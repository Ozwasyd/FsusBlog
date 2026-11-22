using System.Security.Cryptography;
using System.Text.Json;
using Fido2NetLib;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Operations;
using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Server.Passkeys;

internal sealed partial class PasskeyStore
{
    internal Task<byte[]> BeginSitePasskeyRename(string? session, string? expected, SitePasskeyRename request, CancellationToken ct) =>
        BeginSitePasskeyChange(session, expected, request.Reference, request.ExpectedRevision, NormalizeCredentialName(request.Name), ct);

    internal Task<byte[]> BeginSitePasskeyRemove(string? session, string? expected, SitePasskeyRemove request, CancellationToken ct) =>
        BeginSitePasskeyChange(session, expected, request.Reference, request.ExpectedRevision, name: null, ct);

    internal Task<byte[]> BeginSitePasskeyRemoveCurrent(string? session, string? expected, string? ticket, CancellationToken ct) =>
        BeginSitePasskeyChange(session, expected, null, 0, null, ct, RecoveryTokenDigest(ticket) ?? throw Denied());

    private async Task<byte[]> BeginSitePasskeyChange(string? session, string? expected, string? reference, long revision, string? name,
        CancellationToken ct, byte[]? recovery = null)
    {
        var remove = name is null;
        await using var db = await _source.OpenConnectionAsync(ct);
        await using var tx = await InstanceLease.BeginProtected(db, _lease, ct);
        var actor = await RequireCurrentPasskeySession(db, tx, session, expected, ct);
        long? recoveryVersion = recovery is null ? null : await CurrentRecoveryVersion(db, tx, actor, recovery, ct);
        var rows = await SitePasskeys.Manage(db, tx, actor.Id, actor.Scope, ct);
        if (recovery is not null && (rows.Count == 0 || !rows[0].Value.Metadata.Current)) throw Denied();
        var target = recovery is not null ? rows[0] : rows.SingleOrDefault(row => row.Value.Reference == reference)
            ?? throw new BusinessException(Rejection.NotFound, "Passkey not found.");
        if (recovery is not null) revision = target.Value.Revision;
        if (target.Value.Revision != revision || (remove && recovery is null && rows.Count < 2))
            throw ChangeConflict(remove);
        var proofCredential = rows[0].CredentialId;
        byte[][] allowed = [proofCredential];
        var options = _verifier.RequestAssertion(allowed);
        var intent = new CredentialIntent(target.CredentialId, revision, name, proofCredential, options.ToJson(),
            remove ? target.CreatedAtTicks : null, recoveryVersion, recovery is null ? null : rows.Count);
        var token = NewToken();
        await SaveChallenge(db, tx, token, JsonSerializer.Serialize(intent), actor.Id, actor.Generation, ChangeBinding(actor.Scope, remove, recovery), ct, recovery is null ? 300 : 120);
        await InstanceLease.CommitProtected(tx, _lease, ct);
        return options.LoginFrame(token, allowed);
    }

    internal Task CompleteSitePasskeyRename(string? session, string? expected, PasskeyLoginRequest request, CancellationToken ct) =>
        CompleteSitePasskeyChange(session, expected, request, remove: false, ct);

    internal Task<bool> CompleteSitePasskeyRemove(string? session, string? expected, PasskeyLoginRequest request, CancellationToken ct) =>
        CompleteSitePasskeyChange(session, expected, request, remove: true, ct);

    internal Task CompleteSitePasskeyRemoveCurrent(string? session, string? expected, string? ticket, PasskeyLoginRequest request, CancellationToken ct) =>
        CompleteSitePasskeyChange(session, expected, request, remove: true, ct, RecoveryTokenDigest(ticket) ?? throw Denied());

    private async Task<bool> CompleteSitePasskeyChange(string? session, string? expected, PasskeyLoginRequest request, bool remove,
        CancellationToken ct, byte[]? recovery = null)
    {
        if (request.RememberMe) throw Denied();
        CheckId(request.CredentialId, request.RawId);
        await using var db = await _source.OpenConnectionAsync(ct);
        CredentialIntent intent;
        MfaStore.Subject admitted;
        await using (var consume = await InstanceLease.BeginProtected(db, _lease, ct))
        {
            admitted = await RequireCurrentPasskeySession(db, consume, session, expected, ct);
            if (!await CurrentSchema.HasSitePasskeyNamesAsync(db, consume, ct))
                throw new BusinessException(Rejection.NotFound, "Passkey names are unavailable.");
            var challenge = await ConsumeChallenge(db, consume, request.Token, ChangeBinding(admitted.Scope, remove, recovery), ct);
            if (challenge.UserId != admitted.Id || challenge.Generation != admitted.Generation) throw Denied();
            intent = JsonSerializer.Deserialize<CredentialIntent>(challenge.Options) ?? throw Denied();
            if (recovery is not null && intent.RecoveryVersion != await CurrentRecoveryVersion(db, consume, admitted, recovery, ct))
                throw Denied();
            await InstanceLease.CommitProtected(consume, _lease, ct);
        }
        if ((intent.Name is null) != remove || !CryptographicOperations.FixedTimeEquals(intent.ProofCredential, request.RawId)) throw Denied();
        await using var tx = await InstanceLease.BeginProtected(db, _lease, ct);
        var current = await RequireCurrentPasskeySession(db, tx, session, expected, ct);
        if (current.Id != admitted.Id || current.Generation != admitted.Generation ||
            !CryptographicOperations.FixedTimeEquals(current.Scope, admitted.Scope)) throw Denied();
        await VerifyAssertion(db, tx, request, current.Id, AssertionOptions.FromJson(intent.Options), requireHandle: false, ct);
        await MfaStore.RequireSession(db, tx, session, ct);
        if (recovery is not null && intent.RecoveryVersion != await CurrentRecoveryVersion(db, tx, current, recovery, ct))
            throw Denied();
        var removingCurrent = remove && intent.Target.AsSpan().SequenceEqual(intent.ProofCredential);
        var changed = remove ? await RemoveCredential(db, tx, current, intent, removingCurrent, recovery, ct) :
            await ApplyRename(db, tx, current.Id, intent, ct);
        // Preserve a valid assertion's counter even if a concurrent change makes its target stale.
        await InstanceLease.CommitProtected(tx, _lease, ct);
        if (!changed) throw ChangeConflict(remove);
        return removingCurrent;
    }

