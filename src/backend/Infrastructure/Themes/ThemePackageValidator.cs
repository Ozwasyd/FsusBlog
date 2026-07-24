using System.Globalization;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace FsusBlog.Server.Infrastructure.Themes;

public sealed partial class ThemePackageValidator
{
    private const long MaximumPackageBytes = 16 * 1024 * 1024;
    private const long MaximumExpandedBytes = 8 * 1024 * 1024;
    private const long MaximumCssBudgetBytes = 1024 * 1024;
    private const long MaximumAssetBudgetBytes = 4 * 1024 * 1024;
    private const int MaximumEntries = 128;
    private const int MaximumSelectors = 4096;

    private static readonly string[] s_requiredPaths =
    [
        "manifest.json",
        "styles/tokens.css",
        "styles/theme.css",
        "assets/preview.png",
        "config/schema.json"
    ];

    public ValidatedThemePackage Validate(Stream packageStream, Version fsusBlogVersion)
    {
        ArgumentNullException.ThrowIfNull(packageStream);
        ArgumentNullException.ThrowIfNull(fsusBlogVersion);
        using MemoryStream packageCopy = CopyPackage(packageStream);
        byte[] packageBytes = packageCopy.ToArray();
        string packageHash = ComputeHash(packageBytes);

        try
        {
            using var archive = new ZipArchive(
                new MemoryStream(packageBytes, writable: false),
                ZipArchiveMode.Read,
                leaveOpen: false);
            IReadOnlyDictionary<string, ThemePackageContent> contents = ReadEntries(archive);
            EnsureRequiredEntries(contents);
            ThemePackageContent manifestContent = contents["manifest.json"];
            string manifestJson = DecodeUtf8(manifestContent.Content, "theme_manifest_encoding_invalid");
            ThemeManifest manifest = ParseManifest(manifestJson);
            ValidateManifest(manifest, contents, fsusBlogVersion);
            string configSchemaJson = DecodeUtf8(
                contents[manifest.ConfigSchema].Content,
                "theme_config_schema_encoding_invalid");
            ValidateConfigSchema(configSchemaJson);

            ThemePackageEntry[] entries =
            [
                .. contents.Values
                    .OrderBy(static content => content.Path, StringComparer.Ordinal)
                    .Select(static content => new ThemePackageEntry(
                        content.Path,
                        content.ContentHash,
                        content.Content.LongLength))
            ];
            var assets = new Dictionary<string, ThemeAssetMetadata>(StringComparer.Ordinal);
            foreach ((string assetKey, string path) in manifest.Assets)
            {
                ThemePackageContent content = contents[path];
                assets.Add(
                    assetKey,
                    new ThemeAssetMetadata(assetKey, path, content.ContentHash, content.Content.LongLength));
            }

            return new ValidatedThemePackage(
                manifest,
                manifestJson,
                configSchemaJson,
                packageHash,
                packageBytes,
                Array.AsReadOnly(entries),
                new System.Collections.ObjectModel.ReadOnlyDictionary<string, ThemeAssetMetadata>(assets));
        }
        catch (ThemePackageException)
        {
            throw;
        }
        catch (InvalidDataException exception)
        {
            throw new ThemePackageException(
                "theme_package_archive_invalid",
                "Theme package is not a valid .fstheme ZIP archive.",
                exception);
        }
    }

