using FsusBlog.V2.Core.Authentication;
using static FsusBlog.V2.Server.SqlCommands;

namespace FsusBlog.V2.Server.Passkeys;

internal sealed class MfaStore(NpgsqlDataSource source, TotpSecret secrets, InstanceLease? lease = null)
{
    private const int MaxFailures = 5;
    private const string Issuer = "FsusBlog";
    internal enum Purpose { Assertion = 1, SetupProof = 2, Login = 3, FactorChallenge = 4, FactorProof = 5 }
    internal sealed record Subject(Guid Id, long Generation, int Number, byte[] Scope);

    private Task<T> Run<T>(Func<NpgsqlConnection, NpgsqlTransaction, Task<T>> run, CancellationToken ct) =>
        InstanceLease.RunProtected(source, lease, run, ct);

    internal Task<byte[]> Profile(string? session, CancellationToken ct) => Run(async (db, tx) =>
    {
        var actor = await RequireSession(db, tx, session, ct);
        var value = await Scalar(db, tx, ct, "select verified_at from public.mfa_totp where user_id=$1", actor.Id);
        return MfaWire.EncodeProfile(value is DateTime time ? new DateTimeOffset(time) : null);
    }, ct);

    internal Task<byte[]> BeginSetup(string? session, string? proof, CancellationToken ct) => Run(async (db, tx) =>
    {
        var actor = await RequireSession(db, tx, session, ct);
        if (await IsEnabled(db, tx, actor.Id, ct)) throw Denied();
        await ConsumeProof(db, tx, actor, Purpose.SetupProof, proof, ct);
        var seed = RandomNumberGenerator.GetBytes(Totp.SecretBytes);
        try
        {
            await Execute(db, tx, ct, """
                insert into public.mfa_setup(user_id,generation,session_digest,sealed_seed,expires_at,failed_count)
                values($1,$2,$3,$4,clock_timestamp()+interval '5 minutes',0)
                on conflict (user_id) do update set generation=excluded.generation,session_digest=excluded.session_digest,
                    sealed_seed=excluded.sealed_seed,expires_at=excluded.expires_at,failed_count=0
                """, actor.Id, actor.Generation, actor.Scope, secrets.Seal(actor.Id, seed));
            var text = Totp.EncodeSecret(seed);
            var account = $"Account {actor.Number}";
            var uri = $"otpauth://totp/{Issuer}:{Uri.EscapeDataString(account)}?secret={text}&issuer={Issuer}&algorithm=SHA1&digits=6&period=30";
            return MfaWire.EncodeSetup(text, uri, Issuer, account);
        }
        finally { CryptographicOperations.ZeroMemory(seed); }
    }, ct);

    internal Task<(byte[] Frame, string Token, DateTimeOffset Expires)> CompleteSetup(string? session, string code, CancellationToken ct) =>
        Run(async (db, tx) =>
        {
            var actor = await RequireSession(db, tx, session, ct);
            var envelope = (await Scalar(db, tx, ct, """
                select sealed_seed from public.mfa_setup
                where user_id=$1 and generation=$2 and session_digest=$3 and expires_at>clock_timestamp() and failed_count<$4
                for update
                """, actor.Id, actor.Generation, actor.Scope, MaxFailures) as byte[]) ?? throw Denied();
            var matched = Match(actor.Id, envelope, code, -1);
            if (!matched.HasValue)
            {
                await Execute(db, tx, ct, "update public.mfa_setup set failed_count=failed_count+1 where user_id=$1", actor.Id);
                await InstanceLease.CommitProtected(tx, lease, ct);
                throw new BusinessException(Rejection.Invalid, "Invalid authenticator verification code.");
            }

            await Execute(db, tx, ct, """
                insert into public.mfa_totp(user_id,sealed_seed,last_step,verified_at,retry_after,failed_count)
                values($1,$2,$3,clock_timestamp(),clock_timestamp(),0)
                """, actor.Id, envelope, matched.Value);
            var recovery = await IssueRecoveryCodes(db, tx, actor.Id, WireLimits.MfaCodeCount, ct);
            await Execute(db, tx, ct, "delete from public.mfa_setup where user_id=$1", actor.Id);
            var (token, expiry) = await RotateSession(db, tx, actor, mfa: true, ct);
            return (MfaWire.EncodeSetupVerified(recovery), token, expiry);
        }, ct);

    internal Task<byte[]> BeginDisable(string? session, CancellationToken ct) =>
        BeginFactorChallenge(session, MfaWire.Disable, null, ct);

    internal Task<byte[]> BeginRecoveryRegeneration(string? session, CancellationToken ct, string? expectedSession = null) =>
        BeginFactorChallenge(session, MfaWire.Regenerate, expectedSession, ct);

