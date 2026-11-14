using System.Globalization;
using System.IO.Compression;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using static FsusBlog.V2.Core.Extensions.ExtensionManifestReader;
using static FsusBlog.V2.Core.Extensions.ExtensionPackageVerifier;

namespace FsusBlog.V2.Core.Extensions;

public sealed partial class AppearanceRegistry
{
    private static readonly JsonSerializerOptions LegacyFontJson = new(Json) { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private static readonly Version LegacyFontVersion = new(1, 3, 0);
    private const string LegacyFontPrefix = @"fsusblog\.font\.";
    private const string LegacyLicense = "license/LICENSE.txt";
    private const string LegacyLicenseSource = "license/source.json";

    private static Font ReadLegacyFont(ZipArchive archive, SignedArchiveTrust trust)
    {
        var entries = LegacyFontEntries(archive);
        var manifest = Decode<LegacyFontManifest>(ReadEntry(entries, "manifest.json", MaxTheme), LegacyFontJson);
        if (manifest.Id is not { } id || !LegacyFontId().IsMatch(id) || id.Length > 128 ||
            !FontVersion(manifest.Version) || !FontAllowsBaseline(manifest.FsusBlog) || manifest.Type != "font" ||
            manifest.Category != "ui-sans" || !FontMetadata(manifest.Name) || !FontMetadata(manifest.Family) ||
            manifest.Scripts is not { Length: 0 } || manifest.Locales is not { Length: 0 } ||
            manifest.Faces is not [{ Weight: 400, Style: "normal", Critical: false } face] ||
            manifest.License is not { Name: "OFL-1.1" or "Apache-2.0", File: LegacyLicense, Source: LegacyLicenseSource } ||
            manifest.Budgets is not { MaxFaces: >= 1 and <= 32, CriticalBytes: >= 0 and <= 16777216, TotalBytes: >= 1 and <= 67108864 } budgets ||
            budgets.CriticalBytes > budgets.TotalBytes ||
            manifest.Loading is not { Display: "swap", Preload.Length: 0, Defer.Length: 0 } ||
            face.File is not { } file || !FontFile().IsMatch(file) || file.Length > 128 ||
            face.ContentHash is not { } digest || !IsDigest(digest) || !ValidUnicodeRange(face.UnicodeRange))
            throw Reject("appearance-fsfont-unsupported");

        if (entries.Count != 4 || !entries.ContainsKey(file)) throw Reject("appearance-entry-shape");
        var source = Decode<LegacyFontSource>(ReadEntry(entries, LegacyLicenseSource, 2048), LegacyFontJson);
        if (source != manifest.Source || source.Kind is not ("local-vendored" or "npm-fontsource") ||
            !FontVersion(source.Version) || !FontMetadata(source.Package) || !FontMetadata(source.Upstream) ||
            source.Package.Contains(':') || source.Package.StartsWith('/') || source.Upstream.Contains(':') ||
            source.Upstream.StartsWith('/'))
            throw Reject("appearance-font-provenance");
        var license = ReadEntry(entries, LegacyLicense, MaxLicense);
        var content = ReadEntry(entries, file, (int)Math.Min(MaxFont, budgets.TotalBytes));
        ValidateFontPayload(license, content, digest);
        return new(id, manifest.Version, trust, digest, content, face.UnicodeRange);
    }

    private static Dictionary<string, ZipArchiveEntry> LegacyFontEntries(ZipArchive archive)
    {
        if (archive.Entries.Count is < 4 or > 6) throw Reject("appearance-package-entries");
        var files = new Dictionary<string, ZipArchiveEntry>(StringComparer.Ordinal);
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var entry in archive.Entries)
        {
            var name = entry.FullName;
            var unixMode = entry.ExternalAttributes >> 16;
            var unixType = unixMode & 0xf000;
            if (!names.Add(name) || (entry.ExternalAttributes & (int)FileAttributes.ReparsePoint) != 0)
                throw Reject("appearance-entry-shape");
            if (name is "fonts/" or "license/")
            {
                if (unixType is not (0 or 0x4000) || entry.Length != 0) throw Reject("appearance-entry-shape");
                continue;
            }
            if (name is not ("manifest.json" or LegacyLicense or LegacyLicenseSource) && !FontFile().IsMatch(name) ||
                unixType is not (0 or 0x8000) || (unixMode & 0x49) != 0 ||
                (entry.ExternalAttributes & (int)FileAttributes.Directory) != 0)
                throw Reject("appearance-entry-shape");
            files.Add(name, entry);
        }
        return files;
    }

