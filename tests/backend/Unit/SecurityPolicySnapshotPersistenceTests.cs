using System.Reflection;
using System.Security.Claims;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Models.Security;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;
namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class SecurityPolicySnapshotPersistenceTests(PostgresSchemaMigrationFixture fixture)
{
    private static readonly DateTimeOffset s_baselineNow = DateTimeOffset.Parse("2026-06-19T08:00:00Z");

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
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
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task ActivateAsync_WritesImmutableVersionsAndRevokesPreviousActive()
    {
        string connectionString = await CreateConnectionStringAsync();
        using SqlSugarClient db = CreateDb(connectionString);
        CreateTable(db);
        var service = new SecurityPolicySnapshotService(db, new StaticTimeProvider(s_baselineNow));

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
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Concurrency, ConcurrencyHarness = "fsusblog.real-concurrency.v1")]
    public async Task ActivateAsync_ConcurrentSamePolicyIdProducesStrictlyMonotonicVersions()
    {
        string connectionString = await CreateConnectionStringAsync();
        using SqlSugarClient setupDb = CreateDb(connectionString);
        CreateTable(setupDb);
        using SqlSugarClient firstDb = CreateDb(connectionString);
        using SqlSugarClient secondDb = CreateDb(connectionString);
        var firstService = new SecurityPolicySnapshotService(firstDb, new StaticTimeProvider(s_baselineNow));
        var secondService = new SecurityPolicySnapshotService(secondDb, new StaticTimeProvider(s_baselineNow.AddSeconds(1)));
        using var barrier = new Barrier(2);

        SecurityPolicySnapshotRecord[] records = await RealConcurrencyHarness.RunAsync(
            () => StartBarrierTaskAsync(
                    barrier,
                    () => firstService.ActivateAsync(
                        SecurityPolicyIds.AntiCrawler,
                        SecuritySystemModes.Observe,
                        CreateAntiCrawlerSnapshot("first-concurrent", SecuritySystemModes.Observe),
                        createdByAdminId: 7,
                        reason: "first",
                        CancellationToken.None)),
            () => StartBarrierTaskAsync(
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
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task ResolveNextVersionAsync_RuntimeUsesSingleReturningUpdateOnHotPath()
    {
        string connectionString = await CreateConnectionStringAsync();
        using SqlSugarClient db = CreateDb(connectionString);
        CreateTable(db);
        await db.Insertable(new SecurityPolicyVersionCounter
        {
            PolicyId = SecurityPolicyIds.Pow,
            LastVersion = 40,
            UpdatedAtUtc = s_baselineNow.UtcDateTime
        }).ExecuteCommandAsync();
        var sql = new List<string>();
        db.Aop.OnLogExecuting = (statement, _) => sql.Add(statement);
        var service = new SecurityPolicySnapshotService(db, new StaticTimeProvider(s_baselineNow));

        SecurityPolicySnapshotRecord record = await service.ActivateAsync(
            SecurityPolicyIds.Pow,
            SecuritySystemModes.Enforce,
            CreatePowSnapshot("hot-counter", SecuritySystemModes.Enforce),
            7,
            "hot-counter",
            CancellationToken.None);

        string[] counterStatements = sql.Where(static statement =>
            statement.Contains("security_policy_version_counter", StringComparison.OrdinalIgnoreCase)).ToArray();
        Assert.Equal(41, record.Version);
        string update = Assert.Single(counterStatements);
        Assert.Contains("UPDATE", update, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("RETURNING last_version", update, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("SELECT last_version", update, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("MAX(version)", update, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("FOR UPDATE", update, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task RollbackAsync_CreatesNewActiveVersionFromHistoricalDocumentAndAudits()
    {
        string connectionString = await CreateConnectionStringAsync();
        using SqlSugarClient db = CreateDb(connectionString);
        CreateTable(db);
        var audit = new CapturingAuditEventService();
        var service = new SecurityPolicySnapshotService(db, new StaticTimeProvider(s_baselineNow), audit);

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
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "security-policy-corrupt-active-lkg-only")]
    public async Task LoadActiveOrLastKnownGoodAsync_FallsBackWhenActiveDocumentCannotDeserialize()
    {
        string connectionString = await CreateConnectionStringAsync();
        using SqlSugarClient db = CreateDb(connectionString);
        CreateTable(db);
        var service = new SecurityPolicySnapshotService(db, new StaticTimeProvider(s_baselineNow));
        await service.ActivateAsync(SecurityPolicyIds.AntiCrawler, SecuritySystemModes.Observe, CreateAntiCrawlerSnapshot("lkg", SecuritySystemModes.Observe), 1, "initial", CancellationToken.None);
        await db.Updateable<SecurityPolicySnapshot>()
            .SetColumns(item => item.RevokedAtUtc == s_baselineNow.AddSeconds(30).UtcDateTime)
            .Where(static item => item.Version == 1)
            .ExecuteCommandAsync();
        await db.Insertable(new SecurityPolicySnapshot
        {
            PolicyId = SecurityPolicyIds.AntiCrawler,
            Version = 2,
            Mode = SecuritySystemModes.Enforce,
            Document = "{not-json",
            CreatedByAdminId = 2,
            CreatedAtUtc = s_baselineNow.AddMinutes(1).UtcDateTime,
            ActivatedAtUtc = s_baselineNow.AddMinutes(1).UtcDateTime,
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
    [Trait("ShardAffinity", "EndpointContractApplication")]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task SecurityEndpoints_RequireAdminStepUpAndPersistPolicySnapshotsForWrites()
    {
        await using EndpointContractSnapshot app = EndpointContractApplication.CreateSnapshot();
        RouteEndpoint riskUpdate = FindRoute(app, "/api/binary/admin/security/risk-control/options", HttpMethods.Put);
        RouteEndpoint riskRollback = FindRoute(app, "/api/binary/admin/security/risk-control/options/rollback", HttpMethods.Post);
        RouteEndpoint perceptionUpdate = FindRoute(app, "/api/binary/admin/security/perception-v2/options", HttpMethods.Put);
        RouteEndpoint perceptionRollback = FindRoute(app, "/api/binary/admin/security/perception-v2/options/rollback", HttpMethods.Post);
        RouteEndpoint[] mutations = [riskUpdate, riskRollback, perceptionUpdate, perceptionRollback];

        Assert.Equal("X-Fsus-Mfa-Proof", typeof(SecurityEndpoints)
            .GetField("MfaProofHeader", BindingFlags.NonPublic | BindingFlags.Static)!
            .GetRawConstantValue());
        Assert.NotNull(riskUpdate.Metadata.GetMetadata<AdminSensitiveStepUpMetadata>());
        foreach (RouteEndpoint endpoint in mutations)
        {
            MethodInfo handler = endpoint.Metadata.GetMetadata<MethodInfo>()!;
            Assert.Contains(handler.GetParameters(), static parameter =>
                parameter.ParameterType == typeof(ISecurityPolicySnapshotService));
            string runtimeShape = RuntimeMetadataInspection.DescribeMethods(handler.DeclaringType!, handler.Name);
            Assert.Contains("RequireAdminSensitiveStepUpAsync", runtimeShape, StringComparison.Ordinal);
        }
        string endpointRuntime = RuntimeMetadataInspection.DescribeType(typeof(SecurityEndpoints));
        Assert.Contains("ISecurityPolicySnapshotService.ActivateAsync", endpointRuntime, StringComparison.Ordinal);
        Assert.Contains("ISecurityPolicySnapshotService.RollbackAsync", endpointRuntime, StringComparison.Ordinal);
        Assert.Contains(SecurityPolicyIds.RiskControl, endpointRuntime, StringComparison.Ordinal);
        Assert.Contains(SecurityPolicyIds.PerceptionSealedV2, endpointRuntime, StringComparison.Ordinal);
        Assert.Contains("admin.security.risk_control.options_updated", endpointRuntime, StringComparison.Ordinal);
        Assert.Contains("admin.security.risk_control.options_rolled_back", endpointRuntime, StringComparison.Ordinal);
        Assert.Contains("admin.security.perception_v2.options_updated", endpointRuntime, StringComparison.Ordinal);
        Assert.Contains("admin.security.perception_v2.options_rolled_back", endpointRuntime, StringComparison.Ordinal);
        Assert.Contains("PreconditionRequired", endpointRuntime, StringComparison.Ordinal);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "security-policy-admin-principal-required")]
    public async Task SecurityEndpoints_AttributePolicyMutationActorsToAdminPrincipal()
    {
        MethodInfo resolveActor = typeof(SecurityEndpoints).GetMethod("ResolveActor", BindingFlags.NonPublic | BindingFlags.Static)!;
        MethodInfo resolveId = typeof(SecurityEndpoints).GetMethod("ResolveAdminPrincipalId", BindingFlags.NonPublic | BindingFlags.Static)!;
        var context = new DefaultHttpContext
        {
            User = new ClaimsPrincipal(new ClaimsIdentity(
            [
                new Claim("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind),
                new Claim("admin_id", "42")
            ], "unit"))
        };

        Assert.Equal(42L, resolveId.Invoke(null, [context]));
        Assert.Equal("admin:42", resolveActor.Invoke(null, [context]));
        var audit = new CapturingAuditEventService();
        MethodInfo recordAudit = typeof(SecurityEndpoints).GetMethod("RecordSecurityAuditAsync", BindingFlags.NonPublic | BindingFlags.Static)!;
        await (Task)recordAudit.Invoke(null,
        [
            context,
            audit,
            "admin.security.runtime",
            "runtime",
            "security_policy_snapshot",
            "snapshot-42",
            "runtime",
            new { Value = 1 },
            CancellationToken.None
        ])!;
        AuditEvent recorded = Assert.Single(audit.Events);
        Assert.Equal(AuditActorTypeCatalog.Admin, recorded.ActorType);
        Assert.Equal("42", recorded.ActorId);
        Assert.Equal("admin:42", recorded.ActorRole);
        Assert.Equal(42L, recorded.Context!["adminPrincipalId"]);

        context.User = new ClaimsPrincipal(new ClaimsIdentity());
        TargetInvocationException exception = Assert.Throws<TargetInvocationException>(() => resolveId.Invoke(null, [context]));
        Assert.IsType<UnauthorizedAccessException>(exception.InnerException);
        Assert.Equal("admin_principal_missing", exception.InnerException!.Message);

        string runtimeShape = RuntimeMetadataInspection.DescribeType(typeof(SecurityEndpoints));
        Assert.DoesNotContain("GetUserId", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("IsAdminPrincipal", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("TryGetAdminPrincipalId", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("adminPrincipalId", runtimeShape, StringComparison.Ordinal);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task StartupLoader_LoadsRiskControlAndPerceptionV2ActiveOrLastKnownGoodPolicy()
    {
        ISecurityPolicySnapshotService snapshots = Substitute.For<ISecurityPolicySnapshotService>();
        SecurityRiskPolicySnapshotV2 risk = CreateRiskControlSnapshot();
        PerceptionSealedV2PolicySnapshot perception = CreatePerceptionSnapshot();
        snapshots.LoadActiveOrLastKnownGoodAsync<AntiCrawlerPolicySnapshot>(SecurityPolicyIds.AntiCrawler, Arg.Any<CancellationToken>())
            .Returns(new SecurityPolicyLoadResult<AntiCrawlerPolicySnapshot>(false, null, null, false, "missing"));
        snapshots.LoadActiveOrLastKnownGoodAsync<PowPolicySnapshot>(SecurityPolicyIds.Pow, Arg.Any<CancellationToken>())
            .Returns(new SecurityPolicyLoadResult<PowPolicySnapshot>(false, null, null, false, "missing"));
        snapshots.LoadActiveOrLastKnownGoodAsync<SecurityRiskPolicySnapshotV2>(SecurityPolicyIds.RiskControl, Arg.Any<CancellationToken>())
            .Returns(new SecurityPolicyLoadResult<SecurityRiskPolicySnapshotV2>(true, risk, null, false, "active"));
        snapshots.LoadActiveOrLastKnownGoodAsync<PerceptionSealedV2PolicySnapshot>(SecurityPolicyIds.PerceptionSealedV2, Arg.Any<CancellationToken>())
            .Returns(new SecurityPolicyLoadResult<PerceptionSealedV2PolicySnapshot>(true, perception, null, true, "last_known_good"));
        using ServiceProvider services = new ServiceCollection()
            .AddScoped(_ => snapshots)
            .BuildServiceProvider();
        ISecurityAdminPolicyService policy = Substitute.For<ISecurityAdminPolicyService>();
        var loader = new SecurityPolicySnapshotHostedService(
            services.GetRequiredService<IServiceScopeFactory>(),
            policy,
            NullLogger<SecurityPolicySnapshotHostedService>.Instance);

        await loader.StartAsync(CancellationToken.None);

        Assert.Equal("risk-control", SecurityPolicyIds.RiskControl);
        Assert.Equal("perception-sealed-v2", SecurityPolicyIds.PerceptionSealedV2);
        await snapshots.Received(1).LoadActiveOrLastKnownGoodAsync<SecurityRiskPolicySnapshotV2>(SecurityPolicyIds.RiskControl, Arg.Any<CancellationToken>());
        await snapshots.Received(1).LoadActiveOrLastKnownGoodAsync<PerceptionSealedV2PolicySnapshot>(SecurityPolicyIds.PerceptionSealedV2, Arg.Any<CancellationToken>());
        policy.Received(1).ApplyRiskControlPolicySnapshot(risk);
        policy.Received(1).ApplyPerceptionSealedV2PolicySnapshot(perception);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task StartupLoader_LoadsPolicySnapshotsSequentiallyWithoutSharingScopedDbClientConcurrently()
    {
        var snapshots = new ConcurrencyTrackingSnapshotService();
        using ServiceProvider services = new ServiceCollection()
            .AddScoped<ISecurityPolicySnapshotService>(_ => snapshots)
            .BuildServiceProvider();
        var loader = new SecurityPolicySnapshotHostedService(
            services.GetRequiredService<IServiceScopeFactory>(),
            Substitute.For<ISecurityAdminPolicyService>(),
            NullLogger<SecurityPolicySnapshotHostedService>.Instance);

        await loader.StartAsync(CancellationToken.None);

        Assert.Equal(1, snapshots.MaxConcurrentLoads);
        Assert.Equal(
            [SecurityPolicyIds.AntiCrawler, SecurityPolicyIds.Pow, SecurityPolicyIds.RiskControl, SecurityPolicyIds.PerceptionSealedV2],
            snapshots.PolicyIds);
    }

    private static AntiCrawlerPolicySnapshot CreateAntiCrawlerSnapshot(string id, string mode)
        => new(id, s_baselineNow, "admin:1", "unit", new AntiCrawlerPolicyOptions(
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
        => new(id, s_baselineNow, "admin:1", "unit", new PowPolicyOptions(
            mode,
            DefaultDifficulty: 4,
            AdaptiveDifficultyEnabled: true,
            ProofTtlSeconds: 300,
            ReplayProtectionEnabled: true,
            RiskScoreLinkEnabled: true,
            ChallengeEndpoint: "/api/binary/auth/pow-challenge",
            VerificationStrategy: "RedisPowService"));

    private static SecurityRiskPolicySnapshotV2 CreateRiskControlSnapshot()
    {
        var defaultAction = new SecurityRiskActionPolicy(
            "*",
            new SecurityRiskActionThresholds(10, 25, 50, 75, 90),
            "sha256PowV1",
            1,
            null,
            AnonymousWriteAllowed: true);
        return new SecurityRiskPolicySnapshotV2(
            "risk-policy-runtime",
            "risk-policy-v2",
            s_baselineNow,
            SecuritySystemModes.Enforce,
            200,
            125,
            "risk-policy-lkg",
            defaultAction,
            new Dictionary<string, SecurityRiskActionPolicy>(StringComparer.Ordinal),
            new Dictionary<string, string>(StringComparer.Ordinal));
    }

    private static PerceptionSealedV2PolicySnapshot CreatePerceptionSnapshot()
        => new(
            "perception-runtime",
            "perception-v2",
            s_baselineNow,
            "admin:42",
            "runtime",
            null,
            new PerceptionSealedV2PolicyOptions(
                Enabled: true,
                LocalizationEnabled: true,
                MicroInteractionEnabled: false,
                PoSpaceFallbackEnabled: false,
                EarlyRejectThreshold: 90,
                MaxAttempts: 3,
                MinSolveDurationMs: 750,
                MaxSolveDurationMs: 60_000));

    private Task<string> CreateConnectionStringAsync()
        => PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);

    private static SqlSugarClient CreateDb(string connectionString)
        => PostgresSqlSugarTestClient.Create(connectionString);

    private static void CreateTable(SqlSugarClient db)
        => PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(SecurityPolicySnapshot),
            typeof(SecurityPolicyVersionCounter),
            typeof(ArticleSourceGeneration),
            typeof(ArticleSourceSequence),
            typeof(ArticleSourceMutation),
            typeof(ArticleSourceObservation));

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

    private static RouteEndpoint FindRoute(IEndpointRouteBuilder app, string route, string method)
        => Assert.Single(((IEndpointRouteBuilder)app).DataSources
            .SelectMany(static source => source.Endpoints)
            .OfType<RouteEndpoint>(),
            endpoint => string.Equals(
                    endpoint.RoutePattern.RawText?.TrimStart('/'),
                    route.TrimStart('/'),
                    StringComparison.Ordinal)
                && endpoint.Metadata.GetMetadata<IHttpMethodMetadata>()?.HttpMethods.Contains(method, StringComparer.Ordinal) == true);

    private sealed class ConcurrencyTrackingSnapshotService : ISecurityPolicySnapshotService
    {
        private int _activeLoads;
        public int MaxConcurrentLoads
        {
            get; private set;
        }
        public List<string> PolicyIds { get; } = [];

        public Task<SecurityPolicySnapshotRecord> ActivateAsync<T>(
            string policyId,
            string mode,
            T document,
            long? createdByAdminId,
            string? reason,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public async Task<SecurityPolicyLoadResult<T>> LoadActiveOrLastKnownGoodAsync<T>(
            string policyId,
            CancellationToken cancellationToken = default)
        {
            int active = Interlocked.Increment(ref _activeLoads);
            MaxConcurrentLoads = Math.Max(MaxConcurrentLoads, active);
            PolicyIds.Add(policyId);
            try
            {
                await Task.Yield();
                return new SecurityPolicyLoadResult<T>(false, default, null, false, "missing");
            }
            finally
            {
                Interlocked.Decrement(ref _activeLoads);
            }
        }

        public Task<SecurityPolicyRollbackResult<T>> RollbackAsync<T>(
            string policyId,
            long? targetVersion,
            long? createdByAdminId,
            string? reason,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();
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
            Events.Add(auditEvent with
            {
                IsHighValue = true
            });
            return Task.CompletedTask;
        }
    }

    private sealed class StaticTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => utcNow;
    }
}
