using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Platform;

namespace FsusBlog.Server.Infrastructure.Memory.Pressure;

public enum LinuxCgroupCounter
{
    AnonymousBytes, FileBytes, MajorFaults, LocalHighEvents, LocalMaxEvents,
    LocalOutOfMemoryEvents, LocalOutOfMemoryKillEvents, PressureSomeMicroseconds, PressureFullMicroseconds
}

public enum LinuxCgroupCounterUnit
{
    Bytes, Events, Microseconds
}

public sealed record LinuxCgroupCounterCapture(LinuxCgroupCounter Counter, LinuxCgroupCounterUnit Unit,
    MemoryObservationState State, long? Value, LinuxCgroupDirectoryIdentity Identity)
{
    public MemoryQualification Qualification => MemoryQualification.NotVerified;
}

/// <summary>
/// Parses selected v2 native keys without assigning swap activity, thrashing or
/// headroom meaning. Event files are explicitly local; PSI totals retain microsecond
/// units. Missing or unrecognized target formats remain unavailable, never zero.
/// </summary>
public static class LinuxCgroupCounterParser
{
    internal static string FileName(LinuxCgroupCounter counter) => counter switch
    {
        LinuxCgroupCounter.AnonymousBytes or LinuxCgroupCounter.FileBytes or LinuxCgroupCounter.MajorFaults => "memory.stat",
        LinuxCgroupCounter.PressureSomeMicroseconds or LinuxCgroupCounter.PressureFullMicroseconds => "memory.pressure",
        _ => "memory.events.local"
    };

    internal static LinuxCgroupCounterUnit Unit(LinuxCgroupCounter counter) => counter switch
    {
        LinuxCgroupCounter.AnonymousBytes or LinuxCgroupCounter.FileBytes => LinuxCgroupCounterUnit.Bytes,
        LinuxCgroupCounter.PressureSomeMicroseconds or LinuxCgroupCounter.PressureFullMicroseconds => LinuxCgroupCounterUnit.Microseconds,
        _ => LinuxCgroupCounterUnit.Events
    };

    internal static LinuxCgroupCounterCapture Parse(ReadOnlySpan<byte> content, LinuxCgroupCounter counter,
        LinuxCgroupDirectoryIdentity identity)
    {
        ArgumentNullException.ThrowIfNull(identity);
        if (!Enum.IsDefined(counter))
        {
            throw new ArgumentOutOfRangeException(nameof(counter));
        }
        if (identity.Version != 2)
        {
            return Result(MemoryObservationState.Unknown, null);
        }
        ReadOnlySpan<byte> key = counter switch
        {
            LinuxCgroupCounter.AnonymousBytes => "anon"u8,
            LinuxCgroupCounter.FileBytes => "file"u8,
            LinuxCgroupCounter.MajorFaults => "pgmajfault"u8,
            LinuxCgroupCounter.LocalHighEvents => "high"u8,
            LinuxCgroupCounter.LocalMaxEvents => "max"u8,
            LinuxCgroupCounter.LocalOutOfMemoryEvents => "oom"u8,
            LinuxCgroupCounter.LocalOutOfMemoryKillEvents => "oom_kill"u8,
            LinuxCgroupCounter.PressureSomeMicroseconds => "some"u8,
            _ => "full"u8
        };
        bool pressure = Unit(counter) == LinuxCgroupCounterUnit.Microseconds;
        bool found = false;
        long? value = null;
        foreach (Range range in content.Split((byte)'\n'))
        {
            ReadOnlySpan<byte> line = content[range].Trim(" \t\r"u8);
            int split = line.IndexOfAny((byte)' ', (byte)'\t');
            if (split < 0)
            {
                if (line.SequenceEqual(key))
                {
                    return Result(MemoryObservationState.Malformed, null);
                }
                continue;
            }
            if (!line[..split].SequenceEqual(key))
            {
                continue;
            }
            if (found)
            {
                return Result(MemoryObservationState.Malformed, null);
            }
            found = true;
            ReadOnlySpan<byte> number = line[(split + 1)..].Trim(" \t"u8);
            if (pressure)
            {
                value = ParsePressure(number, identity);
                if (value is null)
                {
                    return Result(MemoryObservationState.Malformed, null);
                }
            }
            else
            {
                var scalar = LinuxCgroupDirectoryReader.ParseScalar(number, false, identity);
                if (scalar.State != MemoryObservationState.Available)
                {
                    return Result(MemoryObservationState.Malformed, null);
                }
                value = scalar.Value;
            }
        }
        return Result(found ? MemoryObservationState.Available : MemoryObservationState.Unknown, value);

        LinuxCgroupCounterCapture Result(MemoryObservationState state, long? number)
            => new(counter, Unit(counter), state, number, identity);
    }

    private static long? ParsePressure(ReadOnlySpan<byte> fields, LinuxCgroupDirectoryIdentity identity)
    {
        int seen = 0;
        long? total = null;
        foreach (Range range in fields.Split((byte)' '))
        {
            ReadOnlySpan<byte> token = fields[range];
            if (token.IsEmpty)
            {
                continue;
            }
            int equals = token.IndexOf((byte)'=');
            if (equals < 0)
            {
                return null;
            }
            ReadOnlySpan<byte> key = token[..equals];
            int bit = key.SequenceEqual("avg10"u8) ? 1 : key.SequenceEqual("avg60"u8) ? 2
                : key.SequenceEqual("avg300"u8) ? 4 : key.SequenceEqual("total"u8) ? 8 : 0;
            if (bit == 0 || (seen & bit) != 0)
            {
                return null;
            }
            seen |= bit;
            ReadOnlySpan<byte> number = token[(equals + 1)..];
            if (bit == 8)
            {
                total = LinuxCgroupDirectoryReader.ParseScalar(number, false, identity).Value;
                if (total is null)
                {
                    return null;
                }
            }
            else
            {
                int point = number.IndexOf((byte)'.');
                if (point <= 0 || number.Length - point != 3 || number[point + 1] is < (byte)'0' or > (byte)'9'
                    || number[point + 2] is < (byte)'0' or > (byte)'9')
                {
                    return null;
                }
                long? whole = LinuxCgroupDirectoryReader.ParseScalar(number[..point], false, identity).Value;
                if (whole is null or > 100 || whole == 100 && !number[(point + 1)..].SequenceEqual("00"u8))
                {
                    return null;
                }
            }
        }
        return seen == 15 ? total : null;
    }
}
