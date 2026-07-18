using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using SqlSugar;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Privacy;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Services;
using FsusBlog.Server.Tests.TestInfrastructure;
namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class StatsPerformanceContractTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task RecentCommentsAndRegions_EachExecuteOneNarrowCommandWithoutOverviewQueries()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(Comment));
        db.Ado.ExecuteCommand("""
            CREATE TABLE region_read_stats (
                region text NULL,
                read_count bigint NOT NULL,
                updated_at_utc timestamp without time zone NOT NULL
            );
            """);
        DateTime now = DateTime.UtcNow;
        db.Insertable(new[]
        {
            new Comment
            {
                Id = 1,
                ArticleId = 10,
                Content = "public measured comment",
                CreateTime = now.AddMinutes(-1),
                AuthorMode = CommentAuthorModes.Public,
                PublicHandle = "Public Query",
                UserId = 7001,
                ModerationStatus = CommentModerationStatus.Approved,
                IsDeleted = false
            },
            new Comment
            {
                Id = 2,
                ArticleId = 10,
                Content = "anonymous measured comment",
                CreateTime = now.AddMinutes(-2),
                AuthorMode = CommentAuthorModes.LegacyServerVisiblePseudonymous,
                AnonymousDisplayName = "Query Budget",
                AnonymousScope = "article:10",
                CredentialLevel = "basic",
                UserId = 7002,
                ModerationStatus = CommentModerationStatus.Approved,
                IsDeleted = false
            },
            new Comment
            {
                Id = 3,
                ArticleId = 10,
                Content = "zk measured comment",
                CreateTime = now.AddMinutes(-3),
                AuthorMode = CommentAuthorModes.ZkAnonymous,
                AnonymousDisplayName = "Verified Query",
                AnonymousScope = "article:10",
                CredentialLevel = "verified",
                UserId = 7003,
                ModerationStatus = CommentModerationStatus.Approved,
                IsDeleted = false
            }
        }).ExecuteCommand();
        db.Ado.ExecuteCommand(
            "INSERT INTO region_read_stats(region, read_count, updated_at_utc) VALUES (@Region, @Count, @Now);",
            new SugarParameter("@Region", "中国-北京"),
            new SugarParameter("@Count", 4L),
            new SugarParameter("@Now", now));

        var executedSql = new List<string>();
        db.Aop.OnLogExecuting = (sql, _) => executedSql.Add(sql);
        var service = new StatsService(
            db,
            Substitute.For<IUnifiedCache>(),
            Substitute.For<ICacheMissCoordinator>(),
            Substitute.For<IDbConcurrencyGate>(),
            new ReadAnalyticsPrivacyPolicy(
                new ConfigurationBuilder()
                    .AddInMemoryCollection(new Dictionary<string, string?>
                    {
                        [ReadAnalyticsPrivacyPolicy.NoiseKeySetting] = "QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8="
                    })
                    .Build(),
                TimeProvider.System),
            NullLogger<StatsService>.Instance);

        List<FsusBlog.Shared.Contracts.Outputs.RecentCommentStatItemDto> comments =
            await service.LoadRecentCommentsAsync(CancellationToken.None);
        Assert.Equal(3, comments.Count);
        FsusBlog.Shared.Contracts.Outputs.RecentCommentStatItemDto publicComment = comments[0];
        Assert.Equal("Public Query", publicComment.AuthorDisplayName);
        Assert.Equal(CommentAuthorModes.Public, publicComment.AuthorMode);
        Assert.Null(publicComment.AuthorBadge);
        Assert.Null(publicComment.AuthorScopeLabel);

        FsusBlog.Shared.Contracts.Outputs.RecentCommentStatItemDto anonymousComment = comments[1];
        Assert.Equal("Query Budget", anonymousComment.AuthorDisplayName);
        Assert.Equal(CommentAuthorModes.LegacyServerVisiblePseudonymous, anonymousComment.AuthorMode);
        Assert.Null(anonymousComment.AuthorBadge);
        Assert.Null(anonymousComment.AuthorScopeLabel);

        FsusBlog.Shared.Contracts.Outputs.RecentCommentStatItemDto zkComment = comments[2];
        Assert.Equal("Verified Query", zkComment.AuthorDisplayName);
        Assert.Equal(CommentAuthorModes.ZkAnonymous, zkComment.AuthorMode);
        Assert.Equal("已验证匿名资格", zkComment.AuthorBadge);
        Assert.Equal("article:10", zkComment.AuthorScopeLabel);
        Assert.DoesNotContain("CredentialLevel", typeof(FsusBlog.Shared.Contracts.Outputs.RecentCommentStatItemDto).GetProperties().Select(static property => property.Name));
        Assert.DoesNotContain(comments, static item =>
            item.AuthorDisplayName is "7001" or "7002" or "7003");
        Assert.Single(executedSql);
        Assert.Contains("comment", executedSql[0], StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("daily_read_stats", executedSql[0], StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("event_type_read_stats", executedSql[0], StringComparison.OrdinalIgnoreCase);

        executedSql.Clear();
        List<FsusBlog.Shared.Contracts.Outputs.RegionStatItemDto> regions =
            await service.LoadRegionStatsAsync(CancellationToken.None);
        Assert.Empty(regions);
        Assert.Single(executedSql);
        Assert.Contains("region_read_stats", executedSql[0], StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("daily_read_stats", executedSql[0], StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("event_type_read_stats", executedSql[0], StringComparison.OrdinalIgnoreCase);
    }

}
