using System.Runtime.CompilerServices;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicContentInvalidationFlowTests
{
    [Fact]
    public void OutboxReplay_InvalidatesPublicAotBeforeReplayingSideEffects()
    {
        string source = ReadRepoFile("src/backend/Services/Background/ArticleMutationOutboxDispatcher.cs");
        string method = Slice(source, "private async Task<bool> ProcessOneAsync", "private static async Task<ArticleMutationAotScope>");

        Assert.Contains("IPublicAotInvalidationService publicAotInvalidation", source, StringComparison.Ordinal);
        Assert.Contains("LoadAotScopeAsync", source, StringComparison.Ordinal);
        Assert.Contains("publicAotInvalidation.InvalidateArticleMutationAsync", method, StringComparison.Ordinal);

        int aotInvalidation = method.IndexOf("publicAotInvalidation.InvalidateArticleMutationAsync", StringComparison.Ordinal);
        int cacheInvalidation = method.IndexOf("cacheInvalidation.InvalidateArticleMutationAsync", StringComparison.Ordinal);
        int replay = method.IndexOf("coordinator.ReplayOutboxAsync", StringComparison.Ordinal);

        Assert.True(aotInvalidation >= 0);
        Assert.True(cacheInvalidation > aotInvalidation);
        Assert.True(replay > cacheInvalidation);
    }

    [Fact]
    public void OutboxReplay_UsesExplicitResultBeforeMarkingProcessed()
    {
        string sideEffects = ReadRepoFile("src/backend/Services/ArticleMutationSideEffects.cs");
        string dispatcher = ReadRepoFile("src/backend/Services/Background/ArticleMutationOutboxDispatcher.cs");
        string replayMethod = Slice(sideEffects, "public async Task<ArticleMutationReplayResult> ReplayOutboxAsync", "    private async Task<Article?> LoadArticleWithContentAsync");
        string processOne = Slice(dispatcher, "private async Task<bool> ProcessOneAsync", "private static async Task<ArticleMutationAotScope>");

        Assert.Contains("public sealed record ArticleMutationReplayResult", sideEffects, StringComparison.Ordinal);
        Assert.Contains("Task<ArticleMutationReplayResult> ReplayOutboxAsync", sideEffects, StringComparison.Ordinal);
        Assert.DoesNotContain("BoundaryExecutor.ExecuteAsync", replayMethod, StringComparison.Ordinal);
        Assert.Contains("ArticleMutationReplayResult replay = await coordinator.ReplayOutboxAsync", processOne, StringComparison.Ordinal);
        Assert.Contains("if (!replay.IsSuccess)", processOne, StringComparison.Ordinal);
        Assert.Contains("return await MarkRetryAsync", processOne, StringComparison.Ordinal);
        Assert.Contains("\"article-outbox-retry\"", dispatcher, StringComparison.Ordinal);
        Assert.Contains(".SetColumns(e => e.RetryCount == nextRetryCount)", dispatcher, StringComparison.Ordinal);
        Assert.Contains(".SetColumns(e => e.NextRetryAt == nextRetryAt)", dispatcher, StringComparison.Ordinal);
        Assert.Contains(".SetColumns(e => e.LastError == lastError)", dispatcher, StringComparison.Ordinal);

        int replay = processOne.IndexOf("ArticleMutationReplayResult replay = await coordinator.ReplayOutboxAsync", StringComparison.Ordinal);
        int resultGuard = processOne.IndexOf("if (!replay.IsSuccess)", StringComparison.Ordinal);
        int complete = processOne.IndexOf("\"article-outbox-complete\"", StringComparison.Ordinal);
        Assert.True(replay >= 0);
        Assert.True(resultGuard > replay);
        Assert.True(complete > resultGuard);
    }

    [Fact]
    public void ScheduledPublish_InvalidatesPublicAotForNewlyPublishedArticles()
    {
        string source = ReadRepoFile("src/backend/Services/Background/ScheduledPublishWorker.cs");
        string method = Slice(source, "internal async Task<int> PublishDueArticlesAsync", "        finally");

        Assert.Contains("IPublicAotInvalidationService publicAotInvalidation", source, StringComparison.Ordinal);
        Assert.Contains(".OrderBy(article => new { article.ScheduledPublishAt, article.Id })", method, StringComparison.Ordinal);
        Assert.Contains("\"scheduled-publish-body-batch-query\"", method, StringComparison.Ordinal);
        Assert.Contains("\"scheduled-publish-tags-batch-query\"", method, StringComparison.Ordinal);
        Assert.DoesNotContain("\"scheduled-publish-body-query\"", method, StringComparison.Ordinal);
        Assert.DoesNotContain("\"scheduled-publish-tags-query\"", method, StringComparison.Ordinal);
        Assert.Contains("publicAotInvalidation.InvalidateArticleMutationAsync", method, StringComparison.Ordinal);

        int searchProjection = method.IndexOf("searchIndex.AddOrUpdateIndexAsync(article)", StringComparison.Ordinal);
        int aotInvalidation = method.IndexOf("publicAotInvalidation.InvalidateArticleMutationAsync", StringComparison.Ordinal);
        int cacheInvalidation = method.IndexOf("invalidation.InvalidateArticleMutationAsync(article.Id", StringComparison.Ordinal);

        Assert.True(searchProjection >= 0);
        Assert.True(aotInvalidation > searchProjection);
        Assert.True(cacheInvalidation > aotInvalidation);
    }

    [Fact]
    public void AdminAotRebuild_InvalidatesAotBeforeQueueingPublicHotRead()
    {
        string source = ReadRepoFile("src/backend/Infrastructure/Operations/AdminOperationsService.cs");
        string method = Slice(source, "public async Task<AdminCacheActionResponse> RunCacheActionAsync", "public async Task<IntegrityReportResponse>");

        Assert.Contains("IPublicAotInvalidationService publicAotInvalidationService", source, StringComparison.Ordinal);
        Assert.Contains("publicAotInvalidationService.InvalidateArticleMutationAsync", method, StringComparison.Ordinal);
        Assert.Contains("publicAotInvalidationService.InvalidateAllAsync", method, StringComparison.Ordinal);

        int aotAll = method.IndexOf("publicAotInvalidationService.InvalidateAllAsync", StringComparison.Ordinal);
        int publicHotQueue = method.IndexOf("publicHotArtifactUpdateQueue.TryEnqueue", StringComparison.Ordinal);

        Assert.True(aotAll >= 0);
        Assert.True(publicHotQueue > aotAll);
    }

    [Fact]
    public void RedisBackedPublicAotInvalidateAll_SkipsPerMemberRegistryUnregister()
    {
        string source = ReadRepoFile("src/backend/Infrastructure/PublicAot/PublicAotShellCache.cs");
        string invalidateAll = Slice(source, "public async Task InvalidateAllAsync", "    private static string ResolveRegistryKey");
        string removeMany = Slice(source, "private async Task RemoveManyCacheEntriesAsync", "    public async Task RemoveByPrefixAsync");

        Assert.Contains("bool unregisterKeys = true", removeMany, StringComparison.Ordinal);
        Assert.Contains("if (unregisterKeys)", removeMany, StringComparison.Ordinal);
        Assert.Contains("unregisterKeys: false", invalidateAll, StringComparison.Ordinal);

        int removeDocuments = invalidateAll.IndexOf("RemoveManyCacheEntriesAsync(keysToDelete, cancellationToken, unregisterKeys: false)", StringComparison.Ordinal);
        int removeRegistries = invalidateAll.IndexOf("_db.KeyDeleteAsync(registryKeys)", StringComparison.Ordinal);
        Assert.True(removeDocuments >= 0);
        Assert.True(removeRegistries > removeDocuments);
    }

    private static string Slice(string source, string startMarker, string endMarker)
    {
        int start = source.IndexOf(startMarker, StringComparison.Ordinal);
        Assert.True(start >= 0, $"start marker not found: {startMarker}");
        int end = source.IndexOf(endMarker, start + startMarker.Length, StringComparison.Ordinal);
        Assert.True(end > start, $"end marker not found: {endMarker}");
        return source[start..end];
    }

    private static string ReadRepoFile(string relativePath, [CallerFilePath] string sourceFile = "")
        => File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, relativePath));
}
