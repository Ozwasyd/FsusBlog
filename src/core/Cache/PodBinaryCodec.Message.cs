using System.Buffers;
using System.Runtime.InteropServices;
using FsusBlog.Core.Mapping.Codecs;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Mapping.Projectors;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Core.Cache;

public static partial class PodBinaryCodec
{
    public static void WriteConversationList(PageResponse<ConversationListItemResponse> page, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(1024);
        var writer = new BinaryPodWriter(destination);
        writer.WriteInt32(page.Total);
        writer.WriteInt32(page.Items.Count);

        foreach (ConversationListItemResponse item in page.Items)
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

            writer.WritePod(CastMessagePod<MutableConversationListItemPod, ConversationListItemPod>(mutable));
        }

        writer.WriteBytes(payload.WrittenSpan);
    }

    public static byte[] EncodeConversationList(PageResponse<ConversationListItemResponse> page)
        => EncodeToArray(1024 + page.Items.Count * Marshal.SizeOf<ConversationListItemPod>(), writer => WriteConversationList(page, writer));

    public static bool TryDecodeConversationList(ReadOnlyMemory<byte> source, out PageResponse<ConversationListItemResponse> page)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadInt32(out int total) || !reader.TryReadInt32(out int count) || total < 0 || count < 0)
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

        page = new PageResponse<ConversationListItemResponse> { Total = total, Items = items };
        return reader.IsConsumed;
    }

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

    public static byte[] EncodeConversationDetail(ConversationDetailResponse detail)
        => EncodeToArray(1024 + detail.Messages.Count * Marshal.SizeOf<ConversationMessagePod>(), writer => WriteConversationDetail(detail, writer));

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

    public static void WriteConversationMessage(ConversationMessageResponse message, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(512);
        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CreateMessagePod(message, payload));
        writer.WriteBytes(payload.WrittenSpan);
    }

    public static byte[] EncodeConversationMessage(ConversationMessageResponse message)
        => EncodeToArray(512, writer => WriteConversationMessage(message, writer));

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

    public static byte[] EncodeConversationCreateRequest(ConversationCreateRequestCoreModel request)
        => EncodeToArray(256, writer => WriteConversationCreateRequest(request, writer));

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

    public static void WriteConversationStatusRequest(ConversationStatusValue status, IBufferWriter<byte> destination)
    {
        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CastMessagePod<MutableConversationStatusRequestPod, ConversationStatusRequestPod>(
            new MutableConversationStatusRequestPod { Status = (int)status }));
    }

    public static byte[] EncodeConversationStatusRequest(ConversationStatusValue status)
        => EncodeToArray(Marshal.SizeOf<ConversationStatusRequestPod>(), writer => WriteConversationStatusRequest(status, writer));

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

    public static void WriteSystemMessageRequest(SystemMessageRequestCoreModel request, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(256);
        var mutable = new MutableSystemMessageRequestPod
        {
            TargetUserId = request.TargetUserId ?? 0,
            HasTargetUserId = request.TargetUserId.HasValue ? (byte)1 : (byte)0,
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

    public static byte[] EncodeSystemMessageRequest(SystemMessageRequestCoreModel request)
        => EncodeToArray(256, writer => WriteSystemMessageRequest(request, writer));

    public static bool TryDecodeSystemMessageRequest(ReadOnlyMemory<byte> source, out SystemMessageRequestCoreModel request)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out SystemMessageRequestPod pod) ||
            pod.HasTargetUserId > 1 ||
            !reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            request = default;
            return false;
        }

        request = new SystemMessageRequestCoreModel(
            pod.HasTargetUserId == 1 ? pod.TargetUserId : null,
            PodProjector.ReadSlice(pod.Subject, payload),
            PodProjector.ReadSlice(pod.Body, payload));
        return reader.IsConsumed;
    }

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
            0 => ConversationSenderValue.User,
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
        public long TargetUserId;
        public byte HasTargetUserId;
        public byte Reserved0;
        public ushort Reserved1;
        public int Reserved2;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Subject;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Body;
    }
}
