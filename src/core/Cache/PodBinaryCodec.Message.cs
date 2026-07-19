using System.Buffers;
using System.Runtime.InteropServices;

using FsusBlog.Core.Mapping.Codecs;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Mapping.Projectors;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Outputs;
using FsusBlog.Shared.Contracts.Primitives;

namespace FsusBlog.Core.Cache;

/// <summary>
/// Provides binary serialization and decoding operations for message contracts.
/// </summary>
public static partial class PodBinaryCodec
{
    private const int ConversationListCursorEnvelopeMagic = 0x4D534743;
    private const int ConversationListCursorEnvelopeVersion = 1;

    /// <summary>
    /// Writes the <c>ConversationList</c> contract to the supplied binary destination.
    /// </summary>
    public static void WriteConversationList(PageResponse<ConversationListItemResponse> page, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(1024);
        var writer = new BinaryPodWriter(destination);
        if (page.HasMore || !string.IsNullOrEmpty(page.NextCursor))
        {
            Utf8SliceRef nextCursor = PodUtf8Codec.AppendSlice(page.NextCursor ?? string.Empty, payload);
            writer.WriteInt32(ConversationListCursorEnvelopeMagic);
            writer.WriteInt32(ConversationListCursorEnvelopeVersion);
            writer.WriteByte(page.HasMore ? (byte)1 : (byte)0);
            writer.WriteSliceRef(nextCursor);
        }

        writer.WriteInt32(page.Total);
        writer.WriteInt32(page.Items.Count);

        foreach (ConversationListItemResponse item in page.Items)
        {
            writer.WritePod(CreateConversationListItemPod(item, payload));
        }

        writer.WriteBytes(payload.WrittenSpan);
    }

    /// <summary>
    /// Encodes the <c>ConversationList</c> contract into a new binary payload.
    /// </summary>
    public static byte[] EncodeConversationList(PageResponse<ConversationListItemResponse> page)
        => EncodeToArray(1024 + page.Items.Count * Marshal.SizeOf<ConversationListItemPod>(), writer => WriteConversationList(page, writer));

    /// <summary>
    /// Attempts to decode the <c>ConversationList</c> contract from a binary payload.
    /// </summary>
    public static bool TryDecodeConversationList(ReadOnlyMemory<byte> source, out PageResponse<ConversationListItemResponse> page)
    {
        var reader = new BinaryPodReader(source.Span);
        bool hasMore = false;
        Utf8SliceRef nextCursorSlice = default;
        if (!reader.TryReadInt32(out int total))
        {
            page = new PageResponse<ConversationListItemResponse>();
            return false;
        }

        if (total == ConversationListCursorEnvelopeMagic)
        {
            if (!reader.TryReadInt32(out int version) ||
                version != ConversationListCursorEnvelopeVersion ||
                !reader.TryReadByte(out byte hasMoreByte) ||
                hasMoreByte > 1 ||
                !reader.TryReadSliceRef(out nextCursorSlice) ||
                !reader.TryReadInt32(out total))
            {
                page = new PageResponse<ConversationListItemResponse>();
                return false;
            }

            hasMore = hasMoreByte == 1;
        }

        if (!reader.TryReadInt32(out int count) || total < 0 || count < 0)
        {
            page = new PageResponse<ConversationListItemResponse>();
            return false;
        }

        var pods = new List<ConversationListItemPod>(count);
        for (int i = 0; i < count; i++)
        {
            if (!reader.TryReadPod(out ConversationListItemPod pod) ||
                pod.IsSystemSource > 1 ||
                pod.CanReply > 1 ||
                pod.HasLastMessage > 1 ||
                pod.LastMessage.HasSenderName > 1)
            {
                page = new PageResponse<ConversationListItemResponse>();
                return false;
            }

            pods.Add(pod);
        }

        if (!reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            page = new PageResponse<ConversationListItemResponse>();
            return false;
        }

        var items = new List<ConversationListItemResponse>(count);
        foreach (ConversationListItemPod pod in pods)
        {
            items.Add(new ConversationListItemResponse
            {
                ConversationId = pod.ConversationId.ToString(),
                Subject = PodProjector.ReadSlice(pod.Subject, payload),
                Status = ToConversationStatus(pod.Status),
                IsSystemSource = pod.IsSystemSource == 1,
                CanReply = pod.CanReply == 1,
                UnreadCount = pod.UnreadCount,
                LastMessageAt = PodTimeCodec.FromUnixMs(pod.LastMessageAtUnixMs),
                UpdatedAt = PodTimeCodec.FromUnixMs(pod.UpdatedAtUnixMs),
                LastMessage = pod.HasLastMessage == 1 ? DecodePreview(pod.LastMessage, payload) : null
            });
        }

        string? nextCursor = hasMore ? PodProjector.ReadSlice(nextCursorSlice, payload) : null;
        if (hasMore && string.IsNullOrWhiteSpace(nextCursor))
        {
            page = new PageResponse<ConversationListItemResponse>();
            return false;
        }

        page = new PageResponse<ConversationListItemResponse>
        {
            Total = total,
            Items = items,
            NextCursor = nextCursor,
            HasMore = hasMore
        };
        return reader.IsConsumed;
    }

