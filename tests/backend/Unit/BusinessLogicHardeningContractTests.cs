using System.Runtime.CompilerServices;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class BusinessLogicHardeningContractTests
{
    [Fact]
    public void ArticleMutationPaths_DoNotBypassDeleteOrRepublishOnRestore()
    {
        string source = ReadSource("src/backend/Services/ArticleService.cs");
        string update = ExtractBetween(source, "public async Task<bool> UpdateAsync", "private async Task<ArticleUpdateState?> LoadArticleUpdateStateAsync");
        string delete = ExtractBetween(source, "public async Task<bool> DeleteAsync", "public async Task<bool> RestoreAsync");
        string restore = ExtractBetween(source, "public async Task<bool> RestoreAsync", "public async Task<bool> PermanentlyDeleteArticleAsync");

        Assert.Contains("if (dto.Status == ArticleStatus.Deleted)", update, StringComparison.Ordinal);
        Assert.DoesNotContain("status == ArticleStatus.Deleted ? now : null", update, StringComparison.Ordinal);
        Assert.Contains("AND isdeleted = false", delete, StringComparison.Ordinal);
        Assert.Contains("AND isdeleted = true", restore, StringComparison.Ordinal);
        Assert.Contains("status = @Status", restore, StringComparison.Ordinal);
        Assert.Contains("new SugarParameter(\"@Status\", (int)ArticleStatus.Draft)", restore, StringComparison.Ordinal);
        Assert.DoesNotContain(".SetColumns(it => it.Status == ArticleStatus.Published)", restore, StringComparison.Ordinal);
        Assert.DoesNotContain(".SetColumns(it => it.PublishedAt == now)", restore, StringComparison.Ordinal);
    }

    [Fact]
    public void CommentMutationPaths_InvalidateAfterAutoDispositionAndDeleteUnderLock()
    {
        string source = ReadSource("src/backend/Services/CommentService.cs");
        string create = ExtractBetween(source, "private async Task<bool> CreateResolvedCommentAsync", "private async Task<bool> LockVisibleCommentTargetAsync");
        string delete = ExtractBetween(source, "private async Task<bool> DeleteCommentInternalAsync", "private async Task<DeleteCommentRow?> LoadDeleteCommentRowAsync");
        string load = ExtractBetween(source, "private async Task<DeleteCommentRow?> LoadDeleteCommentRowAsync", "private async Task<bool> TrySoftDeleteCommentAsync");

        Assert.True(
            create.IndexOf("ApplyAutomaticModerationDispositionAsync", StringComparison.Ordinal) <
            create.IndexOf("InvalidateCommentMutationAsync", StringComparison.Ordinal),
            "comment cache invalidation must use the post-disposition moderation status.");
        Assert.Contains("db.Ado.UseTranAsync", delete, StringComparison.Ordinal);
        Assert.Contains("FOR UPDATE", load, StringComparison.Ordinal);
        Assert.Contains("a.isdeleted = false", load, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void AccountBanState_ProtectsDeletedUsersAndStableDbBans()
    {
        string source = ReadSource("src/backend/Services/Security/BlacklistService.cs");
        string ban = ExtractBetween(source, "public async Task BanUserAsync", "public async Task UnbanUserAsync");
        string unban = ExtractBetween(source, "public async Task UnbanUserAsync", "public async Task<BanStateSnapshot> GetBanStateAsync");
        string get = ExtractBetween(source, "public async Task<BanStateSnapshot> GetBanStateAsync", "internal static string BuildAccountSubjectCacheKey");

        Assert.Contains("u.Status != UserStatusDeleted", ban, StringComparison.Ordinal);
        Assert.DoesNotContain("u.Status != 2", ban, StringComparison.Ordinal);
        Assert.Contains("u.DeletedAt == null", unban, StringComparison.Ordinal);
        Assert.Contains("return snapshot;", get, StringComparison.Ordinal);
        Assert.DoesNotContain("!string.Equals(row.CacheKey, cacheKey", get, StringComparison.Ordinal);
    }

    [Fact]
    public void SecurityChallengeAttempts_DoNotDowngradeTerminalStatus()
    {
        string source = ReadSource("src/backend/Services/Security/SecurityChallengePersistenceService.cs");
        string record = ExtractBetween(source, "public async Task<SecurityChallengeAttempt> RecordAttemptAsync", "public async Task<bool> ExpireAsync");

        Assert.Contains("ReadChallengeMetricContextAsync", record, StringComparison.Ordinal);
        Assert.Contains("status NOT IN ('verified', 'revoked', 'expired')", source, StringComparison.Ordinal);
        Assert.Contains("CASE WHEN status NOT IN", source, StringComparison.Ordinal);
    }

    [Fact]
    public void SearchPolicyCrawlerAndFilterFallbacks_FailPredictably()
    {
        string search = ReadSource("src/backend/Services/SearchIndexService.cs");
        string policy = ReadSource("src/backend/Services/Security/AnonymousCommentPolicyService.cs");
        string crawler = ReadSource("src/backend/Services/Security/CrawlerDetectorService.cs");
        string filter = ReadSource("src/backend/Services/Security/ContentFilterService.cs");

        Assert.Contains("NormalizeKeywordForFallback", search, StringComparison.Ordinal);
        Assert.Contains("_runtimeSnapshot = null", search, StringComparison.Ordinal);
        Assert.Contains("_current = null", policy, StringComparison.Ordinal);
        Assert.Contains("TimeSpan.FromHours(1) : TimeSpan.FromMinutes(15)", crawler, StringComparison.Ordinal);
        Assert.Contains("NormalizeCrawlerUserAgent", crawler, StringComparison.Ordinal);
        Assert.Contains("NormalizeUserAgentRune", crawler, StringComparison.Ordinal);
        Assert.Contains("GetHostAddressesAsync", crawler, StringComparison.Ordinal);
        Assert.Contains("GetGlobalHardFilterTerms", filter, StringComparison.Ordinal);
        Assert.Contains("lock (_ruleReloadLock)", filter, StringComparison.Ordinal);
    }

    [Fact]
    public void CommentCursorPolicies_AreResolvedThroughConfigurableProvider()
    {
        string policies = ReadSource("src/backend/Services/CommentCursorPolicies.cs");
        string endpoints = ReadSource("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs");
        string gateway = ReadSource("src/backend/Infrastructure/CoreBridge/Gateways/CommentCoreGateway.cs");
        string services = ReadSource("src/backend/Infrastructure/Bootstrap/RuntimeDomainServiceCollectionExtensions.cs");

        Assert.Contains("ICommentCursorPolicyResolver", policies, StringComparison.Ordinal);
        Assert.Contains("IConfiguration", policies, StringComparison.Ordinal);
        Assert.Contains("CommentCursorPolicies:Tenants", policies, StringComparison.Ordinal);
        Assert.Contains("CommentCursorPolicyKind.Threads", endpoints, StringComparison.Ordinal);
        Assert.Contains("CommentCursorPolicyKind.Replies", endpoints, StringComparison.Ordinal);
        Assert.Contains("CommentCursorPolicyKind.UserComments", endpoints, StringComparison.Ordinal);
        Assert.Contains("ICommentCursorPolicyResolver cursorPolicies", gateway, StringComparison.Ordinal);
        Assert.Contains("services.AddSingleton<ICommentCursorPolicyResolver", services, StringComparison.Ordinal);
    }

    [Fact]
    public void LegacyArticleViewSeedAndChallengeIssueContracts_DoNotLeakRuntimeState()
    {
        string articleViewSeed = ReadSource("src/backend/Entities/ArticleViewSeed.cs");
        string orchestrator = ReadSource("src/backend/Services/Security/SecurityChallengeOrchestrator.cs");
        string securityDocs = ReadSource("docs/security.md");
        string architectureDocs = ReadSource("docs/architecture.md");

        Assert.Contains("backfill-only", articleViewSeed, StringComparison.Ordinal);
        Assert.Contains("Provider IssueAsync must persist", orchestrator, StringComparison.Ordinal);
        Assert.True(
            orchestrator.IndexOf("provider.IssueAsync", StringComparison.Ordinal) <
            orchestrator.IndexOf("new SecurityChallengeEnvelope", StringComparison.Ordinal),
            "orchestrator must only build the envelope after provider issue returned.");
        Assert.Contains("ArticleViewSeed", architectureDocs, StringComparison.Ordinal);
        Assert.Contains("provider 必须先持久化 challenge", securityDocs, StringComparison.Ordinal);
    }

    private static string ReadSource(string relativePath, [CallerFilePath] string sourceFilePath = "")
        => File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, relativePath));

    private static string ExtractBetween(string source, string start, string end)
    {
        int startIndex = source.IndexOf(start, StringComparison.Ordinal);
        Assert.True(startIndex >= 0, $"Missing start marker: {start}");
        int endIndex = source.IndexOf(end, startIndex, StringComparison.Ordinal);
        Assert.True(endIndex >= 0, $"Missing end marker: {end}");
        return source[startIndex..endIndex];
    }
}
