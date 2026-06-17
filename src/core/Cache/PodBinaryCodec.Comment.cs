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

    public static void WriteCommentPolicySnapshot(CommentPolicySnapshotCoreModel snapshot, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(128);
        var mutable = new MutableCommentPolicySnapshotPod
        {
            AnonymousCommentsEnabled = snapshot.AnonymousCommentsEnabled ? (byte)1 : (byte)0,
            PublicCommentsEnabled = snapshot.PublicCommentsEnabled ? (byte)1 : (byte)0,
            ZkAnonymousEnabled = snapshot.ZkAnonymousEnabled ? (byte)1 : (byte)0,
            DefaultAuthorMode = EncodeCommentAuthorMode(snapshot.DefaultAuthorMode),
            SupportedDisplayLanguages = PodUtf8Codec.AppendSlice(JoinDisplayLanguages(snapshot.SupportedDisplayLanguages), payload)
        };

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CastUserPod<MutableCommentPolicySnapshotPod, CommentPolicySnapshotPod>(mutable));
        writer.WriteBytes(payload.WrittenSpan);
    }

    public static byte[] EncodeCommentPolicySnapshot(CommentPolicySnapshotCoreModel snapshot)
        => EncodeToArray(Marshal.SizeOf<CommentPolicySnapshotPod>() + 128, writer => WriteCommentPolicySnapshot(snapshot, writer));

    public static bool TryDecodeCommentPolicySnapshot(ReadOnlyMemory<byte> bytes, out CommentPolicySnapshotCoreModel snapshot)
    {
        var reader = new BinaryPodReader(bytes.Span);
        if (!reader.TryReadPod(out CommentPolicySnapshotPod pod) ||
            pod.AnonymousCommentsEnabled > 1 ||
            pod.PublicCommentsEnabled > 1 ||
            pod.ZkAnonymousEnabled > 1 ||
            !TryDecodeCommentAuthorMode(pod.DefaultAuthorMode, out string defaultAuthorMode) ||
            !reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            snapshot = default;
            return false;
        }

        snapshot = new CommentPolicySnapshotCoreModel(
            pod.AnonymousCommentsEnabled == 1,
            pod.PublicCommentsEnabled == 1,
            pod.ZkAnonymousEnabled == 1,
            defaultAuthorMode,
            SplitDisplayLanguages(PodProjector.ReadSlice(pod.SupportedDisplayLanguages, payload)));
        return reader.IsConsumed;
    }

    public static void WriteCommentPolicyUpdateRequest(CommentPolicyUpdateRequestCoreModel request, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(128);
        bool hasDefaultAuthorMode = !string.IsNullOrWhiteSpace(request.DefaultAuthorMode);
        var mutable = new MutableCommentPolicyUpdateRequestPod
        {
            HasAnonymousCommentsEnabled = request.AnonymousCommentsEnabled.HasValue ? (byte)1 : (byte)0,
            AnonymousCommentsEnabled = request.AnonymousCommentsEnabled == true ? (byte)1 : (byte)0,
            HasPublicCommentsEnabled = request.PublicCommentsEnabled.HasValue ? (byte)1 : (byte)0,
            PublicCommentsEnabled = request.PublicCommentsEnabled == true ? (byte)1 : (byte)0,
            HasZkAnonymousEnabled = request.ZkAnonymousEnabled.HasValue ? (byte)1 : (byte)0,
            ZkAnonymousEnabled = request.ZkAnonymousEnabled == true ? (byte)1 : (byte)0,
            HasDefaultAuthorMode = hasDefaultAuthorMode ? (byte)1 : (byte)0,
            DefaultAuthorMode = hasDefaultAuthorMode ? EncodeCommentAuthorMode(request.DefaultAuthorMode) : (byte)0,
            SupportedDisplayLanguages = PodUtf8Codec.AppendSlice(JoinDisplayLanguages(request.SupportedDisplayLanguages), payload)
        };

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CastUserPod<MutableCommentPolicyUpdateRequestPod, CommentPolicyUpdateRequestPod>(mutable));
        writer.WriteBytes(payload.WrittenSpan);
    }

    public static byte[] EncodeCommentPolicyUpdateRequest(CommentPolicyUpdateRequestCoreModel request)
        => EncodeToArray(Marshal.SizeOf<CommentPolicyUpdateRequestPod>() + 128, writer => WriteCommentPolicyUpdateRequest(request, writer));

    public static bool TryDecodeCommentPolicyUpdateRequest(ReadOnlyMemory<byte> bytes, out CommentPolicyUpdateRequestCoreModel request)
    {
        var reader = new BinaryPodReader(bytes.Span);
        if (!reader.TryReadPod(out CommentPolicyUpdateRequestPod pod) ||
            pod.HasAnonymousCommentsEnabled > 1 ||
            pod.AnonymousCommentsEnabled > 1 ||
            pod.HasPublicCommentsEnabled > 1 ||
            pod.PublicCommentsEnabled > 1 ||
            pod.HasZkAnonymousEnabled > 1 ||
            pod.ZkAnonymousEnabled > 1 ||
            pod.HasDefaultAuthorMode > 1 ||
            !TryDecodeCommentAuthorMode(pod.DefaultAuthorMode, out string defaultAuthorMode) ||
            !reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            request = default;
            return false;
        }

        IReadOnlyList<string>? languages = NullCommentFieldIfEmpty(PodProjector.ReadSlice(pod.SupportedDisplayLanguages, payload)) is { } languageText
            ? SplitDisplayLanguages(languageText)
            : null;
        request = new CommentPolicyUpdateRequestCoreModel(
            pod.HasAnonymousCommentsEnabled == 1 ? pod.AnonymousCommentsEnabled == 1 : null,
            pod.HasPublicCommentsEnabled == 1 ? pod.PublicCommentsEnabled == 1 : null,
            pod.HasZkAnonymousEnabled == 1 ? pod.ZkAnonymousEnabled == 1 : null,
            pod.HasDefaultAuthorMode == 1 ? defaultAuthorMode : null,
            languages);
        return reader.IsConsumed;
    }

    public static void WriteCommentCreateV2Request(CommentCreateV2RequestCoreModel request, IBufferWriter<byte> destination)
    {
        CommentCreateV2RequestPod pod = CreateCommentCreateV2RequestPod(request, out ReadOnlyMemory<byte> payload);
        var writer = new BinaryPodWriter(destination);
        writer.WritePod(pod);
        writer.WriteBytes(payload.Span);
    }

    public static byte[] EncodeCommentCreateV2Request(CommentCreateV2RequestCoreModel request)
        => EncodeToArray(640 + (request.Content?.Length ?? 0) + (request.ZkProof?.Length ?? 0), writer => WriteCommentCreateV2Request(request, writer));

    public static bool TryDecodeCommentCreateV2Request(ReadOnlyMemory<byte> bytes, out CommentCreateV2RequestCoreModel request)
    {
        var reader = new BinaryPodReader(bytes.Span);
        if (!reader.TryReadPod(out CommentCreateV2RequestPod pod) ||
            pod.HasParentId > 1 ||
            pod.HasRootId > 1 ||
            pod.HasReplyToCommentId > 1 ||
            pod.HasReplyToUserId > 1 ||
            pod.PublicSendExplicitlySelected > 1 ||
            !TryDecodeCommentAuthorMode(pod.AuthorMode, out string authorMode) ||
            !reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            request = default;
            return false;
        }

        request = new CommentCreateV2RequestCoreModel(
            pod.ArticleId,
            PodProjector.ReadSlice(pod.Content, payload),
            pod.HasParentId == 1 ? pod.ParentId.ToString() : null,
            pod.HasRootId == 1 ? pod.RootId.ToString() : null,
            pod.HasReplyToCommentId == 1 ? pod.ReplyToCommentId.ToString() : null,
            pod.HasReplyToUserId == 1 ? pod.ReplyToUserId : null,
            authorMode,
            pod.PublicSendExplicitlySelected == 1,
            NullCommentFieldIfEmpty(PodProjector.ReadSlice(pod.AnonymousScope, payload)),
            NullCommentFieldIfEmpty(PodProjector.ReadSlice(pod.DisplayLanguage, payload)),
            NullCommentFieldIfEmpty(PodProjector.ReadSlice(pod.ProofToken, payload)),
            ReadBytes(pod.ZkProof, payload));
        return reader.IsConsumed;
    }

    public static void WriteCommentAuthorView(CommentAuthorViewCoreModel author, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(128);
        var mutable = new MutableCommentAuthorViewPod
        {
            Mode = EncodeCommentAuthorMode(author.Mode),
            CredentialLevel = EncodeCommentCredentialLevel(author.CredentialLevel),
            Reserved0 = 0,
            DisplayName = PodUtf8Codec.AppendSlice(author.DisplayName, payload),
            DisplayLanguage = PodUtf8Codec.AppendSlice(author.DisplayLanguage, payload),
            Badge = PodUtf8Codec.AppendSlice(author.Badge ?? string.Empty, payload),
            ScopeLabel = PodUtf8Codec.AppendSlice(author.ScopeLabel ?? string.Empty, payload)
        };

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CastUserPod<MutableCommentAuthorViewPod, CommentAuthorViewPod>(mutable));
        writer.WriteBytes(payload.WrittenSpan);
    }

    public static byte[] EncodeCommentAuthorView(CommentAuthorViewCoreModel author)
        => EncodeToArray(Marshal.SizeOf<CommentAuthorViewPod>() + 128, writer => WriteCommentAuthorView(author, writer));

    public static bool TryDecodeCommentAuthorView(ReadOnlyMemory<byte> bytes, out CommentAuthorViewCoreModel author)
    {
        var reader = new BinaryPodReader(bytes.Span);
        if (!reader.TryReadPod(out CommentAuthorViewPod pod) ||
            !TryDecodeCommentAuthorMode(pod.Mode, out string mode) ||
            !TryDecodeCommentCredentialLevel(pod.CredentialLevel, out string? credentialLevel) ||
            !reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            author = default;
            return false;
        }

        author = new CommentAuthorViewCoreModel(
            mode,
            PodProjector.ReadSlice(pod.DisplayName, payload),
            PodProjector.ReadSlice(pod.DisplayLanguage, payload),
            NullCommentFieldIfEmpty(PodProjector.ReadSlice(pod.Badge, payload)),
            NullCommentFieldIfEmpty(PodProjector.ReadSlice(pod.ScopeLabel, payload)),
            credentialLevel);
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
                item.ModerationStatus,
                item.ModerationStatusLabel,
                item.VisibilityState,
                item.VisibilityReasonCode,
                item.IsPubliclyVisible,
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
            string visibilityState = PodUtf8Codec.FromFixed32(pod.VisibilityState);
            string visibilityReasonCode = PodUtf8Codec.FromFixed64(pod.VisibilityReasonCode);
            string moderationStatusLabel = PodUtf8Codec.FromFixed64(pod.ModerationStatusLabel);
            data.Add(new UserCommentCoreModel(
                pod,
                pod.Id,
                content,
                createTime,
                pod.ArticleId,
                articleTitle,
                pod.RootId == 0 ? null : pod.RootId,
                replyToUserName,
                pod.ModerationStatus,
                moderationStatusLabel,
                visibilityState,
                visibilityReasonCode,
                pod.IsPubliclyVisible == 1));
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

    private static CommentCreateV2RequestPod CreateCommentCreateV2RequestPod(
        CommentCreateV2RequestCoreModel request,
        out ReadOnlyMemory<byte> payload)
    {
        var bytes = new ArrayBufferWriter<byte>(512);
        bool hasParentId = TryParsePositive(request.ParentId, out long parentId);
        bool hasRootId = TryParsePositive(request.RootId, out long rootId);
        bool hasReplyToCommentId = TryParsePositive(request.ReplyToCommentId, out long replyToCommentId);
        ReadOnlySpan<byte> zkProof = request.ZkProof ?? Array.Empty<byte>();
        var mutable = new MutableCommentCreateV2RequestPod
        {
            ArticleId = request.ArticleId,
            ReplyToUserId = request.ReplyToUserId ?? 0,
            HasParentId = hasParentId ? (byte)1 : (byte)0,
            HasRootId = hasRootId ? (byte)1 : (byte)0,
            HasReplyToCommentId = hasReplyToCommentId ? (byte)1 : (byte)0,
            HasReplyToUserId = request.ReplyToUserId.HasValue ? (byte)1 : (byte)0,
            AuthorMode = EncodeCommentAuthorMode(request.AuthorMode),
            PublicSendExplicitlySelected = request.PublicSendExplicitlySelected ? (byte)1 : (byte)0,
            Reserved0 = 0,
            ParentId = parentId,
            RootId = rootId,
            ReplyToCommentId = replyToCommentId,
            AnonymousScope = PodUtf8Codec.AppendSlice(request.AnonymousScope ?? string.Empty, bytes),
            DisplayLanguage = PodUtf8Codec.AppendSlice(request.DisplayLanguage ?? string.Empty, bytes),
            ProofToken = PodUtf8Codec.AppendSlice(request.ProofToken ?? string.Empty, bytes),
            ZkProof = AppendBytes(zkProof, bytes),
            Content = PodUtf8Codec.AppendSlice(request.Content ?? string.Empty, bytes)
        };

        payload = bytes.WrittenMemory;
        return MemoryMarshal.Read<CommentCreateV2RequestPod>(MemoryMarshal.AsBytes(new MutableCommentCreateV2RequestPod[] { mutable }));
    }

    private static bool TryParsePositive(string? value, out long parsed)
        => long.TryParse(value, out parsed) && parsed > 0;

    private static byte EncodeCommentAuthorMode(string? mode)
        => NormalizeCommentToken(mode) switch
        {
            "pseudonymous" => 2,
            "public" => 3,
            "zk_anonymous" => 4,
            _ => 1
        };

    private static bool TryDecodeCommentAuthorMode(byte raw, out string mode)
    {
        mode = raw switch
        {
            0 or 1 => "anonymous",
            2 => "pseudonymous",
            3 => "public",
            4 => "zk_anonymous",
            _ => string.Empty
        };
        return mode.Length > 0;
    }

    private static byte EncodeCommentCredentialLevel(string? level)
        => NormalizeCommentToken(level) switch
        {
            "basic" => 1,
            "trusted" => 2,
            "strong_anonymous" => 3,
            _ => 0
        };

    private static bool TryDecodeCommentCredentialLevel(byte raw, out string? level)
    {
        level = raw switch
        {
            0 => null,
            1 => "basic",
            2 => "trusted",
            3 => "strong_anonymous",
            _ => string.Empty
        };
        return level is null || level.Length > 0;
    }

    private static string NormalizeCommentToken(string? value)
        => (value ?? string.Empty).Trim().ToLowerInvariant().Replace('-', '_');

    private static string JoinDisplayLanguages(IReadOnlyList<string>? languages)
        => languages is null ? string.Empty : string.Join('\n', languages);

    private static IReadOnlyList<string> SplitDisplayLanguages(string languages)
        => languages
            .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .ToArray();

    private static string? NullCommentFieldIfEmpty(string value)
        => value.Length == 0 ? null : value;

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

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableCommentPolicySnapshotPod
    {
        public byte AnonymousCommentsEnabled;
        public byte PublicCommentsEnabled;
        public byte ZkAnonymousEnabled;
        public byte DefaultAuthorMode;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef SupportedDisplayLanguages;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableCommentPolicyUpdateRequestPod
    {
        public byte HasAnonymousCommentsEnabled;
        public byte AnonymousCommentsEnabled;
        public byte HasPublicCommentsEnabled;
        public byte PublicCommentsEnabled;
        public byte HasZkAnonymousEnabled;
        public byte ZkAnonymousEnabled;
        public byte HasDefaultAuthorMode;
        public byte DefaultAuthorMode;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef SupportedDisplayLanguages;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableCommentCreateV2RequestPod
    {
        public int ArticleId;
        public int ReplyToUserId;
        public byte HasParentId;
        public byte HasRootId;
        public byte HasReplyToCommentId;
        public byte HasReplyToUserId;
        public byte AuthorMode;
        public byte PublicSendExplicitlySelected;
        public ushort Reserved0;
        public long ParentId;
        public long RootId;
        public long ReplyToCommentId;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef AnonymousScope;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef DisplayLanguage;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef ProofToken;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef ZkProof;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Content;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableCommentAuthorViewPod
    {
        public byte Mode;
        public byte CredentialLevel;
        public ushort Reserved0;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef DisplayName;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef DisplayLanguage;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Badge;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef ScopeLabel;
    }
}
