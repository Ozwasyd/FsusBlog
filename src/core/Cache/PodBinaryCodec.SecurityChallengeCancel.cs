using System.Buffers;
using System.Runtime.InteropServices;

using FsusBlog.Core.Mapping.Codecs;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Primitives;
using FsusBlog.Shared.Contracts.Security;

namespace FsusBlog.Core.Cache;

/// <summary>
/// Provides binary serialization and decoding operations for security challenge cancellation pods.
/// </summary>
public static partial class PodBinaryCodec
{
    /// <summary>
    /// Writes an aggregate challenge envelope cancellation request.
    /// </summary>
    public static void WriteSecurityChallengeCancelRequest(
        SecurityChallengeCancelBinaryRequest request,
        IBufferWriter<byte> destination)
    {
        ArgumentNullException.ThrowIfNull(request);
        var blob = new ArrayBufferWriter<byte>(Math.Max(
            128,
            request.EnvelopeId.Length
            + request.Action.Length
            + request.RouteKey.Length
            + request.DeviceFingerprint.Length
            + request.PolicyVersion.Length));
        var mutable = new MutableSecurityChallengeCancelRequestPod
        {
            EnvelopeId = PodUtf8Codec.AppendSlice(request.EnvelopeId, blob),
            Action = PodUtf8Codec.AppendSlice(request.Action, blob),
            RouteKey = PodUtf8Codec.AppendSlice(request.RouteKey, blob),
            DeviceFingerprint = PodUtf8Codec.AppendSlice(request.DeviceFingerprint, blob),
            PolicyVersion = PodUtf8Codec.AppendSlice(request.PolicyVersion, blob)
        };

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(Cast<MutableSecurityChallengeCancelRequestPod, SecurityChallengeCancelRequestPod>(mutable));
        writer.WriteBytes(blob.WrittenSpan);
    }

    /// <summary>
    /// Encodes an aggregate challenge envelope cancellation request.
    /// </summary>
    public static byte[] EncodeSecurityChallengeCancelRequest(SecurityChallengeCancelBinaryRequest request)
        => EncodeToArray(
            Marshal.SizeOf<SecurityChallengeCancelRequestPod>()
            + request.EnvelopeId.Length
            + request.Action.Length
            + request.RouteKey.Length
            + request.DeviceFingerprint.Length
            + request.PolicyVersion.Length,
            writer => WriteSecurityChallengeCancelRequest(request, writer));

    /// <summary>
    /// Attempts to decode an aggregate challenge envelope cancellation request.
    /// </summary>
    public static bool TryDecodeSecurityChallengeCancelRequest(
        ReadOnlyMemory<byte> source,
        out SecurityChallengeCancelBinaryRequest request)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out SecurityChallengeCancelRequestPod pod)
            || !reader.TryReadBytes(out ReadOnlySpan<byte> blob))
        {
            request = EmptySecurityChallengeCancelRequest();
            return false;
        }

        request = new SecurityChallengeCancelBinaryRequest(
            PodUtf8Codec.ReadSlice(pod.EnvelopeId, blob),
            PodUtf8Codec.ReadSlice(pod.Action, blob),
            PodUtf8Codec.ReadSlice(pod.RouteKey, blob),
            PodUtf8Codec.ReadSlice(pod.DeviceFingerprint, blob),
            PodUtf8Codec.ReadSlice(pod.PolicyVersion, blob));
        return reader.IsConsumed;
    }

    private static SecurityChallengeCancelBinaryRequest EmptySecurityChallengeCancelRequest()
        => new(string.Empty, string.Empty, string.Empty, string.Empty, string.Empty);

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableSecurityChallengeCancelRequestPod
    {
        public Utf8SliceRef EnvelopeId;
        public Utf8SliceRef Action;
        public Utf8SliceRef RouteKey;
        public Utf8SliceRef DeviceFingerprint;
        public Utf8SliceRef PolicyVersion;
    }
}
