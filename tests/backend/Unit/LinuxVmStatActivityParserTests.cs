using System.Text;

using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Pressure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class LinuxVmStatActivityParserTests
{
    [Fact]
    public void ReorderedFieldsPreserveIndependentNativeCounts()
    {
        var actual = LinuxVmStatActivityParser.Parse(
            "future not-a-counter\npgmajfault 91\npswpout 7\npswpin 3\n"u8);
        AssertCounter(actual.SwapInPages, MemoryObservationState.Available, 3);
        AssertCounter(actual.SwapOutPages, MemoryObservationState.Available, 7);
        AssertCounter(actual.MajorFaultEvents, MemoryObservationState.Available, 91);
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
    public void EveryMissingFieldRemainsUnknownWhileExplicitZeroIsAvailable(int presentFields)
    {
        string content = ((presentFields & 1) != 0 ? "pswpin 0\n" : "")
            + ((presentFields & 2) != 0 ? "pswpout 0\n" : "")
            + ((presentFields & 4) != 0 ? "pgmajfault 0\n" : "");
        var actual = LinuxVmStatActivityParser.Parse(Encoding.UTF8.GetBytes(content));
        AssertPresence(actual.SwapInPages, (presentFields & 1) != 0);
        AssertPresence(actual.SwapOutPages, (presentFields & 2) != 0);
        AssertPresence(actual.MajorFaultEvents, (presentFields & 4) != 0);
    }

    [Theory]
    [InlineData("pswpin 0003\npswpout 0\npgmajfault 9223372036854775807", 3L, 0L, long.MaxValue)]
    [InlineData("\r\n  pswpin\t13\t\r\npswpout   17\r\npgmajfault 19\n\n", 13L, 17L, 19L)]
    [InlineData("pswpin 9223372036854775807\npswpout 9223372036854775807\npgmajfault 0\n", long.MaxValue, long.MaxValue, 0L)]
    public void DecimalRangeWhitespaceAndFinalLineAreHandled(string content, long swapIn, long swapOut, long majorFaults)
    {
        var actual = LinuxVmStatActivityParser.Parse(Encoding.UTF8.GetBytes(content));
        AssertCounter(actual.SwapInPages, MemoryObservationState.Available, swapIn);
        AssertCounter(actual.SwapOutPages, MemoryObservationState.Available, swapOut);
        AssertCounter(actual.MajorFaultEvents, MemoryObservationState.Available, majorFaults);
    }

    public static IEnumerable<object[]> MalformedFields()
    {
        string[] fields = ["pswpin", "pswpout", "pgmajfault"];
        string[] values = ["", "-1", "+1", "1.0", "0x10", "1,000", "1 kB", "1 2", "1\t2", "max",
            "9223372036854775808", "18446744073709551615", "18446744073709551616", "\u0661", "1\0"];
        foreach (string field in fields)
        {
            foreach (string value in values)
            {
                yield return [field, field + " " + value];
            }
            yield return [field, field];
            yield return [field, field + " 0\n" + field + " 0"];
            yield return [field, field + " invalid\n" + field + " 1"];
            yield return [field, field + " 1\n" + field + " 2\n" + field + " 3"];
        }
    }

    [Theory]
    [MemberData(nameof(MalformedFields))]
    public void InvalidOrDuplicateTargetOnlyInvalidatesThatField(string field, string malformedLines)
    {
        string content = (field != "pswpin" ? "pswpin 11\n" : "")
            + (field != "pswpout" ? "pswpout 13\n" : "")
            + (field != "pgmajfault" ? "pgmajfault 17\n" : "")
            + malformedLines + "\n";
        var actual = LinuxVmStatActivityParser.Parse(Encoding.UTF8.GetBytes(content));
        AssertSelected(actual.SwapInPages, field == "pswpin", 11);
        AssertSelected(actual.SwapOutPages, field == "pswpout", 13);
        AssertSelected(actual.MajorFaultEvents, field == "pgmajfault", 17);
    }

    [Fact]
    public void MajorFaultsAndOccupancyNeverSupplyMissingSwapActivity()
    {
        var actual = LinuxVmStatActivityParser.Parse(
            "pgmajfault 99\npgpgin 1024\npgfault 100\nVmSwap 8192\nSwapTotal 16384\nSwapFree 0\n"u8);
        AssertCounter(actual.SwapInPages, MemoryObservationState.Unknown, null);
        AssertCounter(actual.SwapOutPages, MemoryObservationState.Unknown, null);
        AssertCounter(actual.MajorFaultEvents, MemoryObservationState.Available, 99);
        var converted = LinuxVmStatActivityParser.ConvertSwapPagesToBytes(actual, 4096);
        AssertCounter(converted.SwapInBytes, MemoryObservationState.Unknown, null);
        AssertCounter(converted.SwapOutBytes, MemoryObservationState.Unknown, null);
    }

    [Fact]
    public void OnlyExactCaseSensitiveKeysAreSelected()
    {
        var actual = LinuxVmStatActivityParser.Parse(
            "PSWPIN 1\npswpin_extra 2\npswpout: 3\npgmajfault_extra 4\nxpgmajfault 5\n"u8);
        Assert.Equal(default, actual);
    }

    [Theory]
    [InlineData(1L)]
    [InlineData(4096L)]
    [InlineData(65536L)]
    public void ByteConversionUsesExplicitPageSizeAndLeavesMajorFaultsAsEvents(long pageSizeBytes)
    {
        var activity = LinuxVmStatActivityParser.Parse("pswpin 3\npswpout 7\npgmajfault 91\n"u8);
        var converted = LinuxVmStatActivityParser.ConvertSwapPagesToBytes(activity, pageSizeBytes);
        AssertCounter(converted.SwapInBytes, MemoryObservationState.Available, 3 * pageSizeBytes);
        AssertCounter(converted.SwapOutBytes, MemoryObservationState.Available, 7 * pageSizeBytes);
        AssertCounter(activity.SwapInPages, MemoryObservationState.Available, 3);
        AssertCounter(activity.SwapOutPages, MemoryObservationState.Available, 7);
        AssertCounter(activity.MajorFaultEvents, MemoryObservationState.Available, 91);
    }

    [Theory]
    [InlineData(0L)]
    [InlineData(-1L)]
    [InlineData(long.MinValue)]
    public void NonpositivePageSizeIsRejectedEvenForMissingCounters(long pageSizeBytes)
    {
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            LinuxVmStatActivityParser.ConvertSwapPagesToBytes(default, pageSizeBytes));
    }

    [Theory]
    [InlineData(1L)]
    [InlineData(4096L)]
    [InlineData(65536L)]
    [InlineData(long.MaxValue)]
    public void ConversionChecksExactSignedByteBoundary(long pageSizeBytes)
    {
        long maximumPages = long.MaxValue / pageSizeBytes;
        string content = $"pswpin {maximumPages}\npswpout 0\n";
        var converted = LinuxVmStatActivityParser.ConvertSwapPagesToBytes(
            LinuxVmStatActivityParser.Parse(Encoding.UTF8.GetBytes(content)), pageSizeBytes);
        AssertCounter(converted.SwapInBytes, MemoryObservationState.Available, maximumPages * pageSizeBytes);
        AssertCounter(converted.SwapOutBytes, MemoryObservationState.Available, 0);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void ConversionOverflowOnlyInvalidatesTheAffectedDirection(bool overflowSwapIn)
    {
        const long PageSize = 4096;
        long overflowPages = long.MaxValue / PageSize + 1;
        string content = overflowSwapIn ? $"pswpin {overflowPages}\npswpout 1\npgmajfault 9\n"
            : $"pswpin 1\npswpout {overflowPages}\npgmajfault 9\n";
        var activity = LinuxVmStatActivityParser.Parse(Encoding.UTF8.GetBytes(content));
        var converted = LinuxVmStatActivityParser.ConvertSwapPagesToBytes(activity, PageSize);
        AssertSelected(converted.SwapInBytes, overflowSwapIn, PageSize);
        AssertSelected(converted.SwapOutBytes, !overflowSwapIn, PageSize);
        AssertCounter(activity.SwapInPages, MemoryObservationState.Available, overflowSwapIn ? overflowPages : 1);
        AssertCounter(activity.SwapOutPages, MemoryObservationState.Available, overflowSwapIn ? 1 : overflowPages);
        AssertCounter(activity.MajorFaultEvents, MemoryObservationState.Available, 9);
    }

    [Fact]
    public void ConversionPreservesMissingAndMalformedStates()
    {
        var activity = LinuxVmStatActivityParser.Parse("pswpout -1\npgmajfault 0\n"u8);
        var converted = LinuxVmStatActivityParser.ConvertSwapPagesToBytes(activity, 4096);
        AssertCounter(converted.SwapInBytes, MemoryObservationState.Unknown, null);
        AssertCounter(converted.SwapOutBytes, MemoryObservationState.Malformed, null);
        AssertCounter(activity.MajorFaultEvents, MemoryObservationState.Available, 0);
    }

    private static void AssertPresence(LinuxVmStatActivityParser.Counter actual, bool present)
        => AssertCounter(actual, present ? MemoryObservationState.Available : MemoryObservationState.Unknown, present ? 0 : null);

    private static void AssertSelected(LinuxVmStatActivityParser.Counter actual, bool malformed, long validValue)
        => AssertCounter(actual, malformed ? MemoryObservationState.Malformed : MemoryObservationState.Available,
            malformed ? null : validValue);

    private static void AssertCounter(LinuxVmStatActivityParser.Counter actual, MemoryObservationState state, long? value)
    {
        Assert.Equal(state, actual.State);
        Assert.Equal(value, actual.Value);
    }
}
