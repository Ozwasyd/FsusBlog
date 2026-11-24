using static FsusBlog.V2.Server.SqlCommands;

namespace FsusBlog.V2.Server.Administration;

// Owns administrator Passkey ceremonies (bootstrap, sign-in, and Step-Up Fido2 assertion options/verification).
internal sealed class AdminPasskeyStore(NpgsqlDataSource source, InstanceLease? lease, PasskeyConfiguration config)
{
    private sealed record Principal(Guid Id, string Handle, byte[] UserHandle, long Generation, DateTimeOffset GenerationChangedAt);
    private sealed record Challenge(Guid? Principal, long? Generation, string Options, DateTimeOffset StartedAt);

    private readonly Fido2 _verifier = config.CreateVerifier("FsusBlog administration");
    private const int Login = 1;
    private const int Bootstrap = 2;
    private const int ChallengeLimit = 128;
    private const long ChallengeLock = 716729109726707503L;

    internal Task<(byte[] Frame, string Binding)> BeginLogin(CancellationToken ct) =>
        InstanceLease.RunProtected(source, lease, async (db, tx) =>
        {
            var options = _verifier.RequestAssertion([]);
            var (token, binding) = (AdminSql.Token(), AdminSql.Token());
            await SaveChallenge(db, tx, token, AdminSql.ChallengeDigest(binding, null), Login, null, options.ToJson(), ct);
            return (options.LoginFrame(token), binding);
        }, ct);

    internal Task<(byte[] Frame, string Binding)> BeginBootstrap(string? ticket, CancellationToken ct)
    {
        var digest = Store.TokenDigest(ticket) ?? throw AdminSessionGate.Denied();
        return InstanceLease.RunProtected(source, lease, async (db, tx) =>
        {
            var principal = await BootstrapPrincipal(db, tx, digest, ct);
            var (token, binding) = (AdminSql.Token(), AdminSql.Token());
            var options = _verifier.RequestRegistration(principal.UserHandle, principal.Handle, principal.Handle);
            await SaveChallenge(db, tx, token, AdminSql.ChallengeDigest(binding, digest), Bootstrap, principal, options.ToJson(), ct);
            return (options.RegistrationFrame(token), binding);
        }, ct);
    }

    internal async Task CompleteBootstrap(PasskeyProvisionRequest request, string? binding, string? ticket, CancellationToken ct)
    {
        var digest = Store.TokenDigest(ticket) ?? throw AdminSessionGate.Denied();
        await using var db = await source.OpenConnectionAsync(ct);
        var challenge = await ConsumeChallenge(db, request.Token, AdminSql.ChallengeDigest(binding, digest), Bootstrap, ct);
        AdminSql.RequireCredentialId(request.CredentialId, request.RawId);
        await InstanceLease.RunProtected(db, lease, async tx =>
        {
            var principal = await BootstrapPrincipal(db, tx, digest, ct);
            var options = CredentialCreateOptions.FromJson(challenge.Options);
            if (principal.Id != challenge.Principal || principal.Generation != challenge.Generation ||
                !CryptographicOperations.FixedTimeEquals(options.User.Id, principal.UserHandle)) throw AdminSessionGate.Denied();

            RegisteredPublicKeyCredential verified;
            try
            {
                verified = await PasskeyVerification.Attest(_verifier, request, options, async (candidate, token) =>
                    (bool)(await Scalar(db, tx, token, """
                        select not exists(select 1 from public.admin_passkey_credential where credential_id=$1)
                        """, candidate.CredentialId))!, ct);
            }
            catch (Fido2VerificationException) { throw AdminSessionGate.Denied(); }

            try
            {
                await Execute(db, tx, ct, """
                    insert into public.admin_passkey_credential(credential_id,principal_id,public_key,sign_count,backup_eligible,backed_up)
                    values($1,$2,$3,$4,$5,$6)
                    """, verified.Id, principal.Id, verified.PublicKey, (long)verified.SignCount, verified.IsBackupEligible, verified.IsBackedUp);
            }
            catch (PostgresException error) when (error.SqlState == PostgresErrorCodes.UniqueViolation) { throw AdminSessionGate.Denied(); }
            if (await Execute(db, tx, ct, """
                delete from public.admin_invitation where principal_id=$1 and digest=$2 and generation=$3 and expires_at>clock_timestamp()
                """, principal.Id, digest, principal.Generation) != 1) throw AdminSessionGate.Denied();
            await Execute(db, tx, ct, """
                update public.admin_principal set generation=generation+1,generation_changed_at=clock_timestamp() where id=$1
                """, principal.Id);
            await Execute(db, tx, ct, "delete from public.admin_challenge where principal_id=$1", principal.Id);
        }, ct);
    }

