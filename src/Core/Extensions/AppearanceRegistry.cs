using System.Buffers.Binary;
using System.Collections.Immutable;
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using static FsusBlog.V2.Core.Extensions.ExtensionManifestReader;
using static FsusBlog.V2.Core.Extensions.ExtensionPackageVerifier;

namespace FsusBlog.V2.Core.Extensions;

public sealed partial class AppearanceRegistry
{
    private const int MaxFont = 1024 * 1024;
    private const int MaxTheme = 4096;
    private const int MaxLicense = 32 * 1024;
    private readonly Theme? _theme;
    private readonly Font? _font;
    private readonly TimeProvider _clock;
    private readonly long _loadedAt;
    private readonly ImmutableDictionary<string, Entry> _entries;
    private readonly HashSet<string> _expiredEntries = new(StringComparer.Ordinal);
    private readonly byte[]? _css;
    private int _expired;
    public string? StyleDigest { get; }
    public string? FontDigest => _font?.Hash;

    public static AppearanceRegistry Load(DirectoryInfo root, TimeProvider clock)
    {
        var path = ExtensionDisk.ValidatePrivateRoot(root);
        var configuration = Decode<Registry>(ExtensionDisk.Read(path, "appearance.json", 128 * 1024, default));
        if (configuration.Packages.IsDefault || configuration.Packages.Length > 16 || configuration.Keys.IsDefault ||
            configuration.Keys.Length > 16 || configuration.Sources.IsDefault || configuration.Sources.Length > 16 ||
            configuration.ActiveTheme is not null && !IsIdentifier(configuration.ActiveTheme) ||
            configuration.ActiveFont is not null && !IsIdentifier(configuration.ActiveFont)) throw Reject("appearance-registry-shape");
        if (configuration.Packages.Length != configuration.Sources.Length) throw Reject("appearance-registry-sources");
        var verifier = new ExtensionPackageVerifier(configuration.Keys, configuration.Sources, clock);
        var byId = new Dictionary<string, Entry>(StringComparer.Ordinal);
        var loadedSources = new HashSet<string>(StringComparer.Ordinal);
        foreach (var descriptor in configuration.Packages)
        {
            if (descriptor is null || !IsOpaqueReference(descriptor.Source, "approved-source/") || !loadedSources.Add(descriptor.Source) ||
                !IsDigest(descriptor.ArchiveSha256) || !IsDigest(descriptor.SignatureSha256)) throw Reject("appearance-package-reference");
            var archive = ExtensionDisk.Read(path, descriptor.ArchiveSha256 + ".zip", MaxFont + MaxLicense + 8192, default);
            var signed = ExtensionDisk.Read(path, descriptor.SignatureSha256 + ".signature", MaxSignatureBytes, default);
            if (Digest(signed) != descriptor.SignatureSha256) throw Reject("appearance-signature-digest");
            var trust = verifier.VerifyArchive(descriptor.Source, archive, signed, default, requireCurrent: false);
            if (trust.Source.ArchiveSha256 != descriptor.ArchiveSha256) throw Reject("appearance-archive-reference");
            var item = Read(archive, trust);
            if (!byId.TryAdd(item.Id, item)) throw Reject("appearance-package-id-duplicate");
        }
        var theme = Select<Theme>(byId, configuration.ActiveTheme);
        var font = Select<Font>(byId, configuration.ActiveFont);
        return new(theme, font, clock, byId.ToImmutableDictionary(StringComparer.Ordinal));
    }

    private AppearanceRegistry(Theme? theme, Font? font, TimeProvider clock, ImmutableDictionary<string, Entry> entries)
    {
        _theme = theme;
        _font = font;
        _clock = clock;
        _loadedAt = clock.GetTimestamp();
        _entries = entries;
        if (theme is not null || font is not null)
        {
            _css = Encoding.UTF8.GetBytes(ThemeCss(theme) + FontCss(font));
            StyleDigest = Digest(_css);
        }
    }

    public byte[]? ReadStyle(string digest)
    {
        return _css is not null && digest == StyleDigest && Current() ? _css.ToArray() : null;
    }

    public byte[]? ReadFont(string digest)
    {
        return _font is not null && digest == _font.Hash && Current() ? _font.Bytes.ToArray() : null;
    }