    public void ValidateConfig(ValidatedThemePackage package, string configJson)
    {
        ArgumentNullException.ThrowIfNull(package);
        ArgumentException.ThrowIfNullOrWhiteSpace(configJson);
        using JsonDocument schema = ParseJson(
            package.ConfigSchemaJson,
            "theme_config_schema_invalid",
            "Theme config schema is invalid JSON.");
        using JsonDocument config = ParseJson(
            configJson,
            "theme_config_invalid",
            "Theme config is invalid JSON.");
        JsonElement schemaRoot = schema.RootElement;
        JsonElement configRoot = config.RootElement;
        if (configRoot.ValueKind != JsonValueKind.Object)
        {
            throw new ThemePackageException(
                "theme_config_type_invalid",
                "Theme config root must be an object.");
        }

        JsonElement properties = schemaRoot.GetProperty("properties");
        var knownProperties = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        foreach (JsonProperty property in properties.EnumerateObject())
        {
            knownProperties.Add(property.Name, property.Value);
        }

        foreach (JsonProperty property in configRoot.EnumerateObject())
        {
            if (!knownProperties.TryGetValue(property.Name, out JsonElement propertySchema))
            {
                throw new ThemePackageException(
                    "theme_config_property_unknown",
                    $"Theme config property '{property.Name}' is not declared by the package schema.");
            }

            string type = propertySchema.GetProperty("type").GetString()!;
            if (!MatchesJsonType(property.Value, type))
            {
                throw new ThemePackageException(
                    "theme_config_type_invalid",
                    $"Theme config property '{property.Name}' must be of type '{type}'.");
            }
        }

        if (schemaRoot.TryGetProperty("required", out JsonElement required))
        {
            foreach (JsonElement nameElement in required.EnumerateArray())
            {
                string propertyName = nameElement.GetString()!;
                if (!configRoot.TryGetProperty(propertyName, out _))
                {
                    throw new ThemePackageException(
                        "theme_config_required_property_missing",
                        $"Theme config property '{propertyName}' is required.");
                }
            }
        }
    }

    private static MemoryStream CopyPackage(Stream packageStream)
    {
        var packageCopy = new MemoryStream();
        var buffer = new byte[81920];
        long totalBytes = 0;
        while (true)
        {
            int read = packageStream.Read(buffer, 0, buffer.Length);
            if (read == 0)
            {
                break;
            }

            totalBytes += read;
            if (totalBytes > MaximumPackageBytes)
            {
                packageCopy.Dispose();
                throw new ThemePackageException(
                    "theme_package_too_large",
                    $"Theme package exceeds the {MaximumPackageBytes} byte limit.");
            }

            packageCopy.Write(buffer, 0, read);
        }

        packageCopy.Position = 0;
        return packageCopy;
    }

    private static IReadOnlyDictionary<string, ThemePackageContent> ReadEntries(ZipArchive archive)
    {
        if (archive.Entries.Count == 0 || archive.Entries.Count > MaximumEntries)
        {
            throw new ThemePackageException(
                "theme_package_entry_count_invalid",
                $"Theme package must contain between 1 and {MaximumEntries} entries.");
        }

        var contents = new Dictionary<string, ThemePackageContent>(StringComparer.Ordinal);
        var caseFoldedPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        long expandedBytes = 0;
        foreach (ZipArchiveEntry entry in archive.Entries)
        {
            string path = ValidateEntryPath(entry);
            if (!contents.TryAdd(path, null!) || !caseFoldedPaths.Add(path))
            {
                throw new ThemePackageException(
                    "theme_package_entry_duplicate",
                    $"Theme package contains duplicate entry '{path}'.");
            }

            using Stream source = entry.Open();
            using var content = new MemoryStream();
            CopyExpandedEntry(source, content, ref expandedBytes);
            byte[] bytes = content.ToArray();
            contents[path] = new ThemePackageContent(path, bytes, ComputeHash(bytes));
        }

        return contents;
    }

    private static string ValidateEntryPath(ZipArchiveEntry entry)
    {
        string path = entry.FullName;
        int unixFileType = (entry.ExternalAttributes >> 16) & 0xF000;
        if (unixFileType == 0xA000)
        {
            throw new ThemePackageException(
                "theme_package_link_denied",
                $"Theme package entry '{path}' cannot be a symbolic link.");
        }

        if (string.IsNullOrWhiteSpace(path)
            || path.EndsWith("/", StringComparison.Ordinal)
            || path.StartsWith("/", StringComparison.Ordinal)
            || path.Contains('\\', StringComparison.Ordinal)
            || path.Contains(':', StringComparison.Ordinal)
            || path.Split('/').Any(static segment => segment is "" or "." or ".."))
        {
            throw new ThemePackageException(
                "theme_package_path_invalid",
                $"Theme package entry '{path}' is not a canonical relative path.");
        }

        return path;
    }