    /// <summary>
    /// Writes the admin-only conversation list projection.
    /// </summary>
    public static void WriteAdminConversationList(PageResponse<AdminConversationListItemResponse> page, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(1024);
        var writer = new BinaryPodWriter(destination);
        if (page.HasMore || !string.IsNullOrEmpty(page.NextCursor))
        {
            Utf8SliceRef nextCursor = PodUtf8Codec.AppendSlice(page.NextCursor ?? string.Empty, payload);
            writer.WriteInt32(ConversationListCursorEnvelopeMagic);
            writer.WriteInt32(ConversationListCursorEnvelopeVersion);
            writer.WriteByte(page.HasMore ? (byte)1 : (byte)0);
            writer.WriteSliceRef(nextCursor);
        }

        writer.WriteInt32(page.Total);
        writer.WriteInt32(page.Items.Count);
        foreach (AdminConversationListItemResponse item in page.Items)
        {
            var mutable = new MutableAdminConversationListItemPod
            {
                Conversation = CreateConversationListItemPod(item, payload),
                CounterpartyAccountId = ParseId(item.CounterpartyAccountId),
                CounterpartyAccountStatus = (int)item.CounterpartyAccountStatus,
                Reserved0 = 0
            };
            writer.WritePod(CastMessagePod<MutableAdminConversationListItemPod, AdminConversationListItemPod>(mutable));
        }

        writer.WriteBytes(payload.WrittenSpan);
    }

    /// <summary>
    /// Encodes the admin-only conversation list projection into its AEDS payload.
    /// </summary>
    public static byte[] EncodeAdminConversationList(PageResponse<AdminConversationListItemResponse> page)
        => EncodeToArray(1024 + page.Items.Count * Marshal.SizeOf<AdminConversationListItemPod>(), writer => WriteAdminConversationList(page, writer));

    /// <summary>
    /// Decodes and validates an admin-only conversation list projection payload.
    /// </summary>
    public static bool TryDecodeAdminConversationList(ReadOnlyMemory<byte> source, out PageResponse<AdminConversationListItemResponse> page)
    {
        var reader = new BinaryPodReader(source.Span);
        bool hasMore = false;
        Utf8SliceRef nextCursorSlice = default;
        if (!reader.TryReadInt32(out int total))
        {
            page = new PageResponse<AdminConversationListItemResponse>();
            return false;
        }

        if (total == ConversationListCursorEnvelopeMagic)
        {
            if (!reader.TryReadInt32(out int version) ||
                version != ConversationListCursorEnvelopeVersion ||
                !reader.TryReadByte(out byte hasMoreByte) ||
                hasMoreByte > 1 ||
                !reader.TryReadSliceRef(out nextCursorSlice) ||
                !reader.TryReadInt32(out total))
            {
                page = new PageResponse<AdminConversationListItemResponse>();
                return false;
            }

            hasMore = hasMoreByte == 1;
        }

        if (!reader.TryReadInt32(out int count) || total < 0 || count < 0)
        {
            page = new PageResponse<AdminConversationListItemResponse>();
            return false;
        }

        var pods = new List<AdminConversationListItemPod>(count);
        for (int i = 0; i < count; i++)
        {
            if (!reader.TryReadPod(out AdminConversationListItemPod pod) ||
                !IsValidConversationListItem(pod.Conversation) ||
                pod.CounterpartyAccountId < 0 ||
                pod.CounterpartyAccountStatus is < 0 or > 3 ||
                (pod.CounterpartyAccountId == 0 && pod.CounterpartyAccountStatus != (int)CounterpartyAccountStatusValue.Missing))
            {
                page = new PageResponse<AdminConversationListItemResponse>();
                return false;
            }

            pods.Add(pod);
        }

        if (!reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            page = new PageResponse<AdminConversationListItemResponse>();
            return false;
        }

        var items = new List<AdminConversationListItemResponse>(count);
        foreach (AdminConversationListItemPod pod in pods)
        {
            ConversationListItemResponse conversation = DecodeConversationListItem(pod.Conversation, payload);
            items.Add(new AdminConversationListItemResponse
            {
                ConversationId = conversation.ConversationId,
                Subject = conversation.Subject,
                Status = conversation.Status,
                IsSystemSource = conversation.IsSystemSource,
                CanReply = conversation.CanReply,
                UnreadCount = conversation.UnreadCount,
                LastMessageAt = conversation.LastMessageAt,
                UpdatedAt = conversation.UpdatedAt,
                LastMessage = conversation.LastMessage,
                CounterpartyAccountId = pod.CounterpartyAccountId.ToString(),
                CounterpartyAccountStatus = (CounterpartyAccountStatusValue)pod.CounterpartyAccountStatus
            });
        }

        string? nextCursor = hasMore ? PodProjector.ReadSlice(nextCursorSlice, payload) : null;
        if (hasMore && string.IsNullOrWhiteSpace(nextCursor))
        {
            page = new PageResponse<AdminConversationListItemResponse>();
            return false;
        }

        page = new PageResponse<AdminConversationListItemResponse>
        {
            Total = total,
            Items = items,
            NextCursor = nextCursor,
            HasMore = hasMore
        };
        return reader.IsConsumed;
    }

    /// <summary>
    /// Writes the <c>ConversationDetail</c> contract to the supplied binary destination.
    /// </summary>
    public static void WriteConversationDetail(ConversationDetailResponse detail, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(1024);
        var writer = new BinaryPodWriter(destination);
        var mutable = new MutableConversationDetailPod
        {
            ConversationId = ParseId(detail.ConversationId),
            Status = (int)detail.Status,
            UnreadCount = detail.UnreadCount,
            LastMessageAtUnixMs = PodTimeCodec.ToUnixMs(detail.LastMessageAt),
            IsSystemSource = detail.IsSystemSource ? (byte)1 : (byte)0,
            CanReply = detail.CanReply ? (byte)1 : (byte)0,
            Reserved0 = 0,
            Subject = PodUtf8Codec.AppendSlice(detail.Subject, payload)
        };
        writer.WritePod(CastMessagePod<MutableConversationDetailPod, ConversationDetailPod>(mutable));
        writer.WriteInt32(detail.Messages.Count);
        foreach (ConversationMessageResponse message in detail.Messages)
        {
            writer.WritePod(CreateMessagePod(message, payload));
        }

        writer.WriteBytes(payload.WrittenSpan);
    }

