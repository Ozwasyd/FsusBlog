using System.Security.Cryptography;
using System.Text.Json;
using Fido2NetLib;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Operations;
using FsusBlog.V2.Server.Sessions;
using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Server.Passkeys;

internal sealed partial class PasskeyStore
{
    internal async Task<byte[]> BeginSitePasskeyRename(string? session, string? expected, SitePasskeyRename request, CancellationToken ct)
    {
        var name = NormalizeCredentialName(request.Name);
        await using var db = await _source.OpenConnectionAsync(ct);
        await using var tx = await InstanceLease.BeginProtected(db, _lease, ct);
        var actor = await MfaStore.RequireSession(db, tx, session, ct);
        SiteSessions.RequireCurrent(actor.Id, actor.Scope, expected);
        var rows = await SitePasskeys.Manage(db, tx, actor.Id, actor.Scope, ct);
        var target = rows.SingleOrDefault(row => row.Value.Reference == request.Reference)
            ?? throw new BusinessException(Rejection.NotFound, "Passkey not found.");
        if (target.Value.Revision != request.ExpectedRevision) throw NameConflict();
        var proofCredential = rows[0].CredentialId;
        byte[][] allowed = [proofCredential];
        var options = RestrictedAssertionOptions(allowed);
        var intent = new RenameIntent(target.CredentialId, request.ExpectedRevision, name, proofCredential, options.ToJson());
        var token = NewToken();
        await SaveChallenge(db, tx, token, JsonSerializer.Serialize(intent), actor.Id, actor.Generation, RenameBinding(actor.Scope), ct);
        await InstanceLease.CommitProtected(tx, _lease, ct);
        return PasskeyWire.LoginBegin(token, checked((uint)options.Timeout), options.RpId!, options.Challenge, allowed);
    }

    internal async Task CompleteSitePasskeyRename(string? session, string? expected, PasskeyLoginRequest request, CancellationToken ct)
    {
        if (request.RememberMe) throw Denied();
        CheckId(request.CredentialId, request.RawId);
        await using var db = await _source.OpenConnectionAsync(ct);
        RenameIntent intent;
        MfaStore.Subject admitted;
        await using (var consume = await InstanceLease.BeginProtected(db, _lease, ct))
        {
            admitted = await MfaStore.RequireSession(db, consume, session, ct);
            SiteSessions.RequireCurrent(admitted.Id, admitted.Scope, expected);
            if (!await CurrentSchema.HasSitePasskeyNamesAsync(db, consume, ct))
                throw new BusinessException(Rejection.NotFound, "Passkey names are unavailable.");
            var challenge = await ConsumeChallenge(db, consume, request.Token, RenameBinding(admitted.Scope), ct);
            if (challenge.UserId != admitted.Id || challenge.Generation != admitted.Generation) throw Denied();
            intent = JsonSerializer.Deserialize<RenameIntent>(challenge.Options) ?? throw Denied();
            await InstanceLease.CommitProtected(consume, _lease, ct);
        }
        if (!CryptographicOperations.FixedTimeEquals(intent.ProofCredential, request.RawId)) throw Denied();
        await using var tx = await InstanceLease.BeginProtected(db, _lease, ct);
        var current = await MfaStore.RequireSession(db, tx, session, ct);
        SiteSessions.RequireCurrent(current.Id, current.Scope, expected);
        if (current.Id != admitted.Id || current.Generation != admitted.Generation ||
            !CryptographicOperations.FixedTimeEquals(current.Scope, admitted.Scope)) throw Denied();
        await VerifyAssertion(db, tx, request, current.Id, AssertionOptions.FromJson(intent.Options), requireHandle: false, ct);
        await MfaStore.RequireSession(db, tx, session, ct);
        var changed = await ApplyRename(db, tx, current.Id, intent, ct);
        // Valid authenticator counter advancement stays durable if a concurrent approved rename already advanced the label.
        await InstanceLease.CommitProtected(tx, _lease, ct);
        if (!changed) throw NameConflict();
    }

    private static async Task<bool> ApplyRename(NpgsqlConnection db, NpgsqlTransaction tx, Guid user, RenameIntent intent, CancellationToken ct)
    {
        await using var command = Store.Sql(db, tx, intent.ExpectedRevision == 0 ? """
            insert into public.site_passkey_name(credential_id,user_id,revision,name)
            select credential_id,user_id,1,$3 from public.passkey_credential where credential_id=$1 and user_id=$2
            on conflict (credential_id) do nothing
            """ : """
            update public.site_passkey_name set name=$3,revision=revision+1
            where credential_id=$1 and user_id=$2 and revision=$4 and revision<9223372036854775807
            """, intent.ExpectedRevision == 0 ? [intent.Target, user, intent.Name] : [intent.Target, user, intent.Name, intent.ExpectedRevision]);
        return await command.ExecuteNonQueryAsync(ct) == 1;
    }

    private static string NormalizeCredentialName(string input)
    {
        var name = input.Trim();
        if (name.Length is < 1 or > WireLimits.SitePasskeyNameChars || name.Any(char.IsControl))
            throw new BusinessException(Rejection.Invalid, "Provide a Passkey name between 1 and 64 characters.");
        return name;
    }

    private static byte[] RenameBinding(byte[] digest) => SHA256.HashData([.. "FsusBlog v2 site passkey rename v1"u8, .. digest]);
    private static BusinessException NameConflict() => new(Rejection.Conflict, "The Passkey name changed. Reload the Passkey list.");
    private sealed record RenameIntent(byte[] Target, long ExpectedRevision, string Name, byte[] ProofCredential, string Options);
}