    private static async Task<bool> ApplyRename(NpgsqlConnection db, NpgsqlTransaction tx, Guid user, CredentialIntent intent, CancellationToken ct)
    {
        await using var command = Store.Sql(db, tx, intent.ExpectedRevision == 0 ? """
            insert into public.site_passkey_name(credential_id,user_id,revision,name)
            select credential_id,user_id,1,$3 from public.passkey_credential where credential_id=$1 and user_id=$2
            on conflict (credential_id) do nothing
            """ : """
            update public.site_passkey_name set name=$3,revision=revision+1
            where credential_id=$1 and user_id=$2 and revision=$4 and revision<9223372036854775807
            """, intent.ExpectedRevision == 0 ? [intent.Target, user, intent.Name!] : [intent.Target, user, intent.Name!, intent.ExpectedRevision]);
        return await command.ExecuteNonQueryAsync(ct) == 1;
    }

    private static async Task<bool> RemoveCredential(NpgsqlConnection db, NpgsqlTransaction tx, MfaStore.Subject actor,
        CredentialIntent intent, bool removingCurrent, byte[]? recovery, CancellationToken ct)
    {
        var credential = intent.Target;
        var rows = await SitePasskeys.Manage(db, tx, actor.Id, actor.Scope, ct);
        var target = rows.SingleOrDefault(row => row.CredentialId.AsSpan().SequenceEqual(credential));
        var final = recovery is not null && removingCurrent && rows.Count == 1;
        if (target is null || target.Value.Metadata.Current != removingCurrent ||
            (recovery is not null ? rows.Count != intent.DeviceCount : rows.Count < 2) ||
            target.Value.Revision != intent.ExpectedRevision || target.CreatedAtTicks != intent.CreatedAtTicks) return false;
        await using (var sessions = Store.Sql(db, tx,
            "delete from public.user_session where user_id=$1 and ($3 or passkey_credential_id=$2)", actor.Id, credential, final))
            await sessions.ExecuteNonQueryAsync(ct);
        // The pending login scope is the 32-byte cookie digest followed by the credential ID.
        await using (var flows = Store.Sql(db, tx,
            "delete from public.mfa_flow where user_id=$1 and kind=$2 and substring(scope from 33)=$3",
            actor.Id, (int)MfaStore.Purpose.Login, credential))
            await flows.ExecuteNonQueryAsync(ct);
        await using var remove = Store.Sql(db, tx,
            "delete from public.passkey_credential where user_id=$1 and credential_id=$2", actor.Id, credential);
        if (await remove.ExecuteNonQueryAsync(ct) != 1) throw ChangeConflict(remove: true);
        if (recovery is not null)
        {
            await RecoveryWrite(db, tx, ct, "delete from public.site_recovery_rebind where user_id=$1 and ticket_digest=$2", actor.Id, recovery);
            if (final) await EnterPasskeyRecovery(db, tx, actor.Id, ct);
        }
        return true;
    }

    private static string NormalizeCredentialName(string input)
    {
        var name = input.Trim();
        if (name.Length is < 1 or > WireLimits.SitePasskeyNameChars || name.Any(char.IsControl))
            throw new BusinessException(Rejection.Invalid, "Provide a Passkey name between 1 and 64 characters.");
        return name;
    }

    private static byte[] ChangeBinding(byte[] digest, bool remove, byte[]? recovery) => recovery is not null
        ? SHA256.HashData([.. "FsusBlog v2 remove current passkey with recovery v1"u8, .. digest, .. recovery])
        : SHA256.HashData([.. (remove ? "FsusBlog v2 site passkey remove v1"u8 : "FsusBlog v2 site passkey rename v1"u8), .. digest]);
    private static BusinessException ChangeConflict(bool remove) => new(Rejection.Conflict, remove
        ? "This Passkey cannot be removed. Reload the list to check the remaining Passkeys."
        : "The Passkey name changed. Reload the Passkey list.");
    private sealed record CredentialIntent(byte[] Target, long ExpectedRevision, string? Name, byte[] ProofCredential, string Options, long? CreatedAtTicks, long? RecoveryVersion, int? DeviceCount);
}
