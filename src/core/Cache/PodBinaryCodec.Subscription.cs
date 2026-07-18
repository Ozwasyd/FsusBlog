using System.Buffers;
using System.Runtime.InteropServices;

using FsusBlog.Core.Mapping.Codecs;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Outputs;
using FsusBlog.Shared.Contracts.Primitives;

namespace FsusBlog.Core.Cache;

/// <summary>
/// Provides binary serialization and decoding operations for subscription contracts.
/// </summary>
public static partial class PodBinaryCodec
{
    /// <summary>
    /// Writes the <c>SiteSubscriptionRequest</c> contract to the supplied binary destination.
    /// </summary>
    public static void WriteSiteSubscriptionRequest(SiteSubscriptionBinaryRequest request, IBufferWriter<byte> destination)
    {
        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CreateSiteSubscriptionRequestPod(request));
    }

    /// <summary>
    /// Encodes the <c>SiteSubscriptionRequest</c> contract into a new binary payload.
    /// </summary>
    public static byte[] EncodeSiteSubscriptionRequest(SiteSubscriptionBinaryRequest request)
        => EncodeToArray(Marshal.SizeOf<SiteSubscriptionRequestPod>(), writer => WriteSiteSubscriptionRequest(request, writer));

    /// <summary>
    /// Attempts to decode the <c>SiteSubscriptionRequest</c> contract from a binary payload.
    /// </summary>
    public static bool TryDecodeSiteSubscriptionRequest(ReadOnlyMemory<byte> source, out SiteSubscriptionBinaryRequest request)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out SiteSubscriptionRequestPod pod) || !reader.IsConsumed)
        {
            request = new SiteSubscriptionBinaryRequest(string.Empty, null);
            return false;
        }

        request = new SiteSubscriptionBinaryRequest(
            PodUtf8Codec.FromFixed256(pod.Email),
            EmptyToNull(PodUtf8Codec.FromFixed32(pod.Channel)));
        return true;
    }

    /// <summary>
    /// Writes the <c>SiteSubscriptionResponse</c> contract to the supplied binary destination.
    /// </summary>
    public static void WriteSiteSubscriptionResponse(SiteSubscriptionBinaryResponse response, IBufferWriter<byte> destination)
    {
        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CreateSiteSubscriptionResponsePod(response));
    }

    /// <summary>
    /// Encodes the <c>SiteSubscriptionResponse</c> contract into a new binary payload.
    /// </summary>
    public static byte[] EncodeSiteSubscriptionResponse(SiteSubscriptionBinaryResponse response)
        => EncodeToArray(Marshal.SizeOf<SiteSubscriptionResponsePod>(), writer => WriteSiteSubscriptionResponse(response, writer));

    /// <summary>
    /// Attempts to decode the <c>SiteSubscriptionResponse</c> contract from a binary payload.
    /// </summary>
    public static bool TryDecodeSiteSubscriptionResponse(ReadOnlyMemory<byte> source, out SiteSubscriptionBinaryResponse response)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out SiteSubscriptionResponsePod pod)
            || !reader.IsConsumed
            || pod.Subscribed > 1
            || pod.Unsubscribed > 1)
        {
            response = new SiteSubscriptionBinaryResponse(false, false, string.Empty);
            return false;
        }

        response = new SiteSubscriptionBinaryResponse(
            pod.Subscribed == 1,
            pod.Unsubscribed == 1,
            PodUtf8Codec.FromFixed32(pod.Channel));
        return true;
    }

    private static SiteSubscriptionRequestPod CreateSiteSubscriptionRequestPod(SiteSubscriptionBinaryRequest request)
    {
        var mutable = new MutableSiteSubscriptionRequestPod
        {
            Email = PodUtf8Codec.ToFixed256(request.Email),
            Channel = PodUtf8Codec.ToFixed32(request.Channel)
        };

        Span<MutableSiteSubscriptionRequestPod> source = stackalloc MutableSiteSubscriptionRequestPod[1];
        source[0] = mutable;
        return MemoryMarshal.Read<SiteSubscriptionRequestPod>(MemoryMarshal.AsBytes(source));
    }

    private static SiteSubscriptionResponsePod CreateSiteSubscriptionResponsePod(SiteSubscriptionBinaryResponse response)
    {
        var mutable = new MutableSiteSubscriptionResponsePod
        {
            Subscribed = response.Subscribed ? (byte)1 : (byte)0,
            Unsubscribed = response.Unsubscribed ? (byte)1 : (byte)0,
            Channel = PodUtf8Codec.ToFixed32(response.Channel)
        };

        Span<MutableSiteSubscriptionResponsePod> source = stackalloc MutableSiteSubscriptionResponsePod[1];
        source[0] = mutable;
        return MemoryMarshal.Read<SiteSubscriptionResponsePod>(MemoryMarshal.AsBytes(source));
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableSiteSubscriptionRequestPod
    {
        public Utf8Fixed256 Email;
        public Utf8Fixed32 Channel;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableSiteSubscriptionResponsePod
    {
        public byte Subscribed;
        public byte Unsubscribed;
        public ushort Reserved0;
        public Utf8Fixed32 Channel;
    }
}
