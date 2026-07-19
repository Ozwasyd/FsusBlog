using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Helpers;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;

using SqlSugar;

namespace FsusBlog.Server.Services;

public interface IArticleMutationSideEffectCoordinator
{
    Task AfterCreatedAsync(Article article, int articleId, ArticleListItemResponse? preview);

    Task AfterUpdatedAsync(int articleId, ArticleListItemResponse? preview);

    Task AfterDeletedAsync(int articleId);

    Task AfterRestoredAsync(int articleId, ArticleListItemResponse? preview);

    Task AfterPermanentlyDeletedAsync(int articleId, IEnumerable<string> imageUrls, CancellationToken cancellationToken);

    Task AfterTrashClearedAsync(
        IReadOnlyCollection<int> articleIds,
        IReadOnlyDictionary<int, string> articleBodies,
        CancellationToken cancellationToken);

    Task<ArticleMutationReplayResult> ReplayOutboxAsync(
        int articleId,
        string eventType,
        string outboxEventId,
        IReadOnlySet<string> completedEdges,
        CancellationToken cancellationToken);
}

public static class ArticleMutationReplayEdges
{
    public const string PublicAotInvalidation = "public-aot-invalidation";
    public const string HttpCacheInvalidation = "http-cache-invalidation";
    public const string SearchProjection = "search-projection";
    public const string ArticleDetailAeds = "article-detail-aeds";
    public const string TaxonomyProjection = "taxonomy-projection";
    public const string PublicArtifactRevocation = "public-artifact-revocation";
    public const string PublicHotRead = "public-hot-read";
    public const string IntegrityProof = "integrity-proof";
    public const string Notification = "notification";

    public static readonly IReadOnlySet<string> Required = new HashSet<string>(StringComparer.Ordinal)
    {
        PublicAotInvalidation,
        HttpCacheInvalidation,
        SearchProjection,
        ArticleDetailAeds,
        TaxonomyProjection,
        PublicArtifactRevocation,
        PublicHotRead
    };
}

internal static class ArticleMutationEventTypes
{
    internal const string Created = "created";
    internal const string Updated = "updated";
    internal const string Deleted = "deleted";
    internal const string Restored = "restored";
    internal const string PermanentlyDeleted = "permanently-deleted";
    internal const string TrashCleared = "trash-cleared";
    internal const string ScheduledPublished = "scheduled-published";
    internal const string CategoryUpdated = "category-updated";
    internal const string TagUpdated = "tag-updated";
    internal const string RightsProofUpdated = "rights-proof-updated";

    internal static readonly IReadOnlySet<string> s_supported = new HashSet<string>(StringComparer.Ordinal)
    {
        Created,
        Updated,
        Deleted,
        Restored,
        PermanentlyDeleted,
        TrashCleared,
        ScheduledPublished,
        CategoryUpdated,
        TagUpdated,
        RightsProofUpdated
    };
}

public static class ArticleMutationDeliveryKey
{
    public static string Build(string outboxEventId, string edgeName)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(outboxEventId);
        ArgumentException.ThrowIfNullOrWhiteSpace(edgeName);
        byte[] digest = SHA256.HashData(Encoding.UTF8.GetBytes(string.Concat(outboxEventId, ":", edgeName)));
        return Convert.ToHexString(digest).ToLowerInvariant();
    }
}

public sealed record ArticleMutationReplayResult(
    bool IsSuccess,
    string? Error,
    IReadOnlySet<string> CompletedEdges,
    IReadOnlyDictionary<string, string> FailedEdges)
{
    public static ArticleMutationReplayResult Success(IReadOnlySet<string> completedEdges)
        => new(true, null, completedEdges, new Dictionary<string, string>(StringComparer.Ordinal));

    public static ArticleMutationReplayResult Success(
        IReadOnlySet<string> completedEdges,
        IReadOnlyDictionary<string, string> failedEdges)
        => new(true, null, completedEdges, failedEdges);

    public static ArticleMutationReplayResult Failed(
        string error,
        IReadOnlySet<string> completedEdges,
        IReadOnlyDictionary<string, string> failedEdges)
        => new(false, error, completedEdges, failedEdges);
}

public sealed class ArticleAssetCleanupPolicy(IFileService fileService)
{
    private const int MaxDeleteParallelism = 5;

