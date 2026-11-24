using static FsusBlog.V2.Server.SqlCommands;

namespace FsusBlog.V2.Server.Passkeys;

internal sealed class PasskeyStore(NpgsqlDataSource source, PasskeyConfiguration configuration, InstanceLease? lease = null)
{
    private readonly Fido2 _verifier = configuration.CreateVerifier();
    private const long ChallengeBudgetLock = 716729109726707502L;
    private const int ChallengeCapacity = 4096;
    private const int EnrollmentLifetimeSeconds = 120;
    private const short RecoveryAssertion = 1;
    private const short RecoveryProof = 2;

    private sealed record RecoveryAccount(Guid Id, long Generation, byte[] Handle);
    private sealed record EnrollmentState(byte[] Handle, byte[] Current, IReadOnlyList<byte[]> Credentials);
    private sealed record EnrollmentIntent(string Session, string CredentialSet, string Options);
    private sealed record CredentialIntent(byte[] Target, long ExpectedRevision, string? Name, byte[] ProofCredential,
        string Options, long? CreatedAtTicks, long? RecoveryVersion, int? DeviceCount);

    private Task<T> Run<T>(Func<NpgsqlConnection, NpgsqlTransaction, Task<T>> run, CancellationToken ct) =>
        InstanceLease.RunProtected(source, lease, run, ct);

    private Task Run(Func<NpgsqlConnection, NpgsqlTransaction, Task> run, CancellationToken ct) =>
        InstanceLease.RunProtected(source, lease, run, ct);

    private Task<T> Run<T>(NpgsqlConnection db, Func<NpgsqlTransaction, Task<T>> run, CancellationToken ct) =>
        InstanceLease.RunProtected(db, lease, run, ct);

    internal Task<byte[]> BeginLogin(CancellationToken ct) => Run(async (db, tx) =>
    {
        var options = _verifier.RequestAssertion([]);
        var token = NewToken();
        await SaveChallenge(db, tx, token, options.ToJson(), null, null, null, ct);
        return options.LoginFrame(token);
    }, ct);

    internal Task<(byte[] Frame, string Binding)> BeginProvision(string ticket, CancellationToken ct)
    {
        if (ticket is not { Length: 64 } || !ticket.All(char.IsAsciiHexDigitLower)) throw Denied();
        var digest = SHA256.HashData(Convert.FromHexString(ticket));
        return Run(async (db, tx) =>
        {
            var (userId, generation) = await QueryRequired(db, tx, ct, """
                select id,generation from public.blog_user
                where enabled and id=(select user_id from public.login_ticket where digest=$1 and expires_at>clock_timestamp())
                for update
                """, r => (r.GetGuid(0), r.GetInt64(1)), Denied, digest);

            if (await HasCredential(db, tx, userId, ct) || await CurrentSchema.RequiresSiteRecoveryAsync(db, tx, userId, ct)) throw Denied();
            if (await Execute(db, tx, ct, """
                delete from public.login_ticket where user_id=$1 and digest=$2 and expires_at>clock_timestamp()
                """, userId, digest) != 1) throw Denied();

            await Execute(db, tx, ct, """
                insert into public.passkey_subject(user_id,user_handle) values ($1,$2) on conflict (user_id) do nothing
                """, userId, RandomNumberGenerator.GetBytes(WireLimits.PasskeyUserHandleBytes));
            var userHandle = (byte[])(await Scalar(db, tx, ct, "select user_handle from public.passkey_subject where user_id=$1", userId))!;

            var options = _verifier.RequestRegistration(userHandle);
            var (token, binding) = (NewToken(), NewToken());
            await SaveChallenge(db, tx, token, options.ToJson(), userId, generation, TokenDigest(binding), ct);
            return (options.RegistrationFrame(token), binding);
        }, ct);
    }

