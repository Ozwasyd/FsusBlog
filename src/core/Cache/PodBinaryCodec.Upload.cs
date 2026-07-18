using System.Buffers;
using System.Runtime.InteropServices;

using FsusBlog.Core.Mapping.Codecs;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Core.Cache;

public static partial class PodBinaryCodec
{
    public static void WriteUploadInit(UploadInitDto value, IBufferWriter<byte> target)
    {
        var writer = new BinaryPodWriter(target);
        writer.WritePod(CreateUploadInitPod(value));
    }

    public static void WriteUploadStatus(UploadStatusDto value, IBufferWriter<byte> target)
    {
        var writer = new BinaryPodWriter(target);
        writer.WritePod(CreateUploadStatusPod(value));
    }

    public static void WriteUploadPartMap(UploadPartMapDto value, IBufferWriter<byte> target)
    {
        var writer = new BinaryPodWriter(target);
        writer.WritePod(CreateUploadPartMapPod(value));
        foreach (UploadPartRangeDto range in value.UploadedRanges)
        {
            writer.WritePod(CreateUploadPartRangePod(range));
        }
    }

    public static void WriteUploadPartAck(UploadPartAckDto value, IBufferWriter<byte> target)
    {
        var writer = new BinaryPodWriter(target);
        writer.WritePod(CreateUploadPartAckPod(value));
    }

    public static void WriteUploadComplete(UploadCompleteDto value, IBufferWriter<byte> target)
    {
        var writer = new BinaryPodWriter(target);
        writer.WritePod(CreateUploadCompletePod(value));
    }

    public static void WritePowChallenge(PowChallenge value, IBufferWriter<byte> target)
    {
        var writer = new BinaryPodWriter(target);
        writer.WritePod(CreatePowChallengePod(value));
    }

    public static void WriteUploadInitRequest(UploadInitRequestCoreModel value, IBufferWriter<byte> target)
    {
        var writer = new BinaryPodWriter(target);
        writer.WritePod(CreateUploadInitRequestPod(value));
    }

    public static void WriteUploadCompleteRequest(UploadCompleteRequestCoreModel value, IBufferWriter<byte> target)
    {
        var writer = new BinaryPodWriter(target);
        writer.WritePod(CreateUploadCompleteRequestPod(value));
    }

    public static byte[] EncodeUploadInit(UploadInitDto value)
        => EncodeToArray(Marshal.SizeOf<UploadInitPod>(), writer => WriteUploadInit(value, writer));

    public static byte[] EncodeUploadStatus(UploadStatusDto value)
        => EncodeToArray(Marshal.SizeOf<UploadStatusPod>(), writer => WriteUploadStatus(value, writer));

    public static byte[] EncodeUploadPartMap(UploadPartMapDto value)
        => EncodeToArray(Marshal.SizeOf<UploadPartMapPod>() + value.UploadedRanges.Count * Marshal.SizeOf<UploadPartRangePod>(), writer => WriteUploadPartMap(value, writer));

    public static byte[] EncodeUploadPartAck(UploadPartAckDto value)
        => EncodeToArray(Marshal.SizeOf<UploadPartAckPod>(), writer => WriteUploadPartAck(value, writer));

    public static byte[] EncodeUploadComplete(UploadCompleteDto value)
        => EncodeToArray(Marshal.SizeOf<UploadCompletePod>(), writer => WriteUploadComplete(value, writer));

    public static byte[] EncodePowChallenge(PowChallenge value)
        => EncodeToArray(Marshal.SizeOf<PowChallengePod>(), writer => WritePowChallenge(value, writer));

    public static byte[] EncodeUploadInitRequest(UploadInitRequestCoreModel value)
        => EncodeToArray(Marshal.SizeOf<UploadInitRequestPod>(), writer => WriteUploadInitRequest(value, writer));

    public static byte[] EncodeUploadCompleteRequest(UploadCompleteRequestCoreModel value)
        => EncodeToArray(Marshal.SizeOf<UploadCompleteRequestPod>(), writer => WriteUploadCompleteRequest(value, writer));

