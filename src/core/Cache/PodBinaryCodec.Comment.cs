using FsusBlog.Core.Mapping.Codecs;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Mapping.Projectors;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Outputs;
using FsusBlog.Shared.Contracts.Primitives;
using FsusBlog.Shared.Contracts.Validation;
using System.Buffers;
using System.Buffers.Binary;
using System.Runtime.InteropServices;

namespace FsusBlog.Core.Cache;

public static partial class PodBinaryCodec
{
    private const int AnonymousPrivacyMaxPayloadBytes = 16 * 1024;
    private const int CommentDefaultMaxChars = 1000;
    private const int CommentDefaultMaxUtf8Bytes = 4096;
    private const int CommentMinMaxChars = 100;
    private const int CommentHardMaxChars = 3000;
    private const int CommentMinMaxUtf8Bytes = 1024;
    private const int CommentHardMaxUtf8Bytes = 12288;

    public static void WriteCommentPolicySnapshot(CommentPolicySnapshotCoreModel snapshot, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(128);
        var mutable = new MutableCommentPolicySnapshotPod
        {
            AnonymousCommentsEnabled = snapshot.AnonymousCommentsEnabled ? (byte)1 : (byte)0,
            PublicCommentsEnabled = snapshot.PublicCommentsEnabled ? (byte)1 : (byte)0,
            ZkAnonymousEnabled = snapshot.ZkAnonymousEnabled ? (byte)1 : (byte)0,
            DefaultAuthorMode = EncodeCommentAuthorMode(snapshot.DefaultAuthorMode),
            ZkProdEnabled = snapshot.ZkProdEnabled ? (byte)1 : (byte)0,
            ZkProdNativeVerifierConfigured = snapshot.ZkProdNativeVerifierConfigured ? (byte)1 : (byte)0,
            ZkProdTrustedSetupVerified = snapshot.ZkProdTrustedSetupVerified ? (byte)1 : (byte)0,
            ZkProdCredentialRequired = snapshot.ZkProdCredentialRequired ? (byte)1 : (byte)0,
            ZkProdCredentialRootReady = snapshot.ZkProdCredentialRootReady ? (byte)1 : (byte)0,
            CommentMaxChars = NormalizeCommentMaxChars(snapshot.CommentMaxChars),
            CommentMaxUtf8Bytes = NormalizeCommentMaxUtf8Bytes(snapshot.CommentMaxUtf8Bytes),
            SupportedDisplayLanguages = PodUtf8Codec.AppendSlice(JoinDisplayLanguages(snapshot.SupportedDisplayLanguages), payload),
            SnapshotHash = PodUtf8Codec.AppendSlice(NormalizePolicySnapshotHash(snapshot.SnapshotHash), payload),
            ZkProdUnavailableReason = PodUtf8Codec.AppendSlice(NormalizeZkProdUnavailableReason(snapshot.ZkProdUnavailableReason), payload)
        };

        var writer = new BinaryPodWriter(destination);
        WriteCommentPolicySnapshotPod(ref writer, in mutable);
        writer.WriteBytes(payload.WrittenSpan);
    }

    public static byte[] EncodeCommentPolicySnapshot(CommentPolicySnapshotCoreModel snapshot)
        => EncodeToArray(Marshal.SizeOf<CommentPolicySnapshotPod>() + 128, writer => WriteCommentPolicySnapshot(snapshot, writer));

    public static bool TryDecodeCommentPolicySnapshot(ReadOnlyMemory<byte> bytes, out CommentPolicySnapshotCoreModel snapshot)
    {
        var reader = new BinaryPodReader(bytes.Span);
        if (!TryReadCommentPolicySnapshotPod(ref reader, out var pod) ||
            pod.AnonymousCommentsEnabled > 1 ||
            pod.PublicCommentsEnabled > 1 ||
            pod.ZkAnonymousEnabled > 1 ||
            pod.ZkProdEnabled > 1 ||
            pod.ZkProdNativeVerifierConfigured > 1 ||
            pod.ZkProdTrustedSetupVerified > 1 ||
            pod.ZkProdCredentialRequired > 1 ||
            pod.ZkProdCredentialRootReady > 1 ||
            !IsCommentMaxCharsValid(pod.CommentMaxChars) ||
            !IsCommentMaxUtf8BytesValid(pod.CommentMaxUtf8Bytes) ||
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
            SplitDisplayLanguages(PodProjector.ReadSlice(pod.SupportedDisplayLanguages, payload)),
            PodProjector.ReadSlice(pod.SnapshotHash, payload),
            pod.CommentMaxChars,
            pod.CommentMaxUtf8Bytes,
            pod.ZkProdEnabled == 1,
            pod.ZkProdNativeVerifierConfigured == 1,
            pod.ZkProdTrustedSetupVerified == 1,
            pod.ZkProdCredentialRequired == 1,
            pod.ZkProdCredentialRootReady == 1,
            PodProjector.ReadSlice(pod.ZkProdUnavailableReason, payload));
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
            HasCommentMaxChars = request.CommentMaxChars.HasValue ? (byte)1 : (byte)0,
            HasCommentMaxUtf8Bytes = request.CommentMaxUtf8Bytes.HasValue ? (byte)1 : (byte)0,
            CommentMaxChars = request.CommentMaxChars.GetValueOrDefault(),
            CommentMaxUtf8Bytes = request.CommentMaxUtf8Bytes.GetValueOrDefault(),
            SupportedDisplayLanguages = PodUtf8Codec.AppendSlice(JoinDisplayLanguages(request.SupportedDisplayLanguages), payload)
        };