    internal async Task CompleteProvision(PasskeyProvisionRequest request, string? binding, CancellationToken ct)
    {
        var bindingDigest = RecoveryTokenDigest(binding) ?? throw Denied();
        await using var db = await source.OpenConnectionAsync(ct);
        var challenge = await Run(db, tx => ConsumeChallenge(db, tx, request.Token, bindingDigest, ct), ct);
        CheckId(request.CredentialId, request.RawId);
        var accountId = challenge.UserId!.Value;
        var options = CredentialCreateOptions.FromJson(challenge.Options);
        await InstanceLease.RunProtected(db, lease, async tx =>
        {
            if (await Scalar(db, tx, ct, """
                select 1 from public.blog_user u join public.passkey_subject s on s.user_id=u.id
                where u.id=$1 and u.enabled and u.generation=$2 and s.user_handle=$3 for update of u
                """, accountId, challenge.Generation!.Value, options.User.Id) is null) throw Denied();
            if (await HasCredential(db, tx, accountId, ct) || await CurrentSchema.RequiresSiteRecoveryAsync(db, tx, accountId, ct)) throw Denied();

            await RegisterCredential(db, tx, accountId, request, options, ct);

            // Fail stale credential-attachment challenges and retire bootstrap sessions atomically.
            await Execute(db, tx, ct, "update public.blog_user set generation=generation+1 where id=$1", accountId);
            await Execute(db, tx, ct, "delete from public.login_ticket where user_id=$1", accountId);
            await Execute(db, tx, ct, "delete from public.user_session where user_id=$1", accountId);
        }, ct);
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
        await using var db = await source.OpenConnectionAsync(ct);
        var challenge = await Run(db, tx => ConsumeChallenge(db, tx, request.Token, null, ct), ct);
        CheckId(request.CredentialId, request.RawId);

        return await Run(db, async tx =>
        {
            var reader = await QueryOneValue(db, tx, ct, """
                select u.id,u.generation from public.blog_user u
                where u.enabled and u.id=(select user_id from public.passkey_credential where credential_id=$1)
                for update
                """, r => (Id: r.GetGuid(0), Generation: r.GetInt64(1)), request.RawId);
            if (reader is var (userId, userGeneration))
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
                    return new UnifiedLoginResult(null, number, mfa, binding, null);
                }
                var session = await MfaStore.IssueSession(db, tx, userId, userGeneration, request.RawId, mfa: false, request.RememberMe, ct);
                return new(session, number, null, null, null);
            }

            if (adminStore is null) throw Denied();
            var adminToken = await adminStore.CompleteUnifiedLogin(db, tx, request, challenge.Options,
                challenge.ExpiresAt - TimeSpan.FromSeconds(300), ct);
            return new(null, 0, null, null, adminToken);
        }, ct);
    }

    internal Task<byte[]> BeginSetupProof(string? session, CancellationToken ct) => Run(async (db, tx) =>
    {
        var actor = await MfaStore.RequireSession(db, tx, session, ct);
        if (await MfaStore.IsEnabled(db, tx, actor.Id, ct)) throw MfaStore.Denied();
        var (options, ids) = await RestrictedAssertion(db, tx, actor.Id, ct);
        var token = await MfaStore.BeginFlow(db, tx, actor, MfaStore.Purpose.Assertion, options.ToJson(), ct);
        return options.LoginFrame(token, ids);
    }, ct);

    internal Task<byte[]> CompleteSetupProof(string? session, PasskeyLoginRequest request, CancellationToken ct) =>
        CompleteAssertion(session, expected: null, requireCurrent: false, request,
            (db, tx, actor) => MfaStore.ReadFlow(db, tx, actor, MfaStore.Purpose.Assertion, request.Token, consume: true, ct),
            async (db, tx, current, options) =>
            {
                if (await MfaStore.IsEnabled(db, tx, current.Id, ct)) throw MfaStore.Denied();
                await VerifyAssertion(db, tx, request, current.Id, AssertionOptions.FromJson(options), requireHandle: false, ct);
                var proof = await MfaStore.BeginFlow(db, tx, current, MfaStore.Purpose.SetupProof, "", ct);
                return MfaWire.EncodeChallenge(true, MfaWire.Setup, proof);
            }, ct, checkIdFirst: false, mismatch: MfaStore.Denied);

    internal Task<byte[]> BeginReaderRegistration(string binding,
        Func<NpgsqlConnection, NpgsqlTransaction, Task> admit, CancellationToken ct) => Run(async (db, tx) =>
    {
        var token = NewToken();
        var key = ReaderRegistrationKey(token, binding);
        await admit(db, tx);
        var options = _verifier.RequestRegistration(RandomNumberGenerator.GetBytes(WireLimits.PasskeyUserHandleBytes));
        await SaveChallenge(db, tx, key, options.ToJson(), null, null, null, ct);
        return options.RegistrationFrame(token);
    }, ct);

    internal async Task CompleteReaderRegistration(PasskeyProvisionRequest request, string? binding, CancellationToken ct)
    {
        var key = ReaderRegistrationKey(request.Token, binding);
        await using var db = await source.OpenConnectionAsync(ct);
        // Retire an attempted ceremony before attestation, just like first-Passkey provisioning.
        var challenge = await Run(db, tx => ConsumeChallenge(db, tx, key, null, ct), ct);
        if (challenge.UserId is not null || challenge.Generation is not null) throw Denied();
        CheckId(request.CredentialId, request.RawId);
        var options = CredentialCreateOptions.FromJson(challenge.Options);
        var id = Guid.NewGuid();
        await InstanceLease.RunProtected(db, lease, async tx =>
        {
            await Execute(db, tx, ct, """
                insert into public.blog_user(id,name,enabled,generation) values($1,$2,true,1)
                """, id, "reader-" + id.ToString("N"));
            await Execute(db, tx, ct, "insert into public.passkey_subject(user_id,user_handle) values($1,$2)", id, options.User.Id);
            await RegisterCredential(db, tx, id, request, options, ct);
        }, ct);
    }

    internal static string NewReaderRegistrationBinding() => NewToken();

    internal static bool ValidReaderRegistrationToken(string? value) =>
        IsBase64Url43(value) && WebEncoders.Base64UrlEncode(WebEncoders.Base64UrlDecode(value!)) == value;

    private static string ReaderRegistrationKey(string token, string? binding)
    {
        if (!ValidReaderRegistrationToken(token) || !ValidReaderRegistrationToken(binding)) throw Denied();
        return "reader-registration:" + token + ":" + binding;
    }

    internal Task<bool> RecoveryKeyStatus(string? session, CancellationToken ct) => Run(async (db, tx) =>
    {
        var actor = await MfaStore.RequireSession(db, tx, session, ct);
        return await Scalar(db, tx, ct,
            "select exists (select from public.site_recovery_key where user_id=$1 and used_at is null)", actor.Id) is true;
    }, ct);

    internal Task<byte[]> BeginRecoveryKeyStepUp(string? session, RecoveryKeyOperation operation, CancellationToken ct) => Run(async (db, tx) =>
    {
        var actor = await MfaStore.RequireSession(db, tx, session, ct);
        var (options, ids) = await RestrictedAssertion(db, tx, actor.Id, ct);
        var token = await SaveRecoveryFlow(db, tx, actor, (short)operation.Operation, RecoveryAssertion, options.ToJson(), 120, ct);
        return options.LoginFrame(token, ids);
    }, ct);

    internal Task<byte[]> CompleteRecoveryKeyStepUp(string? session, PasskeyLoginRequest request, CancellationToken ct) =>
        CompleteAssertion(session, expected: null, requireCurrent: false, request,
            (db, tx, actor) => QueryRequired(db, tx, ct, """
                delete from public.site_recovery_flow
                where digest=$1 and user_id=$2 and generation=$3 and session_digest=$4 and kind=$5
                    and expires_at>clock_timestamp()
                returning purpose,options
                """, r => (Op: r.GetInt16(0), Options: r.GetString(1)), Denied,
                MfaStore.FlowDigest(request.Token), actor.Id, actor.Generation, actor.Scope, RecoveryAssertion),
            async (db, tx, current, flow) =>
            {
                await VerifyAssertion(db, tx, request, current.Id, AssertionOptions.FromJson(flow.Options), requireHandle: false, ct);
                var proof = await SaveRecoveryFlow(db, tx, current, flow.Op, RecoveryProof, null, 45, ct);
                return MfaWire.EncodeChallenge(true, flow.Op == 1 ? "recovery-key.create" : "recovery-key.rotate", proof);
            }, ct);

    internal Task<RecoveryKeyIssued> IssueRecoveryKey(RecoveryKeySecret secret, string? session,
        RecoveryKeyOperation operation, string? proof, CancellationToken ct) => Run(async (db, tx) =>
    {
        var actor = await MfaStore.RequireSession(db, tx, session, ct);
        if (RecoveryTokenDigest(proof) is not { } proofDigest) throw new RecoveryKeyProofRequiredException();
        if (await Execute(db, tx, ct, """
            delete from public.site_recovery_flow
            where digest=$1 and user_id=$2 and generation=$3 and session_digest=$4 and purpose=$5 and kind=$6
                and expires_at>clock_timestamp()
            """, proofDigest, actor.Id, actor.Generation, actor.Scope, (short)operation.Operation, RecoveryProof) != 1)
            throw new RecoveryKeyProofRequiredException();
        if (await Scalar(db, tx, ct, """
            select not exists (
                select from public.site_recovery_rebind where user_id=$1 and generation=$2
                    and expires_at>clock_timestamp() and completed_at is null
            ) and (
                $3 or not exists (select from public.site_recovery_key where user_id=$1 and used_at is null)
            )
            """, actor.Id, actor.Generation, operation.Operation == 2) is not true)
            throw new BusinessException(Rejection.Conflict, "A current key or recovery ceremony already exists.");
        var key = secret.Generate();
        return await QueryRequired(db, tx, ct, """
            insert into public.site_recovery_key as existing
                (user_id,lookup_digest,salt,verifier,version,created_at,failed_count)
            values ($1,$2,$3,$4,1,clock_timestamp(),0)
            on conflict (user_id) do update set lookup_digest=excluded.lookup_digest, salt=excluded.salt,
                verifier=excluded.verifier,version=existing.version+1,created_at=excluded.created_at,used_at=null,
                failed_count=0,failure_until=clock_timestamp()
            returning version,created_at
            """, r => new RecoveryKeyIssued(key.Key, r.GetInt64(0), r.GetUnixMilliseconds(1)), null,
            actor.Id, key.Lookup, key.Salt, key.Verifier);
    }, ct);

    internal async Task<string> VerifySiteRecoveryKey(RecoveryKeySecret secret, string key,
        Func<NpgsqlConnection, NpgsqlTransaction, Task> consumePow, CancellationToken ct)
    {
        var lookup = secret.Lookup(key);
        await using var db = await source.OpenConnectionAsync(ct);
        // Spend the anonymous proof before running its protected operation, including failed guesses.
        await InstanceLease.RunProtected(db, lease, proof => consumePow(db, proof), ct);

        return await Run(db, async tx =>
        {
            var (account, generation) = await QueryRequired(db, tx, ct, """
                select u.id,u.generation from public.blog_user u where u.enabled and u.id=(
                    select user_id from public.site_recovery_key where lookup_digest=$1 and used_at is null
                ) for update of u
                """, r => (r.GetGuid(0), r.GetInt64(1)), Denied, lookup);
            var (salt, verifier) = await QueryRequired(db, tx, ct, """
                select salt,verifier from public.site_recovery_key where user_id=$1 and lookup_digest=$2
                    and used_at is null and (failed_count<8 or failure_until<=clock_timestamp()) for update
                """, r => (r.GetFieldValue<byte[]>(0), r.GetFieldValue<byte[]>(1)), Denied, account, lookup);
            if (!secret.Verify(key, salt, verifier))
            {
                await RecoveryWrite(db, tx, ct, """
                    update public.site_recovery_key set
                        failed_count=case when failure_until<=clock_timestamp() then 1 else failed_count+1 end,
                        failure_until=case when failure_until<=clock_timestamp()
                            then clock_timestamp()+interval '10 minutes' else failure_until end
                    where user_id=$1
                    """, account);
                await InstanceLease.CommitProtected(tx, lease, ct);
                throw Denied();
            }
            var ticket = NewToken();
            await RecoveryWrite(db, tx, ct, """
                update public.site_recovery_key set failed_count=0, failure_until=clock_timestamp()
                where user_id=$1 and used_at is null
                """, account);
            await RecoveryWrite(db, tx, ct, """
                insert into public.site_recovery_rebind as pending(user_id,generation,ticket_digest,expires_at)
                values($1,$2,$3,clock_timestamp()+interval '10 minutes')
                on conflict(user_id) do update set generation=excluded.generation,ticket_digest=excluded.ticket_digest,
                    expires_at=case when pending.generation=excluded.generation and pending.completed_at is null
                        and pending.expires_at>clock_timestamp() then pending.expires_at else excluded.expires_at end,
                    challenge_digest=null,options=null,challenge_expires_at=null,
                    request_digest=null,completed_at=null
                """, account, generation, TokenDigest(ticket));
            return ticket;
        }, ct);
    }

    internal Task<byte[]> BeginRecoveryRebind(string? ticket, CancellationToken ct)
    {
        var digest = RecoveryTokenDigest(ticket) ?? throw Denied();
        return Run(async (db, tx) =>
        {
            var account = await LockRecoveryAccount(db, tx, digest, ct);
            var options = _verifier.RequestRegistration(account.Handle);
            var challenge = NewToken();
            await RecoveryWrite(db, tx, ct, """
                update public.site_recovery_rebind set challenge_digest=$3,options=$4,
                    challenge_expires_at=least(expires_at,clock_timestamp()+interval '2 minutes')
                where user_id=$1 and ticket_digest=$2 and generation=$5 and completed_at is null and expires_at>clock_timestamp()
                """, account.Id, digest, TokenDigest(challenge), options.ToJson(), account.Generation);
            return options.RegistrationFrame(challenge);
        }, ct);
    }

    internal Task CompleteRecoveryRebind(string? ticket, PasskeyProvisionRequest request, byte[] requestDigest,
        CancellationToken ct)
    {
        var digest = RecoveryTokenDigest(ticket) ?? throw Denied();
        CheckId(request.CredentialId, request.RawId);
        return Run(async (db, tx) =>
        {
            var account = await LockRecoveryAccount(db, tx, digest, ct);
            var options = await QueryRequired(db, tx, ct, """
                select generation,request_digest,case when challenge_digest=$3 and challenge_expires_at>clock_timestamp()
                    then options end
                from public.site_recovery_rebind
                where user_id=$1 and ticket_digest=$2 and expires_at>clock_timestamp() for update
                """, row =>
            {
                var generation = row.GetInt64(0);
                if (!row.IsDBNull(1))
                {
                    if (account.Generation != generation + 1 ||
                        !CryptographicOperations.FixedTimeEquals(row.GetFieldValue<byte[]>(1), requestDigest)) throw Denied();
                    return (string?)null;
                }
                if (generation != account.Generation || row.IsDBNull(2)) throw Denied();
                return row.GetString(2);
            }, Denied, account.Id, digest, TokenDigest(request.Token));
            if (options is null) return;

            var registration = CredentialCreateOptions.FromJson(options);
            if (!CryptographicOperations.FixedTimeEquals(registration.User.Id, account.Handle)) throw Denied();

            // Insert before deleting old credentials so an existing credential ID cannot be registered as new.
            var replacementId = await RegisterCredential(db, tx, account.Id, request, registration, ct);
            await Execute(db, tx, ct, "delete from public.user_session where user_id=$1", account.Id);
            await Execute(db, tx, ct, "delete from public.passkey_credential where user_id=$1 and credential_id<>$2",
                account.Id, replacementId);
            await RecoveryWrite(db, tx, ct, """
                update public.site_recovery_key set used_at=clock_timestamp() where user_id=$1 and used_at is null
                """, account.Id);
            await EnterPasskeyRecovery(db, tx, account.Id, ct);
            await RecoveryWrite(db, tx, ct, """
                update public.site_recovery_rebind set challenge_digest=null,options=null,challenge_expires_at=null,
                    request_digest=$3,completed_at=clock_timestamp()
                where user_id=$1 and ticket_digest=$2 and expires_at>clock_timestamp() and challenge_expires_at>clock_timestamp()
                """, account.Id, digest, requestDigest);
        }, ct);
    }

    internal Task<byte[]> BeginSitePasskeyEnrollment(string? session, string? expected, CancellationToken ct) => Run(async (db, tx) =>
    {
        var actor = await RequireCurrentPasskeySession(db, tx, session, expected, ct);
        var state = await ReadEnrollmentState(db, tx, actor, ct);
        await RequireNoEnrollment(db, tx, actor, ct);
        byte[][] allowed = [state.Current];
        var options = _verifier.RequestAssertion(allowed);
        var token = NewToken();
        await SaveChallenge(db, tx, token, options.ToJson(), actor.Id, actor.Generation, EnrollmentApprovalBinding(actor.Scope), ct,
            EnrollmentLifetimeSeconds);
        return options.LoginFrame(token, allowed);
    }, ct);

    internal Task<byte[]> ApproveSitePasskeyEnrollment(string? session, string? expected, PasskeyLoginRequest request, CancellationToken ct) =>
        CompleteAssertion(session, expected, requireCurrent: true, request,
            (db, tx, actor) => ConsumeOwnedChallenge(db, tx, actor, request.Token, EnrollmentApprovalBinding(actor.Scope), ct),
            async (db, tx, actor, approvedOptions) =>
            {
                var state = await ReadEnrollmentState(db, tx, actor, ct);
                if (!CryptographicOperations.FixedTimeEquals(state.Current, request.RawId)) throw Denied();
                await RequireNoEnrollment(db, tx, actor, ct);
                await VerifyAssertion(db, tx, request, actor.Id, AssertionOptions.FromJson(approvedOptions), requireHandle: false, ct);
                await RequireCurrentPasskeySession(db, tx, session, expected, ct);

                var options = _verifier.RequestRegistration(state.Handle);
                var intent = new EnrollmentIntent(expected!, EnrollmentSet(state.Credentials), options.ToJson());
                var token = NewToken();
                await SaveChallenge(db, tx, token, JsonSerializer.Serialize(intent), actor.Id, actor.Generation,
                    EnrollmentCreationBinding(actor.Id), ct, EnrollmentLifetimeSeconds);
                return PasskeyWire.EnrollmentBegin(token, checked((uint)options.Timeout), options.Rp.Id, options.Rp.Name,
                    options.User.Name, options.User.DisplayName, options.User.Id, options.Challenge,
                    options.PubKeyCredParams.Select(parameter => (int)parameter.Alg).ToArray(), state.Credentials);
            }, ct);

    internal Task CompleteSitePasskeyEnrollment(string? session, string? expected, PasskeyProvisionRequest request, CancellationToken ct)
    {
        CheckId(request.CredentialId, request.RawId);
        return Run(async (db, tx) =>
        {
            var actor = await RequireCurrentPasskeySession(db, tx, session, expected, ct);
            var raw = await ConsumeOwnedChallenge(db, tx, actor, request.Token, EnrollmentCreationBinding(actor.Id), ct);
            var intent = JsonSerializer.Deserialize<EnrollmentIntent>(raw) ?? throw Denied();
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
                await InstanceLease.CommitProtected(tx, lease, ct);
                throw;
            }
        }, ct);
    }

    internal Task<byte[]> BeginSitePasskeyRename(string? session, string? expected, SitePasskeyRename request, CancellationToken ct) =>
        BeginSitePasskeyChange(session, expected, request.Reference, request.ExpectedRevision, NormalizeCredentialName(request.Name), ct);

    internal Task<byte[]> BeginSitePasskeyRemove(string? session, string? expected, SitePasskeyRemove request, CancellationToken ct) =>
        BeginSitePasskeyChange(session, expected, request.Reference, request.ExpectedRevision, name: null, ct);

    internal Task<byte[]> BeginSitePasskeyRemoveCurrent(string? session, string? expected, string? ticket, CancellationToken ct) =>
        BeginSitePasskeyChange(session, expected, null, 0, null, ct, RecoveryTokenDigest(ticket) ?? throw Denied());

    private Task<byte[]> BeginSitePasskeyChange(string? session, string? expected, string? reference, long revision, string? name,
        CancellationToken ct, byte[]? recovery = null) => Run(async (db, tx) =>
    {
        var remove = name is null;
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
        await SaveChallenge(db, tx, token, JsonSerializer.Serialize(intent), actor.Id, actor.Generation,
            ChangeBinding(actor.Scope, remove, recovery), ct, recovery is null ? 300 : 120);
        return options.LoginFrame(token, allowed);
    }, ct);

    internal Task CompleteSitePasskeyRename(string? session, string? expected, PasskeyLoginRequest request, CancellationToken ct) =>
        CompleteSitePasskeyChange(session, expected, request, remove: false, ct);

    internal Task<bool> CompleteSitePasskeyRemove(string? session, string? expected, PasskeyLoginRequest request, CancellationToken ct) =>
        CompleteSitePasskeyChange(session, expected, request, remove: true, ct);

    internal Task CompleteSitePasskeyRemoveCurrent(string? session, string? expected, string? ticket, PasskeyLoginRequest request, CancellationToken ct) =>
        CompleteSitePasskeyChange(session, expected, request, remove: true, ct, RecoveryTokenDigest(ticket) ?? throw Denied());

    private async Task<bool> CompleteSitePasskeyChange(string? session, string? expected, PasskeyLoginRequest request, bool remove,
        CancellationToken ct, byte[]? recovery = null)
    {
        var (changed, removingCurrent) = await CompleteAssertion(session, expected, requireCurrent: true, request,
            async (db, tx, actor) =>
            {
                if (!await CurrentSchema.HasSitePasskeyNamesAsync(db, tx, ct))
                    throw new BusinessException(Rejection.NotFound, "Passkey names are unavailable.");
                var raw = await ConsumeOwnedChallenge(db, tx, actor, request.Token, ChangeBinding(actor.Scope, remove, recovery), ct);
                var parsed = JsonSerializer.Deserialize<CredentialIntent>(raw) ?? throw Denied();
                if (recovery is not null && parsed.RecoveryVersion != await CurrentRecoveryVersion(db, tx, actor, recovery, ct))
                    throw Denied();
                return parsed;
            },
            async (db, tx, current, intent) =>
            {
                await VerifyAssertion(db, tx, request, current.Id, AssertionOptions.FromJson(intent.Options), requireHandle: false, ct);
                await MfaStore.RequireSession(db, tx, session, ct);
                if (recovery is not null && intent.RecoveryVersion != await CurrentRecoveryVersion(db, tx, current, recovery, ct))
                    throw Denied();
                var isCurrent = remove && intent.Target.AsSpan().SequenceEqual(intent.ProofCredential);
                var ok = remove ? await RemoveCredential(db, tx, current, intent, isCurrent, recovery, ct) :
                    await ApplyRename(db, tx, current.Id, intent, ct);
                // Preserve a valid assertion's counter even if a concurrent change makes its target stale.
                return (ok, isCurrent);
            }, ct, checkState: intent =>
            {
                if ((intent.Name is null) != remove || !CryptographicOperations.FixedTimeEquals(intent.ProofCredential, request.RawId))
                    throw Denied();
            });
        if (!changed) throw ChangeConflict(remove);
        return removingCurrent;
    }

    private async Task<TResult> CompleteAssertion<TState, TResult>(string? session, string? expected, bool requireCurrent,
        PasskeyLoginRequest request, Func<NpgsqlConnection, NpgsqlTransaction, MfaStore.Subject, Task<TState>> consume,
        Func<NpgsqlConnection, NpgsqlTransaction, MfaStore.Subject, TState, Task<TResult>> verify, CancellationToken ct,
        bool checkIdFirst = true, Func<BusinessException>? mismatch = null, Action<TState>? checkState = null)
    {
        if (request.RememberMe) throw Denied();
        if (checkIdFirst) CheckId(request.CredentialId, request.RawId);
        await using var db = await source.OpenConnectionAsync(ct);
        Task<MfaStore.Subject> ReadActor(NpgsqlTransaction tx) =>
            requireCurrent ? RequireCurrentPasskeySession(db, tx, session, expected, ct) : MfaStore.RequireSession(db, tx, session, ct);
        var (admitted, state) = await Run(db, async tx =>
        {
            var actor = await ReadActor(tx);
            return (actor, await consume(db, tx, actor));
        }, ct);
        if (!checkIdFirst) CheckId(request.CredentialId, request.RawId);
        checkState?.Invoke(state);
        return await Run(db, async tx =>
        {
            var current = await ReadActor(tx);
            if (!SameSession(current, admitted)) throw (mismatch ?? Denied)();
            return await verify(db, tx, current, state);
        }, ct);
    }

    private async Task<(AssertionOptions Options, List<byte[]> Credentials)> RestrictedAssertion(
        NpgsqlConnection db, NpgsqlTransaction tx, Guid user, CancellationToken ct)
    {
        var ids = await QueryList(db, tx, ct, """
            select credential_id from public.passkey_credential where user_id=$1 order by credential_id limit 17
            """, r => r.GetFieldValue<byte[]>(0), user);
        if (ids.Count is 0 or > 16) throw Denied();
        return (_verifier.RequestAssertion(ids), ids);
    }

    private async Task<byte[]> RegisterCredential(NpgsqlConnection db, NpgsqlTransaction tx, Guid user, PasskeyProvisionRequest request,
        CredentialCreateOptions options, CancellationToken ct)
    {
        RegisteredPublicKeyCredential credential;
        try
        {
            credential = await PasskeyVerification.Attest(_verifier, request, options, async (candidate, token) =>
                (bool)(await Scalar(db, tx, token,
                    "select not exists(select 1 from public.passkey_credential where credential_id=$1)", candidate.CredentialId))!, ct);
        }
        catch (Fido2VerificationException) { throw Denied(); }
        if (!CryptographicOperations.FixedTimeEquals(credential.Id, request.RawId)) throw Denied();

        try
        {
            await Execute(db, tx, ct, """
                insert into public.passkey_credential(credential_id,user_id,public_key,sign_count,backup_eligible,backed_up)
                values ($1,$2,$3,$4,$5,$6)
                """, credential.Id, user, credential.PublicKey, (long)credential.SignCount, credential.IsBackupEligible, credential.IsBackedUp);
        }
        catch (PostgresException error) when (error.SqlState == PostgresErrorCodes.UniqueViolation) { throw Denied(); }
        return credential.Id;
    }

    private async Task<int> VerifyAssertion(NpgsqlConnection db, NpgsqlTransaction tx, PasskeyLoginRequest request,
        Guid userId, AssertionOptions options, bool requireHandle, CancellationToken ct)
    {
        var (number, handle, key, counter, backupEligible) = await QueryRequired(db, tx, ct, """
            select s.account_id,s.user_handle,c.public_key,c.sign_count,c.backup_eligible from public.passkey_credential c
            join public.passkey_subject s on s.user_id=c.user_id
            where c.credential_id=$1 and c.user_id=$2 for update of c
            """, r => (r.GetInt32(0), r.GetFieldValue<byte[]>(1), r.GetFieldValue<byte[]>(2), checked((uint)r.GetInt64(3)), r.GetBoolean(4)),
            Denied, request.RawId, userId);
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
        await Execute(db, tx, ct, """
            update public.passkey_credential set sign_count=$2,backed_up=$3,last_used_at=clock_timestamp()
            where credential_id=$1
            """, request.RawId, (long)verification.SignCount, verification.IsBackedUp);
        return number;
    }

    internal static bool AcceptsSignatureCounter(uint stored, uint verified) =>
        (stored == 0 && verified == 0) || verified > stored;

    private static async Task<bool> HasCredential(NpgsqlConnection db, NpgsqlTransaction tx, Guid id, CancellationToken ct) =>
        (bool)(await Scalar(db, tx, ct, "select exists(select 1 from public.passkey_credential where user_id=$1)", id))!;

    private static async Task SaveChallenge(NpgsqlConnection db, NpgsqlTransaction tx, string token,
        string options, Guid? userId, long? generation, byte[]? binding, CancellationToken ct, int lifetimeSeconds = 300)
    {
        await Execute(db, tx, ct, "select pg_advisory_xact_lock($1)", ChallengeBudgetLock);
        await Execute(db, tx, ct, "delete from public.passkey_challenge where expires_at<=clock_timestamp()");
        if (await Execute(db, tx, ct, """
            insert into public.passkey_challenge(digest,user_id,generation,options,expires_at,binding_digest)
            select $1,$2,$3,$4,clock_timestamp()+$7 * interval '1 second',$5
            where (select count(*) from public.passkey_challenge)<$6
            """, TokenDigest(token), Optional(NpgsqlDbType.Uuid, userId),
            Optional(NpgsqlDbType.Bigint, generation), options, Optional(NpgsqlDbType.Bytea, binding), ChallengeCapacity, lifetimeSeconds) != 1)
            throw new PublicUnavailableException();
    }

    private static async Task<string> ConsumeOwnedChallenge(NpgsqlConnection db, NpgsqlTransaction tx, MfaStore.Subject actor,
        string token, byte[] binding, CancellationToken ct)
    {
        var challenge = await ConsumeChallenge(db, tx, token, binding, ct);
        return challenge.UserId == actor.Id && challenge.Generation == actor.Generation ? challenge.Options : throw Denied();
    }

    private static Task<(string Options, Guid? UserId, long? Generation, DateTimeOffset ExpiresAt)> ConsumeChallenge(NpgsqlConnection db,
        NpgsqlTransaction tx, string token, byte[]? binding, CancellationToken ct) =>
        QueryRequired(db, tx, ct, """
            delete from public.passkey_challenge
            where digest=$1 and expires_at>clock_timestamp() and binding_digest is not distinct from $2
            returning options,user_id,generation,expires_at
            """, r => (r.GetString(0), r.IsDBNull(1) ? (Guid?)null : r.GetGuid(1), r.IsDBNull(2) ? (long?)null : r.GetInt64(2),
            r.GetFieldValue<DateTimeOffset>(3)), Denied, TokenDigest(token), Optional(NpgsqlDbType.Bytea, binding));

    private static async Task<string> SaveRecoveryFlow(NpgsqlConnection db, NpgsqlTransaction tx, MfaStore.Subject actor,
        short purpose, short kind, string? options, int seconds, CancellationToken ct)
    {
        var token = NewToken();
        await Execute(db, tx, ct, """
            insert into public.site_recovery_flow(digest,user_id,generation,session_digest,purpose,kind,options,expires_at)
            values($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+$8 * interval '1 second')
            on conflict(user_id,purpose,kind) do update set digest=excluded.digest,generation=excluded.generation,
                session_digest=excluded.session_digest,options=excluded.options,expires_at=excluded.expires_at
            """, TokenDigest(token), actor.Id, actor.Generation, actor.Scope, purpose, kind,
            Optional(NpgsqlDbType.Text, options), seconds);
        return token;
    }

    private static Task<RecoveryAccount> LockRecoveryAccount(NpgsqlConnection db, NpgsqlTransaction tx, byte[] digest,
        CancellationToken ct) =>
        QueryRequired(db, tx, ct, """
            select u.id,u.generation,p.user_handle from public.blog_user u
            join public.passkey_subject p on p.user_id=u.id where u.enabled and u.id=(
                select user_id from public.site_recovery_rebind where ticket_digest=$1 and expires_at>clock_timestamp()
            ) for update of u
            """, r => new RecoveryAccount(r.GetGuid(0), r.GetInt64(1), r.GetFieldValue<byte[]>(2)), Denied, digest);

    private static async Task<long> CurrentRecoveryVersion(NpgsqlConnection db, NpgsqlTransaction tx, MfaStore.Subject actor,
        byte[] proof, CancellationToken ct)
    {
        if (!await CurrentSchema.HasSiteRecoveryKeySchemaAsync(db, tx, ct)) throw Denied();
        return await Scalar(db, tx, ct, """
            select k.version from public.site_recovery_rebind r join public.site_recovery_key k using (user_id)
            where r.user_id=$1 and r.generation=$2 and r.ticket_digest=$3 and r.completed_at is null
            and r.expires_at>clock_timestamp() and k.used_at is null
            and (k.failed_count<8 or k.failure_until<=clock_timestamp()) for update of r,k
            """, actor.Id, actor.Generation, proof) is long version ? version : throw Denied();
    }

    private static async Task EnterPasskeyRecovery(NpgsqlConnection db, NpgsqlTransaction tx, Guid owner, CancellationToken ct)
    {
        foreach (var table in new[] { "login_ticket", "passkey_challenge", "mfa_flow", "site_recovery_flow" })
            await Execute(db, tx, ct, $"delete from public.{table} where user_id=$1", owner);
        await RecoveryWrite(db, tx, ct, "update public.blog_user set generation=generation+1 where id=$1", owner);
    }

    private static async Task RecoveryWrite(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct,
        string sql, params object[] parameters)
    {
        if (await Execute(db, tx, ct, sql, parameters) != 1) throw Denied();
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
        if (await Scalar(db, tx, ct, """
            select exists (select 1 from public.passkey_challenge where user_id=$1 and generation=$2 and binding_digest=$3
                and expires_at>clock_timestamp())
            """, actor.Id, actor.Generation, EnrollmentCreationBinding(actor.Id)) is true)
            throw new BusinessException(Rejection.Conflict, "A Passkey enrollment is already in progress. Try again after it expires.");
    }

    private static async Task<EnrollmentState> ReadEnrollmentState(NpgsqlConnection db, NpgsqlTransaction tx, MfaStore.Subject actor,
        CancellationToken ct)
    {
        byte[]? handle = null, current = null;
        var ids = new List<byte[]>();
        await ReadAll(db, tx, ct, """
            select s.user_handle,u.passkey_credential_id,c.credential_id
            from public.passkey_subject s join public.user_session u on u.user_id=s.user_id
            join public.passkey_credential c on c.user_id=s.user_id
            where s.user_id=$1 and u.digest=$2 and u.passkey_credential_id is not null
            order by c.credential_id limit $3
            """, r =>
        {
            handle ??= r.GetFieldValue<byte[]>(0);
            current ??= r.GetFieldValue<byte[]>(1);
            ids.Add(r.GetFieldValue<byte[]>(2));
        }, actor.Id, actor.Scope, WireLimits.SitePasskeyListSize);
        if (handle is null) throw Denied();
        if (ids.Count >= WireLimits.SitePasskeyListSize)
            throw new BusinessException(Rejection.Conflict, "This account has reached its Passkey limit.");
        return new(handle, current!, ids);
    }

    private static async Task<bool> ApplyRename(NpgsqlConnection db, NpgsqlTransaction tx, Guid user, CredentialIntent intent, CancellationToken ct) =>
        await Execute(db, tx, ct, intent.ExpectedRevision == 0 ? """
            insert into public.site_passkey_name(credential_id,user_id,revision,name)
            select credential_id,user_id,1,$3 from public.passkey_credential where credential_id=$1 and user_id=$2
            on conflict (credential_id) do nothing
            """ : """
            update public.site_passkey_name set name=$3,revision=revision+1
            where credential_id=$1 and user_id=$2 and revision=$4 and revision<9223372036854775807
            """, intent.ExpectedRevision == 0 ? [intent.Target, user, intent.Name!] : [intent.Target, user, intent.Name!, intent.ExpectedRevision]) == 1;

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
        await Execute(db, tx, ct, "delete from public.user_session where user_id=$1 and ($3 or passkey_credential_id=$2)", actor.Id, credential, final);
        // The pending login scope is the 32-byte cookie digest followed by the credential ID.
        await Execute(db, tx, ct, "delete from public.mfa_flow where user_id=$1 and kind=$2 and substring(scope from 33)=$3",
            actor.Id, (int)MfaStore.Purpose.Login, credential);
        if (await Execute(db, tx, ct, "delete from public.passkey_credential where user_id=$1 and credential_id=$2",
            actor.Id, credential) != 1) throw ChangeConflict(remove: true);
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

    private static byte[] EnrollmentApprovalBinding(byte[] session) => SHA256.HashData([.. "FsusBlog v2 passkey enrollment approval v1"u8, .. session]);
    private static byte[] EnrollmentCreationBinding(Guid owner) => SHA256.HashData([.. "FsusBlog v2 passkey enrollment creation v1"u8, .. owner.ToByteArray()]);

    private static byte[] ChangeBinding(byte[] digest, bool remove, byte[]? recovery) => recovery is not null
        ? SHA256.HashData([.. "FsusBlog v2 remove current passkey with recovery v1"u8, .. digest, .. recovery])
        : SHA256.HashData([.. (remove ? "FsusBlog v2 site passkey remove v1"u8 : "FsusBlog v2 site passkey rename v1"u8), .. digest]);

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

    private static bool SameSession(MfaStore.Subject left, MfaStore.Subject right) =>
        left.Id == right.Id && left.Generation == right.Generation && CryptographicOperations.FixedTimeEquals(left.Scope, right.Scope);

    internal static bool IsBase64Url43(string? token) =>
        token is { Length: 43 } && token.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_');
    private static byte[]? RecoveryTokenDigest(string? token) => IsBase64Url43(token) ? TokenDigest(token!) : null;
    private static string NewToken() => WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
    private static byte[] TokenDigest(string token) => SHA256.HashData(Encoding.ASCII.GetBytes(token));

    private static void CheckId(string text, byte[] raw)
    {
        if (!string.Equals(WebEncoders.Base64UrlEncode(raw), text, StringComparison.Ordinal)) throw Denied();
    }

    private static BusinessException ChangeConflict(bool remove) => new(Rejection.Conflict, remove
        ? "This Passkey cannot be removed. Reload the list to check the remaining Passkeys."
        : "The Passkey name changed. Reload the Passkey list.");

    private static BusinessException Denied() => new(Rejection.Unauthorized, "Passkey verification failed. Start a new ceremony.");
}

internal sealed class RecoveryKeyProofRequiredException : Exception;
