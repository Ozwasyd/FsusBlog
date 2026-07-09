using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using SqlSugar;
using StackExchange.Redis;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>
/// Tests ArticleService validation paths and early returns that don't require DB/Redis.
/// </summary>
public class ArticleServiceValidationTests
{
    private static ArticleService BuildService()
    {
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(Substitute.For<IDatabase>());

        return new ArticleService(
            _db: Substitute.For<ISqlSugarClient>(),
            _searchIndex: Substitute.For<ISearchIndexService>(),
            _redisConnection: redis,
            _cache: Substitute.For<IUnifiedCache>(),
            _cacheMissCoordinator: Substitute.For<ICacheMissCoordinator>(),
            _dbConcurrencyGate: Substitute.For<IDbConcurrencyGate>(),
            _runtimeKeyScope: Substitute.For<IRuntimeKeyScope>(),
            _httpContextAccessor: Substitute.For<IHttpContextAccessor>(),
            _logger: NullLogger<ArticleService>.Instance,
            _publicAotInvalidationService: Substitute.For<IPublicAotInvalidationService>(),
            _cacheInvalidationDispatcher: Substitute.For<ICacheInvalidationDispatcher>(),
            _mutationSideEffects: Substitute.For<IArticleMutationSideEffectCoordinator>(),
            _viewWriteBuffer: Substitute.For<IArticleViewWriteBuffer>());
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

    [Fact]
    public async Task SearchArticlesAsync_WhitespaceKeyword_ReturnsEmpty()
    {
        var svc = BuildService();
        var result = await svc.SearchArticlesAsync("   ");
        Assert.Empty(result);
    }

    [Fact]
    public async Task SearchArticlesAsync_TabAndNewlineOnly_ReturnsEmpty()
    {
        var svc = BuildService();
        var result = await svc.SearchArticlesAsync("\t\n\r");
        Assert.Empty(result);
    }

    [Fact]
    public void SearchArticlesAsync_SourceUsesVersionedNormalizedCacheIdentity()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Services/ArticleService.cs"));
        int methodStart = source.IndexOf("public async Task<List<ArticleListItemReadModel>> SearchArticlesAsync", StringComparison.Ordinal);
        int methodEnd = source.IndexOf("public async Task<List<PopularArticleSummaryDto>> GetHotArticlesAsync", methodStart, StringComparison.Ordinal);
        string method = source[methodStart..methodEnd];

        Assert.Contains("NormalizeSearchKeyword", method, StringComparison.Ordinal);
        Assert.Contains("GetSearchCacheVersionAsync", method, StringComparison.Ordinal);
        Assert.Contains("BuildArticleSearchIdentity", method, StringComparison.Ordinal);
        Assert.DoesNotContain("$\"keyword:{keyword}\"", method, StringComparison.Ordinal);
    }

    [Fact]
    public void SearchArticlesAsync_SourceBypassesLongLivedCacheForLowValueKeywords()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Services/ArticleService.cs"));
        int methodStart = source.IndexOf("public async Task<List<ArticleListItemReadModel>> SearchArticlesAsync", StringComparison.Ordinal);
        int methodEnd = source.IndexOf("public async Task<List<PopularArticleSummaryDto>> GetHotArticlesAsync", methodStart, StringComparison.Ordinal);
        string method = source[methodStart..methodEnd];

