namespace FsusBlog.V2.Contracts;

internal static class PackedWireFields
{
    private const int ReferenceSize = 2 * sizeof(int);

    internal static byte[] Encode(int lengthOffset, int referenceOffset, byte[][] fields, int? referenceCount = null)
    {
        var length = fields.Sum(static field => field.Length);
        var payload = new byte[lengthOffset + sizeof(int) + length];
        BinaryPrimitives.WriteInt32LittleEndian(payload.AsSpan(lengthOffset), length);
        var blob = payload.AsSpan(lengthOffset + sizeof(int));
        var offset = 0;
        for (var index = 0; index < fields.Length; index++)
        {
            var field = fields[index];
            if (index < (referenceCount ?? fields.Length))
            {
                var reference = payload.AsSpan(referenceOffset + index * ReferenceSize);
                BinaryPrimitives.WriteInt32LittleEndian(reference, offset);
                BinaryPrimitives.WriteInt32LittleEndian(reference[sizeof(int)..], field.Length);
            }
            field.CopyTo(blob[offset..]);
            offset += field.Length;
        }
        return payload;
    }
}
