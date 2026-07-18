using System.Buffers;
using System.Runtime.InteropServices;

using FsusBlog.Core.Mapping.Codecs;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Outputs;
using FsusBlog.Shared.Contracts.Primitives;

namespace FsusBlog.Core.Cache;

public static partial class PodBinaryCodec
{
    public static void WriteHumanReadChallengeRequest(HumanReadChallengeRequest request, IBufferWriter<byte> destination)
    {
        var blob = new ArrayBufferWriter<byte>(Math.Max(64, (request.RouteKey?.Length ?? 0) + (request.Scope?.Length ?? 0)));
        var mutable = new MutableHumanReadChallengeRequestPod
        {
            ArticleId = request.ArticleId.GetValueOrDefault(),
            HasArticleId = request.ArticleId.HasValue ? (byte)1 : (byte)0,
            Scope = PodUtf8Codec.AppendSlice(request.Scope, blob),
            RouteKey = PodUtf8Codec.AppendSlice(request.RouteKey, blob)
        };

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(Cast<MutableHumanReadChallengeRequestPod, HumanReadChallengeRequestPod>(mutable));
        writer.WriteBytes(blob.WrittenSpan);
    }

    public static byte[] EncodeHumanReadChallengeRequest(HumanReadChallengeRequest request)
        => EncodeToArray(64 + (request.RouteKey?.Length ?? 0) + (request.Scope?.Length ?? 0), writer => WriteHumanReadChallengeRequest(request, writer));

