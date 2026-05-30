using FsusBlog.Core.Mapping.Codecs;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Mapping.Projectors;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Outputs;
using System.Buffers;
using System.Runtime.InteropServices;

namespace FsusBlog.Core.Cache;

public static partial class PodBinaryCodec
{
    public static void WriteCommentCreateRequest(CommentCreateRequestCoreModel request, IBufferWriter<byte> destination)
    {
        CommentCreateRequestPod pod = CreateCommentCreateRequestPod(request, out ReadOnlyMemory<byte> payload);
        var writer = new BinaryPodWriter(destination);
        writer.WritePod(pod);
        writer.WriteBytes(payload.Span);
    }

    public static byte[] EncodeCommentCreateRequest(CommentCreateRequestCoreModel request)
        => EncodeToArray(512 + request.Content.Length, writer => WriteCommentCreateRequest(request, writer));

    public static bool TryDecodeCommentCreateRequest(ReadOnlyMemory<byte> bytes, out CommentCreateRequestCoreModel request)
    {
        var reader = new BinaryPodReader(bytes.Span);
        if (!reader.TryReadPod(out CommentCreateRequestPod pod) || !reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            request = default;
            return false;
        }

        if (pod.HasParentId > 1 || pod.HasRootId > 1 || pod.HasReplyToCommentId > 1 || pod.HasReplyToUserId > 1)
        {
            request = default;
            return false;
        }

        request = new CommentCreateRequestCoreModel(
            pod.ArticleId,
            PodProjector.ReadSlice(pod.Content, payload),
            pod.HasParentId == 1 ? pod.ParentId.ToString() : null,
            pod.HasRootId == 1 ? pod.RootId.ToString() : null,
            pod.HasReplyToCommentId == 1 ? pod.ReplyToCommentId.ToString() : null,
            pod.HasReplyToUserId == 1 ? pod.ReplyToUserId : null);
        return reader.IsConsumed;
    }

    public static void WriteCommentCursor(CoreCursorResult<CommentQueryCoreModel> cursor, IBufferWriter<byte> destination)
    {
        var writer = new BinaryPodWriter(destination);
        writer.WriteInt64(cursor.NextCursor ?? 0);
        writer.WriteByte(cursor.HasMore ? (byte)1 : (byte)0);
        writer.WriteInt32(cursor.Data.Count);

        foreach (CommentQueryCoreModel item in cursor.Data)
        {
            writer.WritePod(item.Pod);
            _ = PodProjector.ProjectCommentItem(item.Id, item.CreateTime, item.UserName, item.Content, out ReadOnlyMemory<byte> payload);
            writer.WriteBytes(payload.Span);
        }
    }

    public static byte[] EncodeCommentCursor(CoreCursorResult<CommentQueryCoreModel> cursor)
        => EncodeToArray(512 + cursor.Data.Count * 256, writer => WriteCommentCursor(cursor, writer));

    public static bool TryDecodeCommentCursor(ReadOnlyMemory<byte> bytes, out CoreCursorResult<CommentQueryCoreModel> cursor)
    {
        var reader = new BinaryPodReader(bytes.Span);
        if (!reader.TryReadInt64(out long nextCursor) || !reader.TryReadByte(out byte hasMore) || !reader.TryReadInt32(out int count) || count < 0)
        {
            cursor = default;
            return false;
        }

        var data = new List<CommentQueryCoreModel>(count);
        for (int i = 0; i < count; i++)
        {
            if (!reader.TryReadPod(out CommentItemPod pod) || !reader.TryReadBytes(out ReadOnlySpan<byte> payloadSpan))
            {
                cursor = default;
                return false;
            }

            string userName = PodUtf8Codec.FromFixed64(pod.UserName);
            string content = PodProjector.ReadSlice(pod.Content, payloadSpan);
            DateTime createTime = PodTimeCodec.FromUnixMs(pod.CreateTimeUnixMs);
            data.Add(new CommentQueryCoreModel(pod, pod.Id, content, createTime, userName));
        }

        cursor = new CoreCursorResult<CommentQueryCoreModel>(data, nextCursor == 0 ? null : nextCursor, hasMore == 1);
        return reader.IsConsumed;
    }

