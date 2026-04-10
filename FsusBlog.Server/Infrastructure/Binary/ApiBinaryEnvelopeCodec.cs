using System.Buffers.Binary;
using System.Text;

namespace FsusBlog.Server.Infrastructure.Binary;

public static class ApiBinaryEnvelopeCodec
{
    public static byte[] EncodeEnvelopePayload(int statusCode, string? contentType, ReadOnlySpan<byte> body)
    {
        byte[] contentTypeBytes = Encoding.UTF8.GetBytes(contentType ?? string.Empty);
        int payloadLength = sizeof(int)
            + sizeof(ushort)
            + contentTypeBytes.Length
            + sizeof(int)
            + body.Length;

        byte[] payload = new byte[payloadLength];
        var span = payload.AsSpan();
        int offset = 0;

        BinaryPrimitives.WriteInt32LittleEndian(span.Slice(offset, sizeof(int)), statusCode);
        offset += sizeof(int);

        BinaryPrimitives.WriteUInt16LittleEndian(span.Slice(offset, sizeof(ushort)), checked((ushort)contentTypeBytes.Length));
        offset += sizeof(ushort);

        contentTypeBytes.CopyTo(span.Slice(offset, contentTypeBytes.Length));
        offset += contentTypeBytes.Length;

        BinaryPrimitives.WriteInt32LittleEndian(span.Slice(offset, sizeof(int)), body.Length);
        offset += sizeof(int);

        body.CopyTo(span.Slice(offset, body.Length));
        return payload;
    }
}
