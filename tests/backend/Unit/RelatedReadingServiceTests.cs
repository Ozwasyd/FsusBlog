using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Services.Distribution;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Outputs;

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
        InitRelatedReadingTables(db);
        DateTime publishedAt = DateTime.UtcNow.AddHours(-2);
        int categoryId = db.Insertable(new Category { Name = "Performance" }).ExecuteReturnIdentity();
        int tagId = db.Insertable(new Tag { Name = "cache" }).ExecuteReturnIdentity();
        int sourceId = InsertArticle(db, categoryId, "Source cache article", publishedAt);
        int candidateId = InsertArticle(db, categoryId, "Candidate cache article", publishedAt.AddMinutes(-10));
        db.Insertable(new[]
        {
            new ArticleTag { ArticleId = sourceId, TagId = tagId },
            new ArticleTag { ArticleId = candidateId, TagId = tagId }
        }).ExecuteCommand();

        IUnifiedCache cache = Substitute.For<IUnifiedCache>();
        cache.GetStringAsync(
                CachePolicyId.ArticleListVersion,
                "main",
                Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<string?>("42"));
        using var frameCache = new RecordingOwnedFrameCache();
        var commands = new List<string>();
        db.Aop.OnLogExecuting = (sql, _) => commands.Add(sql);
        var service = new RelatedReadingService(db, frameCache, new PassthroughCacheMissCoordinator(), cache, frameCache, new AedsEncoder());

        RelatedReadingResponse? cold = await service.BuildAsync(sourceId);
        Assert.NotNull(cold);
        Assert.Contains(cold.Related, item => item.Id == candidateId);
        Assert.All(cold.Related, item => Assert.Equal(DateTimeKind.Utc, item.CreateTime.Kind));
        Assert.Single(commands);
        Assert.DoesNotContain(commands, sql => sql.Contains("article_body", StringComparison.OrdinalIgnoreCase));

        int coldCommandCount = commands.Count;
        RelatedReadingResponse? hit = await service.BuildAsync(sourceId);
        Assert.NotNull(hit);
        Assert.Equal(cold.Related.ToArray(), hit.Related.ToArray());
        Assert.Equal(cold.Previous, hit.Previous);
        Assert.Equal(cold.Next, hit.Next);
        Assert.Equal(coldCommandCount, commands.Count);
        Assert.Equal(1, frameCache.PublishCount);
    }

    [Fact]
    public async Task BuildFrameAsync_MissingArticleUsesPolicyNegativeWhileEmptyRecommendationsRemainAFrame()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        InitRelatedReadingTables(db);
        IUnifiedCache versionCache = Substitute.For<IUnifiedCache>();
        versionCache.GetStringAsync(
                CachePolicyId.ArticleListVersion,
                "main",
                Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<string?>("57"));
        using var frameCache = new RecordingOwnedFrameCache();
        var commands = new List<string>();
        db.Aop.OnLogExecuting = (sql, _) => commands.Add(sql);
        var encoder = new AedsEncoder();
        var service = new RelatedReadingService(
            db,
            frameCache,
            new PassthroughCacheMissCoordinator(),
            versionCache,
            frameCache,
            encoder);

        using OwnedAedsFrameReadLease? missingCold = await service.BuildFrameAsync(int.MaxValue);
        using OwnedAedsFrameReadLease? missingHit = await service.BuildFrameAsync(int.MaxValue);

        Assert.Null(missingCold);
        Assert.Null(missingHit);
        Assert.Single(commands);
        Assert.Equal(1, frameCache.NegativePublishCount);

        int categoryId = db.Insertable(new Category { Name = $"empty-related-{Guid.CreateVersion7():N}" }).ExecuteReturnIdentity();
        int sourceId = InsertArticle(db, categoryId, "Only article in category", DateTime.UtcNow.AddHours(-1));
        commands.Clear();

        using OwnedAedsFrameReadLease? emptyFrame = await service.BuildFrameAsync(sourceId);

        Assert.NotNull(emptyFrame);
        var decodedFrame = encoder.TryDecode(emptyFrame.Memory);
        Assert.True(decodedFrame.IsSuccess, decodedFrame.Error.Message);
        Assert.Equal(AedsFrameType.ArticleRelatedReading, decodedFrame.Value.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeRelatedReading(decodedFrame.Value.Payload, out RelatedReadingResponse response));
        Assert.Empty(response.Related);
        Assert.Single(commands);
        Assert.Equal(1, frameCache.PublishCount);
    }

    [Fact]
    public void CacheIdentity_BindsPublicationRankingAndAedsSchemaVersions()
    {
        string identity = RelatedReadingService.BuildCacheIdentity(42, 987);

        Assert.Equal(
            $"article:42:publication:987:ranking:{RelatedReadingService.RankingAlgorithmVersion}:aeds-frame:{AedsFrameHeader.CurrentVersion}:aeds-schema:1",
            identity);
    }

    [Fact]
    public void RankingProjection_PreservesLegacyBusinessWeightsAndReasons()
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

        Assert.Equal(165, result.Score);
        Assert.Equal(5, result.PublishedDistance);
        Assert.Contains("同分类", result.Reason, StringComparison.Ordinal);
        Assert.Contains("共同标签", result.Reason, StringComparison.Ordinal);
        Assert.Contains("全文关键词", result.Reason, StringComparison.Ordinal);
        Assert.Contains("发布时间接近", result.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void ScoringPath_DeduplicatesTagsAndMatchesKeywordsWithoutCrossFieldConcatenation()
    {
        RelatedReadingBenchmarkResult result = RelatedReadingService.ScoreCandidateForBenchmark(
            1,
            DateTime.UnixEpoch.AddDays(10),
            [7],
            2,
            DateTime.UnixEpoch.AddDays(30),
            [7, 7],
            "POSTGRESQL runtime",
            "notification stream",
            ["postgresql", "stream"]);

        Assert.Equal(50, result.Score);
        Assert.Equal(20, result.PublishedDistance);
        Assert.Equal("共同标签 / 全文关键词", result.Reason);
    }

    private static void InitRelatedReadingTables(SqlSugarClient db)
        => PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(Category),
            typeof(Tag),
            typeof(Article),
            typeof(ArticleTag),
            typeof(ArticleRevision),
            typeof(ArticlePublicationRecord));

    private static int InsertArticle(SqlSugarClient db, int categoryId, string title, DateTime publishedAt)
    {
        int articleId = db.Insertable(new Article
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
        long revisionId = db.Insertable(new ArticleRevision
        {
            ArticleId = articleId,
            RevisionNo = 1,
            Title = title,
            Summary = "cache notification PostgreSQL",
            CategoryId = categoryId,
            TagIds = string.Empty,
            ContentBlockId = 0,
            CreatedByAdminPrincipalId = 1,
            CreatedAt = publishedAt
        }).ExecuteReturnBigIdentity();
        long publicationId = db.Insertable(new ArticlePublicationRecord
        {
            ArticleId = articleId,
            PublicationNo = 1,
            ArticleRevisionId = revisionId,
            RevisionNo = 1,
            RightsSnapshotId = 1,
            TransitionKind = "publish",
            PublishedAt = publishedAt,
            CreatedAt = publishedAt
        }).ExecuteReturnBigIdentity();
        db.Ado.ExecuteCommand(
            "UPDATE article SET current_revision_id = @RevisionId, current_publication_id = @PublicationId WHERE id = @ArticleId",
            new[]
            {
                new SugarParameter("@RevisionId", revisionId),
                new SugarParameter("@PublicationId", publicationId),
                new SugarParameter("@ArticleId", articleId)
            });
        return articleId;
    }

    private sealed class PassthroughCacheMissCoordinator : ICacheMissCoordinator
    {
        public async Task<T?> CoordinateAsync<T>(
            CachePolicyId policyId,
            string identity,
            Func<CancellationToken, Task<CacheReadResult<T>>> tryReadAsync,
            Func<CancellationToken, Task<T?>> rebuildAsync,
            string operation,
            CancellationToken cancellationToken = default,
            CacheRebuildStrategy? strategy = null)
        {
            CacheReadResult<T> cached = await tryReadAsync(cancellationToken);
            return cached.Hit ? cached.Value : await rebuildAsync(cancellationToken);
        }
    }

    private sealed class RecordingOwnedFrameCache : IOwnedFrameCache, ICacheRawWriter, IDisposable
    {
        private OwnedAedsFrame? _frame;
        private string? _frameIdentity;
        private string? _negativeIdentity;

        public int PublishCount
        {
            get;
            private set;
        }

        public int NegativePublishCount
        {
            get;
            private set;
        }

        public Task<OwnedFrameCacheReadResult> TryGetOwnedFrameAsync(
            CachePolicyId policyId,
            string identity,
            AedsFrameType expectedFrameType,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (string.Equals(identity, _frameIdentity, StringComparison.Ordinal)
                && _frame is not null
                && _frame.TryAcquireReadLease(out OwnedAedsFrameReadLease? lease))
            {
                return Task.FromResult(new OwnedFrameCacheReadResult(true, lease));
            }

            return Task.FromResult(string.Equals(identity, _negativeIdentity, StringComparison.Ordinal)
                ? OwnedFrameCacheReadResult.NegativeHit
                : default);
        }

        public Task SetOwnedFrameAsync(
            CachePolicyId policyId,
            string identity,
            OwnedAedsFrame frame,
            TimeSpan? l2TtlOverride = null,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            _frame?.Retire();
            _frame = frame;
            _frameIdentity = identity;
            _negativeIdentity = null;
            PublishCount++;
            return Task.CompletedTask;
        }

        public Task SetRawAsync(
            CachePolicyId policyId,
            string identity,
            byte[] value,
            TimeSpan? l2TtlOverride = null,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task SetNegativeAsync(
            CachePolicyId policyId,
            string identity,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (string.Equals(identity, _frameIdentity, StringComparison.Ordinal))
            {
                _frame?.Retire();
                _frame = null;
                _frameIdentity = null;
            }
            _negativeIdentity = identity;
            NegativePublishCount++;
            return Task.CompletedTask;
        }

        public OwnedFrameCacheResidencySnapshot GetOwnedFrameResidencySnapshot() => default;

        public void Dispose() => _frame?.Retire();
    }
}
