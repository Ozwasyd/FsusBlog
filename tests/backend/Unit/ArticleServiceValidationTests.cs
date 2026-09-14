using System.Reflection;

using FsusBlog.Core.Services.Articles;
using FsusBlog.Core.Services.Gateways;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;

using StackExchange.Redis;
namespace FsusBlog.Server.Tests.Unit;

/// <summary>
/// Tests ArticleService validation paths and early returns that don't require DB/Redis.
/// </summary>
public class ArticleServiceValidationTests
{
    private static string ArticleRuntime(params string[] methodNames)
        => RuntimeMetadataInspection.DescribeMethods(typeof(ArticleService), methodNames);

    private static ArticleService BuildService()
    {
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(Substitute.For<IDatabase>());

        return new ArticleService(
            _db: Substitute.For<ISqlSugarClient>(),
            _searchIndex: Substitute.For<ISearchIndexService>(),
            _redisOperations: RedisOperationExecutor.ForTestConnection(redis),
            _cacheReader: Substitute.For<ICacheTypedReader>(),
            _cacheWriter: Substitute.For<ICacheRawWriter>(),
            _stringReader: Substitute.For<ICacheStringReader>(),
            _stringWriter: Substitute.For<ICacheStringWriter>(),
            _cacheMissCoordinator: Substitute.For<ICacheMissCoordinator>(),
            _dbConcurrencyGate: Substitute.For<IDbConcurrencyGate>(),
            _runtimeKeyScope: Substitute.For<IRuntimeKeyScope>(),
            _httpContextAccessor: Substitute.For<IHttpContextAccessor>(),
            _logger: NullLogger<ArticleService>.Instance,
            _publicAotInvalidationService: Substitute.For<IPublicAotInvalidationService>(),
            _cacheInvalidationDispatcher: Substitute.For<ICacheInvalidationDispatcher>(),
            _mutationFence: Substitute.For<IArticlePublicMutationFence>(),
            _mutationSideEffects: Substitute.For<IArticleMutationSideEffectCoordinator>(),
            _viewWriteBuffer: Substitute.For<IArticleViewWriteBuffer>(),
            _publicationValidator: ArticlePublicationValidatorTestFactory.CreateAllowing(),
            _articleBodyRepairQueue: new ArticleBodyRepairQueue());
    }

    // ─── SearchArticlesAsync guard ────────────────────────────────────────────

    [Fact]
    public async Task SearchArticlesAsync_NullKeyword_ReturnsEmpty()
    {
        var svc = BuildService();
        var result = await svc.SearchArticlesAsync(null!);
        Assert.Empty(result);
    }

    [Fact]
    public async Task SearchArticlesAsync_EmptyKeyword_ReturnsEmpty()
    {
        var svc = BuildService();
        var result = await svc.SearchArticlesAsync(string.Empty);
        Assert.Empty(result);
    }

    [Theory]
    [InlineData("spaces", "   ")]
    [InlineData("tab-newline-cr", "\t\n\r")]
    public async Task SearchArticlesAsync_WhitespaceOnlyKeyword_ReturnsEmpty(
        string caseName,
        string keyword)
    {
        Assert.True(caseName is "spaces" or "tab-newline-cr");

        var db = Substitute.For<ISqlSugarClient>();
        var searchIndex = Substitute.For<ISearchIndexService>();
        var redis = Substitute.For<IDatabase>();
        var redisConnection = Substitute.For<IConnectionMultiplexer>();
        redisConnection.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(redis);
        var cacheReader = Substitute.For<ICacheTypedReader>();
        var cacheWriter = Substitute.For<ICacheRawWriter>();
        var stringReader = Substitute.For<ICacheStringReader>();
        var stringWriter = Substitute.For<ICacheStringWriter>();
        var cacheMissCoordinator = Substitute.For<ICacheMissCoordinator>();
        var dbConcurrencyGate = Substitute.For<IDbConcurrencyGate>();
        var svc = new ArticleService(
            _db: db,
            _searchIndex: searchIndex,
            _redisOperations: RedisOperationExecutor.ForTestConnection(redisConnection),
            _cacheReader: cacheReader,
            _cacheWriter: cacheWriter,
            _stringReader: stringReader,
            _stringWriter: stringWriter,
            _cacheMissCoordinator: cacheMissCoordinator,
            _dbConcurrencyGate: dbConcurrencyGate,
            _runtimeKeyScope: Substitute.For<IRuntimeKeyScope>(),
            _httpContextAccessor: Substitute.For<IHttpContextAccessor>(),
            _logger: NullLogger<ArticleService>.Instance,
            _publicAotInvalidationService: Substitute.For<IPublicAotInvalidationService>(),
            _cacheInvalidationDispatcher: Substitute.For<ICacheInvalidationDispatcher>(),
            _mutationFence: Substitute.For<IArticlePublicMutationFence>(),
            _mutationSideEffects: Substitute.For<IArticleMutationSideEffectCoordinator>(),
            _viewWriteBuffer: Substitute.For<IArticleViewWriteBuffer>(),
            _publicationValidator: Substitute.For<IArticlePublicationValidator>(),
            _articleBodyRepairQueue: new ArticleBodyRepairQueue());
        redisConnection.ClearReceivedCalls();

        var result = await svc.SearchArticlesAsync(keyword);

        Assert.Empty(result);
        Assert.Empty(db.ReceivedCalls());
        Assert.Empty(searchIndex.ReceivedCalls());
        Assert.Empty(redis.ReceivedCalls());
        Assert.Empty(redisConnection.ReceivedCalls());
        Assert.Empty(cacheReader.ReceivedCalls());
        Assert.Empty(cacheWriter.ReceivedCalls());
        Assert.Empty(stringReader.ReceivedCalls());
        Assert.Empty(stringWriter.ReceivedCalls());
        Assert.Empty(cacheMissCoordinator.ReceivedCalls());
        Assert.Empty(dbConcurrencyGate.ReceivedCalls());
    }

