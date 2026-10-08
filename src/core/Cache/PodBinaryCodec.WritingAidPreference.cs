using System.Buffers;
using System.Buffers.Binary;
using System.Runtime.InteropServices;
using System.Text;

using FsusBlog.Core.Mapping.Codecs;
using FsusBlog.Shared.Contracts.AuthoringPreferences;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Primitives;

namespace FsusBlog.Core.Cache;

/// <summary>Writing aid payload support within the existing codec. Frame registration and HTTP remain separate.</summary>
public static partial class PodBinaryCodec
{
    private const int WritingAidMaximumScopeBytes = 512;

    /// <summary>Writes a validated observation payload without allocating a frame or establishing authority.</summary>
    public static void WriteWritingAidPreferenceSnapshot(
        WritingAidPreferenceSnapshot snapshot,
        IBufferWriter<byte> destination)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        ArgumentNullException.ThrowIfNull(destination);
        if (WritingAidPreferenceValidator.ValidateSnapshot(snapshot, snapshot.Owner) != WritingAidPreferenceValidation.Valid)
        {
            throw new ArgumentException("Invalid writing aid preference snapshot.", nameof(snapshot));
        }
        var payload = new ArrayBufferWriter<byte>();
        var mutable = new MutableWritingAidPreferenceSnapshotPod
        {
            SchemaVersion = snapshot.Values.SchemaVersion,
            FocusEnabled = snapshot.Values.FocusEnabled ? (byte)1 : (byte)0,
            TypewriterEnabled = snapshot.Values.TypewriterEnabled ? (byte)1 : (byte)0,
            ImmersiveEnabled = snapshot.Values.ImmersiveEnabled ? (byte)1 : (byte)0,
            Reserved0 = 0,
            Revision = snapshot.Revision,
            UserScope = PodUtf8Codec.AppendSlice(snapshot.Owner.UserScope, payload),
            SiteScope = PodUtf8Codec.AppendSlice(snapshot.Owner.SiteScope, payload),
            ContentDigest = EncodeFixedUtf8<Utf8Fixed64>(snapshot.ContentDigest)
        };
        if (payload.WrittenCount > WritingAidMaximumScopeBytes)
        {
            throw new ArgumentException("Writing aid preference scope exceeds its payload bound.", nameof(snapshot));
        }
        var writer = new BinaryPodWriter(destination);
        writer.WritePod(mutable);
        writer.WriteBytes(payload.WrittenSpan);
    }

    /// <summary>Rejects malformed, trailing or cross-owner payloads before exposing an observation.</summary>
    public static bool TryDecodeWritingAidPreferenceSnapshot(
        ReadOnlyMemory<byte> source,
        WritingAidPreferenceOwner expectedOwner,
        out WritingAidPreferenceSnapshot? snapshot)
    {
        snapshot = null;
        int fixedSize = Marshal.SizeOf<WritingAidPreferenceSnapshotPod>();
        if (!WritingAidPreferenceValidator.IsValidOwner(expectedOwner)
            || source.Length < fixedSize + sizeof(int)
            || source.Length > fixedSize + sizeof(int) + WritingAidMaximumScopeBytes)
        {
            return false;
        }
        int length = BinaryPrimitives.ReadInt32LittleEndian(source.Span.Slice(fixedSize, sizeof(int)));
        // Bound the length before invoking the common reader; hostile arithmetic cannot reach slicing.
        if (length is < 1 or > WritingAidMaximumScopeBytes || source.Length != fixedSize + sizeof(int) + length)
        {
            return false;
        }
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out WritingAidPreferenceSnapshotPod pod)
            || pod.SchemaVersion != WritingAidPreferenceContract.SchemaVersion
            || pod.FocusEnabled > 1 || pod.TypewriterEnabled > 1 || pod.ImmersiveEnabled > 1 || pod.Reserved0 != 0
            || !reader.TryReadBytes(out ReadOnlySpan<byte> payload) || !reader.IsConsumed
            || pod.UserScope.Offset != 0 || pod.UserScope.Length < 1 || pod.UserScope.Length >= payload.Length
            || pod.SiteScope.Offset != pod.UserScope.Length || pod.SiteScope.Length != payload.Length - pod.UserScope.Length)
        {
            return false;
        }
        try
        {
            var owner = new WritingAidPreferenceOwner(
                PodUtf8Codec.ReadSlice(pod.UserScope, payload), PodUtf8Codec.ReadSlice(pod.SiteScope, payload));
            var candidate = new WritingAidPreferenceSnapshot(owner, pod.Revision,
                new(pod.SchemaVersion, pod.FocusEnabled == 1, pod.TypewriterEnabled == 1, pod.ImmersiveEnabled == 1),
                PodUtf8Codec.FromFixed64(pod.ContentDigest));
            if (WritingAidPreferenceValidator.ValidateSnapshot(candidate, expectedOwner) != WritingAidPreferenceValidation.Valid)
            {
                return false;
            }
            snapshot = candidate;
            return true;
        }
        catch (DecoderFallbackException)
        {
            return false;
        }
    }

    /// <summary>Writes the closed CAS command; authenticated owner and device remain server context.</summary>
    public static void WriteWritingAidPreferenceUpdateRequest(
        WritingAidPreferenceUpdate request,
        IBufferWriter<byte> destination)
    {
        ArgumentNullException.ThrowIfNull(destination);
        if (WritingAidPreferenceValidator.ValidateUpdate(request) != WritingAidPreferenceValidation.Valid)
        {
            throw new ArgumentException("Invalid writing aid preference command.", nameof(request));
        }
        var mutable = new MutableWritingAidPreferenceUpdateRequestPod
        {
            ExpectedRevision = request.ExpectedRevision,
            SchemaVersion = request.Values.SchemaVersion,
            FocusEnabled = request.Values.FocusEnabled ? (byte)1 : (byte)0,
            TypewriterEnabled = request.Values.TypewriterEnabled ? (byte)1 : (byte)0,
            ImmersiveEnabled = request.Values.ImmersiveEnabled ? (byte)1 : (byte)0,
            Reserved0 = 0,
            OperationId = EncodeFixedUtf8<Utf8Fixed64>(request.OperationId.ToString("D"))
        };
        var writer = new BinaryPodWriter(destination);
        writer.WritePod(mutable);
    }

    /// <summary>Admits only exact revision, schema, boolean and canonical operation-identity bytes.</summary>
    public static bool TryDecodeWritingAidPreferenceUpdateRequest(
        ReadOnlyMemory<byte> source,
        out WritingAidPreferenceUpdate? request)
    {
        request = null;
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out WritingAidPreferenceUpdateRequestPod pod) || !reader.IsConsumed
            || pod.SchemaVersion != WritingAidPreferenceContract.SchemaVersion
            || pod.FocusEnabled > 1 || pod.TypewriterEnabled > 1 || pod.ImmersiveEnabled > 1 || pod.Reserved0 != 0)
        {
            return false;
        }
        int identityOffset = Marshal.OffsetOf<WritingAidPreferenceUpdateRequestPod>(nameof(WritingAidPreferenceUpdateRequestPod.OperationId)).ToInt32();
        ReadOnlySpan<byte> identityBytes = source.Span.Slice(identityOffset, 64);
        if (identityBytes[36..].IndexOfAnyExcept((byte)0) >= 0
            || identityBytes[..36].IndexOfAnyExcept("0123456789abcdef-"u8) >= 0)
        {
            return false;
        }
        string identity = PodUtf8Codec.FromFixed64(pod.OperationId);
        if (!Guid.TryParseExact(identity, "D", out Guid operationId) || identity != operationId.ToString("D"))
        {
            return false;
        }
        var candidate = new WritingAidPreferenceUpdate(pod.ExpectedRevision, operationId,
            new(pod.SchemaVersion, pod.FocusEnabled == 1, pod.TypewriterEnabled == 1, pod.ImmersiveEnabled == 1));
        if (WritingAidPreferenceValidator.ValidateUpdate(candidate) != WritingAidPreferenceValidation.Valid)
        {
            return false;
        }
        request = candidate;
        return true;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableWritingAidPreferenceSnapshotPod
    {
        public int SchemaVersion;
        public byte FocusEnabled;
        public byte TypewriterEnabled;
        public byte ImmersiveEnabled;
        public byte Reserved0;
        public long Revision;
        public Utf8SliceRef UserScope;
        public Utf8SliceRef SiteScope;
        public Utf8Fixed64 ContentDigest;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableWritingAidPreferenceUpdateRequestPod
    {
        public long ExpectedRevision;
        public int SchemaVersion;
        public byte FocusEnabled;
        public byte TypewriterEnabled;
        public byte ImmersiveEnabled;
        public byte Reserved0;
        public Utf8Fixed64 OperationId;
    }
}