    private static void CopyExpandedEntry(Stream source, MemoryStream destination, ref long expandedBytes)
    {
        var buffer = new byte[81920];
        while (true)
        {
            int read = source.Read(buffer, 0, buffer.Length);
            if (read == 0)
            {
                break;
            }

            expandedBytes += read;
            if (expandedBytes > MaximumExpandedBytes)
            {
                throw new ThemePackageException(
                    "theme_package_expanded_too_large",
                    $"Theme package expanded content exceeds the {MaximumExpandedBytes} byte limit.");
            }

            destination.Write(buffer, 0, read);
        }
    }

    private static void EnsureRequiredEntries(IReadOnlyDictionary<string, ThemePackageContent> contents)
    {
        foreach (string requiredPath in s_requiredPaths)
        {
            if (!contents.ContainsKey(requiredPath))
            {
                throw new ThemePackageException(
                    "theme_package_required_file_missing",
                    $"Theme package is missing required file '{requiredPath}'.");
            }
        }
    }

    private static ThemeManifest ParseManifest(string manifestJson)
    {
        try
        {
            ThemeManifest? manifest = JsonSerializer.Deserialize(
                manifestJson,
                ThemeJsonSerializerContext.Default.ThemeManifest);
            return manifest
                ?? throw new ThemePackageException(
                    "theme_manifest_invalid",
                    "Theme manifest cannot be null.");
        }
        catch (JsonException exception)
        {
            throw new ThemePackageException(
                "theme_manifest_invalid",
                "Theme manifest is invalid JSON or does not match the schema.",
                exception);
        }
    }

