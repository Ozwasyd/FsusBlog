using FsusBlog.Server.Infrastructure.Memory.Contracts;

namespace FsusBlog.Server.Infrastructure.Memory.Pressure;

/// <summary>
/// Parses caller-supplied /proc/vmstat counters independently. Swap counts retain
/// pages; major faults retain events. These cumulative host counters establish
/// neither a sampling interval nor anonymous swap thrashing or process pressure.
/// </summary>
internal static class LinuxVmStatActivityParser
{
    internal readonly record struct Counter(MemoryObservationState State, long? Value);

    internal readonly record struct Activity(Counter SwapInPages, Counter SwapOutPages, Counter MajorFaultEvents);

    internal readonly record struct SwapByteCounts(Counter SwapInBytes, Counter SwapOutBytes);

    // FORMAT: Linux 6.18 source 7d0a66e4bb9081d75c82ec4957c50034cb0ea449,
    // mm/vmstat.c vmstat_text/vmstat_show and mm/page_io.c swap event accounting.
    // Values outside the existing signed observation range remain malformed.
    internal static Activity Parse(ReadOnlySpan<byte> content)
    {
        Counter swapIn = default;
        Counter swapOut = default;
        Counter majorFaults = default;
        bool foundSwapIn = false;
        bool foundSwapOut = false;
        bool foundMajorFaults = false;
        foreach (Range range in content.Split((byte)'\n'))
        {
            ReadOnlySpan<byte> line = content[range].Trim(" \t\r"u8);
            int split = line.IndexOfAny((byte)' ', (byte)'\t');
            ReadOnlySpan<byte> key = split < 0 ? line : line[..split];
            ReadOnlySpan<byte> number = split < 0 ? default : line[(split + 1)..].Trim(" \t"u8);
            if (key.SequenceEqual("pswpin"u8))
            {
                ReadCounter(ref swapIn, ref foundSwapIn, number);
            }
            else if (key.SequenceEqual("pswpout"u8))
            {
                ReadCounter(ref swapOut, ref foundSwapOut, number);
            }
            else if (key.SequenceEqual("pgmajfault"u8))
            {
                ReadCounter(ref majorFaults, ref foundMajorFaults, number);
            }
        }
        return new(swapIn, swapOut, majorFaults);
    }

    /// <summary>
    /// Converts only the swap page counters using an explicit positive page size.
    /// Missing or malformed counters remain unavailable; an overflowing conversion
    /// is malformed independently of the other counter and preserves the raw input.
    /// </summary>
    internal static SwapByteCounts ConvertSwapPagesToBytes(Activity activity, long pageSizeBytes)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(pageSizeBytes);
        return new(Convert(activity.SwapInPages), Convert(activity.SwapOutPages));

        Counter Convert(Counter pages)
        {
            if (pages.State != MemoryObservationState.Available)
            {
                return new(pages.State, null);
            }
            if (pages.Value is not long value || value < 0 || value > long.MaxValue / pageSizeBytes)
            {
                return new(MemoryObservationState.Malformed, null);
            }
            return new(MemoryObservationState.Available, checked(value * pageSizeBytes));
        }
    }

    private static void ReadCounter(ref Counter counter, ref bool found, ReadOnlySpan<byte> number)
    {
        bool duplicate = found;
        found = true;
        counter = new(MemoryObservationState.Malformed, null);
        if (duplicate || number.IsEmpty)
        {
            return;
        }
        long value = 0;
        foreach (byte digit in number)
        {
            if (digit is < (byte)'0' or > (byte)'9')
            {
                return;
            }
            int decimalDigit = digit - (byte)'0';
            if (value > (long.MaxValue - decimalDigit) / 10)
            {
                return;
            }
            value = value * 10 + decimalDigit;
        }
        counter = new(MemoryObservationState.Available, value);
    }
}
