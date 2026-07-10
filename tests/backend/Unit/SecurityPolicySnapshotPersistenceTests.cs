using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Models.Security;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class SecurityPolicySnapshotPersistenceTests(PostgresSchemaMigrationFixture fixture)
{
    private static readonly DateTimeOffset BaselineNow = DateTimeOffset.Parse("2026-06-19T08:00:00Z");

    [Fact]
    public void Migration_CreatesVersionedSecurityPolicySnapshotTable()
    {
        var registry = new SchemaMigrationRegistry();

        ISchemaMigrationDescriptor descriptor = Assert.Single(
            registry.GetDescriptors(),
            static item => item.MigrationId == "20260619-post-security-policy-snapshot");
        string fingerprint = string.Join('\n', descriptor.Steps.Select(static step => step.Fingerprint));

        Assert.Equal(SchemaMigrationPhase.PostCodeFirst, descriptor.Phase);
        Assert.Contains("CREATE TABLE IF NOT EXISTS security_policy_snapshot", fingerprint, StringComparison.Ordinal);
        Assert.Contains("policy_id varchar(64) NOT NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("version bigint NOT NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("mode varchar(32) NOT NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("document text NOT NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("created_by_admin_id bigint NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("activated_at_utc timestamp NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("revoked_at_utc timestamp NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("CREATE TABLE IF NOT EXISTS security_policy_version_counter", fingerprint, StringComparison.Ordinal);
        Assert.Contains("policy_id varchar(64) PRIMARY KEY", fingerprint, StringComparison.Ordinal);
        Assert.Contains("last_version bigint NOT NULL DEFAULT 0", fingerprint, StringComparison.Ordinal);
        Assert.Contains("unique_idx_security_policy_snapshot_policy_version", fingerprint, StringComparison.Ordinal);
        Assert.Contains("unique_idx_security_policy_snapshot_active", fingerprint, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ActivateAsync_WritesImmutableVersionsAndRevokesPreviousActive()
    {
        string connectionString = await CreateConnectionStringAsync();
        using SqlSugarClient db = CreateDb(connectionString);
        CreateTable(db);
            var service = new SecurityPolicySnapshotService(db, new StaticTimeProvider(BaselineNow));

            SecurityPolicySnapshotRecord first = await service.ActivateAsync(
                SecurityPolicyIds.AntiCrawler,
                SecuritySystemModes.Observe,
                CreateAntiCrawlerSnapshot("first", SecuritySystemModes.Observe),
                createdByAdminId: 7,
                reason: "initial",
                CancellationToken.None);
            SecurityPolicySnapshotRecord second = await service.ActivateAsync(
                SecurityPolicyIds.AntiCrawler,
                SecuritySystemModes.Enforce,
                CreateAntiCrawlerSnapshot("second", SecuritySystemModes.Enforce),
                createdByAdminId: 7,
                reason: "tighten",
                CancellationToken.None);

            Assert.Equal(1, first.Version);
            Assert.Equal(2, second.Version);
            List<SecurityPolicySnapshot> rows = await db.Queryable<SecurityPolicySnapshot>()
                .OrderBy(static item => item.Version)
                .ToListAsync();
            Assert.Equal(2, rows.Count);
            Assert.NotNull(rows[0].RevokedAtUtc);
            Assert.Null(rows[1].RevokedAtUtc);
            Assert.NotEqual(rows[0].Document, rows[1].Document);
    }

    [Fact]
    public async Task ActivateAsync_ConcurrentSamePolicyIdProducesStrictlyMonotonicVersions()
    {
        string connectionString = await CreateConnectionStringAsync();
        using SqlSugarClient setupDb = CreateDb(connectionString);
        CreateTable(setupDb);
        using SqlSugarClient firstDb = CreateDb(connectionString);
        using SqlSugarClient secondDb = CreateDb(connectionString);
        var firstService = new SecurityPolicySnapshotService(firstDb, new StaticTimeProvider(BaselineNow));
        var secondService = new SecurityPolicySnapshotService(secondDb, new StaticTimeProvider(BaselineNow.AddSeconds(1)));
        using var barrier = new Barrier(2);

        SecurityPolicySnapshotRecord[] records = await Task.WhenAll(
                StartBarrierTaskAsync(
                    barrier,
                    () => firstService.ActivateAsync(
                        SecurityPolicyIds.AntiCrawler,
                        SecuritySystemModes.Observe,
                        CreateAntiCrawlerSnapshot("first-concurrent", SecuritySystemModes.Observe),
                        createdByAdminId: 7,
                        reason: "first",
                        CancellationToken.None)),
                StartBarrierTaskAsync(
                    barrier,
                    () => secondService.ActivateAsync(
                        SecurityPolicyIds.AntiCrawler,
                        SecuritySystemModes.Enforce,
                        CreateAntiCrawlerSnapshot("second-concurrent", SecuritySystemModes.Enforce),
                        createdByAdminId: 8,
                        reason: "second",
                        CancellationToken.None)))
            .WaitAsync(TimeSpan.FromSeconds(30));

        long[] returnedVersions = records.Select(static item => item.Version).Order().ToArray();
        Assert.Equal([1, 2], returnedVersions);

        List<long> storedVersions = await setupDb.Queryable<SecurityPolicySnapshot>()
            .Where(static item => item.PolicyId == SecurityPolicyIds.AntiCrawler)
            .OrderBy(static item => item.Version)
            .Select(static item => item.Version)
            .ToListAsync();
        Assert.Equal([1, 2], storedVersions);
        Assert.Equal(1, storedVersions.Count(static version => version == 1));
        Assert.Equal(1, storedVersions.Count(static version => version == 2));
    }

    [Fact]
    public void ResolveNextVersionAsync_SourceUsesCounterReturningUpdateInsteadOfSnapshotMax()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Security/SecurityPolicySnapshotService.cs");
        int methodStart = source.IndexOf("private async Task<long> ResolveNextVersionAsync", StringComparison.Ordinal);
        int methodEnd = source.IndexOf("private async Task EnsureVersionCounterAsync", methodStart, StringComparison.Ordinal);
        string method = source[methodStart..methodEnd];

        Assert.Contains("SecurityPolicyVersionCounter", source, StringComparison.Ordinal);
        Assert.Contains("UPDATE security_policy_version_counter", method, StringComparison.Ordinal);
        Assert.Contains("RETURNING last_version", method, StringComparison.Ordinal);
        Assert.DoesNotContain("FOR UPDATE", method, StringComparison.Ordinal);
        Assert.DoesNotContain("OrderBy(item => item.Version, OrderByType.Desc)", method, StringComparison.Ordinal);
        Assert.DoesNotContain("latest?.Version", method, StringComparison.Ordinal);
    }

    [Fact]
    public void ResolveNextVersionAsync_SourceUsesSingleReturningUpdateOnHotPath()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Security/SecurityPolicySnapshotService.cs");
        int methodStart = source.IndexOf("private async Task<long> ResolveNextVersionAsync", StringComparison.Ordinal);
        int methodEnd = source.IndexOf("private async Task EnsureVersionCounterAsync", methodStart, StringComparison.Ordinal);
        string method = source[methodStart..methodEnd];

        Assert.Contains("UPDATE security_policy_version_counter", method, StringComparison.Ordinal);
        Assert.Contains("RETURNING last_version", method, StringComparison.Ordinal);
        Assert.Contains("EnsureVersionCounterAsync(policyId, cancellationToken)", method, StringComparison.Ordinal);
        Assert.DoesNotContain("SELECT last_version", method, StringComparison.Ordinal);
        Assert.DoesNotContain("FOR UPDATE", method, StringComparison.Ordinal);
        Assert.DoesNotContain("db.Updateable<SecurityPolicyVersionCounter>()", method, StringComparison.Ordinal);
    }

    [Fact]
    public async Task RollbackAsync_CreatesNewActiveVersionFromHistoricalDocumentAndAudits()
    {
        string connectionString = await CreateConnectionStringAsync();
        using SqlSugarClient db = CreateDb(connectionString);
        CreateTable(db);
            var audit = new CapturingAuditEventService();
            var service = new SecurityPolicySnapshotService(db, new StaticTimeProvider(BaselineNow), audit);

            await service.ActivateAsync(SecurityPolicyIds.Pow, SecuritySystemModes.Observe, CreatePowSnapshot("first", SecuritySystemModes.Observe), 1, "initial", CancellationToken.None);
            await service.ActivateAsync(SecurityPolicyIds.Pow, SecuritySystemModes.Enforce, CreatePowSnapshot("second", SecuritySystemModes.Enforce), 1, "tighten", CancellationToken.None);

            SecurityPolicyRollbackResult<PowPolicySnapshot> rollback = await service.RollbackAsync<PowPolicySnapshot>(
                SecurityPolicyIds.Pow,
                targetVersion: 1,
                createdByAdminId: 2,
                reason: "rollback",
                CancellationToken.None);

            Assert.True(rollback.Success, rollback.Reason);
            Assert.Equal(3, rollback.Record?.Version);
            Assert.NotNull(rollback.Document);
            Assert.Equal(SecuritySystemModes.Observe, rollback.Document!.Options.Mode);
            Assert.Equal(3, await db.Queryable<SecurityPolicySnapshot>().CountAsync());
            AuditEvent auditEvent = Assert.Single(audit.Events, static item => item.Action == AuditActionCatalog.SecurityPolicyRolledBack);
            Assert.Equal("security_policy_snapshot", auditEvent.TargetType);
            Assert.Equal("rollback", auditEvent.ReasonCode);
    }

    [Fact]
    public async Task LoadActiveOrLastKnownGoodAsync_FallsBackWhenActiveDocumentCannotDeserialize()
    {
        string connectionString = await CreateConnectionStringAsync();
        using SqlSugarClient db = CreateDb(connectionString);
        CreateTable(db);
            var service = new SecurityPolicySnapshotService(db, new StaticTimeProvider(BaselineNow));
            await service.ActivateAsync(SecurityPolicyIds.AntiCrawler, SecuritySystemModes.Observe, CreateAntiCrawlerSnapshot("lkg", SecuritySystemModes.Observe), 1, "initial", CancellationToken.None);
            await db.Updateable<SecurityPolicySnapshot>()
                .SetColumns(item => item.RevokedAtUtc == BaselineNow.AddSeconds(30).UtcDateTime)
                .Where(static item => item.Version == 1)
                .ExecuteCommandAsync();
            await db.Insertable(new SecurityPolicySnapshot
            {
                PolicyId = SecurityPolicyIds.AntiCrawler,
                Version = 2,
                Mode = SecuritySystemModes.Enforce,
                Document = "{not-json",
                CreatedByAdminId = 2,
                CreatedAtUtc = BaselineNow.AddMinutes(1).UtcDateTime,
                ActivatedAtUtc = BaselineNow.AddMinutes(1).UtcDateTime,
                IsLastKnownGood = false,
                Reason = "bad-active"
            }).ExecuteCommandAsync();

            SecurityPolicyLoadResult<AntiCrawlerPolicySnapshot> loaded = await service.LoadActiveOrLastKnownGoodAsync<AntiCrawlerPolicySnapshot>(
                SecurityPolicyIds.AntiCrawler,
                CancellationToken.None);

            Assert.True(loaded.Success, loaded.Reason);
            Assert.True(loaded.UsedLastKnownGood);
            Assert.NotNull(loaded.Document);
            Assert.Equal(SecuritySystemModes.Observe, loaded.Document!.Options.Mode);
            Assert.Equal(1, loaded.Record?.Version);
    }

    [Fact]
    public void SecurityEndpoints_RequireAdminStepUpAndPersistPolicySnapshotsForWrites()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Modules/Endpoints/SecurityEndpoints.cs");

        Assert.Contains("X-Fsus-Mfa-Proof", source, StringComparison.Ordinal);
        Assert.Contains("AedsJsonResults.PreconditionRequired", source, StringComparison.Ordinal);
        Assert.Contains("ISecurityPolicySnapshotService policySnapshots", source, StringComparison.Ordinal);
        Assert.Contains("policySnapshots.ActivateAsync", source, StringComparison.Ordinal);
        Assert.Contains("policySnapshots.RollbackAsync", source, StringComparison.Ordinal);
        Assert.Contains("SecurityPolicyIds.RiskControl", source, StringComparison.Ordinal);
        Assert.Contains("SecurityPolicyIds.PerceptionSealedV2", source, StringComparison.Ordinal);
        Assert.Contains("/risk-control/options", source, StringComparison.Ordinal);
        Assert.Contains("/perception-v2/options", source, StringComparison.Ordinal);
        Assert.Contains("admin.security.risk_control.options_updated", source, StringComparison.Ordinal);
        Assert.Contains("admin.security.risk_control.options_rolled_back", source, StringComparison.Ordinal);
        Assert.Contains("admin.security.perception_v2.options_updated", source, StringComparison.Ordinal);
        Assert.Contains("admin.security.perception_v2.options_rolled_back", source, StringComparison.Ordinal);
        Assert.Contains("RequireAdminSensitiveStepUpAsync", source, StringComparison.Ordinal);
    }

    [Fact]
    public void SecurityEndpoints_AttributePolicyMutationActorsToAdminPrincipal()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Modules/Endpoints/SecurityEndpoints.cs");

        Assert.DoesNotContain("context.GetUserId()", source, StringComparison.Ordinal);
        Assert.Contains("private static string ResolveActor(HttpContext context)", source, StringComparison.Ordinal);
        Assert.Contains("=> FormatAdminActor(ResolveAdminPrincipalId(context));", source, StringComparison.Ordinal);
        Assert.Contains("context.User.IsAdminPrincipal()", source, StringComparison.Ordinal);
        Assert.Contains("context.User.TryGetAdminPrincipalId(out long adminPrincipalId)", source, StringComparison.Ordinal);
        Assert.Contains("throw new UnauthorizedAccessException(\"admin_principal_missing\")", source, StringComparison.Ordinal);
        Assert.Contains("string.Concat(\"admin:\", adminPrincipalId.ToString(CultureInfo.InvariantCulture))", source, StringComparison.Ordinal);
        Assert.Contains("ActorType: AuditActorTypeCatalog.Admin", source, StringComparison.Ordinal);
        Assert.Contains("ActorId: adminPrincipalId.ToString(CultureInfo.InvariantCulture)", source, StringComparison.Ordinal);
        Assert.Contains("[\"adminPrincipalId\"] = adminPrincipalId", source, StringComparison.Ordinal);
        Assert.Contains("policySnapshots.ActivateAsync", source, StringComparison.Ordinal);
        Assert.Contains("ResolveAdminPrincipalId(context)", source, StringComparison.Ordinal);
    }

    [Fact]
    public void StartupLoader_LoadsRiskControlAndPerceptionV2ActiveOrLastKnownGoodPolicy()
    {
        string service = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Security/SecurityPolicySnapshotService.cs");

        Assert.Contains("public const string RiskControl = \"risk-control\"", service, StringComparison.Ordinal);
        Assert.Contains("public const string PerceptionSealedV2 = \"perception-sealed-v2\"", service, StringComparison.Ordinal);
        Assert.Contains("LoadActiveOrLastKnownGoodAsync<SecurityRiskPolicySnapshotV2>", service, StringComparison.Ordinal);
        Assert.Contains("LoadActiveOrLastKnownGoodAsync<PerceptionSealedV2PolicySnapshot>", service, StringComparison.Ordinal);
        Assert.Contains("policy.ApplyRiskControlPolicySnapshot", service, StringComparison.Ordinal);
        Assert.Contains("policy.ApplyPerceptionSealedV2PolicySnapshot", service, StringComparison.Ordinal);
    }

    [Fact]
    public void StartupLoader_LoadsPolicySnapshotsSequentiallyWithoutSharingScopedDbClientConcurrently()
    {
        string service = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Security/SecurityPolicySnapshotService.cs");
        string start = ExtractBetween(service, "public async Task StartAsync", "    public Task StopAsync");

        Assert.DoesNotContain("Task.WhenAll", start, StringComparison.Ordinal);
        Assert.DoesNotContain("antiCrawlerTask", start, StringComparison.Ordinal);
        Assert.DoesNotContain("powTask", start, StringComparison.Ordinal);
        Assert.DoesNotContain("riskControlTask", start, StringComparison.Ordinal);
        Assert.DoesNotContain("perceptionV2Task", start, StringComparison.Ordinal);
        Assert.Contains("SecurityPolicyLoadResult<AntiCrawlerPolicySnapshot> antiCrawler =\n                await", start, StringComparison.Ordinal);
        Assert.Contains("SecurityPolicyLoadResult<PowPolicySnapshot> pow =\n                await", start, StringComparison.Ordinal);
        Assert.Contains("SecurityPolicyLoadResult<SecurityRiskPolicySnapshotV2> riskControl =\n                await", start, StringComparison.Ordinal);
        Assert.Contains("SecurityPolicyLoadResult<PerceptionSealedV2PolicySnapshot> perceptionV2 =\n                await", start, StringComparison.Ordinal);
    }

    private static AntiCrawlerPolicySnapshot CreateAntiCrawlerSnapshot(string id, string mode)
        => new(id, BaselineNow, "admin:1", "unit", new AntiCrawlerPolicyOptions(
            mode,
            PublicReadChallengeEnabled: true,
            SearchCrawlerVerificationEnabled: true,
            SocialPreviewGuardEnabled: true,
            RiskScoringEnabled: true,
            EventPersistenceEnabled: true,
            DashboardAggregationEnabled: true,
            CidrAutoUpdateEnabled: false,
            IllegalPathHardAbortEnabled: true,
            RequireChallengeScore: 50,
            BlockScore: 100,
            MaxRiskScore: 200,
            DefaultRiskTtlSeconds: 600,
            ZeroRiskCacheTtlSeconds: 3,
            FixedIpPermitLimit: 100,
            FixedIpQueueLimit: 10,
            VerifiedCrawlerFixedIpPermitLimit: 1000,
            PublicReadPermitLimit: 100,
            PublicReadQueueLimit: 10,
            VerifiedCrawlerPublicReadPermitLimit: 1000,
            SocialPreviewPublicReadPermitLimit: 1000,
            ReadProofPermitLimit: 1000,
            CidrUpdateIntervalMinutes: 1440,
            CidrInitialDelaySeconds: 0,
            CidrMinUpdateIntervalMinutes: 30,
            GoogleCrawlerRangesUrl: "https://example.invalid/google.json",
            BingCrawlerRangesUrl: "https://example.invalid/bing.json",
            SnapshotPath: null,
            SocialPreviewAllowedPathPrefixes: ["/"],
            BlockedUserAgentKeywords: ["curl"],
            SecurityChallengeReference: "security.pow"));

    private static PowPolicySnapshot CreatePowSnapshot(string id, string mode)
        => new(id, BaselineNow, "admin:1", "unit", new PowPolicyOptions(
            mode,
            DefaultDifficulty: 4,
            AdaptiveDifficultyEnabled: true,
            ProofTtlSeconds: 300,
            ReplayProtectionEnabled: true,
            RiskScoreLinkEnabled: true,
            ChallengeEndpoint: "/api/binary/auth/pow-challenge",
            VerificationStrategy: "RedisPowService"));

    private Task<string> CreateConnectionStringAsync()
        => PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);

    private static SqlSugarClient CreateDb(string connectionString)
        => PostgresSqlSugarTestClient.Create(connectionString);

    private static void CreateTable(SqlSugarClient db)
        => PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(SecurityPolicySnapshot),
            typeof(SecurityPolicyVersionCounter));

    private static Task<T> StartBarrierTaskAsync<T>(Barrier barrier, Func<Task<T>> action)
        => Task.Factory.StartNew(
            async () =>
            {
                Assert.True(
                    barrier.SignalAndWait(TimeSpan.FromSeconds(30)),
                    "Timed out waiting for concurrent security policy writers.");
                return await action();
            },
            CancellationToken.None,
            TaskCreationOptions.LongRunning,
            TaskScheduler.Default).Unwrap();

    private static string ExtractBetween(string source, string start, string end)
    {
        int startIndex = source.IndexOf(start, StringComparison.Ordinal);
        Assert.True(startIndex >= 0, $"Missing start marker: {start}");
        int endIndex = source.IndexOf(end, startIndex + start.Length, StringComparison.Ordinal);
        Assert.True(endIndex > startIndex, $"Missing end marker: {end}");
        return source[startIndex..endIndex];
    }

    private sealed class CapturingAuditEventService : IAuditEventService
    {
        public List<AuditEvent> Events { get; } = [];

        public Task RecordAsync(AuditEvent auditEvent, CancellationToken cancellationToken = default)
        {
            Events.Add(auditEvent);
            return Task.CompletedTask;
        }

        public Task RecordHighValueAsync(AuditEvent auditEvent, CancellationToken cancellationToken = default)
        {
            Events.Add(auditEvent with { IsHighValue = true });
            return Task.CompletedTask;
        }
    }

    private sealed class StaticTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => utcNow;
    }
}
