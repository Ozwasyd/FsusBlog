using System.Security.Cryptography;
using System.Text;
using Fido2NetLib;
using Fido2NetLib.Objects;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Administration;
using FsusBlog.V2.Server.Operations;
using FsusBlogV2.Storage;
using Microsoft.AspNetCore.WebUtilities;
using Npgsql;
using NpgsqlTypes;

namespace FsusBlog.V2.Server.Passkeys;

internal sealed partial class PasskeyStore(NpgsqlDataSource source, PasskeyConfiguration configuration, InstanceLease? lease = null)
{
    private readonly NpgsqlDataSource _source = source;
    private readonly InstanceLease? _lease = lease;
    private readonly Fido2 _verifier = configuration.CreateVerifier();
    private const long ChallengeBudgetLock = 716729109726707502L;
    private const int ChallengeCapacity = 4096;

    internal async Task<byte[]> BeginLogin(CancellationToken ct)
    {
        var options = _verifier.GetAssertionOptions(new GetAssertionOptionsParams
        {
            AllowedCredentials = [],
            UserVerification = UserVerificationRequirement.Required
        });
        var token = NewToken();
        await using var db = await _source.OpenConnectionAsync(ct);
        await using var tx = await InstanceLease.BeginProtected(db, _lease, ct);
        await SaveChallenge(db, tx, token, options.ToJson(), null, null, null, ct);
        await InstanceLease.CommitProtected(tx, _lease, ct);
        return PasskeyWire.LoginBegin(token, checked((uint)options.Timeout), options.RpId!, options.Challenge);
    }

    internal async Task<(byte[] Frame, string Binding)> BeginProvision(string ticket, CancellationToken ct)
    {
        if (ticket is not { Length: 64 } || !ticket.All(char.IsAsciiHexDigitLower)) throw Denied();
        var digest = SHA256.HashData(Convert.FromHexString(ticket));
        await using var db = await _source.OpenConnectionAsync(ct);
        await using var tx = await InstanceLease.BeginProtected(db, _lease, ct);
        Guid userId;
        long generation;
        await using (var user = Store.Sql(db, tx, """
            select id,generation from public.blog_user
            where enabled and id=(select user_id from public.login_ticket where digest=$1 and expires_at>clock_timestamp())
            for update
            """, digest))
        await using (var row = await user.ExecuteReaderAsync(ct))
        {
            if (!await row.ReadAsync(ct)) throw Denied();
            (userId, generation) = (row.GetGuid(0), row.GetInt64(1));
        }

        if (await HasCredential(db, tx, userId, ct) || await CurrentSchema.RequiresSiteRecoveryAsync(db, tx, userId, ct)) throw Denied();
        await using (var consume = Store.Sql(db, tx, """
            delete from public.login_ticket where user_id=$1 and digest=$2 and expires_at>clock_timestamp()
            """, userId, digest))
            if (await consume.ExecuteNonQueryAsync(ct) != 1) throw Denied();

        await SqlCommands.Execute(db, tx, ct, """
            insert into public.passkey_subject(user_id,user_handle) values ($1,$2) on conflict (user_id) do nothing
            """, userId, RandomNumberGenerator.GetBytes(WireLimits.PasskeyUserHandleBytes));
        byte[] userHandle;
        await using (var subject = Store.Sql(db, tx, "select user_handle from public.passkey_subject where user_id=$1", userId))
            userHandle = (byte[])(await subject.ExecuteScalarAsync(ct))!;

        var options = RegistrationOptions(userHandle);
        var token = NewToken();
        var binding = NewToken();
        await SaveChallenge(db, tx, token, options.ToJson(), userId, generation, TokenDigest(binding), ct);
        await InstanceLease.CommitProtected(tx, _lease, ct);
        return (RegistrationBegin(token, options), binding);
    }

