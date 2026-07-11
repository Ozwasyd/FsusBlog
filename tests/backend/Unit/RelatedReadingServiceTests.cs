using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Services.Distribution;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Outputs;
using Microsoft.Extensions.Caching.Memory;
using NSubstitute;
using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class RelatedReadingServiceTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task BuildAsync_ColdReadIsBoundedAndMemoryHitExecutesNoDatabaseCommand()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(Category), typeof(Tag), typeof(Article), typeof(ArticleTag));
        DateTime publishedAt = DateTime.UtcNow.AddHours(-2);
        int categoryId = db.Insertable(new Category { Name = "Performance" }).ExecuteReturnIdentity();
        int tagId = db.Insertable(new Tag { Name = "cache" }).ExecuteReturnIdentity();
        int sourceId = InsertArticle(db, categoryId, "Source cache article", publishedAt);
        int candidateId = InsertArticle(db, categoryId, "Candidate cache article", publishedAt.AddMinutes(-10));
        db.Insertable([
            new ArticleTag { ArticleId = sourceId, TagId = tagId },
            new ArticleTag { ArticleId = candidateId, TagId = tagId }
        ]).ExecuteCommand();

        IUnifiedCache cache = Substitute.For<IUnifiedCache>();
        cache.GetStringAsync(
                CachePolicyId.ArticleListVersion,
                "main",
                Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<string?>("42"));
        cache.TryGetAsync(
                CachePolicyId.RelatedReading,
                Arg.Any<string>(),
                Arg.Any<Func<ReadOnlyMemory<byte>, (bool Success, RelatedReadingResponse? Value)>>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(new CacheReadResult<RelatedReadingResponse>(false, null)));
        cache.SetRawAsync(
                CachePolicyId.RelatedReading,
                Arg.Any<string>(),
                Arg.Any<byte[]>(),
                Arg.Any<TimeSpan?>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);

        using var memory = new MemoryCache(new MemoryCacheOptions());
        var commands = new List<string>();
        db.Aop.OnLogExecuting = (sql, _) => commands.Add(sql);
        var service = new RelatedReadingService(db, cache, memory);

        RelatedReadingResponse? cold = await service.BuildAsync(sourceId);
        Assert.NotNull(cold);
        Assert.Contains(cold.Related, item => item.Id == candidateId);
        Assert.InRange(commands.Count, 4, 5);
        Assert.DoesNotContain(commands, sql => sql.Contains("article_body", StringComparison.OrdinalIgnoreCase));

        int coldCommandCount = commands.Count;
        RelatedReadingResponse? hit = await service.BuildAsync(sourceId);
        Assert.Same(cold, hit);
        Assert.Equal(coldCommandCount, commands.Count);
    }

    [Fact]
    public void KeywordAndScoringPath_PreservesCategoryTagAndTimeReasons()
    {
        string[] keywords = RelatedReadingService.ExtractKeywords(
            "PostgreSQL cache concurrency",
            "notification stream performance");
        RelatedReadingBenchmarkResult result = RelatedReadingService.ScoreCandidateForBenchmark(
            7,
            DateTime.UnixEpoch.AddDays(100),
            [1, 2],
            7,
            DateTime.UnixEpoch.AddDays(95),
            [2, 3],
            "PostgreSQL cache performance",
            "notification stream",
            keywords);

        Assert.True(result.Score >= 100);
        Assert.Equal(5, result.PublishedDistance);
        Assert.Contains("同分类", result.Reason, StringComparison.Ordinal);
        Assert.Contains("共同标签", result.Reason, StringComparison.Ordinal);
        Assert.Contains("全文关键词", result.Reason, StringComparison.Ordinal);
        Assert.Contains("发布时间接近", result.Reason, StringComparison.Ordinal);
    }

    private static int InsertArticle(SqlSugarClient db, int categoryId, string title, DateTime publishedAt)
        => db.Insertable(new Article
        {
            Title = title,
            Summary = "cache notification PostgreSQL",
            CategoryId = categoryId,
            Views = 1,
            CreateTime = publishedAt,
            PublishedAt = publishedAt,
            ScheduledPublishAt = null,
            Status = ArticleStatus.Published,
            IsDeleted = false
        }).ExecuteReturnIdentity();
}
