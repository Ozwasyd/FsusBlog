using System.Security.Cryptography;
using Fido2NetLib;
using Fido2NetLib.Objects;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Operations;
using FsusBlog.V2.Server.Passkeys;
using FsusBlogV2.Storage;
using Npgsql;
using NpgsqlTypes;

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

    internal async Task<(byte[] Frame, string Binding)> BeginLogin(CancellationToken ct)
    {
        var options = _verifier.RequestAssertion([]);
        var (token, binding) = (AdminSql.Token(), AdminSql.Token());
        await using var db = await source.OpenConnectionAsync(ct);
        await using var tx = await InstanceLease.BeginProtected(db, lease, ct);
        await SaveChallenge(db, tx, token, AdminSql.ChallengeDigest(binding, null), Login, null, options.ToJson(), ct);
        await InstanceLease.CommitProtected(tx, lease, ct);
        return (options.LoginFrame(token), binding);
    }

    internal async Task<(byte[] Frame, string Binding)> BeginBootstrap(string? ticket, CancellationToken ct)
    {
        var digest = Store.TokenDigest(ticket) ?? throw AdminSessionGate.Denied();
        await using var db = await source.OpenConnectionAsync(ct);
        await using var tx = await InstanceLease.BeginProtected(db, lease, ct);
        var principal = await BootstrapPrincipal(db, tx, digest, ct);
        var (token, binding) = (AdminSql.Token(), AdminSql.Token());
        var options = _verifier.RequestRegistration(principal.UserHandle, principal.Handle, principal.Handle);
        await SaveChallenge(db, tx, token, AdminSql.ChallengeDigest(binding, digest), Bootstrap, principal, options.ToJson(), ct);
        await InstanceLease.CommitProtected(tx, lease, ct);
        return (options.RegistrationFrame(token), binding);
    }

    internal async Task CompleteBootstrap(PasskeyProvisionRequest request, string? binding, string? ticket, CancellationToken ct)
    {
        var digest = Store.TokenDigest(ticket) ?? throw AdminSessionGate.Denied();
        await using var db = await source.OpenConnectionAsync(ct);
        var challenge = await ConsumeChallenge(db, request.Token, AdminSql.ChallengeDigest(binding, digest), Bootstrap, ct);
        AdminSql.RequireCredentialId(request.CredentialId, request.RawId);
        await using var tx = await InstanceLease.BeginProtected(db, lease, ct);
        var principal = await BootstrapPrincipal(db, tx, digest, ct);
        var options = CredentialCreateOptions.FromJson(challenge.Options);
        if (principal.Id != challenge.Principal || principal.Generation != challenge.Generation ||
            !CryptographicOperations.FixedTimeEquals(options.User.Id, principal.UserHandle)) throw AdminSessionGate.Denied();

        RegisteredPublicKeyCredential verified;
        try
        {
            verified = await PasskeyVerification.Attest(_verifier, request, options, async (candidate, ct) =>
            {
                return (bool)(await SqlCommands.Scalar(db, tx, ct, """
                    select not exists(select 1 from public.admin_passkey_credential where credential_id=$1)
                    """, candidate.CredentialId))!;
            }, ct);
        }
        catch (Fido2VerificationException) { throw AdminSessionGate.Denied(); }

        try
        {
            await SqlCommands.Execute(db, tx, ct, """
                insert into public.admin_passkey_credential(credential_id,principal_id,public_key,sign_count,backup_eligible,backed_up)
                values($1,$2,$3,$4,$5,$6)
                """, verified.Id, principal.Id, verified.PublicKey, (long)verified.SignCount, verified.IsBackupEligible, verified.IsBackedUp);
        }
        catch (PostgresException error) when (error.SqlState == PostgresErrorCodes.UniqueViolation) { throw AdminSessionGate.Denied(); }
        if (await SqlCommands.Execute(db, tx, ct, """
            delete from public.admin_invitation where principal_id=$1 and digest=$2 and generation=$3 and expires_at>clock_timestamp()
            """, principal.Id, digest, principal.Generation) != 1) throw AdminSessionGate.Denied();
        await SqlCommands.Execute(db, tx, ct, """
            update public.admin_principal set generation=generation+1,generation_changed_at=clock_timestamp() where id=$1
            """, principal.Id);
        await SqlCommands.Execute(db, tx, ct, "delete from public.admin_challenge where principal_id=$1", principal.Id);
        await InstanceLease.CommitProtected(tx, lease, ct);
    }

    internal async Task<string> CompleteLogin(PasskeyLoginRequest request, string? binding, CancellationToken ct)
    {
        await using var db = await source.OpenConnectionAsync(ct);
        var challenge = await ConsumeChallenge(db, request.Token, AdminSql.ChallengeDigest(binding, null), Login, ct);
        AdminSql.RequireCredentialId(request.CredentialId, request.RawId);
        if (request.RememberMe || request.AuthenticatorData.Length < 37) throw AdminSessionGate.Denied();
        await using var tx = await InstanceLease.BeginProtected(db, lease, ct);
        var principal = await LockPrincipal(db, tx, """
            select principal_id from public.admin_passkey_credential where credential_id=$1
            """, request.RawId, ct);
        if (challenge.StartedAt <= principal.GenerationChangedAt) throw AdminSessionGate.Denied();
        await VerifyCredential(db, tx, principal.Id, principal.UserHandle, request, AssertionOptions.FromJson(challenge.Options), ct);
        var raw = RandomNumberGenerator.GetBytes(32);
        try
        {
            await AdminSignInHistory.RecordAsync(db, tx, principal.Id, SHA256.HashData(raw), principal.Generation, ct);
            await InstanceLease.CommitProtected(tx, lease, ct);
            return Convert.ToHexStringLower(raw);
        }
        finally { CryptographicOperations.ZeroMemory(raw); }
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
        var frame = options.LoginFrame(token, [credential]);
        return (frame, options.ToJson());
    }

    internal Task VerifyStepUpAssertion(NpgsqlConnection db, NpgsqlTransaction tx, Guid principalId, byte[] userHandle,
        PasskeyLoginRequest request, string optionsJson, CancellationToken ct) =>
        VerifyCredential(db, tx, principalId, userHandle, request, AssertionOptions.FromJson(optionsJson), ct, requireHandle: false);

    private async Task VerifyCredential(NpgsqlConnection db, NpgsqlTransaction tx, Guid principal, byte[] handle,
        PasskeyLoginRequest request, AssertionOptions options, CancellationToken ct, bool requireHandle = true)
    {
        if (request.AuthenticatorData.Length < 37 || (requireHandle || request.UserHandle.Length != 0) &&
            !CryptographicOperations.FixedTimeEquals(handle, request.UserHandle)) throw AdminSessionGate.Denied();
        byte[] key;
        uint counter;
        bool backupEligible;
        await using (var credential = Store.Sql(db, tx, """
            select public_key,sign_count,backup_eligible from public.admin_passkey_credential
            where principal_id=$1 and credential_id=$2 for update
            """, principal, request.RawId))
        await using (var row = await credential.ExecuteReaderAsync(ct))
        {
            await row.ReadRequired(ct, AdminSessionGate.Denied);
            (key, counter, backupEligible) = (row.GetFieldValue<byte[]>(0), checked((uint)row.GetInt64(1)), row.GetBoolean(2));
        }
        VerifyAssertionResult verified;
        try
        {
            verified = await PasskeyVerification.Assert(_verifier, request, options, handle, key, counter, ct);
        }
        catch (Fido2VerificationException) { throw AdminSessionGate.Denied(); }
        if (((request.AuthenticatorData[32] & 0x08) != 0) != backupEligible) throw AdminSessionGate.Denied();
        await SqlCommands.Execute(db, tx, ct, """
            update public.admin_passkey_credential set sign_count=$2,backed_up=$3 where credential_id=$1
            """, request.RawId, (long)verified.SignCount, verified.IsBackedUp);
    }

    private static async Task<Principal> BootstrapPrincipal(NpgsqlConnection db, NpgsqlTransaction tx, byte[] digest, CancellationToken ct)
    {
        var principal = await LockPrincipal(db, tx, """
            select principal_id from public.admin_invitation where digest=$1
            """, digest, ct);
        if (await SqlCommands.Scalar(db, tx, ct, """
            select exists(select from public.admin_invitation
                where digest=$1 and principal_id=$2 and generation=$3 and expires_at>clock_timestamp())
            and not exists(select from public.admin_passkey_credential where principal_id=$2)
            """, digest, principal.Id, principal.Generation) is not true) throw AdminSessionGate.Denied();
        return principal;
    }

    private static async Task<Principal> LockPrincipal(NpgsqlConnection db, NpgsqlTransaction tx, string selector,
        byte[] digestOrCredential, CancellationToken ct)
    {
        Principal principal;
        await using (var cmd = Store.Sql(db, tx, """
            select id,handle,user_handle,generation,generation_changed_at from public.admin_principal where enabled and id=(
            """ + selector + ") for update", digestOrCredential))
        await using (var row = await cmd.ExecuteReaderAsync(ct))
        {
            await row.ReadRequired(ct, AdminSessionGate.Denied);
            principal = new(row.GetGuid(0), row.GetString(1), row.GetFieldValue<byte[]>(2), row.GetInt64(3), row.GetFieldValue<DateTimeOffset>(4));
        }
        return principal;
    }

    private static async Task SaveChallenge(NpgsqlConnection db, NpgsqlTransaction tx, string token, byte[] binding, int kind,
        Principal? principal, string options, CancellationToken ct)
    {
        await SqlCommands.Execute(db, tx, ct, "select pg_catalog.pg_advisory_xact_lock($1)", ChallengeLock);
        await SqlCommands.Execute(db, tx, ct, "delete from public.admin_challenge where expires_at<=clock_timestamp() or principal_id=$1",
            SqlCommands.Optional(NpgsqlDbType.Uuid, principal?.Id));
        if (await SqlCommands.Execute(db, tx, ct, """
            insert into public.admin_challenge(digest,principal_id,generation,binding_digest,kind,options,expires_at,started_at)
            select $1,$2,$3,$4,$5,$6,statement_timestamp()+interval '2 minutes',statement_timestamp()
            where (select count(*) from public.admin_challenge)<$7
            """, AdminSql.ChallengeDigest(token, null), SqlCommands.Optional(NpgsqlDbType.Uuid, principal?.Id),
            SqlCommands.Optional(NpgsqlDbType.Bigint, principal?.Generation), binding, kind, options, ChallengeLimit) != 1)
            throw new PublicUnavailableException();
    }

    private async Task<Challenge> ConsumeChallenge(NpgsqlConnection db, string token, byte[] binding, int kind, CancellationToken ct)
    {
        await using var tx = await InstanceLease.BeginProtected(db, lease, ct);
        Challenge result;
        await using (var cmd = Store.Sql(db, tx, """
            delete from public.admin_challenge where digest=$1 and binding_digest=$2 and kind=$3 and expires_at>clock_timestamp()
            returning principal_id,generation,options,started_at
            """, AdminSql.ChallengeDigest(token, null), binding, kind))
        await using (var row = await cmd.ExecuteReaderAsync(ct))
        {
            await row.ReadRequired(ct, AdminSessionGate.Denied);
            result = new(row.IsDBNull(0) ? null : row.GetGuid(0), row.IsDBNull(1) ? null : row.GetInt64(1), row.GetString(2),
                row.GetFieldValue<DateTimeOffset>(3));
        }
        await InstanceLease.CommitProtected(tx, lease, ct);
        return result;
    }
}