    public static bool TryDecodeUploadInit(ReadOnlyMemory<byte> source, out UploadInitDto value)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out UploadInitPod pod) || !reader.IsConsumed)
        {
            value = new UploadInitDto();
            return false;
        }

        value = new UploadInitDto
        {
            UploadId = PodUtf8Codec.FromFixed64(pod.UploadId),
            FileName = PodUtf8Codec.FromFixed256(pod.FileName),
            MimeType = PodUtf8Codec.FromFixed64(pod.MimeType),
            TargetFormat = PodUtf8Codec.FromFixed32(pod.TargetFormat),
            TotalBytes = pod.TotalBytes,
            ChunkSize = pod.ChunkSize,
            TotalParts = pod.TotalParts,
            ExpiresAt = FromUnixMs(pod.ExpiresAtUnixMs),
            UploadToken = PodUtf8Codec.FromFixed128(pod.UploadToken)
        };
        return true;
    }

    public static bool TryDecodeUploadStatus(ReadOnlyMemory<byte> source, out UploadStatusDto value)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out UploadStatusPod pod) || !reader.IsConsumed)
        {
            value = new UploadStatusDto();
            return false;
        }

        value = new UploadStatusDto
        {
            UploadId = PodUtf8Codec.FromFixed64(pod.UploadId),
            Status = PodUtf8Codec.FromFixed32(pod.Status),
            TotalBytes = pod.TotalBytes,
            UploadedBytes = pod.UploadedBytes,
            ChunkSize = pod.ChunkSize,
            TotalParts = pod.TotalParts,
            UploadedPartCount = pod.UploadedPartCount,
            NextPartHint = pod.NextPartHint,
            ExpiresAt = FromUnixMs(pod.ExpiresAtUnixMs)
        };
        return true;
    }

    public static bool TryDecodeUploadPartMap(ReadOnlyMemory<byte> source, out UploadPartMapDto value)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out UploadPartMapPod pod) || pod.Count < 0)
        {
            value = new UploadPartMapDto();
            return false;
        }

        var ranges = new List<UploadPartRangeDto>(pod.Count);
        for (int i = 0; i < pod.Count; i++)
        {
            if (!reader.TryReadPod(out UploadPartRangePod range))
            {
                value = new UploadPartMapDto();
                return false;
            }

            ranges.Add(new UploadPartRangeDto(range.Start, range.End));
        }

        if (!reader.IsConsumed)
        {
            value = new UploadPartMapDto();
            return false;
        }

        value = new UploadPartMapDto
        {
            UploadId = PodUtf8Codec.FromFixed64(pod.UploadId),
            UploadedRanges = ranges
        };
        return true;
    }

    public static bool TryDecodeUploadPartAck(ReadOnlyMemory<byte> source, out UploadPartAckDto value)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out UploadPartAckPod pod) || !reader.IsConsumed)
        {
            value = new UploadPartAckDto();
            return false;
        }

        value = new UploadPartAckDto
        {
            UploadId = PodUtf8Codec.FromFixed64(pod.UploadId),
            PartNumber = pod.PartNumber,
            Offset = pod.Offset,
            Size = pod.Size,
            UploadedBytes = pod.UploadedBytes,
            UploadedPartCount = pod.UploadedPartCount
        };
        return true;
    }

    public static bool TryDecodeUploadComplete(ReadOnlyMemory<byte> source, out UploadCompleteDto value)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out UploadCompletePod pod) || !reader.IsConsumed)
        {
            value = new UploadCompleteDto();
            return false;
        }

        value = new UploadCompleteDto
        {
            UploadId = PodUtf8Codec.FromFixed64(pod.UploadId),
            Url = PodUtf8Codec.FromFixed256(pod.Url),
            RelativeUrl = PodUtf8Codec.FromFixed256(pod.RelativeUrl),
            MimeType = PodUtf8Codec.FromFixed64(pod.MimeType),
            TotalBytes = pod.TotalBytes
        };
        return true;
    }

    public static bool TryDecodePowChallenge(ReadOnlyMemory<byte> source, out PowChallenge value)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out PowChallengePod pod) || !reader.IsConsumed)
        {
            value = default;
            return false;
        }

        value = new PowChallenge(
            PodUtf8Codec.FromFixed64(pod.Salt),
            pod.Difficulty,
            pod.Timestamp,
            PodUtf8Codec.FromFixed128(pod.Signature));
        return true;
    }

    public static bool TryDecodeUploadInitRequest(ReadOnlyMemory<byte> source, out UploadInitRequestCoreModel value)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out UploadInitRequestPod pod) || !reader.IsConsumed)
        {
            value = default;
            return false;
        }

        value = new UploadInitRequestCoreModel(
            PodUtf8Codec.FromFixed256(pod.FileName),
            PodUtf8Codec.FromFixed64(pod.MimeType),
            PodUtf8Codec.FromFixed32(pod.TargetFormat),
            pod.TotalBytes,
            pod.ChunkSize,
            EmptyToNull(PodUtf8Codec.FromFixed64(pod.Sha256)));
        return true;
    }

    public static bool TryDecodeUploadCompleteRequest(ReadOnlyMemory<byte> source, out UploadCompleteRequestCoreModel value)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out UploadCompleteRequestPod pod) || !reader.IsConsumed)
        {
            value = default;
            return false;
        }

        value = new UploadCompleteRequestCoreModel(EmptyToNull(PodUtf8Codec.FromFixed64(pod.Sha256)));
        return true;
    }

    private static UploadInitPod CreateUploadInitPod(UploadInitDto value)
    {
        var mutable = new MutableUploadInitPod
        {
            UploadId = PodUtf8Codec.ToFixed64(value.UploadId),
            FileName = PodUtf8Codec.ToFixed256(value.FileName),
            MimeType = PodUtf8Codec.ToFixed64(value.MimeType),
            TargetFormat = PodUtf8Codec.ToFixed32(value.TargetFormat),
            TotalBytes = value.TotalBytes,
            ChunkSize = value.ChunkSize,
            TotalParts = value.TotalParts,
            ExpiresAtUnixMs = ToUnixMs(value.ExpiresAt),
            UploadToken = PodUtf8Codec.ToFixed128(value.UploadToken)
        };
        return Cast<MutableUploadInitPod, UploadInitPod>(mutable);
    }

    private static UploadStatusPod CreateUploadStatusPod(UploadStatusDto value)
    {
        var mutable = new MutableUploadStatusPod
        {
            UploadId = PodUtf8Codec.ToFixed64(value.UploadId),
            Status = PodUtf8Codec.ToFixed32(value.Status),
            TotalBytes = value.TotalBytes,
            UploadedBytes = value.UploadedBytes,
            ChunkSize = value.ChunkSize,
            TotalParts = value.TotalParts,
            UploadedPartCount = value.UploadedPartCount,
            NextPartHint = value.NextPartHint,
            ExpiresAtUnixMs = ToUnixMs(value.ExpiresAt)
        };
        return Cast<MutableUploadStatusPod, UploadStatusPod>(mutable);
    }

    private static UploadPartMapPod CreateUploadPartMapPod(UploadPartMapDto value)
    {
        var mutable = new MutableUploadPartMapPod
        {
            UploadId = PodUtf8Codec.ToFixed64(value.UploadId),
            Count = value.UploadedRanges.Count
        };
        return Cast<MutableUploadPartMapPod, UploadPartMapPod>(mutable);
    }

    private static UploadPartRangePod CreateUploadPartRangePod(UploadPartRangeDto value)
    {
        var mutable = new MutableUploadPartRangePod { Start = value.Start, End = value.End };
        return Cast<MutableUploadPartRangePod, UploadPartRangePod>(mutable);
    }

    private static UploadPartAckPod CreateUploadPartAckPod(UploadPartAckDto value)
    {
        var mutable = new MutableUploadPartAckPod
        {
            UploadId = PodUtf8Codec.ToFixed64(value.UploadId),
            PartNumber = value.PartNumber,
            Offset = value.Offset,
            Size = value.Size,
            UploadedBytes = value.UploadedBytes,
            UploadedPartCount = value.UploadedPartCount
        };
        return Cast<MutableUploadPartAckPod, UploadPartAckPod>(mutable);
    }

    private static UploadCompletePod CreateUploadCompletePod(UploadCompleteDto value)
    {
        var mutable = new MutableUploadCompletePod
        {
            UploadId = PodUtf8Codec.ToFixed64(value.UploadId),
            Url = PodUtf8Codec.ToFixed256(value.Url),
            RelativeUrl = PodUtf8Codec.ToFixed256(value.RelativeUrl),
            MimeType = PodUtf8Codec.ToFixed64(value.MimeType),
            TotalBytes = value.TotalBytes
        };
        return Cast<MutableUploadCompletePod, UploadCompletePod>(mutable);
    }

    private static PowChallengePod CreatePowChallengePod(PowChallenge value)
    {
        var mutable = new MutablePowChallengePod
        {
            Salt = PodUtf8Codec.ToFixed64(value.Salt),
            Difficulty = value.Difficulty,
            Timestamp = value.Timestamp,
            Signature = PodUtf8Codec.ToFixed128(value.Signature)
        };
        return Cast<MutablePowChallengePod, PowChallengePod>(mutable);
    }

    private static UploadInitRequestPod CreateUploadInitRequestPod(UploadInitRequestCoreModel value)
    {
        var mutable = new MutableUploadInitRequestPod
        {
            FileName = PodUtf8Codec.ToFixed256(value.FileName),
            MimeType = PodUtf8Codec.ToFixed64(value.MimeType),
            TargetFormat = PodUtf8Codec.ToFixed32(value.TargetFormat),
            TotalBytes = value.TotalBytes,
            ChunkSize = value.ChunkSize,
            Sha256 = PodUtf8Codec.ToFixed64(value.Sha256)
        };
        return Cast<MutableUploadInitRequestPod, UploadInitRequestPod>(mutable);
    }

    private static UploadCompleteRequestPod CreateUploadCompleteRequestPod(UploadCompleteRequestCoreModel value)
    {
        var mutable = new MutableUploadCompleteRequestPod
        {
            Sha256 = PodUtf8Codec.ToFixed64(value.Sha256)
        };
        return Cast<MutableUploadCompleteRequestPod, UploadCompleteRequestPod>(mutable);
    }

    private static long ToUnixMs(DateTime value)
        => new DateTimeOffset(value.Kind == DateTimeKind.Unspecified ? DateTime.SpecifyKind(value, DateTimeKind.Utc) : value).ToUnixTimeMilliseconds();

    private static DateTime FromUnixMs(long value)
        => DateTimeOffset.FromUnixTimeMilliseconds(value).UtcDateTime;

    private static TOut Cast<TIn, TOut>(TIn value)
        where TIn : unmanaged
        where TOut : unmanaged
    {
        Span<TIn> source = stackalloc TIn[1];
        source[0] = value;
        return MemoryMarshal.Read<TOut>(MemoryMarshal.AsBytes(source));
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableUploadInitPod
    {
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed64 UploadId;
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed256 FileName;
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed64 MimeType;
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed32 TargetFormat;
        public long TotalBytes;
        public int ChunkSize;
        public int TotalParts;
        public long ExpiresAtUnixMs;
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed128 UploadToken;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableUploadStatusPod
    {
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed64 UploadId;
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed32 Status;
        public long TotalBytes;
        public long UploadedBytes;
        public int ChunkSize;
        public int TotalParts;
        public int UploadedPartCount;
        public int NextPartHint;
        public long ExpiresAtUnixMs;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableUploadPartMapPod
    {
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed64 UploadId;
        public int Count;
        public int Reserved0;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableUploadPartRangePod
    {
        public int Start;
        public int End;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableUploadPartAckPod
    {
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed64 UploadId;
        public int PartNumber;
        public long Offset;
        public int Size;
        public long UploadedBytes;
        public int UploadedPartCount;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableUploadCompletePod
    {
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed64 UploadId;
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed256 Url;
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed256 RelativeUrl;
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed64 MimeType;
        public long TotalBytes;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutablePowChallengePod
    {
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed64 Salt;
        public int Difficulty;
        public long Timestamp;
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed128 Signature;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableUploadInitRequestPod
    {
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed256 FileName;
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed64 MimeType;
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed32 TargetFormat;
        public long TotalBytes;
        public int ChunkSize;
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed64 Sha256;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableUploadCompleteRequestPod
    {
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed64 Sha256;
    }
}
