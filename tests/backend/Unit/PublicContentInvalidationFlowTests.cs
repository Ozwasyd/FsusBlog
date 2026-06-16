using System.Runtime.CompilerServices;

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
        => File.ReadAllText(Path.Combine(FindRepoRoot(sourceFile), relativePath));

    private static string FindRepoRoot(string sourceFile)
    {
        DirectoryInfo? current = new(Path.GetDirectoryName(sourceFile) ?? AppContext.BaseDirectory);
        while (current is not null)
        {
            if (File.Exists(Path.Combine(current.FullName, "FsusBlog.slnx")))
            {
                return current.FullName;
            }

            current = current.Parent;
        }

        throw new DirectoryNotFoundException("repo root not found");
    }
}
