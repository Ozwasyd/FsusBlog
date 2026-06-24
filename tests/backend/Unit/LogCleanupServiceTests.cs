using FsusBlog.Server.Entities;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Tests.TestInfrastructure;
using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollection))]
public sealed class LogCleanupServiceTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public void SourceUsesLeaderLeaseAndServerSideLimitDelete()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Background/LogCleanupService.cs");

        Assert.Contains("TryRunAsLeaderAsync(\"log-cleanup-worker\"", source, StringComparison.Ordinal);
        Assert.Contains("DELETE FROM sys_visit_log target", source, StringComparison.Ordinal);
        Assert.Contains("LIMIT @ChunkSize", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Queryable<VisitLogEntity>()", source, StringComparison.Ordinal);
        Assert.DoesNotContain(".In(ids)", source, StringComparison.Ordinal);
    }

    [Fact]
    public async Task CleanupVisitLogsAsync_ServerSideLimitDeletesAllExpiredRowsInPages()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(VisitLog));
        DateTime cutoff = new(2026, 6, 25, 0, 0, 0, DateTimeKind.Utc);
        await db.Insertable(new[]
        {
            new VisitLog { IpHash = "expired-1", Region = "test", CreateTime = cutoff.AddDays(-2) },
            new VisitLog { IpHash = "expired-2", Region = "test", CreateTime = cutoff.AddDays(-2) },
            new VisitLog { IpHash = "expired-3", Region = "test", CreateTime = cutoff.AddDays(-2) },
            new VisitLog { IpHash = "expired-4", Region = "test", CreateTime = cutoff.AddDays(-2) },
            new VisitLog { IpHash = "expired-5", Region = "test", CreateTime = cutoff.AddDays(-2) },
            new VisitLog { IpHash = "retained", Region = "test", CreateTime = cutoff }
        }).ExecuteCommandAsync();

        int deleted = await LogCleanupService.CleanupVisitLogsAsync(
            db,
            cutoff,
            chunkSize: 2,
            maxChunks: 10,
            delayBetweenChunks: TimeSpan.Zero,
            CancellationToken.None);

        Assert.Equal(5, deleted);
        VisitLog retained = Assert.Single(await db.Queryable<VisitLog>().ToListAsync());
        Assert.Equal("retained", retained.IpHash);
    }
}