    private bool Current()
    {
        if (Volatile.Read(ref _expired) != 0) return false;
        if (!Current(_theme) || !Current(_font)) Interlocked.Exchange(ref _expired, 1);
        return Volatile.Read(ref _expired) == 0;
    }

    private bool Current(Entry? item)
    {
        if (item is null) return true;
        lock (_expiredEntries)
        {
            if (_expiredEntries.Contains(item.Id)) return false;
            var now = _clock.GetUtcNow();
            if (item.Trust.CheckedAt >= item.Trust.ValidFrom && now >= item.Trust.CheckedAt && now < item.Trust.ValidUntil &&
                _clock.GetElapsedTime(_loadedAt) < item.Trust.ValidUntil - item.Trust.CheckedAt) return true;
            _expiredEntries.Add(item.Id);
            return false;
        }
    }

    private static T? Select<T>(Dictionary<string, Entry> entries, string? id) where T : Entry
    {
        if (id is null) return null;
        return entries.GetValueOrDefault(id) as T ?? throw Reject("appearance-active-reference");
    }

    private static Entry Read(byte[] bytes, SignedArchiveTrust trust)
    {
        try
        {
            using var archive = new ZipArchive(new MemoryStream(bytes, writable: false), ZipArchiveMode.Read);
            if (archive.Entries.Count is not (1 or 3)) throw Reject("appearance-package-entries");
            var entries = new Dictionary<string, ZipArchiveEntry>(StringComparer.Ordinal);
            foreach (var entry in archive.Entries)
            {
                var unixType = (entry.ExternalAttributes >> 16) & 0xf000;
                if (entry.FullName is not ("manifest.json" or "font.woff2" or "LICENSE.txt") || unixType is not (0 or 0x8000) ||
                    (entry.ExternalAttributes & ((int)FileAttributes.ReparsePoint | (int)FileAttributes.Directory)) != 0 ||
                    !entries.TryAdd(entry.FullName, entry)) throw Reject("appearance-entry-shape");
            }
            var manifest = Decode<Manifest>(ReadEntry(entries, "manifest.json", MaxTheme));
            if (manifest.Format != 1 || !IsIdentifier(manifest.Id) || !IsVersion(manifest.Version) ||
                manifest.Publisher != trust.Source.Publisher || manifest.SignatureReference != trust.Source.SignatureReference ||
                manifest.TrustPolicyReference != trust.Source.TrustPolicyReference) throw Reject("appearance-manifest");
            if (manifest.Kind == "theme" && entries.Count == 1 && manifest.Theme is { } palette && manifest.Font is null)
            {
                ValidatePalette(palette);
                return new Theme(manifest.Id, manifest.Version, trust, palette);
            }
            if (manifest.Kind != "font" || entries.Count != 3 || manifest.Theme is not null || manifest.Font is not { } font ||
                font.License is not ("OFL-1.1" or "Apache-2.0") || !IsDigest(font.FontSha256) || !IsDigest(font.LicenseSha256))
                throw Reject("appearance-manifest");
            var license = ReadEntry(entries, "LICENSE.txt", MaxLicense);
            var content = ReadEntry(entries, "font.woff2", MaxFont);
            var licenseText = new UTF8Encoding(false, true).GetString(license);
            if (string.IsNullOrWhiteSpace(licenseText) || licenseText.Any(c => char.IsControl(c) && c is not ('\n' or '\r' or '\t')) ||
                Digest(license) != font.LicenseSha256 || Digest(content) != font.FontSha256) throw Reject("appearance-font-provenance");
            if (content.Length < 48 || !content.AsSpan(0, 4).SequenceEqual("wOF2"u8) ||
                BinaryPrimitives.ReadUInt32BigEndian(content.AsSpan(4, 4)) is not (0x00010000 or 0x4f54544f) ||
                BinaryPrimitives.ReadUInt32BigEndian(content.AsSpan(8, 4)) != content.Length ||
                BinaryPrimitives.ReadUInt16BigEndian(content.AsSpan(12, 2)) is < 1 or > 128 ||
                BinaryPrimitives.ReadUInt16BigEndian(content.AsSpan(14, 2)) != 0 ||
                BinaryPrimitives.ReadUInt32BigEndian(content.AsSpan(16, 4)) > 4 * MaxFont)
                throw Reject("appearance-font-container");
            return new Font(manifest.Id, manifest.Version, trust, font.FontSha256, content);
        }
        catch (Exception error) when (error is IOException or InvalidDataException or DecoderFallbackException or NotSupportedException)
        {
            throw Reject("appearance-archive-invalid");
        }
    }

