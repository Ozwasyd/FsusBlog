using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Tests.TestInfrastructure;
using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class LogCleanupDatabaseBehaviorTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task CleanupVisitLogsAsync_DeletesExpiredRowsInPagesAndKeepsCutoffBoundary()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(VisitLog));
        DateTime cutoff = new(2026, 6, 25, 0, 0, 0, DateTimeKind.Utc);
        await db.Insertable(Enumerable.Range(1, 5)
            .Select(index => new VisitLog
            {
                IpHash = $"expired-{index}",
                Region = "test",
                CreateTime = cutoff.AddDays(-2)
            })
            .Append(new VisitLog
            {
                IpHash = "cutoff-boundary",
                Region = "test",
                CreateTime = cutoff
            })
            .ToArray())
            .ExecuteCommandAsync();

        int deleted = await LogCleanupService.CleanupVisitLogsAsync(
            db,
            cutoff,
            chunkSize: 2,
            maxChunks: 10,
            delayBetweenChunks: TimeSpan.Zero,
            CancellationToken.None);

        Assert.Equal(5, deleted);
        VisitLog retained = Assert.Single(await db.Queryable<VisitLog>().ToListAsync());
        Assert.Equal("cutoff-boundary", retained.IpHash);
        Assert.Equal(cutoff, retained.CreateTime);
    }

    [Fact]
    public async Task CleanupRumAuditAndAnonymousCredentialAuditAsync_DeleteOnlyEligibleExpiredRows()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(FrontendRumMetric),
            typeof(AuditLog),
            typeof(AnonymousCredentialIssuanceAudit));
        DateTime cutoff = new(2026, 6, 25, 0, 0, 0, DateTimeKind.Utc);

        await db.Insertable(new[]
        {
            CreateRum("rum-expired-1", cutoff.AddDays(-2)),
            CreateRum("rum-expired-2", cutoff.AddDays(-2)),
            CreateRum("rum-expired-3", cutoff.AddDays(-2)),
            CreateRum("rum-cutoff", cutoff)
        }).ExecuteCommandAsync();
        await db.Insertable(new[]
        {
            CreateAudit("audit-expired", cutoff.AddDays(-2), AuditSeverityCatalog.Info, highValue: false),
            CreateAudit("audit-cutoff", cutoff, AuditSeverityCatalog.Info, highValue: false),
            CreateAudit("audit-critical", cutoff.AddDays(-2), AuditSeverityCatalog.Critical, highValue: false),
            CreateAudit("audit-high-value", cutoff.AddDays(-2), AuditSeverityCatalog.Info, highValue: true)
        }).ExecuteCommandAsync();
        await db.Insertable(new[]
        {
            CreateAnonymousAudit("anonymous-expired-1", 1, cutoff.AddDays(-2)),
            CreateAnonymousAudit("anonymous-expired-2", 2, cutoff.AddDays(-2)),
            CreateAnonymousAudit("anonymous-expired-3", 3, cutoff.AddDays(-2)),
            CreateAnonymousAudit("anonymous-cutoff", 4, cutoff)
        }).ExecuteCommandAsync();

        int rumDeleted = await LogCleanupService.CleanupRumMetricsAsync(
            db, cutoff, 2, 10, TimeSpan.Zero, CancellationToken.None);
        int auditDeleted = await LogCleanupService.CleanupAuditLogsAsync(
            db, cutoff, 2, 10, TimeSpan.Zero, CancellationToken.None);
        int anonymousAuditDeleted = await LogCleanupService.CleanupAnonymousCredentialIssuanceAuditAsync(
            db, cutoff, 2, 10, TimeSpan.Zero, CancellationToken.None);

        Assert.Equal(3, rumDeleted);
        Assert.Equal(1, auditDeleted);
        Assert.Equal(3, anonymousAuditDeleted);

        FrontendRumMetric retainedRum = Assert.Single(await db.Queryable<FrontendRumMetric>().ToListAsync());
        Assert.Equal("rum-cutoff", retainedRum.Name);

        List<string> retainedAuditActions = (await db.Queryable<AuditLog>().ToListAsync())
            .Select(item => item.Action)
            .OrderBy(value => value, StringComparer.Ordinal)
            .ToList();
        Assert.Equal(new[] { "audit-critical", "audit-cutoff", "audit-high-value" }, retainedAuditActions);

        AnonymousCredentialIssuanceAudit retainedAnonymous = Assert.Single(
            await db.Queryable<AnonymousCredentialIssuanceAudit>().ToListAsync());
        Assert.Equal("anonymous-cutoff", retainedAnonymous.SubjectHash);
    }

    [Fact]
    public async Task CleanupLegacySecurityRiskPseudonymsAsync_DeletesOnlyUnkeyedEpochs()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(SecurityRiskEvent));
        DateTime now = new(2026, 7, 15, 0, 0, 0, DateTimeKind.Utc);
        await db.Insertable(new[]
        {
            CreateRiskEvent("legacy-risk", now, pseudonymEpoch: 0),
            CreateRiskEvent("keyed-risk", now, pseudonymEpoch: 2)
        }).ExecuteCommandAsync();

        int deleted = await LogCleanupService.CleanupLegacySecurityRiskPseudonymsAsync(
            db,
            chunkSize: 1,
            maxChunks: 10,
            delayBetweenChunks: TimeSpan.Zero,
            CancellationToken.None);

        Assert.Equal(1, deleted);
        SecurityRiskEvent retained = Assert.Single(await db.Queryable<SecurityRiskEvent>().ToListAsync());
        Assert.Equal("keyed-risk", retained.Id);
        Assert.Equal(2, retained.PseudonymEpoch);
    }

    [Fact]
    public async Task CleanupLegacyVisitLogIpPseudonymsAsync_DeletesOnlyRowsWithoutKeyAndWindowMetadata()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(VisitLog));
        DateTime now = new(2026, 7, 15, 0, 0, 0, DateTimeKind.Utc);
        await db.Insertable(new[]
        {
            new VisitLog
            {
                IpHash = new string('a', 32),
                IpHashKeyEpoch = 0,
                IpHashWindowUtc = 0,
                Region = "test",
                CreateTime = now
            },
            new VisitLog
            {
                IpHash = new string('b', 32),
                IpHashKeyEpoch = 2,
                IpHashWindowUtc = 20260715,
                Region = "test",
                CreateTime = now
            }
        }).ExecuteCommandAsync();

        int deleted = await LogCleanupService.CleanupLegacyVisitLogIpPseudonymsAsync(
            db,
            chunkSize: 1,
            maxChunks: 10,
            delayBetweenChunks: TimeSpan.Zero,
            CancellationToken.None);

        Assert.Equal(1, deleted);
        VisitLog retained = Assert.Single(await db.Queryable<VisitLog>().ToListAsync());
        Assert.Equal(2, retained.IpHashKeyEpoch);
        Assert.Equal(20260715, retained.IpHashWindowUtc);
    }

    private static FrontendRumMetric CreateRum(string name, DateTime occurredAt)
        => new()
        {
            Name = name,
            PageType = "article",
            AotSource = "test",
            MetricsJson = "{}",
            OccurredAtUtc = occurredAt,
            CreatedAtUtc = occurredAt
        };

    private static AuditLog CreateAudit(string action, DateTime occurredAt, string severity, bool highValue)
        => new()
        {
            Source = "cleanup-test",
            Type = "retention",
            OccurredAtUtc = occurredAt,
            Action = action,
            Outcome = "success",
            Severity = severity,
            IsHighValue = highValue,
            EventInfo = action
        };

    private static AnonymousCredentialIssuanceAudit CreateAnonymousAudit(
        string subjectHash,
        long epoch,
        DateTime createdAt)
        => new()
        {
            SubjectHash = subjectHash,
            Epoch = epoch,
            CreatedAtUtc = createdAt
        };

    private static SecurityRiskEvent CreateRiskEvent(string id, DateTime occurredAt, int pseudonymEpoch)
        => new()
        {
            Id = id,
            OccurredAtUtc = occurredAt,
            Source = SecurityRiskSources.RiskControl,
            Reason = nameof(SecurityRiskReason.SecurityChallengeRejected),
            Action = "risk-test",
            ScoreDelta = 1,
            TotalScore = 1,
            TtlSeconds = 60,
            ExpiresAtUtc = occurredAt.AddMinutes(1),
            SubjectHash = new string(pseudonymEpoch == 0 ? 'a' : 'b', 64),
            PseudonymEpoch = pseudonymEpoch
        };
}
