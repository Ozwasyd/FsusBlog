using System.Buffers.Binary;

namespace FsusBlog.Server.Infrastructure.Pagination;

public readonly record struct MessageConversationCursor(
    long SnapshotMessageId,
    DateTime LastMessageAt,
    long ConversationId)
{
    private const int PayloadSize = sizeof(long) * 3;

    public string Encode()
    {
        Span<byte> payload = stackalloc byte[PayloadSize];
        BinaryPrimitives.WriteInt64LittleEndian(payload, SnapshotMessageId);
        BinaryPrimitives.WriteInt64LittleEndian(payload[sizeof(long)..], LastMessageAt.Ticks);
        BinaryPrimitives.WriteInt64LittleEndian(payload[(sizeof(long) * 2)..], ConversationId);
        return Convert.ToBase64String(payload).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    public static bool TryDecode(string? encoded, out MessageConversationCursor cursor)
    {
        cursor = default;
        if (string.IsNullOrWhiteSpace(encoded))
        {
            return false;
        }

        string normalized = encoded.Replace('-', '+').Replace('_', '/');
        normalized = normalized.PadRight((normalized.Length + 3) / 4 * 4, '=');
        Span<byte> payload = stackalloc byte[PayloadSize];
        if (!Convert.TryFromBase64String(normalized, payload, out int written) || written != PayloadSize)
        {
            return false;
        }

        long snapshotMessageId = BinaryPrimitives.ReadInt64LittleEndian(payload);
        long lastMessageAtTicks = BinaryPrimitives.ReadInt64LittleEndian(payload[sizeof(long)..]);
        long conversationId = BinaryPrimitives.ReadInt64LittleEndian(payload[(sizeof(long) * 2)..]);
        if (snapshotMessageId <= 0 ||
            conversationId <= 0 ||
            lastMessageAtTicks < DateTime.MinValue.Ticks ||
            lastMessageAtTicks > DateTime.MaxValue.Ticks)
        {
            return false;
        }

        cursor = new MessageConversationCursor(
            snapshotMessageId,
            new DateTime(lastMessageAtTicks, DateTimeKind.Utc),
            conversationId);
        return true;
    }
}
