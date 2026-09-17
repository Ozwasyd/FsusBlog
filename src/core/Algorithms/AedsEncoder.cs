using System.Buffers;
using System.Buffers.Binary;

using FsusBlog.Core.Common;

namespace FsusBlog.Core.Algorithms;

/// <summary>
/// Implements the AEDS v2 frame encoder and validating decoder.
/// </summary>
public sealed class AedsEncoder : IAedsEncoder
{
    /// <summary>The fixed magic prefix used by every supported AEDS frame.</summary>
    public const uint Magic = AedsFrameHeader.Magic;

    /// <inheritdoc />
    public byte[] Encode(AedsFrameType frameType, ReadOnlySpan<byte> payload, ushort version = AedsFrameHeader.CurrentVersion, uint flags = 0)
    {
        int totalLength = AedsFrameHeader.Size + payload.Length;
        var frame = new byte[totalLength];
        EncodeInto(frameType, payload, version, flags, frame);
        return frame;
    }

    /// <inheritdoc />
    public void WriteFrame(AedsFrameType frameType, ReadOnlySpan<byte> payload, IBufferWriter<byte> destination, ushort version = AedsFrameHeader.CurrentVersion, uint flags = 0)
    {
        int totalLength = AedsFrameHeader.Size + payload.Length;
        Span<byte> frame = destination.GetSpan(totalLength).Slice(0, totalLength);
        EncodeInto(frameType, payload, version, flags, frame);
        destination.Advance(totalLength);
    }

    /// <inheritdoc />
    public void WriteHeader(AedsFrameType frameType, ReadOnlySpan<byte> payload, IBufferWriter<byte> destination, ushort version = AedsFrameHeader.CurrentVersion, uint flags = 0)
    {
        Span<byte> header = destination.GetSpan(AedsFrameHeader.Size).Slice(0, AedsFrameHeader.Size);
        WriteHeaderInto(frameType, payload, version, flags, header);
        destination.Advance(AedsFrameHeader.Size);
    }

    /// <inheritdoc />
    public Result<AedsDecodeResult> TryDecode(ReadOnlyMemory<byte> frame)
    {
        ReadOnlySpan<byte> frameSpan = frame.Span;
        if (frameSpan.Length < AedsFrameHeader.Size)
        {
            return Result<AedsDecodeResult>.Failure(ErrorCode.Validation, "AEDS frame too short");
        }

        ReadOnlySpan<byte> header = frameSpan[..AedsFrameHeader.Size];
        uint magic = BinaryPrimitives.ReadUInt32LittleEndian(header[0..4]);
        if (magic != Magic)
        {
            return Result<AedsDecodeResult>.Failure(ErrorCode.Validation, "AEDS magic mismatch");
        }

        byte version = header[4];
        byte headerLength = header[5];
        ushort flags = BinaryPrimitives.ReadUInt16LittleEndian(header[6..8]);
        ushort frameTypeRaw = BinaryPrimitives.ReadUInt16LittleEndian(header[8..10]);
        uint payloadLength = BinaryPrimitives.ReadUInt32LittleEndian(header[10..14]);
        ushort payloadCrc16 = BinaryPrimitives.ReadUInt16LittleEndian(header[14..16]);

        if (version != AedsFrameHeader.CurrentVersion)
        {
            return Result<AedsDecodeResult>.Failure(ErrorCode.Validation, "AEDS version unsupported");
        }

        if (headerLength != AedsFrameHeader.Size)
        {
            return Result<AedsDecodeResult>.Failure(ErrorCode.Validation, "AEDS header length mismatch");
        }

        if (IsRetiredFrameType(frameTypeRaw))
        {
            return Result<AedsDecodeResult>.Failure(ErrorCode.Validation, "AEDS frame type retired");
        }

        if (!Enum.IsDefined(typeof(AedsFrameType), frameTypeRaw))
        {
            return Result<AedsDecodeResult>.Failure(ErrorCode.Validation, "AEDS frame type unsupported");
        }

        if (payloadLength != (uint)(frameSpan.Length - AedsFrameHeader.Size))
        {
            return Result<AedsDecodeResult>.Failure(ErrorCode.Validation, "AEDS payload length mismatch");
        }

        ReadOnlySpan<byte> payloadSpan = frameSpan[AedsFrameHeader.Size..];
        ushort computedPayloadCrc = AedsCrc16.Compute(payloadSpan);
        if (computedPayloadCrc != payloadCrc16)
        {
            return Result<AedsDecodeResult>.Failure(ErrorCode.Validation, "AEDS payload crc mismatch");
        }

        var typedFrame = (AedsFrameType)frameTypeRaw;
        var headerModel = new AedsFrameHeader(magic, version, headerLength, flags, frameTypeRaw, payloadLength, payloadCrc16);
        return Result<AedsDecodeResult>.Success(new AedsDecodeResult(headerModel, frame[AedsFrameHeader.Size..], typedFrame));
    }

    private static void EncodeInto(AedsFrameType frameType, ReadOnlySpan<byte> payload, ushort version, uint flags, Span<byte> frame)
    {
        Span<byte> header = frame[..AedsFrameHeader.Size];
        WriteHeaderInto(frameType, payload, version, flags, header);
        payload.CopyTo(frame[AedsFrameHeader.Size..]);
    }

    internal static void WriteHeaderInto(AedsFrameType frameType, ReadOnlySpan<byte> payload, ushort version, uint flags, Span<byte> header)
    {
        if (version != AedsFrameHeader.CurrentVersion)
        {
            throw new ArgumentOutOfRangeException(nameof(version), "AEDS v2 is the only supported wire version.");
        }

        if (flags > ushort.MaxValue)
        {
            throw new ArgumentOutOfRangeException(nameof(flags), "AEDS v2 flags are uint16.");
        }

        BinaryPrimitives.WriteUInt32LittleEndian(header[0..4], Magic);
        header[4] = (byte)version;
        header[5] = AedsFrameHeader.CurrentHeaderLength;
        BinaryPrimitives.WriteUInt16LittleEndian(header[6..8], (ushort)flags);
        BinaryPrimitives.WriteUInt16LittleEndian(header[8..10], (ushort)frameType);
        BinaryPrimitives.WriteUInt32LittleEndian(header[10..14], (uint)payload.Length);
        BinaryPrimitives.WriteUInt16LittleEndian(header[14..16], AedsCrc16.Compute(payload));
    }

    private static bool IsRetiredFrameType(ushort frameTypeRaw)
        => frameTypeRaw is 40 or 43 or 44 or 45 or 46 or 180 or 181 or 186 or 187;
}
