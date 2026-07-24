using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace FsusBlog.Server.Infrastructure.Plugins;

/// <summary>
/// Reads and verifies the inert contents of an .fspkg archive. It never extracts
/// files or invokes plugin-controlled code.
/// </summary>
public sealed partial class PluginPackageReader(
    Version hostVersion,
    IPluginPackageSignatureVerifier? signatureVerifier = null)
{
    private const int MaximumEntryCount = 256;
    private const long MaximumEntryBytes = 8 * 1024 * 1024;
    private const long MaximumPackageBytes = 32 * 1024 * 1024;

    private static readonly HashSet<string> s_supportedHooks =
    [
        "comment.beforeCreate"
    ];

    private static readonly HashSet<string> s_supportedCapabilities =
    [
        "comment.read",
        "comment.moderate",
        "plugin.storage.kv",
        "plugin.log.write"
    ];

    private static readonly HashSet<string> s_supportedConfigSchemaKeywords =
    [
        "$schema",
        "$id",
        "title",
        "description",
        "type",
        "properties",
        "required",
        "additionalProperties",
        "items",
        "enum",
        "minimum",
        "maximum",
        "minLength",
        "maxLength",
        "pattern",
        "default"
    ];

    private static readonly HashSet<string> s_supportedConfigTypes =
    [
        "array",
        "boolean",
        "integer",
        "null",
        "number",
        "object",
        "string"
    ];

    private static readonly JsonSerializerOptions s_manifestJsonOptions = new(JsonSerializerDefaults.Web)
    {
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        Converters =
        {
            new JsonStringEnumConverter(JsonNamingPolicy.CamelCase, allowIntegerValues: false)
        }
    };

    public async Task<PluginPackage> ReadAsync(Stream source, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(source);
        byte[] packageBytes = await ReadBoundedAsync(source, MaximumPackageBytes, cancellationToken).ConfigureAwait(false);
        try
        {
            using var archiveStream = new MemoryStream(packageBytes, writable: false);
            using var archive = new ZipArchive(archiveStream, ZipArchiveMode.Read, leaveOpen: false);
            Dictionary<string, ZipArchiveEntry> entries = IndexEntries(archive);
            byte[] manifestBytes = await ReadRequiredEntryAsync(entries, "manifest.json", cancellationToken).ConfigureAwait(false);
            PluginManifest manifest = DeserializeManifest(manifestBytes);
            PluginConfigSchema configSchema = ValidateManifest(manifest, entries);
            byte[] checksumMetadata = await ValidateChecksumsAsync(entries, cancellationToken).ConfigureAwait(false);
            byte[] signature = await ReadRequiredEntryAsync(
                entries,
                "signature/signature.sig",
                cancellationToken).ConfigureAwait(false);
            if (signature.Length == 0)
            {
                throw new PluginPackageValidationException("Plugin signature metadata cannot be empty.");
            }
            if (signatureVerifier is not null
                && !await signatureVerifier.VerifyAsync(
                    manifest,
                    checksumMetadata,
                    signature,
                    cancellationToken).ConfigureAwait(false))
            {
                throw new PluginPackageValidationException("Plugin signature verification failed.");
            }

            return new PluginPackage(
                manifest,
                configSchema,
                packageBytes,
                SHA256.HashData(packageBytes));
        }
        catch (PluginPackageValidationException)
        {
            throw;
        }
        catch (InvalidDataException exception)
        {
            throw new PluginPackageValidationException("The .fspkg archive is invalid.", exception);
        }
    }

    private static async Task<byte[]> ReadBoundedAsync(
        Stream source,
        long maximumBytes,
        CancellationToken cancellationToken)
    {
        using var destination = new MemoryStream();
        byte[] buffer = new byte[81920];
        while (true)
        {
            int read = await source.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
            if (read == 0)
            {
                break;
            }
            if (destination.Length + read > maximumBytes)
            {
                throw new PluginPackageValidationException(
                    $"Plugin package exceeds the {maximumBytes}-byte limit.");
            }
            destination.Write(buffer, 0, read);
        }
        return destination.ToArray();
    }

    private static Dictionary<string, ZipArchiveEntry> IndexEntries(ZipArchive archive)
    {
        if (archive.Entries.Count == 0 || archive.Entries.Count > MaximumEntryCount)
        {
            throw new PluginPackageValidationException(
                $"Plugin package must contain 1..{MaximumEntryCount} entries.");
        }

        var entries = new Dictionary<string, ZipArchiveEntry>(StringComparer.Ordinal);
        long uncompressedBytes = 0;
        foreach (ZipArchiveEntry entry in archive.Entries)
        {
            string path = entry.FullName;
            ValidatePackagePath(path);
            if (path.EndsWith("/", StringComparison.Ordinal))
            {
                continue;
            }
            if (entry.Length > MaximumEntryBytes)
            {
                throw new PluginPackageValidationException($"Plugin package entry '{path}' is too large.");
            }
            uncompressedBytes = checked(uncompressedBytes + entry.Length);
            if (uncompressedBytes > MaximumPackageBytes)
            {
                throw new PluginPackageValidationException("Plugin package expands beyond the allowed size.");
            }
            if (!entries.TryAdd(path, entry))
            {
                throw new PluginPackageValidationException($"Plugin package contains duplicate path '{path}'.");
            }
        }
        return entries;
    }

    private static void ValidatePackagePath(string path)
    {
        if (string.IsNullOrWhiteSpace(path)
            || path.Contains('\\', StringComparison.Ordinal)
            || path.StartsWith("/", StringComparison.Ordinal)
            || Path.IsPathRooted(path)
            || path.Split('/').Any(static segment => segment is "." or ".." or ""))
        {
            throw new PluginPackageValidationException($"Plugin package path '{path}' is unsafe.");
        }
    }

    private static async Task<byte[]> ReadRequiredEntryAsync(
        IReadOnlyDictionary<string, ZipArchiveEntry> entries,
        string path,
        CancellationToken cancellationToken)
    {
        if (!entries.TryGetValue(path, out ZipArchiveEntry? entry))
        {
            throw new PluginPackageValidationException($"Plugin package is missing required entry '{path}'.");
        }

        await using Stream stream = entry.Open();
        return await ReadBoundedAsync(stream, MaximumEntryBytes, cancellationToken).ConfigureAwait(false);
    }

    private static PluginManifest DeserializeManifest(byte[] manifestBytes)
    {
        try
        {
            using JsonDocument document = JsonDocument.Parse(manifestBytes);
            EnsureUniqueJsonProperties(document.RootElement, "$");
            return JsonSerializer.Deserialize<PluginManifest>(manifestBytes, s_manifestJsonOptions)
                ?? throw new PluginPackageValidationException("Plugin manifest cannot be null.");
        }
        catch (JsonException exception)
        {
            string location = string.IsNullOrWhiteSpace(exception.Path)
                ? string.Empty
                : $" at {exception.Path}";
            throw new PluginPackageValidationException(
                $"Plugin manifest JSON is invalid{location}.",
                exception);
        }
    }

    private PluginConfigSchema ValidateManifest(
        PluginManifest manifest,
        IReadOnlyDictionary<string, ZipArchiveEntry> entries)
    {
        if (manifest is null
            || manifest.Runtime is null
            || manifest.Permissions is null
            || manifest.Hooks is null
            || manifest.Capabilities is null)
        {
            throw new PluginPackageValidationException(
                "Plugin manifest is missing a required object or collection.");
        }
        ValidateRequiredText(manifest.Name, 128, "name");
        ValidateRequiredText(manifest.Author, 128, "author");
        ValidateRequiredText(manifest.Description, 512, "description");
        if (string.IsNullOrEmpty(manifest.Id) || !PluginIdPattern().IsMatch(manifest.Id))
        {
            throw new PluginPackageValidationException("Plugin id is invalid.");
        }
        if (string.IsNullOrEmpty(manifest.Version) || !SemanticVersionPattern().IsMatch(manifest.Version))
        {
            throw new PluginPackageValidationException("Plugin version must be a semantic version.");
        }
        if (string.IsNullOrEmpty(manifest.Fsusblog)
            || !IsCompatibleVersionRange(manifest.Fsusblog, hostVersion))
        {
            throw new PluginPackageValidationException(
                $"Plugin fsusblog range '{manifest.Fsusblog}' does not include host {hostVersion}.");
        }
        if (!Enum.IsDefined(manifest.Runtime.Type))
        {
            throw new PluginPackageValidationException("Plugin runtime type is unsupported.");
        }
        ValidateRelativeFileReference(manifest.Runtime.Entry, "runtime entry", entries);
        if ((manifest.Runtime.Type == PluginRuntimeType.Lua
                && !manifest.Runtime.Entry.EndsWith(".lua", StringComparison.Ordinal))
            || (manifest.Runtime.Type == PluginRuntimeType.JavaScript
                && !manifest.Runtime.Entry.EndsWith(".js", StringComparison.Ordinal)
                && !manifest.Runtime.Entry.EndsWith(".mjs", StringComparison.Ordinal)))
        {
            throw new PluginPackageValidationException(
                "Plugin runtime entry extension does not match its runtime type.");
        }
        ValidateRelativeFileReference(manifest.ConfigSchema, "config schema", entries);
        if (manifest.Ui?.AdminEntry is not null)
        {
            ValidateRelativeFileReference(manifest.Ui.AdminEntry, "admin UI entry", entries);
        }
        if (manifest.Ui?.Style is not null)
        {
            ValidateRelativeFileReference(manifest.Ui.Style, "UI stylesheet", entries);
        }
        PluginConfigSchema configSchema = ValidateConfigSchema(
            manifest.ConfigSchema,
            entries[manifest.ConfigSchema]);
        if (manifest.Hooks.Count > 64
            || manifest.Hooks.Any(static hook => hook is null)
            || manifest.Hooks.Count != manifest.Hooks.Select(static hook => hook.Name).Distinct(StringComparer.Ordinal).Count())
        {
            throw new PluginPackageValidationException("Plugin hook names must be unique.");
        }
        foreach (PluginHookDescriptor hook in manifest.Hooks)
        {
            if (!s_supportedHooks.Contains(hook.Name)
                || hook.Priority is < -1000 or > 1000
                || hook.TimeoutMs is < 1 or > 30_000
                || hook.FailPolicy is not ("fail-open" or "fail-closed"))
            {
                throw new PluginPackageValidationException($"Plugin hook '{hook.Name}' is invalid.");
            }
        }
        if (manifest.Capabilities.Count > 64
            || manifest.Capabilities.Count
            != manifest.Capabilities.Distinct(StringComparer.Ordinal).Count())
        {
            throw new PluginPackageValidationException("Plugin capabilities must be unique.");
        }
        if (manifest.Capabilities.Any(capability => !s_supportedCapabilities.Contains(capability)))
        {
            throw new PluginPackageValidationException("Plugin capability is unsupported.");
        }
        if (manifest.Permissions.Database is not ("none" or "read" or "read-write"))
        {
            throw new PluginPackageValidationException("Plugin database permission is invalid.");
        }
        return configSchema;
    }

    private static void ValidateRequiredText(string? value, int maximumLength, string field)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > maximumLength)
        {
            throw new PluginPackageValidationException(
                $"Plugin manifest {field} must contain 1..{maximumLength} characters.");
        }
    }

    private static void ValidateRelativeFileReference(
        string path,
        string description,
        IReadOnlyDictionary<string, ZipArchiveEntry> entries)
    {
        ValidatePackagePath(path);
        if (!entries.ContainsKey(path))
        {
            throw new PluginPackageValidationException($"Plugin {description} '{path}' does not exist.");
        }
    }

    private static PluginConfigSchema ValidateConfigSchema(string path, ZipArchiveEntry entry)
    {
        try
        {
            using Stream stream = entry.Open();
            using JsonDocument document = JsonDocument.Parse(stream);
            JsonElement root = document.RootElement;
            EnsureUniqueJsonProperties(root, "$");
            if (root.ValueKind != JsonValueKind.Object
                || !root.TryGetProperty("type", out JsonElement type)
                || type.ValueKind != JsonValueKind.String
                || type.GetString() != "object")
            {
                throw new PluginPackageValidationException(
                    "Plugin config schema must be a JSON Schema object with type 'object'.");
            }
            ValidateConfigSchemaNode(root, "$", requireObjectType: true);
            return new PluginConfigSchema(path, root.Clone());
        }
        catch (JsonException exception)
        {
            throw new PluginPackageValidationException("Plugin config schema JSON is invalid.", exception);
        }
    }

    private static void ValidateConfigSchemaNode(
        JsonElement node,
        string path,
        bool requireObjectType = false)
    {
        if (node.ValueKind != JsonValueKind.Object)
        {
            throw new PluginPackageValidationException(
                $"Plugin config schema node '{path}' must be an object.");
        }
        foreach (JsonProperty property in node.EnumerateObject())
        {
            if (!s_supportedConfigSchemaKeywords.Contains(property.Name))
            {
                throw new PluginPackageValidationException(
                    $"Plugin config schema keyword '{property.Name}' at '{path}' is unsupported.");
            }
        }

        if (!node.TryGetProperty("type", out JsonElement type)
            || type.ValueKind != JsonValueKind.String
            || !s_supportedConfigTypes.Contains(type.GetString()!))
        {
            throw new PluginPackageValidationException(
                $"Plugin config schema node '{path}' must declare one supported string type.");
        }
        if (requireObjectType && type.GetString() != "object")
        {
            throw new PluginPackageValidationException(
                "Plugin config schema root type must be 'object'.");
        }

        HashSet<string> propertyNames = [];
        if (node.TryGetProperty("properties", out JsonElement properties))
        {
            if (type.GetString() != "object" || properties.ValueKind != JsonValueKind.Object)
            {
                throw new PluginPackageValidationException(
                    $"Plugin config schema properties at '{path}' require object type.");
            }
            foreach (JsonProperty property in properties.EnumerateObject())
            {
                if (!propertyNames.Add(property.Name))
                {
                    throw new PluginPackageValidationException(
                        $"Plugin config schema property '{property.Name}' is duplicated.");
                }
                ValidateConfigSchemaNode(property.Value, $"{path}.properties.{property.Name}");
            }
        }
        if (node.TryGetProperty("required", out JsonElement required))
        {
            if (type.GetString() != "object" || required.ValueKind != JsonValueKind.Array)
            {
                throw new PluginPackageValidationException(
                    $"Plugin config schema required at '{path}' must be an array on an object.");
            }
            var requiredNames = new HashSet<string>(StringComparer.Ordinal);
            foreach (JsonElement item in required.EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.String
                    || !requiredNames.Add(item.GetString()!)
                    || !propertyNames.Contains(item.GetString()!))
                {
                    throw new PluginPackageValidationException(
                        $"Plugin config schema required at '{path}' must reference unique declared properties.");
                }
            }
        }
        if (node.TryGetProperty("additionalProperties", out JsonElement additionalProperties)
            && additionalProperties.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
        {
            throw new PluginPackageValidationException(
                $"Plugin config schema additionalProperties at '{path}' must be boolean.");
        }
        if (node.TryGetProperty("items", out JsonElement items))
        {
            if (type.GetString() != "array")
            {
                throw new PluginPackageValidationException(
                    $"Plugin config schema items at '{path}' require array type.");
            }
            ValidateConfigSchemaNode(items, $"{path}.items");
        }
        if (node.TryGetProperty("enum", out JsonElement enumValues)
            && (enumValues.ValueKind != JsonValueKind.Array || enumValues.GetArrayLength() == 0))
        {
            throw new PluginPackageValidationException(
                $"Plugin config schema enum at '{path}' must be a non-empty array.");
        }
        ValidateNonNegativeIntegerKeyword(node, "minLength", path);
        ValidateNonNegativeIntegerKeyword(node, "maxLength", path);
        ValidateNumberKeyword(node, "minimum", path);
        ValidateNumberKeyword(node, "maximum", path);
        ValidateStringKeyword(node, "$schema", path);
        ValidateStringKeyword(node, "$id", path);
        ValidateStringKeyword(node, "title", path);
        ValidateStringKeyword(node, "description", path);
        ValidateStringKeyword(node, "pattern", path);
    }

    private static void ValidateNonNegativeIntegerKeyword(
        JsonElement node,
        string keyword,
        string path)
    {
        if (node.TryGetProperty(keyword, out JsonElement value)
            && (!value.TryGetInt32(out int integer) || integer < 0))
        {
            throw new PluginPackageValidationException(
                $"Plugin config schema {keyword} at '{path}' must be a non-negative integer.");
        }
    }

    private static void ValidateNumberKeyword(JsonElement node, string keyword, string path)
    {
        if (node.TryGetProperty(keyword, out JsonElement value)
            && value.ValueKind != JsonValueKind.Number)
        {
            throw new PluginPackageValidationException(
                $"Plugin config schema {keyword} at '{path}' must be a number.");
        }
    }

    private static void ValidateStringKeyword(JsonElement node, string keyword, string path)
    {
        if (node.TryGetProperty(keyword, out JsonElement value)
            && value.ValueKind != JsonValueKind.String)
        {
            throw new PluginPackageValidationException(
                $"Plugin config schema {keyword} at '{path}' must be a string.");
        }
    }

    private static async Task<byte[]> ValidateChecksumsAsync(
        IReadOnlyDictionary<string, ZipArchiveEntry> entries,
        CancellationToken cancellationToken)
    {
        byte[] checksumBytes = await ReadRequiredEntryAsync(
            entries,
            "signature/checksums.json",
            cancellationToken).ConfigureAwait(false);
        Dictionary<string, string> checksums;
        try
        {
            using JsonDocument document = JsonDocument.Parse(checksumBytes);
            EnsureUniqueJsonProperties(document.RootElement, "$");
            checksums = JsonSerializer.Deserialize<Dictionary<string, string>>(checksumBytes)
                ?? throw new PluginPackageValidationException("Plugin checksum metadata cannot be null.");
        }
        catch (JsonException exception)
        {
            throw new PluginPackageValidationException("Plugin checksum metadata JSON is invalid.", exception);
        }

        string[] payloadPaths =
        [
            .. entries.Keys
                .Where(static path => path is not "signature/checksums.json" and not "signature/signature.sig")
                .Order(StringComparer.Ordinal)
        ];
        if (!payloadPaths.SequenceEqual(checksums.Keys.Order(StringComparer.Ordinal), StringComparer.Ordinal))
        {
            throw new PluginPackageValidationException(
                "Plugin checksum metadata must cover every payload entry exactly once.");
        }

        foreach (string path in payloadPaths)
        {
            ValidatePackagePath(path);
            string expected = checksums[path];
            if (!ChecksumPattern().IsMatch(expected))
            {
                throw new PluginPackageValidationException($"Plugin checksum for '{path}' is invalid.");
            }
            await using Stream stream = entries[path].Open();
            byte[] actual = await SHA256.HashDataAsync(stream, cancellationToken).ConfigureAwait(false);
            if (!CryptographicOperations.FixedTimeEquals(actual, Convert.FromHexString(expected)))
            {
                throw new PluginPackageValidationException($"Plugin checksum mismatch for '{path}'.");
            }
        }
        return checksumBytes;
    }

    private static void EnsureUniqueJsonProperties(JsonElement node, string path)
    {
        if (node.ValueKind == JsonValueKind.Object)
        {
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (JsonProperty property in node.EnumerateObject())
            {
                if (!names.Add(property.Name))
                {
                    throw new PluginPackageValidationException(
                        $"Plugin JSON property '{property.Name}' is duplicated at '{path}'.");
                }
                EnsureUniqueJsonProperties(property.Value, $"{path}.{property.Name}");
            }
        }
        else if (node.ValueKind == JsonValueKind.Array)
        {
            int index = 0;
            foreach (JsonElement item in node.EnumerateArray())
            {
                EnsureUniqueJsonProperties(item, $"{path}[{index}]");
                index++;
            }
        }
    }

    private static bool IsCompatibleVersionRange(string range, Version host)
    {
        string[] terms = range.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (terms.Length == 0)
        {
            return false;
        }
        foreach (string term in terms)
        {
            Match match = VersionRangeTermPattern().Match(term);
            if (!match.Success || !Version.TryParse(match.Groups["version"].Value, out Version? boundary))
            {
                return false;
            }
            int comparison = host.CompareTo(boundary);
            bool accepted = match.Groups["operator"].Value switch
            {
                ">=" => comparison >= 0,
                ">" => comparison > 0,
                "<=" => comparison <= 0,
                "<" => comparison < 0,
                "=" => comparison == 0,
                _ => false
            };
            if (!accepted)
            {
                return false;
            }
        }
        return true;
    }

    [GeneratedRegex(@"^[a-z0-9]+(?:[.-][a-z0-9]+){2,}$", RegexOptions.CultureInvariant)]
    private static partial Regex PluginIdPattern();

    [GeneratedRegex(@"^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$", RegexOptions.CultureInvariant)]
    private static partial Regex SemanticVersionPattern();

    [GeneratedRegex(@"^(?<operator>>=|>|<=|<|=)(?<version>\d+\.\d+\.\d+)$", RegexOptions.CultureInvariant)]
    private static partial Regex VersionRangeTermPattern();

    [GeneratedRegex(@"^[0-9a-f]{64}$", RegexOptions.CultureInvariant)]
    private static partial Regex ChecksumPattern();
}
