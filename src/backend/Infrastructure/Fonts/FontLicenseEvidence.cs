using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.Shared.Contracts.Fonts;

namespace FsusBlog.Server.Infrastructure.Fonts;

public sealed record FontLicenseEvidenceFont(
    string Id,
    string License,
    string Source,
    bool HashVerified);

public sealed record FontLicenseEvidenceViolation(
    string Code,
    string FontId);

public sealed record FontLicenseEvidence(
    string Schema,
    string Status,
    IReadOnlyList<FontLicenseEvidenceFont> Fonts,
    IReadOnlyList<FontLicenseEvidenceViolation> Violations);

public static class FontLicenseEvidenceWriter
{
    public const string Schema = "fsusblog.font.license.v1";
    public const string RelativeReleasePath = ".tmp/release-evidence/font-license-summary.json";

    private static readonly JsonSerializerOptions s_jsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        WriteIndented = true
    };

    public static async Task<FontLicenseEvidence> CreateAsync(
        FontRegistrySnapshot snapshot,
        string registryRoot,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        ArgumentException.ThrowIfNullOrWhiteSpace(registryRoot);

        string assetRoot = Path.Combine(Path.GetFullPath(registryRoot), "assets");
        var fonts = new List<FontLicenseEvidenceFont>();
        var violations = new List<FontLicenseEvidenceViolation>();
        foreach (FontRegistryEntry entry in snapshot.Fonts
                     .Where(static entry => !entry.BuiltIn)
                     .OrderBy(static entry => entry.Id, StringComparer.Ordinal))
        {
            FontManifest? manifest = null;
            FontSourceDescriptor? source = null;
            try
            {
                manifest = JsonSerializer.Deserialize<FontManifest>(entry.ManifestJson, s_jsonOptions);
                source = JsonSerializer.Deserialize<FontSourceDescriptor>(
                    entry.LicenseSourceJson,
                    s_jsonOptions);
            }
            catch (JsonException)
            {
                AddViolation(violations, "font_metadata_invalid", entry.Id);
            }

            if (manifest is null
                || source is null
                || string.IsNullOrWhiteSpace(entry.LicenseText)
                || !Equals(source, manifest.Source)
                || !FontManifestValidator.Validate(manifest, new Version(1, 3, 0)).IsValid
                || entry.Faces is null
                || manifest.Faces.Count != entry.Faces.Count
                || manifest.Faces.Any(face => !entry.Faces.Any(
                    stored => stored.Weight == face.Weight
                        && string.Equals(stored.Style, face.Style, StringComparison.Ordinal)
                        && string.Equals(stored.ContentHash, face.ContentHash, StringComparison.Ordinal))))
            {
                AddViolation(violations, "font_metadata_invalid", entry.Id);
                continue;
            }

            bool hashVerified = true;
            foreach (FontRegistryFace face in entry.Faces)
            {
                if (!FontManifestValidator.IsSha256(face.ContentHash))
                {
                    AddViolation(violations, "font_metadata_invalid", entry.Id);
                    hashVerified = false;
                    continue;
                }

                string assetPath = Path.Combine(assetRoot, $"{face.ContentHash}.woff2");
                if (!File.Exists(assetPath))
                {
                    AddViolation(violations, "font_asset_missing", entry.Id);
                    hashVerified = false;
                    continue;
                }

                byte[] content = await File.ReadAllBytesAsync(assetPath, cancellationToken)
                    .ConfigureAwait(false);
                string hash = Convert.ToHexStringLower(SHA256.HashData(content));
                if (content.LongLength != face.SizeBytes
                    || !string.Equals(hash, face.ContentHash, StringComparison.Ordinal))
                {
                    AddViolation(violations, "font_asset_hash_mismatch", entry.Id);
                    hashVerified = false;
                }
            }

            fonts.Add(new FontLicenseEvidenceFont(
                entry.Id,
                manifest.License.Name,
                $"{source.Package}@{source.Version}",
                hashVerified));
        }

        return new FontLicenseEvidence(
            Schema,
            violations.Count == 0 ? "ok" : "blocked",
            fonts.AsReadOnly(),
            violations
                .OrderBy(static violation => violation.FontId, StringComparer.Ordinal)
                .ThenBy(static violation => violation.Code, StringComparer.Ordinal)
                .ToArray());
    }

    public static async Task<FontLicenseEvidence> WriteAsync(
        FontRegistrySnapshot snapshot,
        string registryRoot,
        string outputPath,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(outputPath);
        FontLicenseEvidence evidence = await CreateAsync(
            snapshot,
            registryRoot,
            cancellationToken).ConfigureAwait(false);
        string resolved = Path.GetFullPath(outputPath);
        string? directory = Path.GetDirectoryName(resolved);
        if (directory is null)
        {
            throw new ArgumentException("Evidence output must have a parent directory.", nameof(outputPath));
        }

        Directory.CreateDirectory(directory);
        string temporaryPath = Path.Combine(directory, $".font-license-{Guid.NewGuid():N}.tmp");
        try
        {
            await using (var destination = new FileStream(
                temporaryPath,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None,
                bufferSize: 16 * 1024,
                FileOptions.Asynchronous | FileOptions.WriteThrough))
            {
                await JsonSerializer.SerializeAsync(
                    destination,
                    evidence,
                    s_jsonOptions,
                    cancellationToken).ConfigureAwait(false);
                await destination.FlushAsync(cancellationToken).ConfigureAwait(false);
            }

            File.Move(temporaryPath, resolved, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporaryPath))
            {
                File.Delete(temporaryPath);
            }
        }

        return evidence;
    }

    private static void AddViolation(
        ICollection<FontLicenseEvidenceViolation> violations,
        string code,
        string fontId)
    {
        if (!violations.Any(
                violation => string.Equals(violation.Code, code, StringComparison.Ordinal)
                    && string.Equals(violation.FontId, fontId, StringComparison.Ordinal)))
        {
            violations.Add(new FontLicenseEvidenceViolation(code, fontId));
        }
    }
}