    internal async Task<string> CompleteLogin(PasskeyLoginRequest request, string? binding, CancellationToken ct)
    {
        await using var db = await source.OpenConnectionAsync(ct);
        var challenge = await ConsumeChallenge(db, request.Token, AdminSql.ChallengeDigest(binding, null), Login, ct);
        if (request.RememberMe) throw AdminSessionGate.Denied();
        return await InstanceLease.RunProtected(db, lease,
            tx => CompleteUnifiedLogin(db, tx, request, challenge.Options, challenge.StartedAt, ct), ct);
    }

    internal async Task<string> CompleteUnifiedLogin(NpgsqlConnection db, NpgsqlTransaction tx, PasskeyLoginRequest request,
        string optionsJson, DateTimeOffset challengeStartedAt, CancellationToken ct)
    {
        AdminSql.RequireCredentialId(request.CredentialId, request.RawId);
        if (request.AuthenticatorData.Length < 37) throw AdminSessionGate.Denied();
        var principal = await LockPrincipal(db, tx, """
            select principal_id from public.admin_passkey_credential where credential_id=$1
            """, request.RawId, ct);
        if (challengeStartedAt <= principal.GenerationChangedAt) throw AdminSessionGate.Denied();
        await VerifyCredential(db, tx, principal.Id, principal.UserHandle, request, AssertionOptions.FromJson(optionsJson), ct);
        var raw = RandomNumberGenerator.GetBytes(32);
        try
        {
            await AdminSignInHistory.RecordAsync(db, tx, principal.Id, SHA256.HashData(raw), principal.Generation, ct);
            return Convert.ToHexStringLower(raw);
        }
        finally { CryptographicOperations.ZeroMemory(raw); }
    }

    internal (byte[] Frame, string OptionsJson) CreateStepUpChallenge(string token, byte[] credential)
    {
        var options = _verifier.RequestAssertion([credential]);
        return (options.LoginFrame(token, [credential]), options.ToJson());
    }

    internal Task VerifyStepUpAssertion(NpgsqlConnection db, NpgsqlTransaction tx, Guid principalId, byte[] userHandle,
        PasskeyLoginRequest request, string optionsJson, CancellationToken ct) =>
        VerifyCredential(db, tx, principalId, userHandle, request, AssertionOptions.FromJson(optionsJson), ct, requireHandle: false);

    private async Task VerifyCredential(NpgsqlConnection db, NpgsqlTransaction tx, Guid principal, byte[] handle,
        PasskeyLoginRequest request, AssertionOptions options, CancellationToken ct, bool requireHandle = true)
    {
        if (request.AuthenticatorData.Length < 37 || (requireHandle || request.UserHandle.Length != 0) &&
            !CryptographicOperations.FixedTimeEquals(handle, request.UserHandle)) throw AdminSessionGate.Denied();
        var (key, counter, backupEligible) = await QueryRequired(db, tx, ct, """
            select public_key,sign_count,backup_eligible from public.admin_passkey_credential
            where principal_id=$1 and credential_id=$2 for update
            """, r => (r.GetFieldValue<byte[]>(0), checked((uint)r.GetInt64(1)), r.GetBoolean(2)),
            AdminSessionGate.Denied, principal, request.RawId);
        VerifyAssertionResult verified;
        try
        {
            verified = await PasskeyVerification.Assert(_verifier, request, options, handle, key, counter, ct);
        }
        catch (Fido2VerificationException) { throw AdminSessionGate.Denied(); }
        if (((request.AuthenticatorData[32] & 0x08) != 0) != backupEligible) throw AdminSessionGate.Denied();
        await Execute(db, tx, ct, """
            update public.admin_passkey_credential set sign_count=$2,backed_up=$3 where credential_id=$1
            """, request.RawId, (long)verified.SignCount, verified.IsBackedUp);
    }