    private Task<byte[]> BeginFactorChallenge(string? session, string action, string? expectedSession, CancellationToken ct) =>
        Run(async (db, tx) =>
        {
            var actor = await RequireSession(db, tx, session, ct);
            if (expectedSession is not null) SiteSessions.RequireCurrent(actor.Id, actor.Scope, expectedSession);
            if (!await IsEnabled(db, tx, actor.Id, ct)) throw Denied();
            var token = await BeginFlow(db, tx, actor, Purpose.FactorChallenge, FactorScope(action), ct);
            return MfaWire.EncodeChallenge(false, action, token);
        }, ct);

    internal Task<byte[]> VerifyDisable(string? session, MfaAttempt attempt, CancellationToken ct) =>
        VerifyFactorChallenge(session, attempt, MfaWire.Disable, null, ct);

    internal Task<byte[]> VerifyRecoveryRegeneration(string? session, MfaAttempt attempt, CancellationToken ct, string? expectedSession = null) =>
        VerifyFactorChallenge(session, attempt, MfaWire.Regenerate, expectedSession, ct);

    private Task<byte[]> VerifyFactorChallenge(string? session, MfaAttempt attempt, string action,
        string? expectedSession, CancellationToken ct)
    {
        if (attempt.Action != action) throw Denied();
        return Run(async (db, tx) =>
        {
            var actor = await RequireSession(db, tx, session, ct);
            if (expectedSession is not null) SiteSessions.RequireCurrent(actor.Id, actor.Scope, expectedSession);
            var scope = FactorScope(action);
            await ReadFlow(db, tx, actor, Purpose.FactorChallenge, attempt.Token, consume: false, ct, scope);
            if (!await VerifyFactor(db, tx, actor.Id, attempt, ct))
            {
                await InstanceLease.CommitProtected(tx, lease, ct);
                throw Denied();
            }
            await ReadFlow(db, tx, actor, Purpose.FactorChallenge, attempt.Token, consume: true, ct, scope);
            var proof = await BeginFlow(db, tx, actor, Purpose.FactorProof, scope, ct);
            return MfaWire.EncodeChallenge(true, action, proof);
        }, ct);
    }

    internal Task<(string Token, DateTimeOffset Expires)> Disable(string? session, string? proof, CancellationToken ct) =>
        Run(async (db, tx) =>
        {
            var actor = await RequireSession(db, tx, session, ct);
            await ConsumeProof(db, tx, actor, Purpose.FactorProof, proof, ct, FactorScope(MfaWire.Disable));
            await Execute(db, tx, ct, "delete from public.mfa_recovery_code where user_id=$1", actor.Id);
            await Execute(db, tx, ct, "delete from public.mfa_totp where user_id=$1", actor.Id);
            return await RotateSession(db, tx, actor, mfa: false, ct);
        }, ct);

    internal Task<byte[]> RegenerateRecoveryCodes(string? session, string? proof, CancellationToken ct, string? expectedSession = null) =>
        Run(async (db, tx) =>
        {
            var actor = await RequireSession(db, tx, session, ct);
            if (expectedSession is not null) SiteSessions.RequireCurrent(actor.Id, actor.Scope, expectedSession);
            await ConsumeProof(db, tx, actor, Purpose.FactorProof, proof, ct, MfaWire.Regenerate);
            if (!await IsEnabled(db, tx, actor.Id, ct))
            {
                await InstanceLease.CommitProtected(tx, lease, ct);
                throw new BusinessException(Rejection.Invalid, "Authenticator verification is not enabled.");
            }
            await Execute(db, tx, ct, "delete from public.mfa_recovery_code where user_id=$1", actor.Id);
            var recovery = await IssueRecoveryCodes(db, tx, actor.Id, WireLimits.MfaRegeneratedCodeCount, ct);
            return MfaWire.EncodeSetupVerified(recovery);
        }, ct);

    internal Task<(SiteRefreshStore.Issued Session, int Number)> FinishLogin(MfaAttempt attempt, string? binding,
        bool persistentEnabled, CancellationToken ct) => Run(async (db, tx) =>
    {
        var (digest, bound) = (FlowDigest(attempt.Token), FlowDigest(binding));
        var actor = await QueryRequired(db, tx, ct, """
            select u.id,u.generation,s.account_id,f.scope
            from public.blog_user u join public.passkey_subject s on s.user_id=u.id
            join public.mfa_flow f on f.user_id=u.id and f.generation=u.generation
            where u.enabled and f.digest=$1 and f.kind=$2 and f.expires_at>clock_timestamp() for update of u
            """, r => new Subject(r.GetGuid(0), r.GetInt64(1), r.GetInt32(2), r.GetFieldValue<byte[]>(3)),
            Denied, digest, (int)Purpose.Login);
        if (actor.Scope.Length <= bound.Length || !CryptographicOperations.FixedTimeEquals(actor.Scope.AsSpan(0, bound.Length), bound))
            throw Denied();
        var options = await ReadFlow(db, tx, actor, Purpose.Login, attempt.Token, consume: false, ct);
        var persistent = options switch { "" => false, "persistent" when persistentEnabled => true, _ => throw Denied() };
        if (!await VerifyFactor(db, tx, actor.Id, attempt, ct))
        {
            await InstanceLease.CommitProtected(tx, lease, ct);
            throw Denied();
        }
        await ReadFlow(db, tx, actor, Purpose.Login, attempt.Token, consume: true, ct);
        var session = await IssueSession(db, tx, actor.Id, actor.Generation, actor.Scope[bound.Length..], mfa: true, persistent, ct);
        return (session, actor.Number);
    }, ct);

