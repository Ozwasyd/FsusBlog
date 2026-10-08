using System.Buffers;
using System.Buffers.Binary;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Codecs;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Mapping.Projectors;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Primitives;

namespace FsusBlog.Core.Cache;

/// <summary>
/// Provides binary serialization and decoding operations for shared contracts.
/// </summary>
public static partial class PodBinaryCodec
{
    private static byte[] EncodeToArray(int initialCapacity, Action<IBufferWriter<byte>> write)
    {
        using var writer = new PooledByteBufferWriter(initialCapacity);
        write(writer);
        return writer.ToArray();
    }

    private ref struct BinaryPodReader(ReadOnlySpan<byte> source)
    {
        private ReadOnlySpan<byte> _source = source;
        private int _offset;

        public bool IsConsumed => _offset == _source.Length;
        public int Remaining => _source.Length - _offset;

        public bool TryReadInt32(out int value)
        {
            if (_offset + sizeof(int) > _source.Length)
            {
                value = 0;
                return false;
            }

            value = BinaryPrimitives.ReadInt32LittleEndian(_source.Slice(_offset, sizeof(int)));
            _offset += sizeof(int);
            return true;
        }

        public bool TryReadInt64(out long value)
        {
            if (_offset + sizeof(long) > _source.Length)
            {
                value = 0;
                return false;
            }

            value = BinaryPrimitives.ReadInt64LittleEndian(_source.Slice(_offset, sizeof(long)));
            _offset += sizeof(long);
            return true;
        }

        public bool TryReadByte(out byte value)
        {
            if (_offset + 1 > _source.Length)
            {
                value = 0;
                return false;
            }

            value = _source[_offset];
            _offset++;
            return true;
        }

        public bool TryReadBytes(out ReadOnlySpan<byte> value)
        {
            if (!TryReadInt32(out int length) || length < 0 || _offset + length > _source.Length)
            {
                value = default;
                return false;
            }

            value = _source.Slice(_offset, length);
            _offset += length;
            return true;
        }

        public bool TryReadSpan(int length, out ReadOnlySpan<byte> value)
        {
            if (length < 0 || _offset + length > _source.Length)
            {
                value = default;
                return false;
            }

            value = _source.Slice(_offset, length);
            _offset += length;
            return true;
        }

        public bool TryReadSliceRef(out Utf8SliceRef value)
        {
            if (!TryReadInt32(out int offset) || !TryReadInt32(out int length) || offset < 0 || length < 0)
            {
                value = default;
                return false;
            }

            Span<int> parts = stackalloc int[2];
            parts[0] = offset;
            parts[1] = length;
            value = MemoryMarshal.Read<Utf8SliceRef>(MemoryMarshal.AsBytes(parts));
            return true;
        }

        public bool TryReadPod<T>(out T value)
            where T : unmanaged
        {
            int size = Unsafe.SizeOf<T>();
            if (_offset + size > _source.Length)
            {
                value = default;
                return false;
            }

            value = MemoryMarshal.Read<T>(_source.Slice(_offset, size));
            _offset += size;
            return true;
        }
    }

    private struct BinaryPodWriter
    {
        private readonly IBufferWriter<byte> _writer;

        public BinaryPodWriter(IBufferWriter<byte> writer)
        {
            _writer = writer;
        }

        public void WriteInt32(int value)
        {
            Span<byte> span = _writer.GetSpan(sizeof(int));
            BinaryPrimitives.WriteInt32LittleEndian(span, value);
            _writer.Advance(sizeof(int));
        }

        public void WriteInt64(long value)
        {
            Span<byte> span = _writer.GetSpan(sizeof(long));
            BinaryPrimitives.WriteInt64LittleEndian(span, value);
            _writer.Advance(sizeof(long));
        }

        public void WriteByte(byte value)
        {
            Span<byte> span = _writer.GetSpan(1);
            span[0] = value;
            _writer.Advance(1);
        }

        public void WriteBytes(ReadOnlySpan<byte> value)
        {
            WriteInt32(value.Length);
            Span<byte> span = _writer.GetSpan(value.Length);
            value.CopyTo(span);
            _writer.Advance(value.Length);
        }

        public void WriteSliceRef(in Utf8SliceRef value)
        {
            WriteInt32(value.Offset);
            WriteInt32(value.Length);
        }

        public void WritePod<T>(in T value)
            where T : unmanaged
        {
            int size = Unsafe.SizeOf<T>();
            Span<byte> span = _writer.GetSpan(size);
            MemoryMarshal.Write(span, in value);
            _writer.Advance(size);
        }

    }
}
