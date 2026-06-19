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
    private const int AnonymousPrivacyMaxPayloadBytes = 16 * 1024;

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

    public static void WriteAnonymousCredentialIssueRequest(AnonymousCredentialIssueRequestCoreModel request, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(512 + (request.BlindedRequest?.Length ?? 0));
        var mutable = new MutableAnonymousCredentialIssueRequestPod
        {
            CredentialEpoch = request.CredentialEpoch,
            CircuitNumericId = request.CircuitNumericId,
            PublicInputLayoutVersion = request.PublicInputLayoutVersion,
            Reserved0 = 0,
            CircuitId = PodUtf8Codec.AppendSlice(request.CircuitId, payload),
            CredentialLevel = PodUtf8Codec.AppendSlice(request.CredentialLevel, payload),
            BlindedRequest = AppendBytes(request.BlindedRequest ?? [], payload),
            ClientNonce = AppendBytes(request.ClientNonce ?? [], payload)
        };

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CastUserPod<MutableAnonymousCredentialIssueRequestPod, AnonymousCredentialIssueRequestPod>(mutable));
        writer.WriteBytes(payload.WrittenSpan);
    }

    public static byte[] EncodeAnonymousCredentialIssueRequest(AnonymousCredentialIssueRequestCoreModel request)
        => EncodeToArray(Marshal.SizeOf<AnonymousCredentialIssueRequestPod>() + 512 + (request.BlindedRequest?.Length ?? 0), writer => WriteAnonymousCredentialIssueRequest(request, writer));

    public static bool TryDecodeAnonymousCredentialIssueRequest(ReadOnlyMemory<byte> bytes, out AnonymousCredentialIssueRequestCoreModel request)
    {
        var reader = new BinaryPodReader(bytes.Span);
        if (!reader.TryReadPod(out AnonymousCredentialIssueRequestPod pod) ||
            !reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            request = default;
            return false;
        }

        ReadOnlySpan<FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef> slices = stackalloc[]
        {
            pod.CircuitId,
            pod.CredentialLevel,
            pod.BlindedRequest,
            pod.ClientNonce
        };
        if (!ValidateAnonymousPayload(payload, slices))
        {
            request = default;
            return false;
        }

        request = new AnonymousCredentialIssueRequestCoreModel(
            pod.CredentialEpoch,
            pod.CircuitNumericId,
            pod.PublicInputLayoutVersion,
            PodProjector.ReadSlice(pod.CircuitId, payload),
            PodProjector.ReadSlice(pod.CredentialLevel, payload),
            ReadBytes(pod.BlindedRequest, payload),
            ReadBytes(pod.ClientNonce, payload));
        return reader.IsConsumed;
    }

    public static void WriteAnonymousCredentialIssueResponse(AnonymousCredentialIssueResponseCoreModel response, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(512 + (response.IssuerResponse?.Length ?? 0));
        var mutable = new MutableAnonymousCredentialIssueResponsePod
        {
            CredentialEpoch = response.CredentialEpoch,
            RootExpiresAtUnixMs = response.RootExpiresAtUnixMs,
            CircuitNumericId = response.CircuitNumericId,
            PublicInputLayoutVersion = response.PublicInputLayoutVersion,
            Reserved0 = 0,
            CircuitId = PodUtf8Codec.AppendSlice(response.CircuitId, payload),
            CredentialLevel = PodUtf8Codec.AppendSlice(response.CredentialLevel, payload),
            IssuerResponse = AppendBytes(response.IssuerResponse ?? [], payload),
            CredentialCommitment = AppendBytes(response.CredentialCommitment ?? [], payload)
        };

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CastUserPod<MutableAnonymousCredentialIssueResponsePod, AnonymousCredentialIssueResponsePod>(mutable));
        writer.WriteBytes(payload.WrittenSpan);
    }

    public static byte[] EncodeAnonymousCredentialIssueResponse(AnonymousCredentialIssueResponseCoreModel response)
        => EncodeToArray(Marshal.SizeOf<AnonymousCredentialIssueResponsePod>() + 512 + (response.IssuerResponse?.Length ?? 0), writer => WriteAnonymousCredentialIssueResponse(response, writer));

    public static bool TryDecodeAnonymousCredentialIssueResponse(ReadOnlyMemory<byte> bytes, out AnonymousCredentialIssueResponseCoreModel response)
    {
        var reader = new BinaryPodReader(bytes.Span);
        if (!reader.TryReadPod(out AnonymousCredentialIssueResponsePod pod) ||
            !reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            response = default;
            return false;
        }

        ReadOnlySpan<FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef> slices = stackalloc[]
        {
            pod.CircuitId,
            pod.CredentialLevel,
            pod.IssuerResponse,
            pod.CredentialCommitment
        };
        if (!ValidateAnonymousPayload(payload, slices))
        {
            response = default;
            return false;
        }

        response = new AnonymousCredentialIssueResponseCoreModel(
            pod.CredentialEpoch,
            pod.RootExpiresAtUnixMs,
            pod.CircuitNumericId,
            pod.PublicInputLayoutVersion,
            PodProjector.ReadSlice(pod.CircuitId, payload),
            PodProjector.ReadSlice(pod.CredentialLevel, payload),
            ReadBytes(pod.IssuerResponse, payload),
            ReadBytes(pod.CredentialCommitment, payload));
        return reader.IsConsumed;
    }

    public static void WriteAnonymousCredentialRootSnapshot(AnonymousCredentialRootSnapshotCoreModel snapshot, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(1024 + (snapshot.CircuitMetadata?.Length ?? 0));
        var mutable = new MutableAnonymousCredentialRootSnapshotPod
        {
            CredentialEpoch = snapshot.CredentialEpoch,
            RootExpiresAtUnixMs = snapshot.RootExpiresAtUnixMs,
            RootGraceExpiresAtUnixMs = snapshot.RootGraceExpiresAtUnixMs,
            CircuitNumericId = snapshot.CircuitNumericId,
            PublicInputLayoutVersion = snapshot.PublicInputLayoutVersion,
            ZkAnonymousEnabled = snapshot.ZkAnonymousEnabled ? (byte)1 : (byte)0,
            VerifierConfigured = snapshot.VerifierConfigured ? (byte)1 : (byte)0,
            CircuitId = PodUtf8Codec.AppendSlice(snapshot.CircuitId, payload),
            VerifyingKeyHash = PodUtf8Codec.AppendSlice(snapshot.VerifyingKeyHash, payload),
            CredentialRoot = AppendBytes(snapshot.CredentialRoot ?? [], payload),
            RevocationRoot = AppendBytes(snapshot.RevocationRoot ?? [], payload),
            CircuitMetadata = AppendBytes(snapshot.CircuitMetadata ?? [], payload)
        };

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CastUserPod<MutableAnonymousCredentialRootSnapshotPod, AnonymousCredentialRootSnapshotPod>(mutable));
        writer.WriteBytes(payload.WrittenSpan);
    }

    public static byte[] EncodeAnonymousCredentialRootSnapshot(AnonymousCredentialRootSnapshotCoreModel snapshot)
        => EncodeToArray(Marshal.SizeOf<AnonymousCredentialRootSnapshotPod>() + 1024 + (snapshot.CircuitMetadata?.Length ?? 0), writer => WriteAnonymousCredentialRootSnapshot(snapshot, writer));

    public static bool TryDecodeAnonymousCredentialRootSnapshot(ReadOnlyMemory<byte> bytes, out AnonymousCredentialRootSnapshotCoreModel snapshot)
    {
        var reader = new BinaryPodReader(bytes.Span);
        if (!reader.TryReadPod(out AnonymousCredentialRootSnapshotPod pod) ||
            pod.ZkAnonymousEnabled > 1 ||
            pod.VerifierConfigured > 1 ||
            !reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            snapshot = default;
            return false;
        }

        ReadOnlySpan<FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef> slices = stackalloc[]
        {
            pod.CircuitId,
            pod.VerifyingKeyHash,
            pod.CredentialRoot,
            pod.RevocationRoot,
            pod.CircuitMetadata
        };
        if (!ValidateAnonymousPayload(payload, slices))
        {
            snapshot = default;
            return false;
        }

        snapshot = new AnonymousCredentialRootSnapshotCoreModel(
            pod.CredentialEpoch,
            pod.RootExpiresAtUnixMs,
            pod.RootGraceExpiresAtUnixMs,
            pod.CircuitNumericId,
            pod.PublicInputLayoutVersion,
            pod.ZkAnonymousEnabled == 1,
            pod.VerifierConfigured == 1,
            PodProjector.ReadSlice(pod.CircuitId, payload),
            PodProjector.ReadSlice(pod.VerifyingKeyHash, payload),
            ReadBytes(pod.CredentialRoot, payload),
            ReadBytes(pod.RevocationRoot, payload),
            ReadBytes(pod.CircuitMetadata, payload));
        return reader.IsConsumed;
    }

    public static void WriteAnonymousCommentTicketRequest(AnonymousCommentTicketRequestCoreModel request, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(1024 + (request.ZkProof?.Length ?? 0));
        bool hasParentId = TryParsePositive(request.ParentId, out long parentId);
        bool hasRootId = TryParsePositive(request.RootId, out long rootId);
        bool hasReplyToCommentId = TryParsePositive(request.ReplyToCommentId, out long replyToCommentId);
        var mutable = new MutableAnonymousCommentTicketRequestPod
        {
            ArticleId = request.ArticleId,
            HasParentId = hasParentId ? (byte)1 : (byte)0,
            HasRootId = hasRootId ? (byte)1 : (byte)0,
            HasReplyToCommentId = hasReplyToCommentId ? (byte)1 : (byte)0,
            Reserved0 = 0,
            ParentId = parentId,
            RootId = rootId,
            ReplyToCommentId = replyToCommentId,
            CredentialEpoch = request.CredentialEpoch,
            CircuitNumericId = request.CircuitNumericId,
            PublicInputLayoutVersion = request.PublicInputLayoutVersion,
            Reserved1 = 0,
            AnonymousScope = PodUtf8Codec.AppendSlice(request.AnonymousScope, payload),
            DisplayLanguage = PodUtf8Codec.AppendSlice(request.DisplayLanguage, payload),
            CircuitId = PodUtf8Codec.AppendSlice(request.CircuitId, payload),
            NullifierHash = AppendBytes(request.NullifierHash ?? [], payload),
            ZkProof = AppendBytes(request.ZkProof ?? [], payload),
            PublicInputs = AppendBytes(request.PublicInputs ?? [], payload)
        };

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CastUserPod<MutableAnonymousCommentTicketRequestPod, AnonymousCommentTicketRequestPod>(mutable));
        writer.WriteBytes(payload.WrittenSpan);
    }

    public static byte[] EncodeAnonymousCommentTicketRequest(AnonymousCommentTicketRequestCoreModel request)
        => EncodeToArray(Marshal.SizeOf<AnonymousCommentTicketRequestPod>() + 1024 + (request.ZkProof?.Length ?? 0), writer => WriteAnonymousCommentTicketRequest(request, writer));

    public static bool TryDecodeAnonymousCommentTicketRequest(ReadOnlyMemory<byte> bytes, out AnonymousCommentTicketRequestCoreModel request)
    {
        var reader = new BinaryPodReader(bytes.Span);
        if (!reader.TryReadPod(out AnonymousCommentTicketRequestPod pod) ||
            pod.HasParentId > 1 ||
            pod.HasRootId > 1 ||
            pod.HasReplyToCommentId > 1 ||
            !reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            request = default;
            return false;
        }

        ReadOnlySpan<FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef> slices = stackalloc[]
        {
            pod.AnonymousScope,
            pod.DisplayLanguage,
            pod.CircuitId,
            pod.NullifierHash,
            pod.ZkProof,
            pod.PublicInputs
        };
        if (!ValidateAnonymousPayload(payload, slices))
        {
            request = default;
            return false;
        }

        request = new AnonymousCommentTicketRequestCoreModel(
            pod.ArticleId,
            pod.HasParentId == 1 ? pod.ParentId.ToString() : null,
            pod.HasRootId == 1 ? pod.RootId.ToString() : null,
            pod.HasReplyToCommentId == 1 ? pod.ReplyToCommentId.ToString() : null,
            pod.CredentialEpoch,
            pod.CircuitNumericId,
            pod.PublicInputLayoutVersion,
            PodProjector.ReadSlice(pod.AnonymousScope, payload),
            PodProjector.ReadSlice(pod.DisplayLanguage, payload),
            PodProjector.ReadSlice(pod.CircuitId, payload),
            ReadBytes(pod.NullifierHash, payload),
            ReadBytes(pod.ZkProof, payload),
            ReadBytes(pod.PublicInputs, payload));
        return reader.IsConsumed;
    }

    public static void WriteAnonymousCommentTicketResponse(AnonymousCommentTicketResponseCoreModel response, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(512 + (response.Ticket?.Length ?? 0));
        var mutable = new MutableAnonymousCommentTicketResponsePod
        {
            CredentialEpoch = response.CredentialEpoch,
            TicketExpiresAtUnixMs = response.TicketExpiresAtUnixMs,
            CredentialLevel = PodUtf8Codec.AppendSlice(response.CredentialLevel, payload),
            Ticket = AppendBytes(response.Ticket ?? [], payload),
            ModerationSubjectHash = AppendBytes(response.ModerationSubjectHash ?? [], payload),
            AnonymousNullifierHash = AppendBytes(response.AnonymousNullifierHash ?? [], payload)
        };

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CastUserPod<MutableAnonymousCommentTicketResponsePod, AnonymousCommentTicketResponsePod>(mutable));
        writer.WriteBytes(payload.WrittenSpan);
    }

    public static byte[] EncodeAnonymousCommentTicketResponse(AnonymousCommentTicketResponseCoreModel response)
        => EncodeToArray(Marshal.SizeOf<AnonymousCommentTicketResponsePod>() + 512 + (response.Ticket?.Length ?? 0), writer => WriteAnonymousCommentTicketResponse(response, writer));

    public static bool TryDecodeAnonymousCommentTicketResponse(ReadOnlyMemory<byte> bytes, out AnonymousCommentTicketResponseCoreModel response)
    {
        var reader = new BinaryPodReader(bytes.Span);
        if (!reader.TryReadPod(out AnonymousCommentTicketResponsePod pod) ||
            !reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            response = default;
            return false;
        }

        ReadOnlySpan<FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef> slices = stackalloc[]
        {
            pod.CredentialLevel,
            pod.Ticket,
            pod.ModerationSubjectHash,
            pod.AnonymousNullifierHash
        };
        if (!ValidateAnonymousPayload(payload, slices))
        {
            response = default;
            return false;
        }

        response = new AnonymousCommentTicketResponseCoreModel(
            pod.CredentialEpoch,
            pod.TicketExpiresAtUnixMs,
            PodProjector.ReadSlice(pod.CredentialLevel, payload),
            ReadBytes(pod.Ticket, payload),
            ReadBytes(pod.ModerationSubjectHash, payload),
            ReadBytes(pod.AnonymousNullifierHash, payload));
        return reader.IsConsumed;
    }

    public static void WriteAnonymousCommentCreateRequest(AnonymousCommentCreateRequestCoreModel request, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(512 + (request.Content?.Length ?? 0) + (request.Ticket?.Length ?? 0));
        bool hasParentId = TryParsePositive(request.ParentId, out long parentId);
        bool hasRootId = TryParsePositive(request.RootId, out long rootId);
        bool hasReplyToCommentId = TryParsePositive(request.ReplyToCommentId, out long replyToCommentId);
        var mutable = new MutableAnonymousCommentCreateRequestPod
        {
            ArticleId = request.ArticleId,
            HasParentId = hasParentId ? (byte)1 : (byte)0,
            HasRootId = hasRootId ? (byte)1 : (byte)0,
            HasReplyToCommentId = hasReplyToCommentId ? (byte)1 : (byte)0,
            Reserved0 = 0,
            ParentId = parentId,
            RootId = rootId,
            ReplyToCommentId = replyToCommentId,
            CredentialEpoch = request.CredentialEpoch,
            AnonymousScope = PodUtf8Codec.AppendSlice(request.AnonymousScope, payload),
            DisplayLanguage = PodUtf8Codec.AppendSlice(request.DisplayLanguage, payload),
            Ticket = AppendBytes(request.Ticket ?? [], payload),
            Content = PodUtf8Codec.AppendSlice(request.Content, payload)
        };

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CastUserPod<MutableAnonymousCommentCreateRequestPod, AnonymousCommentCreateRequestPod>(mutable));
        writer.WriteBytes(payload.WrittenSpan);
    }

    public static byte[] EncodeAnonymousCommentCreateRequest(AnonymousCommentCreateRequestCoreModel request)
        => EncodeToArray(Marshal.SizeOf<AnonymousCommentCreateRequestPod>() + 512 + (request.Content?.Length ?? 0) + (request.Ticket?.Length ?? 0), writer => WriteAnonymousCommentCreateRequest(request, writer));

    public static bool TryDecodeAnonymousCommentCreateRequest(ReadOnlyMemory<byte> bytes, out AnonymousCommentCreateRequestCoreModel request)
    {
        var reader = new BinaryPodReader(bytes.Span);
        if (!reader.TryReadPod(out AnonymousCommentCreateRequestPod pod) ||
            pod.HasParentId > 1 ||
            pod.HasRootId > 1 ||
            pod.HasReplyToCommentId > 1 ||
            !reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            request = default;
            return false;
        }

        ReadOnlySpan<FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef> slices = stackalloc[]
        {
            pod.AnonymousScope,
            pod.DisplayLanguage,
            pod.Ticket,
            pod.Content
        };
        if (!ValidateAnonymousPayload(payload, slices))
        {
            request = default;
            return false;
        }

        request = new AnonymousCommentCreateRequestCoreModel(
            pod.ArticleId,
            PodProjector.ReadSlice(pod.Content, payload),
            pod.HasParentId == 1 ? pod.ParentId.ToString() : null,
            pod.HasRootId == 1 ? pod.RootId.ToString() : null,
            pod.HasReplyToCommentId == 1 ? pod.ReplyToCommentId.ToString() : null,
            pod.CredentialEpoch,
            PodProjector.ReadSlice(pod.AnonymousScope, payload),
            PodProjector.ReadSlice(pod.DisplayLanguage, payload),
            ReadBytes(pod.Ticket, payload));
        return reader.IsConsumed;
    }

    public static void WriteAnonymousPrivacyStateSnapshot(AnonymousPrivacyStateSnapshotCoreModel snapshot, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(256);
        var mutable = new MutableAnonymousPrivacyStateSnapshotPod
        {
            CredentialEpoch = snapshot.CredentialEpoch,
            RootExpiresAtUnixMs = snapshot.RootExpiresAtUnixMs,
            TicketExpiresAtUnixMs = snapshot.TicketExpiresAtUnixMs,
            CircuitNumericId = snapshot.CircuitNumericId,
            PublicInputLayoutVersion = snapshot.PublicInputLayoutVersion,
            HasActiveCredential = snapshot.HasActiveCredential ? (byte)1 : (byte)0,
            CanIssueCredential = snapshot.CanIssueCredential ? (byte)1 : (byte)0,
            CanSubmitAnonymousComment = snapshot.CanSubmitAnonymousComment ? (byte)1 : (byte)0,
            Reserved0 = 0,
            CircuitId = PodUtf8Codec.AppendSlice(snapshot.CircuitId, payload),
            VerifyingKeyHash = PodUtf8Codec.AppendSlice(snapshot.VerifyingKeyHash, payload),
            CredentialStatus = PodUtf8Codec.AppendSlice(snapshot.CredentialStatus, payload),
            CredentialLevel = PodUtf8Codec.AppendSlice(snapshot.CredentialLevel, payload)
        };

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CastUserPod<MutableAnonymousPrivacyStateSnapshotPod, AnonymousPrivacyStateSnapshotPod>(mutable));
        writer.WriteBytes(payload.WrittenSpan);
    }

    public static byte[] EncodeAnonymousPrivacyStateSnapshot(AnonymousPrivacyStateSnapshotCoreModel snapshot)
        => EncodeToArray(Marshal.SizeOf<AnonymousPrivacyStateSnapshotPod>() + 256, writer => WriteAnonymousPrivacyStateSnapshot(snapshot, writer));

    public static bool TryDecodeAnonymousPrivacyStateSnapshot(ReadOnlyMemory<byte> bytes, out AnonymousPrivacyStateSnapshotCoreModel snapshot)
    {
        var reader = new BinaryPodReader(bytes.Span);
        if (!reader.TryReadPod(out AnonymousPrivacyStateSnapshotPod pod) ||
            pod.HasActiveCredential > 1 ||
            pod.CanIssueCredential > 1 ||
            pod.CanSubmitAnonymousComment > 1 ||
            !reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            snapshot = default;
            return false;
        }

        ReadOnlySpan<FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef> slices = stackalloc[]
        {
            pod.CircuitId,
            pod.VerifyingKeyHash,
            pod.CredentialStatus,
            pod.CredentialLevel
        };
        if (!ValidateAnonymousPayload(payload, slices))
        {
            snapshot = default;
            return false;
        }

        snapshot = new AnonymousPrivacyStateSnapshotCoreModel(
            pod.CredentialEpoch,
            pod.RootExpiresAtUnixMs,
            pod.TicketExpiresAtUnixMs,
            pod.CircuitNumericId,
            pod.PublicInputLayoutVersion,
            pod.HasActiveCredential == 1,
            pod.CanIssueCredential == 1,
            pod.CanSubmitAnonymousComment == 1,
            PodProjector.ReadSlice(pod.CircuitId, payload),
            PodProjector.ReadSlice(pod.VerifyingKeyHash, payload),
            PodProjector.ReadSlice(pod.CredentialStatus, payload),
            PodProjector.ReadSlice(pod.CredentialLevel, payload));
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

    private static bool ValidateAnonymousPayload(
        ReadOnlySpan<byte> payload,
        ReadOnlySpan<FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef> slices)
    {
        if (payload.Length > AnonymousPrivacyMaxPayloadBytes)
        {
            return false;
        }

        foreach (FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef slice in slices)
        {
            if (slice.Offset < 0 || slice.Length < 0 || slice.Length > AnonymousPrivacyMaxPayloadBytes)
            {
                return false;
            }

            long end = (long)slice.Offset + slice.Length;
            if (end > payload.Length)
            {
                return false;
            }
        }

        return true;
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
    private struct MutableAnonymousCredentialIssueRequestPod
    {
        public long CredentialEpoch;
        public uint CircuitNumericId;
        public ushort PublicInputLayoutVersion;
        public ushort Reserved0;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef CircuitId;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef CredentialLevel;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef BlindedRequest;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef ClientNonce;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableAnonymousCredentialIssueResponsePod
    {
        public long CredentialEpoch;
        public long RootExpiresAtUnixMs;
        public uint CircuitNumericId;
        public ushort PublicInputLayoutVersion;
        public ushort Reserved0;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef CircuitId;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef CredentialLevel;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef IssuerResponse;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef CredentialCommitment;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableAnonymousCredentialRootSnapshotPod
    {
        public long CredentialEpoch;
        public long RootExpiresAtUnixMs;
        public long RootGraceExpiresAtUnixMs;
        public uint CircuitNumericId;
        public ushort PublicInputLayoutVersion;
        public byte ZkAnonymousEnabled;
        public byte VerifierConfigured;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef CircuitId;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef VerifyingKeyHash;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef CredentialRoot;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef RevocationRoot;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef CircuitMetadata;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableAnonymousCommentTicketRequestPod
    {
        public int ArticleId;
        public byte HasParentId;
        public byte HasRootId;
        public byte HasReplyToCommentId;
        public byte Reserved0;
        public long ParentId;
        public long RootId;
        public long ReplyToCommentId;
        public long CredentialEpoch;
        public uint CircuitNumericId;
        public ushort PublicInputLayoutVersion;
        public ushort Reserved1;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef AnonymousScope;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef DisplayLanguage;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef CircuitId;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef NullifierHash;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef ZkProof;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef PublicInputs;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableAnonymousCommentTicketResponsePod
    {
        public long CredentialEpoch;
        public long TicketExpiresAtUnixMs;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef CredentialLevel;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Ticket;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef ModerationSubjectHash;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef AnonymousNullifierHash;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableAnonymousCommentCreateRequestPod
    {
        public int ArticleId;
        public byte HasParentId;
        public byte HasRootId;
        public byte HasReplyToCommentId;
        public byte Reserved0;
        public long ParentId;
        public long RootId;
        public long ReplyToCommentId;
        public long CredentialEpoch;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef AnonymousScope;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef DisplayLanguage;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Ticket;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Content;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableAnonymousPrivacyStateSnapshotPod
    {
        public long CredentialEpoch;
        public long RootExpiresAtUnixMs;
        public long TicketExpiresAtUnixMs;
        public uint CircuitNumericId;
        public ushort PublicInputLayoutVersion;
        public byte HasActiveCredential;
        public byte CanIssueCredential;
        public byte CanSubmitAnonymousComment;
        public byte Reserved0;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef CircuitId;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef VerifyingKeyHash;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef CredentialStatus;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef CredentialLevel;
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