    public static bool TryDecodeHumanReadChallengeRequest(ReadOnlyMemory<byte> source, out HumanReadChallengeRequest request)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out HumanReadChallengeRequestPod pod) ||
            pod.HasArticleId > 1 ||
            !reader.TryReadBytes(out ReadOnlySpan<byte> blob))
        {
            request = new HumanReadChallengeRequest(string.Empty, string.Empty, null);
            return false;
        }

        request = new HumanReadChallengeRequest(
            PodUtf8Codec.ReadSlice(pod.Scope, blob),
            PodUtf8Codec.ReadSlice(pod.RouteKey, blob),
            pod.HasArticleId == 1 ? pod.ArticleId : null);
        return reader.IsConsumed;
    }

    public static void WriteHumanReadChallengeResponse(HumanReadChallengeResponse response, IBufferWriter<byte> destination)
    {
        var blob = new ArrayBufferWriter<byte>(Math.Max(128, (response.Token?.Length ?? 0) + (response.Scope?.Length ?? 0) + (response.RouteKey?.Length ?? 0)));
        var mutable = new MutableHumanReadChallengeResponsePod
        {
            ArticleId = response.ArticleId.GetValueOrDefault(),
            MinDwellMs = response.MinDwellMs,
            IssuedAtUnixMs = response.IssuedAt.ToUnixTimeMilliseconds(),
            ExpiresAtUnixMs = response.ExpiresAt.ToUnixTimeMilliseconds(),
            HasArticleId = response.ArticleId.HasValue ? (byte)1 : (byte)0,
            Token = PodUtf8Codec.AppendSlice(response.Token, blob),
            Scope = PodUtf8Codec.AppendSlice(response.Scope, blob),
            RouteKey = PodUtf8Codec.AppendSlice(response.RouteKey, blob)
        };

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(Cast<MutableHumanReadChallengeResponsePod, HumanReadChallengeResponsePod>(mutable));
        writer.WriteBytes(blob.WrittenSpan);
    }

    public static byte[] EncodeHumanReadChallengeResponse(HumanReadChallengeResponse response)
        => EncodeToArray(128 + (response.Token?.Length ?? 0) + (response.RouteKey?.Length ?? 0), writer => WriteHumanReadChallengeResponse(response, writer));

    public static bool TryDecodeHumanReadChallengeResponse(ReadOnlyMemory<byte> source, out HumanReadChallengeResponse response)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out HumanReadChallengeResponsePod pod) ||
            pod.HasArticleId > 1 ||
            !reader.TryReadBytes(out ReadOnlySpan<byte> blob))
        {
            response = new HumanReadChallengeResponse(string.Empty, string.Empty, string.Empty, null, 0, DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch);
            return false;
        }

        response = new HumanReadChallengeResponse(
            PodUtf8Codec.ReadSlice(pod.Token, blob),
            PodUtf8Codec.ReadSlice(pod.Scope, blob),
            PodUtf8Codec.ReadSlice(pod.RouteKey, blob),
            pod.HasArticleId == 1 ? pod.ArticleId : null,
            pod.MinDwellMs,
            DateTimeOffset.FromUnixTimeMilliseconds(pod.IssuedAtUnixMs),
            DateTimeOffset.FromUnixTimeMilliseconds(pod.ExpiresAtUnixMs));
        return reader.IsConsumed;
    }

    public static void WriteHumanReadSubmitRequest(HumanReadSubmitRequest request, IBufferWriter<byte> destination)
    {
        var blob = new ArrayBufferWriter<byte>(Math.Max(128, (request.Token?.Length ?? 0) + (request.Scope?.Length ?? 0) + (request.RouteKey?.Length ?? 0)));
        var mutable = new MutableHumanReadSubmitRequestPod
        {
            ArticleId = request.ArticleId.GetValueOrDefault(),
            DwellMs = request.DwellMs,
            HasArticleId = request.ArticleId.HasValue ? (byte)1 : (byte)0,
            Token = PodUtf8Codec.AppendSlice(request.Token, blob),
            Scope = PodUtf8Codec.AppendSlice(request.Scope, blob),
            RouteKey = PodUtf8Codec.AppendSlice(request.RouteKey, blob)
        };

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(Cast<MutableHumanReadSubmitRequestPod, HumanReadSubmitRequestPod>(mutable));
        writer.WriteBytes(blob.WrittenSpan);
    }

    public static byte[] EncodeHumanReadSubmitRequest(HumanReadSubmitRequest request)
        => EncodeToArray(128 + (request.Token?.Length ?? 0) + (request.RouteKey?.Length ?? 0), writer => WriteHumanReadSubmitRequest(request, writer));

    public static bool TryDecodeHumanReadSubmitRequest(ReadOnlyMemory<byte> source, out HumanReadSubmitRequest request)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out HumanReadSubmitRequestPod pod) ||
            pod.HasArticleId > 1 ||
            !reader.TryReadBytes(out ReadOnlySpan<byte> blob))
        {
            request = new HumanReadSubmitRequest(string.Empty, string.Empty, string.Empty, null, 0);
            return false;
        }

        request = new HumanReadSubmitRequest(
            PodUtf8Codec.ReadSlice(pod.Token, blob),
            PodUtf8Codec.ReadSlice(pod.Scope, blob),
            PodUtf8Codec.ReadSlice(pod.RouteKey, blob),
            pod.HasArticleId == 1 ? pod.ArticleId : null,
            pod.DwellMs);
        return reader.IsConsumed;
    }

    public static void WriteHumanReadSubmitResponse(HumanReadSubmitResponse response, IBufferWriter<byte> destination)
    {
        var blob = new ArrayBufferWriter<byte>(Math.Max(32, response.Status?.Length ?? 0));
        var mutable = new MutableHumanReadSubmitResponsePod
        {
            Counted = response.Counted ? (byte)1 : (byte)0,
            Status = PodUtf8Codec.AppendSlice(response.Status, blob)
        };

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(Cast<MutableHumanReadSubmitResponsePod, HumanReadSubmitResponsePod>(mutable));
        writer.WriteBytes(blob.WrittenSpan);
    }

    public static byte[] EncodeHumanReadSubmitResponse(HumanReadSubmitResponse response)
        => EncodeToArray(32 + (response.Status?.Length ?? 0), writer => WriteHumanReadSubmitResponse(response, writer));

    public static bool TryDecodeHumanReadSubmitResponse(ReadOnlyMemory<byte> source, out HumanReadSubmitResponse response)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out HumanReadSubmitResponsePod pod) ||
            pod.Counted > 1 ||
            !reader.TryReadBytes(out ReadOnlySpan<byte> blob))
        {
            response = new HumanReadSubmitResponse(false, string.Empty);
            return false;
        }

        response = new HumanReadSubmitResponse(
            pod.Counted == 1,
            PodUtf8Codec.ReadSlice(pod.Status, blob));
        return reader.IsConsumed;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableHumanReadChallengeRequestPod
    {
        public int ArticleId;
        public byte HasArticleId;
        public byte Reserved0;
        public ushort Reserved1;
        public Utf8SliceRef Scope;
        public Utf8SliceRef RouteKey;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableHumanReadChallengeResponsePod
    {
        public int ArticleId;
        public int MinDwellMs;
        public long IssuedAtUnixMs;
        public long ExpiresAtUnixMs;
        public byte HasArticleId;
        public byte Reserved0;
        public ushort Reserved1;
        public Utf8SliceRef Token;
        public Utf8SliceRef Scope;
        public Utf8SliceRef RouteKey;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableHumanReadSubmitRequestPod
    {
        public int ArticleId;
        public int DwellMs;
        public byte HasArticleId;
        public byte Reserved0;
        public ushort Reserved1;
        public Utf8SliceRef Token;
        public Utf8SliceRef Scope;
        public Utf8SliceRef RouteKey;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableHumanReadSubmitResponsePod
    {
        public byte Counted;
        public byte Reserved0;
        public ushort Reserved1;
        public Utf8SliceRef Status;
    }
}
