using System.Globalization;

using FsusBlog.Server.Infrastructure.Memory.Capabilities;

namespace FsusBlog.Server.Infrastructure.Memory.Platform;

internal sealed record OsNumaTopologyObservation(MemoryDetection Detection,
    IReadOnlyList<int> OnlineNodes, IReadOnlyList<int>? AllowedNodes,
    string Source, DateTimeOffset SampledAt, string Reason)
{
    public bool CanTarget(int node) => AllowedNodes is not null
        && OnlineNodes.Contains(node) && AllowedNodes.Contains(node);
}

// OBSERVATION: Linux kernel node IDs and process memory-node restrictions are
// separate facts. CPU chiplets, processor count and cpulists are not NUMA nodes.
// No affinity is applied, and callers must reobserve after domain migration.
internal static class OsNumaTopologySource
{
    private const int MaximumCharacters = 65536;
    private const int MaximumNodes = 4096;

    public static OsNumaTopologyObservation Observe(MemoryCapabilityMode mode = MemoryCapabilityMode.Auto)
    {
        DateTimeOffset sampledAt = DateTimeOffset.UtcNow;
        if (MemoryCapabilityPolicy.Validate(mode) == MemoryCapabilityMode.Disabled)
        {
            return new(MemoryDetection.Unknown, Array.Empty<int>(), null,
                "os-numa", sampledAt, "Disabled; no NUMA source probes attempted.");
        }
        if (!OperatingSystem.IsLinux())
        {
            return new(MemoryDetection.Unsupported, Array.Empty<int>(), null,
                "os-numa", sampledAt, "No verified NUMA observation adapter for this OS.");
        }
        try
        {
            string before = ReadBounded("/sys/devices/system/node/online");
            string status = ReadBounded("/proc/self/status");
            string after = ReadBounded("/sys/devices/system/node/online");
            if (!StringComparer.Ordinal.Equals(before, after))
            {
                return new(MemoryDetection.Unknown, Array.Empty<int>(), null,
                    "linux-sysfs/proc-status", sampledAt, "Topology changed during sampling.");
            }
            return Parse(before, status, sampledAt);
        }
        catch (IOException exception)
        {
            return Unavailable(sampledAt, exception.GetType().Name);
        }
        catch (UnauthorizedAccessException exception)
        {
            return Unavailable(sampledAt, exception.GetType().Name);
        }
    }

    internal static OsNumaTopologyObservation Parse(string online, string processStatus, DateTimeOffset sampledAt)
    {
        const string AllowedPrefix = "Mems_allowed_list:";
        if (processStatus.Length > MaximumCharacters || !TryParseNodeList(online, out int[] onlineNodes))
        {
            return Unavailable(sampledAt, "Malformed or missing online NUMA node list.");
        }
        string[] lines = processStatus.Split('\n')
            .Where(line => line.StartsWith(AllowedPrefix, StringComparison.Ordinal)).Take(2).ToArray();
        if (lines.Length != 1 || !TryParseNodeList(lines[0][AllowedPrefix.Length..], out int[] allowed))
        {
            return new(MemoryDetection.Present, Array.AsReadOnly(onlineNodes), null,
                "linux-sysfs/proc-status", sampledAt, "Allowed memory nodes are unknown; placement denied.");
        }
        // Offline or externally disallowed nodes are never targetable.
        int[] allowedOnline = allowed.Intersect(onlineNodes).ToArray();
        return new(MemoryDetection.Present, Array.AsReadOnly(onlineNodes), Array.AsReadOnly(allowedOnline),
            "linux-sysfs/proc-status", sampledAt,
            onlineNodes.Length == 1 ? "Single NUMA node observed." : "Multiple NUMA nodes observed.");
    }

    internal static bool TryParseNodeList(string value, out int[] nodes)
    {
        nodes = Array.Empty<int>();
        if (value.Length > MaximumCharacters || string.IsNullOrWhiteSpace(value))
        {
            return false;
        }
        var result = new SortedSet<int>();
        foreach (string item in value.Trim().Split(','))
        {
            string[] endpoints = item.Split('-');
            if (endpoints.Length is < 1 or > 2
                || !int.TryParse(endpoints[0], NumberStyles.None, CultureInfo.InvariantCulture, out int first)
                || first < 0 || first >= MaximumNodes)
            {
                return false;
            }
            int last = first;
            if (endpoints.Length == 2
                && (!int.TryParse(endpoints[1], NumberStyles.None, CultureInfo.InvariantCulture, out last)
                    || last < first || last >= MaximumNodes))
            {
                return false;
            }
            for (int node = first; node <= last; node++)
            {
                if (!result.Add(node))
                {
                    return false;
                }
            }
        }
        nodes = result.ToArray();
        return nodes.Length > 0;
    }

    private static string ReadBounded(string path)
    {
        using var reader = new StreamReader(path);
        var buffer = new char[MaximumCharacters + 1];
        int read = reader.ReadBlock(buffer, 0, buffer.Length);
        if (read > MaximumCharacters)
        {
            throw new IOException("OS topology observation exceeds the finite bound.");
        }
        return new string(buffer, 0, read);
    }

    private static OsNumaTopologyObservation Unavailable(DateTimeOffset sampledAt, string reason)
        => new(MemoryDetection.Unknown, Array.Empty<int>(), null,
            "linux-sysfs/proc-status", sampledAt, reason);
}
