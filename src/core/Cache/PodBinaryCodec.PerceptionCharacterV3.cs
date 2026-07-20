using System.Buffers;
using System.Runtime.InteropServices;

using FsusBlog.Core.Mapping.Codecs;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Primitives;
using FsusBlog.Shared.Contracts.Security;

namespace FsusBlog.Core.Cache;

public static partial class PodBinaryCodec
{
    public static byte[] EncodePerceptionCharacterV3Issue(PerceptionCharacterV3IssuePayload payload)
        => EncodeToArray(Marshal.SizeOf<PerceptionCharacterV3IssuePod>() + payload.MediaBytes.Length + payload.StateToken.Length + 128,
            writer => WritePerceptionCharacterV3Issue(payload, writer));

    public static void WritePerceptionCharacterV3Issue(PerceptionCharacterV3IssuePayload payload, IBufferWriter<byte> destination)
    {
        SecurityChallengeValidationResult validation = PerceptionCharacterV3Contracts.ValidateIssue(payload);
        if (!validation.IsValid)
            throw new ArgumentException(validation.ErrorCode, nameof(payload));
        var blob = new ArrayBufferWriter<byte>(payload.MediaBytes.Length + payload.StateToken.Length + 128);
        var mutable = new MutableIssuePod
        {
            Representation = (byte)payload.Representation,
            AttemptBudget = payload.AttemptBudget,
            PhysicalWidth = payload.PhysicalWidth,
            PhysicalHeight = payload.PhysicalHeight,
            DisplayWidth = payload.DisplayWidth,
            DisplayHeight = payload.DisplayHeight,
            MediaByteCount = payload.MediaBytes.Length,
            IssuedAtUnixMs = payload.IssuedAtUnixMs,
            ExpiresAtUnixMs = payload.ExpiresAtUnixMs,
            ChallengeId = PodUtf8Codec.ToFixed64(payload.ChallengeId),
            EnvelopeId = PodUtf8Codec.ToFixed64(payload.EnvelopeId),
            PolicyVersion = PodUtf8Codec.ToFixed64(payload.PolicyVersion),
            Algorithm = PodUtf8Codec.AppendSlice(payload.Algorithm, blob),
            MediaType = PodUtf8Codec.AppendSlice(payload.MediaType, blob),
            MediaBytes = AppendBytes(payload.MediaBytes, blob),
            StateToken = PodUtf8Codec.AppendSlice(payload.StateToken, blob)
        };
        var writer = new BinaryPodWriter(destination);
        writer.WritePod(Cast<MutableIssuePod, PerceptionCharacterV3IssuePod>(mutable));
        writer.WriteBytes(blob.WrittenSpan);
    }

