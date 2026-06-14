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

        AssertFanoutMethod(source, "public async Task<Result<ConversationDetailResponse>> CreateUserTicketAsync");
        AssertFanoutMethod(source, "public async Task<Result<ConversationMessageResponse>> ReplyAsUserAsync");
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
        string load = ExtractMethodBlock(source, "private async Task<IntegrityData> LoadIntegrityDataAsync");

        Assert.Contains("Task.WhenAll", load, StringComparison.Ordinal);
        Assert.Contains("IntegrityArticleRow", source, StringComparison.Ordinal);
        Assert.Contains("Select(article => new IntegrityArticleRow", load, StringComparison.Ordinal);
        Assert.DoesNotContain("List<Article> articles = await", load, StringComparison.Ordinal);
        Assert.DoesNotContain("Queryable<Article>().ToListAsync", load, StringComparison.Ordinal);
        Assert.DoesNotContain("Queryable<User>().ToListAsync", load, StringComparison.Ordinal);

        string apply = ExtractMethodBlock(source, "public async Task<IntegrityFixResponse> ApplyIntegrityFixAsync");
        Assert.Contains("DeleteInvalidArticleTagsAsync", apply, StringComparison.Ordinal);
        Assert.Contains("RevokeDeletedUserSessionsAsync", apply, StringComparison.Ordinal);
        Assert.DoesNotContain("foreach (ArticleTag tag", apply, StringComparison.Ordinal);
        Assert.DoesNotContain("foreach (UserSession session", apply, StringComparison.Ordinal);

        Assert.Contains("ActiveUserIds", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Users.Any(user =>", source, StringComparison.Ordinal);
    }

    [Fact]
    public void AuditQueries_RunCountRowsAndSummaryFacetsInParallel()
    {
        string source = ReadRepoFile("src/backend/Infrastructure/Audit/AuditQueryService.cs");

        string list = ExtractMethodBlock(source, "public async Task<AuditLogListResponse> ListAsync");
        Assert.Contains("Task<int> totalTask", list, StringComparison.Ordinal);
        Assert.Contains("Task<List<AuditLog>> rowsTask", list, StringComparison.Ordinal);
        Assert.Contains("Task.WhenAll(totalTask, rowsTask)", list, StringComparison.Ordinal);
        Assert.DoesNotContain("int total = await filtered.CountAsync", list, StringComparison.Ordinal);

        string summary = ExtractMethodBlock(source, "public async Task<AuditLogSummaryResponse> GetSummaryAsync");
        Assert.Contains("Task.WhenAll(totalTask, sourceTask, actionTask, outcomeTask, severityTask)", summary, StringComparison.Ordinal);
        Assert.DoesNotContain("await BuildSourceFacetAsync", summary, StringComparison.Ordinal);
        Assert.DoesNotContain("await BuildActionFacetAsync", summary, StringComparison.Ordinal);
    }

    [Fact]
    public void PublicAotBootstrapProviders_ParallelizeIndependentBootstrapInputs()
    {
        string source = ReadRepoFile("src/backend/Infrastructure/PublicAot/PublicAotBootstrapProviders.cs");

        Assert.Contains("Task<SeoConfigReadModel> seoTask", source, StringComparison.Ordinal);
        Assert.Contains("Task<SiteComplianceConfigReadModel> complianceTask", source, StringComparison.Ordinal);
        Assert.Contains("Task.WhenAll(seoTask, complianceTask)", source, StringComparison.Ordinal);
        Assert.True(CountOccurrences(source, "Task.WhenAll") >= 5, "Expected AOT providers to fan out independent SEO/page/article/archive reads.");
    }

    [Fact]
    public void ProductionHealth_UsesTypedChecksAndConcurrentPostgresRedisProbe()
    {
        string health = ReadRepoFile("src/backend/Infrastructure/Operations/ProductionHealth.cs");
        string adminOperations = ReadRepoFile("src/backend/Infrastructure/Operations/AdminOperationsService.cs");
        string check = ExtractMethodBlock(health, "public async Task<ProductionHealthReport> CheckAsync");

        Assert.Contains("ProductionDependencyHealthCheck", health, StringComparison.Ordinal);
        Assert.Contains("Task<ProductionDependencyHealthCheck> postgresTask", check, StringComparison.Ordinal);
        Assert.Contains("Task<ProductionDependencyHealthCheck> redisTask", check, StringComparison.Ordinal);
        Assert.Contains("Task.WhenAll(postgresTask, redisTask)", check, StringComparison.Ordinal);
        Assert.DoesNotContain("GetProperty(\"status\"", health, StringComparison.Ordinal);
        Assert.DoesNotContain("ExtractProperty(check", adminOperations, StringComparison.Ordinal);
    }

    [Fact]
    public void CacheInitializer_LoadsRollbackBanStateWithBoundedTaskBatch()
    {
        string source = ReadRepoFile("src/backend/Infrastructure/Helpers/Initializer/CacheInitializer.cs");
        string initialize = ExtractMethodBlock(source, "public async Task<CacheInitializationResult> InitializeAsync");

        Assert.Contains("LoadRollbackEntriesAsync", initialize, StringComparison.Ordinal);
        Assert.DoesNotContain("await _blacklist.GetBanStateAsync(user.Id)", initialize, StringComparison.Ordinal);

        string helper = ExtractMethodBlock(source, "private async Task<List<CacheInitializationRollbackEntry>> LoadRollbackEntriesAsync");
        Assert.Contains("Task.WhenAll", helper, StringComparison.Ordinal);
        Assert.Contains("BatchSize", helper, StringComparison.Ordinal);
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

    private static string ReadRepoFile(string relativePath)
        => File.ReadAllText(Path.Combine(FindRepoRoot(), relativePath));

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

    private static string FindRepoRoot()
    {
        string current = AppContext.BaseDirectory;
        while (!string.IsNullOrWhiteSpace(current))
        {
            if (File.Exists(Path.Combine(current, "FsusBlog.slnx")))
            {
                return current;
            }

            DirectoryInfo? parent = Directory.GetParent(current);
            if (parent is null)
            {
                break;
            }

            current = parent.FullName;
        }

        throw new DirectoryNotFoundException("Unable to locate repository root.");
    }
}
