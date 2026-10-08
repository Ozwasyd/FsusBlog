using System.Collections.Frozen;
using System.Security.Cryptography;
using System.Text.Json;

namespace FsusBlog.Server.Infrastructure.Storage;

/// <summary>
/// Startup-validated immutable policy shared with the gateway generator.
/// Asset requests never read configuration files or build policy state.
/// </summary>
public sealed record PublicAssetDeliveryPolicy(
    string RoutePrefix,
    FrozenSet<string> Methods,
    FrozenDictionary<string, string> MediaTypes,
    long MaxFileBytes,
    int PermitLimit,
    int WindowSeconds,
    int RequestsPerSecond,
    int Burst,
    int ConnectionsPerIp,
    long RateAfterBytes,
    long RateBytesPerSecond,
    FrozenDictionary<string, string> Headers,
    string InputSha256)
{
    private static readonly Lazy<PublicAssetDeliveryPolicy> s_default = new(LoadEmbedded);

    public static PublicAssetDeliveryPolicy Default => s_default.Value;

    public static PublicAssetDeliveryPolicy Parse(ReadOnlyMemory<byte> bytes)
    {
        using JsonDocument document = JsonDocument.Parse(bytes);
        JsonElement root = document.RootElement;
        RequireKeys(root, "schemaVersion", "routePrefix", "methods", "mediaTypes", "maxFileBytes", "kestrel", "gateway", "headers");
        if (root.GetProperty("schemaVersion").GetInt32() != 1
            || root.GetProperty("routePrefix").GetString() != "/uploads/illustration")
        {
            throw Invalid();
        }
        string[] methods = [.. root.GetProperty("methods").EnumerateArray().Select(static value => value.GetString() ?? string.Empty)];
        if (methods.Length != 2 || !methods.Order(StringComparer.Ordinal).SequenceEqual(new[] { "GET", "HEAD" }))
        {
            throw Invalid();
        }
        var media = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (JsonProperty property in root.GetProperty("mediaTypes").EnumerateObject())
        {
            string? type = property.Value.GetString();
            string? expected = property.Name switch
            {
                ".png" => "image/png",
                ".jpg" or ".jpeg" => "image/jpeg",
                ".gif" => "image/gif",
                ".webp" => "image/webp",
                ".ico" => "image/x-icon",
                _ => null
            };
            if (expected is null || type != expected || !media.TryAdd(property.Name, type))
            {
                throw Invalid();
            }
        }
        if (media.Count == 0)
        {
            throw Invalid();
        }
        JsonElement kestrel = root.GetProperty("kestrel");
        JsonElement gateway = root.GetProperty("gateway");
        JsonElement headers = root.GetProperty("headers");
        RequireKeys(kestrel, "permitLimit", "windowSeconds", "queueLimit");
        RequireKeys(gateway, "requestsPerSecond", "burst", "connectionsPerIp", "rateAfterBytes", "rateBytesPerSecond");
        RequireKeys(headers, "Cache-Control", "Cross-Origin-Resource-Policy", "X-Content-Type-Options", "Accept-Ranges");
        if (kestrel.GetProperty("queueLimit").GetInt32() != 0
            || headers.GetProperty("Cache-Control").GetString() != "public,max-age=31536000,immutable"
            || headers.GetProperty("Cross-Origin-Resource-Policy").GetString() != "same-origin"
            || headers.GetProperty("X-Content-Type-Options").GetString() != "nosniff"
            || headers.GetProperty("Accept-Ranges").GetString() != "none")
        {
            throw Invalid();
        }
        return new PublicAssetDeliveryPolicy(
            root.GetProperty("routePrefix").GetString()!,
            methods.ToFrozenSet(StringComparer.Ordinal),
            media.ToFrozenDictionary(StringComparer.Ordinal),
            Positive(root, "maxFileBytes", 1 << 30),
            (int)Positive(kestrel, "permitLimit", 1000000),
            (int)Positive(kestrel, "windowSeconds", 86400),
            (int)Positive(gateway, "requestsPerSecond", 1000000),
            (int)Positive(gateway, "burst", 1000),
            (int)Positive(gateway, "connectionsPerIp", 1000000),
            Positive(gateway, "rateAfterBytes", 1L << 40),
            Positive(gateway, "rateBytesPerSecond", 1L << 40),
            headers.EnumerateObject().ToFrozenDictionary(static property => property.Name, static property => property.Value.GetString()!, StringComparer.Ordinal),
            Convert.ToHexStringLower(SHA256.HashData(bytes.Span)));
    }

    private static PublicAssetDeliveryPolicy LoadEmbedded()
    {
        using Stream stream = typeof(PublicAssetDeliveryPolicy).Assembly.GetManifestResourceStream("FsusBlog.PublicAssetDeliveryPolicy.json")
            ?? throw Invalid();
        using var buffer = new MemoryStream();
        stream.CopyTo(buffer);
        return Parse(buffer.ToArray());
    }

    private static long Positive(JsonElement value, string name, long maximum)
    {
        long number = value.GetProperty(name).GetInt64();
        return number > 0 && number <= maximum ? number : throw Invalid();
    }

    private static void RequireKeys(JsonElement value, params string[] expected)
    {
        if (value.ValueKind != JsonValueKind.Object
            || !value.EnumerateObject().Select(static property => property.Name).Order(StringComparer.Ordinal).SequenceEqual(expected.Order(StringComparer.Ordinal)))
        {
            throw Invalid();
        }
    }

    private static InvalidOperationException Invalid() => new("public_asset_delivery_policy_invalid");
}