        var writer = new BinaryPodWriter(destination);
        WriteCommentPolicyUpdateRequestPod(ref writer, in mutable);
        writer.WriteBytes(payload.WrittenSpan);
    }

    public static byte[] EncodeCommentPolicyUpdateRequest(CommentPolicyUpdateRequestCoreModel request)
        => EncodeToArray(Marshal.SizeOf<CommentPolicyUpdateRequestPod>() + 128, writer => WriteCommentPolicyUpdateRequest(request, writer));

    public static bool TryDecodeCommentPolicyUpdateRequest(ReadOnlyMemory<byte> bytes, out CommentPolicyUpdateRequestCoreModel request)
    {
        var reader = new BinaryPodReader(bytes.Span);
        if (!TryReadCommentPolicyUpdateRequestPod(ref reader, out var pod) ||
            pod.HasAnonymousCommentsEnabled > 1 ||
            pod.AnonymousCommentsEnabled > 1 ||
            pod.HasPublicCommentsEnabled > 1 ||
            pod.PublicCommentsEnabled > 1 ||
            pod.HasZkAnonymousEnabled > 1 ||
            pod.ZkAnonymousEnabled > 1 ||
            pod.HasDefaultAuthorMode > 1 ||
            pod.HasCommentMaxChars > 1 ||
            pod.HasCommentMaxUtf8Bytes > 1 ||
            (pod.HasCommentMaxChars == 1 && !IsCommentMaxCharsValid(pod.CommentMaxChars)) ||
            (pod.HasCommentMaxUtf8Bytes == 1 && !IsCommentMaxUtf8BytesValid(pod.CommentMaxUtf8Bytes)) ||
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
            languages,
            pod.HasCommentMaxChars == 1 ? pod.CommentMaxChars : null,
            pod.HasCommentMaxUtf8Bytes == 1 ? pod.CommentMaxUtf8Bytes : null);
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
        var payload = new ArrayBufferWriter<byte>(512 + (request.CredentialRequest?.Length ?? 0));
        var mutable = new MutableAnonymousCredentialIssueRequestPod
        {
            CredentialEpoch = request.CredentialEpoch,
            CircuitNumericId = request.CircuitNumericId,
            PublicInputLayoutVersion = request.PublicInputLayoutVersion,
            Reserved0 = 0,
            CircuitId = PodUtf8Codec.AppendSlice(request.CircuitId, payload),
            CredentialLevel = PodUtf8Codec.AppendSlice(request.CredentialLevel, payload),
            CredentialRequest = AppendBytes(request.CredentialRequest ?? [], payload),
            ClientNonce = AppendBytes(request.ClientNonce ?? [], payload)
        };

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CastUserPod<MutableAnonymousCredentialIssueRequestPod, AnonymousCredentialIssueRequestPod>(mutable));
        writer.WriteBytes(payload.WrittenSpan);
    }

    public static byte[] EncodeAnonymousCredentialIssueRequest(AnonymousCredentialIssueRequestCoreModel request)
        => EncodeToArray(Marshal.SizeOf<AnonymousCredentialIssueRequestPod>() + 512 + (request.CredentialRequest?.Length ?? 0), writer => WriteAnonymousCredentialIssueRequest(request, writer));

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
            pod.CredentialRequest,
            pod.ClientNonce
        };
        if (!ValidateAnonymousPayload(payload, slices) ||
            !IsProductionAnonymousLayout(pod.CircuitId, pod.PublicInputLayoutVersion, payload) ||
            !SliceLengthAtMost(pod.CredentialRequest, AnonymousPrivacyContract.MaxCircuitNativeCredentialRequestBytes) ||
            !SliceLengthAtMost(pod.ClientNonce, AnonymousPrivacyContract.MaxClientNonceBytes) ||
            !SliceLengthAtMost(pod.CredentialLevel, AnonymousPrivacyContract.MaxCredentialLevelBytes))
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
            ReadBytes(pod.CredentialRequest, payload),
            ReadBytes(pod.ClientNonce, payload));
        return reader.IsConsumed;
    }

    public static void WriteAnonymousCredentialIssueResponse(AnonymousCredentialIssueResponseCoreModel response, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(512 + (response.IssuerSignature?.Length ?? 0));
        var mutable = new MutableAnonymousCredentialIssueResponsePod
        {
            CredentialEpoch = response.CredentialEpoch,
            ExpiresAtUnixMs = response.ExpiresAtUnixMs,
            CircuitNumericId = response.CircuitNumericId,
            PublicInputLayoutVersion = response.PublicInputLayoutVersion,
            Reserved0 = 0,
            CircuitId = PodUtf8Codec.AppendSlice(response.CircuitId, payload),
            CredentialLevel = PodUtf8Codec.AppendSlice(response.CredentialLevel, payload),
            IssuerPublicKeyId = PodUtf8Codec.AppendSlice(response.IssuerPublicKeyId, payload),
            IssuerSignature = AppendBytes(response.IssuerSignature ?? [], payload)
        };

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CastUserPod<MutableAnonymousCredentialIssueResponsePod, AnonymousCredentialIssueResponsePod>(mutable));
        writer.WriteBytes(payload.WrittenSpan);
    }

    public static byte[] EncodeAnonymousCredentialIssueResponse(AnonymousCredentialIssueResponseCoreModel response)
        => EncodeToArray(Marshal.SizeOf<AnonymousCredentialIssueResponsePod>() + 512 + (response.IssuerSignature?.Length ?? 0), writer => WriteAnonymousCredentialIssueResponse(response, writer));

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
            pod.IssuerPublicKeyId,
            pod.IssuerSignature
        };
        if (!ValidateAnonymousPayload(payload, slices) ||
            !IsProductionAnonymousLayout(pod.CircuitId, pod.PublicInputLayoutVersion, payload) ||
            !SliceLengthAtMost(pod.CredentialLevel, AnonymousPrivacyContract.MaxCredentialLevelBytes) ||
            !SliceLengthAtMost(pod.IssuerPublicKeyId, AnonymousPrivacyContract.MaxIssuerPublicKeyIdBytes) ||
            !SliceLengthAtMost(pod.IssuerSignature, AnonymousPrivacyContract.MaxCircuitNativeIssuerSignatureBytes))
        {
            response = default;
            return false;
        }

        response = new AnonymousCredentialIssueResponseCoreModel(
            pod.CredentialEpoch,
            pod.ExpiresAtUnixMs,
            pod.CircuitNumericId,
            pod.PublicInputLayoutVersion,
            PodProjector.ReadSlice(pod.CircuitId, payload),
            PodProjector.ReadSlice(pod.CredentialLevel, payload),
            PodProjector.ReadSlice(pod.IssuerPublicKeyId, payload),
            ReadBytes(pod.IssuerSignature, payload));
        return reader.IsConsumed;
    }

    public static void WriteBlindCredentialIssuerMetadata(
        BlindCredentialIssuerMetadataCoreModel metadata,
        IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(1024);
        var mutable = new MutableBlindCredentialIssuerMetadataPod
        {
            CredentialEpoch = metadata.CredentialEpoch,
            ExpiresAtUnixMs = metadata.ExpiresAtUnixMs,
            CircuitNumericId = metadata.CircuitNumericId,
            PublicInputLayoutVersion = metadata.PublicInputLayoutVersion,
            ModulusBytes = metadata.ModulusBytes,
            CircuitId = PodUtf8Codec.AppendSlice(metadata.CircuitId, payload),
            CredentialLevel = PodUtf8Codec.AppendSlice(metadata.CredentialLevel, payload),
            SchemeId = PodUtf8Codec.AppendSlice(metadata.SchemeId, payload),
            IssuerPublicKeyId = PodUtf8Codec.AppendSlice(metadata.IssuerPublicKeyId, payload),
            IssuerPublicKeyHash = PodUtf8Codec.AppendSlice(metadata.IssuerPublicKeyHash, payload),
            SubjectPublicKeyInfo = AppendBytes(metadata.SubjectPublicKeyInfo ?? [], payload)
        };
        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CastUserPod<MutableBlindCredentialIssuerMetadataPod, BlindCredentialIssuerMetadataPod>(mutable));
        writer.WriteBytes(payload.WrittenSpan);
    }

    public static bool TryDecodeBlindCredentialIssuerMetadata(
        ReadOnlyMemory<byte> bytes,
        out BlindCredentialIssuerMetadataCoreModel metadata)
    {
        var reader = new BinaryPodReader(bytes.Span);
        if (!reader.TryReadPod(out BlindCredentialIssuerMetadataPod pod) ||
            !reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            metadata = default;
            return false;
        }
        ReadOnlySpan<FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef> slices = stackalloc[]
        {
            pod.CircuitId, pod.CredentialLevel, pod.SchemeId, pod.IssuerPublicKeyId,
            pod.IssuerPublicKeyHash, pod.SubjectPublicKeyInfo
        };
        if (!ValidateAnonymousPayload(payload, slices) ||
            !IsProductionAnonymousLayout(pod.CircuitId, pod.PublicInputLayoutVersion, payload) ||
            pod.ModulusBytes != Rfc9474BlindCredentialProfile.ModulusBytes ||
            !SliceLengthAtMost(pod.CredentialLevel, AnonymousPrivacyContract.MaxCredentialLevelBytes) ||
            !SliceLengthAtMost(pod.SchemeId, 96) ||
            !SliceLengthAtMost(pod.IssuerPublicKeyId, Rfc9474BlindCredentialProfile.MaxKeyIdBytes) ||
            !SliceLengthAtMost(pod.IssuerPublicKeyHash, 64) ||
            !SliceLengthAtMost(pod.SubjectPublicKeyInfo, Rfc9474BlindCredentialProfile.MaxSubjectPublicKeyInfoBytes))
        {
            metadata = default;
            return false;
        }
        metadata = new BlindCredentialIssuerMetadataCoreModel(
            pod.CredentialEpoch,
            pod.ExpiresAtUnixMs,
            pod.CircuitNumericId,
            pod.PublicInputLayoutVersion,
            PodProjector.ReadSlice(pod.CircuitId, payload),
            PodProjector.ReadSlice(pod.CredentialLevel, payload),
            PodProjector.ReadSlice(pod.SchemeId, payload),
            PodProjector.ReadSlice(pod.IssuerPublicKeyId, payload),
            PodProjector.ReadSlice(pod.IssuerPublicKeyHash, payload),
            pod.ModulusBytes,
            ReadBytes(pod.SubjectPublicKeyInfo, payload));
        return reader.IsConsumed;
    }

    public static void WriteBlindCredentialIssueRequest(
        BlindCredentialIssueRequestCoreModel request,
        IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(1024);
        var mutable = new MutableBlindCredentialIssueRequestPod
        {
            CredentialEpoch = request.CredentialEpoch,
            CircuitNumericId = request.CircuitNumericId,
            PublicInputLayoutVersion = request.PublicInputLayoutVersion,
            Reserved0 = 0,
            CircuitId = PodUtf8Codec.AppendSlice(request.CircuitId, payload),
            CredentialLevel = PodUtf8Codec.AppendSlice(request.CredentialLevel, payload),
            SchemeId = PodUtf8Codec.AppendSlice(request.SchemeId, payload),
            IssuerPublicKeyId = PodUtf8Codec.AppendSlice(request.IssuerPublicKeyId, payload),
            BlindedMessage = AppendBytes(request.BlindedMessage ?? [], payload)
        };
        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CastUserPod<MutableBlindCredentialIssueRequestPod, BlindCredentialIssueRequestPod>(mutable));
        writer.WriteBytes(payload.WrittenSpan);
    }

    public static bool TryDecodeBlindCredentialIssueRequest(
        ReadOnlyMemory<byte> bytes,
        out BlindCredentialIssueRequestCoreModel request)
    {
        var reader = new BinaryPodReader(bytes.Span);
        if (!reader.TryReadPod(out BlindCredentialIssueRequestPod pod) ||
            !reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            request = default;
            return false;
        }
        ReadOnlySpan<FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef> slices = stackalloc[]
        {
            pod.CircuitId, pod.CredentialLevel, pod.SchemeId, pod.IssuerPublicKeyId, pod.BlindedMessage
        };
        if (!ValidateAnonymousPayload(payload, slices) ||
            !IsProductionAnonymousLayout(pod.CircuitId, pod.PublicInputLayoutVersion, payload) ||
            !SliceLengthAtMost(pod.CredentialLevel, AnonymousPrivacyContract.MaxCredentialLevelBytes) ||
            !SliceLengthAtMost(pod.SchemeId, 96) ||
            !SliceLengthAtMost(pod.IssuerPublicKeyId, Rfc9474BlindCredentialProfile.MaxKeyIdBytes) ||
            pod.BlindedMessage.Length != Rfc9474BlindCredentialProfile.ModulusBytes)
        {
            request = default;
            return false;
        }
        request = new BlindCredentialIssueRequestCoreModel(
            pod.CredentialEpoch,
            pod.CircuitNumericId,
            pod.PublicInputLayoutVersion,
            PodProjector.ReadSlice(pod.CircuitId, payload),
            PodProjector.ReadSlice(pod.CredentialLevel, payload),
            PodProjector.ReadSlice(pod.SchemeId, payload),
            PodProjector.ReadSlice(pod.IssuerPublicKeyId, payload),
            ReadBytes(pod.BlindedMessage, payload));
        return reader.IsConsumed;
    }

    public static void WriteBlindCredentialIssueResponse(
        BlindCredentialIssueResponseCoreModel response,
        IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(1024);
        var mutable = new MutableBlindCredentialIssueResponsePod
        {
            CredentialEpoch = response.CredentialEpoch,
            ExpiresAtUnixMs = response.ExpiresAtUnixMs,
            CircuitNumericId = response.CircuitNumericId,
            PublicInputLayoutVersion = response.PublicInputLayoutVersion,
            Reserved0 = 0,
            CircuitId = PodUtf8Codec.AppendSlice(response.CircuitId, payload),
            CredentialLevel = PodUtf8Codec.AppendSlice(response.CredentialLevel, payload),
            SchemeId = PodUtf8Codec.AppendSlice(response.SchemeId, payload),
            IssuerPublicKeyId = PodUtf8Codec.AppendSlice(response.IssuerPublicKeyId, payload),
            BlindSignature = AppendBytes(response.BlindSignature ?? [], payload)
        };
        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CastUserPod<MutableBlindCredentialIssueResponsePod, BlindCredentialIssueResponsePod>(mutable));
        writer.WriteBytes(payload.WrittenSpan);
    }

    public static bool TryDecodeBlindCredentialIssueResponse(
        ReadOnlyMemory<byte> bytes,
        out BlindCredentialIssueResponseCoreModel response)
    {
        var reader = new BinaryPodReader(bytes.Span);
        if (!reader.TryReadPod(out BlindCredentialIssueResponsePod pod) ||
            !reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            response = default;
            return false;
        }
        ReadOnlySpan<FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef> slices = stackalloc[]
        {
            pod.CircuitId, pod.CredentialLevel, pod.SchemeId, pod.IssuerPublicKeyId, pod.BlindSignature
        };
        if (!ValidateAnonymousPayload(payload, slices) ||
            !IsProductionAnonymousLayout(pod.CircuitId, pod.PublicInputLayoutVersion, payload) ||
            !SliceLengthAtMost(pod.CredentialLevel, AnonymousPrivacyContract.MaxCredentialLevelBytes) ||
            !SliceLengthAtMost(pod.SchemeId, 96) ||
            !SliceLengthAtMost(pod.IssuerPublicKeyId, Rfc9474BlindCredentialProfile.MaxKeyIdBytes) ||
            pod.BlindSignature.Length != Rfc9474BlindCredentialProfile.ModulusBytes)
        {
            response = default;
            return false;
        }
        response = new BlindCredentialIssueResponseCoreModel(
            pod.CredentialEpoch,
            pod.ExpiresAtUnixMs,
            pod.CircuitNumericId,
            pod.PublicInputLayoutVersion,
            PodProjector.ReadSlice(pod.CircuitId, payload),
            PodProjector.ReadSlice(pod.CredentialLevel, payload),
            PodProjector.ReadSlice(pod.SchemeId, payload),
            PodProjector.ReadSlice(pod.IssuerPublicKeyId, payload),
            ReadBytes(pod.BlindSignature, payload));
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
            IssuerPublicKeyHash = PodUtf8Codec.AppendSlice(snapshot.IssuerPublicKeyHash, payload),
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
            pod.IssuerPublicKeyHash,
            pod.CredentialRoot,
            pod.RevocationRoot,
            pod.CircuitMetadata
        };
        if (!ValidateAnonymousPayload(payload, slices) ||
            !IsProductionAnonymousLayout(pod.CircuitId, pod.PublicInputLayoutVersion, payload) ||
            !SliceLengthAtMost(pod.VerifyingKeyHash, AnonymousPrivacyContract.MaxVerifyingKeyHashBytes) ||
            !SliceLengthAtMost(pod.IssuerPublicKeyHash, AnonymousPrivacyContract.MaxIssuerPublicKeyHashBytes) ||
            !SliceLengthAtMost(pod.CredentialRoot, AnonymousPrivacyContract.MaxCredentialRootBytes) ||
            !SliceLengthAtMost(pod.RevocationRoot, AnonymousPrivacyContract.MaxRevocationRootBytes) ||
            !SliceLengthAtMost(pod.CircuitMetadata, AnonymousPrivacyContract.MaxCircuitMetadataBytes))
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
            PodProjector.ReadSlice(pod.IssuerPublicKeyHash, payload),
            ReadBytes(pod.CredentialRoot, payload),
            ReadBytes(pod.RevocationRoot, payload),
            ReadBytes(pod.CircuitMetadata, payload));
        return reader.IsConsumed;
    }

    public static void WriteAnonymousCredentialRevocationArtifact(
        AnonymousCredentialRevocationArtifactCoreModel artifact,
        IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(512 + (artifact.EntryHashes?.Length ?? 0));
        var mutable = new MutableAnonymousCredentialRevocationArtifactPod
        {
            CredentialEpoch = artifact.CredentialEpoch,
            Version = artifact.Version,
            BaseVersion = artifact.BaseVersion,
            ExpiresAtUnixMs = artifact.ExpiresAtUnixMs,
            EntryCount = artifact.EntryHashes is { Length: > 0 } && artifact.EntryHashes.Length % 32 == 0
                ? (uint)(artifact.EntryHashes.Length / 32)
                : 0,
            PathDepth = artifact.PathDepth,
            Kind = artifact.Kind,
            Reserved0 = 0,
            AlgorithmId = PodUtf8Codec.AppendSlice(artifact.AlgorithmId, payload),
            IssuerPublicKeyHash = PodUtf8Codec.AppendSlice(artifact.IssuerPublicKeyHash, payload),
            RevocationRoot = AppendBytes(artifact.RevocationRoot ?? [], payload),
            ContentHash = AppendBytes(artifact.ContentHash ?? [], payload),
            Signature = AppendBytes(artifact.Signature ?? [], payload),
            EntryHashes = AppendBytes(artifact.EntryHashes ?? [], payload)
        };

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CastUserPod<MutableAnonymousCredentialRevocationArtifactPod, AnonymousCredentialRevocationArtifactPod>(mutable));
        writer.WriteBytes(payload.WrittenSpan);
    }

    public static byte[] EncodeAnonymousCredentialRevocationArtifact(
        AnonymousCredentialRevocationArtifactCoreModel artifact)
        => EncodeToArray(
            Marshal.SizeOf<AnonymousCredentialRevocationArtifactPod>() + 512 + (artifact.EntryHashes?.Length ?? 0),
            writer => WriteAnonymousCredentialRevocationArtifact(artifact, writer));

    public static bool TryDecodeAnonymousCredentialRevocationArtifact(
        ReadOnlyMemory<byte> bytes,
        out AnonymousCredentialRevocationArtifactCoreModel artifact)
    {
        var reader = new BinaryPodReader(bytes.Span);
        if (!reader.TryReadPod(out AnonymousCredentialRevocationArtifactPod pod) ||
            !reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            artifact = default;
            return false;
        }

        ReadOnlySpan<FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef> slices = stackalloc[]
        {
            pod.AlgorithmId,
            pod.IssuerPublicKeyHash,
            pod.RevocationRoot,
            pod.ContentHash,
            pod.Signature,
            pod.EntryHashes
        };
        if (!ValidateAnonymousPayload(payload, slices) ||
            pod.CredentialEpoch <= 0 ||
            pod.Version < 0 ||
            pod.BaseVersion < 0 ||
            pod.BaseVersion > pod.Version ||
            pod.Kind is not (1 or 2) ||
            pod.PathDepth != AnonymousPrivacyContract.MaxRevocationWitnessPathDepth ||
            pod.EntryCount > AnonymousPrivacyContract.MaxRevocationArtifactEntries ||
            pod.EntryHashes.Length != checked((int)pod.EntryCount * 32) ||
            pod.EntryHashes.Length > AnonymousPrivacyContract.MaxRevocationArtifactBytes ||
            !SliceLengthAtMost(pod.AlgorithmId, AnonymousPrivacyContract.MaxRevocationWitnessAlgorithmIdBytes) ||
            !SliceLengthAtMost(pod.IssuerPublicKeyHash, AnonymousPrivacyContract.MaxIssuerPublicKeyHashBytes) ||
            pod.RevocationRoot.Length != 32 ||
            pod.ContentHash.Length != 32 ||
            pod.Signature.Length != 32)
        {
            artifact = default;
            return false;
        }

        artifact = new AnonymousCredentialRevocationArtifactCoreModel(
            pod.CredentialEpoch,
            pod.Version,
            pod.BaseVersion,
            pod.ExpiresAtUnixMs,
            pod.Kind,
            pod.PathDepth,
            PodProjector.ReadSlice(pod.AlgorithmId, payload),
            PodProjector.ReadSlice(pod.IssuerPublicKeyHash, payload),
            ReadBytes(pod.RevocationRoot, payload),
            ReadBytes(pod.ContentHash, payload),
            ReadBytes(pod.Signature, payload),
            ReadBytes(pod.EntryHashes, payload));
        return reader.IsConsumed;
    }

    public static void WriteAnonymousCommentTicketRequest(AnonymousCommentTicketRequestCoreModel request, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(
            1024 +
            (request.CredentialRoot?.Length ?? 0) +
            (request.RevocationRoot?.Length ?? 0) +
            (request.Groth16Proof?.Length ?? 0) +
            (request.PublicInputs?.Length ?? 0));
        bool hasParentId = TryParsePositive(request.ParentId, out long parentId);
        bool hasRootId = TryParsePositive(request.RootId, out long rootId);
        bool hasReplyToCommentId = TryParsePositive(request.ReplyToCommentId, out long replyToCommentId);
        var mutable = new MutableAnonymousCommentTicketRequestPod
        {
            ArticleId = request.ArticleId,
            HasParentId = hasParentId ? (byte)1 : (byte)0,
            HasRootId = hasRootId ? (byte)1 : (byte)0,
            HasReplyToCommentId = hasReplyToCommentId ? (byte)1 : (byte)0,
            IsEligible = request.IsEligible ? (byte)1 : (byte)0,
            ParentId = parentId,
            RootId = rootId,
            ReplyToCommentId = replyToCommentId,
            CircuitNumericId = request.CircuitNumericId,
            PublicInputLayoutVersion = request.PublicInputLayoutVersion,
            MayComment = request.MayComment ? (byte)1 : (byte)0,
            RequiresModeration = request.RequiresModeration ? (byte)1 : (byte)0,
            ActionContext = PodUtf8Codec.AppendSlice(request.ActionContext, payload),
            Scope = PodUtf8Codec.AppendSlice(request.Scope, payload),
            CircuitId = PodUtf8Codec.AppendSlice(request.CircuitId, payload),
            VerifyingKeyHash = PodUtf8Codec.AppendSlice(request.VerifyingKeyHash, payload),
            NullifierHash = AppendBytes(request.NullifierHash ?? [], payload),
            CredentialRoot = AppendBytes(request.CredentialRoot ?? [], payload),
            RevocationRoot = AppendBytes(request.RevocationRoot ?? [], payload),
            RateClass = PodUtf8Codec.AppendSlice(request.RateClass, payload),
            Groth16Proof = AppendBytes(request.Groth16Proof ?? [], payload),
            PublicInputs = AppendBytes(request.PublicInputs ?? [], payload)
        };

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CastUserPod<MutableAnonymousCommentTicketRequestPod, AnonymousCommentTicketRequestPod>(mutable));
        writer.WriteBytes(payload.WrittenSpan);
    }

    public static byte[] EncodeAnonymousCommentTicketRequest(AnonymousCommentTicketRequestCoreModel request)
        => EncodeToArray(
            Marshal.SizeOf<AnonymousCommentTicketRequestPod>() + 1024 + (request.Groth16Proof?.Length ?? 0) + (request.PublicInputs?.Length ?? 0),
            writer => WriteAnonymousCommentTicketRequest(request, writer));

    public static bool TryDecodeAnonymousCommentTicketRequest(ReadOnlyMemory<byte> bytes, out AnonymousCommentTicketRequestCoreModel request)
    {
        var reader = new BinaryPodReader(bytes.Span);
        if (!reader.TryReadPod(out AnonymousCommentTicketRequestPod pod) ||
            pod.HasParentId > 1 ||
            pod.HasRootId > 1 ||
            pod.HasReplyToCommentId > 1 ||
            pod.IsEligible > 1 ||
            pod.MayComment > 1 ||
            pod.RequiresModeration > 1 ||
            !reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            request = default;
            return false;
        }

        ReadOnlySpan<FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef> slices = stackalloc[]
        {
            pod.ActionContext,
            pod.Scope,
            pod.CircuitId,
            pod.VerifyingKeyHash,
            pod.NullifierHash,
            pod.CredentialRoot,
            pod.RevocationRoot,
            pod.RateClass,
            pod.Groth16Proof,
            pod.PublicInputs
        };
        if (!ValidateAnonymousPayload(payload, slices) ||
            !IsProductionAnonymousLayout(pod.CircuitId, pod.PublicInputLayoutVersion, payload) ||
            !SliceEquals(pod.ActionContext, AnonymousPrivacyContract.CommentCreateActionContext, payload) ||
            !SliceLengthAtMost(pod.ActionContext, AnonymousPrivacyContract.MaxActionContextBytes) ||
            !SliceLengthAtMost(pod.Scope, AnonymousPrivacyContract.MaxScopeBytes) ||
            !SliceLengthAtMost(pod.VerifyingKeyHash, AnonymousPrivacyContract.MaxVerifyingKeyHashBytes) ||
            !SliceLengthAtMost(pod.NullifierHash, AnonymousPrivacyContract.MaxNullifierHashBytes) ||
            !SliceLengthAtMost(pod.CredentialRoot, AnonymousPrivacyContract.MaxCredentialRootBytes) ||
            !SliceLengthAtMost(pod.RevocationRoot, AnonymousPrivacyContract.MaxRevocationRootBytes) ||
            !SliceLengthAtMost(pod.RateClass, AnonymousPrivacyContract.MaxRateClassBytes) ||
            !SliceLengthAtMost(pod.Groth16Proof, AnonymousPrivacyContract.MaxGroth16ProofBytes) ||
            !SliceLengthAtMost(pod.PublicInputs, AnonymousPrivacyContract.MaxAnonymousTicketPublicInputsBytes))
        {
            request = default;
            return false;
        }

        request = new AnonymousCommentTicketRequestCoreModel(
            pod.ArticleId,
            pod.HasParentId == 1 ? pod.ParentId.ToString() : null,
            pod.HasRootId == 1 ? pod.RootId.ToString() : null,
            pod.HasReplyToCommentId == 1 ? pod.ReplyToCommentId.ToString() : null,
            pod.CircuitNumericId,
            pod.PublicInputLayoutVersion,
            PodProjector.ReadSlice(pod.ActionContext, payload),
            PodProjector.ReadSlice(pod.Scope, payload),
            PodProjector.ReadSlice(pod.CircuitId, payload),
            PodProjector.ReadSlice(pod.VerifyingKeyHash, payload),
            ReadBytes(pod.NullifierHash, payload),
            ReadBytes(pod.CredentialRoot, payload),
            ReadBytes(pod.RevocationRoot, payload),
            pod.IsEligible == 1,
            pod.MayComment == 1,
            PodProjector.ReadSlice(pod.RateClass, payload),
            pod.RequiresModeration == 1,
            ReadBytes(pod.Groth16Proof, payload),
            ReadBytes(pod.PublicInputs, payload));
        return reader.IsConsumed;
    }

    public static void WriteAnonymousCommentTicketResponse(AnonymousCommentTicketResponseCoreModel response, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(512 + (response.Ticket?.Length ?? 0));
        var mutable = new MutableAnonymousCommentTicketResponsePod
        {
            TicketExpiresAtUnixMs = response.TicketExpiresAtUnixMs,
            RequiresModeration = response.RequiresModeration ? (byte)1 : (byte)0,
            Reserved0 = 0,
            Reserved1 = 0,
            RateClass = PodUtf8Codec.AppendSlice(response.RateClass, payload),
            Ticket = AppendBytes(response.Ticket ?? [], payload),
            ModerationSubjectHash = AppendBytes(response.ModerationSubjectHash ?? [], payload)
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
            pod.RateClass,
            pod.Ticket,
            pod.ModerationSubjectHash
        };
        if (!ValidateAnonymousPayload(payload, slices) ||
            pod.RequiresModeration > 1 ||
            !SliceLengthAtMost(pod.RateClass, AnonymousPrivacyContract.MaxRateClassBytes) ||
            !SliceLengthAtMost(pod.Ticket, AnonymousPrivacyContract.MaxOpaqueTicketBytes) ||
            !SliceLengthAtMost(pod.ModerationSubjectHash, AnonymousPrivacyContract.MaxModerationSubjectHashBytes))
        {
            response = default;
            return false;
        }

        response = new AnonymousCommentTicketResponseCoreModel(
            pod.TicketExpiresAtUnixMs,
            PodProjector.ReadSlice(pod.RateClass, payload),
            pod.RequiresModeration == 1,
            ReadBytes(pod.Ticket, payload),
            ReadBytes(pod.ModerationSubjectHash, payload));
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
        if (!ValidateAnonymousPayload(payload, slices) ||
            !SliceLengthAtMost(pod.AnonymousScope, AnonymousPrivacyContract.MaxScopeBytes) ||
            !SliceLengthAtMost(pod.Ticket, AnonymousPrivacyContract.MaxOpaqueTicketBytes))
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
        if (!ValidateAnonymousPayload(payload, slices) ||
            !IsProductionAnonymousLayout(pod.CircuitId, pod.PublicInputLayoutVersion, payload) ||
            !SliceLengthAtMost(pod.VerifyingKeyHash, AnonymousPrivacyContract.MaxVerifyingKeyHashBytes) ||
            !SliceLengthAtMost(pod.CredentialLevel, AnonymousPrivacyContract.MaxCredentialLevelBytes))
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
            ReservedPrivacyClass = 0,
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
            pod.ReservedPrivacyClass != 0 ||
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
            NullCommentFieldIfEmpty(PodProjector.ReadSlice(pod.ScopeLabel, payload)));
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
            CommentItemPod pod = PodProjector.ProjectCommentItem(item.Id, item.CreateTime, item.Author.Mode, item.Author.DisplayName, item.Content, out ReadOnlyMemory<byte> payload);
            writer.WritePod(pod);
            writer.WriteBytes(BuildCommentItemPayload(payload, item.Author, null).Span);
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

            string content = PodProjector.ReadSlice(pod.Content, payloadSpan);
            if (!TryReadCommentItemAuthors(payloadSpan, pod.Content, out var author, out _))
            {
                cursor = default;
                return false;
            }
            DateTime createTime = PodTimeCodec.FromUnixMs(pod.CreateTimeUnixMs);
            data.Add(new CommentQueryCoreModel(pod, pod.Id, content, createTime, author));
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
            UserCommentPod pod = PodProjector.ProjectUserComment(
                item.Id,
                item.ArticleId,
                item.CreateTime,
                item.Content,
                item.ArticleTitle,
                item.RootId,
                item.ModerationStatus,
                item.ModerationStatusLabel,
                item.VisibilityState,
                item.VisibilityReasonCode,
                item.IsPubliclyVisible,
                out ReadOnlyMemory<byte> payload);
            writer.WritePod(pod);
            writer.WriteBytes(BuildCommentItemPayload(payload, item.Author, item.ReplyToAuthor).Span);
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
            string visibilityState = PodUtf8Codec.FromFixed32(pod.VisibilityState);
            string visibilityReasonCode = PodUtf8Codec.FromFixed64(pod.VisibilityReasonCode);
            string moderationStatusLabel = PodUtf8Codec.FromFixed64(pod.ModerationStatusLabel);
            if (!TryReadCommentItemAuthors(payloadSpan, pod.Content, out var author, out var replyToAuthor))
            {
                cursor = default;
                return false;
            }
            data.Add(new UserCommentCoreModel(
                pod,
                pod.Id,
                content,
                createTime,
                pod.ArticleId,
                articleTitle,
                pod.RootId == 0 ? null : pod.RootId,
                author,
                replyToAuthor,
                pod.ModerationStatus,
                moderationStatusLabel,
                visibilityState,
                visibilityReasonCode,
                pod.IsPubliclyVisible == 1));
        }

        cursor = new CoreCursorResult<UserCommentCoreModel>(data, nextCursor == 0 ? null : nextCursor, hasMore == 1);
        return reader.IsConsumed;
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
                item.Author.Mode,
                item.Author.DisplayName,
                item.Content,
                item.ReplyCount,
                item.HasMoreReplies,
                item.RepliesPreview.Count,
                out ReadOnlyMemory<byte> payload));
            writer.WriteBytes(BuildCommentItemPayload(payload, item.Author, null).Span);

            foreach (CommentReplyPreviewItemDto reply in item.RepliesPreview)
            {
                writer.WritePod(PodProjector.ProjectCommentReplyPreviewItem(
                    ParseLong(reply.Id),
                    reply.IsDeleted,
                    reply.CreateTime,
                    reply.Author.Mode,
                    reply.Author.DisplayName,
                    reply.ReplyToAuthor?.DisplayName,
                    reply.Content,
                out ReadOnlyMemory<byte> replyPayload));
                writer.WriteBytes(BuildCommentItemPayload(replyPayload, reply.Author, reply.ReplyToAuthor).Span);
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
                null,
                ParseNullableLong(reply.ReplyToCommentId),
                reply.Depth,
                reply.IsDeleted,
                reply.CreateTime,
                reply.Author.Mode,
                reply.Author.DisplayName,
                reply.ReplyToAuthor?.DisplayName,
                reply.Content,
                out ReadOnlyMemory<byte> payload));
            writer.WriteBytes(BuildCommentItemPayload(payload, reply.Author, reply.ReplyToAuthor).Span);
        }
    }

    public static byte[] EncodeCommentReplyCursor(long rootId, CursorResponse<CommentReplyItemDto> cursor)
        => EncodeToArray(512 + cursor.Data.Count * 320, writer => WriteCommentReplyCursor(rootId, cursor, writer));

    private static long ParseLong(string value) => long.TryParse(value, out long parsed) ? parsed : 0;

    private static long? ParseNullableLong(string? value) => long.TryParse(value, out long parsed) ? parsed : null;

    private static long ParseCursor(string? value) => long.TryParse(value, out long cursor) ? cursor : 0;

    private static ReadOnlyMemory<byte> BuildCommentItemPayload(
        ReadOnlyMemory<byte> contentPayload,
        CommentAuthorViewDto author,
        CommentAuthorViewDto? replyToAuthor)
    {
        var bytes = new ArrayBufferWriter<byte>(contentPayload.Length + 256);
        bytes.Write(contentPayload.Span);
        WriteLengthPrefixedPayload(bytes, EncodeCommentAuthorView(ToCoreCommentAuthorView(author)));
        WriteLengthPrefixedPayload(
            bytes,
            replyToAuthor.HasValue
                ? EncodeCommentAuthorView(ToCoreCommentAuthorView(replyToAuthor.Value))
                : ReadOnlySpan<byte>.Empty);
        return bytes.WrittenMemory;
    }

    private static void WriteLengthPrefixedPayload(IBufferWriter<byte> writer, ReadOnlySpan<byte> payload)
    {
        Span<byte> lengthSpan = writer.GetSpan(sizeof(int));
        BinaryPrimitives.WriteInt32LittleEndian(lengthSpan, payload.Length);
        writer.Advance(sizeof(int));
        writer.Write(payload);
    }

    private static bool TryReadCommentItemAuthors(
        ReadOnlySpan<byte> payload,
        Utf8SliceRef content,
        out CommentAuthorViewDto author,
        out CommentAuthorViewDto? replyToAuthor)
    {
        author = default;
        replyToAuthor = null;
        int offset = content.Offset + content.Length;
        if (offset < 0 ||
            offset > payload.Length ||
            !TryReadLengthPrefixedPayload(payload, ref offset, out ReadOnlySpan<byte> authorPayload) ||
            authorPayload.Length == 0 ||
            !TryDecodeCommentAuthorView(authorPayload.ToArray(), out CommentAuthorViewCoreModel authorCore))
        {
            return false;
        }

        if (!TryReadLengthPrefixedPayload(payload, ref offset, out ReadOnlySpan<byte> replyPayload) ||
            offset != payload.Length)
        {
            return false;
        }

        author = FromCoreCommentAuthorView(authorCore);
        if (replyPayload.Length > 0)
        {
            if (!TryDecodeCommentAuthorView(replyPayload.ToArray(), out CommentAuthorViewCoreModel replyCore))
            {
                return false;
            }

            replyToAuthor = FromCoreCommentAuthorView(replyCore);
        }

        return true;
    }

    private static bool TryReadLengthPrefixedPayload(ReadOnlySpan<byte> payload, ref int offset, out ReadOnlySpan<byte> value)
    {
        value = default;
        if (offset < 0 || offset + sizeof(int) > payload.Length)
        {
            return false;
        }

        int length = BinaryPrimitives.ReadInt32LittleEndian(payload[offset..]);
        offset += sizeof(int);
        if (length < 0 || offset + length > payload.Length)
        {
            return false;
        }

        value = payload.Slice(offset, length);
        offset += length;
        return true;
    }

    private static CommentAuthorViewCoreModel ToCoreCommentAuthorView(CommentAuthorViewDto author)
        => new(
            author.Mode,
            author.DisplayName,
            author.DisplayLanguage,
            author.Badge,
            author.ScopeLabel);

    private static CommentAuthorViewDto FromCoreCommentAuthorView(CommentAuthorViewCoreModel author)
        => new(
            author.Mode,
            author.DisplayName,
            author.DisplayLanguage,
            author.Badge,
            author.ScopeLabel);

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
            ReplyToUserId = 0,
            HasParentId = hasParentId ? (byte)1 : (byte)0,
            HasRootId = hasRootId ? (byte)1 : (byte)0,
            HasReplyToCommentId = hasReplyToCommentId ? (byte)1 : (byte)0,
            HasReplyToUserId = 0,
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
    {
        string normalized = NormalizeCommentToken(mode);
        return normalized switch
        {
            "anonymous" or "legacy_server_visible_pseudonymous" => 1,
            "public" => 3,
            "zk_anonymous" => 4,
            _ => throw new ArgumentOutOfRangeException(nameof(mode), "comment_author_mode_invalid")
        };
    }

    private static bool TryDecodeCommentAuthorMode(byte raw, out string mode)
    {
        mode = raw switch
        {
            0 or 1 => "legacy_server_visible_pseudonymous",
            3 => "public",
            4 => "zk_anonymous",
            _ => string.Empty
        };
        return mode.Length > 0;
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

    private static bool IsProductionAnonymousLayout(
        FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef circuitId,
        ushort publicInputLayoutVersion,
        ReadOnlySpan<byte> payload)
        => publicInputLayoutVersion == AnonymousPrivacyContract.PublicInputLayoutVersion &&
            SliceEquals(circuitId, AnonymousPrivacyContract.CircuitId, payload);

    private static bool SliceEquals(
        FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef slice,
        string expected,
        ReadOnlySpan<byte> payload)
        => string.Equals(PodProjector.ReadSlice(slice, payload), expected, StringComparison.Ordinal);

    private static bool SliceLengthAtMost(
        FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef slice,
        int maxBytes)
        => slice.Length <= maxBytes;

    private static string NormalizeCommentToken(string? value)
        => (value ?? string.Empty).Trim().ToLowerInvariant().Replace('-', '_');

    private static string JoinDisplayLanguages(IReadOnlyList<string>? languages)
        => languages is null ? string.Empty : string.Join('\n', languages);

    private static IReadOnlyList<string> SplitDisplayLanguages(string languages)
        => languages
            .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .ToArray();

    private static string NormalizeZkProdUnavailableReason(string? value)
    {
        string normalized = NormalizeCommentToken(value);
        return normalized.Length <= 64 ? normalized : normalized[..64];
    }

    private static string NormalizePolicySnapshotHash(string? value)
    {
        string normalized = (value ?? string.Empty).Trim().ToLowerInvariant();
        return normalized.Length <= 64 ? normalized : normalized[..64];
    }

    private static string? NullCommentFieldIfEmpty(string value)
        => value.Length == 0 ? null : value;

    private static int NormalizeCommentMaxChars(int value)
        => IsCommentMaxCharsValid(value) ? value : CommentDefaultMaxChars;

    private static int NormalizeCommentMaxUtf8Bytes(int value)
        => IsCommentMaxUtf8BytesValid(value) ? value : CommentDefaultMaxUtf8Bytes;

    private static bool IsCommentMaxCharsValid(int value)
        => value is >= CommentMinMaxChars and <= CommentHardMaxChars;

    private static bool IsCommentMaxUtf8BytesValid(int value)
        => value is >= CommentMinMaxUtf8Bytes and <= CommentHardMaxUtf8Bytes;

    private static void WriteCommentPolicySnapshotPod(ref BinaryPodWriter writer, in MutableCommentPolicySnapshotPod pod)
    {
        writer.WriteByte(pod.AnonymousCommentsEnabled);
        writer.WriteByte(pod.PublicCommentsEnabled);
        writer.WriteByte(pod.ZkAnonymousEnabled);
        writer.WriteByte(pod.DefaultAuthorMode);
        writer.WriteByte(pod.ZkProdEnabled);
        writer.WriteByte(pod.ZkProdNativeVerifierConfigured);
        writer.WriteByte(pod.ZkProdTrustedSetupVerified);
        writer.WriteByte(pod.ZkProdCredentialRequired);
        writer.WriteByte(pod.ZkProdCredentialRootReady);
        writer.WriteInt32(pod.CommentMaxChars);
        writer.WriteInt32(pod.CommentMaxUtf8Bytes);
        writer.WriteSliceRef(pod.SupportedDisplayLanguages);
        writer.WriteSliceRef(pod.SnapshotHash);
        writer.WriteSliceRef(pod.ZkProdUnavailableReason);
    }

    private static bool TryReadCommentPolicySnapshotPod(ref BinaryPodReader reader, out MutableCommentPolicySnapshotPod pod)
    {
        if (!reader.TryReadByte(out byte anonymousCommentsEnabled) ||
            !reader.TryReadByte(out byte publicCommentsEnabled) ||
            !reader.TryReadByte(out byte zkAnonymousEnabled) ||
            !reader.TryReadByte(out byte defaultAuthorMode) ||
            !reader.TryReadByte(out byte zkProdEnabled) ||
            !reader.TryReadByte(out byte zkProdNativeVerifierConfigured) ||
            !reader.TryReadByte(out byte zkProdTrustedSetupVerified) ||
            !reader.TryReadByte(out byte zkProdCredentialRequired) ||
            !reader.TryReadByte(out byte zkProdCredentialRootReady) ||
            !reader.TryReadInt32(out int commentMaxChars) ||
            !reader.TryReadInt32(out int commentMaxUtf8Bytes) ||
            !reader.TryReadSliceRef(out var supportedDisplayLanguages) ||
            !reader.TryReadSliceRef(out var snapshotHash) ||
            !reader.TryReadSliceRef(out var zkProdUnavailableReason))
        {
            pod = default;
            return false;
        }

        pod = new MutableCommentPolicySnapshotPod
        {
            AnonymousCommentsEnabled = anonymousCommentsEnabled,
            PublicCommentsEnabled = publicCommentsEnabled,
            ZkAnonymousEnabled = zkAnonymousEnabled,
            DefaultAuthorMode = defaultAuthorMode,
            ZkProdEnabled = zkProdEnabled,
            ZkProdNativeVerifierConfigured = zkProdNativeVerifierConfigured,
            ZkProdTrustedSetupVerified = zkProdTrustedSetupVerified,
            ZkProdCredentialRequired = zkProdCredentialRequired,
            ZkProdCredentialRootReady = zkProdCredentialRootReady,
            CommentMaxChars = commentMaxChars,
            CommentMaxUtf8Bytes = commentMaxUtf8Bytes,
            SupportedDisplayLanguages = supportedDisplayLanguages,
            SnapshotHash = snapshotHash,
            ZkProdUnavailableReason = zkProdUnavailableReason
        };
        return true;
    }

    private static void WriteCommentPolicyUpdateRequestPod(ref BinaryPodWriter writer, in MutableCommentPolicyUpdateRequestPod pod)
    {
        writer.WriteByte(pod.HasAnonymousCommentsEnabled);
        writer.WriteByte(pod.AnonymousCommentsEnabled);
        writer.WriteByte(pod.HasPublicCommentsEnabled);
        writer.WriteByte(pod.PublicCommentsEnabled);
        writer.WriteByte(pod.HasZkAnonymousEnabled);
        writer.WriteByte(pod.ZkAnonymousEnabled);
        writer.WriteByte(pod.HasDefaultAuthorMode);
        writer.WriteByte(pod.DefaultAuthorMode);
        writer.WriteByte(pod.HasCommentMaxChars);
        writer.WriteByte(pod.HasCommentMaxUtf8Bytes);
        writer.WriteInt32(pod.CommentMaxChars);
        writer.WriteInt32(pod.CommentMaxUtf8Bytes);
        writer.WriteSliceRef(pod.SupportedDisplayLanguages);
    }

    private static bool TryReadCommentPolicyUpdateRequestPod(ref BinaryPodReader reader, out MutableCommentPolicyUpdateRequestPod pod)
    {
        if (!reader.TryReadByte(out byte hasAnonymousCommentsEnabled) ||
            !reader.TryReadByte(out byte anonymousCommentsEnabled) ||
            !reader.TryReadByte(out byte hasPublicCommentsEnabled) ||
            !reader.TryReadByte(out byte publicCommentsEnabled) ||
            !reader.TryReadByte(out byte hasZkAnonymousEnabled) ||
            !reader.TryReadByte(out byte zkAnonymousEnabled) ||
            !reader.TryReadByte(out byte hasDefaultAuthorMode) ||
            !reader.TryReadByte(out byte defaultAuthorMode) ||
            !reader.TryReadByte(out byte hasCommentMaxChars) ||
            !reader.TryReadByte(out byte hasCommentMaxUtf8Bytes) ||
            !reader.TryReadInt32(out int commentMaxChars) ||
            !reader.TryReadInt32(out int commentMaxUtf8Bytes) ||
            !reader.TryReadSliceRef(out var supportedDisplayLanguages))
        {
            pod = default;
            return false;
        }

        pod = new MutableCommentPolicyUpdateRequestPod
        {
            HasAnonymousCommentsEnabled = hasAnonymousCommentsEnabled,
            AnonymousCommentsEnabled = anonymousCommentsEnabled,
            HasPublicCommentsEnabled = hasPublicCommentsEnabled,
            PublicCommentsEnabled = publicCommentsEnabled,
            HasZkAnonymousEnabled = hasZkAnonymousEnabled,
            ZkAnonymousEnabled = zkAnonymousEnabled,
            HasDefaultAuthorMode = hasDefaultAuthorMode,
            DefaultAuthorMode = defaultAuthorMode,
            HasCommentMaxChars = hasCommentMaxChars,
            HasCommentMaxUtf8Bytes = hasCommentMaxUtf8Bytes,
            CommentMaxChars = commentMaxChars,
            CommentMaxUtf8Bytes = commentMaxUtf8Bytes,
            SupportedDisplayLanguages = supportedDisplayLanguages
        };
        return true;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableCommentPolicySnapshotPod
    {
        public byte AnonymousCommentsEnabled;
        public byte PublicCommentsEnabled;
        public byte ZkAnonymousEnabled;
        public byte DefaultAuthorMode;
        public byte ZkProdEnabled;
        public byte ZkProdNativeVerifierConfigured;
        public byte ZkProdTrustedSetupVerified;
        public byte ZkProdCredentialRequired;
        public byte ZkProdCredentialRootReady;
        public int CommentMaxChars;
        public int CommentMaxUtf8Bytes;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef SupportedDisplayLanguages;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef SnapshotHash;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef ZkProdUnavailableReason;
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
        public byte HasCommentMaxChars;
        public byte HasCommentMaxUtf8Bytes;
        public int CommentMaxChars;
        public int CommentMaxUtf8Bytes;
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
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef CredentialRequest;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef ClientNonce;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableAnonymousCredentialIssueResponsePod
    {
        public long CredentialEpoch;
        public long ExpiresAtUnixMs;
        public uint CircuitNumericId;
        public ushort PublicInputLayoutVersion;
        public ushort Reserved0;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef CircuitId;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef CredentialLevel;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef IssuerPublicKeyId;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef IssuerSignature;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableBlindCredentialIssuerMetadataPod
    {
        public long CredentialEpoch;
        public long ExpiresAtUnixMs;
        public uint CircuitNumericId;
        public ushort PublicInputLayoutVersion;
        public ushort ModulusBytes;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef CircuitId;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef CredentialLevel;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef SchemeId;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef IssuerPublicKeyId;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef IssuerPublicKeyHash;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef SubjectPublicKeyInfo;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableBlindCredentialIssueRequestPod
    {
        public long CredentialEpoch;
        public uint CircuitNumericId;
        public ushort PublicInputLayoutVersion;
        public ushort Reserved0;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef CircuitId;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef CredentialLevel;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef SchemeId;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef IssuerPublicKeyId;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef BlindedMessage;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableBlindCredentialIssueResponsePod
    {
        public long CredentialEpoch;
        public long ExpiresAtUnixMs;
        public uint CircuitNumericId;
        public ushort PublicInputLayoutVersion;
        public ushort Reserved0;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef CircuitId;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef CredentialLevel;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef SchemeId;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef IssuerPublicKeyId;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef BlindSignature;
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
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef IssuerPublicKeyHash;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef CredentialRoot;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef RevocationRoot;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef CircuitMetadata;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableAnonymousCredentialRevocationArtifactPod
    {
        public long CredentialEpoch;
        public long Version;
        public long BaseVersion;
        public long ExpiresAtUnixMs;
        public uint EntryCount;
        public ushort PathDepth;
        public byte Kind;
        public byte Reserved0;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef AlgorithmId;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef IssuerPublicKeyHash;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef RevocationRoot;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef ContentHash;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Signature;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef EntryHashes;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableAnonymousCommentTicketRequestPod
    {
        public int ArticleId;
        public byte HasParentId;
        public byte HasRootId;
        public byte HasReplyToCommentId;
        public byte IsEligible;
        public long ParentId;
        public long RootId;
        public long ReplyToCommentId;
        public uint CircuitNumericId;
        public ushort PublicInputLayoutVersion;
        public byte MayComment;
        public byte RequiresModeration;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef ActionContext;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Scope;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef CircuitId;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef VerifyingKeyHash;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef NullifierHash;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef CredentialRoot;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef RevocationRoot;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef RateClass;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Groth16Proof;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef PublicInputs;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableAnonymousCommentTicketResponsePod
    {
        public long TicketExpiresAtUnixMs;
        public byte RequiresModeration;
        public byte Reserved0;
        public ushort Reserved1;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef RateClass;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Ticket;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef ModerationSubjectHash;
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
        public byte ReservedPrivacyClass;
        public ushort Reserved0;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef DisplayName;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef DisplayLanguage;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Badge;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef ScopeLabel;
    }
}
