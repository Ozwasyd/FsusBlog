using System.Buffers;
using System.Buffers.Binary;
using System.Text;

namespace FsusBlog.V2.Contracts;

public sealed record InboxListRecord(long Id, string Subject, int Status, int UnreadCount, DateTimeOffset LastMessageAt,
    DateTimeOffset UpdatedAt, bool IsSystem, bool CanReply, InboxPreviewRecord? LastMessage);

public sealed record InboxPreviewRecord(int Sender, DateTimeOffset CreatedAt, string Body, string? Name = null);

public sealed record InboxDetailRecord(long Id, string Subject, int Status, int UnreadCount, DateTimeOffset LastMessageAt,
    long ReadSnapshot, bool IsSystem, bool CanReply, IReadOnlyList<InboxMessageRecord> Messages, long? Previous = null, bool Replayed = false);

public sealed record InboxMessageRecord(long Id, long ConversationId, int Sender, DateTimeOffset CreatedAt,
    string Body, string? Name = null, bool Replayed = false);

public readonly record struct InboxCursor(long SnapshotMessageId, DateTimeOffset LastMessageAt, long ConversationId);

public static class InboxWire
{
    private const int CursorEnvelopeMagic = 0x4D534743;
    private const int CursorEnvelopeVersion = 1;
    private const int SubjectBytes = 640;
    private const int BodyBytes = 16_000;
    private static readonly UTF8Encoding Utf8 = new(false, true);

    public const int MaxRequestFrameBytes = 20 * 1024;
    public const int MaxAdminStatusFrameBytes = Aeds.HeaderSize + 16 + 1024;

    public static byte[] EncodeCreate(string subject, string body) =>
        new PodWriter().Text(subject, SubjectBytes).Text(body, BodyBytes).Frame(FrameType.ConversationCreateRequest);

    public static byte[] EncodeReply(long readThroughMessageId, string body)
    {
        if (readThroughMessageId <= 0) throw Invalid();
        return new PodWriter().I64(readThroughMessageId).Text(body, BodyBytes).Frame(FrameType.AccountConversationReplyRequest);
    }

    public static byte[] EncodeAdminReply(string body) =>
        new PodWriter().Text(body, BodyBytes).Frame(FrameType.ConversationReplyRequest);

    public static string DecodeAdminReply(ReadOnlySpan<byte> frame)
    {
        var payload = DecodeRequest(frame, FrameType.ConversationReplyRequest);
        return ReadText(payload, ReadArena(payload, 8), BodyBytes);
    }

    public static byte[] EncodeAdminStatus(int target, string reason)
    {
        CheckStatus(target);
        return new PodWriter().I32(target).Text(reason, 1024).Frame(FrameType.ConversationStatusRequest);
    }

    public static (int Target, string Reason) DecodeAdminStatus(ReadOnlySpan<byte> frame)
    {
        if (frame.Length > MaxAdminStatusFrameBytes) throw Invalid();
        var payload = DecodeRequest(frame, FrameType.ConversationStatusRequest);
        var arena = ReadArena(payload, 12);
        int target = ReadInt32(payload);
        CheckStatus(target);
        return (target, ReadText(payload[4..], arena, 1024));
    }

    public static byte[] EncodeAdminStatusResult(int previous, int current)
    {
        CheckStatus(previous);
        CheckStatus(current);
        var payload = new byte[12];
        BinaryPrimitives.WriteInt32LittleEndian(payload, previous);
        BinaryPrimitives.WriteInt32LittleEndian(payload.AsSpan(4), current);
        payload[8] = previous == current ? (byte)1 : (byte)0;
        return Aeds.Encode(FrameType.ConversationStatusMutationResult, payload);
    }

    private static void CheckStatus(int state)
    {
        if (state is < 0 or > 2) throw Invalid();
    }

    public static (string Subject, string Body) DecodeCreate(ReadOnlySpan<byte> frame)
    {
        var payload = DecodeRequest(frame, FrameType.ConversationCreateRequest);
        var arena = ReadArena(payload, 16);
        return (ReadText(payload, arena, SubjectBytes), ReadText(payload[8..], arena, BodyBytes));
    }