    private static void ValidatePalette(Palette value)
    {
        foreach (var (color, baseline) in new[] { (value.LightAccent, 0.93), (value.LightHover, 0.93),
            (value.DarkAccent, 0.006), (value.DarkHover, 0.006) })
        {
            if (color.Length != 7 || color[0] != '#' || !color.Skip(1).All(char.IsAsciiHexDigit)) throw Reject("appearance-palette-color");
            var rgb = Convert.FromHexString(color.AsSpan(1));
            var luminance = 0.2126 * Channel(rgb[0]) + 0.7152 * Channel(rgb[1]) + 0.0722 * Channel(rgb[2]);
            var ratio = (Math.Max(luminance, baseline) + 0.05) / (Math.Min(luminance, baseline) + 0.05);
            if (ratio < 4.5) throw Reject("appearance-palette-contrast");
        }

        static double Channel(byte value)
        {
            var srgb = value / 255.0;
            return srgb <= 0.04045 ? srgb / 12.92 : Math.Pow((srgb + 0.055) / 1.055, 2.4);
        }
    }

    private static string ThemeCss(Theme? theme) => theme is null ? "" : $$$"""
        html:root:not(.dark){--fsus-color-action-primary:{{{theme.Palette.LightAccent}}};--fsus-color-action-primary-hover:{{{theme.Palette.LightHover}}}}
        html:root.dark{--fsus-color-action-primary:{{{theme.Palette.DarkAccent}}};--fsus-color-action-primary-hover:{{{theme.Palette.DarkHover}}}}
        @media(prefers-color-scheme:dark){html:root:not(.light):not(.dark){--fsus-color-action-primary:{{{theme.Palette.DarkAccent}}};--fsus-color-action-primary-hover:{{{theme.Palette.DarkHover}}}}}
        """;

    private static string FontCss(Font? font, string? versionPrefix = null) => font is null ? "" : $$"""
        @font-face{font-family:FsusBlogSiteFont;src:url('/site-appearance/font/{{versionPrefix}}{{font.Hash}}.woff2') format('woff2');font-style:normal;font-weight:400;font-display:swap}
        html:root{--el-font-family:FsusBlogSiteFont,'Google Sans',ui-sans-serif,system-ui,sans-serif}
        html:root .fsus-prose{font-family:var(--el-font-family)}
        """;

    private static T Decode<T>(byte[] bytes) where T : class
    {
        try { return JsonSerializer.Deserialize<T>(bytes, Json) ?? throw Reject("appearance-json-shape"); }
        catch (JsonException) { throw Reject("appearance-json-shape"); }
    }

    private static byte[] ReadEntry(Dictionary<string, ZipArchiveEntry> entries, string name, int limit)
    {
        if (!entries.TryGetValue(name, out var entry) || entry.Length <= 0 || entry.Length > limit) throw Reject("appearance-entry-size");
        var bytes = new byte[(int)entry.Length];
        using var file = entry.Open();
        file.ReadExactly(bytes);
        if (file.ReadByte() != -1) throw Reject("appearance-entry-size");
        return bytes;
    }

    private static ExtensionRejectedException Reject(string code) => new(code);

    private sealed record Registry(ImmutableArray<ExtensionPublisherKey> Keys, ImmutableArray<ApprovedExtensionSource> Sources,
        ImmutableArray<Descriptor> Packages, string? ActiveTheme, string? ActiveFont);
    private sealed record Descriptor(string Source, string ArchiveSha256, string SignatureSha256);
    private sealed record Manifest(int Format, string Id, string Version, string Kind, string Publisher, string SignatureReference,
        string TrustPolicyReference, Palette? Theme = null, FontManifest? Font = null);
    private sealed record Palette(string LightAccent, string LightHover, string DarkAccent, string DarkHover);
    private sealed record FontManifest(string License, string FontSha256, string LicenseSha256);
    private abstract record Entry(string Id, string Version, SignedArchiveTrust Trust);
    private sealed record Theme(string Id, string Version, SignedArchiveTrust Trust, Palette Palette) : Entry(Id, Version, Trust);
    private sealed record Font(string Id, string Version, SignedArchiveTrust Trust, string Hash, byte[] Bytes) : Entry(Id, Version, Trust);
}
