using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text.Json;
using Fido2NetLib;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Operations;
using FsusBlog.V2.Server.Sessions;
using Npgsql;

namespace FsusBlog.V2.Server.Passkeys;

internal sealed partial class PasskeyStore
{
    private const int EnrollmentLifetimeSeconds = 120;

    internal async Task<byte[]> BeginSitePasskeyEnrollment(string? session, string? expected, CancellationToken ct)
    {
        await using var db = await _source.OpenConnectionAsync(ct);
        await using var tx = await InstanceLease.BeginProtected(db, _lease, ct);
        var actor = await RequireCurrentPasskeySession(db, tx, session, expected, ct);
        var state = await ReadEnrollmentState(db, tx, actor, ct);
        await RequireNoEnrollment(db, tx, actor, ct);
        byte[][] allowed = [state.Current];
        var options = _verifier.RequestAssertion(allowed);
        var token = NewToken();
        await SaveChallenge(db, tx, token, options.ToJson(), actor.Id, actor.Generation, EnrollmentApprovalBinding(actor.Scope), ct,
            EnrollmentLifetimeSeconds);
        await InstanceLease.CommitProtected(tx, _lease, ct);
        return options.LoginFrame(token, allowed);
    }

    internal async Task<byte[]> ApproveSitePasskeyEnrollment(string? session, string? expected, PasskeyLoginRequest request, CancellationToken ct)
    {
        if (request.RememberMe) throw Denied();
        CheckId(request.CredentialId, request.RawId);
        await using var db = await _source.OpenConnectionAsync(ct);
        MfaStore.Subject admitted;
        string approvedOptions;
        await using (var consume = await InstanceLease.BeginProtected(db, _lease, ct))
        {
            admitted = await RequireCurrentPasskeySession(db, consume, session, expected, ct);
            var challenge = await ConsumeChallenge(db, consume, request.Token, EnrollmentApprovalBinding(admitted.Scope), ct);
            if (challenge.UserId != admitted.Id || challenge.Generation != admitted.Generation) throw Denied();
            approvedOptions = challenge.Options;
            await InstanceLease.CommitProtected(consume, _lease, ct);
        }

        await using var tx = await InstanceLease.BeginProtected(db, _lease, ct);
        var actor = await RequireCurrentPasskeySession(db, tx, session, expected, ct);
        if (actor.Id != admitted.Id || actor.Generation != admitted.Generation ||
            !CryptographicOperations.FixedTimeEquals(actor.Scope, admitted.Scope)) throw Denied();
        var state = await ReadEnrollmentState(db, tx, actor, ct);
        if (!CryptographicOperations.FixedTimeEquals(state.Current, request.RawId)) throw Denied();
        await RequireNoEnrollment(db, tx, actor, ct);
        await VerifyAssertion(db, tx, request, actor.Id, AssertionOptions.FromJson(approvedOptions), requireHandle: false, ct);
        await RequireCurrentPasskeySession(db, tx, session, expected, ct);

        var options = _verifier.RequestRegistration(state.Handle);
        var intent = new EnrollmentIntent(expected!, EnrollmentSet(state.Credentials), options.ToJson());
        var token = NewToken();
        await SaveChallenge(db, tx, token, JsonSerializer.Serialize(intent), actor.Id, actor.Generation, EnrollmentCreationBinding(actor.Id), ct,
            EnrollmentLifetimeSeconds);
        var frame = PasskeyWire.EnrollmentBegin(token, checked((uint)options.Timeout), options.Rp.Id, options.Rp.Name,
            options.User.Name, options.User.DisplayName, options.User.Id, options.Challenge,
            options.PubKeyCredParams.Select(parameter => (int)parameter.Alg).ToArray(), state.Credentials);
        await InstanceLease.CommitProtected(tx, _lease, ct);
        return frame;
    }