    internal async Task CompleteProvision(PasskeyProvisionRequest request, string? binding, CancellationToken ct)
    {
        await using var db = await _source.OpenConnectionAsync(ct);
        if (binding is not { Length: 43 } || !binding.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_'))
            throw Denied();
        var challenge = await ConsumeChallenge(db, request.Token, TokenDigest(binding), ct);
        CheckId(request.CredentialId, request.RawId);
        var accountId = challenge.UserId!.Value;
        var options = CredentialCreateOptions.FromJson(challenge.Options);
        await using var tx = await InstanceLease.BeginProtected(db, _lease, ct);
        await using (var verifyOwner = Store.Sql(db, tx, """
            select 1 from public.blog_user u join public.passkey_subject s on s.user_id=u.id
            where u.id=$1 and u.enabled and u.generation=$2 and s.user_handle=$3 for update of u
            """, accountId, challenge.Generation!.Value, options.User.Id))
            if (await verifyOwner.ExecuteScalarAsync(ct) is null) throw Denied();
        if (await HasCredential(db, tx, accountId, ct) || await CurrentSchema.RequiresSiteRecoveryAsync(db, tx, accountId, ct)) throw Denied();

        await RegisterCredential(db, tx, accountId, request, options, ct);

        // Fail stale credential-attachment challenges and retire bootstrap sessions atomically.
        await SqlCommands.Execute(db, tx, ct, "update public.blog_user set generation=generation+1 where id=$1", accountId);
        await SqlCommands.Execute(db, tx, ct, "delete from public.login_ticket where user_id=$1", accountId);
        await SqlCommands.Execute(db, tx, ct, "delete from public.user_session where user_id=$1", accountId);
        await InstanceLease.CommitProtected(tx, _lease, ct);
    }

    internal sealed record UnifiedLoginResult(
        SiteRefreshStore.Issued? ReaderSession,
        int AccountNumber,
        string? MfaToken,
        string? MfaBinding,
        string? AdminToken);

    internal async Task<UnifiedLoginResult> CompleteLogin(
        PasskeyLoginRequest request, bool mfaEnabled, bool persistentEnabled, AdminPasskeyStore? adminStore, CancellationToken ct)
    {
        await using var db = await _source.OpenConnectionAsync(ct);
        var challenge = await ConsumeChallenge(db, request.Token, null, ct);
        CheckId(request.CredentialId, request.RawId);

        await using var tx = await InstanceLease.BeginProtected(db, _lease, ct);
        Guid userId = default;
        long userGeneration = 0;
        var foundReader = false;
        await using (var user = Store.Sql(db, tx, """
            select u.id,u.generation from public.blog_user u
            where u.enabled and u.id=(select user_id from public.passkey_credential where credential_id=$1)
            for update
            """, request.RawId))
        await using (var row = await user.ExecuteReaderAsync(ct))
        {
            if (await row.ReadAsync(ct))
            {
                (userId, userGeneration) = (row.GetGuid(0), row.GetInt64(1));
                foundReader = true;
            }
        }
        if (foundReader)
        {
            if (request.RememberMe && !persistentEnabled)
                throw new BusinessException(Rejection.Invalid, "Persistent Passkey sessions are not available.");
            var number = await VerifyAssertion(db, tx, request, userId, AssertionOptions.FromJson(challenge.Options),
                requireHandle: true, ct);
            if (await MfaStore.IsEnabled(db, tx, userId, ct))
            {
                if (!mfaEnabled) throw new PublicUnavailableException();
                var binding = NewToken();
                var actor = new MfaStore.Subject(userId, userGeneration, number, [.. MfaStore.FlowDigest(binding), .. request.RawId]);
                var mfa = await MfaStore.BeginFlow(db, tx, actor, MfaStore.Purpose.Login, request.RememberMe ? "persistent" : "", ct);
                await InstanceLease.CommitProtected(tx, _lease, ct);
                return new(null, number, mfa, binding, null);
            }
            var session = await MfaStore.IssueSession(db, tx, userId, userGeneration, request.RawId, mfa: false, request.RememberMe, ct);
            await InstanceLease.CommitProtected(tx, _lease, ct);
            return new(session, number, null, null, null);
        }

        if (adminStore is null) throw Denied();
        var adminToken = await adminStore.CompleteUnifiedLogin(db, tx, request, challenge.Options,
            challenge.ExpiresAt - TimeSpan.FromSeconds(300), ct);
        await InstanceLease.CommitProtected(tx, _lease, ct);
        return new(null, 0, null, null, adminToken);
    }

    internal async Task<byte[]> BeginSetupProof(string? session, CancellationToken ct)
    {
        await using var db = await _source.OpenConnectionAsync(ct);
        await using var tx = await InstanceLease.BeginProtected(db, _lease, ct);
        var actor = await MfaStore.RequireSession(db, tx, session, ct);
        if (await MfaStore.IsEnabled(db, tx, actor.Id, ct)) throw MfaStore.Denied();
        var (options, ids) = await RestrictedAssertion(db, tx, actor.Id, ct);
        var token = await MfaStore.BeginFlow(db, tx, actor, MfaStore.Purpose.Assertion, options.ToJson(), ct);
        await InstanceLease.CommitProtected(tx, _lease, ct);
        return PasskeyWire.LoginBegin(token, checked((uint)options.Timeout), options.RpId!, options.Challenge, ids);
    }

    private async Task<(AssertionOptions Options, List<byte[]> Credentials)> RestrictedAssertion(
        NpgsqlConnection db, NpgsqlTransaction tx, Guid user, CancellationToken ct)
    {
        var ids = new List<byte[]>();
        await using (var query = Store.Sql(db, tx, """
            select credential_id from public.passkey_credential where user_id=$1 order by credential_id limit 17
            """, user))
        await using (var row = await query.ExecuteReaderAsync(ct))
            while (await row.ReadAsync(ct)) ids.Add(row.GetFieldValue<byte[]>(0));
        if (ids.Count is 0 or >16) throw Denied();
        return (RestrictedAssertionOptions(ids), ids);
    }

    private AssertionOptions RestrictedAssertionOptions(IReadOnlyList<byte[]> credentials) => _verifier.GetAssertionOptions(new GetAssertionOptionsParams
    {
        AllowedCredentials = credentials.Select(id => new PublicKeyCredentialDescriptor(id)).ToArray(),
        UserVerification = UserVerificationRequirement.Required
    });

    private CredentialCreateOptions RegistrationOptions(byte[] userHandle) => _verifier.RequestNewCredential(new RequestNewCredentialParams
    {
        User = new Fido2User { Id = userHandle, Name = "fsus-anonymous-account", DisplayName = "Anonymous account" },
        AuthenticatorSelection = new AuthenticatorSelection
        {
            ResidentKey = ResidentKeyRequirement.Required,
            UserVerification = UserVerificationRequirement.Required
        },
        AttestationPreference = AttestationConveyancePreference.None
    });

    private static byte[] RegistrationBegin(string token, CredentialCreateOptions options) =>
        PasskeyWire.ProvisionBegin(token, checked((uint)options.Timeout), options.Rp.Id, options.Rp.Name,
            options.User.Name, options.User.DisplayName, options.User.Id, options.Challenge,
            options.PubKeyCredParams.Select(parameter => (int)parameter.Alg).ToArray());

    private async Task<byte[]> RegisterCredential(NpgsqlConnection db, NpgsqlTransaction tx, Guid user, PasskeyProvisionRequest request,
        CredentialCreateOptions options, CancellationToken ct)
    {
        RegisteredPublicKeyCredential credential;
        try
        {
            credential = await PasskeyVerification.Attest(_verifier, request, options, async (candidate, token) =>
            {
                await using var unique = Store.Sql(db, tx,
                    "select not exists(select 1 from public.passkey_credential where credential_id=$1)", candidate.CredentialId);
                return (bool)(await unique.ExecuteScalarAsync(token))!;
            }, ct);
        }
        catch (Fido2VerificationException) { throw Denied(); }
        if (!CryptographicOperations.FixedTimeEquals(credential.Id, request.RawId)) throw Denied();

        try
        {
            await SqlCommands.Execute(db, tx, ct, """
                insert into public.passkey_credential(credential_id,user_id,public_key,sign_count,backup_eligible,backed_up)
                values ($1,$2,$3,$4,$5,$6)
                """, credential.Id, user, credential.PublicKey, (long)credential.SignCount, credential.IsBackupEligible, credential.IsBackedUp);
        }
        catch (PostgresException error) when (error.SqlState == PostgresErrorCodes.UniqueViolation) { throw Denied(); }
        return credential.Id;
    }

    internal async Task<byte[]> CompleteSetupProof(string? session, PasskeyLoginRequest request, CancellationToken ct)
    {
        if (request.RememberMe) throw Denied();
        MfaStore.Subject original;
        string options;
        await using var db = await _source.OpenConnectionAsync(ct);
        await using (var consume = await InstanceLease.BeginProtected(db, _lease, ct))
        {
            original = await MfaStore.RequireSession(db, consume, session, ct);
            options = await MfaStore.ReadFlow(db, consume, original, MfaStore.Purpose.Assertion, request.Token, consume: true, ct);
            await InstanceLease.CommitProtected(consume, _lease, ct);
        }
        CheckId(request.CredentialId, request.RawId);
        await using var verify = await InstanceLease.BeginProtected(db, _lease, ct);
        var current = await MfaStore.RequireSession(db, verify, session, ct);
        if (original.Id != current.Id || original.Generation != current.Generation || !original.Scope.AsSpan().SequenceEqual(current.Scope) ||
            await MfaStore.IsEnabled(db, verify, current.Id, ct)) throw MfaStore.Denied();
        await VerifyAssertion(db, verify, request, current.Id, AssertionOptions.FromJson(options), requireHandle: false, ct);
        var proof = await MfaStore.BeginFlow(db, verify, current, MfaStore.Purpose.SetupProof, "", ct);
        await InstanceLease.CommitProtected(verify, _lease, ct);
        return MfaWire.EncodeChallenge(true, MfaWire.Setup, proof);
    }

    private async Task<int> VerifyAssertion(NpgsqlConnection db, NpgsqlTransaction tx, PasskeyLoginRequest request,
        Guid userId, AssertionOptions options, bool requireHandle, CancellationToken ct)
    {
        byte[] handle, key;
        int number;
        uint counter;
        bool backupEligible;
        await using (var credential = Store.Sql(db, tx, """
            select s.account_id,s.user_handle,c.public_key,c.sign_count,c.backup_eligible from public.passkey_credential c
            join public.passkey_subject s on s.user_id=c.user_id
            where c.credential_id=$1 and c.user_id=$2 for update of c
            """, request.RawId, userId))
        await using (var row = await credential.ExecuteReaderAsync(ct))
        {
            if (!await row.ReadAsync(ct)) throw Denied();
            (number, handle, key, counter, backupEligible) =
                (row.GetInt32(0), row.GetFieldValue<byte[]>(1), row.GetFieldValue<byte[]>(2), checked((uint)row.GetInt64(3)), row.GetBoolean(4));
        }
        if (request.AuthenticatorData.Length < 37 ||
            ((requireHandle || request.UserHandle.Length > 0) && !CryptographicOperations.FixedTimeEquals(handle, request.UserHandle)))
            throw Denied();

        VerifyAssertionResult verification;
        try
        {
            verification = await PasskeyVerification.Assert(_verifier, request, options, handle, key, counter, ct);
        }
        catch (Fido2VerificationException) { throw Denied(); }

        // Fido2 4.0.1 accepts a signed zero even when the stored counter was positive.
        if (!AcceptsSignatureCounter(counter, verification.SignCount)) throw Denied();

        // The flag is covered by the verified authenticator data. Backup eligibility is immutable.
        if (((request.AuthenticatorData[32] & 0x08) != 0) != backupEligible) throw Denied();
        await SqlCommands.Execute(db, tx, ct, """
            update public.passkey_credential set sign_count=$2,backed_up=$3,last_used_at=clock_timestamp()
            where credential_id=$1
            """, request.RawId, (long)verification.SignCount, verification.IsBackedUp);
        return number;
    }

    internal static bool AcceptsSignatureCounter(uint stored, uint verified) =>
        (stored == 0 && verified == 0) || verified > stored;

    private static async Task<bool> HasCredential(NpgsqlConnection db, NpgsqlTransaction tx, Guid id, CancellationToken ct)
    {
        await using var cmd = Store.Sql(db, tx, "select exists(select 1 from public.passkey_credential where user_id=$1)", id);
        return (bool)(await cmd.ExecuteScalarAsync(ct))!;
    }

    private static async Task SaveChallenge(NpgsqlConnection db, NpgsqlTransaction tx, string token,
        string options, Guid? userId, long? generation, byte[]? binding, CancellationToken ct, int lifetimeSeconds = 300)
    {
        await SqlCommands.Execute(db, tx, ct, "select pg_advisory_xact_lock($1)", ChallengeBudgetLock);
        await SqlCommands.Execute(db, tx, ct, "delete from public.passkey_challenge where expires_at<=clock_timestamp()");
        await using var insert = Store.Sql(db, tx, """
            insert into public.passkey_challenge(digest,user_id,generation,options,expires_at,binding_digest)
            select $1,$2,$3,$4,clock_timestamp()+$7 * interval '1 second',$5
            where (select count(*) from public.passkey_challenge)<$6
            """, TokenDigest(token), SqlCommands.Optional(NpgsqlDbType.Uuid, userId),
            SqlCommands.Optional(NpgsqlDbType.Bigint, generation), options, SqlCommands.Optional(NpgsqlDbType.Bytea, binding), ChallengeCapacity, lifetimeSeconds);
        if (await insert.ExecuteNonQueryAsync(ct) != 1) throw new PublicUnavailableException();
    }

    private async Task<(string Options, Guid? UserId, long? Generation, DateTimeOffset ExpiresAt)> ConsumeChallenge(NpgsqlConnection db,
        string token, byte[]? binding, CancellationToken ct)
    {
        await using var tx = await InstanceLease.BeginProtected(db, _lease, ct);
        var challenge = await ConsumeChallenge(db, tx, token, binding, ct);
        await InstanceLease.CommitProtected(tx, _lease, ct);
        return challenge;
    }

    private static async Task<(string Options, Guid? UserId, long? Generation, DateTimeOffset ExpiresAt)> ConsumeChallenge(NpgsqlConnection db,
        NpgsqlTransaction tx, string token, byte[]? binding, CancellationToken ct)
    {
        await using var consume = Store.Sql(db, tx, """
            delete from public.passkey_challenge
            where digest=$1 and expires_at>clock_timestamp() and binding_digest is not distinct from $2
            returning options,user_id,generation,expires_at
            """, TokenDigest(token), SqlCommands.Optional(NpgsqlDbType.Bytea, binding));
        await using var row = await consume.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct)) throw Denied();
        return (row.GetString(0), row.IsDBNull(1) ? null : row.GetGuid(1), row.IsDBNull(2) ? null : row.GetInt64(2),
            row.GetFieldValue<DateTimeOffset>(3));
    }

    private static string NewToken() => WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
    private static byte[] TokenDigest(string token) => SHA256.HashData(Encoding.ASCII.GetBytes(token));

    private static void CheckId(string text, byte[] raw)
    {
        if (!string.Equals(WebEncoders.Base64UrlEncode(raw), text, StringComparison.Ordinal)) throw Denied();
    }

    private static BusinessException Denied() => new(Rejection.Unauthorized, "Passkey verification failed. Start a new ceremony.");
}
