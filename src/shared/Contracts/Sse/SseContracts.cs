using System.Globalization;

namespace FsusBlog.Shared.Contracts.Sse;

public readonly record struct SseCursor(long Value)
{
    public static SseCursor Empty => new(0);

    public bool HasValue => Value > 0;

    public override string ToString() => Value.ToString(CultureInfo.InvariantCulture);

    public static bool TryParse(string? raw, out SseCursor cursor)
    {
        if (long.TryParse(raw, NumberStyles.None, CultureInfo.InvariantCulture, out long value) && value > 0)
        {
            cursor = new SseCursor(value);
            return true;
        }

        cursor = Empty;
        return false;
    }
}

public enum SseEventType : short
{
    NoticeReceived = 1,
    GlobalNoticePublished = 2,
    UnreadCountUpdated = 3,
    UserStatusChanged = 4,
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

public readonly record struct SseEnvelopeV2<TPayload>(long Id, SseEventType Type, long Ts, TPayload Payload);
