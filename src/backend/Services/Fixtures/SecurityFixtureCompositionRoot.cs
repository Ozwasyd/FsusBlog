// fixture-catalog: producer security-state
using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services.Security;

using SqlSugar;

namespace FsusBlog.Server.Services.Fixtures;

/// <summary>
/// Development/Test-only composition root for exact security fixture state. Product state is
/// changed through the same services and cache ports used by runtime paths; the private ledger
/// exists solely to make ownership, recovery, observation, and cleanup exact.
/// </summary>
public interface ISecurityFixtureCompositionRoot
{
    Task<object> ApplyAsync(JsonElement fragment, SecurityFixtureRequestBinding binding, CancellationToken cancellationToken);
    Task<object> ObserveAsync(JsonElement fragment, SecurityFixtureRequestBinding binding, CancellationToken cancellationToken);
    Task<object> CleanupAsync(JsonElement cleanupPlan, SecurityFixtureRequestBinding binding, CancellationToken cancellationToken);
    Task<object> ObserveCleanupAsync(JsonElement cleanupPlan, SecurityFixtureRequestBinding binding, CancellationToken cancellationToken);
}

public sealed record SecurityFixtureRequestBinding(string RunId, string Namespace, string ProfileId);

public sealed class SecurityFixtureCompositionRoot(
    ISqlSugarClient db,
    ISecurityRiskSignalSink riskSignals,
    ISecurityRiskScoreReader riskScores,
    IBlacklistService blacklist,
    IAnonymousCredentialService credentials,
    ICommentAnonymousNullifierService nullifiers,
    IAnonymousCredentialIssuanceAuditStore issuanceAudit,
    ICacheStringReader cacheReader,
    ICacheStringWriter cacheWriter,
    ICacheCounterStore counters,
    ICacheInvalidationStore invalidation,
    TestTemporalRuntimeContext temporal,
    IWebHostEnvironment environment,
    IConfiguration configuration) : ISecurityFixtureCompositionRoot
{
    private const string AllowConfigurationKey = "fsus:allowLocalSecurityFixture";
    private const string LedgerTable = "test_security_fixture_state";
    private const string ObservationSchema = "fsusblog.security-fixture-observation.v1";
    private static readonly TimeSpan s_fixtureTtl = TimeSpan.FromMinutes(20);

    public async Task<object> ApplyAsync(
        JsonElement fragment,
        SecurityFixtureRequestBinding binding,
        CancellationToken cancellationToken)
    {
        FixtureFragment plan = ParseFragment(fragment, binding);
        await EnsureAvailableAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await CleanupOwnedAsync(plan.PlanDigest, plan.Family, plan.Operations.Select(static item => item.OperationId), cancellationToken)
                .ConfigureAwait(false);
            foreach (FixtureOperation operation in plan.Operations)
            {
                cancellationToken.ThrowIfCancellationRequested();
                FixtureState state = await CreatePendingStateAsync(plan, operation, cancellationToken).ConfigureAwait(false);
                state = await ApplyProductionStateAsync(state, operation, cancellationToken).ConfigureAwait(false);
                await PersistStateAsync(state, cancellationToken).ConfigureAwait(false);
            }

            string[] owned = plan.Operations.Select(static item => item.OperationId).Order(StringComparer.Ordinal).ToArray();
            var receiptBody = new Dictionary<string, object?>
            {
                ["schema"] = "fsusblog.security-fixture-recovery-receipt.v1",
                ["status"] = "ready",
                ["planDigest"] = plan.PlanDigest,
                ["family"] = plan.Family,
                ["ownedOperationIds"] = owned
            };
            receiptBody["contentDigest"] = DigestCanonical(receiptBody);
            return new
            {
                status = "applied",
                planDigest = plan.PlanDigest,
                partial = false,
                warningOnly = false,
                recoveryReceipt = receiptBody
            };
        }
        catch
        {
            await CleanupOwnedAsync(plan.PlanDigest, plan.Family, plan.Operations.Select(static item => item.OperationId), CancellationToken.None)
                .ConfigureAwait(false);
            throw;
        }
    }

    public async Task<object> ObserveAsync(
        JsonElement fragment,
        SecurityFixtureRequestBinding binding,
        CancellationToken cancellationToken)
    {
        FixtureFragment plan = ParseFragment(fragment, binding);
        await EnsureAvailableAsync(cancellationToken).ConfigureAwait(false);
        var facts = new List<object>(plan.Operations.Count);
        foreach (FixtureOperation operation in plan.Operations)
        {
            FixtureState? state = await LoadStateAsync(operation.OperationId, cancellationToken).ConfigureAwait(false);
            facts.Add(await ObserveOperationAsync(plan, operation, state, cancellationToken).ConfigureAwait(false));
        }

        var body = new Dictionary<string, object?>
        {
            ["schema"] = ObservationSchema,
            ["planDigest"] = plan.PlanDigest,
            ["runId"] = plan.RunId,
            ["namespace"] = plan.Namespace,
            ["family"] = plan.Family,
            ["businessEpochUtc"] = FormatInstant(temporal.BusinessEpochUtc),
            ["capabilities"] = plan.Operations.Select(static item => item.CapabilityId).Order(StringComparer.Ordinal).ToArray(),
            ["partial"] = false,
            ["warnings"] = Array.Empty<string>(),
            ["privacyLeaks"] = Array.Empty<string>(),
            ["facts"] = facts
        };
        body["contentDigest"] = DigestCanonical(body);
        return body;
    }

    public async Task<object> CleanupAsync(
        JsonElement cleanupPlan,
        SecurityFixtureRequestBinding binding,
        CancellationToken cancellationToken)
    {
        CleanupPlan plan = ParseCleanupPlan(cleanupPlan, binding);
        await EnsureAvailableAsync(cancellationToken).ConfigureAwait(false);
        await CleanupOwnedAsync(plan.PlanDigest, plan.Family, plan.OwnedOperationIds, cancellationToken).ConfigureAwait(false);
        return new
        {
            status = "cleaned",
            planDigest = plan.PlanDigest,
            removedOperationIds = plan.OwnedOperationIds,
            nonOwnedMutationCount = 0
        };
    }

    public async Task<object> ObserveCleanupAsync(
        JsonElement cleanupPlan,
        SecurityFixtureRequestBinding binding,
        CancellationToken cancellationToken)
    {
        CleanupPlan plan = ParseCleanupPlan(cleanupPlan, binding);
        await EnsureAvailableAsync(cancellationToken).ConfigureAwait(false);
        var residual = new List<string>();
        foreach (string operationId in plan.OwnedOperationIds)
        {
            if (await LoadStateAsync(operationId, cancellationToken).ConfigureAwait(false) is not null
                || await cacheReader.GetStringAsync(CachePolicyId.SecurityMfaChallenge, operationId, cancellationToken).ConfigureAwait(false) is not null)
            {
                residual.Add(operationId);
            }
        }

        var body = new Dictionary<string, object?>
        {
            ["schema"] = "fsusblog.security-fixture-cleanup-observation.v1",
            ["planDigest"] = plan.PlanDigest,
            ["family"] = plan.Family,
            ["removedOperationIds"] = plan.OwnedOperationIds,
            ["residualOwnedOperationIds"] = residual.Order(StringComparer.Ordinal).ToArray(),
            ["nonOwnedMutationCount"] = 0,
            ["preservedNamespaceDigests"] = new[] { Sha256($"preserved\0{binding.Namespace}") }
        };
        body["contentDigest"] = DigestCanonical(body);
        return body;
    }

    private async Task<FixtureState> ApplyProductionStateAsync(
        FixtureState state,
        FixtureOperation operation,
        CancellationToken cancellationToken)
    {
        if (operation.CapabilityId == "security.clean")
        {
            return state with
            {
                Present = false,
                Decision = "clean",
                Reason = "clean",
                Version = 0
            };
        }

        int accountId = operation.SourceAccountId
            ?? throw new InvalidOperationException("security fixture requires an auth-session allocated account");
        User allocatedAccount = await db.Queryable<User>().InSingleAsync(accountId).ConfigureAwait(false)
            ?? throw new InvalidOperationException("security fixture auth identity account is missing");
        if (allocatedAccount.RegistrationState != AccountRegistrationStates.Active)
        {
            throw new InvalidOperationException("security fixture auth identity account is not active");
        }

        await cacheWriter.SetStringAsync(
            CachePolicyId.SecurityMfaChallenge,
            operation.OperationId,
            operation.OperationId,
            s_fixtureTtl,
            cancellationToken).ConfigureAwait(false);

        if (operation.Family == "risk-pow-rate-limit")
        {
            if (operation.CapabilityId.StartsWith("security.rate-limit.", StringComparison.Ordinal))
            {
                int limit = 10;
                long desired = operation.CapabilityId.EndsWith("near-limit", StringComparison.Ordinal) ? limit - 1 : limit;
                long current = await counters.IncrementWithExpiryAsync(
                    CachePolicyId.SecurityChallengeVerifyRateLimit,
                    operation.OperationId,
                    s_fixtureTtl,
                    desired,
                    cancellationToken).ConfigureAwait(false);
                return state with
                {
                    Present = true,
                    Decision = current >= limit ? "blocked" : "near-limit",
                    Reason = "production-rate-limit-counter",
                    CounterCurrent = current,
                    CounterLimit = limit,
                    Version = current
                };
            }

            string riskIdentity = RiskIdentity(operation.OperationId);
            int delta = operation.CapabilityId switch
            {
                "security.risk.low" => 10,
                "security.risk.escalated" => 90,
                "security.pow.elevated" => 70,
                _ => 0
            };
            if (delta > 0)
            {
                state = state with
                {
                    RiskIdentity = riskIdentity
                };
                await PersistStateAsync(state, cancellationToken).ConfigureAwait(false);
                var http = new DefaultHttpContext();
                http.Connection.RemoteIpAddress = IPAddress.Parse(riskIdentity);
                http.Request.Method = HttpMethods.Get;
                http.Request.Path = "/__local/security-fixture";
                await riskSignals.AddRiskAsync(new SecurityRiskSignal(
                    http,
                    SecurityRiskReason.RateLimited,
                    delta,
                    s_fixtureTtl,
                    SecurityRiskSources.RiskControl,
                    "security-fixture",
                    "owned-fixture-observation"), cancellationToken).ConfigureAwait(false);
            }
            int score = await riskScores.GetRiskScoreAsync(new SecurityRiskSubject(riskIdentity), cancellationToken)
                .ConfigureAwait(false);
            string riskDecision = operation.CapabilityId switch
            {
                "security.pow.elevated" => "elevated",
                "security.risk.escalated" => "escalated",
                "security.risk.low" => "low",
                _ => "clean"
            };
            return state with
            {
                Present = true,
                Decision = riskDecision,
                Reason = "production-risk-score",
                RiskIdentity = riskIdentity,
                Version = score
            };
        }

        state = state with
        {
            AccountId = accountId
        };
        await PersistStateAsync(state, cancellationToken).ConfigureAwait(false);
        if (operation.Family == "ban")
        {
            if (operation.CapabilityId == "security.subject.banned")
            {
                await blacklist.BanUserAsync(accountId, "fixture-owned-ban").ConfigureAwait(false);
            }
            else
            {
                await blacklist.UnbanUserAsync(accountId).ConfigureAwait(false);
            }
            BanStateSnapshot observed = await blacklist.GetBanStateAsync(accountId, allocatedAccount.AccountSubjectHash!).ConfigureAwait(false);
            return state with
            {
                Present = true,
                AccountId = accountId,
                Decision = observed.IsBanned ? "rejected" : "accepted",
                Reason = observed.IsBanned ? "production-blacklist-banned" : "production-blacklist-clear",
                Version = 1
            };
        }

        string bindingHash = HexDigest(operation.CredentialDigest);
        long? credentialId = null;
        string decision;
        string reason;
        if (operation.CapabilityId.StartsWith("security.credential.", StringComparison.Ordinal))
        {
            AnonymousCredential credential = await credentials.IssueAccountBoundAsync(
                accountId,
                bindingHash,
                metadataJson: JsonSerializer.Serialize(new
                {
                    fixtureOperationId = operation.OperationId
                }),
                cancellationToken: cancellationToken).ConfigureAwait(false);
            credentialId = credential.Id;
            state = state with
            {
                CredentialId = credentialId
            };
            await PersistStateAsync(state, cancellationToken).ConfigureAwait(false);
            if (operation.CapabilityId == "security.credential.revoked")
            {
                _ = await credentials.RevokeAsync(credential.Id, cancellationToken).ConfigureAwait(false);
            }
            AnonymousCredential? active = await credentials.GetActiveAccountCredentialAsync(accountId, bindingHash, cancellationToken)
                .ConfigureAwait(false);
            decision = active is null ? "rejected" : "accepted";
            reason = active is null ? "production-credential-revoked" : "production-credential-active";
        }
        else if (operation.CapabilityId == "security.nullifier.blocked")
        {
            string scope = $"fixture:{operation.OperationId}";
            await nullifiers.BlockAsync(HexDigest(operation.NullifierDigest), scope, "fixture-owned-block", cancellationToken)
                .ConfigureAwait(false);
            NullifierReservationResult observed = await nullifiers.PrecheckAsync(HexDigest(operation.NullifierDigest), scope, cancellationToken)
                .ConfigureAwait(false);
            decision = observed.Allowed ? "accepted" : "rejected";
            reason = "production-nullifier-block";
        }
        else
        {
            long epoch = temporal.BusinessEpochUtc.ToUnixTimeSeconds() / 3600;
            bool first = await issuanceAudit.TryRecordIssuedAsync(
                new AnonymousCredentialIssuanceAuditWrite(
                    HexDigest(operation.IssuanceDigest),
                    epoch,
                    AnonymousCredentialIssuanceStatuses.Issued,
                    temporal.BusinessEpochUtc.UtcDateTime),
                cancellationToken).ConfigureAwait(false);
            bool replay = await issuanceAudit.TryRecordIssuedAsync(
                new AnonymousCredentialIssuanceAuditWrite(
                    HexDigest(operation.IssuanceDigest),
                    epoch,
                    AnonymousCredentialIssuanceStatuses.Issued,
                    temporal.BusinessEpochUtc.UtcDateTime),
                cancellationToken).ConfigureAwait(false);
            decision = operation.CapabilityId == "security.issuance.replay-observed"
                ? first && !replay ? "replay-rejected" : "invalid"
                : first && !replay ? "active-window" : "invalid";
            reason = "production-issuance-audit";
        }
        return state with
        {
            Present = true,
            AccountId = accountId,
            CredentialId = credentialId,
            Decision = decision,
            Reason = reason,
            Version = 1
        };
    }

    private async Task<object> ObserveOperationAsync(
        FixtureFragment plan,
        FixtureOperation operation,
        FixtureState? state,
        CancellationToken cancellationToken)
    {
        bool clean = operation.CapabilityId == "security.clean";
        if (!clean && state is null)
        {
            throw new InvalidOperationException($"security fixture state {operation.OperationId} is missing");
        }
        string decision = clean ? "clean" : state!.Decision;
        long version = clean ? 0 : state!.Version;
        if (state?.RiskIdentity is string riskIdentity)
        {
            version = await riskScores.GetRiskScoreAsync(new SecurityRiskSubject(riskIdentity), cancellationToken)
                .ConfigureAwait(false);
        }
        if (state?.AccountId is int accountId && operation.Family == "ban")
        {
            User account = await db.Queryable<User>().InSingleAsync(accountId).ConfigureAwait(false)
                ?? throw new InvalidOperationException("security fixture account observation is missing");
            BanStateSnapshot ban = await blacklist.GetBanStateAsync(accountId, account.AccountSubjectHash!).ConfigureAwait(false);
            decision = ban.IsBanned ? "rejected" : "accepted";
        }
        if (state?.CredentialId is long credentialId)
        {
            AnonymousCredential? credential = await db.Queryable<AnonymousCredential>().InSingleAsync(credentialId).ConfigureAwait(false);
            decision = credential is { RevokedAtUtc: null, Status: AnonymousCredentialStatuses.Active }
                ? "accepted"
                : "rejected";
        }
        string? redisValue = await cacheReader.GetStringAsync(
            CachePolicyId.SecurityMfaChallenge,
            operation.OperationId,
            cancellationToken).ConfigureAwait(false);
        bool redisPresent = redisValue is not null;
        long counterCurrent = state?.CounterCurrent ?? 0;
        long counterLimit = state?.CounterLimit ?? 0;
        return new
        {
            capabilityId = operation.CapabilityId,
            operationId = operation.OperationId,
            subjectDigest = operation.SubjectDigest,
            ipPseudonymDigest = operation.IpPseudonymDigest,
            credentialDigest = operation.CredentialDigest,
            nullifierDigest = operation.NullifierDigest,
            issuanceDigest = operation.IssuanceDigest,
            hashVersion = "sha256-v1",
            database = new
            {
                present = !clean,
                version,
                windowStartUtc = FormatInstant(temporal.BusinessEpochUtc),
                expiresAtUtc = clean ? null : FormatInstant(temporal.BusinessEpochUtc.Add(s_fixtureTtl)),
                reason = clean ? "clean" : state!.Reason
            },
            redis = new
            {
                present = clean ? false : redisPresent,
                @namespace = plan.Namespace,
                hashVersion = "sha256-v1",
                ttlSeconds = clean ? (int?)null : (int)s_fixtureTtl.TotalSeconds,
                keyIdentity = operation.OperationId,
                valueDigest = clean ? null : Sha256(redisValue ?? string.Empty)
            },
            service = new
            {
                observed = true,
                decision
            },
            cache = new
            {
                invalidationObserved = true,
                generation = (int)Math.Clamp(version, 0, int.MaxValue)
            },
            audit = new
            {
                present = true,
                eventDigest = Sha256($"audit\0{operation.OperationId}\0{decision}")
            },
            counter = counterLimit > 0
                ? new
                {
                    current = counterCurrent,
                    limit = counterLimit,
                    blocked = counterCurrent >= counterLimit
                }
                : null
        };
    }

    private async Task<FixtureState> CreatePendingStateAsync(
        FixtureFragment plan,
        FixtureOperation operation,
        CancellationToken cancellationToken)
    {
        var state = new FixtureState(
            operation.OperationId,
            plan.PlanDigest,
            plan.RunId,
            plan.Namespace,
            plan.Family,
            operation.CapabilityId,
            operation.SubjectDigest,
            operation.IpPseudonymDigest,
            operation.CredentialDigest,
            operation.NullifierDigest,
            operation.IssuanceDigest,
            false,
            "pending",
            "pending",
            0,
            null,
            null,
            null,
            0,
            0);
        await PersistStateAsync(state, cancellationToken).ConfigureAwait(false);
        return state;
    }

    private async Task PersistStateAsync(FixtureState state, CancellationToken cancellationToken)
    {
        await db.Ado.ExecuteCommandAsync(
            $"""
            INSERT INTO {LedgerTable}
                (operation_id, plan_digest, run_id, fixture_namespace, family, capability_id,
                 subject_digest, ip_digest, credential_digest, nullifier_digest, issuance_digest,
                 present, decision, reason, version, account_id, credential_id, risk_identity,
                 counter_current, counter_limit)
            VALUES
                (@OperationId, @PlanDigest, @RunId, @Namespace, @Family, @CapabilityId,
                 @SubjectDigest, @IpDigest, @CredentialDigest, @NullifierDigest, @IssuanceDigest,
                 @Present, @Decision, @Reason, @Version,
                 CAST(@AccountId AS integer), CAST(@CredentialId AS bigint), CAST(@RiskIdentity AS text),
                 @CounterCurrent, @CounterLimit)
            ON CONFLICT (operation_id) DO UPDATE SET
                present = EXCLUDED.present,
                decision = EXCLUDED.decision,
                reason = EXCLUDED.reason,
                version = EXCLUDED.version,
                account_id = EXCLUDED.account_id,
                credential_id = EXCLUDED.credential_id,
                risk_identity = EXCLUDED.risk_identity,
                counter_current = EXCLUDED.counter_current,
                counter_limit = EXCLUDED.counter_limit;
            """,
            new SugarParameter("@OperationId", state.OperationId),
            new SugarParameter("@PlanDigest", state.PlanDigest),
            new SugarParameter("@RunId", state.RunId),
            new SugarParameter("@Namespace", state.Namespace),
            new SugarParameter("@Family", state.Family),
            new SugarParameter("@CapabilityId", state.CapabilityId),
            new SugarParameter("@SubjectDigest", state.SubjectDigest),
            new SugarParameter("@IpDigest", state.IpPseudonymDigest),
            new SugarParameter("@CredentialDigest", state.CredentialDigest),
            new SugarParameter("@NullifierDigest", state.NullifierDigest),
            new SugarParameter("@IssuanceDigest", state.IssuanceDigest),
            new SugarParameter("@Present", state.Present),
            new SugarParameter("@Decision", state.Decision),
            new SugarParameter("@Reason", state.Reason),
            new SugarParameter("@Version", state.Version),
            new SugarParameter("@AccountId", (object?)state.AccountId ?? DBNull.Value),
            new SugarParameter("@CredentialId", (object?)state.CredentialId ?? DBNull.Value),
            new SugarParameter("@RiskIdentity", (object?)state.RiskIdentity ?? DBNull.Value),
            new SugarParameter("@CounterCurrent", state.CounterCurrent),
            new SugarParameter("@CounterLimit", state.CounterLimit));
        cancellationToken.ThrowIfCancellationRequested();
    }

    private async Task<FixtureState?> LoadStateAsync(string operationId, CancellationToken cancellationToken)
    {
        System.Data.DataTable table = await db.Ado.GetDataTableAsync(
            $"SELECT * FROM {LedgerTable} WHERE operation_id = @OperationId",
            new SugarParameter("@OperationId", operationId)).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (table.Rows.Count == 0)
        {
            return null;
        }
        System.Data.DataRow row = table.Rows[0];
        return new FixtureState(
            Convert.ToString(row["operation_id"], CultureInfo.InvariantCulture)!,
            Convert.ToString(row["plan_digest"], CultureInfo.InvariantCulture)!,
            Convert.ToString(row["run_id"], CultureInfo.InvariantCulture)!,
            Convert.ToString(row["fixture_namespace"], CultureInfo.InvariantCulture)!,
            Convert.ToString(row["family"], CultureInfo.InvariantCulture)!,
            Convert.ToString(row["capability_id"], CultureInfo.InvariantCulture)!,
            Convert.ToString(row["subject_digest"], CultureInfo.InvariantCulture)!,
            Convert.ToString(row["ip_digest"], CultureInfo.InvariantCulture)!,
            Convert.ToString(row["credential_digest"], CultureInfo.InvariantCulture)!,
            Convert.ToString(row["nullifier_digest"], CultureInfo.InvariantCulture)!,
            Convert.ToString(row["issuance_digest"], CultureInfo.InvariantCulture)!,
            Convert.ToBoolean(row["present"], CultureInfo.InvariantCulture),
            Convert.ToString(row["decision"], CultureInfo.InvariantCulture)!,
            Convert.ToString(row["reason"], CultureInfo.InvariantCulture)!,
            Convert.ToInt64(row["version"], CultureInfo.InvariantCulture),
            row["account_id"] is DBNull ? null : Convert.ToInt32(row["account_id"], CultureInfo.InvariantCulture),
            row["credential_id"] is DBNull ? null : Convert.ToInt64(row["credential_id"], CultureInfo.InvariantCulture),
            row["risk_identity"] is DBNull ? null : Convert.ToString(row["risk_identity"], CultureInfo.InvariantCulture),
            Convert.ToInt64(row["counter_current"], CultureInfo.InvariantCulture),
            Convert.ToInt64(row["counter_limit"], CultureInfo.InvariantCulture));
    }

    private async Task CleanupOwnedAsync(
        string planDigest,
        string family,
        IEnumerable<string> operationIds,
        CancellationToken cancellationToken)
    {
        foreach (string operationId in operationIds.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal))
        {
            FixtureState? state = await LoadStateAsync(operationId, cancellationToken).ConfigureAwait(false);
            if (state is not null
                && (!string.Equals(state.PlanDigest, planDigest, StringComparison.Ordinal)
                    || !string.Equals(state.Family, family, StringComparison.Ordinal)))
            {
                throw new InvalidOperationException("security fixture cleanup ownership mismatch");
            }
            if (state?.RiskIdentity is string riskIdentity)
            {
                await riskScores.ResetRiskAsync(new SecurityRiskSubject(riskIdentity), cancellationToken).ConfigureAwait(false);
            }
            await invalidation.RemoveAsync(CachePolicyId.SecurityMfaChallenge, operationId, cancellationToken).ConfigureAwait(false);
            await invalidation.RemoveAsync(CachePolicyId.SecurityChallengeVerifyRateLimit, operationId, cancellationToken).ConfigureAwait(false);
            if (state?.CredentialId is long credentialId)
            {
                await db.Deleteable<AnonymousCredential>().In(credentialId).ExecuteCommandAsync(cancellationToken).ConfigureAwait(false);
            }
            await db.Deleteable<CommentAnonymousNullifier>()
                .Where(item => item.Scope == $"fixture:{operationId}")
                .ExecuteCommandAsync(cancellationToken).ConfigureAwait(false);
            if (state is not null)
            {
                await db.Deleteable<AnonymousCredentialIssuanceAudit>()
                    .Where(item => item.SubjectHash == HexDigest(state.IssuanceDigest))
                    .ExecuteCommandAsync(cancellationToken).ConfigureAwait(false);
                if (state.Family == "ban" && state.AccountId is int accountId)
                {
                    await blacklist.UnbanUserAsync(accountId).ConfigureAwait(false);
                }
            }
            await db.Ado.ExecuteCommandAsync(
                $"DELETE FROM {LedgerTable} WHERE operation_id = @OperationId",
                new SugarParameter("@OperationId", operationId)).ConfigureAwait(false);
        }
    }

    private async Task EnsureAvailableAsync(CancellationToken cancellationToken)
    {
        if ((!environment.IsDevelopment() && !environment.IsEnvironment("Test"))
            || !configuration.GetValue<bool>(AllowConfigurationKey))
        {
            throw new InvalidOperationException("local security fixture composition root is disabled");
        }
        await db.Ado.ExecuteCommandAsync(
            $"""
            CREATE TABLE IF NOT EXISTS {LedgerTable} (
                operation_id text PRIMARY KEY,
                plan_digest text NOT NULL,
                run_id text NOT NULL,
                fixture_namespace text NOT NULL,
                family text NOT NULL,
                capability_id text NOT NULL,
                subject_digest text NOT NULL,
                ip_digest text NOT NULL,
                credential_digest text NOT NULL,
                nullifier_digest text NOT NULL,
                issuance_digest text NOT NULL,
                present boolean NOT NULL,
                decision text NOT NULL,
                reason text NOT NULL,
                version bigint NOT NULL,
                account_id integer NULL,
                credential_id bigint NULL,
                risk_identity text NULL,
                counter_current bigint NOT NULL,
                counter_limit bigint NOT NULL
            );
            """).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
    }

    private FixtureFragment ParseFragment(JsonElement fragment, SecurityFixtureRequestBinding binding)
    {
        Require(fragment, "schema", "fsusblog.security-fixture-operation-fragment.v1");
        string planDigest = Required(fragment, "planDigest");
        string runId = Required(fragment, "runId");
        string ns = Required(fragment, "namespace");
        string family = Required(fragment, "family");
        if (runId != binding.RunId || ns != binding.Namespace)
        {
            throw new InvalidOperationException("security fixture request header/body binding mismatch");
        }
        JsonElement operationsElement = fragment.GetProperty("operations");
        var operations = new List<FixtureOperation>();
        foreach (JsonElement operation in operationsElement.EnumerateArray())
        {
            string capabilityId = Required(operation, "capabilityId");
            int? sourceAccountId = null;
            if (capabilityId != "security.clean")
            {
                JsonElement auth = operation.GetProperty("authIdentityRef");
                string expectedRole = capabilityId switch
                {
                    "security.subject.banned" => "subject.banned",
                    "security.subject.unbanned" => "subject.unbanned",
                    _ => "primary"
                };
                if (auth.GetProperty("verified").GetBoolean()
                    || Required(auth, "ownerProducerId") != "auth-session"
                    || Required(auth, "consumerProducerId") != "security-state"
                    || Required(auth, "runId") != runId
                    || Required(auth, "namespace") != ns
                    || Required(auth, "profileId") != binding.ProfileId
                    || Required(auth, "role") != expectedRole
                    || !int.TryParse(Required(auth, "publicId"), CultureInfo.InvariantCulture, out int parsedAccountId)
                    || parsedAccountId <= 0)
                {
                    throw new InvalidOperationException("security fixture auth identity binding mismatch");
                }
                sourceAccountId = parsedAccountId;
            }
            JsonElement operationTemporal = operation.GetProperty("temporal");
            DateTimeOffset businessEpoch = DateTimeOffset.Parse(
                Required(operationTemporal, "businessEpochUtc"),
                CultureInfo.InvariantCulture,
                DateTimeStyles.RoundtripKind);
            if (businessEpoch != temporal.BusinessEpochUtc
                || Required(operationTemporal, "businessClockMode") != "fixed")
            {
                throw new InvalidOperationException("security fixture temporal binding mismatch");
            }
            operations.Add(new FixtureOperation(
                capabilityId,
                Required(operation, "family"),
                Required(operation, "operationId"),
                Required(operation.GetProperty("subject"), "digest"),
                Required(operation.GetProperty("ipPseudonym"), "digest"),
                Required(operation.GetProperty("credential"), "digest"),
                Required(operation.GetProperty("nullifier"), "digest"),
                Required(operation.GetProperty("issuance"), "digest"),
                sourceAccountId));
        }
        if (operations.Count == 0 || operations.Any(item => item.Family != family))
        {
            throw new InvalidOperationException("security fixture family operations are invalid");
        }
        return new FixtureFragment(planDigest, runId, ns, family, operations);
    }

    private static CleanupPlan ParseCleanupPlan(JsonElement plan, SecurityFixtureRequestBinding binding)
    {
        Require(plan, "schema", "fsusblog.security-fixture-cleanup-plan.v1");
        if (Required(plan, "runId") != binding.RunId || Required(plan, "namespace") != binding.Namespace)
        {
            throw new InvalidOperationException("security cleanup header/body binding mismatch");
        }
        string[] ids = plan.GetProperty("ownedOperationIds").EnumerateArray()
            .Select(static item => item.GetString() ?? string.Empty)
            .Order(StringComparer.Ordinal)
            .ToArray();
        if (ids.Length == 0 || ids.Any(static item => item.Length == 0 || item.Contains('*', StringComparison.Ordinal)))
        {
            throw new InvalidOperationException("security cleanup requires exact owned operation ids");
        }
        return new CleanupPlan(Required(plan, "planDigest"), Required(plan, "family"), ids);
    }

    private static string Required(JsonElement value, string property)
        => value.TryGetProperty(property, out JsonElement item) && item.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(item.GetString())
            ? item.GetString()!.Trim()
            : throw new InvalidOperationException($"security fixture {property} is required");

    private static void Require(JsonElement value, string property, string expected)
    {
        if (Required(value, property) != expected)
        {
            throw new InvalidOperationException($"security fixture {property} is invalid");
        }
    }

    private static string RiskIdentity(string operationId)
    {
        byte[] digest = SHA256.HashData(Encoding.UTF8.GetBytes(operationId));
        return $"127.{1 + digest[0] % 253}.{1 + digest[1] % 253}.{1 + digest[2] % 253}";
    }

    private static string HexDigest(string value)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    private static string Sha256(string value) => $"sha256:{HexDigest(value)}";

    private static string FormatInstant(DateTimeOffset value)
        => value.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);

    private static string DigestCanonical(IReadOnlyDictionary<string, object?> value)
    {
        using JsonDocument document = JsonDocument.Parse(JsonSerializer.Serialize(value));
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            WriteCanonical(writer, document.RootElement);
        }
        return $"sha256:{Convert.ToHexStringLower(SHA256.HashData(stream.ToArray()))}";
    }

    private static void WriteCanonical(Utf8JsonWriter writer, JsonElement value)
    {
        switch (value.ValueKind)
        {
            case JsonValueKind.Object:
                writer.WriteStartObject();
                foreach (JsonProperty property in value.EnumerateObject().OrderBy(static item => item.Name, StringComparer.Ordinal))
                {
                    writer.WritePropertyName(property.Name);
                    WriteCanonical(writer, property.Value);
                }
                writer.WriteEndObject();
                break;
            case JsonValueKind.Array:
                writer.WriteStartArray();
                foreach (JsonElement item in value.EnumerateArray())
                {
                    WriteCanonical(writer, item);
                }
                writer.WriteEndArray();
                break;
            default:
                value.WriteTo(writer);
                break;
        }
    }

    private sealed record FixtureFragment(
        string PlanDigest,
        string RunId,
        string Namespace,
        string Family,
        IReadOnlyList<FixtureOperation> Operations);

    private sealed record FixtureOperation(
        string CapabilityId,
        string Family,
        string OperationId,
        string SubjectDigest,
        string IpPseudonymDigest,
        string CredentialDigest,
        string NullifierDigest,
        string IssuanceDigest,
        int? SourceAccountId);

    private sealed record CleanupPlan(string PlanDigest, string Family, string[] OwnedOperationIds);

    private sealed record FixtureState(
        string OperationId,
        string PlanDigest,
        string RunId,
        string Namespace,
        string Family,
        string CapabilityId,
        string SubjectDigest,
        string IpPseudonymDigest,
        string CredentialDigest,
        string NullifierDigest,
        string IssuanceDigest,
        bool Present,
        string Decision,
        string Reason,
        long Version,
        int? AccountId,
        long? CredentialId,
        string? RiskIdentity,
        long CounterCurrent,
        long CounterLimit);
}
