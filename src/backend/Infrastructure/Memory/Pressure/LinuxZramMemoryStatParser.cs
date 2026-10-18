using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;

namespace FsusBlog.Server.Infrastructure.Memory.Pressure;

/// <summary>
/// Retains the five byte quantities and four page counts emitted by mm_stat.
/// Allocated bytes include allocator overhead; peak and compressed bytes are
/// separate quantities. A zero limit denotes no configured zram memory limit.
/// SamePages counts same-element pages; PagesCompacted counts pages freed during
/// compaction. HugePages counts current incompressible pages; HugePagesSince
/// counts incompressible pages since device setup.
/// </summary>
public sealed record LinuxZramMemoryStat(long OriginalDataBytes, long CompressedDataBytes,
    long AllocatedBytes, long LimitBytes, long PeakAllocatedBytes, long SamePages,
    long PagesCompacted, long HugePages, long HugePagesSince);

/// <summary>
/// Reports parsing of captured text only. Available denotes valid syntax, without
/// device identity, sampling freshness, physical headroom or runtime qualification.
/// Rejected or unavailable input carries no statistics.
/// </summary>
public sealed record LinuxZramMemoryStatCapture(MemoryObservationState State, LinuxZramMemoryStat? Statistics)
{
    public MemoryQualification Qualification => MemoryQualification.NotVerified;
}

/// <summary>
/// Parses only the explicitly selected Linux 6.18 nine-field mm_stat layout.
/// The caller owns capture and layout selection; this parser performs no I/O or
/// discovery and derives no headroom. Values must fit the existing signed memory
/// observation range. Page counts are retained without assuming a page size.
/// </summary>
public static class LinuxZramMemoryStatParser
{
    public const string Linux618Layout = "linux-6.18-mm-stat-nine-fields";
    public const int MaximumInputBytes = 256;
    private const int FieldCount = 9;

    // Field order and units are pinned to mm_stat_show and the mm_stat documentation:
    // https://github.com/torvalds/linux/blob/7d0a66e4bb9081d75c82ec4957c50034cb0ea449/drivers/block/zram/zram_drv.c
    // https://github.com/torvalds/linux/blob/7d0a66e4bb9081d75c82ec4957c50034cb0ea449/Documentation/admin-guide/blockdev/zram.rst
    public static LinuxZramMemoryStatCapture Parse(ReadOnlySpan<byte> content, string? layout,
        MemoryObservationState contentState = MemoryObservationState.Available)
    {
        if (!Enum.IsDefined(contentState))
        {
            return new(MemoryObservationState.Malformed, null);
        }
        if (contentState != MemoryObservationState.Available)
        {
            return new(contentState, null);
        }
        if (!string.Equals(layout, Linux618Layout, StringComparison.Ordinal))
        {
            return new(MemoryObservationState.Unknown, null);
        }
        if (content.Length > MaximumInputBytes)
        {
            return new(MemoryObservationState.Malformed, null);
        }

        // sysfs emits one line with optional left padding and a final LF.
        if (!content.IsEmpty && content[^1] == (byte)'\n')
        {
            content = content[..^1];
        }
        Span<long> values = stackalloc long[FieldCount];
        int position = 0;
        int field = 0;
        while (position < content.Length)
        {
            if (content[position] is (byte)' ' or (byte)'\t')
            {
                position++;
                continue;
            }
            if (field == FieldCount)
            {
                return new(MemoryObservationState.Malformed, null);
            }

            long value = 0;
            do
            {
                byte digit = content[position];
                if (digit is < (byte)'0' or > (byte)'9'
                    || value > (long.MaxValue - (digit - (byte)'0')) / 10)
                {
                    return new(MemoryObservationState.Malformed, null);
                }
                value = value * 10 + digit - (byte)'0';
                position++;
            }
            while (position < content.Length && content[position] is not ((byte)' ' or (byte)'\t'));
            values[field++] = value;
        }
        if (field != FieldCount)
        {
            return new(MemoryObservationState.Malformed, null);
        }

        return new(MemoryObservationState.Available, new(values[0], values[1], values[2],
            values[3], values[4], values[5], values[6], values[7], values[8]));
    }
}