    public static (long ReadThroughMessageId, string Body) DecodeReply(ReadOnlySpan<byte> frame)
    {
        var payload = DecodeRequest(frame, FrameType.AccountConversationReplyRequest);
        var arena = ReadArena(payload, 16);
        var message = ReadInt64(payload);
        if (message <= 0) throw Invalid();
        return (message, ReadText(payload[8..], arena, BodyBytes));
    }

    public static long DecodeRead(ReadOnlySpan<byte> frame)
    {
        var payload = DecodeRequest(frame, FrameType.ConversationReadRequest);
        if (payload.Length != 8) throw Invalid();
        var position = ReadInt64(payload);
        return position > 0 ? position : throw Invalid();
    }

    public static string EncodeCursor(InboxCursor cursor)
    {
        if (cursor.SnapshotMessageId <= 0 || cursor.ConversationId <= 0) throw Invalid();
        Span<byte> bytes = stackalloc byte[24];
        BinaryPrimitives.WriteInt64LittleEndian(bytes, cursor.SnapshotMessageId);
        BinaryPrimitives.WriteInt64LittleEndian(bytes[8..], cursor.LastMessageAt.UtcTicks);
        BinaryPrimitives.WriteInt64LittleEndian(bytes[16..], cursor.ConversationId);
        return Convert.ToBase64String(bytes).Replace('+', '-').Replace('/', '_');
    }

    public static InboxCursor DecodeCursor(string encoded)
    {
        Span<byte> bytes = stackalloc byte[24];
        if (encoded.Length != 32 || encoded.Any(ch => !char.IsAsciiLetterOrDigit(ch) && ch is not ('-' or '_')) ||
            !Convert.TryFromBase64String(encoded.Replace('-', '+').Replace('_', '/'), bytes, out int written) || written != bytes.Length)
            throw Invalid();
        long snapshot = ReadInt64(bytes);
        long ticks = ReadInt64(bytes[8..]);
        long conversation = ReadInt64(bytes[16..]);
        if (snapshot <= 0 || conversation <= 0 || ticks < DateTime.MinValue.Ticks || ticks > DateTime.MaxValue.Ticks)
            throw Invalid();
        return new InboxCursor(snapshot, new DateTimeOffset(ticks, TimeSpan.Zero), conversation);
    }

    public static byte[] EncodeList(IReadOnlyList<InboxListRecord> items, int total, string? nextCursor = null)
    {
        if (items.Count > 50 || total < items.Count) throw Invalid();
        var writer = new PodWriter();
        if (!string.IsNullOrEmpty(nextCursor))
        {
            DecodeCursor(nextCursor);
            writer.I32(CursorEnvelopeMagic).I32(CursorEnvelopeVersion).Bool(true).Text(nextCursor, 32);
        }
        writer.I32(total).I32(items.Count);
        foreach (var item in items)
        {
            CheckSummary(item.Id, item.Status, item.UnreadCount);
            writer.I64(item.Id).I32(item.Status).I32(item.UnreadCount)
                .I64(item.LastMessageAt.ToUnixTimeMilliseconds()).I64(item.UpdatedAt.ToUnixTimeMilliseconds())
                .Bool(item.IsSystem).Bool(item.CanReply).Bool(item.LastMessage is not null).Padding(1)
                .Text(item.Subject, SubjectBytes);
            if (item.LastMessage is { } last)
            {
                CheckSender(last.Sender);
                writer.I32(last.Sender).I64(last.CreatedAt.ToUnixTimeMilliseconds())
                    .Bool(!string.IsNullOrWhiteSpace(last.Name)).Padding(3)
                    .Text(last.Name, SubjectBytes).Text(last.Body, BodyBytes);
            }
            else writer.Padding(32);
        }
        return writer.Frame(FrameType.ConversationList);
    }

