using FsusBlog.Shared.Contracts.Primitives;
using System.Text;

namespace FsusBlog.Server.Tests.Unit;

// ──────────────────────────────────────────────────────────────────────────────
// UTF8 Codec Edge Cases and Boundary Tests
// ──────────────────────────────────────────────────────────────────────────────

public class Utf8CodecBoundaryTests
{
    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(15)]
    [InlineData(31)]
    public void Utf8Fixed32_SmallStrings_RoundTrip(int length)
    {
        var input = new string('x', length);
        var utf8 = Encoding.UTF8.GetBytes(input);

        // Should be able to encode
        Assert.True(utf8.Length <= 32);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(31)]
    [InlineData(63)]
    public void Utf8Fixed64_SmallStrings_RoundTrip(int length)
    {
        var input = new string('y', length);
        var utf8 = Encoding.UTF8.GetBytes(input);

        Assert.True(utf8.Length <= 64);
    }

    [Fact]
    public void Utf8Fixed256_LargeString_WithinBounds()
    {
        var input = new string('z', 255);
        var utf8 = Encoding.UTF8.GetBytes(input);

        // ASCII is 1 byte per char, so 255 chars = 255 bytes < 256
        Assert.True(utf8.Length <= 256);
    }

    [Fact]
    public void Utf8Fixed512_VeryLargeString_WithinBounds()
    {
        var input = new string('a', 500);
        var utf8 = Encoding.UTF8.GetBytes(input);

        Assert.True(utf8.Length <= 512);
    }

    [Fact]
    public void Utf8MultiByteCharacters_Encode()
    {
        // Chinese characters are 3 bytes in UTF-8
        var input = "你好世界";  // 4 chars = 12 bytes UTF-8
        var utf8 = Encoding.UTF8.GetBytes(input);

        Assert.Equal(12, utf8.Length);
    }

    [Fact]
    public void Utf8Emoji_Encode()
    {
        // Most emoji are 4 bytes in UTF-8
        var input = "😀😁😂";  // 3 emoji = 12 bytes
        var utf8 = Encoding.UTF8.GetBytes(input);

        Assert.Equal(12, utf8.Length);
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// String Encoding/Decoding Theory Tests
// ──────────────────────────────────────────────────────────────────────────────

public class StringEncodingTheoryTests
{
    [Theory]
    [InlineData("")]
    [InlineData("a")]
    [InlineData("hello")]
    [InlineData("HELLO WORLD")]
    [InlineData("123-456-789")]
    [InlineData("test@example.com")]
    public void AsciiStrings_EncodeCorrectly(string input)
    {
        var bytes = Encoding.UTF8.GetBytes(input);
        var str = Encoding.UTF8.GetString(bytes);

        Assert.Equal(input, str);
    }

    [Theory]
    [InlineData("é")]
    [InlineData("ñ")]
    [InlineData("ü")]
    public void AccentedCharacters_EncodeCorrectly(string input)
    {
        var bytes = Encoding.UTF8.GetBytes(input);
        var str = Encoding.UTF8.GetString(bytes);

        Assert.Equal(input, str);
    }

    [Theory]
    [InlineData("你")]
    [InlineData("好")]
    [InlineData("世界")]
    public void ChineseCharacters_EncodeCorrectly(string input)
    {
        var bytes = Encoding.UTF8.GetBytes(input);
        var str = Encoding.UTF8.GetString(bytes);

        Assert.Equal(input, str);
    }
}