    public async Task DeleteIllustrationsAsync(IEnumerable<string> imageUrls, CancellationToken cancellationToken = default)
    {
        string[] uniqueUrls = imageUrls
            .Where(static url => !string.IsNullOrWhiteSpace(url))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        if (uniqueUrls.Length == 0)
        {
            return;
        }

        await Parallel.ForEachAsync(
            uniqueUrls,
            new ParallelOptions { MaxDegreeOfParallelism = MaxDeleteParallelism, CancellationToken = cancellationToken },
            async (url, _) => await fileService.DeleteImageAsync(url));
    }
}

public sealed class ArticleMutationSideEffectCoordinator(
    ISqlSugarClient db,
    IArticlePublicMutationFence mutationFence,
    ArticleMutationProjectionInvalidator projections,
    ArticleMutationDelivery delivery,
    ArticleAssetCleanupPolicy assetCleanupPolicy,
    ILogger<ArticleMutationSideEffectCoordinator> logger) : IArticleMutationSideEffectCoordinator
{
    public Task AfterCreatedAsync(Article article, int articleId, ArticleListItemResponse? preview)
        => ExecuteAsync(
            async () =>
            {
                article.Id = articleId;
                bool isPublic = ArticlePublication.IsPubliclyVisible(article, DateTime.UtcNow);
                if (isPublic)
                {
                    await mutationFence.CommitPublicMutationFenceAsync(
                            null,
                            "article-created",
                            CancellationToken.None)
                        .ConfigureAwait(false);
                }
                await RunSideEffectsSequentiallyAsync(
                    () => delivery.ProjectSearchAsync(article),
                    () => projections.ReconcileTaxonomyAsync(articleId),
                    () => projections.GenerateDetailAsync(articleId),
                    () => projections.QueuePublicHotUpdateAsync(isPublic ? null : articleId, "article-created"),
                    () => delivery.NotifyAsync(articleId, "Created", preview));
            },
            "article-create-sync");

    public Task AfterUpdatedAsync(int articleId, ArticleListItemResponse? preview)
        => ExecuteAsync(
            async () =>
            {
                await mutationFence
                    .CompleteArticleMutationFenceAsync(articleId, CancellationToken.None)
                    .ConfigureAwait(false);

                Article? article = await LoadArticleWithContentAsync(articleId);
                if (article is null)
                {
                    return;
                }

                await RunSideEffectsSequentiallyAsync(
                    () => delivery.ProjectSearchAsync(article),
                    () => projections.ReconcileTaxonomyAsync(articleId),
                    () => projections.GenerateDetailAsync(articleId),
                    () => projections.QueuePublicHotUpdateAsync(articleId, "article-updated"),
                    () => delivery.NotifyAsync(articleId, "Updated", preview));
            },
            "article-update-sync");

    public Task AfterDeletedAsync(int articleId)
        => ExecuteAsync(
            async () =>
            {
                await mutationFence
                    .CompleteArticleMutationFenceAsync(articleId, CancellationToken.None)
                    .ConfigureAwait(false);
                await RunSideEffectsSequentiallyAsync(
                    () => delivery.DeleteSearchAsync(articleId),
                    () => projections.ReconcileTaxonomyAsync(articleId),
                    () => projections.RemoveDetailAsync(articleId),
                    () => projections.QueuePublicHotUpdateAsync(articleId, "article-deleted"),
                    () => projections.RemoveTopArticleAsync(articleId),
                    () => delivery.NotifyAsync(articleId, "Deleted"));
            },
            "article-delete-sync");

    public Task AfterRestoredAsync(int articleId, ArticleListItemResponse? preview)
        => ExecuteAsync(
            async () =>
            {
                Article? article = await LoadArticleWithContentAsync(articleId);
                if (article is null)
                {
                    return;
                }

                await RunSideEffectsSequentiallyAsync(
                    () => delivery.ProjectSearchAsync(article),
                    () => projections.ReconcileTaxonomyAsync(articleId),
                    () => projections.GenerateDetailAsync(articleId),
                    () => projections.QueuePublicHotUpdateAsync(articleId, "article-restored"),
                    () => projections.RestoreTopArticleAsync(articleId, article.Views),
                    () => delivery.NotifyAsync(articleId, "Restored", preview));
            },
            "article-restore-sync");

    public Task AfterPermanentlyDeletedAsync(int articleId, IEnumerable<string> imageUrls, CancellationToken cancellationToken)
        => ExecuteAsync(
            async () =>
            {
                await projections.RevokeArticleAsync(articleId, cancellationToken).ConfigureAwait(false);
                await RunSideEffectsSequentiallyAsync(
                    () => delivery.DeleteSearchAsync(articleId),
                    () => projections.ReconcileTaxonomyAsync(articleId, cancellationToken),
                    () => projections.RemoveDetailAsync(articleId),
                    () => projections.QueuePublicHotUpdateAsync(articleId, "article-permanently-deleted"),
                    () => projections.RemoveTopArticleAsync(articleId),
                    () => delivery.NotifyAsync(articleId, "Deleted"));

                await assetCleanupPolicy.DeleteIllustrationsAsync(imageUrls, cancellationToken);
            },
            "article-permanent-delete-sync");

    public Task AfterTrashClearedAsync(
        IReadOnlyCollection<int> articleIds,
        IReadOnlyDictionary<int, string> articleBodies,
        CancellationToken cancellationToken)
        => ExecuteAsync(
            async () =>
            {
                await projections.RevokeAllAsync(cancellationToken).ConfigureAwait(false);
                foreach (int[] chunk in articleIds.Chunk(128))
                {
                    foreach (int articleId in chunk)
                    {
                        await RunSideEffectsSequentiallyAsync(
                            () => projections.RemoveTopArticleAsync(articleId),
                            () => projections.RemoveDetailCacheAsync(articleId, cancellationToken),
                            () => projections.ReconcileTaxonomyAsync(articleId, cancellationToken),
                            () => projections.RemoveDetailAsync(articleId, cancellationToken),
                            () => delivery.DeleteSearchAsync(articleId));
                    }
                }

                await projections.QueuePublicHotUpdateAsync(null, "article-trash-cleared");

                var imageUrls = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (string body in articleBodies.Values)
                {
                    foreach (string url in ImageHelper.ExtractIllustrationUrls(body))
                    {
                        imageUrls.Add(url);
                    }
                }

                await assetCleanupPolicy.DeleteIllustrationsAsync(imageUrls, cancellationToken);
            },
            "article-clear-trash-sync");

    public async Task<ArticleMutationReplayResult> ReplayOutboxAsync(
        int articleId,
        string eventType,
        string outboxEventId,
        IReadOnlySet<string> completedEdges,
        CancellationToken cancellationToken)
    {
        var completed = new HashSet<string>(completedEdges, StringComparer.Ordinal);
        var completedDuringReplay = new HashSet<string>(StringComparer.Ordinal);
        var failed = new Dictionary<string, string>(StringComparer.Ordinal);
        async Task<bool> RunEdgeAsync(string edgeName, Func<Task> effect)
        {
            if (completed.Contains(edgeName))
            {
                return true;
            }

            try
            {
                await effect().ConfigureAwait(false);
                completed.Add(edgeName);
                completedDuringReplay.Add(edgeName);
                return true;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                string error = NormalizeReplayError(ex);
                failed[edgeName] = error;
                logger.LogError(
                    ex,
                    "article-outbox-replay-edge-failed {ArticleId} {EventType} {EdgeName} {Error}",
                    articleId,
                    eventType,
                    edgeName,
                    error);
                return false;
            }
        }

        async Task RunOptionalEdgeAsync(string edgeName, Func<Task> effect)
        {
            if (completed.Contains(edgeName))
            {
                return;
            }

            try
            {
                await effect().ConfigureAwait(false);
                completed.Add(edgeName);
                completedDuringReplay.Add(edgeName);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                string error = NormalizeReplayError(ex);
                failed[edgeName] = error;
                logger.LogWarning(
                    ex,
                    "article-outbox-replay-optional-edge-failed {ArticleId} {EventType} {EdgeName} {Error}",
                    articleId,
                    eventType,
                    edgeName,
                    error);
            }
        }

        async Task ScheduleIntegrityProofIfRequiredEdgesCompleteAsync(string normalized)
        {
            if (string.Equals(normalized, ArticleMutationEventTypes.RightsProofUpdated, StringComparison.Ordinal))
            {
                return;
            }

            if (!ArticleMutationReplayEdges.Required.All(completed.Contains))
            {
                return;
            }

            await RunOptionalEdgeAsync(ArticleMutationReplayEdges.IntegrityProof, () =>
                    delivery.ScheduleIntegrityProofAsync(articleId, normalized, completed, cancellationToken))
                .ConfigureAwait(false);
        }

        try
        {
            string normalized = TextHelpers.LowerTrimmed(eventType) ?? string.Empty;
            if (normalized is ArticleMutationEventTypes.Deleted
                or ArticleMutationEventTypes.PermanentlyDeleted
                or ArticleMutationEventTypes.TrashCleared)
            {
                return await ReplayDeletedArticleEdgesAsync(normalized).ConfigureAwait(false);
            }

            Article? article = await LoadArticleWithContentAsync(articleId).ConfigureAwait(false);
            if (article is null)
            {
                return await ReplayMissingArticleEdgesAsync(normalized).ConfigureAwait(false);
            }

            string action = normalized switch
            {
                ArticleMutationEventTypes.Created => "Created",
                ArticleMutationEventTypes.Restored => "Restored",
                _ => "Updated"
            };

            if (!await RunEdgeAsync(
                        ArticleMutationReplayEdges.PublicArtifactRevocation,
                        () => projections.RevokeArticleAsync(articleId, cancellationToken))
                    .ConfigureAwait(false)
                || !await RunEdgeAsync(ArticleMutationReplayEdges.SearchProjection, () => delivery.ProjectSearchAsync(article))
                    .ConfigureAwait(false)
                || !await RunEdgeAsync(
                        ArticleMutationReplayEdges.TaxonomyProjection,
                        () => projections.ReconcileTaxonomyAsync(articleId, cancellationToken))
                    .ConfigureAwait(false)
                || !await RunEdgeAsync(
                        ArticleMutationReplayEdges.ArticleDetailAeds,
                        () => projections.GenerateDetailAsync(articleId, cancellationToken))
                    .ConfigureAwait(false)
                || !await RunEdgeAsync(
                        ArticleMutationReplayEdges.PublicHotRead,
                        async () =>
                        {
                            await projections.EnsurePublicHotUpdateQueuedAsync(
                                    normalized is ArticleMutationEventTypes.Created or ArticleMutationEventTypes.ScheduledPublished
                                        ? null
                                        : articleId,
                                    $"outbox-{normalized}")
                                .ConfigureAwait(false);
                            if (normalized == ArticleMutationEventTypes.Restored)
                            {
                                await projections.RestoreTopArticleAsync(articleId, article.Views)
                                    .ConfigureAwait(false);
                            }
                        })
                    .ConfigureAwait(false)
            )
            {
                return FailedResult();
            }

            await ScheduleIntegrityProofIfRequiredEdgesCompleteAsync(normalized).ConfigureAwait(false);

            if (!await RunEdgeAsync(
                    ArticleMutationReplayEdges.Notification,
                    () => delivery.NotifyAsync(
                        articleId,
                        action,
                        idempotencyKey: ArticleMutationDeliveryKey.Build(outboxEventId, ArticleMutationReplayEdges.Notification)))
                .ConfigureAwait(false))
            {
                return FailedResult();
            }

            return ArticleMutationReplayResult.Success(completedDuringReplay, failed);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            string error = NormalizeReplayError(ex);
            logger.LogError(ex, "article-outbox-replay-failed {ArticleId} {EventType} {Error}", articleId, eventType, error);
            failed["article-outbox-replay"] = error;
            return ArticleMutationReplayResult.Failed(error, completedDuringReplay, failed);
        }

        async Task<ArticleMutationReplayResult> ReplayDeletedArticleEdgesAsync(string normalized)
        {
            if (!await RunEdgeAsync(
                        ArticleMutationReplayEdges.PublicArtifactRevocation,
                        () => projections.RevokeArticleAsync(articleId, cancellationToken))
                    .ConfigureAwait(false)
                || !await RunEdgeAsync(ArticleMutationReplayEdges.SearchProjection, () => delivery.DeleteSearchAsync(articleId))
                    .ConfigureAwait(false)
                || !await RunEdgeAsync(
                        ArticleMutationReplayEdges.TaxonomyProjection,
                        () => projections.ReconcileTaxonomyAsync(articleId, cancellationToken))
                    .ConfigureAwait(false)
                || !await RunEdgeAsync(
                        ArticleMutationReplayEdges.ArticleDetailAeds,
                        () => projections.RemoveDetailAsync(articleId, cancellationToken))
                    .ConfigureAwait(false)
                || !await RunEdgeAsync(
                        ArticleMutationReplayEdges.PublicHotRead,
                        async () =>
                        {
                            await projections.EnsurePublicHotUpdateQueuedAsync(articleId, $"outbox-{normalized}").ConfigureAwait(false);
                            await projections.RemoveTopArticleAsync(articleId).ConfigureAwait(false);
                        })
                    .ConfigureAwait(false)
            )
            {
                return FailedResult();
            }

            await ScheduleIntegrityProofIfRequiredEdgesCompleteAsync(normalized).ConfigureAwait(false);

            if (!await RunEdgeAsync(
                    ArticleMutationReplayEdges.Notification,
                    () => delivery.NotifyAsync(
                        articleId,
                        "Deleted",
                        idempotencyKey: ArticleMutationDeliveryKey.Build(outboxEventId, ArticleMutationReplayEdges.Notification)))
                .ConfigureAwait(false))
            {
                return FailedResult();
            }

            return ArticleMutationReplayResult.Success(completedDuringReplay, failed);
        }

        async Task<ArticleMutationReplayResult> ReplayMissingArticleEdgesAsync(string normalized)
        {
            if (!await RunEdgeAsync(
                        ArticleMutationReplayEdges.PublicArtifactRevocation,
                        () => projections.RevokeArticleAsync(articleId, cancellationToken))
                    .ConfigureAwait(false)
                || !await RunEdgeAsync(ArticleMutationReplayEdges.SearchProjection, () => delivery.DeleteSearchAsync(articleId))
                    .ConfigureAwait(false)
                || !await RunEdgeAsync(
                        ArticleMutationReplayEdges.TaxonomyProjection,
                        () => projections.ReconcileTaxonomyAsync(articleId, cancellationToken))
                    .ConfigureAwait(false)
                || !await RunEdgeAsync(
                        ArticleMutationReplayEdges.ArticleDetailAeds,
                        () => projections.RemoveDetailAsync(articleId, cancellationToken))
                    .ConfigureAwait(false)
                || !await RunEdgeAsync(
                        ArticleMutationReplayEdges.PublicHotRead,
                        async () =>
                        {
                            await projections.EnsurePublicHotUpdateQueuedAsync(articleId, $"outbox-{normalized}").ConfigureAwait(false);
                            await projections.RemoveTopArticleAsync(articleId).ConfigureAwait(false);
                        })
                    .ConfigureAwait(false))
            {
                return FailedResult();
            }

            await ScheduleIntegrityProofIfRequiredEdgesCompleteAsync(normalized).ConfigureAwait(false);

            return ArticleMutationReplayResult.Success(completedDuringReplay, failed);
        }

        ArticleMutationReplayResult FailedResult()
        {
            string error = failed.Count == 0
                ? "article mutation replay edge failed"
                : string.Join("; ", failed.Select(static item => $"{item.Key}: {item.Value}"));
            return ArticleMutationReplayResult.Failed(NormalizeReplayError(error), completedDuringReplay, failed);
        }
    }

    private async Task<Article?> LoadArticleWithContentAsync(int articleId)
    {
        Article? article = await db.Queryable<Article>().ClearFilter().InSingleAsync(articleId);
        if (article is null)
        {
            return null;
        }

        article.Content = await db.Queryable<ArticleBody>()
            .Where(it => it.ArticleId == articleId)
            .Select(it => it.MarkdownContent)
            .FirstAsync()
            ?? string.Empty;
        return article;
    }

    private Task ExecuteAsync(Func<Task> action, string operation)
        => BoundaryExecutor.ExecuteAsync(action, logger, operation, LogLevel.Error);

    private static async Task RunSideEffectsSequentiallyAsync(params Func<Task>[] effects)
    {
        foreach (Func<Task> effect in effects)
        {
            await effect().ConfigureAwait(false);
        }
    }

    private static string NormalizeReplayError(Exception ex)
        => NormalizeReplayError(ex.Message);

    private static string NormalizeReplayError(string error)
        => error.Length <= 1024 ? error : error[..1024];
}