    private static async Task<Principal> BootstrapPrincipal(NpgsqlConnection db, NpgsqlTransaction tx, byte[] digest, CancellationToken ct)
    {
        var principal = await LockPrincipal(db, tx, "select principal_id from public.admin_invitation where digest=$1", digest, ct);
        if (await Scalar(db, tx, ct, """
            select exists(select from public.admin_invitation
                where digest=$1 and principal_id=$2 and generation=$3 and expires_at>clock_timestamp())
            and not exists(select from public.admin_passkey_credential where principal_id=$2)
            """, digest, principal.Id, principal.Generation) is not true) throw AdminSessionGate.Denied();
        return principal;
    }

    private static Task<Principal> LockPrincipal(NpgsqlConnection db, NpgsqlTransaction tx, string selector,
        byte[] digestOrCredential, CancellationToken ct) =>
        QueryRequired(db, tx, ct, """
            select id,handle,user_handle,generation,generation_changed_at from public.admin_principal where enabled and id=(
            """ + selector + ") for update",
            r => new Principal(r.GetGuid(0), r.GetString(1), r.GetFieldValue<byte[]>(2), r.GetInt64(3), r.GetFieldValue<DateTimeOffset>(4)),
            AdminSessionGate.Denied, digestOrCredential);

    private static async Task SaveChallenge(NpgsqlConnection db, NpgsqlTransaction tx, string token, byte[] binding, int kind,
        Principal? principal, string options, CancellationToken ct)
    {
        await Execute(db, tx, ct, "select pg_catalog.pg_advisory_xact_lock($1)", ChallengeLock);
        await Execute(db, tx, ct, "delete from public.admin_challenge where expires_at<=clock_timestamp() or principal_id=$1",
            Optional(NpgsqlDbType.Uuid, principal?.Id));
        if (await Execute(db, tx, ct, """
            insert into public.admin_challenge(digest,principal_id,generation,binding_digest,kind,options,expires_at,started_at)
            select $1,$2,$3,$4,$5,$6,statement_timestamp()+interval '2 minutes',statement_timestamp()
            where (select count(*) from public.admin_challenge)<$7
            """, AdminSql.ChallengeDigest(token, null), Optional(NpgsqlDbType.Uuid, principal?.Id),
            Optional(NpgsqlDbType.Bigint, principal?.Generation), binding, kind, options, ChallengeLimit) != 1)
            throw new PublicUnavailableException();
    }

    private Task<Challenge> ConsumeChallenge(NpgsqlConnection db, string token, byte[] binding, int kind, CancellationToken ct) =>
        InstanceLease.RunProtected(db, lease, tx => QueryRequired(db, tx, ct, """
            delete from public.admin_challenge where digest=$1 and binding_digest=$2 and kind=$3 and expires_at>clock_timestamp()
            returning principal_id,generation,options,started_at
            """, r => new Challenge(r.IsDBNull(0) ? null : r.GetGuid(0), r.IsDBNull(1) ? null : r.GetInt64(1),
                r.GetString(2), r.GetFieldValue<DateTimeOffset>(3)),
            AdminSessionGate.Denied, AdminSql.ChallengeDigest(token, null), binding, kind), ct);
}