    public static byte[] EncodeDetail(InboxDetailRecord detail, bool createResponse = false)
    {
        CheckSummary(detail.Id, detail.Status, detail.UnreadCount);
        if (detail.ReadSnapshot <= 0 || detail.Messages.Count > 100 || detail.Previous <= 0 || createResponse && detail.Previous is not null)
            throw Invalid();
        var writer = new PodWriter().I64(detail.Id).I32(detail.Status).I32(detail.UnreadCount)
            .I64(detail.LastMessageAt.ToUnixTimeMilliseconds()).I64(detail.ReadSnapshot);
        if (!createResponse) writer.I64(detail.Previous ?? 0);
        writer.Bool(detail.IsSystem).Bool(detail.CanReply).Bool(createResponse ? detail.Replayed : detail.Previous.HasValue)
            .Padding(1).Text(detail.Subject, SubjectBytes).I32(detail.Messages.Count);
        foreach (var message in detail.Messages)
        {
            if (message.ConversationId != detail.Id) throw Invalid();
            WriteMessage(writer, message);
        }
        return writer.Frame(createResponse ? FrameType.ConversationDetailV2 : FrameType.ConversationDetailV3);
    }

    public static byte[] EncodeMessage(InboxMessageRecord message)
    {
        var writer = new PodWriter();
        WriteMessage(writer, message);
        return writer.Frame(FrameType.ConversationMessage);
    }

    private static void WriteMessage(PodWriter writer, InboxMessageRecord message)
    {
        if (message.Id <= 0 || message.ConversationId <= 0) throw Invalid();
        CheckSender(message.Sender);
        writer.I64(message.Id).I64(message.ConversationId).I32(message.Sender)
            .I64(message.CreatedAt.ToUnixTimeMilliseconds()).Bool(!string.IsNullOrWhiteSpace(message.Name))
            .Bool(message.Replayed).Padding(2).Text(message.Name, SubjectBytes).Text(message.Body, BodyBytes);
    }

    private static ReadOnlySpan<byte> DecodeRequest(ReadOnlySpan<byte> frame, FrameType kind)
        => frame.Length <= MaxRequestFrameBytes ? Aeds.Decode(frame, kind) : throw Invalid();

    private static ReadOnlySpan<byte> ReadArena(ReadOnlySpan<byte> payload, int headerBytes)
    {
        if (payload.Length < headerBytes + 4 || ReadInt32(payload[headerBytes..]) != payload.Length - headerBytes - 4)
            throw Invalid();
        return payload[(headerBytes + 4)..];
    }

    private static string ReadText(ReadOnlySpan<byte> slice, ReadOnlySpan<byte> arena, int limit)
    {
        int offset = ReadInt32(slice);
        int length = ReadInt32(slice[4..]);
        if (offset < 0 || length < 0 || length > limit || offset > arena.Length - length)
            throw Invalid();
        try
        {
            return Utf8.GetString(arena.Slice(offset, length));
        }
        catch (DecoderFallbackException)
        {
            throw Invalid();
        }
    }

    private static int ReadInt32(ReadOnlySpan<byte> value) => BinaryPrimitives.ReadInt32LittleEndian(value);
    private static long ReadInt64(ReadOnlySpan<byte> value) => BinaryPrimitives.ReadInt64LittleEndian(value);
    private static ProtocolException Invalid() => new("Invalid inbox AEDS data");

    private static void CheckSummary(long id, int status, int unread)
    {
        if (id <= 0 || status is < 0 or > 2 || unread < 0) throw Invalid();
    }

    private static void CheckSender(int sender)
    {
        if (sender is < 0 or > 2) throw Invalid();
    }

    private sealed class PodWriter : ScalarBufferWriter<PodWriter>
    {
        private readonly ArrayBufferWriter<byte> arena = new();

        public PodWriter Padding(int length)
        {
            buffer.GetSpan(length)[..length].Clear();
            buffer.Advance(length);
            return this;
        }

        public PodWriter Text(string? value, int limit)
        {
            value ??= "";
            int length = Utf8.GetByteCount(value);
            if (length > limit) throw Invalid();
            I32(arena.WrittenCount);
            I32(length);
            if (length > 0) arena.Advance(Utf8.GetBytes(value, arena.GetSpan(length)));
            return this;
        }

        public byte[] Frame(FrameType type)
        {
            I32(arena.WrittenCount);
            buffer.Write(arena.WrittenSpan);
            return Aeds.Encode(type, buffer.WrittenSpan);
        }
    }
}
