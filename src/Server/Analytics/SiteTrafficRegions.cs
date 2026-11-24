using System.Net.Sockets;

namespace FsusBlog.V2.Server.Analytics;

// Only an operator-supplied offline prefix map is consulted. Addresses never leave this call.
internal sealed class SiteTrafficRegions
{
    private static readonly IPNetwork[] ExcludedV4 = [.. new[] { "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8",
        "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15",
        "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/3" }.Select(IPNetwork.Parse)];
    private static readonly IPNetwork GlobalV6 = IPNetwork.Parse("2000::/3");
    private static readonly IPNetwork[] ExcludedV6 = [IPNetwork.Parse("2001::/23"), IPNetwork.Parse("2001:db8::/32"), IPNetwork.Parse("2002::/16")];
    private readonly (IPNetwork Prefix, string Region)[] entries;
    internal bool Configured { get; }

    internal SiteTrafficRegions(string? path)
    {
        if (string.IsNullOrWhiteSpace(path)) { entries = []; return; }
        using var input = File.OpenRead(path);
        var bytes = new byte[1_048_577];
        var size = input.ReadAtLeast(bytes, bytes.Length, throwOnEndOfStream: false);
        if (size == bytes.Length) throw new InvalidOperationException("Site traffic region map exceeds 1 MiB.");
        var rows = JsonSerializer.Deserialize(bytes.AsSpan(0, size), TrafficRegionJsonContext.Default.TrafficRegionEntryArray)
            ?? throw new InvalidOperationException("Site traffic region map is empty.");
        if (rows.Length is 0 or > 4096) throw new InvalidOperationException("Site traffic region map must contain 1–4096 prefixes.");
        entries = rows.Select(row =>
        {
            if (row is null || !ValidRegion(row.Region) ||
                !IPNetwork.TryParse(row.Cidr, out var prefix))
                throw new InvalidOperationException("Invalid site traffic region prefix or coarse region.");
            return (Prefix: prefix, row.Region);
        }).OrderByDescending(row => row.Prefix.PrefixLength).ToArray();
        if (entries.Select(row => row.Prefix).Distinct().Count() != entries.Length)
            throw new InvalidOperationException("Duplicate site traffic region prefix.");
        Configured = true;
    }

    internal static bool ValidRegion(string? value) => value is not null && value != "unknown" && FsusBlog.V2.Contracts.Wire.IsSiteTrafficRegion(value);

    internal static bool IsPublic(IPAddress? address)
    {
        if (address is null) return false;
        if (address.IsIPv4MappedToIPv6) address = address.MapToIPv4();
        if (address.AddressFamily == AddressFamily.InterNetwork) return !ExcludedV4.Any(prefix => prefix.Contains(address));
        return address.AddressFamily == AddressFamily.InterNetworkV6 && GlobalV6.Contains(address) &&
            !ExcludedV6.Any(prefix => prefix.Contains(address));
    }

    internal string Resolve(IPAddress address)
    {
        if (address.IsIPv4MappedToIPv6) address = address.MapToIPv4();
        foreach (var (prefix, region) in entries)
            if (prefix.Contains(address)) return region;
        return "unknown";
    }
}

internal sealed record TrafficRegionEntry(string Cidr, string Region);
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(TrafficRegionEntry[]))]
internal partial class TrafficRegionJsonContext : JsonSerializerContext;
