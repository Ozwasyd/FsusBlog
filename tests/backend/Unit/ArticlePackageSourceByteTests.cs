using System.Security.Cryptography;
using System.Text;

using FsusBlog.Shared.Contracts.ArticlePackages;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticlePackageSourceByteTests
{
    [Theory]
    [InlineData("", 0, 0, 0, ArticlePackageFinalNewline.None, 0, 0)]
    [InlineData("正文😀  \t\r\n^anchor\n", 1, 1, 0, ArticlePackageFinalNewline.Lf, 2, 1)]
    [InlineData("a\r\nb \r", 0, 1, 1, ArticlePackageFinalNewline.Cr, 1, 0)]
    [InlineData("a\r\nb\r\n", 0, 2, 0, ArticlePackageFinalNewline.CrLf, 0, 0)]
    [InlineData("a  \t", 0, 0, 0, ArticlePackageFinalNewline.None, 2, 1)]
    public void Inspect_RecordsExactBytesWithoutNormalizing(
        string source,
        int lf,
        int crLf,
        int bareCr,
        ArticlePackageFinalNewline final,
        int spaces,
        int tabs)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(source);
        byte[] original = bytes.ToArray();
        Assert.True(ArticlePackageSourceBytes.Inspect(bytes, out ArticlePackageByteMetadata? metadata).IsValid);
        Assert.NotNull(metadata);
        Assert.Equal(bytes.Length, metadata.ByteLength);
        Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(bytes)), metadata.Sha256);
        Assert.Equal(lf, metadata.LfCount);
        Assert.Equal(crLf, metadata.CrLfCount);
        Assert.Equal(bareCr, metadata.BareCrCount);
        Assert.Equal(final, metadata.FinalNewline);
        Assert.Equal(spaces, metadata.TrailingSpaceCount);
        Assert.Equal(tabs, metadata.TrailingTabCount);
        Assert.False(metadata.HasUtf8Bom);
        Assert.Equal(original, bytes);
        Assert.True(ArticlePackageSourceBytes.Verify(bytes, metadata).IsValid);
    }

    [Fact]
    public void Bom_AndUnicodeNormalization_RemainDistinctRawByteIdentities()
    {
        byte[] plain = Encoding.UTF8.GetBytes("é\r\n");
        byte[] bom = [0xef, 0xbb, 0xbf, .. plain];
        byte[] decomposed = Encoding.UTF8.GetBytes("e\u0301\r\n");
        Assert.True(ArticlePackageSourceBytes.Inspect(plain, out ArticlePackageByteMetadata? first).IsValid);
        Assert.True(ArticlePackageSourceBytes.Inspect(bom, out ArticlePackageByteMetadata? second).IsValid);
        Assert.True(ArticlePackageSourceBytes.Inspect(decomposed, out ArticlePackageByteMetadata? third).IsValid);
        Assert.NotEqual(first!.Sha256, second!.Sha256);
        Assert.NotEqual(first.Sha256, third!.Sha256);
        Assert.True(second.HasUtf8Bom);
        Assert.Equal(first.ByteLength + 3, second.ByteLength);
        Assert.False(ArticlePackageSourceBytes.Verify(bom, first).IsValid);
    }

    [Theory]
    [InlineData(new byte[] { 0xc0, 0xaf })]
    [InlineData(new byte[] { 0xed, 0xa0, 0x80 })]
    [InlineData(new byte[] { 0xf4, 0x90, 0x80, 0x80 })]
    [InlineData(new byte[] { 0xe2, 0x82 })]
    public void InvalidUtf8_FailsClosed(byte[] bytes)
    {
        ArticlePackageByteValidationResult result = ArticlePackageSourceBytes.Inspect(bytes, out _);
        Assert.False(result.IsValid);
        Assert.Equal("article_package_source_invalid_utf8", result.ReasonCode);
    }

    [Fact]
    public void Verify_RejectsEveryMetadataFieldTamperAndSourceTamper()
    {
        byte[] bytes = Encoding.UTF8.GetBytes("正文  \r\n");
        Assert.True(ArticlePackageSourceBytes.Inspect(bytes, out ArticlePackageByteMetadata? metadata).IsValid);
        ArticlePackageByteMetadata original = metadata!;
        ArticlePackageByteMetadata[] tampered =
        [
            original with { ByteLength = original.ByteLength + 1 },
            original with { Sha256 = original.Sha256.ToUpperInvariant() },
            original with { HasUtf8Bom = true },
            original with { LfCount = 1 },
            original with { CrLfCount = 0 },
            original with { BareCrCount = 1 },
            original with { FinalNewline = ArticlePackageFinalNewline.None },
            original with { FinalNewline = (ArticlePackageFinalNewline)255 },
            original with { TrailingSpaceCount = 0 },
            original with { TrailingTabCount = 1 }
        ];
        Assert.All(tampered, item => Assert.False(ArticlePackageSourceBytes.Verify(bytes, item).IsValid));
        Assert.False(ArticlePackageSourceBytes.Verify(bytes, null).IsValid);
        bytes[0] ^= 1;
        Assert.False(ArticlePackageSourceBytes.Verify(bytes, original).IsValid);
    }

    [Fact]
    public void ByteBudget_RejectsOversizeBeforeDecoding()
    {
        byte[] bytes = new byte[ArticlePackageSourceBytes.MaximumByteLength + 1];
        bytes[0] = 0xff;
        ArticlePackageByteValidationResult result = ArticlePackageSourceBytes.Inspect(bytes, out _);
        Assert.False(result.IsValid);
        Assert.Equal("article_package_source_byte_budget_exceeded", result.ReasonCode);
    }
}
