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
            _mutationSideEffects: Substitute.For<IArticleMutationSideEffectCoordinator>());
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
    public void UpdateAsync_SourceChecksAffectedRowsBeforeDependentWrites()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Services/ArticleService.cs"));
        int updateMethod = source.IndexOf("public async Task<bool> UpdateAsync", StringComparison.Ordinal);
        int deleteMethod = source.IndexOf("public async Task<bool> DeleteAsync", StringComparison.Ordinal);
        string method = source[updateMethod..deleteMethod];

        int affectedAssignment = method.IndexOf("int affectedRows = await _db.Updateable<Article>()", StringComparison.Ordinal);
        int zeroRowReturn = method.IndexOf("if (affectedRows == 0)", StringComparison.Ordinal);
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
    public void ArticleService_SourceUsesProcessWideLegacySchemaCapabilityCache()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Services/ArticleService.cs"));

        Assert.Contains("private static int s_legacyArticleContentColumnState", source, StringComparison.Ordinal);
        Assert.Contains("Volatile.Read(ref s_legacyArticleContentColumnState)", source, StringComparison.Ordinal);
        Assert.Contains("Volatile.Write(ref s_legacyArticleContentColumnState", source, StringComparison.Ordinal);
        Assert.DoesNotContain("private bool? _legacyArticleContentColumnExists", source, StringComparison.Ordinal);
    }

    [Fact]
    public void IncreaseViewCountAsync_SourceChecksAffectedRowsBeforeRedisHotRanking()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Services/ArticleService.cs"));
        int methodStart = source.IndexOf("public async ValueTask IncreaseViewCountAsync(int id, int count)", StringComparison.Ordinal);
        int nextMethod = source.IndexOf("public async Task<ArticleListPageReadModel>", StringComparison.Ordinal);
        string method = source[methodStart..nextMethod];

        int affectedAssignment = method.IndexOf("int affectedRows = await _db.Updateable<Article>()", StringComparison.Ordinal);
        int nonDeletedFilter = method.IndexOf(".Where(it => it.Id == id && !it.IsDeleted)", StringComparison.Ordinal);
        int zeroGuard = method.IndexOf("if (affectedRows == 0)", StringComparison.Ordinal);
        int redisRemove = method.IndexOf("SortedSetRemoveAsync", StringComparison.Ordinal);
        int redisIncrement = method.IndexOf("SortedSetIncrementAsync", StringComparison.Ordinal);

        Assert.True(affectedAssignment >= 0);
        Assert.True(nonDeletedFilter > affectedAssignment);
        Assert.True(zeroGuard > nonDeletedFilter);
        Assert.True(redisRemove > zeroGuard);
        Assert.True(redisIncrement > redisRemove);
    }

    [Fact]
    public void ArticleMutations_SourceRecordsTransactionalOutboxEvents()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Services/ArticleService.cs"));

        Assert.Contains("RecordArticleMutationOutboxAsync(id, \"created\")", source, StringComparison.Ordinal);
        Assert.Contains("RecordArticleMutationOutboxAsync(id, \"updated\")", source, StringComparison.Ordinal);
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

        Assert.Contains("FOR UPDATE", articleService, StringComparison.Ordinal);
        Assert.Contains("ux_article_revision_article_revision_no", entities, StringComparison.Ordinal);
    }

    [Fact]
    public void SaveArticleRevisionAsync_SourceUsesAdminPrincipalActor()
    {
        string articleService = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Services/ArticleService.cs"));
        int methodStart = articleService.IndexOf("private async Task SaveArticleRevisionAsync", StringComparison.Ordinal);
        int methodEnd = articleService.IndexOf("private Task RecordArticleMutationOutboxAsync", StringComparison.Ordinal);
        string method = articleService[methodStart..methodEnd];

        Assert.Contains("ResolveRevisionAdminPrincipalId()", articleService, StringComparison.Ordinal);
        Assert.Contains("CreatedByAdminPrincipalId = actorAdminPrincipalId", method, StringComparison.Ordinal);
        Assert.DoesNotContain("GetUserId()", method, StringComparison.Ordinal);
        Assert.DoesNotContain("CreatedByUserId", method, StringComparison.Ordinal);
    }

    [Fact]
    public void IncreaseViewCountsAsync_SourceUsesSingleValuesUpdateAndRedisBatch()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Services/ArticleService.cs"));
        int methodStart = source.IndexOf("public async ValueTask<IReadOnlySet<int>> IncreaseViewCountsAsync", StringComparison.Ordinal);
        int nextMethod = source.IndexOf("public async Task<ArticleListPageReadModel>", StringComparison.Ordinal);
        string method = source[methodStart..nextMethod];

        Assert.Contains("FROM (VALUES", method, StringComparison.Ordinal);
        Assert.Contains("RETURNING a.id", method, StringComparison.Ordinal);
        Assert.Contains("IBatch redisBatch = _redis.CreateBatch()", method, StringComparison.Ordinal);
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
        Assert.Contains("a.createtime < @CursorTime OR (a.createtime = @CursorTime AND a.id < @CursorId)", methodBlock, StringComparison.Ordinal);
        Assert.Contains("ORDER BY a.createtime DESC, a.id DESC", methodBlock, StringComparison.Ordinal);

        int keysetMethod = methodBlock.IndexOf("LoadPublicArticleListPageByKeysetAsync", StringComparison.Ordinal);
        int offset = methodBlock.IndexOf("OFFSET @Offset", StringComparison.Ordinal);
        Assert.True(offset > keysetMethod);
    }

    [Fact]
    public void ArticleEntity_DefinesPublicListStatusTimeIndexes()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Entities/Article.cs"));

        Assert.Contains("idx_article_public_status_time", source, StringComparison.Ordinal);
        Assert.Contains("idx_article_public_category_status_time", source, StringComparison.Ordinal);
        Assert.Contains("nameof(Status), OrderByType.Asc, nameof(CreateTime), OrderByType.Desc", source, StringComparison.Ordinal);
    }
}
