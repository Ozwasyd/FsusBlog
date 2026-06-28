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
        Assert.Contains("retry_count = retry_count + 1", dispatcher, StringComparison.Ordinal);
        Assert.Contains("retry_count = @ExpectedRetryCount", dispatcher, StringComparison.Ordinal);
        Assert.Contains("status = 'processing'", dispatcher, StringComparison.Ordinal);
        Assert.Contains("if (updatedRows == 0)", dispatcher, StringComparison.Ordinal);
        Assert.DoesNotContain(".SetColumns(e => e.RetryCount == nextRetryCount)", dispatcher, StringComparison.Ordinal);

        int replay = processOne.IndexOf("ArticleMutationReplayResult replay = await coordinator.ReplayOutboxAsync", StringComparison.Ordinal);
        int resultGuard = processOne.IndexOf("if (!replay.IsSuccess)", StringComparison.Ordinal);
        int complete = processOne.IndexOf("\"article-outbox-complete\"", StringComparison.Ordinal);
        Assert.True(replay >= 0);
        Assert.True(resultGuard > replay);
        Assert.True(complete > resultGuard);
    }

    [Fact]
    public void OutboxReplay_TracksRequiredEdgesBeforeMarkingEventProcessed()
    {
        string entities = ReadRepoFile("src/backend/Entities/Article.cs");
        string migrations = ReadRepoFile("src/backend/Infrastructure/SchemaMigration/SchemaMigrationRegistry.cs");
        string sideEffects = ReadRepoFile("src/backend/Services/ArticleMutationSideEffects.cs");
        string dispatcher = ReadRepoFile("src/backend/Services/Background/ArticleMutationOutboxDispatcher.cs");
        string processOne = Slice(dispatcher, "private async Task<bool> ProcessOneAsync", "private static async Task<ArticleMutationAotScope>");

        Assert.Contains("public class ArticleMutationOutboxEdge", entities, StringComparison.Ordinal);
        Assert.Contains("[SugarTable(\"article_mutation_outbox_edge\")]", entities, StringComparison.Ordinal);
        Assert.Contains("OutboxEventId", entities, StringComparison.Ordinal);
        Assert.Contains("EdgeName", entities, StringComparison.Ordinal);
        Assert.Contains("AttemptCount", entities, StringComparison.Ordinal);
        Assert.Contains("LastError", entities, StringComparison.Ordinal);
        Assert.Contains("UpdatedAt", entities, StringComparison.Ordinal);

        Assert.Contains("CREATE TABLE IF NOT EXISTS article_mutation_outbox_edge", migrations, StringComparison.Ordinal);
        Assert.Contains("ux_article_mutation_outbox_edge_event_name", migrations, StringComparison.Ordinal);

        Assert.Contains("public static class ArticleMutationReplayEdges", sideEffects, StringComparison.Ordinal);
        Assert.Contains("SearchProjection = \"search-projection\"", sideEffects, StringComparison.Ordinal);
        Assert.Contains("ArticleDetailAeds = \"article-detail-aeds\"", sideEffects, StringComparison.Ordinal);
        Assert.Contains("PublicHotRead = \"public-hot-read\"", sideEffects, StringComparison.Ordinal);
        Assert.Contains("IReadOnlySet<string> completedEdges", sideEffects, StringComparison.Ordinal);
        Assert.Contains("IReadOnlySet<string> CompletedEdges", sideEffects, StringComparison.Ordinal);
        Assert.Contains("IReadOnlyDictionary<string, string> FailedEdges", sideEffects, StringComparison.Ordinal);

        Assert.Contains("LoadCompletedEdgesAsync", processOne, StringComparison.Ordinal);
        Assert.Contains("coordinator.ReplayOutboxAsync(item.AggregateId, item.EventType, completedEdges", processOne, StringComparison.Ordinal);
        Assert.Contains("RecordReplayEdgesAsync", processOne, StringComparison.Ordinal);
        Assert.Contains("ArticleMutationReplayEdges.Required.All(completedAfterReplay.Contains)", processOne, StringComparison.Ordinal);
        Assert.Contains("!requiredEdgesComplete", processOne, StringComparison.Ordinal);
        Assert.Contains("return await MarkRetryAsync", processOne, StringComparison.Ordinal);
        Assert.Contains("\"article-outbox-edge-complete\"", dispatcher, StringComparison.Ordinal);
        Assert.Contains("\"article-outbox-edge-failed\"", dispatcher, StringComparison.Ordinal);

        int loadEdges = processOne.IndexOf("LoadCompletedEdgesAsync", StringComparison.Ordinal);
        int replay = processOne.IndexOf("ArticleMutationReplayResult replay = await coordinator.ReplayOutboxAsync", StringComparison.Ordinal);
        int recordEdges = processOne.IndexOf("RecordReplayEdgesAsync", StringComparison.Ordinal);
        int requiredGuard = processOne.IndexOf("!requiredEdgesComplete", StringComparison.Ordinal);
        int complete = processOne.IndexOf("\"article-outbox-complete\"", StringComparison.Ordinal);
        Assert.True(loadEdges >= 0);
        Assert.True(replay > loadEdges);
        Assert.True(recordEdges > replay);
        Assert.True(requiredGuard > recordEdges);
        Assert.True(complete > requiredGuard);
    }

    [Fact]
    public void OutboxReplay_TreatsPublicHotEnqueueFailureAsRequiredEdgeFailure()
    {
        string queue = ReadRepoFile("src/backend/Infrastructure/PublicReadArtifacts/PublicHotArtifactUpdateQueue.cs");
        string sideEffects = ReadRepoFile("src/backend/Services/ArticleMutationSideEffects.cs");
        string replayMethod = Slice(sideEffects, "public async Task<ArticleMutationReplayResult> ReplayOutboxAsync", "    private async Task<Article?> LoadArticleWithContentAsync");
        string queueMethod = Slice(sideEffects, "private Task<PublicHotArtifactEnqueueResult> QueuePublicHotUpdateAsync", "    private async Task EnsurePublicHotUpdateQueuedAsync");
        string ensureMethod = Slice(sideEffects, "private async Task EnsurePublicHotUpdateQueuedAsync", "}");

        Assert.Contains("public readonly record struct PublicHotArtifactEnqueueResult", queue, StringComparison.Ordinal);
        Assert.Contains("public PublicHotArtifactEnqueueResult Enqueue", queue, StringComparison.Ordinal);
        Assert.Contains("BoundedChannelFullMode.Wait", queue, StringComparison.Ordinal);
        Assert.Contains("queue-full-or-closed", queue, StringComparison.Ordinal);

        Assert.Contains("PublicHotArtifactEnqueueResult result = publicHotUpdates.Enqueue", queueMethod, StringComparison.Ordinal);
        Assert.Contains("required ? \"required\" : \"best-effort\"", queueMethod, StringComparison.Ordinal);
        Assert.Contains("EnsurePublicHotUpdateQueuedAsync", replayMethod, StringComparison.Ordinal);
        Assert.Contains("required: true", ensureMethod, StringComparison.Ordinal);
        Assert.Contains("throw new InvalidOperationException", ensureMethod, StringComparison.Ordinal);
        Assert.DoesNotContain("QueuePublicHotUpdateAsync(articleId, $\"outbox-", replayMethod, StringComparison.Ordinal);
    }

    [Fact]
    public void PublicHotUpdateWorker_ReplaysEveryCoalescedArticleId()
    {
        string queue = ReadRepoFile("src/backend/Infrastructure/PublicReadArtifacts/PublicHotArtifactUpdateQueue.cs");
        string worker = Slice(queue, "protected override async Task ExecuteAsync", "    }\n}");

        Assert.Contains("var articleIds = new HashSet<int>();", worker, StringComparison.Ordinal);
        Assert.Contains("CollectUpdate(first, articleIds, ref requiresFullRebuild);", worker, StringComparison.Ordinal);
        Assert.Contains("CollectUpdate(next, articleIds, ref requiresFullRebuild);", worker, StringComparison.Ordinal);
        Assert.Contains("foreach (int articleId in articleIds)", worker, StringComparison.Ordinal);
        Assert.Contains("RebuildAfterArticleMutationAsync(snapshot, articleId, stoppingToken)", worker, StringComparison.Ordinal);
        Assert.DoesNotContain("first.ArticleId ?? 0", worker, StringComparison.Ordinal);
    }

    [Fact]
    public void ScheduledPublish_ReliesOnOutboxForNewlyPublishedArticleSideEffects()
    {
        string source = ReadRepoFile("src/backend/Services/Background/ScheduledPublishWorker.cs");
        string method = Slice(source, "internal async Task<int> PublishDueArticlesAsync", "        finally");

        Assert.Contains(".OrderBy(article => new { article.ScheduledPublishAt, article.Id })", method, StringComparison.Ordinal);
        Assert.DoesNotContain("\"scheduled-publish-body-batch-query\"", method, StringComparison.Ordinal);
        Assert.DoesNotContain("\"scheduled-publish-tags-batch-query\"", method, StringComparison.Ordinal);
        Assert.DoesNotContain("\"scheduled-publish-body-query\"", method, StringComparison.Ordinal);
        Assert.DoesNotContain("\"scheduled-publish-tags-query\"", method, StringComparison.Ordinal);
        Assert.Contains("BuildScheduledPublishOutboxEvent(article.Id, outboxEventId, now)", method, StringComparison.Ordinal);
        Assert.DoesNotContain("searchIndex.AddOrUpdateIndexAsync(article)", method, StringComparison.Ordinal);
        Assert.DoesNotContain("publicAotInvalidation.InvalidateArticleMutationAsync", method, StringComparison.Ordinal);
        Assert.DoesNotContain("invalidation.InvalidateArticleMutationAsync(article.Id", method, StringComparison.Ordinal);

        int commitGuard = method.IndexOf("TransactionSideEffectGuard.CanPublishAfterCommit", StringComparison.Ordinal);
        int outbox = method.IndexOf("BuildScheduledPublishOutboxEvent(article.Id, outboxEventId, now)", StringComparison.Ordinal);

        Assert.True(outbox >= 0);
        Assert.True(commitGuard > outbox);
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
