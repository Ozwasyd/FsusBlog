using System.Runtime.CompilerServices;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ParallelOperationsHotPathContractTests
{
    [Fact]
    public void ArticleViewProjection_InvalidatesUpdatedArticlesWithTaskFanout()
    {
        string source = ReadRepoFile("src/backend/Services/VisitLog/ArticleViewProjectionService.cs");
        string apply = ExtractMethodBlock(source, "public async Task ApplyAsync");

        Assert.Contains("InvalidateArticleViewsAsync", apply, StringComparison.Ordinal);
        Assert.DoesNotContain("await dispatcher.InvalidateArticleViewAsync(articleId, cancellationToken)", apply, StringComparison.Ordinal);

        string helper = ExtractMethodBlock(source, "private async Task<int> InvalidateArticleViewsAsync");
        Assert.Contains("maxPerBatchViewInvalidations", helper, StringComparison.Ordinal);
        Assert.Contains("Task.WhenAll", helper, StringComparison.Ordinal);
    }

    [Fact]
    public void MessageCenter_PostCommitFanoutPublishesIndependentStreamsTogether()
    {
        string source = ReadRepoFile("src/backend/Services/NotificationStream/MessageCenterService.cs");

        AssertFanoutMethod(source, "public async Task<Result<ConversationDetailResponse>> CreateAccountTicketAsync");
        AssertFanoutMethod(source, "public async Task<Result<ConversationMessageResponse>> ReplyAsAccountAsync");
        AssertFanoutMethod(source, "public async Task<Result<ConversationDetailResponse>> SendSystemMessageAsync");

        string adminReply = ExtractMethodBlock(source, "public async Task<Result<ConversationMessageResponse>> ReplyAsAdminAsync");
        Assert.Contains("PublishParticipantMessageFanoutAsync", adminReply, StringComparison.Ordinal);
        Assert.DoesNotContain("foreach (var participant in participants)", adminReply, StringComparison.Ordinal);

        string statusUpdate = ExtractMethodBlock(source, "public async Task<Result> UpdateConversationStatusAsync");
        Assert.Contains("Task.WhenAll", statusUpdate, StringComparison.Ordinal);
        Assert.DoesNotContain("foreach (var userId in participants)", statusUpdate, StringComparison.Ordinal);
    }

    [Fact]
    public void AdminOperations_IntegrityLoadsUseNarrowConcurrentProjectionsAndBatchedFixes()
    {
        string source = ReadRepoFile("src/backend/Infrastructure/Operations/AdminOperationsService.cs");
        string observability = ReadRepoFile("src/backend/Infrastructure/Observability/FsusObservability.cs");
        string inspect = ExtractMethodBlock(source, "public async Task<IntegrityReportResponse> InspectIntegrityAsync");
        string preview = ExtractMethodBlock(source, "public async Task<IntegrityFixPreviewResponse> PreviewIntegrityFixAsync");

        Assert.DoesNotContain("LoadIntegrityDataAsync", inspect, StringComparison.Ordinal);
        Assert.DoesNotContain("LoadIntegrityDataAsync", preview, StringComparison.Ordinal);
        Assert.Contains("BuildIntegrityChecksAsync", inspect, StringComparison.Ordinal);
        Assert.Contains("BuildSafeFixDiffsAsync", preview, StringComparison.Ordinal);
        Assert.Contains("RunIntegritySqlCheckAsync", source, StringComparison.Ordinal);
        Assert.Contains("COUNT(*)", source, StringComparison.Ordinal);
        Assert.Contains("LIMIT 10", source, StringComparison.Ordinal);
        Assert.Contains("MaxUntrackedUploadScanFiles", source, StringComparison.Ordinal);
        Assert.Contains("RecordAdminIntegrityCheck", source, StringComparison.Ordinal);
        Assert.Contains("fsus.admin.integrity.check_elapsed_ms", observability, StringComparison.Ordinal);
        Assert.Contains("fsus.admin.integrity.total_count", observability, StringComparison.Ordinal);
        Assert.Contains("fsus.admin.integrity.sample_count", observability, StringComparison.Ordinal);
        Assert.Contains("fsus.admin.integrity.scanned_files", observability, StringComparison.Ordinal);
        Assert.DoesNotContain("Directory.EnumerateFiles(uploadRoot, \"*\", SearchOption.AllDirectories)", source, StringComparison.Ordinal);

        string apply = ExtractMethodBlock(source, "public async Task<IntegrityFixResponse> ApplyIntegrityFixAsync");
        Assert.Contains("DeleteInvalidArticleTagsAsync", apply, StringComparison.Ordinal);
        Assert.Contains("RevokeDeletedUserSessionsAsync", apply, StringComparison.Ordinal);
        Assert.DoesNotContain("LoadIntegrityDataAsync", apply, StringComparison.Ordinal);
        Assert.DoesNotContain("foreach (ArticleTag tag", apply, StringComparison.Ordinal);
        Assert.DoesNotContain("foreach (UserSession session", apply, StringComparison.Ordinal);
        string deleteArticleTagBatch = ExtractMethodBlock(source, "private async Task DeleteArticleTagBatchAsync");
        Assert.Contains("articleid = ", deleteArticleTagBatch, StringComparison.Ordinal);
        Assert.Contains("tagid = ", deleteArticleTagBatch, StringComparison.Ordinal);
        Assert.DoesNotContain("article_id = ", deleteArticleTagBatch, StringComparison.Ordinal);
        Assert.DoesNotContain("tag_id = ", deleteArticleTagBatch, StringComparison.Ordinal);
    }

    [Fact]
    public void AuditQueries_RunCountRowsAndSummaryFacetsInParallel()
    {
        string source = ReadRepoFile("src/backend/Infrastructure/Audit/AuditQueryService.cs");

        string list = ExtractMethodBlock(source, "public async Task<AuditLogListResponse> ListAsync");
        Assert.Contains("Task<int> totalTask", list, StringComparison.Ordinal);
        Assert.Contains("Task<List<AuditLog>> rowsTask", list, StringComparison.Ordinal);
        Assert.Contains("int total = await totalTask", list, StringComparison.Ordinal);
        Assert.Contains("List<AuditLog> rows = await rowsTask", list, StringComparison.Ordinal);
        Assert.DoesNotContain(".Result", list, StringComparison.Ordinal);
        Assert.DoesNotContain("int total = await filtered.CountAsync", list, StringComparison.Ordinal);

        string summary = ExtractMethodBlock(source, "public async Task<AuditLogSummaryResponse> GetSummaryAsync");
        Assert.Contains("int total = await totalTask", summary, StringComparison.Ordinal);
        Assert.Contains("IReadOnlyList<AuditFacetResponse> source = await sourceTask", summary, StringComparison.Ordinal);
        Assert.DoesNotContain(".Result", summary, StringComparison.Ordinal);
    }

    [Fact]
    public void PublicAotBootstrapProviders_ParallelizeIndependentBootstrapInputs()
    {
        string source = ReadRepoFile("src/backend/Infrastructure/PublicAot/PublicAotBootstrapProviders.cs");
        string homeProvider = source[
            source.IndexOf("public sealed class PublicAotHomeBootstrapProvider", StringComparison.Ordinal)..
            source.IndexOf("public sealed class PublicAotArticleDetailBootstrapProvider", StringComparison.Ordinal)];

        Assert.Contains("Task<SeoConfigReadModel> seoTask", source, StringComparison.Ordinal);
        Assert.Contains("Task<SiteComplianceConfigReadModel> complianceTask", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Task.WhenAll", homeProvider, StringComparison.Ordinal);
        Assert.DoesNotContain(".Result", source, StringComparison.Ordinal);
        Assert.Contains("List<PopularArticleSummaryDto> hotArticles = await articleService.GetHotArticlesAsync", homeProvider, StringComparison.Ordinal);
        Assert.True(CountOccurrences(source, "Task<PublicAotSeoSnapshot> seoTask") >= 4, "Expected AOT providers to start independent SEO reads except Home article reads that share one DB scope.");
    }

    [Fact]
    public void ProductionHealth_UsesTypedChecksAndConcurrentPostgresRedisProbe()
    {
        string health = ReadRepoFile("src/backend/Infrastructure/Operations/ProductionHealth.cs");
        string adminOperations = ReadRepoFile("src/backend/Infrastructure/Operations/AdminOperationsService.cs");
        string check = ExtractMethodBlock(health, "public async Task<ProductionHealthReport> CheckAsync");

        Assert.Contains("ProductionDependencyHealthCheck", health, StringComparison.Ordinal);
        Assert.Contains("Task<ProductionDependencyHealthCheck> postgresTask", check, StringComparison.Ordinal);
        Assert.Contains("Task<RedisReadiness> redisTask", check, StringComparison.Ordinal);
        Assert.Contains("checks[\"postgres\"] = await postgresTask", check, StringComparison.Ordinal);
        Assert.Contains("checks[\"redis\"] = redis.Dependency", check, StringComparison.Ordinal);
        Assert.DoesNotContain(".Result", check, StringComparison.Ordinal);
        Assert.DoesNotContain("GetProperty(\"status\"", health, StringComparison.Ordinal);
        Assert.DoesNotContain("ExtractProperty(check", adminOperations, StringComparison.Ordinal);
    }

    [Fact]
    public void ProductionReadinessProbe_ParallelizesChecksAndReusesRedisReadiness()
    {
        string health = ReadRepoFile("src/backend/Infrastructure/Operations/ProductionHealth.cs");
        string observability = ReadRepoFile("src/backend/Infrastructure/Observability/FsusObservability.cs");
        string check = ExtractMethodBlock(health, "public async Task<ProductionHealthReport> CheckAsync");
        string riskControl = ExtractMethodBlock(health, "private async Task<ProductionRiskControlHealthCheck> CheckRiskControlAsync");

        Assert.Contains("Task<RuntimeHealthSnapshot> runtimeTask", check, StringComparison.Ordinal);
        Assert.Contains("Task<ProductionRiskControlHealthCheck> riskControlTask", check, StringComparison.Ordinal);
        Assert.Contains("await Task.WhenAll(postgresTask, redisTask, riskControlTask, runtimeTask)", check, StringComparison.Ordinal);
        Assert.Contains("RecordReadinessCheckElapsed(\"postgres\"", check, StringComparison.Ordinal);
        Assert.Contains("RecordReadinessCheckElapsed(\"redis\"", check, StringComparison.Ordinal);
        Assert.Contains("RecordReadinessCheckElapsed(\"risk_control\"", check, StringComparison.Ordinal);
        Assert.Contains("RecordReadinessCheckElapsed(\"runtime\"", check, StringComparison.Ordinal);

        Assert.Contains("RedisReadiness", health, StringComparison.Ordinal);
        Assert.Contains("Task<RedisReadiness> redisTask", check, StringComparison.Ordinal);
        Assert.Contains("Task<RedisReadiness> redisTask", riskControl, StringComparison.Ordinal);
        Assert.Contains("redisReadiness.ConsumeOnce.Ok", riskControl, StringComparison.Ordinal);
        Assert.Contains("private async Task<RedisReadiness> CheckRedisReadinessAsync", health, StringComparison.Ordinal);
        Assert.DoesNotContain("await CheckRedisConsumeOnceAsync(cancellationToken)", riskControl, StringComparison.Ordinal);

        Assert.Contains("private async Task<RuntimeHealthSnapshot> CheckRuntimeAsync", health, StringComparison.Ordinal);
        Assert.Contains("Task<PublicHotReadRuntimeSnapshot?> publicHotReadTask", health, StringComparison.Ordinal);
        Assert.Contains("Task<AuditLogRuntimeSnapshot?> auditLogTask", health, StringComparison.Ordinal);
        Assert.Contains("Task<RuntimePressureSnapshot> pressureTask", health, StringComparison.Ordinal);

        Assert.Contains("IConfigurationHealthSnapshot", health, StringComparison.Ordinal);
        Assert.Contains("configurationSnapshot", health, StringComparison.Ordinal);
        Assert.DoesNotContain("ProductionStartupValidator.ValidateCore(", ExtractMethodBlock(health, "private ProductionConfigurationHealthCheck CheckConfiguration"), StringComparison.Ordinal);

        Assert.Contains("fsus.readiness.check.elapsed", observability, StringComparison.Ordinal);
        Assert.Contains("fsus.readiness.postgres.elapsed", observability, StringComparison.Ordinal);
        Assert.Contains("fsus.readiness.redis.elapsed", observability, StringComparison.Ordinal);
        Assert.Contains("fsus.readiness.risk_control.elapsed", observability, StringComparison.Ordinal);
        Assert.Contains("fsus.readiness.runtime.elapsed", observability, StringComparison.Ordinal);
    }

    [Fact]
    public void CacheInitializer_LoadsRollbackBanStateWithBoundedTaskBatch()
    {
        string source = ReadRepoFile("src/backend/Infrastructure/Helpers/Initializer/CacheInitializer.cs");
        string initialize = ExtractMethodBlock(source, "public async Task<CacheInitializationResult> InitializeAsync");

        Assert.Contains("LoadRollbackEntriesAsync", initialize, StringComparison.Ordinal);
        Assert.DoesNotContain("await _blacklist.GetBanStateAsync(user.Id)", initialize, StringComparison.Ordinal);
        Assert.DoesNotContain("user.Id.ToString()", initialize, StringComparison.Ordinal);
        Assert.Contains("AccountSubjectHash", source, StringComparison.Ordinal);
        Assert.Contains("BuildAccountSubjectCacheKey", source, StringComparison.Ordinal);

        string helper = ExtractMethodBlock(source, "private async Task<List<CacheInitializationRollbackEntry>> LoadRollbackEntriesAsync");
        Assert.Contains("Task.WhenAll", helper, StringComparison.Ordinal);
        Assert.Contains("BatchSize", helper, StringComparison.Ordinal);
        Assert.DoesNotContain("int userId = bannedUsers[i + j].Id", helper, StringComparison.Ordinal);
    }

    [Fact]
    public void StartupValidation_CachesReadinessCoreValidationWithReloadAwareness()
    {
        string source = ReadRepoFile("src/backend/Infrastructure/Operations/ProductionStartupValidator.cs");
        string validateCore = ExtractMethodBlock(source, "internal static IReadOnlyList<string> ValidateCore");

        Assert.Contains("CreateCachedValidationReport", validateCore, StringComparison.Ordinal);
        Assert.Contains("CoreValidationCacheTtl", source, StringComparison.Ordinal);
        Assert.Contains("GetReloadToken()", source, StringComparison.Ordinal);
        Assert.Contains("s_coreValidationCache", source, StringComparison.Ordinal);
        Assert.DoesNotContain("=> CreateValidationReport(configuration, enforceProductionRules).Errors", source, StringComparison.Ordinal);
    }

    private static void AssertFanoutMethod(string source, string signature)
    {
        string method = ExtractMethodBlock(source, signature);
        Assert.Contains("Task.WhenAll", method, StringComparison.Ordinal);
        Assert.DoesNotContain("await PublishConversationUpsertAsync", method, StringComparison.Ordinal);
        Assert.DoesNotContain("await PublishMessageAppendAsync", method, StringComparison.Ordinal);
        Assert.DoesNotContain("await PublishConversationUpsertToAdminsAsync", method, StringComparison.Ordinal);
    }

    private static string ReadRepoFile(string relativePath, [CallerFilePath] string sourceFile = "")
        => File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, relativePath));

    private static int CountOccurrences(string source, string value)
    {
        int count = 0;
        int start = 0;
        while (start < source.Length)
        {
            int index = source.IndexOf(value, start, StringComparison.Ordinal);
            if (index < 0)
            {
                return count;
            }

            count++;
            start = index + value.Length;
        }

        return count;
    }

    private static string ExtractMethodBlock(string source, string signature)
    {
        int start = source.IndexOf(signature, StringComparison.Ordinal);
        Assert.True(start >= 0, $"Unable to locate method signature: {signature}");
        int braceStart = source.IndexOf('{', start);
        Assert.True(braceStart > start, $"Unable to locate method body: {signature}");

        int depth = 0;
        for (int i = braceStart; i < source.Length; i++)
        {
            if (source[i] == '{')
            {
                depth++;
            }
            else if (source[i] == '}')
            {
                depth--;
                if (depth == 0)
                {
                    return source[start..(i + 1)];
                }
            }
        }

        throw new InvalidOperationException($"Unable to extract method body: {signature}");
    }
}
