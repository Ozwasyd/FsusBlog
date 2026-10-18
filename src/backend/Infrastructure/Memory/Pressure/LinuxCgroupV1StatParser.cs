using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Platform;

namespace FsusBlog.Server.Infrastructure.Memory.Pressure;

public enum LinuxCgroupV1StatScope
{
    Local, HierarchicalTotal, HierarchicalLimit
}

/// <summary>
/// A raw v1 statistic with its exact native key, scope, unit and caller-supplied
/// directory identity. Available describes parsing only; it grants no qualification.
/// </summary>
public sealed record LinuxCgroupV1StatCapture(string Key, LinuxCgroupV1StatScope Scope,
    LinuxCgroupCounterUnit Unit, MemoryObservationState State, long? Value,
    LinuxCgroupDirectoryIdentity Identity)
{
    public MemoryQualification Qualification => MemoryQualification.NotVerified;
}

/// <summary>
/// Parses caller-supplied memory.stat bytes without reading files or authorizing
/// admission. Native rss includes anonymous pages and swap cache, not v2 anon.
/// Semantics follow Linux commit 7d0a66e4bb9081d75c82ec4957c50034cb0ea449,
/// Documentation/admin-guide/cgroup-v1/memory.rst section 5.2; fault events and
/// additional emitted keys follow mm/memcontrol-v1.c at the same commit.
/// </summary>
public static class LinuxCgroupV1StatParser
{
    public const int MaximumInputBytes = 16 * 1024;

    /// <summary>
    /// Selects one supported native key, keeping local, total_* and hierarchy limits
    /// distinct. Missing keys or non-v1 identities remain Unknown. Oversized input,
    /// duplicate target keys or malformed key/decimal rows return Malformed without
    /// a value. All rows, including future keys, must contain nonnegative Int64 values.
    /// Invalid selectors and null identities throw argument exceptions.
    /// </summary>
    public static LinuxCgroupV1StatCapture Parse(ReadOnlySpan<byte> content, string key,
        LinuxCgroupDirectoryIdentity identity)
    {
        ArgumentException.ThrowIfNullOrEmpty(key);
        ArgumentNullException.ThrowIfNull(identity);
        var (scope, unit) = Describe(key);
        if (content.Length > MaximumInputBytes)
        {
            return Result(MemoryObservationState.Malformed, null);
        }
        if (identity.Version != 1)
        {
            return Result(MemoryObservationState.Unknown, null);
        }

        bool found = false;
        long? value = null;
        foreach (Range range in content.Split((byte)'\n'))
        {
            ReadOnlySpan<byte> line = content[range];
            if (line.EndsWith("\r"u8))
            {
                line = line[..^1];
            }
            line = line.Trim(" \t"u8);
            if (line.IsEmpty)
            {
                continue;
            }

            int split = line.IndexOfAny((byte)' ', (byte)'\t');
            if (split <= 0 || !ValidKey(line[..split])
                || !TryParseNumber(line[(split + 1)..].Trim(" \t"u8), out long number))
            {
                return Result(MemoryObservationState.Malformed, null);
            }
            ReadOnlySpan<byte> nativeKey = line[..split];
            if (!Matches(nativeKey, key))
            {
                continue;
            }
            if (found)
            {
                return Result(MemoryObservationState.Malformed, null);
            }
            found = true;
            value = number;
        }
        return Result(found ? MemoryObservationState.Available : MemoryObservationState.Unknown, value);

        LinuxCgroupV1StatCapture Result(MemoryObservationState state, long? number)
            => new(key, scope, unit, state, number, identity);
    }

    private static (LinuxCgroupV1StatScope Scope, LinuxCgroupCounterUnit Unit) Describe(string key)
    {
        if (key is "hierarchical_memory_limit" or "hierarchical_memsw_limit")
        {
            return (LinuxCgroupV1StatScope.HierarchicalLimit, LinuxCgroupCounterUnit.Bytes);
        }
        bool total = key.StartsWith("total_", StringComparison.Ordinal);
        ReadOnlySpan<char> counter = total ? key.AsSpan(6) : key.AsSpan();
        LinuxCgroupCounterUnit unit = counter switch
        {
            "cache" or "rss" or "rss_huge" or "shmem" or "mapped_file" or "swap" or "swapcached"
                or "dirty" or "writeback" or "inactive_anon" or "active_anon" or "inactive_file"
                or "active_file" or "unevictable" => LinuxCgroupCounterUnit.Bytes,
            "pgpgin" or "pgpgout" or "pgfault" or "pgmajfault" or "workingset_refault_anon"
                or "workingset_refault_file" => LinuxCgroupCounterUnit.Events,
            _ => throw new ArgumentException("Expected a supported native cgroup v1 memory.stat key.", nameof(key))
        };
        return (total ? LinuxCgroupV1StatScope.HierarchicalTotal : LinuxCgroupV1StatScope.Local, unit);
    }

    private static bool ValidKey(ReadOnlySpan<byte> key)
    {
        foreach (byte character in key)
        {
            if (character is not (>= (byte)'a' and <= (byte)'z')
                and not (>= (byte)'0' and <= (byte)'9') and not (byte)'_')
            {
                return false;
            }
        }
        return key[0] is >= (byte)'a' and <= (byte)'z';
    }

    private static bool Matches(ReadOnlySpan<byte> nativeKey, string key)
    {
        if (nativeKey.Length != key.Length)
        {
            return false;
        }
        for (int index = 0; index < key.Length; index++)
        {
            if (nativeKey[index] != key[index])
            {
                return false;
            }
        }
        return true;
    }

    private static bool TryParseNumber(ReadOnlySpan<byte> number, out long value)
    {
        value = 0;
        if (number.IsEmpty)
        {
            return false;
        }
        foreach (byte character in number)
        {
            if (character is < (byte)'0' or > (byte)'9')
            {
                return false;
            }
            int digit = character - (byte)'0';
            if (value > (long.MaxValue - digit) / 10)
            {
                return false;
            }
            value = value * 10 + digit;
        }
        return true;
    }
}
