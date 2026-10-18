using System.Buffers;

using FsusBlog.Core.Algorithms;

namespace FsusBlog.Server.Infrastructure.PublicReadArtifacts;

/// <summary>
/// Borrows already-admitted storage without allocating or replacing its backing buffer.
/// The caller owns reservation and lifetime. With TransientBufferLease, this writer and
/// every returned memory/span view must remain inside the ConsumeAsync callback.
/// </summary>
internal sealed class ReservedAedsFrameWriter(Memory<byte> destination) : IBufferWriter<byte>
{
    private readonly Memory<byte> _destination = destination;
    private int _writtenCount;

    internal int WrittenCount => _writtenCount;
    internal ReadOnlyMemory<byte> WrittenMemory => _destination[.._writtenCount];

    /// <summary>
    /// Computes known-payload capacity using the canonical header and artifact policy.
    /// This is sizing only; it does not reserve storage or qualify admission.
    /// </summary>
    internal static int GetFrameLength(int payloadLength, PublicHotReadOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        ArgumentOutOfRangeException.ThrowIfNegative(payloadLength);
        int frameLength = checked(AedsFrameHeader.Size + payloadLength);
        if (frameLength > options.MaxFrameBytes)
        {
            throw new InvalidOperationException("public hot-read frame exceeds MaxFrameBytes");
        }

        return frameLength;
    }

    /// <summary>
    /// Composes the canonical encoder with an exact bounded view of reserved storage.
    /// The returned frame borrows that storage and must be consumed within its lifetime;
    /// it is not a published artifact or a lease ownership transfer.
    /// </summary>
    internal static ReadOnlyMemory<byte> WriteFrame(
        IAedsEncoder encoder,
        AedsFrameType frameType,
        ReadOnlySpan<byte> payload,
        Memory<byte> destination,
        PublicHotReadOptions options,
        ushort version = AedsFrameHeader.CurrentVersion,
        uint flags = 0)
    {
        ArgumentNullException.ThrowIfNull(encoder);
        int frameLength = GetFrameLength(payload.Length, options);
        if (frameLength > destination.Length)
        {
            throw new ArgumentException("Reserved destination is too small for the AEDS frame.", nameof(destination));
        }

        var writer = new ReservedAedsFrameWriter(destination[..frameLength]);
        encoder.WriteFrame(frameType, payload, writer, version, flags);
        if (writer.WrittenCount != frameLength)
        {
            throw new InvalidOperationException("AEDS encoder did not write the complete frame.");
        }

        return writer.WrittenMemory;
    }

    public void Advance(int count)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(count);
        if (count > _destination.Length - _writtenCount)
        {
            throw new ArgumentOutOfRangeException(nameof(count), "Advance exceeds the reserved destination.");
        }

        _writtenCount += count;
    }

    public Memory<byte> GetMemory(int sizeHint = 0)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(sizeHint);
        int remaining = _destination.Length - _writtenCount;
        // IBufferWriter requires a nonempty view even for a zero hint.
        if (remaining == 0 || sizeHint > remaining)
        {
            throw new ArgumentException("Size hint exceeds the reserved destination.", nameof(sizeHint));
        }

        return _destination[_writtenCount..];
    }

    public Span<byte> GetSpan(int sizeHint = 0) => GetMemory(sizeHint).Span;
}
