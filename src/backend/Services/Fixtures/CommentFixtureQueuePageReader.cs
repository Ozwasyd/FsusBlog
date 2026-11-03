using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Authoring;

namespace FsusBlog.Server.Services.Fixtures;

/// <summary>Reads a complete production queue traversal or refuses the partial result.</summary>
public static class CommentFixtureQueuePageReader
{
    /// <summary>
    /// Preserves page order, item and lease DTOs, and opaque continuation cursors.
    /// Counts come from the terminal page; this traversal does not establish an atomic snapshot.
    /// </summary>
    /// <exception cref="OperationCanceledException">The caller cancels the traversal.</exception>
    /// <exception cref="InvalidOperationException">
    /// A cursor or item identity repeats, an item identity is missing, or a read budget is exhausted.
    /// </exception>
    public static async Task<CommentModerationQueueResponse> ReadAllAsync(
        IAuthoringModerationQueue queue,
        CommentModerationStatus? status = null,
        int pageSize = 100,
        int maxPages = 100,
        int maxItems = 10000,
        int maxLeases = 10000,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(queue);
        ArgumentOutOfRangeException.ThrowIfLessThan(pageSize, 1);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(pageSize, 100);
        ArgumentOutOfRangeException.ThrowIfLessThan(maxPages, 1);
        ArgumentOutOfRangeException.ThrowIfLessThan(maxItems, 1);
        ArgumentOutOfRangeException.ThrowIfLessThan(maxLeases, 1);

        var items = new List<CommentModerationItemResponse>();
        var leases = new List<CommentModerationQueueLeaseResponse>();
        var seenItems = new HashSet<string>(StringComparer.Ordinal);
        var seenCursors = new HashSet<string>(StringComparer.Ordinal);
        bool hasLeases = false;
        string? cursor = null;
        for (int pageIndex = 0; pageIndex < maxPages; pageIndex++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            CommentModerationQueueResponse page = await queue.ListCommentModerationQueuePageAsync(
                status, pageSize, cursor, cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            if (page.Items.Count > maxItems - items.Count
                || (page.Leases?.Count ?? 0) > maxLeases - leases.Count)
            {
                throw new InvalidOperationException("Comment moderation queue exceeded its item or lease read budget.");
            }

            foreach (CommentModerationItemResponse item in page.Items)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (string.IsNullOrWhiteSpace(item.Id) || !seenItems.Add(item.Id))
                {
                    throw new InvalidOperationException("Comment moderation queue returned a missing or repeated item identity.");
                }
                items.Add(item);
            }
            if (page.Leases is not null)
            {
                hasLeases = true;
                foreach (CommentModerationQueueLeaseResponse lease in page.Leases)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    leases.Add(lease);
                }
            }

            cursor = page.NextCursor;
            cancellationToken.ThrowIfCancellationRequested();
            if (cursor is null)
            {
                return page with
                {
                    Items = items.ToArray(),
                    Leases = hasLeases ? leases.ToArray() : null
                };
            }
            if (!seenCursors.Add(cursor))
            {
                throw new InvalidOperationException("Comment moderation queue returned a repeated cursor.");
            }
        }

        throw new InvalidOperationException("Comment moderation queue exhausted its page read budget before completion.");
    }
}
