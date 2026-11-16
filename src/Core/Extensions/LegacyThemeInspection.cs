using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using static FsusBlog.V2.Core.Extensions.ExtensionManifestReader;
using static FsusBlog.V2.Core.Extensions.ExtensionPackageVerifier;

namespace FsusBlog.V2.Core.Extensions;

internal static partial class LegacyThemeInspection
{
    internal const int MaximumArchiveBytes = 16 * 1024 * 1024;
    private const int MaximumExpandedBytes = 8 * 1024 * 1024;
    private const uint ZipCrcPolynomial = 0xedb88320;
    private const string ManifestPath = "manifest.json";
    private const string TokenPath = "styles/tokens.css";
    private const string ThemePath = "styles/theme.css";
    private const string PreviewPath = "assets/preview.png";
    private const string SchemaPath = "config/schema.json";
    private static readonly Version Baseline = new(1, 3, 0);
    private static readonly UTF8Encoding Utf8 = new(false, true);
    private static readonly JsonSerializerOptions Options = new(Json) { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    internal static Report Inspect(byte[] archive, byte[] signature, string source,
        IEnumerable<ExtensionPublisherKey> keys, IEnumerable<ApprovedExtensionSource> sources,
        TimeProvider clock, CancellationToken cancellationToken)
    {
        if (archive.Length is < 1 or > MaximumArchiveBytes) throw Reject("fstheme-archive-size");
        var verifier = new ExtensionPackageVerifier(keys, sources, clock);
        var trust = verifier.VerifyArchive(source, archive, signature, cancellationToken);
        var package = ReadVerified(archive, trust, cancellationToken);
        trust.RequireCurrent(clock, cancellationToken);
        return package.Report;
    }

    internal static Package ReadVerified(byte[] archive, SignedArchiveTrust trust, CancellationToken cancellationToken)
    {
        if (archive.Length is < 1 or > MaximumArchiveBytes) throw Reject("fstheme-archive-size");
        try
        {
            using var zip = new ZipArchive(new MemoryStream(archive, writable: false), ZipArchiveMode.Read);
            var entries = Index(zip);
            var manifestBytes = Read(entries[ManifestPath]);
            var manifest = Decode<Manifest>(manifestBytes, "fstheme-manifest");
            var styles = Validate(manifest, entries);
            var schema = Read(entries[SchemaPath]);
            var config = Config(Decode<ConfigSchema>(schema, "fstheme-config"));
            var inspected = new List<PackageEntry>(entries.Count);
            string? tokenCss = null;
            string? themeCss = null;
            foreach (var entry in entries.Values.OrderBy(item => item.FullName, StringComparer.Ordinal))
            {
                cancellationToken.ThrowIfCancellationRequested();
                var content = entry.FullName switch
                {
                    ManifestPath => manifestBytes,
                    SchemaPath => schema,
                    _ => Read(entry)
                };
                switch (entry.FullName)
                {
                    case TokenPath: tokenCss = Utf8.GetString(content); break;
                    case ThemePath: themeCss = Utf8.GetString(content); break;
                    default:
                        if (styles.Contains(entry.FullName)) _ = Utf8.GetCharCount(content);
                        break;
                }
                inspected.Add(new(entry.FullName, content.Length, Digest(content)));
            }
            var report = new Report("fsusblog.fstheme.v1.structural.v1", "inspection-only", trust.Source.ArchiveSha256,
                trust.Source.Reference, trust.Source.Publisher, manifest.Id, manifest.Name, manifest.Version, manifest.FsusBlog,
                manifest.Modes, manifest.Supports, inspected.Single(entry => entry.Path == PreviewPath),
                styles.Order(StringComparer.Ordinal).ToArray(), new SortedDictionary<string, string>(manifest.Assets, StringComparer.Ordinal), config, inspected);
            return new(report, tokenCss ?? throw Reject("fstheme-required-entry"), themeCss ?? throw Reject("fstheme-required-entry"),
                manifest.Budgets.MaxSelectors);
        }
        catch (DecoderFallbackException) { throw Reject("fstheme-css-encoding"); }
        catch (Exception error) when (error is IOException or InvalidDataException or NotSupportedException)
        {
            throw Reject("fstheme-archive-invalid");
        }
    }

    private static Dictionary<string, ZipArchiveEntry> Index(ZipArchive zip)
    {
        if (zip.Entries.Count is < 5 or > 128) throw Reject("fstheme-entry-count");
        var entries = new Dictionary<string, ZipArchiveEntry>(StringComparer.Ordinal);
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        long expanded = 0;
        foreach (var entry in zip.Entries)
        {
            var unixType = (entry.ExternalAttributes >> 16) & 0xf000;
            if (!IsPackagePath(entry.FullName) || entry.FullName.EndsWith('/') || !names.Add(entry.FullName) ||
                unixType is not (0 or 0x8000) ||
                (entry.ExternalAttributes & ((int)FileAttributes.ReparsePoint | (int)FileAttributes.Directory)) != 0)
                throw Reject("fstheme-entry-shape");
            if (entry.Length < 0 || entry.Length > MaximumExpandedBytes - expanded) throw Reject("fstheme-expanded-size");
            expanded += entry.Length;
            entries.Add(entry.FullName, entry);
        }
        foreach (var required in new[] { ManifestPath, TokenPath, ThemePath, PreviewPath, SchemaPath })
            if (!entries.ContainsKey(required)) throw Reject("fstheme-required-entry");
        if (entries[ManifestPath].Length is < 1 or > ManifestBytes || entries[SchemaPath].Length is < 1 or > ManifestBytes)
            throw Reject("fstheme-document-size");
        return entries;
    }

    private static HashSet<string> Validate(Manifest manifest, Dictionary<string, ZipArchiveEntry> entries)
    {
        if (manifest.Type != "theme" || !ThemeId().IsMatch(manifest.Id) || !Text(manifest.Name, 120) ||
            !Text(manifest.Author, 120) || !Text(manifest.Description, 500) ||
            manifest.Version.Length > 64 || !SemVer().IsMatch(manifest.Version) || !AllowsBaseline(manifest.FsusBlog) ||
            manifest.Modes.Length is < 1 or > 2 || manifest.Modes.Any(mode => mode is not ("light" or "dark")) ||
            manifest.Modes.Distinct(StringComparer.Ordinal).Count() != manifest.Modes.Length)
            throw Reject("fstheme-manifest");
        if (manifest.Permissions is not { Script: false, Network: false, Filesystem: false })
            throw Reject("fstheme-permission");
        if (manifest.Entry.Tokens != TokenPath || manifest.Entry.Theme != ThemePath || manifest.ConfigSchema != SchemaPath ||
            !manifest.Assets.TryGetValue("preview", out var preview) || preview != PreviewPath ||
            manifest.Assets.Any(asset => !Text(asset.Key, 128) || asset.Value is null)) throw Reject("fstheme-entry-role");

        var styles = new HashSet<string>(StringComparer.Ordinal) { TokenPath, ThemePath };
        foreach (var optional in new[] { manifest.Entry.Prose, manifest.Entry.Code })
            if (optional is not null && (!optional.EndsWith(".css", StringComparison.Ordinal) || !styles.Add(optional)))
                throw Reject("fstheme-entry-role");
        var assetPaths = manifest.Assets.Values.ToHashSet(StringComparer.Ordinal);
        if (styles.Overlaps(assetPaths) || assetPaths.Contains(ManifestPath) || assetPaths.Contains(SchemaPath) ||
            styles.Concat(assetPaths).Any(path => !entries.ContainsKey(path))) throw Reject("fstheme-entry-role");

        var budgets = manifest.Budgets;
        if (budgets is not { CssBytes: > 0 and <= 65536, AssetBytes: > 0 and <= 524288, PreviewBytes: > 0 and <= 262144,
            MaxSelectors: > 0 and <= 512, MaxSelectorDepth: > 0 and <= 4, MaxImportant: >= 0 and <= 8,
            MaxMotionDurationMs: > 0 and <= 1000 } || styles.Sum(path => entries[path].Length) > budgets.CssBytes ||
            assetPaths.Sum(path => entries[path].Length) > budgets.AssetBytes ||
            entries[PreviewPath].Length is < 1 || entries[PreviewPath].Length > budgets.PreviewBytes)
            throw Reject("fstheme-budget");
        return styles;
    }

    private static ConfigProperty[] Config(ConfigSchema schema)
    {
        var required = schema.Required ?? [];
        if (schema.Type != "object" || schema.AdditionalProperties || schema.Properties.Count > 256 ||
            required.Distinct(StringComparer.Ordinal).Count() != required.Length ||
            required.Any(name => name is null || !schema.Properties.ContainsKey(name)))
            throw Reject("fstheme-config");
        var known = required.ToHashSet(StringComparer.Ordinal);
        return schema.Properties.OrderBy(property => property.Key, StringComparer.Ordinal).Select(property =>
        {
            var (name, value) = property;
            if (!Text(name, 128) || value?.Type is not ("string" or "number" or "integer" or "boolean" or "array" or "object" or "null"))
                throw Reject("fstheme-config");
            return new ConfigProperty(name, value.Type, known.Contains(name));
        }).ToArray();
    }

    private static bool AllowsBaseline(string spec)
    {
        if (!Text(spec, 128)) return false;
        var constraints = spec.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        return constraints.All(constraint =>
        {
            var match = Boundary().Match(constraint);
            if (!match.Success || !Version.TryParse(match.Groups["version"].Value, out var bound)) return false;
            return match.Groups["operator"].Value switch
            {
                ">=" => Baseline >= bound,
                ">" => Baseline > bound,
                "<=" => Baseline <= bound,
                "<" => Baseline < bound,
                "=" => Baseline == bound,
                _ => false
            };
        });
    }

    private static T Decode<T>(byte[] bytes, string code) where T : class
    {
        try { return JsonSerializer.Deserialize<T>(bytes, Options) ?? throw Reject(code); }
        catch (JsonException) { throw Reject(code); }
    }

    private static byte[] Read(ZipArchiveEntry entry)
    {
        var output = ExtensionArchive.ReadExact(entry, "fstheme-entry-size");
        if (Crc32(output) != entry.Crc32) throw Reject("fstheme-entry-crc");
        return output;
    }

    private static uint Crc32(ReadOnlySpan<byte> bytes)
    {
        var crc = uint.MaxValue;
        foreach (var value in bytes)
        {
            crc ^= value;
            for (var bit = 0; bit < 8; bit++)
                crc = (crc & 1) == 0 ? crc >> 1 : (crc >> 1) ^ ZipCrcPolynomial;
        }
        return ~crc;
    }

    private static bool Text(string value, int limit) => value.Length <= limit &&
        !string.IsNullOrWhiteSpace(value) && value.All(character => !char.IsControl(character));

    private static ExtensionRejectedException Reject(string code) => new(code);

    [GeneratedRegex(@"\Afsusblog\.theme\.[a-z0-9](?:[a-z0-9.-]{0,94}[a-z0-9])?\z", RegexOptions.CultureInvariant)]
    private static partial Regex ThemeId();

    [GeneratedRegex(@"\A[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\z", RegexOptions.CultureInvariant)]
    private static partial Regex SemVer();

    [GeneratedRegex(@"\A(?<operator>>=|>|<=|<|=)(?<version>[0-9]+\.[0-9]+\.[0-9]+)\z", RegexOptions.CultureInvariant)]
    private static partial Regex Boundary();

    internal sealed record Package(Report Report, string TokenCss, string ThemeCss, int MaximumSelectors);
    internal sealed record Report(string Schema, string State, string ArchiveSha256, string Source, string Publisher,
        string Id, string Name, string Version, string FsusBlog, string[] Modes, Support Supports, PackageEntry Preview,
        IReadOnlyList<string> StylePaths, IReadOnlyDictionary<string, string> Assets,
        IReadOnlyList<ConfigProperty> Configuration, IReadOnlyList<PackageEntry> Entries);

    internal sealed record PackageEntry(string Path, int Bytes, string Sha256);
    internal sealed record ConfigProperty(string Name, string Type, bool Required);
    internal sealed record Support(bool Public, bool Admin, bool Console, bool HighContrast, bool ReducedMotion, bool Rtl);

    private sealed record Manifest(string Id, string Name, string Version, [property: JsonPropertyName("fsusblog")] string FsusBlog,
        string Author, string Description, string Type, Styles Entry, string[] Modes, Support Supports,
        Dictionary<string, string> Assets, string ConfigSchema, Permissions Permissions, Budgets Budgets);

    private sealed record Styles(string Tokens, string Theme, string? Prose = null, string? Code = null);
    private sealed record Permissions(bool Script, bool Network, bool Filesystem);
    private sealed record Budgets(long CssBytes, long AssetBytes, int MaxSelectors, int MaxSelectorDepth, int MaxImportant,
        int MaxMotionDurationMs, long PreviewBytes);
    private sealed record ConfigSchema(string Type, bool AdditionalProperties, Dictionary<string, Property> Properties, string[]? Required = null);
    private sealed record Property(string Type);
}
