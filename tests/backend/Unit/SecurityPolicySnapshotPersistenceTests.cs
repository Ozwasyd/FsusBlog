using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Models.Security;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollection))]
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
        => PostgresSqlSugarTestClient.InitTables(db, typeof(SecurityPolicySnapshot));

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