    internal async Task CompleteSitePasskeyEnrollment(string? session, string? expected, PasskeyProvisionRequest request, CancellationToken ct)
    {
        CheckId(request.CredentialId, request.RawId);
        await using var db = await _source.OpenConnectionAsync(ct);
        await using var tx = await InstanceLease.BeginProtected(db, _lease, ct);
        var actor = await RequireCurrentPasskeySession(db, tx, session, expected, ct);
        var challenge = await ConsumeChallenge(db, tx, request.Token, EnrollmentCreationBinding(actor.Id), ct);
        if (challenge.UserId != actor.Id || challenge.Generation != actor.Generation) throw Denied();
        var intent = JsonSerializer.Deserialize<EnrollmentIntent>(challenge.Options) ?? throw Denied();
        // A different browser session cannot consume this challenge, even if it presents the token.
        if (intent.Session != expected) throw Denied();
        await tx.SaveAsync("enrollment_write", ct);
        try
        {
            var state = await ReadEnrollmentState(db, tx, actor, ct);
            var options = CredentialCreateOptions.FromJson(intent.Options);
            if (intent.CredentialSet != EnrollmentSet(state.Credentials) || !CryptographicOperations.FixedTimeEquals(options.User.Id, state.Handle))
                throw Denied();
            // Hold the account lock through consumption and insertion, including races with enrollment or recovery.
            await RegisterCredential(db, tx, actor.Id, request, options, ct);
            await RequireCurrentPasskeySession(db, tx, session, expected, ct);
        }
        catch (BusinessException)
        {
            await tx.RollbackAsync("enrollment_write", ct);
            await InstanceLease.CommitProtected(tx, _lease, ct);
            throw;
        }
        await InstanceLease.CommitProtected(tx, _lease, ct);
    }

    private static async Task<MfaStore.Subject> RequireCurrentPasskeySession(NpgsqlConnection db, NpgsqlTransaction tx, string? session,
        string? expected, CancellationToken ct)
    {
        var actor = await MfaStore.RequireSession(db, tx, session, ct);
        SiteSessions.RequireCurrent(actor.Id, actor.Scope, expected);
        return actor;
    }

    private static async Task RequireNoEnrollment(NpgsqlConnection db, NpgsqlTransaction tx, MfaStore.Subject actor, CancellationToken ct)
    {
        await using var pending = Store.Sql(db, tx, """
            select exists (select 1 from public.passkey_challenge where user_id=$1 and generation=$2 and binding_digest=$3
                and expires_at>clock_timestamp())
            """, actor.Id, actor.Generation, EnrollmentCreationBinding(actor.Id));
        if (await pending.ExecuteScalarAsync(ct) is true)
            throw new BusinessException(Rejection.Conflict, "A Passkey enrollment is already in progress. Try again after it expires.");
    }

    private static async Task<EnrollmentState> ReadEnrollmentState(NpgsqlConnection db, NpgsqlTransaction tx, MfaStore.Subject actor,
        CancellationToken ct)
    {
        await using var query = Store.Sql(db, tx, """
            select s.user_handle,u.passkey_credential_id,c.credential_id
            from public.passkey_subject s join public.user_session u on u.user_id=s.user_id
            join public.passkey_credential c on c.user_id=s.user_id
            where s.user_id=$1 and u.digest=$2 and u.passkey_credential_id is not null
            order by c.credential_id limit $3
            """, actor.Id, actor.Scope, WireLimits.SitePasskeyListSize);
        await using var reader = await query.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) throw Denied();
        var handle = reader.GetFieldValue<byte[]>(0);
        var current = reader.GetFieldValue<byte[]>(1);
        var ids = new List<byte[]>();
        do { ids.Add(reader.GetFieldValue<byte[]>(2)); }
        while (await reader.ReadAsync(ct));
        if (ids.Count >= WireLimits.SitePasskeyListSize)
            throw new BusinessException(Rejection.Conflict, "This account has reached its Passkey limit.");
        return new(handle, current, ids);
    }

    private static byte[] EnrollmentApprovalBinding(byte[] session) => SHA256.HashData([.. "FsusBlog v2 passkey enrollment approval v1"u8, .. session]);
    private static byte[] EnrollmentCreationBinding(Guid owner) => SHA256.HashData([.. "FsusBlog v2 passkey enrollment creation v1"u8, .. owner.ToByteArray()]);

    private static string EnrollmentSet(IReadOnlyList<byte[]> credentials)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        Span<byte> length = stackalloc byte[sizeof(int)];
        foreach (var id in credentials)
        {
            BinaryPrimitives.WriteInt32LittleEndian(length, id.Length);
            hash.AppendData(length);
            hash.AppendData(id);
        }
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    private sealed record EnrollmentState(byte[] Handle, byte[] Current, IReadOnlyList<byte[]> Credentials);
    private sealed record EnrollmentIntent(string Session, string CredentialSet, string Options);
}
