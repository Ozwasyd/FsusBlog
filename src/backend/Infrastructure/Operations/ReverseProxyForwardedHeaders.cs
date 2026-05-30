using System.Net;
using Microsoft.AspNetCore.HttpOverrides;
using NetIPNetwork = System.Net.IPNetwork;

namespace FsusBlog.Server.Infrastructure.Operations;

internal static class ReverseProxyForwardedHeaders
{
    public const string KnownProxiesKey = "ReverseProxy:KnownProxies";
    public const string KnownNetworksKey = "ReverseProxy:KnownNetworks";

    public static void Configure(
        ForwardedHeadersOptions options,
        IConfiguration configuration,
        bool isProduction)
    {
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(configuration);

        options.ForwardedHeaders =
            ForwardedHeaders.XForwardedFor
            | ForwardedHeaders.XForwardedProto
            | ForwardedHeaders.XForwardedHost;

        string[] proxyValues = ReadConfiguredList(configuration, KnownProxiesKey);
        string[] networkValues = ReadConfiguredList(configuration, KnownNetworksKey);
        bool hasExplicitTrust = proxyValues.Length > 0 || networkValues.Length > 0;

        options.KnownIPNetworks.Clear();
        options.KnownProxies.Clear();

        if (!isProduction && !hasExplicitTrust)
        {
            return;
        }

        foreach (string proxyValue in proxyValues)
        {
            if (!TryParseKnownProxy(proxyValue, out IPAddress? address))
            {
                throw new InvalidOperationException($"{KnownProxiesKey} contains an invalid IP address: {proxyValue}");
            }

            options.KnownProxies.Add(address!);
        }

        foreach (string networkValue in networkValues)
        {
            if (!TryParseKnownNetwork(networkValue, out NetIPNetwork network))
            {
                throw new InvalidOperationException($"{KnownNetworksKey} contains an invalid CIDR: {networkValue}");
            }

            options.KnownIPNetworks.Add(network);
        }
    }

    internal static string[] ReadConfiguredList(IConfiguration configuration, string key)
    {
        string? directValue = configuration[key];
        IEnumerable<string> directValues = string.IsNullOrWhiteSpace(directValue)
            ? []
            : SplitList(directValue);

        IEnumerable<string> childValues = configuration
            .GetSection(key)
            .GetChildren()
            .Select(static child => child.Value)
            .Where(static value => !string.IsNullOrWhiteSpace(value))
            .SelectMany(static value => SplitList(value!));

        return directValues
            .Concat(childValues)
            .Select(static value => value.Trim())
            .Where(static value => value.Length > 0)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    internal static bool TryParseKnownProxy(string value, out IPAddress? address)
    {
        address = null;
        if (!IPAddress.TryParse(value, out IPAddress? parsed))
        {
            return false;
        }

        if (IPAddress.Any.Equals(parsed) || IPAddress.IPv6Any.Equals(parsed))
        {
            return false;
        }

        address = parsed;
        return true;
    }

    internal static bool TryParseKnownNetwork(string value, out NetIPNetwork network)
    {
        network = default;
        if (!NetIPNetwork.TryParse(value, out NetIPNetwork parsed))
        {
            return false;
        }

        if (parsed.PrefixLength == 0
            && (IPAddress.Any.Equals(parsed.BaseAddress) || IPAddress.IPv6Any.Equals(parsed.BaseAddress)))
        {
            return false;
        }

        network = parsed;
        return true;
    }

    private static string[] SplitList(string value)
        => value.Split([',', ';'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
}
