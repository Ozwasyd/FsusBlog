using System.Buffers;
using System.Buffers.Binary;
using System.Collections;
using System.Globalization;
using System.Reflection;
using System.Text;

using FsusBlog.Shared.Contracts.NotificationStream;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Core.Cache;

public static partial class PodBinaryCodec
{
    private const byte NotificationNull = 0;
    private const byte NotificationString = 1;
    private const byte NotificationInt32 = 2;
    private const byte NotificationInt64 = 3;
    private const byte NotificationDouble = 4;
    private const byte NotificationBool = 5;
    private const byte NotificationObject = 6;
    private const byte NotificationArray = 7;

    public static void WriteNotificationEvent<TPayload>(
        long eventId,
        NotificationStreamEventType eventType,
        long timestampUnixMs,
        TPayload payload,
        IBufferWriter<byte> destination)
    {
        using var writer = new NotificationValueWriter(destination);
        writer.WriteInt64(eventId);
        writer.WriteInt64(timestampUnixMs);
        writer.WriteInt32((int)eventType);
        writer.WriteInt32(0);
        writer.WriteValue(payload);
    }

    public static void WriteNotificationHeartbeat(IBufferWriter<byte> destination)
    {
        using var writer = new NotificationValueWriter(destination);
        writer.WriteInt64(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    }

    private sealed class NotificationValueWriter(IBufferWriter<byte> destination) : IDisposable
    {
        public void WriteValue(object? value)
        {
            if (value is null)
            {
                WriteByte(NotificationNull);
                return;
            }

            Type type = value.GetType();
            Type nullableType = Nullable.GetUnderlyingType(type) ?? type;

            if (nullableType == typeof(string))
            {
                WriteByte(NotificationString);
                WriteString((string)value);
                return;
            }

            if (nullableType == typeof(DateTime))
            {
                WriteByte(NotificationString);
                WriteString(((DateTime)value).ToUniversalTime().ToString("O", CultureInfo.InvariantCulture));
                return;
            }

            if (nullableType == typeof(DateTimeOffset))
            {
                WriteByte(NotificationString);
                WriteString(((DateTimeOffset)value).ToUniversalTime().ToString("O", CultureInfo.InvariantCulture));
                return;
            }

            if (nullableType == typeof(bool))
            {
                WriteByte(NotificationBool);
                WriteByte((bool)value ? (byte)1 : (byte)0);
                return;
            }

            if (nullableType.IsEnum)
            {
                WriteByte(NotificationInt32);
                WriteInt32(Convert.ToInt32(value, CultureInfo.InvariantCulture));
                return;
            }

            if (nullableType == typeof(byte) ||
                nullableType == typeof(sbyte) ||
                nullableType == typeof(short) ||
                nullableType == typeof(ushort) ||
                nullableType == typeof(int))
            {
                WriteByte(NotificationInt32);
                WriteInt32(Convert.ToInt32(value, CultureInfo.InvariantCulture));
                return;
            }

            if (nullableType == typeof(uint) ||
                nullableType == typeof(long))
            {
                WriteByte(NotificationInt64);
                WriteInt64(Convert.ToInt64(value, CultureInfo.InvariantCulture));
                return;
            }

            if (nullableType == typeof(ulong))
            {
                WriteByte(NotificationString);
                WriteString(Convert.ToString(value, CultureInfo.InvariantCulture) ?? string.Empty);
                return;
            }

            if (nullableType == typeof(float) ||
                nullableType == typeof(double) ||
                nullableType == typeof(decimal))
            {
                WriteByte(NotificationDouble);
                WriteDouble(Convert.ToDouble(value, CultureInfo.InvariantCulture));
                return;
            }

            if (value is IEnumerable enumerable && value is not string)
            {
                WriteArray(enumerable);
                return;
            }

            if (TryWriteKnownPayload(value))
            {
                return;
            }

            WriteObject(value);
        }

        public void WriteByte(byte value)
        {
            Span<byte> span = destination.GetSpan(1);
            span[0] = value;
            destination.Advance(1);
        }

        public void WriteInt32(int value)
        {
            Span<byte> span = destination.GetSpan(sizeof(int));
            BinaryPrimitives.WriteInt32LittleEndian(span, value);
            destination.Advance(sizeof(int));
        }

        public void WriteInt64(long value)
        {
            Span<byte> span = destination.GetSpan(sizeof(long));
            BinaryPrimitives.WriteInt64LittleEndian(span, value);
            destination.Advance(sizeof(long));
        }

        private void WriteDouble(double value)
        {
            Span<byte> span = destination.GetSpan(sizeof(double));
            BinaryPrimitives.WriteDoubleLittleEndian(span, value);
            destination.Advance(sizeof(double));
        }

        private void WriteString(string value)
        {
            int byteCount = Encoding.UTF8.GetByteCount(value);
            WriteInt32(byteCount);
            Span<byte> span = destination.GetSpan(byteCount);
            Encoding.UTF8.GetBytes(value, span);
            destination.Advance(byteCount);
        }

        private void WriteArray(IEnumerable values)
        {
            var materialized = new List<object?>();
            foreach (object? item in values)
            {
                materialized.Add(item);
            }

            WriteByte(NotificationArray);
            WriteInt32(materialized.Count);
            foreach (object? item in materialized)
            {
                WriteValue(item);
            }
        }

        private bool TryWriteKnownPayload(object value)
        {
            switch (value)
            {
                case ArticleNoticeDto payload:
                    WriteObjectHeader(payload.Preview is null ? 3 : 4);
                    WriteField("articleId", payload.ArticleId);
                    WriteField("action", payload.Action);
                    WriteField("eventTime", payload.EventTime);
                    if (payload.Preview is not null)
                    {
                        WriteField("preview", payload.Preview);
                    }
                    return true;

                case ArticleListItemResponse payload:
                    WriteObjectHeader(6
                        + (payload.Summary is null ? 0 : 1)
                        + (payload.CoverImageUrl is null ? 0 : 1)
                        + (payload.IsDeleted.HasValue ? 1 : 0));
                    WriteField("id", payload.Id);
                    WriteField("title", payload.Title);
                    if (payload.Summary is not null)
                    {
                        WriteField("summary", payload.Summary);
                    }
                    if (payload.CoverImageUrl is not null)
                    {
                        WriteField("coverImageUrl", payload.CoverImageUrl);
                    }
                    WriteField("views", payload.Views);
                    WriteField("createTime", payload.CreateTime);
                    WriteField("category", payload.Category);
                    WriteField("tags", payload.Tags);
                    if (payload.IsDeleted.HasValue)
                    {
                        WriteField("isDeleted", payload.IsDeleted.Value);
                    }
                    return true;

                case ArticleCategoryView payload:
                    WriteObjectHeader(2);
                    WriteField("id", payload.Id);
                    WriteField("name", payload.Name);
                    return true;

                case TagDto payload:
                    WriteObjectHeader(2);
                    WriteField("id", payload.Id);
                    WriteField("name", payload.Name);
                    return true;

                case CommentAddedNotifyDto payload:
                    WriteObjectHeader(3);
                    WriteField("articleId", payload.ArticleId);
                    WriteField("comment", payload.Comment);
                    WriteField("time", payload.Time);
                    return true;

                case CommentPushDto payload:
                    WriteCommentPush(payload);
                    return true;

                case GlobalNoticePayload payload:
                    WriteObjectHeader(3);
                    WriteField("id", payload.id);
                    WriteField("title", payload.title);
                    WriteField("time", payload.time);
                    return true;

                case MessageRevokedPayload payload:
                    WriteObjectHeader(1 + (payload.unreadCount.HasValue ? 1 : 0) + (payload.time.HasValue ? 1 : 0));
                    WriteField("messageId", payload.messageId);
                    if (payload.unreadCount.HasValue)
                    {
                        WriteField("unreadCount", payload.unreadCount.Value);
                    }
                    if (payload.time.HasValue)
                    {
                        WriteField("time", payload.time.Value);
                    }
                    return true;

                case AccountStatusPayload payload:
                    WriteObjectHeader(payload.reason is null ? 2 : 3);
                    WriteField("status", payload.status);
                    if (payload.reason is not null)
                    {
                        WriteField("reason", payload.reason);
                    }
                    WriteField("time", payload.time);
                    return true;

                case SessionRevokedPayload payload:
                    WriteObjectHeader(3);
                    WriteField("reason", payload.reason);
                    WriteField("revokedSessionCount", payload.revokedSessionCount);
                    WriteField("time", payload.time);
                    return true;

                case NoticePayload payload:
                    WriteObjectHeader(3);
                    WriteField("title", payload.title);
                    WriteField("unreadCount", payload.unreadCount);
                    WriteField("time", payload.time);
                    return true;

                case CommentRemovedPayload payload:
                    WriteObjectHeader(3 + (payload.rootId is null ? 0 : 1) + (payload.parentId is null ? 0 : 1));
                    WriteField("articleId", payload.articleId);
                    WriteField("commentId", payload.commentId);
                    if (payload.rootId is not null)
                    {
                        WriteField("rootId", payload.rootId);
                    }
                    if (payload.parentId is not null)
                    {
                        WriteField("parentId", payload.parentId);
                    }
                    WriteField("time", payload.time);
                    return true;

                case CacheControlPayload payload:
                    WriteObjectHeader(1 + (payload.Scope is null ? 0 : 1) + (payload.Cache is null ? 0 : 1) + (payload.Keys is null ? 0 : 1));
                    WriteField("type", payload.Type);
                    if (payload.Scope is not null)
                    {
                        WriteField("scope", payload.Scope);
                    }
                    if (payload.Cache is not null)
                    {
                        WriteField("cache", payload.Cache);
                    }
                    if (payload.Keys is not null)
                    {
                        WriteField("keys", payload.Keys);
                    }
                    return true;

                case SearchIndexUpdatePayload payload:
                    WriteObjectHeader(3);
                    WriteField("version", payload.Version);
                    WriteField("manifestUrl", payload.ManifestUrl);
                    WriteField("generatedAt", payload.GeneratedAt);
                    return true;

                case InboxConversationUpsertPayload payload:
                    WriteObjectHeader(1 + (payload.TotalUnread.HasValue ? 1 : 0) + (payload.Time.HasValue ? 1 : 0));
                    WriteField("conversation", payload.Conversation);
                    if (payload.TotalUnread.HasValue)
                    {
                        WriteField("totalUnread", payload.TotalUnread.Value);
                    }
                    if (payload.Time.HasValue)
                    {
                        WriteField("time", payload.Time.Value);
                    }
                    return true;

                case InboxMessageAppendPayload payload:
                    WriteObjectHeader(2 + (payload.ConversationUnreadCount.HasValue ? 1 : 0) + (payload.TotalUnread.HasValue ? 1 : 0) + (payload.Time.HasValue ? 1 : 0));
                    WriteField("conversationId", payload.ConversationId);
                    WriteField("message", payload.Message);
                    if (payload.ConversationUnreadCount.HasValue)
                    {
                        WriteField("conversationUnreadCount", payload.ConversationUnreadCount.Value);
                    }
                    if (payload.TotalUnread.HasValue)
                    {
                        WriteField("totalUnread", payload.TotalUnread.Value);
                    }
                    if (payload.Time.HasValue)
                    {
                        WriteField("time", payload.Time.Value);
                    }
                    return true;

                case InboxReadUpdatedPayload payload:
                    WriteObjectHeader(2 + (payload.LastReadMessageId is null ? 0 : 1) + (payload.TotalUnread.HasValue ? 1 : 0) + (payload.Time.HasValue ? 1 : 0));
                    WriteField("conversationId", payload.ConversationId);
                    if (payload.LastReadMessageId is not null)
                    {
                        WriteField("lastReadMessageId", payload.LastReadMessageId);
                    }
                    WriteField("conversationUnreadCount", payload.ConversationUnreadCount);
                    if (payload.TotalUnread.HasValue)
                    {
                        WriteField("totalUnread", payload.TotalUnread.Value);
                    }
                    if (payload.Time.HasValue)
                    {
                        WriteField("time", payload.Time.Value);
                    }
                    return true;

                case InboxConversationClosedPayload payload:
                    WriteObjectHeader(3);
                    WriteField("conversationId", payload.ConversationId);
                    WriteField("status", payload.Status);
                    WriteField("time", payload.Time);
                    return true;

                case ConversationListItemResponse payload:
                    WriteConversationListItem(payload);
                    return true;

                case ConversationMessagePreviewResponse payload:
                    WriteObjectHeader(payload.SenderName is null ? 3 : 4);
                    WriteField("senderType", payload.SenderType);
                    if (payload.SenderName is not null)
                    {
                        WriteField("senderName", payload.SenderName);
                    }
                    WriteField("bodyPreview", payload.BodyPreview);
                    WriteField("createdAt", payload.CreatedAt);
                    return true;

                case ConversationMessageResponse payload:
                    WriteObjectHeader(payload.SenderName is null ? 5 : 6);
                    WriteField("messageId", payload.MessageId);
                    WriteField("conversationId", payload.ConversationId);
                    WriteField("senderType", payload.SenderType);
                    if (payload.SenderName is not null)
                    {
                        WriteField("senderName", payload.SenderName);
                    }
                    WriteField("body", payload.Body);
                    WriteField("createdAt", payload.CreatedAt);
                    return true;

                default:
                    return false;
            }
        }

        private void WriteCommentPush(CommentPushDto payload)
        {
            int count = 6
                + (payload.ParentId is null ? 0 : 1)
                + (payload.RootId is null ? 0 : 1)
                + (payload.ReplyToAuthor.HasValue ? 1 : 0)
                + (payload.ReplyToCommentId is null ? 0 : 1);
            WriteObjectHeader(count);
            WriteField("id", payload.Id);
            WriteField("content", payload.Content);
            WriteField("createTime", payload.CreateTime);
            WriteField("author", payload.Author);
            if (payload.ParentId is not null)
            {
                WriteField("parentId", payload.ParentId);
            }
            if (payload.RootId is not null)
            {
                WriteField("rootId", payload.RootId);
            }
            if (payload.ReplyToAuthor.HasValue)
            {
                WriteField("replyToAuthor", payload.ReplyToAuthor.Value);
            }
            if (payload.ReplyToCommentId is not null)
            {
                WriteField("replyToCommentId", payload.ReplyToCommentId);
            }
            WriteField("depth", payload.Depth);
            WriteField("isDeleted", payload.IsDeleted);
        }

        private void WriteCommentAuthorView(CommentAuthorViewDto author)
        {
            int count = 3
                + (author.Badge is null ? 0 : 1)
                + (author.ScopeLabel is null ? 0 : 1);
            WriteObjectHeader(count);
            WriteField("mode", author.Mode);
            WriteField("displayName", author.DisplayName);
            WriteField("displayLanguage", author.DisplayLanguage);
            if (author.Badge is not null)
            {
                WriteField("badge", author.Badge);
            }
            if (author.ScopeLabel is not null)
            {
                WriteField("scopeLabel", author.ScopeLabel);
            }
        }

        private void WriteConversationListItem(ConversationListItemResponse payload)
        {
            WriteObjectHeader(payload.LastMessage is null ? 8 : 9);
            WriteField("conversationId", payload.ConversationId);
            WriteField("subject", payload.Subject);
            WriteField("status", payload.Status);
            WriteField("isSystemSource", payload.IsSystemSource);
            WriteField("canReply", payload.CanReply);
            WriteField("unreadCount", payload.UnreadCount);
            WriteField("lastMessageAt", payload.LastMessageAt);
            WriteField("updatedAt", payload.UpdatedAt);
            if (payload.LastMessage is not null)
            {
                WriteField("lastMessage", payload.LastMessage);
            }
        }

        private void WriteObjectHeader(int fieldCount)
        {
            WriteByte(NotificationObject);
            WriteInt32(fieldCount);
        }

        private void WriteField(string name, object? value)
        {
            WriteString(name);
            WriteValue(value);
        }

        private void WriteObject(object value)
        {
            PropertyInfo[] properties = value.GetType()
                .GetProperties(BindingFlags.Instance | BindingFlags.Public)
                .Where(static property => property.GetIndexParameters().Length == 0)
                .ToArray();

            var fields = new List<(string Name, object? Value)>(properties.Length);
            foreach (PropertyInfo property in properties)
            {
                object? propertyValue = property.GetValue(value);
                if (propertyValue is null)
                {
                    continue;
                }

                fields.Add((ToCamelCase(property.Name), propertyValue));
            }

            WriteByte(NotificationObject);
            WriteInt32(fields.Count);
            foreach ((string name, object? propertyValue) in fields)
            {
                WriteString(name);
                WriteValue(propertyValue);
            }
        }

        private static string ToCamelCase(string value)
            => string.IsNullOrEmpty(value) || char.IsLower(value[0])
                ? value
                : string.Concat(char.ToLowerInvariant(value[0]), value[1..]);

        public void Dispose()
        {
        }
    }
}
