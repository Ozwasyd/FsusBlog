using System.Net;

namespace FsusBlog.V2.Server.Operations;

internal static class LoopbackProxy
{
    internal const string ConfigurationKey = "FSUSBLOG_TRUST_LOOPBACK_PROXY";
    private const string ForwardedFor = "X-Forwarded-For";
    private const string ForwardedProto = "X-Forwarded-Proto";

    internal static bool ReadConfiguration(IConfiguration configuration)
    {
        // The ASP.NET startup filter would otherwise process forwarded headers before this gate.
        if (IsEnabled(configuration["ForwardedHeaders_Enabled"]) ||
            IsEnabled(configuration["ASPNETCORE_FORWARDEDHEADERS_ENABLED"]) ||
            IsEnabled(configuration["DOTNET_FORWARDEDHEADERS_ENABLED"]))
            throw new InvalidOperationException("Disable automatic ASP.NET forwarded headers. Configure the FsusBlog loopback proxy explicitly.");

        var value = configuration[ConfigurationKey];
        if (value is null || string.Equals(value, "false", StringComparison.OrdinalIgnoreCase)) return false;
        if (IsEnabled(value)) return true;
        throw new InvalidOperationException($"{ConfigurationKey} must be true or false.");
    }

    internal static bool IsTrustedPeer(IPAddress? peer) => peer is not null &&
        (Normalize(peer).Equals(IPAddress.Loopback) || peer.Equals(IPAddress.IPv6Loopback));

    internal static bool TryApply(HttpContext context)
    {
        var headers = context.Request.Headers;
        var forwardedFor = headers[ForwardedFor];
        var forwardedProto = headers[ForwardedProto];
        var proto = forwardedProto.Count == 1 ? forwardedProto[0] : null;
        if (forwardedFor.Count != 1 || forwardedFor[0] is not { Length: > 0 and <= 45 } address ||
            !IPAddress.TryParse(address, out var client) ||
            (address.Contains(':') ? address.Contains('%') || address.Contains('[') : client.ToString() != address) ||
            proto is not ("https" or "http"))
            return false;

        context.Connection.RemoteIpAddress = Normalize(client);
        context.Connection.RemotePort = 0;
        context.Request.Scheme = proto;
        headers.Remove(ForwardedFor);
        headers.Remove(ForwardedProto);
        return true;
    }

    private static bool IsEnabled(string? value) => string.Equals(value, "true", StringComparison.OrdinalIgnoreCase);

    private static IPAddress Normalize(IPAddress address) => address.IsIPv4MappedToIPv6 ? address.MapToIPv4() : address;
}