    private static void ValidateManifest(
        ThemeManifest manifest,
        IReadOnlyDictionary<string, ThemePackageContent> contents,
        Version fsusBlogVersion)
    {
        if (!ThemeIdExpression().IsMatch(manifest.Id ?? string.Empty))
        {
            throw new ThemePackageException(
                "theme_manifest_id_invalid",
                "Theme manifest id must use the 'fsusblog.theme.<name>' lowercase namespace.");
        }

        if (string.IsNullOrWhiteSpace(manifest.Name)
            || manifest.Name.Length > 120
            || string.IsNullOrWhiteSpace(manifest.Author)
            || manifest.Author.Length > 120
            || string.IsNullOrWhiteSpace(manifest.Description)
            || manifest.Description.Length > 500
            || !string.Equals(manifest.Type, "theme", StringComparison.Ordinal))
        {
            throw new ThemePackageException(
                "theme_manifest_metadata_invalid",
                "Theme manifest metadata is incomplete or invalid.");
        }

        if (!SemanticVersionExpression().IsMatch(manifest.Version ?? string.Empty))
        {
            throw new ThemePackageException(
                "theme_manifest_version_invalid",
                "Theme manifest version must be a semantic version.");
        }

        if (!IsVersionCompatible(manifest.Fsusblog, fsusBlogVersion))
        {
            throw new ThemePackageException(
                "theme_manifest_version_incompatible",
                $"Theme requires FsusBlog '{manifest.Fsusblog}', but runtime is '{fsusBlogVersion}'.");
        }

        if (manifest.Permissions.Script
            || manifest.Permissions.Network
            || manifest.Permissions.Filesystem)
        {
            throw new ThemePackageException(
                "theme_manifest_permission_denied",
                "Theme packages cannot request script, network, or filesystem permissions.");
        }

        if (manifest.Budgets.CssBytes is <= 0 or > MaximumCssBudgetBytes
            || manifest.Budgets.AssetBytes is <= 0 or > MaximumAssetBudgetBytes
            || manifest.Budgets.MaxSelectors is <= 0 or > MaximumSelectors)
        {
            throw new ThemePackageException(
                "theme_manifest_budget_invalid",
                "Theme manifest budgets exceed platform limits.");
        }

        string[] entryPaths =
        [
            manifest.Entry.Tokens,
            manifest.Entry.Theme,
            .. OptionalPaths(manifest.Entry.Prose, manifest.Entry.Code),
            manifest.ConfigSchema,
            .. manifest.Assets.Values
        ];
        foreach (string path in entryPaths)
        {
            ValidateManifestPath(path);
            if (!contents.ContainsKey(path))
            {
                throw new ThemePackageException(
                    "theme_manifest_entry_missing",
                    $"Theme manifest references missing entry '{path}'.");
            }
        }

        if (!string.Equals(manifest.Entry.Tokens, "styles/tokens.css", StringComparison.Ordinal)
            || !string.Equals(manifest.Entry.Theme, "styles/theme.css", StringComparison.Ordinal)
            || !string.Equals(manifest.ConfigSchema, "config/schema.json", StringComparison.Ordinal)
            || !manifest.Assets.TryGetValue("preview", out string? previewPath)
            || !string.Equals(previewPath, "assets/preview.png", StringComparison.Ordinal))
        {
            throw new ThemePackageException(
                "theme_manifest_required_entry_invalid",
                "Theme manifest must bind the minimum package paths to their canonical roles.");
        }

        long cssBytes = entryPaths
            .Where(static path => path.EndsWith(".css", StringComparison.Ordinal))
            .Distinct(StringComparer.Ordinal)
            .Sum(path => contents[path].Content.LongLength);
        long assetBytes = manifest.Assets.Values
            .Distinct(StringComparer.Ordinal)
            .Sum(path => contents[path].Content.LongLength);
        if (cssBytes > manifest.Budgets.CssBytes || assetBytes > manifest.Budgets.AssetBytes)
        {
            throw new ThemePackageException(
                "theme_package_budget_exceeded",
                "Theme package content exceeds its declared CSS or asset budget.");
        }

        if (manifest.Modes.Count == 0
            || manifest.Modes.Distinct(StringComparer.Ordinal).Count() != manifest.Modes.Count
            || manifest.Modes.Any(static mode => mode is not ("light" or "dark")))
        {
            throw new ThemePackageException(
                "theme_manifest_modes_invalid",
                "Theme modes must be a unique non-empty subset of light and dark.");
        }
    }

    private static void ValidateManifestPath(string? path)
    {
        if (string.IsNullOrWhiteSpace(path)
            || path.StartsWith("/", StringComparison.Ordinal)
            || path.Contains('\\', StringComparison.Ordinal)
            || path.Contains(':', StringComparison.Ordinal)
            || path.Split('/').Any(static segment => segment is "" or "." or ".."))
        {
            throw new ThemePackageException(
                "theme_manifest_path_invalid",
                $"Theme manifest path '{path}' is not canonical.");
        }
    }

    private static IEnumerable<string> OptionalPaths(params string?[] paths)
        => paths.Where(static path => !string.IsNullOrWhiteSpace(path)).Select(static path => path!);

    private static void ValidateConfigSchema(string schemaJson)
    {
        using JsonDocument schema = ParseJson(
            schemaJson,
            "theme_config_schema_invalid",
            "Theme config schema is invalid JSON.");
        JsonElement root = schema.RootElement;
        if (root.ValueKind != JsonValueKind.Object
            || !root.TryGetProperty("type", out JsonElement rootType)
            || !string.Equals(rootType.GetString(), "object", StringComparison.Ordinal)
            || !root.TryGetProperty("additionalProperties", out JsonElement additional)
            || additional.ValueKind != JsonValueKind.False
            || !root.TryGetProperty("properties", out JsonElement properties)
            || properties.ValueKind != JsonValueKind.Object)
        {
            throw new ThemePackageException(
                "theme_config_schema_invalid",
                "Theme config schema must be a closed object schema.");
        }

        foreach (JsonProperty property in properties.EnumerateObject())
        {
            if (property.Value.ValueKind != JsonValueKind.Object
                || !property.Value.TryGetProperty("type", out JsonElement type)
                || type.ValueKind != JsonValueKind.String
                || type.GetString() is not ("string" or "number" or "integer" or "boolean" or "array" or "object" or "null"))
            {
                throw new ThemePackageException(
                    "theme_config_schema_invalid",
                    $"Theme config schema property '{property.Name}' has an unsupported type.");
            }
        }

        if (root.TryGetProperty("required", out JsonElement required)
            && (required.ValueKind != JsonValueKind.Array
                || required.EnumerateArray().Any(element =>
                    element.ValueKind != JsonValueKind.String
                    || !properties.TryGetProperty(element.GetString()!, out _))))
        {
            throw new ThemePackageException(
                "theme_config_schema_invalid",
                "Theme config schema required properties must reference declared properties.");
        }
    }

