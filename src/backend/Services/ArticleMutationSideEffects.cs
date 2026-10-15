using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Helpers;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Background;

using SqlSugar;

namespace FsusBlog.Server.Services;

public interface IArticleMutationSideEffectCoordinator
{
    Task AfterCreatedAsync(Article article, int articleId, ArticleListItemResponse? preview);

    Task AfterUpdatedAsync(int articleId, ArticleListItemResponse? preview);

    Task AfterDeletedAsync(int articleId);

    Task AfterRestoredAsync(int articleId, ArticleListItemResponse? preview);

    Task AfterPermanentlyDeletedAsync(int articleId, CancellationToken cancellationToken);

    Task AfterTrashClearedAsync(
        IReadOnlyCollection<int> articleIds,
        CancellationToken cancellationToken);

    Task<ArticleMutationReplayResult> ReplayOutboxAsync(
        int articleId,
        string eventType,
        string outboxEventId,
        ArticleMutationVersionReference version,
        IReadOnlySet<string> completedEdges,
        CancellationToken cancellationToken);
}

public static class ArticleMutationReplayEdges
{
    public const string ContractId = "fsusblog.article-mutation-replay-edges.v1";
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

    public static readonly IReadOnlySet<string> Optional = new HashSet<string>(StringComparer.Ordinal)
    {
        IntegrityProof,
        Notification
    };

    public static readonly IReadOnlySet<string> All = new HashSet<string>(
        Required.Concat(Optional),
        StringComparer.Ordinal);
}

public static class ArticleMutationEventTypes
{
    public const string Created = "created";
    public const string Updated = "updated";
    public const string Deleted = "deleted";
    public const string Restored = "restored";
    public const string PermanentlyDeleted = "permanently-deleted";
    public const string TrashCleared = "trash-cleared";
    public const string ScheduledPublished = "scheduled-published";
    public const string CategoryUpdated = "category-updated";
    public const string TagUpdated = "tag-updated";
    public const string RightsProofUpdated = "rights-proof-updated";
    public const string ResponsibilityUpdated = "responsibility-updated";

    public static readonly IReadOnlySet<string> All = new HashSet<string>(StringComparer.Ordinal)
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
        RightsProofUpdated,
        ResponsibilityUpdated
    };

    internal static readonly IReadOnlySet<string> s_supported = All;
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
    IReadOnlySet<string> SkippedEdges,
    IReadOnlyDictionary<string, string> FailedEdges)
{
    public IReadOnlyDictionary<string, string> SkippedEdgeReasons
    {
        get;
        init;
    } = new Dictionary<string, string>(StringComparer.Ordinal);

    public static ArticleMutationReplayResult Success(IReadOnlySet<string> completedEdges)
        => new(
            true,
            null,
            completedEdges,
            new HashSet<string>(StringComparer.Ordinal),
            new Dictionary<string, string>(StringComparer.Ordinal));

    public static ArticleMutationReplayResult Success(
        IReadOnlySet<string> completedEdges,
        IReadOnlyDictionary<string, string> failedEdges)
        => new(true, null, completedEdges, new HashSet<string>(StringComparer.Ordinal), failedEdges);

    public static ArticleMutationReplayResult Skipped(IReadOnlySet<string> skippedEdges)
        => new(
            true,
            null,
            new HashSet<string>(StringComparer.Ordinal),
            skippedEdges,
            new Dictionary<string, string>(StringComparer.Ordinal));

    internal static ArticleMutationReplayResult ForSupersededPublication(
        IReadOnlySet<string> terminalEdges,
        string reason = "superseded-by-newer-publication",
        IReadOnlySet<string>? completedDuringReplay = null)
    {
        var skippedEdges = ArticleMutationReplayEdges.All
            .Where(edge => !terminalEdges.Contains(edge))
            .ToHashSet(StringComparer.Ordinal);

        return new ArticleMutationReplayResult(
            true,
            null,
            completedDuringReplay ?? new HashSet<string>(StringComparer.Ordinal),
            skippedEdges,
            new Dictionary<string, string>(StringComparer.Ordinal)) with
        {
            SkippedEdgeReasons = skippedEdges.ToDictionary(
                static edge => edge,
                _ => reason,
                StringComparer.Ordinal)
        };
    }

    public static ArticleMutationReplayResult Failed(
        string error,
        IReadOnlySet<string> completedEdges,
        IReadOnlyDictionary<string, string> failedEdges)
        => new(false, error, completedEdges, new HashSet<string>(StringComparer.Ordinal), failedEdges);
}

