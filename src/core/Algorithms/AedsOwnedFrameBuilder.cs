using System.Buffers;

namespace FsusBlog.Core.Algorithms;

public static class AedsOwnedFrameBuilder
{
    public static OwnedAedsFrame BuildOwned(
        AedsFrameType frameType,
        Action<IBufferWriter<byte>> writePayload,
        int initialCapacity = 1024)
    {
        ArgumentNullException.ThrowIfNull(writePayload);

        using var writer = new AedsFrameBufferWriter(initialCapacity);
        writePayload(writer.PayloadWriter);
        writer.Seal(frameType);
        return writer.DetachOwnedFrame();
    }

    public static OwnedAedsFrame BuildExact(
        AedsFrameType frameType,
        Action<IBufferWriter<byte>> writePayload,
        int initialCapacity = 1024)
    {
        ArgumentNullException.ThrowIfNull(writePayload);

        int payloadLength;
        int payloadInitialCapacity = initialCapacity <= AedsFrameHeader.Size
            ? 1
            : initialCapacity - AedsFrameHeader.Size;
        using (var counter = new CountingBufferWriter(
                   initialCapacity: payloadInitialCapacity,
                   clearOnReturn: AedsFrameSensitivity.RequiresClear(frameType)))
        {
            writePayload(counter);
            payloadLength = counter.WrittenCount;
        }

        int frameLength = checked(AedsFrameHeader.Size + payloadLength);
        byte[] frame = GC.AllocateUninitializedArray<byte>(frameLength);
        bool clearOnFailure = AedsFrameSensitivity.RequiresClear(frameType);
        try
        {
            var exactWriter = new ExactBufferWriter(frame.AsMemory(AedsFrameHeader.Size));
            writePayload(exactWriter);
            if (exactWriter.WrittenCount != payloadLength)
            {
                throw new InvalidOperationException(
                    $"AEDS payload length changed between sizing and encoding passes: expected {payloadLength}, wrote {exactWriter.WrittenCount}.");
            }

            ReadOnlySpan<byte> payload = frame.AsSpan(AedsFrameHeader.Size, payloadLength);
            AedsEncoder.WriteHeaderInto(
                frameType,
                payload,
                AedsFrameHeader.CurrentVersion,
                flags: 0,
                frame.AsSpan(0, AedsFrameHeader.Size));
            return OwnedAedsFrame.TakeOwnership(frame, frameType);
        }
        catch
        {
            if (clearOnFailure)
            {
                frame.AsSpan().Clear();
            }

            throw;
        }
    }

    private sealed class CountingBufferWriter : IBufferWriter<byte>, IDisposable
    {
        private readonly ArrayPool<byte> _pool = ArrayPool<byte>.Shared;
        private readonly bool _clearOnReturn;
        private byte[] _scratch;
        private int _available;
        private bool _disposed;

        public CountingBufferWriter(int initialCapacity, bool clearOnReturn)
        {
            _clearOnReturn = clearOnReturn;
            _scratch = _pool.Rent(Math.Max(1, initialCapacity));
        }

        public int WrittenCount { get; private set; }

        public void Advance(int count)
        {
            ThrowIfDisposed();
            if (count < 0 || count > _available)
            {
                throw new ArgumentOutOfRangeException(nameof(count));
            }

            WrittenCount = checked(WrittenCount + count);
            _available = 0;
        }

        public Memory<byte> GetMemory(int sizeHint = 0)
        {
            ThrowIfDisposed();
            Ensure(sizeHint);
            _available = _scratch.Length;
            return _scratch;
        }

        public Span<byte> GetSpan(int sizeHint = 0)
        {
            ThrowIfDisposed();
            Ensure(sizeHint);
            _available = _scratch.Length;
            return _scratch;
        }

        public void Dispose()
        {
            if (_disposed)
            {
                return;
            }

            _pool.Return(_scratch, clearArray: _clearOnReturn);
            _scratch = [];
            _available = 0;
            _disposed = true;
        }

        private void Ensure(int sizeHint)
        {
            int required = Math.Max(1, sizeHint);
            if (_scratch.Length >= required)
            {
                return;
            }

            byte[] next = _pool.Rent(required);
            _pool.Return(_scratch, clearArray: _clearOnReturn);
            _scratch = next;
        }

        private void ThrowIfDisposed()
        {
            if (_disposed)
            {
                throw new ObjectDisposedException(nameof(CountingBufferWriter));
            }
        }
    }

    private sealed class ExactBufferWriter(Memory<byte> destination) : IBufferWriter<byte>
    {
        private int _available;

        public int WrittenCount { get; private set; }

        public void Advance(int count)
        {
            if (count < 0 || count > _available)
            {
                throw new ArgumentOutOfRangeException(nameof(count));
            }

            WrittenCount += count;
            _available = 0;
        }

        public Memory<byte> GetMemory(int sizeHint = 0)
        {
            Memory<byte> remaining = GetRemaining(sizeHint);
            _available = remaining.Length;
            return remaining;
        }

        public Span<byte> GetSpan(int sizeHint = 0)
        {
            Memory<byte> remaining = GetRemaining(sizeHint);
            _available = remaining.Length;
            return remaining.Span;
        }

        private Memory<byte> GetRemaining(int sizeHint)
        {
            int required = Math.Max(1, sizeHint);
            Memory<byte> remaining = destination[WrittenCount..];
            if (remaining.Length < required)
            {
                throw new InvalidOperationException(
                    "The second AEDS payload pass requested more capacity than the exact sizing pass produced.");
            }

            return remaining;
        }
    }
}
