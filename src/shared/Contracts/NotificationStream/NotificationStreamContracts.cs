using System.Globalization;

namespace FsusBlog.Shared.Contracts.NotificationStream;

public readonly record struct NotificationStreamCursor(long Value)
{
    public static NotificationStreamCursor Empty => new(0);

    public bool HasValue => Value > 0;

    public override string ToString() => Value.ToString(CultureInfo.InvariantCulture);

    public static bool TryParse(string? raw, out NotificationStreamCursor cursor)
    {
        if (long.TryParse(raw, NumberStyles.None, CultureInfo.InvariantCulture, out long value) && value > 0)
        {
            cursor = new NotificationStreamCursor(value);
            return true;
        }

        cursor = Empty;
        return false;
    }
}

public enum NotificationStreamEventType : short
{
    NoticeReceived = 1,
    GlobalNoticePublished = 2,
    UnreadCountUpdated = 3,
    AccountStatusChanged = 4,
    CommentAdded = 5,
    CommentRemoved = 6,
    MessageReceived = 7,
    ArticleChanged = 8,
    MessageRevoked = 9,
    CacheControl = 10,
    SearchIndexUpdated = 11,
    InboxConversationUpsert = 12,
    InboxMessageAppend = 13,
    InboxReadUpdated = 14,
    InboxConversationClosed = 15
}

public readonly record struct NotificationStreamEnvelopeV2<TPayload>(long Id, NotificationStreamEventType Type, long Ts, TPayload Payload);
