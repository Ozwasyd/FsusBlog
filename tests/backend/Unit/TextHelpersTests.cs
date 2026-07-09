using FsusBlog.Server.Infrastructure.Helpers;

namespace FsusBlog.Server.Tests.Unit;

public sealed class TextHelpersTests
{
    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void NormalizeNullable_BlankInputs_ReturnsNull(string? input)
    {
        Assert.Null(TextHelpers.NormalizeNullable(input));
    }

    [Fact]
    public void NormalizeNullable_TrimmedInput_ReturnsSameInstance()
    {
        string input = "FsusBlog";

        string? normalized = TextHelpers.NormalizeNullable(input);

        Assert.Same(input, normalized);
    }

    [Fact]
    public void NormalizeNullable_UnicodeInput_TrimsWithoutChangingText()
    {
        string? normalized = TextHelpers.NormalizeNullable("  深圳-博客  ");

        Assert.Equal("深圳-博客", normalized);
    }

    [Fact]
    public void NormalizeNullable_LongInput_TruncatesAfterTrim()
    {
        string? normalized = TextHelpers.NormalizeNullable("  abcdef  ", 3);

        Assert.Equal("abc", normalized);
    }

    [Fact]
    public void NormalizeModeToken_TrimsLowercasesAndReplacesDash()
    {
        string? normalized = TextHelpers.NormalizeModeToken("  ZK-Anonymous  ");

        Assert.Equal("zk_anonymous", normalized);
    }

    [Fact]
    public void NormalizeModeToken_NormalizedInput_ReturnsSameInstance()
    {
        string input = "zk_anonymous";

        string? normalized = TextHelpers.NormalizeModeToken(input);

        Assert.Same(input, normalized);
    }

    [Fact]
    public void LowerTrimmed_TrimsAndLowercasesWithoutReplacingDash()
    {
        string? normalized = TextHelpers.LowerTrimmed("  Foo-BAR  ");

        Assert.Equal("foo-bar", normalized);
    }

    [Fact]
    public void TrimOrNullTrimOrEmptyAndNullIfBlank_PreserveTheirNullContracts()
    {
        Assert.Null(TextHelpers.TrimOrNull(" \t "));
        Assert.Equal(string.Empty, TextHelpers.TrimOrEmpty(null));
        Assert.Null(TextHelpers.NullIfBlank(" \r\n "));
        Assert.Equal("  value  ", TextHelpers.NullIfBlank("  value  "));
    }
}
