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
    public Task ProjectSearchAsync(Article article)
        => ArticlePublication.IsPubliclyVisible(article, DateTime.UtcNow)
            ? searchIndex.AddOrUpdateIndexAsync(article)
            : searchIndex.DeleteIndexAsync(article.Id);

    public Task DeleteSearchAsync(int articleId)
        => searchIndex.DeleteIndexAsync(articleId);

    public Task NotifyAsync(
        int articleId,
        string action,
        ArticleListItemResponse? preview = null,
        string? idempotencyKey = null)
        => messagePublisher.PushArticleChangedAsync(
            new ArticleNoticeDto(articleId, action, DateTime.UtcNow, preview),
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