    /// <summary>
    /// Encodes the <c>ConversationDetail</c> contract into a new binary payload.
    /// </summary>
    public static byte[] EncodeConversationDetail(ConversationDetailResponse detail)
        => EncodeToArray(1024 + detail.Messages.Count * Marshal.SizeOf<ConversationMessagePod>(), writer => WriteConversationDetail(detail, writer));

    /// <summary>
    /// Writes the v2 <c>ConversationDetail</c> contract, including the exact
    /// visible message snapshot that an account may acknowledge.
    /// </summary>
    public static void WriteConversationDetailV2(ConversationDetailResponse detail, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(1024);
        var writer = new BinaryPodWriter(destination);
        var mutable = new MutableConversationDetailV2Pod
        {
            ConversationId = ParseId(detail.ConversationId),
            Status = (int)detail.Status,
            UnreadCount = detail.UnreadCount,
            LastMessageAtUnixMs = PodTimeCodec.ToUnixMs(detail.LastMessageAt),
            ReadSnapshotMessageId = ParseId(detail.ReadSnapshotMessageId),
            IsSystemSource = detail.IsSystemSource ? (byte)1 : (byte)0,
            CanReply = detail.CanReply ? (byte)1 : (byte)0,
            Reserved0 = 0,
            Subject = PodUtf8Codec.AppendSlice(detail.Subject, payload)
        };
        writer.WritePod(CastMessagePod<MutableConversationDetailV2Pod, ConversationDetailV2Pod>(mutable));
        writer.WriteInt32(detail.Messages.Count);
        foreach (ConversationMessageResponse message in detail.Messages)
        {
            writer.WritePod(CreateMessagePod(message, payload));
        }

        writer.WriteBytes(payload.WrittenSpan);
    }

    /// <summary>
    /// Encodes a version 2 conversation detail payload.
    /// </summary>
    public static byte[] EncodeConversationDetailV2(ConversationDetailResponse detail)
        => EncodeToArray(1024 + detail.Messages.Count * Marshal.SizeOf<ConversationMessagePod>(), writer => WriteConversationDetailV2(detail, writer));

