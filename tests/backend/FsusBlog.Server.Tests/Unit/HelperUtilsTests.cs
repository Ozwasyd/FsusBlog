using FsusBlog.Server.Infrastructure.Helpers;

namespace FsusBlog.Server.Tests.Unit;

// ──────────────────────────────────────────────────────────────────────────────
// DigitCount
// ──────────────────────────────────────────────────────────────────────────────

public class DigitCountTests
{
    [Theory]
    [InlineData(0L, 1)]
    [InlineData(1L, 1)]
    [InlineData(9L, 1)]
    [InlineData(10L, 2)]
    [InlineData(99L, 2)]
    [InlineData(100L, 3)]
    [InlineData(999L, 3)]
    [InlineData(1000L, 4)]
    [InlineData(1_000_000L, 7)]
    [InlineData(1_000_000_000L, 10)]
    [InlineData(long.MaxValue, 19)]
    [InlineData(-1L, 2)]
    [InlineData(-9L, 2)]
    [InlineData(-10L, 3)]
    [InlineData(-100L, 4)]
    [InlineData(long.MinValue, 20)]
    public void GetDigitCount_ReturnsExpected(long n, int expected)
    {
        Assert.Equal(expected, DigitCount.GetDigitCount(n));
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// StringExtensions
// ──────────────────────────────────────────────────────────────────────────────

public class StringExtensionsTests
{
    [Fact]
    public void ToTitleCase_Null_ReturnsEmpty()
        => Assert.Equal(string.Empty, StringExtensions.ToTitleCase(null));

    [Fact]
    public void ToTitleCase_Empty_ReturnsEmpty()
        => Assert.Equal(string.Empty, StringExtensions.ToTitleCase(string.Empty));

    [Fact]
    public void ToTitleCase_AllCaps_ReturnsFirstUpperRestLower()
        => Assert.Equal("Fsus", "FSUS".ToTitleCase());

    [Fact]
    public void ToTitleCase_MixedCase_FirstUpperRestLower()
        => Assert.Equal("Hello", "hELLO".ToTitleCase());

    [Fact]
    public void ToTitleCase_SingleChar_ReturnsUpperCase()
        => Assert.Equal("A", "a".ToTitleCase());

    [Fact]
    public void FirstCharToUpper_Null_ReturnsEmpty()
        => Assert.Equal(string.Empty, StringExtensions.FirstCharToUpper(null));

    [Fact]
    public void FirstCharToUpper_AlreadyUpper_ReturnsSameRef()
    {
        string input = "Hello";
        string result = input.FirstCharToUpper();
        Assert.Same(input, result); // identity check (fast path)
    }

    [Fact]
    public void FirstCharToUpper_LowerFirst_OnlyFirstChanged()
        => Assert.Equal("FSUS", "fSUS".FirstCharToUpper());

    [Fact]
    public void FirstCharToUpper_SingleChar_ReturnsUpper()
        => Assert.Equal("A", "a".FirstCharToUpper());

    [Fact]
    public void Truncate_Null_ReturnsEmpty()
        => Assert.Equal(string.Empty, StringExtensions.Truncate(null, 10));

    [Fact]
    public void Truncate_MaxLengthZero_ReturnsEmpty()
        => Assert.Equal(string.Empty, "hello".Truncate(0));

    [Fact]
    public void Truncate_UnderLimit_ReturnsSame()
        => Assert.Equal("hi", "hi".Truncate(10));

    [Fact]
    public void Truncate_ExactLimit_ReturnsSame()
        => Assert.Equal("hello", "hello".Truncate(5));

    [Fact]
    public void Truncate_OverLimit_CutsAndAddsSuffix()
        => Assert.Equal("hel...", "hello world".Truncate(3));

    [Fact]
    public void Truncate_CustomSuffix_UsesIt()
        => Assert.Equal("hel—", "hello world".Truncate(3, "—"));
}

// ──────────────────────────────────────────────────────────────────────────────
// TimeUtils
// ──────────────────────────────────────────────────────────────────────────────

public class TimeUtilsTests
{
    [Fact]
    public void ToRfc822_ReturnsExactly29Chars()
    {
        var dt = new DateTime(2024, 6, 15, 12, 0, 0, DateTimeKind.Utc);
        string result = TimeUtils.ToRfc822(dt);
        Assert.Equal(29, result.Length);
    }

    [Fact]
    public void ToRfc822_ContainsGmt()
    {
        var dt = new DateTime(2024, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        string result = TimeUtils.ToRfc822(dt);
        Assert.Contains("GMT", result);
    }

    [Fact]
    public void ToRfc822_LocalTimeSameAsUtcInput()
    {
        var utcTime = new DateTime(2024, 6, 15, 12, 0, 0, DateTimeKind.Utc);
        var localTime = utcTime.ToLocalTime();
        // Both should produce same result (ToUniversalTime inside)
        Assert.Equal(TimeUtils.ToRfc822(utcTime), TimeUtils.ToRfc822(localTime));
    }
}