    public static bool TryDecodePerceptionCharacterV3Issue(ReadOnlyMemory<byte> source, out PerceptionCharacterV3IssuePayload payload)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out PerceptionCharacterV3IssuePod pod) || !reader.TryReadBytes(out ReadOnlySpan<byte> blob)
            || !TryReadBytes(pod.MediaBytes, blob, out byte[] media) || media.Length != pod.MediaByteCount)
        {
            payload = EmptyIssue();
            return false;
        }
        payload = new PerceptionCharacterV3IssuePayload(
            PodUtf8Codec.ReadSlice(pod.Algorithm, blob), PodUtf8Codec.FromFixed64(pod.ChallengeId), PodUtf8Codec.FromFixed64(pod.EnvelopeId),
            (PerceptionCharacterV3Representation)pod.Representation, PodUtf8Codec.ReadSlice(pod.MediaType, blob), media,
            pod.PhysicalWidth, pod.PhysicalHeight, pod.DisplayWidth, pod.DisplayHeight, pod.AttemptBudget,
            PodUtf8Codec.FromFixed64(pod.PolicyVersion), pod.IssuedAtUnixMs, pod.ExpiresAtUnixMs, PodUtf8Codec.ReadSlice(pod.StateToken, blob));
        return reader.IsConsumed && PerceptionCharacterV3Contracts.ValidateIssue(payload).IsValid;
    }

    public static byte[] EncodePerceptionCharacterV3Verify(PerceptionCharacterV3VerifyPayload payload)
        => EncodeToArray(Marshal.SizeOf<PerceptionCharacterV3VerifyPod>() + payload.Answer.Length + payload.StateToken.Length + 128,
            writer => WritePerceptionCharacterV3Verify(payload, writer));

    public static void WritePerceptionCharacterV3Verify(PerceptionCharacterV3VerifyPayload payload, IBufferWriter<byte> destination)
    {
        SecurityChallengeValidationResult validation = PerceptionCharacterV3Contracts.ValidateVerify(payload);
        if (!validation.IsValid)
            throw new ArgumentException(validation.ErrorCode, nameof(payload));
        var blob = new ArrayBufferWriter<byte>(payload.Answer.Length + payload.StateToken.Length + 128);
        var mutable = new MutableVerifyPod
        {
            Representation = (byte)payload.Representation,
            ChallengeId = PodUtf8Codec.ToFixed64(payload.ChallengeId),
            EnvelopeId = PodUtf8Codec.ToFixed64(payload.EnvelopeId),
            Algorithm = PodUtf8Codec.AppendSlice(payload.Algorithm, blob),
            Answer = PodUtf8Codec.AppendSlice(payload.Answer, blob),
            StateToken = PodUtf8Codec.AppendSlice(payload.StateToken, blob)
        };
        var writer = new BinaryPodWriter(destination);
        writer.WritePod(Cast<MutableVerifyPod, PerceptionCharacterV3VerifyPod>(mutable));
        writer.WriteBytes(blob.WrittenSpan);
    }

    public static bool TryDecodePerceptionCharacterV3Verify(ReadOnlyMemory<byte> source, out PerceptionCharacterV3VerifyPayload payload)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out PerceptionCharacterV3VerifyPod pod) || !reader.TryReadBytes(out ReadOnlySpan<byte> blob))
        {
            payload = EmptyVerify();
            return false;
        }
        payload = new(PodUtf8Codec.ReadSlice(pod.Algorithm, blob), PodUtf8Codec.FromFixed64(pod.ChallengeId),
            PodUtf8Codec.FromFixed64(pod.EnvelopeId), (PerceptionCharacterV3Representation)pod.Representation,
            PodUtf8Codec.ReadSlice(pod.Answer, blob), PodUtf8Codec.ReadSlice(pod.StateToken, blob));
        return reader.IsConsumed && PerceptionCharacterV3Contracts.ValidateVerify(payload).IsValid;
    }

    private static bool TryReadBytes(Utf8SliceRef slice, ReadOnlySpan<byte> blob, out byte[] value)
    {
        if (slice.Offset < 0 || slice.Length < 0 || slice.Offset > blob.Length - slice.Length)
        {
            value = [];
            return false;
        }
        value = blob.Slice(slice.Offset, slice.Length).ToArray();
        return true;
    }

    private static PerceptionCharacterV3IssuePayload EmptyIssue() => new(string.Empty, string.Empty, string.Empty, 0, string.Empty, [], 0, 0, 0, 0, 0, string.Empty, 0, 0, string.Empty);
    private static PerceptionCharacterV3VerifyPayload EmptyVerify() => new(string.Empty, string.Empty, string.Empty, 0, string.Empty, string.Empty);

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableIssuePod
    {
        public byte Representation; public byte AttemptBudget; public ushort PhysicalWidth; public ushort PhysicalHeight; public ushort DisplayWidth; public ushort DisplayHeight; public ushort Reserved;
        public int MediaByteCount; public long IssuedAtUnixMs; public long ExpiresAtUnixMs; public Utf8Fixed64 ChallengeId; public Utf8Fixed64 EnvelopeId; public Utf8Fixed64 PolicyVersion;
        public Utf8SliceRef Algorithm; public Utf8SliceRef MediaType; public Utf8SliceRef MediaBytes; public Utf8SliceRef StateToken;
    }
    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableVerifyPod
    {
        public byte Representation; public byte Reserved0; public ushort Reserved1; public Utf8Fixed64 ChallengeId; public Utf8Fixed64 EnvelopeId; public Utf8SliceRef Algorithm; public Utf8SliceRef Answer; public Utf8SliceRef StateToken;
    }
}