public sealed class ArticleAssetCleanupPolicy(ArticleAssetCleanupQueue cleanupQueue)
{
    public Task RequestCleanupAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        cleanupQueue.TryRequestScan();
        return Task.CompletedTask;
    }
}

public sealed class ArticleMutationSideEffectCoordinator(
    ISqlSugarClient db,
    IArticlePublicMutationFence mutationFence,
    ArticleMutationProjectionInvalidator projections,
    ArticleMutationDelivery delivery,
    ArticleAssetCleanupPolicy assetCleanupPolicy,
    TimeProvider timeProvider,
    ILogger<ArticleMutationSideEffectCoordinator> logger) : IArticleMutationSideEffectCoordinator
{
    public Task AfterCreatedAsync(Article article, int articleId, ArticleListItemResponse? preview)
        => ExecuteAsync(
            async () =>
            {
                article.Id = articleId;
                bool isPublic = ArticlePublication.IsPubliclyVisible(
                    article,
                    timeProvider.GetUtcNow().UtcDateTime);
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

    public Task AfterPermanentlyDeletedAsync(int articleId, CancellationToken cancellationToken)
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

                await assetCleanupPolicy.RequestCleanupAsync(cancellationToken);
            },
            "article-permanent-delete-sync");

    public Task AfterTrashClearedAsync(
        IReadOnlyCollection<int> articleIds,
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
                await assetCleanupPolicy.RequestCleanupAsync(cancellationToken);
            },
            "article-clear-trash-sync");

    public async Task<ArticleMutationReplayResult> ReplayOutboxAsync(
        int articleId,
        string eventType,
        string outboxEventId,
        ArticleMutationVersionReference version,
        IReadOnlySet<string> completedEdges,
        CancellationToken cancellationToken)
    {
        var completed = new HashSet<string>(completedEdges, StringComparer.Ordinal);
        var completedDuringReplay = new HashSet<string>(StringComparer.Ordinal);
        var failed = new Dictionary<string, string>(StringComparer.Ordinal);
        async Task EnsureEventVersionIsCurrentAsync()
        {
            if (!version.ReleaseId.HasValue
                && !version.RevisionId.HasValue
                && !version.RightsSnapshotId.HasValue
                && !version.ResponsibilitySnapshotId.HasValue)
            {
                return;
            }

            var envelope = new ArticleMutationOutboxEnvelope(
                ArticleMutationOutboxEnvelopeCodec.CurrentSchemaVersion,
                outboxEventId,
                articleId,
                eventType,
                version,
                new ArticleMutationScopeChange(null, null),
                version.EventOccurredAt ?? timeProvider.GetUtcNow().UtcDateTime);
            ArticleMutationVersionDisposition disposition = await ArticleMutationOutboxVersionGuard
                .EvaluateAsync(db, envelope, cancellationToken)
                .ConfigureAwait(false);
            if (disposition.Kind == ArticleMutationVersionDispositionKind.Skip)
            {
                throw new ArticleMutationSupersededException(disposition.Reason ?? "superseded-by-newer-publication");
            }
            if (disposition.Kind == ArticleMutationVersionDispositionKind.Invalid)
            {
                throw new InvalidOperationException(disposition.Reason ?? "invalid-article-mutation-coordinate");
            }
        }

        async Task<bool> RunEdgeAsync(string edgeName, Func<Task> effect)
        {
            if (completed.Contains(edgeName))
            {
                return true;
            }

            try
            {
                await EnsureEventVersionIsCurrentAsync().ConfigureAwait(false);
                await effect().ConfigureAwait(false);
                completed.Add(edgeName);
                completedDuringReplay.Add(edgeName);
                return true;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (ArticleMutationSupersededException)
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
                await EnsureEventVersionIsCurrentAsync().ConfigureAwait(false);
                await effect().ConfigureAwait(false);
                completed.Add(edgeName);
                completedDuringReplay.Add(edgeName);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (ArticleMutationSupersededException)
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
            bool responsibilityMutation = string.Equals(
                normalized,
                ArticleMutationEventTypes.ResponsibilityUpdated,
                StringComparison.Ordinal);
            if (responsibilityMutation)
            {
                await ValidateResponsibilityCoordinatesAsync(articleId, version).ConfigureAwait(false);
            }
            if (version.PublicationId.HasValue
                && await IsSupersededPublicationAsync(articleId, version.PublicationId.Value).ConfigureAwait(false))
            {
                return ArticleMutationReplayResult.ForSupersededPublication(completed);
            }

            if (normalized is ArticleMutationEventTypes.Deleted
                or ArticleMutationEventTypes.PermanentlyDeleted
                or ArticleMutationEventTypes.TrashCleared)
            {
                return await ReplayDeletedArticleEdgesAsync(normalized).ConfigureAwait(false);
            }

            Article? article = responsibilityMutation && !version.PublicationId.HasValue
                ? await LoadArticleWithContentAsync(articleId).ConfigureAwait(false)
                : await LoadArticleWithContentAsync(articleId, version).ConfigureAwait(false);
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
                || !await RunEdgeAsync(
                        ArticleMutationReplayEdges.SearchProjection,
                        () => delivery.ProjectSearchAsync(article, version, cancellationToken))
                    .ConfigureAwait(false)
                || !await RunEdgeAsync(
                        ArticleMutationReplayEdges.TaxonomyProjection,
                        () => projections.ReconcileTaxonomyAsync(articleId, cancellationToken))
                    .ConfigureAwait(false)
                || !await RunEdgeAsync(
                        ArticleMutationReplayEdges.ArticleDetailAeds,
                        () => projections.GenerateDetailAsync(articleId, version, cancellationToken))
                    .ConfigureAwait(false)
                || !await RunEdgeAsync(
                        ArticleMutationReplayEdges.PublicHotRead,
                        async () =>
                        {
                            await projections.EnsurePublicHotUpdateQueuedAsync(
                                    articleId,
                                    $"outbox-{normalized}",
                                    version.ReleaseId)
                                .ConfigureAwait(false);
                            if (IsPubliclyListed(article))
                            {
                                await projections.RestoreTopArticleAsync(articleId, article.Views)
                                    .ConfigureAwait(false);
                            }
                            else
                            {
                                await projections.RemoveTopArticleAsync(articleId)
                                    .ConfigureAwait(false);
                            }
                        })
                    .ConfigureAwait(false)
            )
            {
                return FailedResult();
            }

            await ScheduleIntegrityProofIfRequiredEdgesCompleteAsync(normalized).ConfigureAwait(false);

            await RunOptionalEdgeAsync(
                    ArticleMutationReplayEdges.Notification,
                    () => delivery.NotifyAsync(
                        articleId,
                        action,
                        idempotencyKey: ArticleMutationDeliveryKey.Build(outboxEventId, ArticleMutationReplayEdges.Notification),
                        eventTime: version.EventOccurredAt,
                        version: version))
                .ConfigureAwait(false);

            return ArticleMutationReplayResult.Success(completedDuringReplay, failed);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (ArticleMutationSupersededException ex)
        {
            logger.LogInformation(
                "article-outbox-replay-version-skipped {ArticleId} {EventType} {Reason}",
                articleId,
                eventType,
                ex.Reason);
            return ArticleMutationReplayResult.ForSupersededPublication(
                completed,
                ex.Reason,
                completedDuringReplay);
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

            await RunOptionalEdgeAsync(
                    ArticleMutationReplayEdges.Notification,
                    () => delivery.NotifyAsync(
                        articleId,
                        "Deleted",
                        idempotencyKey: ArticleMutationDeliveryKey.Build(outboxEventId, ArticleMutationReplayEdges.Notification),
                        eventTime: version.EventOccurredAt))
                .ConfigureAwait(false);

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

    private bool IsPubliclyListed(Article article)
    {
        DateTime now = timeProvider.GetUtcNow().UtcDateTime;
        return !article.IsDeleted
            && article.Status == ArticleStatus.Published
            && (article.PublishedAt is null || article.PublishedAt <= now)
            && (article.ScheduledPublishAt is null || article.ScheduledPublishAt <= now);
    }

    private async Task<Article?> LoadArticleWithContentAsync(int articleId)
        => await LoadArticleWithContentAsync(articleId, default).ConfigureAwait(false);

    private async Task<Article?> LoadArticleWithContentAsync(
        int articleId,
        ArticleMutationVersionReference version)
    {
        Article? article = await db.Queryable<Article>().ClearFilter().InSingleAsync(articleId);
        if (article is null)
        {
            return null;
        }

        long? publicationId = version.PublicationId ?? article.CurrentPublicationId;
        if (publicationId.HasValue)
        {
            ArticlePublicationRecord? publication = await db.Queryable<ArticlePublicationRecord>()
                .Where(record => record.Id == publicationId.Value && record.ArticleId == articleId)
                .FirstAsync();
            if (publication is null
                || (version.PublicationNo.HasValue && publication.PublicationNo != version.PublicationNo.Value)
                || (version.RevisionId.HasValue && publication.ArticleRevisionId != version.RevisionId.Value)
                || (version.RevisionNo.HasValue && publication.RevisionNo != version.RevisionNo.Value)
                || (version.RightsSnapshotId.HasValue && publication.RightsSnapshotId != version.RightsSnapshotId.Value)
                || (version.ResponsibilitySnapshotId.HasValue
                    && publication.ResponsibilitySnapshotId != version.ResponsibilitySnapshotId.Value))
            {
                throw new InvalidOperationException($"Article mutation event coordinates do not resolve for article {articleId}.");
            }

            ArticleRevision? revision = await db.Queryable<ArticleRevision>()
                .Where(candidate => candidate.Id == publication.ArticleRevisionId && candidate.ArticleId == articleId)
                .FirstAsync();
            if (revision is null || revision.RevisionNo != publication.RevisionNo)
            {
                throw new InvalidOperationException($"Article publication {publication.Id} has an invalid revision coordinate.");
            }

            string content = await ArticleRevisionContentBlockStore.LoadAsync(
                db,
                revision.ContentBlockId,
                CancellationToken.None).ConfigureAwait(false);

            article.Title = revision.Title;
            article.Summary = revision.Summary;
            article.CoverImageUrl = revision.CoverImageUrl;
            article.CategoryId = revision.CategoryId;
            article.Content = content;
            article.PublishedAt = publication.PublishedAt;
            return article;
        }

        article.Content = await db.Queryable<ArticleBody>()
                .Where(it => it.ArticleId == articleId)
                .Select(it => it.MarkdownContent)
                .FirstAsync()
            ?? string.Empty;
        return article;
    }

    private async Task ValidateResponsibilityCoordinatesAsync(
        int articleId,
        ArticleMutationVersionReference version)
    {
        if (!version.RevisionId.HasValue
            || !version.RevisionNo.HasValue
            || !version.ResponsibilitySnapshotId.HasValue)
        {
            throw new InvalidOperationException($"Responsibility mutation coordinates are incomplete for article {articleId}.");
        }

        bool resolves = await db.Queryable<ArticleResponsibilitySnapshot>()
            .Where(snapshot => snapshot.Id == version.ResponsibilitySnapshotId.Value
                && snapshot.ArticleId == articleId
                && snapshot.ArticleRevisionId == version.RevisionId.Value
                && snapshot.RevisionNo == version.RevisionNo.Value
                && (!version.ResponsibilityVersion.HasValue
                    || snapshot.ResponsibilityVersion == version.ResponsibilityVersion.Value))
            .AnyAsync();
        if (!resolves)
        {
            throw new InvalidOperationException($"Responsibility mutation coordinates do not resolve for article {articleId}.");
        }
    }

    private async Task<bool> IsSupersededPublicationAsync(int articleId, long eventPublicationId)
    {
        long? currentPublicationId = await db.Queryable<Article>()
            .ClearFilter()
            .Where(article => article.Id == articleId)
            .Select(article => article.CurrentPublicationId)
            .FirstAsync();
        return currentPublicationId.HasValue && currentPublicationId.Value != eventPublicationId;
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