    private static bool FontVersion(string? value) => value is { Length: <= 64 } && LegacySemVer().IsMatch(value);

    private static bool FontMetadata(string? value) => value is { Length: > 0 and <= 128 } &&
        !string.IsNullOrWhiteSpace(value) && value.All(character => !char.IsControl(character) && character != '\\');

    private static bool FontAllowsBaseline(string? value)
    {
        if (value is not { Length: > 0 and <= 128 }) return false;
        var constraints = value.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (constraints.Length is < 1 or > 8) return false;
        foreach (var constraint in constraints)
        {
            var width = constraint.StartsWith(">=", StringComparison.Ordinal) || constraint.StartsWith("<=", StringComparison.Ordinal) ? 2 : 1;
            if (constraint.Length <= width || !Version.TryParse(constraint[width..], out var target)) return false;
            var comparison = LegacyFontVersion.CompareTo(target);
            var matched = constraint[..width] switch
            {
                ">=" => comparison >= 0,
                "<=" => comparison <= 0,
                ">" => comparison > 0,
                "<" => comparison < 0,
                "=" => comparison == 0,
                _ => false
            };
            if (!matched) return false;
        }
        return true;
    }

    private static bool ValidUnicodeRange(string? value)
    {
        if (value is null) return true;
        if (value.Length > 160 || !FontUnicodeRange().IsMatch(value)) return false;
        foreach (var item in value.Split(','))
        {
            var coordinates = item.TrimStart(' ').AsSpan(2);
            var separator = coordinates.IndexOf('-');
            var start = int.Parse(separator < 0 ? coordinates : coordinates[..separator], NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture);
            var end = separator < 0 ? start : int.Parse(coordinates[(separator + 1)..], NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture);
            if (start > end || end > 0x10ffff) return false;
        }
        return true;
    }

    [GeneratedRegex("\\A" + LegacyFontPrefix + "[a-z0-9]+(?:-[a-z0-9]+)*\\z", RegexOptions.CultureInvariant)]
    private static partial Regex LegacyFontId();

    [GeneratedRegex(@"\Afonts/[A-Za-z0-9][A-Za-z0-9_-]*\.woff2\z", RegexOptions.CultureInvariant)]
    private static partial Regex FontFile();

    [GeneratedRegex(@"\A[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?\z", RegexOptions.CultureInvariant)]
    private static partial Regex LegacySemVer();

    [GeneratedRegex(@"\A[Uu]\+[0-9A-Fa-f]{1,6}(?:-[0-9A-Fa-f]{1,6})?(?:, ?[Uu]\+[0-9A-Fa-f]{1,6}(?:-[0-9A-Fa-f]{1,6})?)*\z", RegexOptions.CultureInvariant)]
    private static partial Regex FontUnicodeRange();

    private sealed record LegacyFontManifest(string Id, string Name, string Version, [property: JsonPropertyName("fsusblog")] string FsusBlog,
        string Type, string Family,
        string Category, string[] Scripts, string[] Locales, LegacyFontFace[] Faces, LegacyFontLicense License,
        LegacyFontSource Source, LegacyFontBudgets Budgets, LegacyFontLoading Loading);
    private sealed record LegacyFontFace(int Weight, string Style, string File, string ContentHash, bool Critical, string? UnicodeRange = null);
    private sealed record LegacyFontLicense(string Name, string File, string Source);
    private sealed record LegacyFontSource(string Kind, string Package, string Version, string Upstream);
    private sealed record LegacyFontBudgets(long CriticalBytes, long TotalBytes, int MaxFaces);
    private sealed record LegacyFontLoading(string Display, string[] Preload, string[] Defer);
}