    private static JsonDocument ParseJson(string json, string errorCode, string message)
    {
        try
        {
            return JsonDocument.Parse(json, new JsonDocumentOptions
            {
                AllowTrailingCommas = false,
                CommentHandling = JsonCommentHandling.Disallow,
                MaxDepth = 32
            });
        }
        catch (JsonException exception)
        {
            throw new ThemePackageException(errorCode, message, exception);
        }
    }

    private static bool MatchesJsonType(JsonElement value, string type)
        => type switch
        {
            "string" => value.ValueKind == JsonValueKind.String,
            "number" => value.ValueKind == JsonValueKind.Number,
            "integer" => value.ValueKind == JsonValueKind.Number
                && value.TryGetInt64(out _),
            "boolean" => value.ValueKind is JsonValueKind.True or JsonValueKind.False,
            "array" => value.ValueKind == JsonValueKind.Array,
            "object" => value.ValueKind == JsonValueKind.Object,
            "null" => value.ValueKind == JsonValueKind.Null,
            _ => false
        };

    private static bool IsVersionCompatible(string? range, Version version)
    {
        if (string.IsNullOrWhiteSpace(range))
        {
            return false;
        }

        string[] constraints = range.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (constraints.Length == 0)
        {
            return false;
        }

        foreach (string constraint in constraints)
        {
            Match match = VersionConstraintExpression().Match(constraint);
            if (!match.Success
                || !Version.TryParse(match.Groups["version"].Value, out Version? boundary))
            {
                return false;
            }

            int comparison = version.CompareTo(boundary);
            bool satisfied = match.Groups["operator"].Value switch
            {
                ">=" => comparison >= 0,
                ">" => comparison > 0,
                "<=" => comparison <= 0,
                "<" => comparison < 0,
                "=" => comparison == 0,
                _ => false
            };
            if (!satisfied)
            {
                return false;
            }
        }

        return true;
    }

    private static string DecodeUtf8(byte[] content, string errorCode)
    {
        try
        {
            return new UTF8Encoding(
                encoderShouldEmitUTF8Identifier: false,
                throwOnInvalidBytes: true).GetString(content);
        }
        catch (DecoderFallbackException exception)
        {
            throw new ThemePackageException(errorCode, "Theme package JSON must be valid UTF-8.", exception);
        }
    }

    private static string ComputeHash(ReadOnlySpan<byte> content)
        => Convert.ToHexStringLower(SHA256.HashData(content));

    [GeneratedRegex(@"^fsusblog\.theme\.[a-z0-9](?:[a-z0-9.-]{0,94}[a-z0-9])?$", RegexOptions.CultureInvariant)]
    private static partial Regex ThemeIdExpression();

    [GeneratedRegex(@"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$", RegexOptions.CultureInvariant)]
    private static partial Regex SemanticVersionExpression();

    [GeneratedRegex(@"^(?<operator>>=|>|<=|<|=)(?<version>\d+\.\d+\.\d+)$", RegexOptions.CultureInvariant)]
    private static partial Regex VersionConstraintExpression();

    private sealed record ThemePackageContent(
        string Path,
        byte[] Content,
        string ContentHash);
}