    internal static async Task<SiteRefreshStore.Issued> IssueSession(NpgsqlConnection db,
        NpgsqlTransaction tx, Guid id, long generation, byte[] credential, bool mfa, bool persistent, CancellationToken ct)
    {
        var (token, digest) = SiteRefreshStore.NewToken();
        var expires = new DateTimeOffset((DateTime)(await Scalar(db, tx, ct, """
            insert into public.user_session(digest,user_id,generation,expires_at,passkey_credential_id,totp_verified_at)
            values($1,$2,$3,clock_timestamp()+interval '8 hours',$4,case when $5 then clock_timestamp() else null end)
            returning expires_at
            """, digest, id, generation, credential, mfa))!);
        return persistent ? await SiteRefreshStore.Start(db, tx, token, expires, ct) : new(token, expires);
    }

    internal static async Task<Subject> RequireSession(NpgsqlConnection db, NpgsqlTransaction tx, string? token, CancellationToken ct)
    {
        var digest = Store.TokenDigest(token) ?? throw Denied();
        var actor = await QueryRequired(db, tx, ct, """
            select u.id,u.generation,p.account_id
            from public.blog_user u join public.passkey_subject p on p.user_id=u.id
            where u.enabled and u.id=(select user_id from public.user_session where digest=$1)
            for update of u
            """, r => new Subject(r.GetGuid(0), r.GetInt64(1), r.GetInt32(2), digest), Denied, digest);
        if (await Scalar(db, tx, ct, """
            select 1 from public.user_session where digest=$1 and user_id=$2 and generation=$3
            and passkey_credential_id is not null and expires_at>clock_timestamp() for update
            """, actor.Scope, actor.Id, actor.Generation) is null) throw Denied();
        return actor;
    }

    internal static async Task<bool> IsEnabled(NpgsqlConnection db, NpgsqlTransaction tx, Guid subject, CancellationToken ct) =>
        (bool)(await Scalar(db, tx, ct, "select exists (select 1 from public.mfa_totp where user_id=$1)", subject))!;

    internal static async Task<string> BeginFlow(NpgsqlConnection db, NpgsqlTransaction tx, Subject actor,
        Purpose kind, string options, CancellationToken ct)
    {
        var token = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
        await Execute(db, tx, ct, "delete from public.mfa_flow where user_id=$1 and (kind=$2 or expires_at<=clock_timestamp())",
            actor.Id, (int)kind);
        await Execute(db, tx, ct, """
            insert into public.mfa_flow(digest,user_id,generation,kind,scope,options,expires_at)
            values($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '5 minutes')
            """, FlowDigest(token, options), actor.Id, actor.Generation, (int)kind, actor.Scope, options);
        return token;
    }

    internal static async Task<string> ReadFlow(NpgsqlConnection db, NpgsqlTransaction tx, Subject actor,
        Purpose kind, string? token, bool consume, CancellationToken ct, string? options = null)
    {
        const string key = """
            from public.mfa_flow where digest=$1 and user_id=$2 and generation=$3 and kind=$4 and scope=$5 and expires_at>clock_timestamp()
            """;
        var filter = options is null ? key : key + " and options=$6";
        object[] coordinates = [FlowDigest(token, options), actor.Id, actor.Generation, (int)kind, actor.Scope];
        return (await Scalar(db, tx, ct,
            (consume ? "delete " + filter + " returning options" : "select options " + filter + " for update"),
            options is null ? coordinates : [.. coordinates, options]) as string) ?? throw Denied();
    }

    private static async Task ConsumeProof(NpgsqlConnection db, NpgsqlTransaction tx, Subject actor,
        Purpose kind, string? proof, CancellationToken ct, string? options = null)
    {
        try { await ReadFlow(db, tx, actor, kind, proof, consume: true, ct, options); }
        catch (BusinessException error) when (error.Rejection == Rejection.Unauthorized)
        {
            throw new MfaProofRequiredException();
        }
    }

    private static string FactorScope(string action) => action == MfaWire.Disable ? "" : action;

