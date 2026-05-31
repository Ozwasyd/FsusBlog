using FsusBlog.Server.Infrastructure.Helpers.Security;

namespace FsusBlog.Server.Tests;

public sealed class FastCharValidatorTests
{
    [Theory]
    [InlineData("")]
    [InlineData("hello!")]
    [InlineData("你好123")]
    [InlineData("你好🙂")]
    public void IsOnlyChineseAndAlpha_ReturnsFalseForInvalidInput(string value)
    {
        bool result = FastCharValidator.IsOnlyChineseAndAlpha(value);

        Assert.False(result);
    }

    [Theory]
    [InlineData("HelloWorld")]
    [InlineData("你好世界")]
    [InlineData("Hello世界Alpha")]
    public void IsOnlyChineseAndAlpha_ReturnsTrueForAllowedLetters(string value)
    {
        bool result = FastCharValidator.IsOnlyChineseAndAlpha(value);

        Assert.True(result);
    }

    [Fact]
    public void IsOnlyChineseAndAlpha_AcceptsLongInput()
    {
        string value = new string('A', 24) + "中文验证";

        bool result = FastCharValidator.IsOnlyChineseAndAlpha(value);

        Assert.True(result);
    }

    [Theory]
    [InlineData("")]
    [InlineData("user_name")]
    [InlineData("user name")]
    [InlineData("你好-123")]
    public void IsAlphaNumericHyphen_ReturnsFalseForInvalidInput(string value)
    {
        bool result = FastCharValidator.IsAlphaNumericHyphen(value);

        Assert.False(result);
    }

    [Theory]
    [InlineData("alpha")]
    [InlineData("Alpha-123")]
    [InlineData("A1-b2-C3")]
    public void IsAlphaNumericHyphen_ReturnsTrueForAllowedInput(string value)
    {
        bool result = FastCharValidator.IsAlphaNumericHyphen(value);

        Assert.True(result);
    }

    [Fact]
    public void IsAlphaNumericHyphen_AcceptsLongInput()
    {
        string value = "Segment-" + new string('9', 24);

        bool result = FastCharValidator.IsAlphaNumericHyphen(value);

        Assert.True(result);
    }
}