using System.Globalization;
using System.Text;

using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Pressure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class LinuxZramMemoryStatParserTests
{
    [Fact]
    public void Linux618FieldOrderPreservesBytesAndUnscaledPageCounts()
    {
        var result = Parse("1048576 327680 393216 524288 458752 11 13 17 19\n");

        Assert.Equal(MemoryObservationState.Available, result.State);
        Assert.Equal(new LinuxZramMemoryStat(1048576, 327680, 393216, 524288, 458752,
            11, 13, 17, 19), result.Statistics);
        Assert.Equal(MemoryQualification.NotVerified, result.Qualification);
    }

    [Theory]
    [InlineData("1 2 3 4 5 6 7 8 9")]
    [InlineData("       1        2        3        4        5        6        7        8        9\n")]
    [InlineData(" \t1\t2  3\t4 5 6 7 8 9 \t\n")]
    [InlineData("01 002 0003 4 5 6 7 8 9")]
    public void AcceptsDecimalFieldsAndHorizontalPadding(string content)
    {
        var result = Parse(content);

        Assert.Equal(MemoryObservationState.Available, result.State);
        Assert.Equal(new LinuxZramMemoryStat(1, 2, 3, 4, 5, 6, 7, 8, 9), result.Statistics);
    }

    [Fact]
    public void ActualZerosRemainAvailableWithoutQualification()
    {
        var result = Parse("0 0 0 0 0 0 0 0 0\n");

        Assert.Equal(MemoryObservationState.Available, result.State);
        Assert.Equal(new LinuxZramMemoryStat(0, 0, 0, 0, 0, 0, 0, 0, 0), result.Statistics);
        Assert.Equal(MemoryQualification.NotVerified, result.Qualification);
    }

    [Theory]
    [InlineData("999 1 80 100 900 5 6 7 8", 1L, 80L, 100L, 900L)]
    [InlineData("999 70 80 100 90 5 6 7 8", 70L, 80L, 100L, 90L)]
    [InlineData("999 1 80 0 900 5 6 7 8", 1L, 80L, 0L, 900L)]
    [InlineData("999 90 80 40 20 5 6 7 8", 90L, 80L, 40L, 20L)]
    public void CompressedPeakAndLimitNeverReplaceAllocatedBytesOrQualifyHeadroom(string content,
        long compressed, long allocated, long limit, long peak)
    {
        var result = Parse(content);

        Assert.Equal(MemoryObservationState.Available, result.State);
        Assert.Equal(new LinuxZramMemoryStat(999, compressed, allocated, limit, peak,
            5, 6, 7, 8), result.Statistics);
        Assert.Equal(MemoryQualification.NotVerified, result.Qualification);
    }

    [Fact]
    public void MaximumSignedValuesArePreservedForEveryField()
    {
        string maximum = long.MaxValue.ToString(CultureInfo.InvariantCulture);
        var result = Parse(string.Join(' ', Enumerable.Repeat(maximum, 9)) + "\n");

        Assert.Equal(MemoryObservationState.Available, result.State);
        Assert.Equal(new LinuxZramMemoryStat(long.MaxValue, long.MaxValue, long.MaxValue,
            long.MaxValue, long.MaxValue, long.MaxValue, long.MaxValue, long.MaxValue,
            long.MaxValue), result.Statistics);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(7)]
    [InlineData(8)]
    [InlineData(10)]
    [InlineData(11)]
    public void RejectsWrongFieldCounts(int count)
    {
        AssertRejected(Parse(string.Join(' ', Enumerable.Repeat("1", count))), MemoryObservationState.Malformed);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    [InlineData(4)]
    [InlineData(5)]
    [InlineData(6)]
    [InlineData(7)]
    [InlineData(8)]
    public void RejectsNegativeOverflowAndNonDecimalInEveryField(int field)
    {
        string[] invalidNumbers = ["-1", "+1", "9223372036854775808", "18446744073709551615",
            "18446744073709551616", "1.0", "1e3", "0x10", "1kB", "x"];
        foreach (string invalid in invalidNumbers)
        {
            string[] fields = Enumerable.Repeat("1", 9).ToArray();
            fields[field] = invalid;
            AssertRejected(Parse(string.Join(' ', fields)), MemoryObservationState.Malformed);
        }
    }

    [Theory]
    [InlineData(" ")]
    [InlineData("\n")]
    [InlineData("1 2 3\n4 5 6 7 8 9")]
    [InlineData("1 2 3 4 5 6 7 8 9\n\n")]
    [InlineData("1 2 3 4 5 6 7 8 9\r\n")]
    [InlineData("1 2 3 4 5 6 7 8 9\0")]
    [InlineData("1 2 3 4 5 6 7 8 9 extra")]
    [InlineData("1\v2 3 4 5 6 7 8 9")]
    [InlineData("1\f2 3 4 5 6 7 8 9")]
    public void RejectsMalformedSingleLine(string content)
    {
        AssertRejected(Parse(content), MemoryObservationState.Malformed);
    }

    [Fact]
    public void RejectsNonAsciiBytes()
    {
        byte[] content = "1 2 3 4 5 6 7 8 9"u8.ToArray();
        content[0] = 0xff;
        AssertRejected(LinuxZramMemoryStatParser.Parse(content, LinuxZramMemoryStatParser.Linux618Layout),
            MemoryObservationState.Malformed);
    }

    [Fact]
    public void InputBoundIncludesPaddingAndFinalNewline()
    {
        const string Fields = "1 2 3 4 5 6 7 8 9\n";
        string atBound = new string(' ', LinuxZramMemoryStatParser.MaximumInputBytes - Fields.Length) + Fields;
        Assert.Equal(MemoryObservationState.Available, Parse(atBound).State);
        AssertRejected(Parse(" " + atBound), MemoryObservationState.Malformed);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("linux-6.17-mm-stat-nine-fields")]
    [InlineData("linux-6.19-mm-stat-nine-fields")]
    [InlineData("linux-6.18-mm-stat-eight-fields")]
    [InlineData("LINUX-6.18-MM-STAT-NINE-FIELDS")]
    public void UnsupportedLayoutHasNoStatistics(string? layout)
    {
        AssertRejected(LinuxZramMemoryStatParser.Parse("1 2 3 4 5 6 7 8 9"u8, layout),
            MemoryObservationState.Unknown);
    }

    [Theory]
    [InlineData(MemoryObservationState.Unknown)]
    [InlineData(MemoryObservationState.Denied)]
    [InlineData(MemoryObservationState.Stale)]
    [InlineData(MemoryObservationState.Malformed)]
    public void UnavailableCaptureStateCannotPromoteValidOrOversizedText(MemoryObservationState state)
    {
        AssertRejected(LinuxZramMemoryStatParser.Parse("1 2 3 4 5 6 7 8 9"u8,
            LinuxZramMemoryStatParser.Linux618Layout, state), state);
        AssertRejected(LinuxZramMemoryStatParser.Parse(new byte[LinuxZramMemoryStatParser.MaximumInputBytes + 1],
            LinuxZramMemoryStatParser.Linux618Layout, state), state);
    }

    [Fact]
    public void InvalidCaptureStateIsMalformed()
    {
        AssertRejected(LinuxZramMemoryStatParser.Parse("1 2 3 4 5 6 7 8 9"u8,
            LinuxZramMemoryStatParser.Linux618Layout, (MemoryObservationState)int.MaxValue),
            MemoryObservationState.Malformed);
    }

    private static LinuxZramMemoryStatCapture Parse(string content)
        => LinuxZramMemoryStatParser.Parse(Encoding.UTF8.GetBytes(content), LinuxZramMemoryStatParser.Linux618Layout);

    private static void AssertRejected(LinuxZramMemoryStatCapture result, MemoryObservationState expected)
    {
        Assert.Equal(expected, result.State);
        Assert.Null(result.Statistics);
        Assert.Equal(MemoryQualification.NotVerified, result.Qualification);
    }
}