    private static async Task<string[]> IssueRecoveryCodes(NpgsqlConnection db, NpgsqlTransaction tx, Guid user, int count, CancellationToken ct)
    {
        var recovery = new string[count];
        for (var i = 0; i < recovery.Length; i++)
        {
            var raw = RandomNumberGenerator.GetBytes(16);
            try
            {
                var text = Convert.ToHexString(raw);
                recovery[i] = string.Join('-', Enumerable.Range(0, 8).Select(index => text.Substring(index * 4, 4)));
                await Execute(db, tx, ct, "insert into public.mfa_recovery_code(user_id,digest) values($1,$2)", user, SHA256.HashData(raw));
            }
            finally { CryptographicOperations.ZeroMemory(raw); }
        }
        return recovery;
    }

    private async Task<bool> VerifyFactor(NpgsqlConnection db, NpgsqlTransaction tx, Guid id, MfaAttempt attempt, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(attempt.Recovery) == string.IsNullOrEmpty(attempt.Code)) return false;
        var row = await QueryOneValue(db, tx, ct, """
            select sealed_seed,last_step,case when failed_count>=5 then 0 else failed_count end
            from public.mfa_totp where user_id=$1 and retry_after<=clock_timestamp() for update
            """, r => (Envelope: r.GetFieldValue<byte[]>(0), LastStep: r.GetInt64(1), FailedCount: r.GetInt32(2)), id);
        if (row is not var (envelope, lastStep, failedCount)) return false;
        var step = Match(id, envelope, attempt.Code, lastStep);
        var verified = step.HasValue;
        if (!verified && RecoveryDigest(attempt.Recovery) is { } recovery)
            verified = await Execute(db, tx, ct,
                "delete from public.mfa_recovery_code where user_id=$1 and digest=$2", id, recovery) == 1;
        await Execute(db, tx, ct, """
            update public.mfa_totp set last_step=$2,failed_count=$3,
                retry_after=case when $3>=5 then clock_timestamp()+interval '5 minutes' else clock_timestamp() end
            where user_id=$1
            """, id, step ?? lastStep, verified ? 0 : failedCount + 1);
        return verified;
    }

    private long? Match(Guid id, byte[] envelope, string code, long lastStep)
    {
        if (!Totp.IsCode(code)) return null;
        var secret = secrets.Open(id, envelope);
        try { return Totp.Match(secret, code, DateTimeOffset.UtcNow, lastStep); }
        finally { CryptographicOperations.ZeroMemory(secret); }
    }

    private static byte[]? RecoveryDigest(string input)
    {
        if (input.Length != 39 || input.Where((c, i) => i % 5 == 4 ? c != '-' : !char.IsAsciiHexDigit(c)).Any())
            return null;
        var bytes = Convert.FromHexString(input.Replace("-", "", StringComparison.Ordinal));
        try { return SHA256.HashData(bytes); }
        finally { CryptographicOperations.ZeroMemory(bytes); }
    }

    internal static byte[] FlowDigest(string? token, string? action = null)
    {
        if (!PasskeyStore.IsBase64Url43(token)) throw Denied();
        // Prior builds recognized kinds 4 and 5 as disable and checked only the unscoped digest.
        var input = action == MfaWire.Regenerate ? $"{MfaWire.Regenerate}:{token}" : token!;
        return SHA256.HashData(Encoding.ASCII.GetBytes(input));
    }

    private static async Task<(string Token, DateTimeOffset Expires)> RotateSession(NpgsqlConnection db,
        NpgsqlTransaction tx, Subject actor, bool mfa, CancellationToken ct)
    {
        var (token, digest) = SiteRefreshStore.NewToken();
        await Execute(db, tx, ct, "update public.blog_user set generation=generation+1 where id=$1", actor.Id);
        var expiry = await Scalar(db, tx, ct, """
            insert into public.user_session(digest,user_id,generation,expires_at,passkey_credential_id,totp_verified_at)
            select $1,s.user_id,u.generation,s.expires_at,s.passkey_credential_id,case when $2 then clock_timestamp() else null end
            from public.user_session s join public.blog_user u on u.id=s.user_id
            where s.digest=$3 and s.expires_at>clock_timestamp()
            returning expires_at
            """, digest, mfa, actor.Scope) is DateTime expiresAt ? expiresAt : throw Denied();
        await Execute(db, tx, ct, "delete from public.user_session where user_id=$1 and digest<>$2", actor.Id, digest);
        await Execute(db, tx, ct, "delete from public.mfa_flow where user_id=$1", actor.Id);
        return (token, expiry);
    }

    internal static BusinessException Denied() => new(Rejection.Unauthorized, "MFA verification failed or expired.");
}

internal sealed class MfaProofRequiredException : Exception;
