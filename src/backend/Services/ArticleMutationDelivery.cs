using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Integrity;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;

namespace FsusBlog.Server.Services;

public sealed class ArticleMutationDelivery(
    ISearchIndexService searchIndex,
    IMessageRealtimePublisher messagePublisher,
    IIntegrityProofScheduler integrityProofScheduler)
{
    public Task ProjectSearchAsync(
        Article article,
        ArticleMutationVersionReference version,
        CancellationToken cancellationToken)
        => version.ReleaseId.HasValue || version.RevisionId.HasValue
            ? searchIndex.AddOrUpdateVersionedIndexAsync(article, version, cancellationToken)
            : ArticlePublication.IsPubliclyVisible(article, DateTime.UtcNow)
                ? searchIndex.AddOrUpdateIndexAsync(article)
                : searchIndex.DeleteIndexAsync(article.Id);

    public Task ProjectSearchAsync(Article article)
        => ProjectSearchAsync(article, default, CancellationToken.None);

    public Task DeleteSearchAsync(int articleId)
        => searchIndex.DeleteIndexAsync(articleId);

    public Task NotifyAsync(
        int articleId,
        string action,
        ArticleListItemResponse? preview = null,
        string? idempotencyKey = null,
        DateTime? eventTime = null,
        ArticleMutationVersionReference version = default)
        => messagePublisher.PushArticleChangedAsync(
            new ArticleNoticeDto(
                articleId,
                action,
                eventTime ?? DateTime.UtcNow,
                preview,
                version.RevisionId?.ToString(System.Globalization.CultureInfo.InvariantCulture),
                version.ReleaseId?.ToString(System.Globalization.CultureInfo.InvariantCulture)),
            idempotencyKey);

    public Task ScheduleIntegrityProofAsync(
        int articleId,
        string eventType,
        IReadOnlySet<string> completedEdges,
        CancellationToken cancellationToken)
        => integrityProofScheduler.ScheduleFromOutboxAsync(
            articleId,
            eventType,
            completedEdges,
            cancellationToken);
}
