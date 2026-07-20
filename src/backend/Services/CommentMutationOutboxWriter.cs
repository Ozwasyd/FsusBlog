using FsusBlog.Server.Entities;

using SqlSugar;

namespace FsusBlog.Server.Services;

public interface ICommentMutationOutbox
{
    Task EnqueueAsync(CommentMutationOutboxEvent item, CancellationToken cancellationToken = default);
}

public sealed class CommentMutationOutboxWriter(ISqlSugarClient db) : ICommentMutationOutbox
{
    public async Task EnqueueAsync(CommentMutationOutboxEvent item, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (item.CommentId <= 0 || item.ArticleId <= 0 || item.RootId <= 0 || string.IsNullOrWhiteSpace(item.EventType))
        {
            throw new InvalidOperationException("Comment outbox event is missing its aggregate identity.");
        }

        item.EventId = string.IsNullOrWhiteSpace(item.EventId) ? Guid.NewGuid().ToString("D") : item.EventId;
        item.PayloadJson = "{}";
        item.Status = CommentMutationOutboxStatus.Pending;
        item.NextAttemptAt = item.OccurredAtUtc;
        await db.Insertable(item).ExecuteCommandAsync(cancellationToken).ConfigureAwait(false);
    }
}
