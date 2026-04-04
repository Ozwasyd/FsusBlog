using System.Buffers.Binary;
using FsusBlog.Core.Common;

namespace FsusBlog.Core.Algorithms;

public sealed class AedsEncoder : IAedsEncoder
{
    public const uint Magic = 0x53444541; // "AEDS" in little-endian bytes

    public byte[] Encode(AedsFrameType frameType, ReadOnlySpan<byte> payload, ushort version = 1, uint flags = 0)
    {
        int totalLength = AedsFrameHeader.Size + payload.Length;
        var frame = new byte[totalLength];
        Span<byte> header = frame.AsSpan(0, AedsFrameHeader.Size);

        BinaryPrimitives.WriteUInt32LittleEndian(header[0..4], Magic);
        BinaryPrimitives.WriteUInt16LittleEndian(header[4..6], version);
        BinaryPrimitives.WriteUInt16LittleEndian(header[6..8], (ushort)frameType);
        BinaryPrimitives.WriteUInt32LittleEndian(header[8..12], flags);
        BinaryPrimitives.WriteUInt32LittleEndian(header[12..16], (uint)payload.Length);
        BinaryPrimitives.WriteUInt32LittleEndian(header[16..20], 0u);

        uint payloadCrc32 = Crc32.Compute(payload);
        BinaryPrimitives.WriteUInt32LittleEndian(header[20..24], payloadCrc32);

        uint headerCrc32 = Crc32.Compute(header);
        BinaryPrimitives.WriteUInt32LittleEndian(header[16..20], headerCrc32);

        payload.CopyTo(frame.AsSpan(AedsFrameHeader.Size));
        return frame;
    }

    public Result<AedsDecodeResult> TryDecode(ReadOnlySpan<byte> frame)
    {
        if (frame.Length < AedsFrameHeader.Size)
        {
            return Result<AedsDecodeResult>.Failure(ErrorCode.Validation, "AEDS frame too short");
        }

        ReadOnlySpan<byte> header = frame[..AedsFrameHeader.Size];
        uint magic = BinaryPrimitives.ReadUInt32LittleEndian(header[0..4]);
        if (magic != Magic)
        {
            return Result<AedsDecodeResult>.Failure(ErrorCode.Validation, "AEDS magic mismatch");
        }

        ushort version = BinaryPrimitives.ReadUInt16LittleEndian(header[4..6]);
        ushort frameTypeRaw = BinaryPrimitives.ReadUInt16LittleEndian(header[6..8]);
        uint flags = BinaryPrimitives.ReadUInt32LittleEndian(header[8..12]);
        uint payloadLength = BinaryPrimitives.ReadUInt32LittleEndian(header[12..16]);
        uint headerCrc32 = BinaryPrimitives.ReadUInt32LittleEndian(header[16..20]);
        uint payloadCrc32 = BinaryPrimitives.ReadUInt32LittleEndian(header[20..24]);

        if (!Enum.IsDefined(typeof(AedsFrameType), frameTypeRaw))
        {
            return Result<AedsDecodeResult>.Failure(ErrorCode.Validation, "AEDS frame type unsupported");
        }

        if (payloadLength != (uint)(frame.Length - AedsFrameHeader.Size))
        {
            return Result<AedsDecodeResult>.Failure(ErrorCode.Validation, "AEDS payload length mismatch");
        }

        Span<byte> headerCopy = stackalloc byte[AedsFrameHeader.Size];
        header.CopyTo(headerCopy);
        BinaryPrimitives.WriteUInt32LittleEndian(headerCopy[16..20], 0u);
        uint computedHeaderCrc = Crc32.Compute(headerCopy);
        if (computedHeaderCrc != headerCrc32)
        {
            return Result<AedsDecodeResult>.Failure(ErrorCode.Validation, "AEDS header crc mismatch");
        }

        ReadOnlySpan<byte> payloadSpan = frame[AedsFrameHeader.Size..];
        uint computedPayloadCrc = Crc32.Compute(payloadSpan);
        if (computedPayloadCrc != payloadCrc32)
        {
            return Result<AedsDecodeResult>.Failure(ErrorCode.Validation, "AEDS payload crc mismatch");
        }

        var payload = payloadSpan.ToArray();
        var typedFrame = (AedsFrameType)frameTypeRaw;
        var headerModel = new AedsFrameHeader(magic, version, frameTypeRaw, flags, payloadLength, headerCrc32, payloadCrc32);
        return Result<AedsDecodeResult>.Success(new AedsDecodeResult(headerModel, payload, typedFrame));
    }

    private static class Crc32
    {
        private const uint Polynomial = 0xEDB88320u;
        private static readonly uint[] Table = BuildTable();

        public static uint Compute(ReadOnlySpan<byte> data)
        {
            uint crc = 0xFFFFFFFFu;
            for (int i = 0; i < data.Length; i++)
            {
                crc = Table[(crc ^ data[i]) & 0xFF] ^ (crc >> 8);
            }

            return ~crc;
        }

        private static uint[] BuildTable()
        {
            var table = new uint[256];
            for (uint i = 0; i < table.Length; i++)
            {
                uint c = i;
                for (int bit = 0; bit < 8; bit++)
                {
                    c = (c & 1) != 0 ? (Polynomial ^ (c >> 1)) : (c >> 1);
                }

                table[i] = c;
            }

            return table;
        }
    }
}
