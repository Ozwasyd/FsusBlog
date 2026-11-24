namespace FsusBlog.V2.Server.Content;

internal sealed class IntegrityKeys
{
    private const string Algorithm = "ECDSA_P256_SHA256";
    private const string P256 = "1.2.840.10045.3.1.7";
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };
    private readonly byte[] _manifest;

    internal Registry Configuration { get; }

    internal IntegrityKeys(IConfiguration configuration)
    {
        Configuration = ReadRegistry(configuration.GetSection("IntegrityProof:Signing"));
        _manifest = JsonSerializer.SerializeToUtf8Bytes(Configuration, Json);
    }

    internal void Map(WebApplication app)
    {
        app.MapGet("/integrity/keys.json", (HttpContext ctx) =>
        {
            ctx.Response.Headers.CacheControl = "public, max-age=60, stale-while-revalidate=300";
            ctx.Response.Headers.Vary = "Accept-Encoding";
            return PublicResponse.Write(ctx, _manifest, "application/json; charset=utf-8");
        });
    }

    internal static byte[] ReadManifest(IConfigurationSection signing) => JsonSerializer.SerializeToUtf8Bytes(ReadRegistry(signing), Json);

    private static Registry ReadRegistry(IConfigurationSection signing)
    {
        var keys = signing.GetSection("Keys").GetChildren().OrderBy(key => key.Key, StringComparer.Ordinal).ToArray();
        if (keys.Length > 64) throw Invalid();
        var publicKeys = keys.Select(ReadKey).OfType<KeyManifest>().ToArray();
        var current = signing["CurrentKeyId"]?.Trim();
        if (!publicKeys.Any(key => key.KeyId == current)) current = null;
        return new Registry(1, "integrity-key-registry", "sha256", current, publicKeys);
    }

    private static KeyManifest? ReadKey(IConfigurationSection section)
    {
        var spki = section["PublicKey"]?.Trim();
        if (string.IsNullOrEmpty(spki)) return null;
        if (!ValidPublicKey(spki)) throw Invalid();
        var algorithm = section["Algorithm"]?.Trim();
        if (!string.Equals(algorithm, Algorithm, StringComparison.OrdinalIgnoreCase) &&
            !string.Equals(algorithm, "ecdsa-p256-sha256", StringComparison.OrdinalIgnoreCase))
            throw Invalid();
        if (section.Key.Length is < 1 or > 128 ||
            section.Key.Any(ch => !char.IsAsciiLetterOrDigit(ch) && ch is not ('-' or '_' or '.')))
            throw Invalid();
        var rawVersion = section["Version"]?.Trim();
        int? version = null;
        if (!string.IsNullOrEmpty(rawVersion))
        {
            if (!int.TryParse(rawVersion, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed) || parsed <= 0)
                throw Invalid();
            version = parsed;
        }
        var revoked = ReadMark(section["RevokedAtUtc"]);
        var compromised = ReadMark(section["CompromisedAtUtc"]);
        return new(section.Key, Algorithm, version, spki, revoked, compromised);
    }

    private static string? ReadMark(string? raw)
    {
        var value = raw?.Trim();
        if (string.IsNullOrEmpty(value)) return null;
        if (!DateTimeOffset.TryParseExact(value, ["yyyy-MM-dd'T'HH:mm:ss.FFFFFFF'Z'", "yyyy-MM-dd'T'HH:mm:ss.FFFFFFFzzz"],
                CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out _))
            throw Invalid();
        return value;
    }

    private static bool ValidPublicKey(string spki)
    {
        if (spki.Length is < 32 or > 256 || spki.Any(ch => !char.IsAsciiLetterOrDigit(ch) && ch is not ('-' or '_'))) return false;
        try
        {
            var der = WebEncoders.Base64UrlDecode(spki);
            if (WebEncoders.Base64UrlEncode(der) != spki) return false;
            using var key = ECDsa.Create();
            key.ImportSubjectPublicKeyInfo(der, out var length);
            return length == der.Length && key.ExportParameters(false).Curve.Oid.Value == P256;
        }
        catch (Exception error) when (error is CryptographicException or FormatException) { return false; }
    }

    private static InvalidOperationException Invalid() => new("Invalid public integrity verification key configuration.");

    internal sealed record Registry(int ManifestVersion, string Kind, string HashAlgorithm, string? CurrentKeyId, KeyManifest[] Keys);
    internal sealed record KeyManifest(string KeyId, string Algorithm, int? Version, string PublicKey,
        string? RevokedAtUtc, string? CompromisedAtUtc);
}