    /// <summary>
    /// Decodes and validates a version 2 conversation detail payload.
    /// </summary>
    public static bool TryDecodeConversationDetailV2(ReadOnlyMemory<byte> source, out ConversationDetailResponse detail)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out ConversationDetailV2Pod pod) ||
            !reader.TryReadInt32(out int count) ||
            count < 0 ||
            pod.ReadSnapshotMessageId <= 0 ||
            pod.IsSystemSource > 1 ||
            pod.CanReply > 1)
        {
            detail = new ConversationDetailResponse();
            return false;
        }

        var messagePods = new List<ConversationMessagePod>(count);
        for (int i = 0; i < count; i++)
        {
            if (!reader.TryReadPod(out ConversationMessagePod messagePod) || messagePod.HasSenderName > 1)
            {
                detail = new ConversationDetailResponse();
                return false;
            }

            messagePods.Add(messagePod);
        }

        if (!reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            detail = new ConversationDetailResponse();
            return false;
        }

        var messages = new List<ConversationMessageResponse>(messagePods.Count);
        foreach (ConversationMessagePod messagePod in messagePods)
        {
            messages.Add(DecodeMessage(messagePod, payload));
        }

        detail = new ConversationDetailResponse
        {
            ConversationId = pod.ConversationId.ToString(),
            ReadSnapshotMessageId = pod.ReadSnapshotMessageId.ToString(),
            Subject = PodProjector.ReadSlice(pod.Subject, payload),
            Status = ToConversationStatus(pod.Status),
            IsSystemSource = pod.IsSystemSource == 1,
            CanReply = pod.CanReply == 1,
            UnreadCount = pod.UnreadCount,
            LastMessageAt = PodTimeCodec.FromUnixMs(pod.LastMessageAtUnixMs),
            Messages = messages
        };
        return reader.IsConsumed;
    }

    /// <summary>
    /// Writes a bounded conversation-message page with an explicit cursor for
    /// loading older rows.
    /// </summary>
    public static void WriteConversationDetailV3(ConversationDetailResponse detail, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(1024);
        var writer = new BinaryPodWriter(destination);
        var mutable = new MutableConversationDetailV3Pod
        {
            ConversationId = ParseId(detail.ConversationId),
            Status = (int)detail.Status,
            UnreadCount = detail.UnreadCount,
            LastMessageAtUnixMs = PodTimeCodec.ToUnixMs(detail.LastMessageAt),
            ReadSnapshotMessageId = ParseId(detail.ReadSnapshotMessageId),
            PreviousCursorMessageId = string.IsNullOrWhiteSpace(detail.PreviousCursor) ? 0 : ParseId(detail.PreviousCursor),
            IsSystemSource = detail.IsSystemSource ? (byte)1 : (byte)0,
            CanReply = detail.CanReply ? (byte)1 : (byte)0,
            HasOlder = detail.HasOlder ? (byte)1 : (byte)0,
            Reserved0 = 0,
            Subject = PodUtf8Codec.AppendSlice(detail.Subject, payload)
        };
        writer.WritePod(CastMessagePod<MutableConversationDetailV3Pod, ConversationDetailV3Pod>(mutable));
        writer.WriteInt32(detail.Messages.Count);
        foreach (ConversationMessageResponse message in detail.Messages)
        {
            writer.WritePod(CreateMessagePod(message, payload));
        }

        writer.WriteBytes(payload.WrittenSpan);
    }

    /// <summary>
    /// Writes an admin-only conversation detail projection to the supplied buffer.
    /// </summary>
    public static void WriteAdminConversationDetail(AdminConversationDetailResponse detail, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(1024);
        var writer = new BinaryPodWriter(destination);
        var mutable = new MutableAdminConversationDetailPod
        {
            Conversation = CreateConversationDetailV3Pod(detail, payload),
            CounterpartyAccountId = ParseId(detail.CounterpartyAccountId),
            CounterpartyAccountStatus = (int)detail.CounterpartyAccountStatus,
            Reserved0 = 0
        };
        writer.WritePod(CastMessagePod<MutableAdminConversationDetailPod, AdminConversationDetailPod>(mutable));
        writer.WriteInt32(detail.Messages.Count);
        foreach (ConversationMessageResponse message in detail.Messages)
        {
            writer.WritePod(CreateMessagePod(message, payload));
        }

        writer.WriteBytes(payload.WrittenSpan);
    }

    /// <summary>
    /// Encodes an admin-only conversation detail projection into its AEDS payload.
    /// </summary>
    public static byte[] EncodeAdminConversationDetail(AdminConversationDetailResponse detail)
        => EncodeToArray(1024 + detail.Messages.Count * Marshal.SizeOf<ConversationMessagePod>(), writer => WriteAdminConversationDetail(detail, writer));

    /// <summary>
    /// Decodes and validates an admin-only conversation detail projection payload.
    /// </summary>
    public static bool TryDecodeAdminConversationDetail(ReadOnlyMemory<byte> source, out AdminConversationDetailResponse detail)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out AdminConversationDetailPod adminPod) ||
            !reader.TryReadInt32(out int count) ||
            count < 0 ||
            adminPod.CounterpartyAccountId < 0 ||
            adminPod.CounterpartyAccountStatus is < 0 or > 3 ||
            (adminPod.CounterpartyAccountId == 0 && adminPod.CounterpartyAccountStatus != (int)CounterpartyAccountStatusValue.Missing) ||
            !IsValidConversationDetailV3(adminPod.Conversation))
        {
            detail = new AdminConversationDetailResponse();
            return false;
        }

        var messagePods = new List<ConversationMessagePod>(count);
        for (int i = 0; i < count; i++)
        {
            if (!reader.TryReadPod(out ConversationMessagePod messagePod) || messagePod.HasSenderName > 1)
            {
                detail = new AdminConversationDetailResponse();
                return false;
            }

            messagePods.Add(messagePod);
        }

        if (!reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            detail = new AdminConversationDetailResponse();
            return false;
        }

        ConversationDetailV3Pod pod = adminPod.Conversation;
        var messages = new List<ConversationMessageResponse>(messagePods.Count);
        foreach (ConversationMessagePod messagePod in messagePods)
        {
            messages.Add(DecodeMessage(messagePod, payload));
        }

        detail = new AdminConversationDetailResponse
        {
            ConversationId = pod.ConversationId.ToString(),
            ReadSnapshotMessageId = pod.ReadSnapshotMessageId.ToString(),
            PreviousCursor = pod.HasOlder == 1 ? pod.PreviousCursorMessageId.ToString() : null,
            HasOlder = pod.HasOlder == 1,
            Subject = PodProjector.ReadSlice(pod.Subject, payload),
            Status = ToConversationStatus(pod.Status),
            IsSystemSource = pod.IsSystemSource == 1,
            CanReply = pod.CanReply == 1,
            UnreadCount = pod.UnreadCount,
            LastMessageAt = PodTimeCodec.FromUnixMs(pod.LastMessageAtUnixMs),
            Messages = messages,
            CounterpartyAccountId = adminPod.CounterpartyAccountId.ToString(),
            CounterpartyAccountStatus = (CounterpartyAccountStatusValue)adminPod.CounterpartyAccountStatus
        };
        return reader.IsConsumed;
    }

    /// <summary>
    /// Encodes a paged version 3 conversation detail payload.
    /// </summary>
    public static byte[] EncodeConversationDetailV3(ConversationDetailResponse detail)
        => EncodeToArray(1024 + detail.Messages.Count * Marshal.SizeOf<ConversationMessagePod>(), writer => WriteConversationDetailV3(detail, writer));

    /// <summary>
    /// Decodes and validates a paged version 3 conversation detail payload.
    /// </summary>
    public static bool TryDecodeConversationDetailV3(ReadOnlyMemory<byte> source, out ConversationDetailResponse detail)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out ConversationDetailV3Pod pod) ||
            !reader.TryReadInt32(out int count) ||
            count < 0 ||
            pod.ReadSnapshotMessageId <= 0 ||
            pod.IsSystemSource > 1 ||
            pod.CanReply > 1 ||
            pod.HasOlder > 1 ||
            (pod.HasOlder == 1) != (pod.PreviousCursorMessageId > 0))
        {
            detail = new ConversationDetailResponse();
            return false;
        }

        var messagePods = new List<ConversationMessagePod>(count);
        for (int i = 0; i < count; i++)
        {
            if (!reader.TryReadPod(out ConversationMessagePod messagePod) || messagePod.HasSenderName > 1)
            {
                detail = new ConversationDetailResponse();
                return false;
            }

            messagePods.Add(messagePod);
        }

        if (!reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            detail = new ConversationDetailResponse();
            return false;
        }

        var messages = new List<ConversationMessageResponse>(messagePods.Count);
        foreach (ConversationMessagePod messagePod in messagePods)
        {
            messages.Add(DecodeMessage(messagePod, payload));
        }

        detail = new ConversationDetailResponse
        {
            ConversationId = pod.ConversationId.ToString(),
            ReadSnapshotMessageId = pod.ReadSnapshotMessageId.ToString(),
            PreviousCursor = pod.HasOlder == 1 ? pod.PreviousCursorMessageId.ToString() : null,
            HasOlder = pod.HasOlder == 1,
            Subject = PodProjector.ReadSlice(pod.Subject, payload),
            Status = ToConversationStatus(pod.Status),
            IsSystemSource = pod.IsSystemSource == 1,
            CanReply = pod.CanReply == 1,
            UnreadCount = pod.UnreadCount,
            LastMessageAt = PodTimeCodec.FromUnixMs(pod.LastMessageAtUnixMs),
            Messages = messages
        };
        return reader.IsConsumed;
    }

    /// <summary>
    /// Attempts to decode the <c>ConversationDetail</c> contract from a binary payload.
    /// </summary>
    public static bool TryDecodeConversationDetail(ReadOnlyMemory<byte> source, out ConversationDetailResponse detail)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out ConversationDetailPod pod) ||
            !reader.TryReadInt32(out int count) ||
            count < 0 ||
            pod.IsSystemSource > 1 ||
            pod.CanReply > 1)
        {
            detail = new ConversationDetailResponse();
            return false;
        }

        var messagePods = new List<ConversationMessagePod>(count);
        for (int i = 0; i < count; i++)
        {
            if (!reader.TryReadPod(out ConversationMessagePod messagePod) || messagePod.HasSenderName > 1)
            {
                detail = new ConversationDetailResponse();
                return false;
            }

            messagePods.Add(messagePod);
        }

        if (!reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            detail = new ConversationDetailResponse();
            return false;
        }

        var messages = new List<ConversationMessageResponse>(messagePods.Count);
        foreach (ConversationMessagePod messagePod in messagePods)
        {
            messages.Add(DecodeMessage(messagePod, payload));
        }

        detail = new ConversationDetailResponse
        {
            ConversationId = pod.ConversationId.ToString(),
            Subject = PodProjector.ReadSlice(pod.Subject, payload),
            Status = ToConversationStatus(pod.Status),
            IsSystemSource = pod.IsSystemSource == 1,
            CanReply = pod.CanReply == 1,
            UnreadCount = pod.UnreadCount,
            LastMessageAt = PodTimeCodec.FromUnixMs(pod.LastMessageAtUnixMs),
            Messages = messages
        };
        return reader.IsConsumed;
    }

    /// <summary>
    /// Writes the <c>ConversationMessage</c> contract to the supplied binary destination.
    /// </summary>
    public static void WriteConversationMessage(ConversationMessageResponse message, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(512);
        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CreateMessagePod(message, payload));
        writer.WriteBytes(payload.WrittenSpan);
    }

    /// <summary>
    /// Encodes the <c>ConversationMessage</c> contract into a new binary payload.
    /// </summary>
    public static byte[] EncodeConversationMessage(ConversationMessageResponse message)
        => EncodeToArray(512, writer => WriteConversationMessage(message, writer));

    /// <summary>
    /// Attempts to decode the <c>ConversationMessage</c> contract from a binary payload.
    /// </summary>
    public static bool TryDecodeConversationMessage(ReadOnlyMemory<byte> source, out ConversationMessageResponse message)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out ConversationMessagePod pod) || pod.HasSenderName > 1 || !reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            message = new ConversationMessageResponse();
            return false;
        }

        message = DecodeMessage(pod, payload);
        return reader.IsConsumed;
    }

    /// <summary>
    /// Writes the <c>ConversationCreateRequest</c> contract to the supplied binary destination.
    /// </summary>
    public static void WriteConversationCreateRequest(ConversationCreateRequestCoreModel request, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(256);
        var mutable = new MutableConversationCreateRequestPod
        {
            Subject = PodUtf8Codec.AppendSlice(request.Subject, payload),
            Body = PodUtf8Codec.AppendSlice(request.Body, payload)
        };
        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CastMessagePod<MutableConversationCreateRequestPod, ConversationCreateRequestPod>(mutable));
        writer.WriteBytes(payload.WrittenSpan);
    }

    /// <summary>
    /// Encodes the <c>ConversationCreateRequest</c> contract into a new binary payload.
    /// </summary>
    public static byte[] EncodeConversationCreateRequest(ConversationCreateRequestCoreModel request)
        => EncodeToArray(256, writer => WriteConversationCreateRequest(request, writer));

    /// <summary>
    /// Attempts to decode the <c>ConversationCreateRequest</c> contract from a binary payload.
    /// </summary>
    public static bool TryDecodeConversationCreateRequest(ReadOnlyMemory<byte> source, out ConversationCreateRequestCoreModel request)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out ConversationCreateRequestPod pod) || !reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            request = default;
            return false;
        }

        request = new ConversationCreateRequestCoreModel(
            PodProjector.ReadSlice(pod.Subject, payload),
            PodProjector.ReadSlice(pod.Body, payload));
        return reader.IsConsumed;
    }

    /// <summary>
    /// Writes the explicit conversation read cursor request payload.
    /// </summary>
    public static void WriteConversationReadRequest(ConversationReadRequestCoreModel request, IBufferWriter<byte> destination)
    {
        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CastMessagePod<MutableConversationReadRequestPod, ConversationReadRequestPod>(
            new MutableConversationReadRequestPod { ReadThroughMessageId = request.ReadThroughMessageId }));
    }

    /// <summary>
    /// Encodes the explicit conversation read cursor request.
    /// </summary>
    public static byte[] EncodeConversationReadRequest(ConversationReadRequestCoreModel request)
        => EncodeToArray(Marshal.SizeOf<ConversationReadRequestPod>(), writer => WriteConversationReadRequest(request, writer));

    /// <summary>
    /// Decodes and validates an explicit conversation read cursor request.
    /// </summary>
    public static bool TryDecodeConversationReadRequest(ReadOnlyMemory<byte> source, out ConversationReadRequestCoreModel request)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out ConversationReadRequestPod pod) || !reader.IsConsumed || pod.ReadThroughMessageId <= 0)
        {
            request = default;
            return false;
        }

        request = new ConversationReadRequestCoreModel(pod.ReadThroughMessageId);
        return true;
    }

    /// <summary>
    /// Writes an account reply together with its explicit read cursor.
    /// </summary>
    public static void WriteAccountConversationReplyRequest(AccountConversationReplyRequestCoreModel request, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(256);
        var mutable = new MutableAccountConversationReplyRequestPod
        {
            ReadThroughMessageId = request.ReadThroughMessageId,
            Body = PodUtf8Codec.AppendSlice(request.Body, payload)
        };
        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CastMessagePod<MutableAccountConversationReplyRequestPod, AccountConversationReplyRequestPod>(mutable));
        writer.WriteBytes(payload.WrittenSpan);
    }

    /// <summary>
    /// Encodes an account reply request into its AEDS payload.
    /// </summary>
    public static byte[] EncodeAccountConversationReplyRequest(AccountConversationReplyRequestCoreModel request)
        => EncodeToArray(256, writer => WriteAccountConversationReplyRequest(request, writer));

    /// <summary>
    /// Decodes and validates an account reply request payload.
    /// </summary>
    public static bool TryDecodeAccountConversationReplyRequest(ReadOnlyMemory<byte> source, out AccountConversationReplyRequestCoreModel request)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out AccountConversationReplyRequestPod pod) ||
            pod.ReadThroughMessageId <= 0 ||
            !reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            request = default;
            return false;
        }

        request = new AccountConversationReplyRequestCoreModel(
            pod.ReadThroughMessageId,
            PodProjector.ReadSlice(pod.Body, payload));
        return reader.IsConsumed;
    }

    /// <summary>
    /// Writes the <c>ConversationStatusRequest</c> contract to the supplied binary destination.
    /// </summary>
    public static void WriteConversationStatusRequest(ConversationStatusValue status, IBufferWriter<byte> destination)
    {
        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CastMessagePod<MutableConversationStatusRequestPod, ConversationStatusRequestPod>(
            new MutableConversationStatusRequestPod { Status = (int)status }));
    }

    /// <summary>
    /// Encodes the <c>ConversationStatusRequest</c> contract into a new binary payload.
    /// </summary>
    public static byte[] EncodeConversationStatusRequest(ConversationStatusValue status)
        => EncodeToArray(Marshal.SizeOf<ConversationStatusRequestPod>(), writer => WriteConversationStatusRequest(status, writer));

    /// <summary>
    /// Attempts to decode the <c>ConversationStatusRequest</c> contract from a binary payload.
    /// </summary>
    public static bool TryDecodeConversationStatusRequest(ReadOnlyMemory<byte> source, out ConversationStatusValue status)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out ConversationStatusRequestPod pod) || !reader.IsConsumed || pod.Status is < 0 or > 2)
        {
            status = ConversationStatusValue.Open;
            return false;
        }

        status = ToConversationStatus(pod.Status);
        return true;
    }

    /// <summary>
    /// Writes the <c>SystemMessageRequest</c> contract to the supplied binary destination.
    /// </summary>
    public static void WriteSystemMessageRequest(SystemMessageRequestCoreModel request, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(256);
        var mutable = new MutableSystemMessageRequestPod
        {
            TargetAccountId = request.TargetAccountId ?? 0,
            HasTargetAccountId = request.TargetAccountId.HasValue ? (byte)1 : (byte)0,
            Reserved0 = 0,
            Reserved1 = 0,
            Reserved2 = 0,
            Subject = PodUtf8Codec.AppendSlice(request.Subject, payload),
            Body = PodUtf8Codec.AppendSlice(request.Body, payload)
        };
        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CastMessagePod<MutableSystemMessageRequestPod, SystemMessageRequestPod>(mutable));
        writer.WriteBytes(payload.WrittenSpan);
    }

    /// <summary>
    /// Encodes the <c>SystemMessageRequest</c> contract into a new binary payload.
    /// </summary>
    public static byte[] EncodeSystemMessageRequest(SystemMessageRequestCoreModel request)
        => EncodeToArray(256, writer => WriteSystemMessageRequest(request, writer));

    /// <summary>
    /// Attempts to decode the <c>SystemMessageRequest</c> contract from a binary payload.
    /// </summary>
    public static bool TryDecodeSystemMessageRequest(ReadOnlyMemory<byte> source, out SystemMessageRequestCoreModel request)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out SystemMessageRequestPod pod) ||
            pod.HasTargetAccountId > 1 ||
            !reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            request = default;
            return false;
        }

        request = new SystemMessageRequestCoreModel(
            pod.HasTargetAccountId == 1 ? pod.TargetAccountId : null,
            PodProjector.ReadSlice(pod.Subject, payload),
            PodProjector.ReadSlice(pod.Body, payload));
        return reader.IsConsumed;
    }

    private static ConversationListItemPod CreateConversationListItemPod(
        ConversationListItemResponse item,
        ArrayBufferWriter<byte> payload)
    {
        var mutable = new MutableConversationListItemPod
        {
            ConversationId = ParseId(item.ConversationId),
            Status = (int)item.Status,
            UnreadCount = item.UnreadCount,
            LastMessageAtUnixMs = PodTimeCodec.ToUnixMs(item.LastMessageAt),
            UpdatedAtUnixMs = PodTimeCodec.ToUnixMs(item.UpdatedAt),
            IsSystemSource = item.IsSystemSource ? (byte)1 : (byte)0,
            CanReply = item.CanReply ? (byte)1 : (byte)0,
            HasLastMessage = item.LastMessage is null ? (byte)0 : (byte)1,
            Reserved0 = 0,
            Subject = PodUtf8Codec.AppendSlice(item.Subject, payload),
            LastMessage = item.LastMessage is null ? default : CreatePreviewPod(item.LastMessage, payload)
        };
        return CastMessagePod<MutableConversationListItemPod, ConversationListItemPod>(mutable);
    }

    private static bool IsValidConversationListItem(in ConversationListItemPod pod)
        => pod.IsSystemSource <= 1 &&
           pod.CanReply <= 1 &&
           pod.HasLastMessage <= 1 &&
           pod.LastMessage.HasSenderName <= 1;

    private static ConversationListItemResponse DecodeConversationListItem(
        in ConversationListItemPod pod,
        ReadOnlySpan<byte> payload)
        => new()
        {
            ConversationId = pod.ConversationId.ToString(),
            Subject = PodProjector.ReadSlice(pod.Subject, payload),
            Status = ToConversationStatus(pod.Status),
            IsSystemSource = pod.IsSystemSource == 1,
            CanReply = pod.CanReply == 1,
            UnreadCount = pod.UnreadCount,
            LastMessageAt = PodTimeCodec.FromUnixMs(pod.LastMessageAtUnixMs),
            UpdatedAt = PodTimeCodec.FromUnixMs(pod.UpdatedAtUnixMs),
            LastMessage = pod.HasLastMessage == 1 ? DecodePreview(pod.LastMessage, payload) : null
        };

    private static ConversationDetailV3Pod CreateConversationDetailV3Pod(
        ConversationDetailResponse detail,
        ArrayBufferWriter<byte> payload)
    {
        var mutable = new MutableConversationDetailV3Pod
        {
            ConversationId = ParseId(detail.ConversationId),
            Status = (int)detail.Status,
            UnreadCount = detail.UnreadCount,
            LastMessageAtUnixMs = PodTimeCodec.ToUnixMs(detail.LastMessageAt),
            ReadSnapshotMessageId = ParseId(detail.ReadSnapshotMessageId),
            PreviousCursorMessageId = string.IsNullOrWhiteSpace(detail.PreviousCursor) ? 0 : ParseId(detail.PreviousCursor),
            IsSystemSource = detail.IsSystemSource ? (byte)1 : (byte)0,
            CanReply = detail.CanReply ? (byte)1 : (byte)0,
            HasOlder = detail.HasOlder ? (byte)1 : (byte)0,
            Reserved0 = 0,
            Subject = PodUtf8Codec.AppendSlice(detail.Subject, payload)
        };
        return CastMessagePod<MutableConversationDetailV3Pod, ConversationDetailV3Pod>(mutable);
    }

    private static bool IsValidConversationDetailV3(in ConversationDetailV3Pod pod)
        => pod.ReadSnapshotMessageId > 0 &&
           pod.IsSystemSource <= 1 &&
           pod.CanReply <= 1 &&
           pod.HasOlder <= 1 &&
           (pod.HasOlder == 1) == (pod.PreviousCursorMessageId > 0);

    private static ConversationMessagePreviewPod CreatePreviewPod(ConversationMessagePreviewResponse preview, ArrayBufferWriter<byte> payload)
    {
        var mutable = new MutableConversationMessagePreviewPod
        {
            SenderType = (int)preview.SenderType,
            CreatedAtUnixMs = PodTimeCodec.ToUnixMs(preview.CreatedAt),
            HasSenderName = string.IsNullOrWhiteSpace(preview.SenderName) ? (byte)0 : (byte)1,
            Reserved0 = 0,
            Reserved1 = 0,
            SenderName = PodUtf8Codec.AppendSlice(preview.SenderName ?? string.Empty, payload),
            BodyPreview = PodUtf8Codec.AppendSlice(preview.BodyPreview, payload)
        };
        return CastMessagePod<MutableConversationMessagePreviewPod, ConversationMessagePreviewPod>(mutable);
    }

    private static ConversationMessagePreviewResponse DecodePreview(in ConversationMessagePreviewPod pod, ReadOnlySpan<byte> payload)
        => new()
        {
            SenderType = ToConversationSender(pod.SenderType),
            SenderName = pod.HasSenderName == 1 ? PodProjector.ReadSlice(pod.SenderName, payload) : null,
            BodyPreview = PodProjector.ReadSlice(pod.BodyPreview, payload),
            CreatedAt = PodTimeCodec.FromUnixMs(pod.CreatedAtUnixMs)
        };

    private static ConversationMessagePod CreateMessagePod(ConversationMessageResponse message, ArrayBufferWriter<byte> payload)
    {
        var mutable = new MutableConversationMessagePod
        {
            MessageId = ParseId(message.MessageId),
            ConversationId = ParseId(message.ConversationId),
            SenderType = (int)message.SenderType,
            CreatedAtUnixMs = PodTimeCodec.ToUnixMs(message.CreatedAt),
            HasSenderName = string.IsNullOrWhiteSpace(message.SenderName) ? (byte)0 : (byte)1,
            Reserved0 = 0,
            Reserved1 = 0,
            SenderName = PodUtf8Codec.AppendSlice(message.SenderName ?? string.Empty, payload),
            Body = PodUtf8Codec.AppendSlice(message.Body, payload)
        };
        return CastMessagePod<MutableConversationMessagePod, ConversationMessagePod>(mutable);
    }

    private static ConversationMessageResponse DecodeMessage(in ConversationMessagePod pod, ReadOnlySpan<byte> payload)
        => new()
        {
            MessageId = pod.MessageId.ToString(),
            ConversationId = pod.ConversationId.ToString(),
            SenderType = ToConversationSender(pod.SenderType),
            SenderName = pod.HasSenderName == 1 ? PodProjector.ReadSlice(pod.SenderName, payload) : null,
            Body = PodProjector.ReadSlice(pod.Body, payload),
            CreatedAt = PodTimeCodec.FromUnixMs(pod.CreatedAtUnixMs)
        };

    private static long ParseId(string? id)
        => long.TryParse(id, out long parsed) ? parsed : 0;

    private static ConversationStatusValue ToConversationStatus(int value)
        => value switch
        {
            1 => ConversationStatusValue.Pending,
            2 => ConversationStatusValue.Closed,
            _ => ConversationStatusValue.Open
        };

    private static ConversationSenderValue ToConversationSender(int value)
        => value switch
        {
            0 => ConversationSenderValue.Account,
            1 => ConversationSenderValue.Admin,
            _ => ConversationSenderValue.System
        };

    private static TTo CastMessagePod<TFrom, TTo>(TFrom source)
        where TFrom : unmanaged
        where TTo : unmanaged
    {
        Span<TFrom> from = stackalloc TFrom[1];
        from[0] = source;
        return MemoryMarshal.Read<TTo>(MemoryMarshal.AsBytes(from));
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableConversationMessagePreviewPod
    {
        public int SenderType;
        public long CreatedAtUnixMs;
        public byte HasSenderName;
        public byte Reserved0;
        public ushort Reserved1;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef SenderName;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef BodyPreview;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableConversationListItemPod
    {
        public long ConversationId;
        public int Status;
        public int UnreadCount;
        public long LastMessageAtUnixMs;
        public long UpdatedAtUnixMs;
        public byte IsSystemSource;
        public byte CanReply;
        public byte HasLastMessage;
        public byte Reserved0;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Subject;
        public ConversationMessagePreviewPod LastMessage;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableAdminConversationListItemPod
    {
        public ConversationListItemPod Conversation;
        public long CounterpartyAccountId;
        public int CounterpartyAccountStatus;
        public int Reserved0;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableConversationMessagePod
    {
        public long MessageId;
        public long ConversationId;
        public int SenderType;
        public long CreatedAtUnixMs;
        public byte HasSenderName;
        public byte Reserved0;
        public ushort Reserved1;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef SenderName;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Body;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableConversationDetailPod
    {
        public long ConversationId;
        public int Status;
        public int UnreadCount;
        public long LastMessageAtUnixMs;
        public byte IsSystemSource;
        public byte CanReply;
        public ushort Reserved0;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Subject;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableConversationDetailV2Pod
    {
        public long ConversationId;
        public int Status;
        public int UnreadCount;
        public long LastMessageAtUnixMs;
        public long ReadSnapshotMessageId;
        public byte IsSystemSource;
        public byte CanReply;
        public ushort Reserved0;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Subject;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableConversationDetailV3Pod
    {
        public long ConversationId;
        public int Status;
        public int UnreadCount;
        public long LastMessageAtUnixMs;
        public long ReadSnapshotMessageId;
        public long PreviousCursorMessageId;
        public byte IsSystemSource;
        public byte CanReply;
        public byte HasOlder;
        public byte Reserved0;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Subject;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableAdminConversationDetailPod
    {
        public ConversationDetailV3Pod Conversation;
        public long CounterpartyAccountId;
        public int CounterpartyAccountStatus;
        public int Reserved0;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableConversationReadRequestPod
    {
        public long ReadThroughMessageId;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableAccountConversationReplyRequestPod
    {
        public long ReadThroughMessageId;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Body;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableConversationCreateRequestPod
    {
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Subject;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Body;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableConversationStatusRequestPod
    {
        public int Status;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableSystemMessageRequestPod
    {
        public long TargetAccountId;
        public byte HasTargetAccountId;
        public byte Reserved0;
        public ushort Reserved1;
        public int Reserved2;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Subject;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Body;
    }
}
