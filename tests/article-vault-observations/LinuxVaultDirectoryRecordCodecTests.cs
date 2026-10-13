using System.Buffers.Binary;
using System.Text;

using Xunit;

namespace FsusBlog.ArticleVault.Observations.Tests;

[Trait("Category", "ArticleVaultEventNormalization")]
public sealed class LinuxVaultDirectoryRecordCodecTests
{
    [Fact]
    public void NativeRecordLayoutPreservesUnicodeNamesAndKindHintsWithoutDotEntries()
    {
        byte[] records = [.. Record(".", 4), .. Record("..", 4), .. Record("文章.md", 8), .. Record("new", 4), .. Record("link", 10)];
        Assert.Equal([new LinuxVaultDirectoryEntry("文章.md", 8), new("new", 4), new("link", 10)],
            LinuxVaultDirectoryRecordCodec.Decode(records).ToArray());
        Assert.Empty(LinuxVaultDirectoryRecordCodec.Decode([]));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(19)]
    [InlineData(23)]
    [InlineData(25)]
    [InlineData(65528)]
    public void MalformedNativeRecordLengthIsRejectedBeforeNameInterpretation(ushort length)
    {
        byte[] record = Record("source.md", 8);
        BinaryPrimitives.WriteUInt16LittleEndian(record.AsSpan(16), length);
        Assert.Throws<InvalidDataException>(() => LinuxVaultDirectoryRecordCodec.Decode(record));
    }

    [Fact]
    public void TruncationMissingTerminatorInvalidUtf8AndPathInjectionAreRejected()
    {
        byte[] good = Record("source.md", 8);
        Assert.Throws<InvalidDataException>(() => LinuxVaultDirectoryRecordCodec.Decode(good.AsSpan(0, good.Length - 1)));
        Assert.Throws<InvalidDataException>(() => LinuxVaultDirectoryRecordCodec.Decode(new byte[19]));
        byte[] unterminated = Record("a", 8);
        unterminated.AsSpan(19).Fill((byte)'a');
        Assert.Throws<InvalidDataException>(() => LinuxVaultDirectoryRecordCodec.Decode(unterminated));
        byte[] invalidUtf8 = Record("a", 8);
        invalidUtf8[19] = 0xff;
        Assert.Throws<InvalidDataException>(() => LinuxVaultDirectoryRecordCodec.Decode(invalidUtf8));
        Assert.Throws<InvalidDataException>(() => LinuxVaultDirectoryRecordCodec.Decode(Record("a/b", 8)));
        Assert.Throws<InvalidDataException>(() => LinuxVaultDirectoryRecordCodec.Decode(
            new byte[LinuxVaultDirectoryRecordCodec.MaximumBufferBytes + 1]));
    }

    internal static byte[] Record(string name, byte type)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(name);
        int length = (19 + bytes.Length + 1 + 7) & ~7;
        byte[] record = new byte[length];
        BinaryPrimitives.WriteUInt16LittleEndian(record.AsSpan(16), checked((ushort)length));
        record[18] = type;
        bytes.CopyTo(record.AsSpan(19));
        return record;
    }
}