    public static void WriteUserCommentCursor(CoreCursorResult<UserCommentCoreModel> cursor, IBufferWriter<byte> destination)
    {
        var writer = new BinaryPodWriter(destination);
        writer.WriteInt64(cursor.NextCursor ?? 0);
        writer.WriteByte(cursor.HasMore ? (byte)1 : (byte)0);
        writer.WriteInt32(cursor.Data.Count);

        foreach (UserCommentCoreModel item in cursor.Data)
        {
            writer.WritePod(item.Pod);
            _ = PodProjector.ProjectUserComment(
                item.Id,
                item.ArticleId,
                item.CreateTime,
                item.Content,
                item.ArticleTitle,
                item.RootId,
                item.ReplyToUserName,
                out ReadOnlyMemory<byte> payload);
            writer.WriteBytes(payload.Span);
        }
    }

    public static byte[] EncodeUserCommentCursor(CoreCursorResult<UserCommentCoreModel> cursor)
        => EncodeToArray(512 + cursor.Data.Count * 384, writer => WriteUserCommentCursor(cursor, writer));

    public static bool TryDecodeUserCommentCursor(ReadOnlyMemory<byte> bytes, out CoreCursorResult<UserCommentCoreModel> cursor)
    {
        var reader = new BinaryPodReader(bytes.Span);
        if (!reader.TryReadInt64(out long nextCursor) || !reader.TryReadByte(out byte hasMore) || !reader.TryReadInt32(out int count) || count < 0)
        {
            cursor = default;
            return false;
        }

        var data = new List<UserCommentCoreModel>(count);
        for (int i = 0; i < count; i++)
        {
            if (!reader.TryReadPod(out UserCommentPod pod) || !reader.TryReadBytes(out ReadOnlySpan<byte> payloadSpan))
            {
                cursor = default;
                return false;
            }

            string content = PodProjector.ReadSlice(pod.Content, payloadSpan);
            string articleTitle = PodUtf8Codec.FromFixed256(pod.ArticleTitle);
            DateTime createTime = PodTimeCodec.FromUnixMs(pod.CreateTimeUnixMs);
            string? replyToUserName = NormalizeNullableFixed(PodUtf8Codec.FromFixed64(pod.ReplyToUserName));
            data.Add(new UserCommentCoreModel(
                pod,
                pod.Id,
                content,
                createTime,
                pod.ArticleId,
                articleTitle,
                pod.RootId == 0 ? null : pod.RootId,
                replyToUserName));
        }

        cursor = new CoreCursorResult<UserCommentCoreModel>(data, nextCursor == 0 ? null : nextCursor, hasMore == 1);
        return reader.IsConsumed;
    }

    private static string? NormalizeNullableFixed(string value)
    {
        string trimmed = value.Trim();
        return trimmed.Length == 0 ? null : trimmed;
    }

    public static void WriteCommentThreadCursor(CursorResponse<CommentThreadItemDto> cursor, IBufferWriter<byte> destination)
    {
        var writer = new BinaryPodWriter(destination);
        writer.WriteInt64(ParseCursor(cursor.NextCursor));
        writer.WriteByte(cursor.HasMore ? (byte)1 : (byte)0);
        writer.WriteInt32(cursor.Data.Count);

        foreach (CommentThreadItemDto item in cursor.Data)
        {
            writer.WritePod(PodProjector.ProjectCommentThreadItem(
                ParseLong(item.Id),
                ParseLong(item.RootId),
                item.IsDeleted,
                item.CreateTime,
                item.UserName,
                item.Content,
                item.ReplyCount,
                item.HasMoreReplies,
                item.RepliesPreview.Count,
                out ReadOnlyMemory<byte> payload));
            writer.WriteBytes(payload.Span);

            foreach (CommentReplyPreviewItemDto reply in item.RepliesPreview)
            {
                writer.WritePod(PodProjector.ProjectCommentReplyPreviewItem(
                    ParseLong(reply.Id),
                    reply.IsDeleted,
                    reply.CreateTime,
                    reply.UserName,
                    reply.ReplyToUserName,
                    reply.Content,
                out ReadOnlyMemory<byte> replyPayload));
                writer.WriteBytes(replyPayload.Span);
            }
        }
    }

