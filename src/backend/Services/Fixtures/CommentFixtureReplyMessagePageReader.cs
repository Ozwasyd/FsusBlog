using System.Globalization;

using FsusBlog.Server.Interfaces;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Services.Fixtures;

/// <summary>Reads all account-visible reply messages through the production older-page query.</summary>
public static class CommentFixtureReplyMessagePageReader
{
    /// <summary>
    /// Returns null only when the initial account projection is unavailable. A missing or invalid
    /// continuation fails instead of presenting a partial message history as complete.
    /// </summary>
    public static async Task<IReadOnlyList<ConversationMessageResponse>?> ReadAsync(
        IMessageQueryService queries,
        int accountId,
        long conversationId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(queries);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(accountId);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(conversationId);
        string expectedConversationId = conversationId.ToString(CultureInfo.InvariantCulture);
        var pages = new List<List<ConversationMessageResponse>>();
        var messageIds = new HashSet<long>();
        long? beforeMessageId = null;
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            ConversationDetailResponse? page = await queries.GetAccountConversationDetailAsync(
                accountId, conversationId, beforeMessageId, cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            if (page is null)
            {
                if (beforeMessageId is null)
                    return null;
                throw new InvalidOperationException("Reply message continuation is missing.");
            }
            if (page.ConversationId != expectedConversationId)
                throw new InvalidOperationException("Reply message page belongs to a different conversation.");
            if (page.Messages is null || page.Messages.Count == 0)
                throw new InvalidOperationException("Reply message page is empty.");

            long previousMessageId = 0;
            foreach (ConversationMessageResponse message in page.Messages)
            {
                if (message is null || message.ConversationId != expectedConversationId)
                    throw new InvalidOperationException("Reply message belongs to a different conversation.");
                long messageId = RequireIdentity(message.MessageId);
                if (!messageIds.Add(messageId))
                    throw new InvalidOperationException("Reply message identity is duplicated.");
                if (messageId <= previousMessageId || (beforeMessageId.HasValue && messageId >= beforeMessageId.Value))
                    throw new InvalidOperationException("Reply message page violates production ordering.");
                previousMessageId = messageId;
            }
            pages.Add(page.Messages);
            if (!page.HasOlder)
            {
                if (page.PreviousCursor is not null)
                    throw new InvalidOperationException("Completed reply message page has an older cursor.");
                break;
            }

            long cursor = RequireIdentity(page.PreviousCursor);
            if (cursor != RequireIdentity(page.Messages[0].MessageId))
                throw new InvalidOperationException("Reply message cursor does not identify the oldest page message.");
            beforeMessageId = cursor;
        }

        // Production returns each page in ascending ID order, with older pages fetched last.
        pages.Reverse();
        return pages.SelectMany(page => page).ToArray();
    }

    private static long RequireIdentity(string? value)
    {
        if (!long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out long identity)
            || identity <= 0 || identity.ToString(CultureInfo.InvariantCulture) != value)
            throw new InvalidOperationException("Reply message identity or cursor is invalid.");
        return identity;
    }
}
