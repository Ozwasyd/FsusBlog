using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

using FsusBlog.Shared.Contracts.Fonts;

namespace FsusBlog.Server.Infrastructure.Fonts;

public static class FontPackageFormat
{
    public const string Extension = ".fsfont";
}

public sealed class FontPackageException(string code, string message) : Exception(message)
{
    public string Code
    {
        get;
    } = code;
}

public sealed class FontPackageFace
{
    internal FontPackageFace(
        FontFaceDescriptor descriptor,
        string contentHash,
        long sizeBytes,
        byte[] content)
    {
        Descriptor = descriptor;
        ContentHash = contentHash;
        SizeBytes = sizeBytes;
        ContentBytes = content;
    }

    public FontFaceDescriptor Descriptor
    {
        get;
    }

    public string ContentHash
    {
        get;
    }

    public long SizeBytes
    {
        get;
    }

    public ReadOnlyMemory<byte> Content
    {
        get => ContentBytes;
    }

    internal byte[] ContentBytes
    {
        get;
    }
}

public sealed class ValidatedFontPackage
{
    internal ValidatedFontPackage(
        FontManifest manifest,
        IReadOnlyList<FontPackageFace> faces,
        string manifestJson,
        string licenseText,
        string licenseSourceJson)
    {
        Manifest = manifest;
        Faces = faces;
        ManifestJson = manifestJson;
        LicenseText = licenseText;
        LicenseSourceJson = licenseSourceJson;
    }

    public FontManifest Manifest
    {
        get;
    }

    public IReadOnlyList<FontPackageFace> Faces
    {
        get;
    }

    public string ManifestJson
    {
        get;
    }

    public string LicenseText
    {
        get;
    }

    public string LicenseSourceJson
    {
        get;
    }
}

