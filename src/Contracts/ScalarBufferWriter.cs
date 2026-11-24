using System.Buffers;
using System.Buffers.Binary;

namespace FsusBlog.V2.Contracts;

internal abstract class ScalarBufferWriter<TSelf> where TSelf : ScalarBufferWriter<TSelf>
{
    protected readonly ArrayBufferWriter<byte> buffer = new();
    public ReadOnlySpan<byte> Written => buffer.WrittenSpan;

    public TSelf I32(int value)
    {
        BinaryPrimitives.WriteInt32LittleEndian(buffer.GetSpan(4), value);
        buffer.Advance(4);
        return (TSelf)this;
    }

    public TSelf I64(long value)
    {
        BinaryPrimitives.WriteInt64LittleEndian(buffer.GetSpan(8), value);
        buffer.Advance(8);
        return (TSelf)this;
    }

    public TSelf Bool(bool value) => Byte(value ? (byte)1 : (byte)0);

    internal TSelf Byte(byte value)
    {
        buffer.GetSpan(1)[0] = value;
        buffer.Advance(1);
        return (TSelf)this;
    }
}