        Assert.Contains("ShouldCacheSearchKeyword", method, StringComparison.Ordinal);
        Assert.Contains("LoadSearchArticlesFromSourceAsync(normalizedKeyword", method, StringComparison.Ordinal);
        Assert.Contains("FsusObservability.RecordCacheOperation", method, StringComparison.Ordinal);
    }

    [Fact]
    public void UpdateAsync_SourceChecksAffectedRowsBeforeDependentWrites()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Services/ArticleService.cs"));
        int updateMethod = source.IndexOf("public async Task<bool> UpdateAsync", StringComparison.Ordinal);
        int deleteMethod = source.IndexOf("public async Task<bool> DeleteAsync", StringComparison.Ordinal);
        string method = source[updateMethod..deleteMethod];

        int affectedAssignment = method.IndexOf("bool updated = await TryUpdateArticleRowAsync", StringComparison.Ordinal);
        int zeroRowReturn = method.IndexOf("if (!updated)", StringComparison.Ordinal);
        int bodyWrite = method.IndexOf("Storageable(new ArticleBody", StringComparison.Ordinal);
        int revisionWrite = method.IndexOf("SaveArticleRevisionAsync", StringComparison.Ordinal);
        int successGuard = method.IndexOf("if (result.IsSuccess && articleUpdated)", StringComparison.Ordinal);

        Assert.True(affectedAssignment >= 0);
        Assert.True(zeroRowReturn > affectedAssignment);
        Assert.True(bodyWrite > zeroRowReturn);
        Assert.True(revisionWrite > zeroRowReturn);
        Assert.True(successGuard > revisionWrite);
    }

    [Fact]
    public void GetPageListAsync_SourceRejectsInvalidPaginationWithoutSilentCoercion()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Services/ArticleService.cs"));
        int methodStart = source.IndexOf("public async Task<ArticleListPageReadModel> GetPageListAsync", StringComparison.Ordinal);
        int nextMethod = source.IndexOf("public async Task<ArticleDetailReadModel?> GetByIdAsync", methodStart, StringComparison.Ordinal);
        string method = source[methodStart..nextMethod];

        Assert.Contains("throw new ArgumentOutOfRangeException(nameof(page)", method, StringComparison.Ordinal);
        Assert.Contains("throw new ArgumentOutOfRangeException(nameof(size)", method, StringComparison.Ordinal);
        Assert.DoesNotContain("page = page < 1 ? 1 : page", method, StringComparison.Ordinal);
        Assert.DoesNotContain("< 1 => 10", method, StringComparison.Ordinal);
        Assert.DoesNotContain("> MaxPageSize => MaxPageSize", method, StringComparison.Ordinal);
    }

    [Fact]
    public void DeleteAndRestore_SourceInvalidatePublicAotWithCurrentStateAfterMutation()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Services/ArticleService.cs"));
        int deleteMethod = source.IndexOf("public async Task<bool> DeleteAsync", StringComparison.Ordinal);
        int restoreMethod = source.IndexOf("public async Task<bool> RestoreAsync", deleteMethod, StringComparison.Ordinal);
        int permanentDeleteMethod = source.IndexOf("public async Task<bool> PermanentlyDeleteArticleAsync", restoreMethod, StringComparison.Ordinal);
        string deleteBlock = source[deleteMethod..restoreMethod];
        string restoreBlock = source[restoreMethod..permanentDeleteMethod];

        Assert.Contains("LoadArticleMutationStateAsync(id, isDeleted: false)", deleteBlock, StringComparison.Ordinal);
        Assert.Contains("xmin::text = @RowVersion", deleteBlock, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("await InvalidatePublicAotAsync(id, state.CategoryIds, state.TagIds, \"delete\")", deleteBlock, StringComparison.Ordinal);

        Assert.Contains("LoadArticleMutationStateAsync(id, isDeleted: true)", restoreBlock, StringComparison.Ordinal);
        Assert.Contains("xmin::text = @RowVersion", restoreBlock, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("await InvalidatePublicAotAsync(id, state.CategoryIds, state.TagIds, \"restore\")", restoreBlock, StringComparison.Ordinal);
    }

    [Fact]
    public void ArticleService_SourceInvalidatesPublicAotCategoryAndTagUnions()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Services/ArticleService.cs"));
        int methodStart = source.IndexOf("private async Task InvalidatePublicAotWithCurrentStateAsync", StringComparison.Ordinal);
        int nextMethod = source.IndexOf("private async Task InvalidatePublicAotBatchAsync", methodStart, StringComparison.Ordinal);
        string method = source[methodStart..nextMethod];

        Assert.Contains("var currentState = await LoadArticleAotStateAsync(articleId)", method, StringComparison.Ordinal);
        Assert.Contains("MergeIds(beforeState.CategoryIds, currentState.CategoryIds)", method, StringComparison.Ordinal);
        Assert.Contains("MergeIds(beforeState.TagIds, currentState.TagIds)", method, StringComparison.Ordinal);
        Assert.Contains("await InvalidatePublicAotAsync(", method, StringComparison.Ordinal);
    }

    [Fact]
    public void ArticleService_SourceDoesNotQueryLegacyArticleContentColumn()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Services/ArticleService.cs"));

        Assert.Contains("LEFT JOIN article_body ab ON ab.article_id = a.id", source, StringComparison.Ordinal);
        Assert.Contains("COALESCE(ab.markdown_content, '')", source, StringComparison.Ordinal);
        Assert.DoesNotContain("s_legacyArticleContentColumnState", source, StringComparison.Ordinal);
        Assert.DoesNotContain("LegacyArticleContentColumnExistsAsync", source, StringComparison.Ordinal);
        Assert.DoesNotContain("a.content", source, StringComparison.Ordinal);
        Assert.DoesNotContain("private bool? _legacyArticleContentColumnExists", source, StringComparison.Ordinal);
    }

    [Fact]
    public void IncreaseViewCountAsync_SourceEnqueuesViewsWithoutSynchronousDbRedisOrDetailInvalidation()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Services/ArticleService.cs"));
        int methodStart = source.IndexOf("public async ValueTask IncreaseViewCountAsync(int id, int count)", StringComparison.Ordinal);
        int nextMethod = source.IndexOf("public async ValueTask<IReadOnlySet<int>> IncreaseViewCountsAsync", StringComparison.Ordinal);
        string method = source[methodStart..nextMethod];

        Assert.Contains("_viewWriteBuffer.EnqueueAsync(id, count", method, StringComparison.Ordinal);
        Assert.DoesNotContain("TryIncreaseArticleViewsAsync", method, StringComparison.Ordinal);
        Assert.DoesNotContain("SortedSetAddAsync", method, StringComparison.Ordinal);
        Assert.DoesNotContain("SortedSetIncrementAsync", method, StringComparison.Ordinal);
        Assert.DoesNotContain("RemoveAsync(CachePolicyId.ArticleDetail", method, StringComparison.Ordinal);
    }

    [Fact]
    public void GetByIdAsync_SourceCoordinatesPublicArticleDetailCacheMiss()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Services/ArticleService.cs"));
        int methodStart = source.IndexOf("public async Task<ArticleDetailReadModel?> GetByIdAsync", StringComparison.Ordinal);
        int nextMethod = source.IndexOf("private async Task<CacheReadResult<ArticleDetailReadModel>> TryReadArticleDetailCacheAsync", StringComparison.Ordinal);
        string method = source[methodStart..nextMethod];

        Assert.Contains("_cacheMissCoordinator.CoordinateAsync", method, StringComparison.Ordinal);
        Assert.Contains("CachePolicyId.ArticleDetail", method, StringComparison.Ordinal);
        Assert.Contains("TryReadArticleDetailCacheAsync", method, StringComparison.Ordinal);
        Assert.Contains("LoadArticleDetailFromDbAsync", method, StringComparison.Ordinal);
        Assert.Contains("article-detail", method, StringComparison.Ordinal);
    }

    [Fact]
    public void LoadArticleDetailFromDbAsync_SourceUsesSingleSqlForMetadataContentAndTags()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Services/ArticleService.cs"));
        int methodStart = source.IndexOf("private async Task<ArticleDetailReadModel?> LoadArticleDetailFromDbAsync", StringComparison.Ordinal);
        int nextMethod = source.IndexOf("private async Task<string> LoadArticleContentAsync", methodStart, StringComparison.Ordinal);
        string method = source[methodStart..nextMethod];

        Assert.Contains("LEFT JOIN article_body ab ON ab.article_id = a.id", method, StringComparison.Ordinal);
        Assert.Contains("array_agg(t.id ORDER BY t.id)", method, StringComparison.Ordinal);
        Assert.Contains("array_agg(t.name ORDER BY t.id)", method, StringComparison.Ordinal);
        Assert.Contains("ReadArticleDetailTags", method, StringComparison.Ordinal);
        Assert.DoesNotContain("LoadArticleContentAsync(id", method, StringComparison.Ordinal);
        Assert.DoesNotContain("LoadArticleTagsAsync(id", method, StringComparison.Ordinal);
    }

    [Fact]
    public void LoadArticleDetailFromDbAsync_SourceLoadsRightsSnapshotAndProofInSingleSql()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Services/ArticleService.cs"));
        int methodStart = source.IndexOf("private async Task<ArticleDetailReadModel?> LoadArticleDetailFromDbAsync", StringComparison.Ordinal);
        int nextMethod = source.IndexOf("private async Task<string> LoadArticleContentAsync", methodStart, StringComparison.Ordinal);
        string method = source[methodStart..nextMethod];

        Assert.Contains("LEFT JOIN LATERAL", method, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("article_rights_snapshot", method, StringComparison.Ordinal);
        Assert.Contains("article_rights_proof", method, StringComparison.Ordinal);
        Assert.Contains("Rights = ReadArticleRights(reader", method, StringComparison.Ordinal);
        Assert.DoesNotContain("LoadArticleRights", method, StringComparison.Ordinal);
    }

    [Fact]
    public void LoadArticleDetailFromDbAsync_SourceNormalizesDbTimestampsBeforeServerCacheEncoding()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Services/ArticleService.cs"));
        int methodStart = source.IndexOf("private async Task<ArticleDetailReadModel?> LoadArticleDetailFromDbAsync", StringComparison.Ordinal);
        int nextMethod = source.IndexOf("private async Task<string> LoadArticleContentAsync", methodStart, StringComparison.Ordinal);
        string method = source[methodStart..nextMethod];

        Assert.Contains("CreateTime = NormalizeArticleListTimestampUtc(reader.GetDateTime(fTime))", method, StringComparison.Ordinal);
        Assert.Contains("ScheduledPublishAt = reader.IsDBNull(fScheduled) ? null : NormalizeArticleListTimestampUtc(reader.GetDateTime(fScheduled))", method, StringComparison.Ordinal);
        Assert.Contains("PublishedAt = reader.IsDBNull(fPublished) ? null : NormalizeArticleListTimestampUtc(reader.GetDateTime(fPublished))", method, StringComparison.Ordinal);
        Assert.True(
            method.IndexOf("CreateTime = NormalizeArticleListTimestampUtc", StringComparison.Ordinal)
                < method.IndexOf("ServerCacheBinaryCodec.EncodeArticleDetail(article)", StringComparison.Ordinal),
            "Article detail timestamps must be normalized before the detail is encoded into the server cache.");
    }

    [Fact]
    public void ArticleDetailAedsArtifactProjector_SourceUsesSingleSqlForDetailArtifactBackfill()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Infrastructure/PublicReadArtifacts/ArticleDetailAedsArtifactStore.cs"));
        int methodStart = source.IndexOf("private async Task<ArticleDetailReadModel?> LoadArticleDetailFromDbAsync", StringComparison.Ordinal);
        int nextMethod = source.IndexOf("private async Task<string> LoadArticleContentAsync", methodStart, StringComparison.Ordinal);
        string method = source[methodStart..nextMethod];

        Assert.Contains("LEFT JOIN article_body ab ON ab.article_id = a.id", method, StringComparison.Ordinal);
        Assert.Contains("array_agg(t.id ORDER BY t.id)", method, StringComparison.Ordinal);
        Assert.Contains("array_agg(t.name ORDER BY t.id)", method, StringComparison.Ordinal);
        Assert.Contains("ReadArticleDetailTags", method, StringComparison.Ordinal);
        Assert.DoesNotContain("LoadArticleContentAsync(id", method, StringComparison.Ordinal);
        Assert.DoesNotContain("LoadArticleTagMapAsync([id]", method, StringComparison.Ordinal);
    }

    [Fact]
    public void ArticleDetailAedsArtifactProjector_SourceLoadsRightsSnapshotAndProofInSingleSql()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Infrastructure/PublicReadArtifacts/ArticleDetailAedsArtifactStore.cs"));
        int methodStart = source.IndexOf("private async Task<ArticleDetailReadModel?> LoadArticleDetailFromDbAsync", StringComparison.Ordinal);
        int nextMethod = source.IndexOf("private async Task<string> LoadArticleContentAsync", methodStart, StringComparison.Ordinal);
        string method = source[methodStart..nextMethod];

        Assert.Contains("LEFT JOIN LATERAL", method, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("article_rights_snapshot", method, StringComparison.Ordinal);
        Assert.Contains("article_rights_proof", method, StringComparison.Ordinal);
        Assert.Contains("Rights = ReadArticleRights(reader", method, StringComparison.Ordinal);
        Assert.DoesNotContain("LoadArticleRights", method, StringComparison.Ordinal);
    }

    [Fact]
    public void ArticleDetailAedsArtifactProjector_SourceDoesNotWriteArtifactWithoutCompleteRights()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Infrastructure/PublicReadArtifacts/ArticleDetailAedsArtifactStore.cs"));
        int methodStart = source.IndexOf("public async Task GenerateAndStoreAsync", StringComparison.Ordinal);
        int nextMethod = source.IndexOf("public Task RemoveAsync", methodStart, StringComparison.Ordinal);
        string method = source[methodStart..nextMethod];

        Assert.Contains("HasCompleteArticleRights(article.Rights)", method, StringComparison.Ordinal);
        Assert.Contains("article_detail_aeds_rights_missing", method, StringComparison.Ordinal);
        Assert.Contains("await store.RemoveAsync(articleId", method, StringComparison.Ordinal);
        Assert.Contains("throw new InvalidOperationException", method, StringComparison.Ordinal);

        int rightsGuard = method.IndexOf("HasCompleteArticleRights(article.Rights)", StringComparison.Ordinal);
        int remove = method.IndexOf("await store.RemoveAsync(articleId", rightsGuard, StringComparison.Ordinal);
        int throwMissing = method.IndexOf("throw new InvalidOperationException", rightsGuard, StringComparison.Ordinal);
        int encode = method.IndexOf("PodBinaryCodec.EncodeArticleDetail", StringComparison.Ordinal);
        Assert.True(rightsGuard >= 0);
        Assert.True(remove > rightsGuard);
        Assert.True(throwMissing > remove);
        Assert.True(encode > throwMissing);
    }

    [Fact]
    public void PublicHotArtifactProjector_SourceLoadsRightsSnapshotForArticleDetailFrames()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Infrastructure/PublicReadArtifacts/PublicHotArtifactProjector.cs"));
        int methodStart = source.IndexOf("private async Task<IReadOnlyList<ArticleDetailReadModel>> LoadArticleDetailsFromDbAsync", StringComparison.Ordinal);
        int nextMethod = source.IndexOf("private async Task<IReadOnlyList<PopularArticleCoreModel>> LoadHotArticlesFromDbAsync", methodStart, StringComparison.Ordinal);
        string method = source[methodStart..nextMethod];

        Assert.Contains("LoadArticleRightsMapAsync", method, StringComparison.Ordinal);
        Assert.Contains("Rights =", method, StringComparison.Ordinal);
        Assert.DoesNotContain("new ArticleRightsReadModel()", method, StringComparison.Ordinal);
    }

    [Fact]
    public void PublicHotArtifactProjector_SourceSkipsArticleDetailFramesWithoutCompleteRights()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Infrastructure/PublicReadArtifacts/PublicHotArtifactProjector.cs"));
        int methodStart = source.IndexOf("private async Task<IReadOnlyList<ArticleDetailReadModel>> LoadArticleDetailsFromDbAsync", StringComparison.Ordinal);
        int nextMethod = source.IndexOf("private async Task<IReadOnlyList<PopularArticleCoreModel>> LoadHotArticlesFromDbAsync", methodStart, StringComparison.Ordinal);
        string method = source[methodStart..nextMethod];

        Assert.Contains("HasCompleteArticleRights", method, StringComparison.Ordinal);
        Assert.Contains("public_hot_article_detail_rights_missing", method, StringComparison.Ordinal);
        Assert.DoesNotContain("? rights : article.Rights", method, StringComparison.Ordinal);
    }

    [Fact]
    public void UpdateAsync_SourceUsesRowVersionGuardAndAtomicTagSetRewrite()
    {
        string articleService = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Services/ArticleService.cs"));
        string articleEntity = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Entities/Article.cs"));
        int updateStart = articleService.IndexOf("public async Task<bool> UpdateAsync", StringComparison.Ordinal);
        int deleteStart = articleService.IndexOf("public async Task<bool> DeleteAsync", updateStart, StringComparison.Ordinal);
        string updateMethod = articleService[updateStart..deleteStart];
        int stateStart = articleService.IndexOf("private async Task<ArticleUpdateState?> LoadArticleUpdateStateAsync", StringComparison.Ordinal);
        int rowUpdateStart = articleService.IndexOf("private async Task<bool> TryUpdateArticleRowAsync", StringComparison.Ordinal);
        int tagStart = articleService.IndexOf("private async Task ApplyArticleTagsAsync", StringComparison.Ordinal);
        int nextMethod = articleService.IndexOf("public async Task<bool> DeleteAsync", StringComparison.Ordinal);
        string loadMethod = articleService[stateStart..rowUpdateStart];
        string rowUpdateMethod = articleService[rowUpdateStart..tagStart];
        string tagMethod = articleService[tagStart..nextMethod];

        Assert.Contains("public string? RowVersion", articleEntity, StringComparison.Ordinal);
        Assert.Contains("LoadArticleUpdateStateAsync(id)", updateMethod, StringComparison.Ordinal);
        Assert.Contains("TryUpdateArticleRowAsync(", updateMethod, StringComparison.Ordinal);
        Assert.Contains("state,", updateMethod, StringComparison.Ordinal);
        Assert.Contains("ApplyArticleTagsAsync(id, tagIds)", updateMethod, StringComparison.Ordinal);
        Assert.Contains("xmin::text AS row_version", loadMethod, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("AND xmin::text = @RowVersion", rowUpdateMethod, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("AND isdeleted = false", rowUpdateMethod, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("WITH desired_tags", tagMethod, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("ON CONFLICT (articleid, tagid) DO NOTHING", tagMethod, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("DELETE FROM article_tag", tagMethod, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Deleteable<ArticleTag>()", updateMethod, StringComparison.Ordinal);
    }

    [Fact]
    public void ArticleMutations_SourceRecordsTransactionalOutboxEvents()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Services/ArticleService.cs"));

        Assert.Contains("RecordArticleMutationOutboxAsync(id, \"created\", rightsSnapshotId)", source, StringComparison.Ordinal);
        Assert.Contains("RecordArticleMutationOutboxAsync(id, \"updated\", rightsSnapshotId)", source, StringComparison.Ordinal);
        Assert.Contains("RecordArticleMutationOutboxAsync(id, \"deleted\")", source, StringComparison.Ordinal);
        Assert.Contains("RecordArticleMutationOutboxAsync(id, \"restored\")", source, StringComparison.Ordinal);
        Assert.Contains("RecordArticleMutationOutboxAsync(id, \"permanently-deleted\")", source, StringComparison.Ordinal);
        Assert.Contains("RecordArticleMutationOutboxAsync(articleId, \"trash-cleared\")", source, StringComparison.Ordinal);
    }

    [Fact]
    public void ClearTrashAsync_SourceLocksAndRechecksDeletedRowsInsideTransaction()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Services/ArticleService.cs"));
        int methodStart = source.IndexOf("public async Task<int> ClearTrashAsync", StringComparison.Ordinal);
        int methodEnd = source.IndexOf("private async Task<List<TrashArticleRow>> LoadTrashArticlesForUpdateAsync", methodStart, StringComparison.Ordinal);
        string method = source[methodStart..methodEnd];
        string lockHelper = source[
            methodEnd..source.IndexOf("public async Task<List<ArticleListItemReadModel>> SearchArticlesAsync", methodEnd, StringComparison.Ordinal)];

        Assert.Contains("UseTranAsync", method, StringComparison.Ordinal);
        Assert.Contains("LoadTrashArticlesForUpdateAsync(ct)", method, StringComparison.Ordinal);
        Assert.DoesNotContain("var trashArticles = await _db.Queryable<Article>()", method, StringComparison.Ordinal);
        Assert.Contains("FOR UPDATE", lockHelper, StringComparison.Ordinal);
        Assert.Contains("WHERE isdeleted = true", lockHelper, StringComparison.Ordinal);
        Assert.Contains(".Where(it => chunk.Contains(it.Id) && it.IsDeleted)", method, StringComparison.Ordinal);
    }

    [Fact]
    public void SaveArticleRevisionAsync_SourceLocksArticleRowAndDefinesUniqueRevisionIndex()
    {
        string articleService = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Services/ArticleService.cs"));
        string entities = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Entities/Article.cs"));
        string migrations = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Infrastructure/SchemaMigration/SchemaMigrationRegistry.cs"));

        Assert.Contains("FOR UPDATE", articleService, StringComparison.Ordinal);
        Assert.Contains("ux_article_revision_article_revision_no", entities, StringComparison.Ordinal);
        Assert.Contains("ux_article_revision_article_revision_no", migrations, StringComparison.Ordinal);
        Assert.Contains("ON article_revision(article_id, revision_no)", migrations, StringComparison.Ordinal);
    }

    [Fact]
    public void SaveArticleRevisionAsync_SourceAllocatesRevisionNoAtomicallyAndRejectsDeletedArticle()
    {
        string articleService = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Services/ArticleService.cs"));
        int methodStart = articleService.IndexOf("private async Task<ArticleRevisionCoordinates> SaveArticleRevisionAsync", StringComparison.Ordinal);
        int methodEnd = articleService.IndexOf("private long ResolveRevisionAdminPrincipalId", methodStart, StringComparison.Ordinal);
        string method = articleService[methodStart..methodEnd];

        Assert.Contains("xmin", method, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("isdeleted = false", method, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("FOR UPDATE", method, StringComparison.Ordinal);
        Assert.Contains("LOCK TABLE article_revision IN ROW EXCLUSIVE MODE", method, StringComparison.Ordinal);
        Assert.Contains("INSERT INTO article_revision", method, StringComparison.Ordinal);
        Assert.Contains("COALESCE(MAX(revision_no), 0) + 1", method, StringComparison.Ordinal);
        Assert.Contains("WHERE article_id = @articleId", method, StringComparison.Ordinal);
        Assert.DoesNotContain(".MaxAsync(it => it.RevisionNo)", method, StringComparison.Ordinal);
        Assert.DoesNotContain("RevisionNo = Math.Max", method, StringComparison.Ordinal);
    }

    [Fact]
    public void SaveArticleRevisionAsync_SourceUsesAdminPrincipalActor()
    {
        string articleService = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Services/ArticleService.cs"));
        int methodStart = articleService.IndexOf("private async Task<ArticleRevisionCoordinates> SaveArticleRevisionAsync", StringComparison.Ordinal);
        int methodEnd = articleService.IndexOf("private Task RecordArticleMutationOutboxAsync", StringComparison.Ordinal);
        string method = articleService[methodStart..methodEnd];

        Assert.Contains("ResolveRevisionAdminPrincipalId()", articleService, StringComparison.Ordinal);
        Assert.Contains("created_by_admin_principal_id", method, StringComparison.Ordinal);
        Assert.Contains("@createdByAdminPrincipalId", method, StringComparison.Ordinal);
        Assert.DoesNotContain("GetUserId()", method, StringComparison.Ordinal);
        Assert.DoesNotContain("CreatedByUserId", method, StringComparison.Ordinal);
    }

    [Fact]
    public void IncreaseViewCountsAsync_SourceUsesSingleValuesUpdateAndRedisBatchWithoutDetailInvalidation()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Services/ArticleService.cs"));
        int methodStart = source.IndexOf("public async ValueTask<IReadOnlySet<int>> IncreaseViewCountsAsync", StringComparison.Ordinal);
        int nextMethod = source.IndexOf("public async Task<ArticleListPageReadModel>", StringComparison.Ordinal);
        string method = source[methodStart..nextMethod];

        Assert.Contains("FROM (VALUES", method, StringComparison.Ordinal);
        Assert.Contains("RETURNING a.id, a.views", method, StringComparison.Ordinal);
        Assert.Contains("IBatch redisBatch = _redis.CreateBatch()", method, StringComparison.Ordinal);
        Assert.Contains("SortedSetAddAsync(hotRankKey, articleId, currentViews)", method, StringComparison.Ordinal);
        Assert.DoesNotContain("RemoveAsync(CachePolicyId.ArticleDetail", method, StringComparison.Ordinal);
    }

    [Fact]
    public void GetByIdAsync_SourceOverlaysProjectedViewsOnCachedArticleDetail()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Services/ArticleService.cs"));

        Assert.Contains("OverlayProjectedViewsAsync", source, StringComparison.Ordinal);
        Assert.Contains("SortedSetScoreAsync(RedisKey(\"blog:top_articles\"), article.Id)", source, StringComparison.Ordinal);
    }

    [Fact]
    public void RuntimeDomainServices_SourceRegistersArticleViewBufferAndWorker()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Infrastructure/Bootstrap/RuntimeDomainServiceCollectionExtensions.cs"));

        Assert.Contains("AddSingleton<IArticleViewWriteBuffer, ArticleViewWriteBuffer>()", source, StringComparison.Ordinal);
        Assert.Contains("AddScoped<IArticleViewFlushSink, ArticleServiceViewFlushSink>()", source, StringComparison.Ordinal);
        Assert.Contains("AddHostedService<ArticleViewFlushWorker>()", source, StringComparison.Ordinal);
    }

    [Fact]
    public void ArticleViewFlushSink_SourceMarksHotStatsAndPublicHotDirtyAfterFlush()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Services/ArticleViewWriteBuffer.cs"));
        int methodStart = source.IndexOf("public async ValueTask<IReadOnlySet<int>> FlushArticleViewsAsync", StringComparison.Ordinal);
        int nextType = source.IndexOf("public sealed class ArticleViewFlushWorker", methodStart, StringComparison.Ordinal);
        string method = source[methodStart..nextType];

        Assert.Contains("IncreaseViewCountsAsync(articleCounts, cancellationToken)", method, StringComparison.Ordinal);
        Assert.Contains("MarkStatsDirtyAsync(reason, cancellationToken)", method, StringComparison.Ordinal);
        Assert.Contains("MarkHotArticlesDirtyAsync(reason, cancellationToken)", method, StringComparison.Ordinal);
        Assert.Contains("foreach (int articleId in updatedArticleIds)", method, StringComparison.Ordinal);
        Assert.Contains("TryEnqueue(articleId, reason)", method, StringComparison.Ordinal);
        Assert.Contains("article-view-projection-buffer-flush", method, StringComparison.Ordinal);
    }

    [Fact]
    public void ArticleViewInvalidation_SourceDoesNotRemoveArticleDetailContentCache()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Infrastructure/Cache/ICacheInvalidationDispatcher.cs"));
        int methodStart = source.IndexOf("public async Task InvalidateArticleViewAsync", StringComparison.Ordinal);
        int nextMethod = source.IndexOf("public async Task InvalidateHotArticlesAsync", methodStart, StringComparison.Ordinal);
        string method = source[methodStart..nextMethod];

        Assert.Contains("RecordRuntimeAsync(\"article_view\"", method, StringComparison.Ordinal);
        Assert.DoesNotContain("CachePolicyId.ArticleDetail", method, StringComparison.Ordinal);
        Assert.DoesNotContain("CachePolicyId.ArticleDetailFrame", method, StringComparison.Ordinal);
    }

    [Fact]
    public void LoadArticleListPageFromDbAsync_SourceUsesKeysetForPublicPagination()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Services/ArticleService.cs"));
        int methodStart = source.IndexOf("private async Task<ArticleListPageReadModel> LoadArticleListPageFromDbAsync", StringComparison.Ordinal);
        int nextMethod = source.IndexOf("private static string RewriteParameters", StringComparison.Ordinal);
        string methodBlock = source[methodStart..nextMethod];

        Assert.Contains("ShouldUsePublicKeysetPagination(isDeleted, status, includePrivate)", methodBlock, StringComparison.Ordinal);
        Assert.Contains("LoadPublicArticleListPageByKeysetAsync", methodBlock, StringComparison.Ordinal);
        Assert.DoesNotContain("page <= PublicKeysetWalkPageThreshold", methodBlock, StringComparison.Ordinal);
        Assert.Contains("ArticleListCursorWhereClause", source, StringComparison.Ordinal);
        Assert.Contains("a.createtime < @CursorTime OR (a.createtime = @CursorTime AND a.id < @CursorId)", source, StringComparison.Ordinal);
        Assert.Contains("ORDER BY a.createtime DESC, a.id DESC", source, StringComparison.Ordinal);

        int publicKeysetBranch = methodBlock.IndexOf("if (ShouldUsePublicKeysetPagination", StringComparison.Ordinal);
        int keysetReturn = methodBlock.IndexOf("return await LoadPublicArticleListPageByKeysetAsync", publicKeysetBranch, StringComparison.Ordinal);
        int offsetFallback = methodBlock.IndexOf("parameters.Add(new SugarParameter(\"@Offset\"", StringComparison.Ordinal);
        Assert.True(publicKeysetBranch >= 0);
        Assert.True(keysetReturn > publicKeysetBranch);
        Assert.True(offsetFallback > keysetReturn);
    }

    [Fact]
    public void LoadPublicArticleListPageByKeysetAsync_SourceUsesSingleOffsetReadWithoutConcurrentScopedDbCommands()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Services/ArticleService.cs"));
        int methodStart = source.IndexOf("private async Task<ArticleListPageReadModel> LoadPublicArticleListPageByKeysetAsync", StringComparison.Ordinal);
        int nextMethod = source.IndexOf("private async Task<List<ArticleListItemReadModel>> LoadPublicArticleListOffsetPageItemsAsync", StringComparison.Ordinal);
        Assert.True(methodStart >= 0, "LoadPublicArticleListPageByKeysetAsync must exist.");
        Assert.True(nextMethod > methodStart, "LoadPublicArticleListOffsetPageItemsAsync must follow LoadPublicArticleListPageByKeysetAsync.");
        string method = source[methodStart..nextMethod];

        Assert.Contains("int totalCount = await GetCachedArticleListTotalCountAsync", method, StringComparison.Ordinal);
        Assert.Contains("List<ArticleListItemReadModel> pageItems = await LoadPublicArticleListOffsetPageItemsAsync", method, StringComparison.Ordinal);
        Assert.DoesNotContain("Task.WhenAll", method, StringComparison.Ordinal);
        Assert.DoesNotContain("totalCountTask", method, StringComparison.Ordinal);
        Assert.DoesNotContain("pageItemsTask", method, StringComparison.Ordinal);
        Assert.Contains("LoadPublicArticleListOffsetPageItemsAsync", method, StringComparison.Ordinal);
        Assert.Contains("parameters.Add(new SugarParameter(\"@Offset\", (page - 1) * size))", method, StringComparison.Ordinal);
        Assert.DoesNotContain("while (currentPage <= page)", method, StringComparison.Ordinal);
        Assert.DoesNotContain("currentPage += 1", method, StringComparison.Ordinal);
    }

    [Fact]
    public void LoadPublicArticleListPageByKeysetAsync_SourceDoesNotCloneParametersPerWalkPage()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Services/ArticleService.cs"));
        int methodStart = source.IndexOf("private async Task<ArticleListPageReadModel> LoadPublicArticleListPageByKeysetAsync", StringComparison.Ordinal);
        int nextMethod = source.IndexOf("private async Task<List<ArticleListItemReadModel>> LoadPublicArticleListOffsetPageItemsAsync", StringComparison.Ordinal);
        Assert.True(methodStart >= 0, "LoadPublicArticleListPageByKeysetAsync must exist.");
        Assert.True(nextMethod > methodStart, "LoadPublicArticleListOffsetPageItemsAsync must follow LoadPublicArticleListPageByKeysetAsync.");
        string method = source[methodStart..nextMethod];

        Assert.Contains("private const string ArticleListCursorWhereClause", source, StringComparison.Ordinal);
        Assert.DoesNotContain("BuildArticleListKeysetPageSql(whereSql + ArticleListCursorWhereClause)", method, StringComparison.Ordinal);
        Assert.DoesNotContain("CloneArticleListParameters(baseParameters)", method, StringComparison.Ordinal);
        Assert.DoesNotContain("pageWhereSql +=", method, StringComparison.Ordinal);
    }

    [Fact]
    public void PublicArticleListCount_SourceUsesVersionedCountCache()
    {
        string articleService = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Services/ArticleService.cs"));
        string cachePolicyIds = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Infrastructure/Cache/CachePolicyId.cs"));
        string cacheRegistry = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Infrastructure/Cache/CachePolicyRegistry.cs"));

        Assert.Contains("ArticleListCount", cachePolicyIds, StringComparison.Ordinal);
        Assert.Contains("[CachePolicyId.ArticleListCount]", cacheRegistry, StringComparison.Ordinal);
        Assert.Contains("GetCachedArticleListTotalCountAsync", articleService, StringComparison.Ordinal);
        Assert.Contains("_cache.GetStringAsync(CachePolicyId.ArticleListCount", articleService, StringComparison.Ordinal);
        Assert.Contains("_cache.SetStringAsync(", articleService, StringComparison.Ordinal);
        Assert.Contains("CachePolicyId.ArticleListCount,", articleService, StringComparison.Ordinal);
    }

    [Fact]
    public void ReadArticleListItemsAsync_NormalizesDbTimestampsToUtcBeforeCacheEncoding()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Services/ArticleService.cs"));
        int methodStart = source.IndexOf("private static async Task ReadArticleListItemsAsync", StringComparison.Ordinal);
        int nextMethod = source.IndexOf("private static DateTime NormalizeArticleListTimestampUtc", StringComparison.Ordinal);
        Assert.True(methodStart >= 0, "ReadArticleListItemsAsync must exist.");
        Assert.True(nextMethod > methodStart, "NormalizeArticleListTimestampUtc must follow ReadArticleListItemsAsync.");
        string method = source[methodStart..nextMethod];

        Assert.Contains("CreateTime = NormalizeArticleListTimestampUtc(reader.GetDateTime(fTime))", method, StringComparison.Ordinal);
        Assert.Contains("ScheduledPublishAt = reader.IsDBNull(fScheduled) ? null : NormalizeArticleListTimestampUtc(reader.GetDateTime(fScheduled))", method, StringComparison.Ordinal);
        Assert.Contains("PublishedAt = reader.IsDBNull(fPublished) ? null : NormalizeArticleListTimestampUtc(reader.GetDateTime(fPublished))", method, StringComparison.Ordinal);
        Assert.Contains("DateTimeKind.Local => value.ToUniversalTime()", source, StringComparison.Ordinal);
        Assert.Contains("DateTime.SpecifyKind(value, DateTimeKind.Utc)", source, StringComparison.Ordinal);
    }

    [Fact]
    public void ArticleEntity_DefinesPublicListStatusTimeIndexes()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Entities/Article.cs"));

        Assert.Contains("idx_article_public_status_time", source, StringComparison.Ordinal);
        Assert.Contains("idx_article_public_category_status_time", source, StringComparison.Ordinal);
        Assert.Contains("nameof(Status), OrderByType.Asc, nameof(CreateTime), OrderByType.Desc", source, StringComparison.Ordinal);
    }

    [Fact]
    public void SchemaMigrationRegistry_SourceDefinesPublicArticleListKeysetIndexes()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Infrastructure/SchemaMigration/SchemaMigrationRegistry.cs"));

        Assert.Contains("BuildPublicArticleListKeysetIndexMigration()", source, StringComparison.Ordinal);
        Assert.Contains("idx_article_public_status_deleted_publish_schedule_time_id", source, StringComparison.Ordinal);
        Assert.Contains("idx_article_public_category_status_deleted_time_id", source, StringComparison.Ordinal);
        Assert.Contains("idx_article_tag_tagid_articleid", source, StringComparison.Ordinal);
        Assert.Contains("createtime DESC, id DESC", source, StringComparison.OrdinalIgnoreCase);
    }
}
