using System.Buffers;
using System.Buffers.Binary;
using System.Text;
using FsusBlog.Server.Infrastructure.Binary;

namespace FsusBlog.Server.Tests;

public sealed class ApiBinaryEnvelopeCodecTests
{
    [Fact]
    public void EncodeEnvelopePayload_MatchesBufferWriterPath()
    {
        byte[] body = Encoding.UTF8.GetBytes("{\"ok\":true}");

        byte[] encoded = ApiBinaryEnvelopeCodec.EncodeEnvelopePayload(200, "application/json", body);
        var writer = new ArrayBufferWriter<byte>();
        ApiBinaryEnvelopeCodec.WriteEnvelopePayload(200, "application/json", body, writer);

        Assert.Equal(encoded, writer.WrittenSpan.ToArray());
    }

    [Fact]
    public void EncodeEnvelopePayload_PreservesEnvelopeLayoutForEmptyBody()
    {
        byte[] encoded = ApiBinaryEnvelopeCodec.EncodeEnvelopePayload(404, "text/plain", []);
        var span = encoded.AsSpan();

        int statusCode = BinaryPrimitives.ReadInt32LittleEndian(span[..sizeof(int)]);
        ushort contentTypeLength = BinaryPrimitives.ReadUInt16LittleEndian(span.Slice(sizeof(int), sizeof(ushort)));
        string contentType = Encoding.UTF8.GetString(span.Slice(sizeof(int) + sizeof(ushort), contentTypeLength));
        int bodyLength = BinaryPrimitives.ReadInt32LittleEndian(span.Slice(sizeof(int) + sizeof(ushort) + contentTypeLength, sizeof(int)));

        Assert.Equal(404, statusCode);
        Assert.Equal("text/plain", contentType);
        Assert.Equal(0, bodyLength);
    }
}