    [Fact]
    public void SearchArticlesAsync_RuntimeUsesVersionedNormalizedCacheIdentity()
    {
        string method = ArticleRuntime(
            nameof(ArticleService.SearchArticlesAsync),
            "NormalizeSearchKeyword",
            "GetSearchCacheVersionAsync",
            "BuildArticleSearchIdentity");

        Assert.Contains("NormalizeSearchKeyword", method, StringComparison.Ordinal);
        Assert.Contains("GetSearchCacheVersionAsync", method, StringComparison.Ordinal);
        Assert.Contains("BuildArticleSearchIdentity", method, StringComparison.Ordinal);
        Assert.DoesNotContain("keyword:", method, StringComparison.Ordinal);
    }

    [Fact]
    public void SearchArticlesAsync_RuntimeBypassesLongLivedCacheForLowValueKeywords()
    {
        string method = ArticleRuntime(
            nameof(ArticleService.SearchArticlesAsync),
            "ShouldCacheSearchKeyword",
            "LoadSearchArticlesFromSourceAsync");

        Assert.Contains("ShouldCacheSearchKeyword", method, StringComparison.Ordinal);
        Assert.Contains("LoadSearchArticlesFromSourceAsync", method, StringComparison.Ordinal);
        Assert.Contains("FsusObservability.RecordCacheOperation", method, StringComparison.Ordinal);
    }

    [Fact]
    public void UpdateAsync_RuntimeChecksAffectedRowsBeforeDependentWrites()
    {
        string method = ArticleRuntime(
            nameof(ArticleService.UpdateAsync),
            "TryUpdateArticleRowAsync",
            "SaveArticleRevisionAsync");
        Assert.Contains("TryUpdateArticleRowAsync", method, StringComparison.Ordinal);
        Assert.Contains("UpsertArticleBodyAsync", method, StringComparison.Ordinal);
        Assert.Contains("SaveArticleRevisionAsync", method, StringComparison.Ordinal);
        Assert.Contains("get_IsSuccess", method, StringComparison.Ordinal);
    }

    [Fact]
    public void UpdateAsync_BodyUpsertOnlyAdvancesTimestampForDistinctMarkdown()
    {
        string method = ArticleRuntime(
            "UpsertArticleBodyAsync",
            "TryUpdateArticleRowAsync");

        Assert.Contains("IS DISTINCT FROM", method, StringComparison.Ordinal);
        Assert.Contains("updated_at", method, StringComparison.Ordinal);
    }