public static partial class FontPackageReader
{
    private const int MaxManifestBytes = 256 * 1024;
    private const int MaxMetadataFileBytes = 2 * 1024 * 1024;
    private const int MaxArchiveEntries = 128;
    private static readonly JsonSerializerOptions s_jsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };

    public static async Task<ValidatedFontPackage> ReadAsync(
        Stream packageStream,
        Version currentFsusBlogVersion,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(packageStream);
        ArgumentNullException.ThrowIfNull(currentFsusBlogVersion);
        if (!packageStream.CanRead)
        {
            throw new FontPackageException("package_stream_unreadable", "Font package stream must be readable.");
        }

        using var archive = new ZipArchive(packageStream, ZipArchiveMode.Read, leaveOpen: true);
        if (archive.Entries.Count == 0 || archive.Entries.Count > MaxArchiveEntries)
        {
            throw new FontPackageException("package_entry_count_invalid", "Font package contains an invalid number of entries.");
        }

        Dictionary<string, ZipArchiveEntry> entries = IndexEntries(archive);
        ZipArchiveEntry manifestEntry = RequireFile(entries, "manifest.json");
        string manifestJson = await ReadTextAsync(
            manifestEntry,
            MaxManifestBytes,
            cancellationToken).ConfigureAwait(false);
        FontManifest manifest;
        try
        {
            manifest = JsonSerializer.Deserialize<FontManifest>(manifestJson, s_jsonOptions)
                ?? throw new JsonException("Manifest was null.");
        }
        catch (JsonException exception)
        {
            throw new FontPackageException("font_manifest_json_invalid", $"Font manifest is not valid JSON: {exception.Message}");
        }

        ZipArchiveEntry licenseEntry = RequireFile(
            entries,
            manifest.License?.File ?? "license/LICENSE.txt");
        ZipArchiveEntry sourceEntry = RequireFile(
            entries,
            manifest.License?.Source ?? "license/source.json");
        FontManifestValidation validation = FontManifestValidator.Validate(manifest, currentFsusBlogVersion);
        if (!validation.IsValid)
        {
            throw new FontPackageException(
                validation.Errors.Contains("font_fsusblog_version_incompatible", StringComparer.Ordinal)
                    ? "font_fsusblog_version_incompatible"
                    : "font_manifest_invalid",
                $"Font manifest validation failed: {string.Join(", ", validation.Errors)}.");
        }

        ValidateMetadataEntries(entries, manifest);
        await ValidateLocalCssAsync(entries, cancellationToken).ConfigureAwait(false);
        string licenseText = await ReadTextAsync(
            licenseEntry,
            MaxMetadataFileBytes,
            cancellationToken).ConfigureAwait(false);
        if (string.IsNullOrWhiteSpace(licenseText))
        {
            throw new FontPackageException(
                "font_license_file_invalid",
                "Font license file must contain declared license text.");
        }

        string licenseSourceJson = await ReadTextAsync(
            sourceEntry,
            MaxMetadataFileBytes,
            cancellationToken).ConfigureAwait(false);
        ValidateLicenseSourceJson(licenseSourceJson, manifest.Source);
        var faces = new List<FontPackageFace>(manifest.Faces.Count);
        long totalBytes = 0;
        long criticalBytes = 0;
        foreach (FontFaceDescriptor descriptor in manifest.Faces)
        {
            ZipArchiveEntry entry = RequireFile(entries, descriptor.File);
            long remainingTotalBytes = manifest.Budgets.TotalBytes - totalBytes;
            if (entry.Length > remainingTotalBytes)
            {
                throw new FontPackageException(
                    "font_budget_total_exceeded",
                    "Font package exceeds its declared total-byte budget.");
            }

            if (descriptor.Critical
                && entry.Length > manifest.Budgets.CriticalBytes - criticalBytes)
            {
                throw new FontPackageException(
                    "font_budget_critical_exceeded",
                    "Font package exceeds its declared critical-byte budget.");
            }

            byte[] content = await ReadBytesAsync(
                entry,
                remainingTotalBytes,
                cancellationToken).ConfigureAwait(false);
            if (!HasWoff2Signature(content))
            {
                throw new FontPackageException(
                    "font_asset_signature_invalid",
                    $"Font asset '{descriptor.File}' is not a WOFF2 file.");
            }

            string contentHash = Convert.ToHexStringLower(SHA256.HashData(content));
            if (!string.Equals(descriptor.ContentHash, contentHash, StringComparison.Ordinal))
            {
                throw new FontPackageException(
                    "font_asset_hash_mismatch",
                    $"Font asset '{descriptor.File}' does not match its declared SHA-256 hash.");
            }

            totalBytes = checked(totalBytes + content.LongLength);
            if (descriptor.Critical)
            {
                criticalBytes = checked(criticalBytes + content.LongLength);
            }

            faces.Add(new FontPackageFace(
                descriptor,
                contentHash,
                content.LongLength,
                content));
        }

        if (faces.Count > manifest.Budgets.MaxFaces)
        {
            throw new FontPackageException(
                "font_budget_face_count_exceeded",
                "Font package exceeds its declared face-count budget.");
        }

        if (totalBytes > manifest.Budgets.TotalBytes)
        {
            throw new FontPackageException(
                "font_budget_total_exceeded",
                "Font package exceeds its declared total-byte budget.");
        }

        if (criticalBytes > manifest.Budgets.CriticalBytes)
        {
            throw new FontPackageException(
                "font_budget_critical_exceeded",
                "Font package exceeds its declared critical-byte budget.");
        }

        return new ValidatedFontPackage(
            manifest,
            faces.AsReadOnly(),
            manifestJson,
            licenseText,
            licenseSourceJson);
    }

    private static Dictionary<string, ZipArchiveEntry> IndexEntries(ZipArchive archive)
    {
        var entries = new Dictionary<string, ZipArchiveEntry>(StringComparer.Ordinal);
        foreach (ZipArchiveEntry entry in archive.Entries)
        {
            bool directory = entry.FullName.EndsWith("/", StringComparison.Ordinal);
            string candidate = directory ? entry.FullName[..^1] : entry.FullName;
            if (!FontPackagePath.TryNormalize(candidate, out string path))
            {
                throw new FontPackageException(
                    "package_path_invalid",
                    $"Font package path '{entry.FullName}' is invalid.");
            }

            if (directory)
            {
                continue;
            }

            if (!entries.TryAdd(path, entry))
            {
                throw new FontPackageException(
                    "package_entry_duplicate",
                    $"Font package path '{path}' is duplicated.");
            }
        }

        return entries;
    }

    private static void ValidateMetadataEntries(
        IReadOnlyDictionary<string, ZipArchiveEntry> entries,
        FontManifest manifest)
    {
        HashSet<string> declaredFaces = manifest.Faces
            .Select(static face => face.File)
            .ToHashSet(StringComparer.Ordinal);
        foreach ((string path, ZipArchiveEntry entry) in entries)
        {
            if (IsExecutableEntry(entry, path))
            {
                throw new FontPackageException(
                    "package_executable_forbidden",
                    $"Executable package entry '{path}' is forbidden.");
            }

            if (path.StartsWith("fonts/", StringComparison.Ordinal))
            {
                if (!path.EndsWith(".woff2", StringComparison.OrdinalIgnoreCase))
                {
                    throw new FontPackageException(
                        "font_asset_must_be_woff2",
                        $"Font asset '{path}' must use the .woff2 format.");
                }

                if (!declaredFaces.Contains(path))
                {
                    throw new FontPackageException(
                        "font_asset_not_declared",
                        $"Font asset '{path}' is not declared by the manifest.");
                }
            }
            else if (IsFontAssetPath(path))
            {
                throw new FontPackageException(
                    "font_asset_outside_fonts",
                    $"Font asset '{path}' must be stored below fonts/.");
            }
            else if (entry.Length > MaxMetadataFileBytes && path != "manifest.json")
            {
                throw new FontPackageException(
                    "package_metadata_too_large",
                    $"Font package metadata file '{path}' is too large.");
            }
        }
    }

    private static ZipArchiveEntry RequireFile(
        IReadOnlyDictionary<string, ZipArchiveEntry> entries,
        string path)
    {
        if (!FontPackagePath.TryNormalize(path, out string normalized)
            || !entries.TryGetValue(normalized, out ZipArchiveEntry? entry))
        {
            throw new FontPackageException(
                "package_required_file_missing",
                $"Font package required file '{path}' is missing.");
        }

        return entry;
    }

    private static async Task ValidateLocalCssAsync(
        IReadOnlyDictionary<string, ZipArchiveEntry> entries,
        CancellationToken cancellationToken)
    {
        foreach ((string path, ZipArchiveEntry entry) in entries)
        {
            if (!path.StartsWith("css/", StringComparison.Ordinal)
                || !path.EndsWith(".css", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            string css = await ReadTextAsync(
                entry,
                MaxMetadataFileBytes,
                cancellationToken).ConfigureAwait(false);
            if (RemoteCssUrlPattern().IsMatch(css))
            {
                throw new FontPackageException(
                    "font_remote_url_forbidden",
                    $"Font package CSS '{path}' contains a remote URL.");
            }
        }
    }

    private static async Task<string> ReadTextAsync(
        ZipArchiveEntry entry,
        int maximumBytes,
        CancellationToken cancellationToken)
    {
        byte[] content = await ReadBytesAsync(entry, maximumBytes, cancellationToken).ConfigureAwait(false);
        return System.Text.Encoding.UTF8.GetString(content);
    }

    private static async Task<byte[]> ReadBytesAsync(
        ZipArchiveEntry entry,
        long maximumBytes,
        CancellationToken cancellationToken)
    {
        if (entry.Length < 0 || entry.Length > maximumBytes || entry.Length > int.MaxValue)
        {
            throw new FontPackageException(
                "package_entry_too_large",
                $"Font package entry '{entry.FullName}' exceeds its permitted size.");
        }

        byte[] content = GC.AllocateUninitializedArray<byte>((int)entry.Length);
        await using Stream source = entry.Open();
        int offset = 0;
        while (offset < content.Length)
        {
            int read = await source.ReadAsync(content.AsMemory(offset), cancellationToken).ConfigureAwait(false);
            if (read == 0)
            {
                throw new FontPackageException(
                    "package_entry_truncated",
                    $"Font package entry '{entry.FullName}' ended unexpectedly.");
            }

            offset += read;
        }

        if (await source.ReadAsync(new byte[1], cancellationToken).ConfigureAwait(false) != 0)
        {
            throw new FontPackageException(
                "package_entry_size_mismatch",
                $"Font package entry '{entry.FullName}' exceeded its declared size.");
        }

        return content;
    }

    private static bool HasWoff2Signature(ReadOnlySpan<byte> content)
        => content.Length >= 4
            && content[0] == 0x77
            && content[1] == 0x4f
            && content[2] == 0x46
            && content[3] == 0x32;

    [GeneratedRegex(
        """url\s*\(\s*['"]?(?:https?:)?//""",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.NonBacktracking)]
    private static partial Regex RemoteCssUrlPattern();

    private static bool IsExecutableEntry(ZipArchiveEntry entry, string path)
    {
        const int UnixExecuteBits = 0b001_001_001;
        int unixMode = entry.ExternalAttributes >> 16;
        string extension = Path.GetExtension(path);
        return (unixMode & UnixExecuteBits) != 0
            || extension.Equals(".bat", StringComparison.OrdinalIgnoreCase)
            || extension.Equals(".cmd", StringComparison.OrdinalIgnoreCase)
            || extension.Equals(".com", StringComparison.OrdinalIgnoreCase)
            || extension.Equals(".dll", StringComparison.OrdinalIgnoreCase)
            || extension.Equals(".dylib", StringComparison.OrdinalIgnoreCase)
            || extension.Equals(".exe", StringComparison.OrdinalIgnoreCase)
            || extension.Equals(".js", StringComparison.OrdinalIgnoreCase)
            || extension.Equals(".mjs", StringComparison.OrdinalIgnoreCase)
            || extension.Equals(".cjs", StringComparison.OrdinalIgnoreCase)
            || extension.Equals(".ps1", StringComparison.OrdinalIgnoreCase)
            || extension.Equals(".scr", StringComparison.OrdinalIgnoreCase)
            || extension.Equals(".sh", StringComparison.OrdinalIgnoreCase)
            || extension.Equals(".so", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsFontAssetPath(string path)
    {
        string extension = Path.GetExtension(path);
        return extension.Equals(".eot", StringComparison.OrdinalIgnoreCase)
            || extension.Equals(".otf", StringComparison.OrdinalIgnoreCase)
            || extension.Equals(".ttf", StringComparison.OrdinalIgnoreCase)
            || extension.Equals(".woff", StringComparison.OrdinalIgnoreCase)
            || extension.Equals(".woff2", StringComparison.OrdinalIgnoreCase);
    }

    private static void ValidateLicenseSourceJson(
        string sourceJson,
        FontSourceDescriptor expected)
    {
        try
        {
            FontSourceDescriptor source = JsonSerializer.Deserialize<FontSourceDescriptor>(
                sourceJson,
                s_jsonOptions)
                ?? throw new JsonException("Source metadata was null.");
            if (!Equals(source, expected)
                || FontManifestValidator.ContainsRemoteUrl(source.Package)
                || FontManifestValidator.ContainsRemoteUrl(source.Upstream))
            {
                throw new FontPackageException(
                    "font_source_mismatch",
                    "Font source metadata must exactly match the local manifest declaration.");
            }
        }
        catch (JsonException exception)
        {
            throw new FontPackageException(
                "font_license_source_invalid",
                $"Font license source is not valid JSON: {exception.Message}");
        }
    }
}