    public static byte[] EncodeCommentThreadCursor(CursorResponse<CommentThreadItemDto> cursor)
        => EncodeToArray(1024 + cursor.Data.Count * 512, writer => WriteCommentThreadCursor(cursor, writer));

    public static void WriteCommentReplyCursor(long rootId, CursorResponse<CommentReplyItemDto> cursor, IBufferWriter<byte> destination)
    {
        var writer = new BinaryPodWriter(destination);
        writer.WriteInt64(rootId);
        writer.WriteInt64(ParseCursor(cursor.NextCursor));
        writer.WriteByte(cursor.HasMore ? (byte)1 : (byte)0);
        writer.WriteInt32(cursor.Data.Count);

        foreach (CommentReplyItemDto reply in cursor.Data)
        {
            writer.WritePod(PodProjector.ProjectCommentReplyItem(
                ParseLong(reply.Id),
                ParseNullableLong(reply.ParentId),
                ParseLong(reply.RootId),
                reply.ReplyToUserId,
                ParseNullableLong(reply.ReplyToCommentId),
                reply.Depth,
                reply.IsDeleted,
                reply.CreateTime,
                reply.UserName,
                reply.ReplyToUserName,
                reply.Content,
                out ReadOnlyMemory<byte> payload));
            writer.WriteBytes(payload.Span);
        }
    }

    public static byte[] EncodeCommentReplyCursor(long rootId, CursorResponse<CommentReplyItemDto> cursor)
        => EncodeToArray(512 + cursor.Data.Count * 320, writer => WriteCommentReplyCursor(rootId, cursor, writer));

    private static long ParseLong(string value) => long.TryParse(value, out long parsed) ? parsed : 0;

    private static long? ParseNullableLong(string? value) => long.TryParse(value, out long parsed) ? parsed : null;

    private static long ParseCursor(string? value) => long.TryParse(value, out long cursor) ? cursor : 0;

    private static CommentCreateRequestPod CreateCommentCreateRequestPod(
        CommentCreateRequestCoreModel request,
        out ReadOnlyMemory<byte> payload)
    {
        var bytes = new ArrayBufferWriter<byte>(512);
        bool hasParentId = TryParsePositive(request.ParentId, out long parentId);
        bool hasRootId = TryParsePositive(request.RootId, out long rootId);
        bool hasReplyToCommentId = TryParsePositive(request.ReplyToCommentId, out long replyToCommentId);
        var mutable = new MutableCommentCreateRequestPod
        {
            ArticleId = request.ArticleId,
            ReplyToUserId = request.ReplyToUserId ?? 0,
            HasParentId = hasParentId ? (byte)1 : (byte)0,
            HasRootId = hasRootId ? (byte)1 : (byte)0,
            HasReplyToCommentId = hasReplyToCommentId ? (byte)1 : (byte)0,
            HasReplyToUserId = request.ReplyToUserId.HasValue ? (byte)1 : (byte)0,
            ParentId = parentId,
            RootId = rootId,
            ReplyToCommentId = replyToCommentId,
            Content = PodUtf8Codec.AppendSlice(request.Content, bytes)
        };

        payload = bytes.WrittenMemory;
        return MemoryMarshal.Read<CommentCreateRequestPod>(MemoryMarshal.AsBytes(new MutableCommentCreateRequestPod[] { mutable }));
    }

    private static bool TryParsePositive(string? value, out long parsed)
        => long.TryParse(value, out parsed) && parsed > 0;

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableCommentCreateRequestPod
    {
        public int ArticleId;
        public int ReplyToUserId;
        public byte HasParentId;
        public byte HasRootId;
        public byte HasReplyToCommentId;
        public byte HasReplyToUserId;
        public long ParentId;
        public long RootId;
        public long ReplyToCommentId;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Content;
    }
}