    [Fact]
    public async Task GetPageListAsync_RuntimeRejectsInvalidPaginationWithoutSilentCoercion()
    {
        ArticleService service = BuildService();
        var gateway = (IArticleCoreGateway)service;
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => gateway.GetPageListAsync(
            new ArticlePageQuery(0, 10, null, null, false)));
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => gateway.GetPageListAsync(
            new ArticlePageQuery(1, 0, null, null, false)));
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => gateway.GetPageListAsync(
            new ArticlePageQuery(1, 101, null, null, false)));
    }

    [Fact]
    public async Task GetPageListAsync_RuntimeRejectsInvalidPublicPageCursorShapeBeforePorts()
    {
        ArticleService service = BuildService();
        var gateway = (IArticleCoreGateway)service;
        var cursor = new ArticleListCursorPosition(
            new DateTime(2026, 7, 20, 8, 0, 0, DateTimeKind.Utc),
            42);

        await Assert.ThrowsAsync<ArgumentException>(() => gateway.GetPageListAsync(
            new ArticlePageQuery(2, 10, null, null, false)));
        await Assert.ThrowsAsync<ArgumentException>(() => gateway.GetPageListAsync(
            new ArticlePageQuery(1, 10, null, null, false, Cursor: cursor)));
    }

    [Fact]
    public void DeleteAndRestore_RuntimeInvalidatePublicAotWithCurrentStateAfterMutation()
    {
        string deleteBlock = ArticleRuntime(nameof(ArticleService.DeleteAsync));
        string restoreBlock = ArticleRuntime(nameof(ArticleService.RestoreAsync));

        Assert.Contains("LoadArticleMutationStateAsync", deleteBlock, StringComparison.Ordinal);
        Assert.Contains("xmin::text = @RowVersion", deleteBlock, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("InvalidatePublicAotAsync", deleteBlock, StringComparison.Ordinal);
        Assert.Contains("delete", deleteBlock, StringComparison.Ordinal);

        Assert.Contains("LoadArticleMutationStateAsync", restoreBlock, StringComparison.Ordinal);
        Assert.Contains("xmin::text = @RowVersion", restoreBlock, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("InvalidatePublicAotAsync", restoreBlock, StringComparison.Ordinal);
        Assert.Contains("restore", restoreBlock, StringComparison.Ordinal);
    }

    [Fact]
    public void ArticleService_RuntimeInvalidatesPublicAotCategoryAndTagUnions()
    {
        string method = ArticleRuntime(
            "InvalidatePublicAotWithCurrentStateAsync",
            "LoadArticleAotStateAsync",
            "MergeIds");

        Assert.Contains("LoadArticleAotStateAsync", method, StringComparison.Ordinal);
        Assert.True(method.Split("MergeIds", StringSplitOptions.None).Length - 1 >= 2);
        Assert.Contains("InvalidatePublicAotAsync", method, StringComparison.Ordinal);
    }

    [Fact]
    public void ArticleService_RuntimeDoesNotQueryLegacyArticleContentColumn()
    {
        string runtimeShape = RuntimeMetadataInspection.DescribeType(typeof(ArticleService));

        Assert.Contains("LEFT JOIN article_body ab ON ab.article_id = a.id", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("article_revision_content_block published_block", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("published_block.markdown_content", runtimeShape, StringComparison.Ordinal);
        Assert.DoesNotContain("legacyArticleContent", runtimeShape, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("a.content", runtimeShape, StringComparison.Ordinal);
    }

    [Fact]
    public void IncreaseViewCountAsync_RuntimeEnqueuesViewsWithoutSynchronousDbRedisOrDetailInvalidation()
    {
        string method = ArticleRuntime(nameof(ArticleService.IncreaseViewCountAsync));

        Assert.Contains("IArticleViewWriteBuffer.EnqueueAsync", method, StringComparison.Ordinal);
        Assert.DoesNotContain("TryIncreaseArticleViewsAsync", method, StringComparison.Ordinal);
        Assert.DoesNotContain("SortedSetAddAsync", method, StringComparison.Ordinal);
        Assert.DoesNotContain("SortedSetIncrementAsync", method, StringComparison.Ordinal);
        Assert.DoesNotContain("RemoveAsync(CachePolicyId.ArticleDetail", method, StringComparison.Ordinal);
    }

    [Fact]
    public void GetByIdAsync_RuntimeCoordinatesPublicArticleDetailCacheMiss()
    {
        string method = ArticleRuntime(
            nameof(ArticleService.GetByIdAsync),
            "TryReadArticleDetailCacheAsync",
            "LoadArticleDetailFromDbAsync");

        Assert.Contains("ICacheMissCoordinator.CoordinateAsync", method, StringComparison.Ordinal);
        Assert.Contains("IDbConcurrencyGate.ExecuteAsync", method, StringComparison.Ordinal);
        Assert.Contains("TryReadArticleDetailCacheAsync", method, StringComparison.Ordinal);
        Assert.Contains("LoadArticleDetailFromDbAsync", method, StringComparison.Ordinal);
        Assert.Contains("article-detail", method, StringComparison.Ordinal);
        Assert.Contains("db-gate-timeout:article-detail", method, StringComparison.Ordinal);
        Assert.Contains("ICacheTypedReader.TryGetAsync", method, StringComparison.Ordinal);
        Assert.Contains("ICacheRawWriter.SetRawAsync", method, StringComparison.Ordinal);
        Assert.DoesNotContain("System.Int32.ToString", method, StringComparison.Ordinal);
        Assert.DoesNotContain("compat", method, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void LoadArticleDetailFromDbAsync_RuntimeUsesSingleSqlForMetadataContentAndTags()
    {
        string method = ArticleRuntime("LoadArticleDetailFromDbAsync", "ReadArticleDetailTags");

        Assert.Contains("LEFT JOIN article_body ab ON ab.article_id = a.id", method, StringComparison.Ordinal);
        Assert.Contains("LEFT JOIN article_revision_content_block published_block", method, StringComparison.Ordinal);
        Assert.Contains("ELSE published_block.markdown_content", method, StringComparison.Ordinal);
        Assert.DoesNotContain("COALESCE(published_block.markdown_content, published_revision.markdown_content", method, StringComparison.Ordinal);
        Assert.Contains("array_agg(t.id ORDER BY t.id)", method, StringComparison.Ordinal);
        Assert.Contains("array_agg(t.name ORDER BY t.id)", method, StringComparison.Ordinal);
        Assert.Contains("ReadArticleDetailTags", method, StringComparison.Ordinal);
        Assert.DoesNotContain("LoadArticleContentAsync(id", method, StringComparison.Ordinal);
        Assert.DoesNotContain("LoadArticleTagsAsync(id", method, StringComparison.Ordinal);
    }

    [Fact]
    public void TryReadArticleDetailCacheAsync_EmptyContentHitNeverFallsBackToDatabase()
    {
        string method = ArticleRuntime("TryReadArticleDetailCacheAsync", "ProjectArticleViews");

        Assert.Contains("ICacheTypedReader.TryGetAsync", method, StringComparison.Ordinal);
        Assert.Contains("ProjectArticleViews", method, StringComparison.Ordinal);
        Assert.DoesNotContain("LoadArticleContentAsync", method, StringComparison.Ordinal);
    }

    [Fact]
    public void LoadArticleDetailFromDbAsync_RuntimeLoadsRightsSnapshotAndProofInSingleSql()
    {
        string method = ArticleRuntime("LoadArticleDetailFromDbAsync", "ReadArticleRights");

        Assert.Contains("LEFT JOIN LATERAL", method, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("article_rights_snapshot", method, StringComparison.Ordinal);
        Assert.Contains("article_rights_proof", method, StringComparison.Ordinal);
        Assert.Contains("ReadArticleRights", method, StringComparison.Ordinal);
        Assert.DoesNotContain("LoadArticleRightsAsync", method, StringComparison.Ordinal);
    }

    [Fact]
    public void LoadArticleDetailFromDbAsync_RuntimeNormalizesDbTimestampsBeforeServerCacheEncoding()
    {
        string method = ArticleRuntime(
            "LoadArticleDetailFromDbAsync",
            "NormalizeArticleListTimestampUtc");

        Assert.True(method.Split("NormalizeArticleListTimestampUtc", StringSplitOptions.None).Length - 1 >= 3);
        Assert.Contains("ServerCacheBinaryCodec.EncodeArticleDetail", method, StringComparison.Ordinal);
    }

    [Fact]
    public void ArticleDetailAedsArtifactProjector_RuntimeUsesSingleSqlForDetailArtifactBackfill()
    {
        string method = RuntimeMetadataInspection.DescribeMethods(
            typeof(ArticleDetailAedsArtifactProjector),
            "LoadArticleDetailFromDbAsync");

        Assert.Contains("JOIN article_publication publication ON publication.id = a.current_publication_id", method, StringComparison.Ordinal);
        Assert.Contains("JOIN article_revision revision ON revision.id = publication.article_revision_id", method, StringComparison.Ordinal);
        Assert.Contains("array_agg(t.id ORDER BY t.id)", method, StringComparison.Ordinal);
        Assert.Contains("array_agg(t.name ORDER BY t.id)", method, StringComparison.Ordinal);
        Assert.Contains("COALESCE(revision.markdown_content, '')", method, StringComparison.Ordinal);
        Assert.DoesNotContain("LoadArticleContentAsync(id", method, StringComparison.Ordinal);
        Assert.DoesNotContain("LoadArticleTagMapAsync([id]", method, StringComparison.Ordinal);
    }

    [Fact]
    public void ArticleDetailAedsArtifactProjector_RuntimeLoadsRightsSnapshotAndProofInSingleSql()
    {
        string method = RuntimeMetadataInspection.DescribeMethods(
            typeof(ArticleDetailAedsArtifactProjector),
            "LoadArticleDetailFromDbAsync",
            "ReadArticleRights");

        Assert.Contains("LEFT JOIN LATERAL", method, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("article_rights_snapshot", method, StringComparison.Ordinal);
        Assert.Contains("article_rights_proof", method, StringComparison.Ordinal);
        Assert.Contains("ReadArticleRights", method, StringComparison.Ordinal);
        Assert.DoesNotContain("LoadArticleRightsAsync", method, StringComparison.Ordinal);
    }

    [Fact]
    public void ArticleDetailAedsArtifactProjector_RuntimeDoesNotWriteArtifactWithoutCompleteRights()
    {
        string method = RuntimeMetadataInspection.DescribeMethods(
            typeof(ArticleDetailAedsArtifactProjector),
            nameof(ArticleDetailAedsArtifactProjector.GenerateAndStoreAsync),
            "HasCompleteArticleRights");

        Assert.Contains("HasCompleteArticleRights", method, StringComparison.Ordinal);
        Assert.Contains("article_detail_aeds_rights_missing", method, StringComparison.Ordinal);
        Assert.Contains("IArticleDetailAedsArtifactStore.RemoveAsync", method, StringComparison.Ordinal);
        Assert.Contains("InvalidOperationException", method, StringComparison.Ordinal);
        Assert.Contains("PodBinaryCodec.WriteArticleDetail", method, StringComparison.Ordinal);
    }

    [Fact]
    public void PublicHotArtifactProjector_RuntimeLoadsRightsSnapshotForArticleDetailFrames()
    {
        IReadOnlyList<string> rightsLoaderCallers = RuntimeMetadataInspection.FindMethodsCallingMember(
            typeof(PublicHotArtifactProjector),
            static member => member.DeclaringType == typeof(PublicHotArtifactProjector)
                && member.Name == "LoadArticleRightsMapAsync");
        Assert.Contains(rightsLoaderCallers,
            static caller => caller.Contains("<LoadArticleDetailsFromDbAsync>", StringComparison.Ordinal));
        IReadOnlyList<string> rightsSetterCallers = RuntimeMetadataInspection.FindMethodsCallingMember(
            typeof(PublicHotArtifactProjector),
            static member => member.Name == "set_Rights");
        Assert.Contains(rightsSetterCallers,
            static caller => caller.Contains("<LoadArticleDetailsFromDbAsync>", StringComparison.Ordinal));
    }

    [Fact]
    public void PublicHotArtifactProjector_RuntimeSkipsArticleDetailFramesWithoutCompleteRights()
    {
        string method = RuntimeMetadataInspection.DescribeMethods(
            typeof(PublicHotArtifactProjector),
            "LoadArticleDetailsFromDbAsync",
            "HasCompleteArticleRights");

        Assert.Contains("HasCompleteArticleRights", method, StringComparison.Ordinal);
        Assert.Contains("public_hot_article_detail_rights_missing", method, StringComparison.Ordinal);
        Assert.DoesNotContain("get_Rights set_Rights", method, StringComparison.Ordinal);
    }

    [Fact]
    public void UpdateAsync_RuntimeUsesRowVersionGuardAndAtomicTagSetRewrite()
    {
        Assert.Equal(typeof(string), typeof(Article).GetProperty("RowVersion")!.PropertyType);
        string runtimeShape = ArticleRuntime(
            nameof(ArticleService.UpdateAsync),
            "LoadArticleUpdateStateAsync",
            "TryUpdateArticleRowAsync",
            "ApplyArticleTagsAsync");

        Assert.Contains("LoadArticleUpdateStateAsync", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("TryUpdateArticleRowAsync", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("ApplyArticleTagsAsync", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("xmin::text AS row_version", runtimeShape, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("AND xmin::text = @RowVersion", runtimeShape, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("AND isdeleted = false", runtimeShape, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("WITH desired_tags", runtimeShape, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("ON CONFLICT (articleid, tagid) DO NOTHING", runtimeShape, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("DELETE FROM article_tag", runtimeShape, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Deleteable", runtimeShape, StringComparison.Ordinal);
    }

    [Fact]
    public void ArticleMutations_RuntimeRecordsTransactionalOutboxEvents()
    {
        string runtimeShape = ArticleRuntime(
            nameof(ArticleService.CreateAsync),
            nameof(ArticleService.UpdateAsync),
            nameof(ArticleService.DeleteAsync),
            nameof(ArticleService.RestoreAsync),
            nameof(ArticleService.PermanentlyDeleteArticleAsync),
            nameof(ArticleService.ClearTrashAsync),
            "RecordArticleMutationOutboxAsync");

        foreach (string eventKind in new[]
        {
            "created", "updated", "deleted", "restored", "permanently-deleted", "trash-cleared"
        })
        {
            Assert.Contains(eventKind, runtimeShape, StringComparison.Ordinal);
        }
        Assert.True(runtimeShape.Split("RecordArticleMutationOutboxAsync", StringSplitOptions.None).Length - 1 >= 6);
    }

    [Fact]
    public void ClearTrashAsync_RuntimeLocksAndRechecksDeletedRowsInsideTransaction()
    {
        string method = ArticleRuntime(
            nameof(ArticleService.ClearTrashAsync),
            "LoadTrashArticlesForUpdateAsync");

        Assert.Contains("UseTranAsync", method, StringComparison.Ordinal);
        Assert.Contains("LoadTrashArticlesForUpdateAsync", method, StringComparison.Ordinal);
        Assert.Contains("FOR UPDATE", method, StringComparison.Ordinal);
        Assert.Contains("WHERE isdeleted = true", method, StringComparison.Ordinal);
        Assert.Contains("ArticleDeletionKernel.DeleteLockedAsync", method, StringComparison.Ordinal);
    }

    [Fact]
    public void PermanentDeleteAndClearTrash_RuntimeReuseOneDeletionKernel()
    {
        string method = ArticleRuntime(
            nameof(ArticleService.PermanentlyDeleteArticleAsync),
            nameof(ArticleService.ClearTrashAsync));

        Assert.Equal(
            2,
            method.Split("ArticleDeletionKernel.DeleteLockedAsync", StringSplitOptions.None).Length - 1);
        Assert.DoesNotContain("Deleteable<Comment>", method, StringComparison.Ordinal);
        Assert.DoesNotContain("Deleteable<ArticleBody>", method, StringComparison.Ordinal);
    }

    [Fact]
    public void SaveArticleRevisionAsync_RuntimeLocksArticleRowAndDefinesUniqueRevisionIndex()
    {
        string runtimeShape = ArticleRuntime("SaveArticleRevisionAsync");
        Assert.Contains("FOR UPDATE", runtimeShape, StringComparison.Ordinal);
        Assert.Contains(
            typeof(ArticleRevision).GetCustomAttributes<SugarIndexAttribute>(),
            static index => index.IndexName == "ux_article_revision_article_revision_no");

        ISchemaMigrationDescriptor migration = Assert.Single(
            new SchemaMigrationRegistry().GetDescriptors(),
            static descriptor => descriptor.MigrationId == "20260625-post-article-revision-atomic-revision-no");
        string fingerprint = string.Join('\n', migration.Steps.Select(static step => step.Fingerprint));
        Assert.Contains("ux_article_revision_article_revision_no", fingerprint, StringComparison.Ordinal);
        Assert.Contains("ON article_revision(article_id, revision_no)", fingerprint, StringComparison.Ordinal);
    }

    [Fact]
    public void SaveArticleRevisionAsync_RuntimeAllocatesRevisionNoAtomicallyAndRejectsDeletedArticle()
    {
        string method = ArticleRuntime("SaveArticleRevisionAsync");

        Assert.Contains("xmin", method, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("isdeleted = false", method, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("FOR UPDATE", method, StringComparison.Ordinal);
        Assert.Contains("pg_advisory_xact_lock", method, StringComparison.Ordinal);
        Assert.DoesNotContain("LOCK TABLE article_revision", method, StringComparison.Ordinal);
        Assert.Contains("INSERT INTO article_revision", method, StringComparison.Ordinal);
        Assert.Contains("SELECT MAX(revision_no)", method, StringComparison.Ordinal);
        Assert.Contains("WHERE article_id = @articleId", method, StringComparison.Ordinal);
        Assert.Contains("ON CONFLICT (article_id, revision_no) DO NOTHING", method, StringComparison.Ordinal);
        Assert.Contains("retrying bounded attempt", method, StringComparison.Ordinal);
        Assert.Contains("Article revision conflict retry limit exceeded", method, StringComparison.Ordinal);
        Assert.DoesNotContain("MaxAsync", method, StringComparison.Ordinal);
        Assert.DoesNotContain("Math.Max", method, StringComparison.Ordinal);
    }

    [Fact]
    public void SaveArticleRevisionAsync_RuntimeUsesAdminPrincipalActor()
    {
        string method = ArticleRuntime("SaveArticleRevisionAsync", "ResolveRevisionAdminPrincipalId");

        Assert.Contains("ResolveRevisionAdminPrincipalId", method, StringComparison.Ordinal);
        Assert.Contains("created_by_admin_principal_id", method, StringComparison.Ordinal);
        Assert.Contains("@createdByAdminPrincipalId", method, StringComparison.Ordinal);
        Assert.DoesNotContain("GetUserId", method, StringComparison.Ordinal);
        Assert.DoesNotContain("CreatedByUserId", method, StringComparison.Ordinal);
    }

    [Fact]
    public void IncreaseViewCountsAsync_RuntimeUsesSingleValuesUpdateAndRedisBatchWithoutDetailInvalidation()
    {
        string method = ArticleRuntime(nameof(ArticleService.IncreaseViewCountsAsync));

        Assert.Contains("FROM (VALUES", method, StringComparison.Ordinal);
        Assert.Contains("RETURNING a.id, a.views", method, StringComparison.Ordinal);
        Assert.Contains("CreateBatch", method, StringComparison.Ordinal);
        Assert.Contains("SortedSetAddAsync", method, StringComparison.Ordinal);
        Assert.DoesNotContain("CachePolicyId.ArticleDetail", method, StringComparison.Ordinal);
    }

    [Fact]
    public void GetByIdAsync_RuntimeProjectsViewsLocallyWithoutRedisOverlay()
    {
        string runtimeShape = ArticleRuntime(
            nameof(ArticleService.GetByIdAsync),
            "TryReadArticleDetailCacheAsync",
            "ProjectArticleViews");

        Assert.Contains("ProjectArticleViews", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("IArticleDetailViewProjection.Project", runtimeShape, StringComparison.Ordinal);
        Assert.DoesNotContain("OverlayProjectedViewsAsync", runtimeShape, StringComparison.Ordinal);
        Assert.DoesNotContain("SortedSetScoreAsync", runtimeShape, StringComparison.Ordinal);
    }

    [Fact]
    public void RuntimeDomainServices_RegisterArticleViewBufferAndWorker()
    {
        var services = new ServiceCollection();
        services.AddFsusRuntimeDomainServices();
        ServiceDescriptor buffer = Assert.Single(services, static descriptor =>
            descriptor.ServiceType == typeof(IArticleViewWriteBuffer));
        ServiceDescriptor sink = Assert.Single(services, static descriptor =>
            descriptor.ServiceType == typeof(IArticleViewFlushSink));
        ServiceDescriptor worker = Assert.Single(services, static descriptor =>
            descriptor.ServiceType == typeof(IHostedService)
                && descriptor.ImplementationType == typeof(ArticleViewFlushWorker));
        Assert.Equal(ServiceLifetime.Singleton, buffer.Lifetime);
        Assert.Equal(typeof(ArticleViewWriteBuffer), buffer.ImplementationType);
        Assert.Equal(ServiceLifetime.Scoped, sink.Lifetime);
        Assert.Equal(typeof(ArticleServiceViewFlushSink), sink.ImplementationType);
        Assert.Equal(ServiceLifetime.Singleton, worker.Lifetime);
    }

    [Fact]
    public void ArticleViewFlushSink_RuntimeMarksHotStatsAndPublicHotDirtyAfterFlush()
    {
        string method = RuntimeMetadataInspection.DescribeMethods(
            typeof(ArticleServiceViewFlushSink),
            nameof(ArticleServiceViewFlushSink.FlushArticleViewsAsync));

        Assert.Contains("IncreaseViewCountsAsync", method, StringComparison.Ordinal);
        Assert.Contains("MarkStatsDirtyAsync", method, StringComparison.Ordinal);
        Assert.Contains("MarkHotArticlesDirtyAsync", method, StringComparison.Ordinal);
        Assert.Contains("GetEnumerator", method, StringComparison.Ordinal);
        Assert.Contains("EnqueueAsync", method, StringComparison.Ordinal);
        Assert.Contains("RequireDurable", method, StringComparison.Ordinal);
        Assert.Contains("article-view-projection-buffer-flush", method, StringComparison.Ordinal);
    }

    [Fact]
    public void ArticleViewInvalidation_RuntimeDoesNotRemoveArticleDetailContentCache()
    {
        string method = RuntimeMetadataInspection.DescribeMethods(
            typeof(CacheInvalidationDispatcher),
            nameof(CacheInvalidationDispatcher.InvalidateArticleViewAsync));

        Assert.Contains("RecordRuntimeAsync", method, StringComparison.Ordinal);
        Assert.Contains("article_view", method, StringComparison.Ordinal);
        Assert.DoesNotContain("CachePolicyId.ArticleDetail", method, StringComparison.Ordinal);
        Assert.DoesNotContain("CachePolicyId.ArticleDetailFrame", method, StringComparison.Ordinal);
    }

    [Fact]
    public void LoadArticleListPageFromDbAsync_RuntimeUsesKeysetForPublicPagination()
    {
        string methodBlock = ArticleRuntime(
            "LoadArticleListPageFromDbAsync",
            "ShouldUsePublicKeysetPagination",
            "LoadPublicArticleListPageByKeysetAsync");
        string cursorClause = (string)typeof(ArticleService)
            .GetField("ArticleListCursorWhereClause", BindingFlags.Static | BindingFlags.NonPublic)!
            .GetRawConstantValue()!;
        string totalCountColumn = (string)typeof(ArticleService)
            .GetField("ArticleListTotalCountColumn", BindingFlags.Static | BindingFlags.NonPublic)!
            .GetRawConstantValue()!;

        Assert.Contains("ShouldUsePublicKeysetPagination", methodBlock, StringComparison.Ordinal);
        Assert.Contains("LoadPublicArticleListPageByKeysetAsync", methodBlock, StringComparison.Ordinal);
        Assert.DoesNotContain("PublicKeysetWalkPageThreshold", methodBlock, StringComparison.Ordinal);
        Assert.Contains("a.createtime < @CursorTime OR (a.createtime = @CursorTime AND a.id < @CursorId)", cursorClause, StringComparison.Ordinal);
        Assert.Contains("ORDER BY a.createtime DESC, a.id DESC", methodBlock, StringComparison.Ordinal);
        Assert.Contains("@Offset", methodBlock, StringComparison.Ordinal);
        Assert.Equal("__TotalCount", totalCountColumn);
        Assert.Contains("__TotalCount", methodBlock, StringComparison.Ordinal);
    }

    [Fact]
    public void LoadPublicArticleListPageByKeysetAsync_RuntimeUsesStrictCursorWindow()
    {
        string method = ArticleRuntime(
            "LoadPublicArticleListPageByKeysetAsync",
            "GetCachedArticleListTotalCountAsync",
            "LoadPublicArticleListKeysetPageItemsAsync");

        Assert.Contains("GetCachedArticleListTotalCountAsync", method, StringComparison.Ordinal);
        Assert.Contains("LoadPublicArticleListKeysetPageItemsAsync", method, StringComparison.Ordinal);
        Assert.DoesNotContain("ResolveLegacyPublicArticleListCursorAsync", method, StringComparison.Ordinal);
        Assert.Contains("IArticleListCursorCodec.Encode", method, StringComparison.Ordinal);
        Assert.DoesNotContain("Task.WhenAll", method, StringComparison.Ordinal);
        Assert.DoesNotContain("@Offset", method, StringComparison.Ordinal);
    }

    [Fact]
    public void LoadPublicArticleListKeysetPageItemsAsync_RuntimeBindsCompositeBoundary()
    {
        FieldInfo cursorClause = typeof(ArticleService).GetField(
            "ArticleListCursorWhereClause",
            BindingFlags.Static | BindingFlags.NonPublic)!;
        Assert.True(cursorClause.IsLiteral);
        IReadOnlyList<string> keysetLoaderCallers = RuntimeMetadataInspection.FindMethodsCallingMember(
            typeof(ArticleService),
            static member => member.DeclaringType == typeof(ArticleService)
                && member.Name == "LoadPublicArticleListKeysetPageItemsAsync");
        Assert.Contains(keysetLoaderCallers,
            static caller => caller.Contains("<LoadPublicArticleListPageByKeysetAsync>", StringComparison.Ordinal));
        Assert.DoesNotContain(keysetLoaderCallers,
            static caller => caller.Contains("<ResolveLegacyPublicArticleListCursorAsync>", StringComparison.Ordinal));

        string loader = ArticleRuntime("LoadPublicArticleListKeysetPageItemsAsync", "BuildArticleListKeysetPageSql");
        Assert.Contains("@CursorTime", loader, StringComparison.Ordinal);
        Assert.Contains("@CursorId", loader, StringComparison.Ordinal);
        Assert.DoesNotContain("@Offset", loader, StringComparison.Ordinal);
    }

    [Fact]
    public void PublicArticleListCount_RuntimeUsesVersionedCountCache()
    {
        Assert.True(Enum.IsDefined(CachePolicyId.ArticleListCount));
        var registry = new CachePolicyRegistry();
        Assert.True(registry.TryGet(CachePolicyId.ArticleListCount, out CachePolicy policy));
        Assert.Equal(CachePolicyId.ArticleListCount, policy.Id);
        Assert.Equal("article-list-count", policy.Resource);

        string runtimeShape = ArticleRuntime("GetCachedArticleListTotalCountAsync");
        Assert.Contains("ICacheStringReader.GetStringAsync", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("ICacheStringWriter.SetStringAsync", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("ICacheMissCoordinator.CoordinateAsync", runtimeShape, StringComparison.Ordinal);
    }

    [Fact]
    public void ReadArticleListItemsAsync_NormalizesDbTimestampsToUtcBeforeCacheEncoding()
    {
        string runtimeShape = ArticleRuntime(
            "ReadArticleListItemsAsync",
            "NormalizeArticleListTimestampUtc");
        Assert.True(runtimeShape.Split("NormalizeArticleListTimestampUtc", StringSplitOptions.None).Length - 1 >= 3);

        MethodInfo normalize = typeof(ArticleService).GetMethod(
            "NormalizeArticleListTimestampUtc",
            BindingFlags.Static | BindingFlags.NonPublic)!;
        DateTime local = new(2026, 7, 12, 8, 0, 0, DateTimeKind.Local);
        DateTime unspecified = new(2026, 7, 12, 8, 0, 0, DateTimeKind.Unspecified);
        DateTime localResult = (DateTime)normalize.Invoke(null, [local])!;
        DateTime unspecifiedResult = (DateTime)normalize.Invoke(null, [unspecified])!;
        Assert.Equal(DateTimeKind.Utc, localResult.Kind);
        Assert.Equal(local.ToUniversalTime(), localResult);
        Assert.Equal(DateTimeKind.Utc, unspecifiedResult.Kind);
        Assert.Equal(unspecified, unspecifiedResult);
    }

    [Fact]
    public void ArticleEntity_DefinesPublicListStatusTimeIndexes()
    {
        SugarIndexAttribute[] indexes = typeof(Article).GetCustomAttributes<SugarIndexAttribute>().ToArray();
        Assert.Contains(indexes, static index => index.IndexName == "idx_article_public_status_time");
        Assert.Contains(indexes, static index => index.IndexName == "idx_article_public_category_status_time");
        SugarIndexAttribute statusTime = Assert.Single(indexes, static index =>
            index.IndexName == "idx_article_public_status_time");
        Assert.Contains(nameof(Article.Status), statusTime.IndexFields);
        Assert.Contains(nameof(Article.CreateTime), statusTime.IndexFields);
    }

    [Fact]
    public void SchemaMigrationRegistry_DefinesPublicArticleListKeysetIndexes()
    {
        ISchemaMigrationDescriptor descriptor = Assert.Single(
            new SchemaMigrationRegistry().GetDescriptors(),
            static item => item.MigrationId == "20260628-post-public-article-list-keyset-indexes");
        string fingerprint = string.Join('\n', descriptor.Steps.Select(static step => step.Fingerprint));
        Assert.Contains("idx_article_public_status_deleted_publish_schedule_time_id", fingerprint, StringComparison.Ordinal);
        Assert.Contains("idx_article_public_category_status_deleted_time_id", fingerprint, StringComparison.Ordinal);
        Assert.Contains("idx_article_tag_tagid_articleid", fingerprint, StringComparison.Ordinal);
        Assert.Contains("createtime DESC, id DESC", fingerprint, StringComparison.OrdinalIgnoreCase);
    }
}
