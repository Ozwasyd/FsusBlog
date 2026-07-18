using System.Buffers;

using FsusBlog.Core.Common;

namespace FsusBlog.Core.Algorithms;

/// <summary>
/// Represents a validated AEDS frame header together with its decoded payload and frame type.
/// </summary>
public readonly record struct AedsDecodeResult(AedsFrameHeader Header, ReadOnlyMemory<byte> Payload, AedsFrameType FrameType);

/// <summary>
/// Encodes and validates the versioned AEDS binary frame protocol.
/// </summary>
public interface IAedsEncoder
{
    /// <summary>
    /// Encodes a payload into a newly allocated AEDS frame.
    /// </summary>
    byte[] Encode(AedsFrameType frameType, ReadOnlySpan<byte> payload, ushort version = AedsFrameHeader.CurrentVersion, uint flags = 0);

    /// <summary>
    /// Writes a complete AEDS frame to the supplied buffer writer.
    /// </summary>
    void WriteFrame(AedsFrameType frameType, ReadOnlySpan<byte> payload, IBufferWriter<byte> destination, ushort version = AedsFrameHeader.CurrentVersion, uint flags = 0);

    /// <summary>
    /// Writes an AEDS header for the supplied payload without copying the payload bytes.
    /// </summary>
    void WriteHeader(AedsFrameType frameType, ReadOnlySpan<byte> payload, IBufferWriter<byte> destination, ushort version = AedsFrameHeader.CurrentVersion, uint flags = 0);

    /// <summary>
    /// Validates and decodes an AEDS frame, returning a structured protocol failure when invalid.
    /// </summary>
    Result<AedsDecodeResult> TryDecode(ReadOnlyMemory<byte> frame);
}
