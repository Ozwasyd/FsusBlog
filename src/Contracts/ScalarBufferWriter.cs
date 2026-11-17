using System.Buffers;
using System.Buffers.Binary;

namespace FsusBlog.V2.Contracts;

internal abstract class ScalarBufferWriter
{
    protected readonly ArrayBufferWriter<byte> buffer = new();
    public ReadOnlySpan<byte> Written => buffer.WrittenSpan;

    public void I32(int value)
    {
        BinaryPrimitives.WriteInt32LittleEndian(buffer.GetSpan(4), value);
        buffer.Advance(4);
    }

    public void I64(long value)
    {
        BinaryPrimitives.WriteInt64LittleEndian(buffer.GetSpan(8), value);
        buffer.Advance(8);
    }

    public void Bool(bool value) => Byte(value ? (byte)1 : (byte)0);

    internal void Byte(byte value)
    {
        buffer.GetSpan(1)[0] = value;
        buffer.Advance(1);
    }

}
