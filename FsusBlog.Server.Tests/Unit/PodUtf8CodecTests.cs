using System.Buffers;
using FsusBlog.Core.Mapping.Codecs;

namespace FsusBlog.Server.Tests;

public sealed class PodUtf8CodecTests
{
    [Theory]
    [InlineData("")]
    [InlineData("hello")]
    [InlineData("你好")]
    [InlineData("Hello你好123")]
    public void AppendSlice_ListPathMatchesArrayBufferWriter(string value)
    {
        var listPayload = new List<byte> { 1, 2, 3 };
        var bufferPayload = new ArrayBufferWriter<byte>();
        bufferPayload.Write([(byte)1, (byte)2, (byte)3]);

        var listSlice = PodUtf8Codec.AppendSlice(value, listPayload);
        var bufferSlice = PodUtf8Codec.AppendSlice(value, bufferPayload);

        Assert.Equal(listSlice, bufferSlice);
        Assert.Equal(listPayload, bufferPayload.WrittenSpan.ToArray());
    }
}
