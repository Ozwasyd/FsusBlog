using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using FsusBlog.V2.Core.Extensions;
using FsusBlog.V2.Tests;
using static FsusBlog.V2.Tests.AppearancePackageStore;

public sealed class AppearanceRegistryTests
{
    [Fact]
    public void SignedThemeIsImmutableAndKnownKeyExpiryLatchesAcrossClockRollback()
    {
        var store = new AppearanceMemoryStore();
        using var signer = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var clock = new TestClock();
        var source = store.Add(signer, Theme(), "summer");
        store.Configure(signer, [source], "summer", Now.AddSeconds(1));
        var registry = AppearanceRegistry.Load(store.Read, clock);
        var digest = Assert.IsType<string>(registry.StyleDigest);
        var style = Assert.IsType<byte[]>(registry.ReadStyle(digest));
        Assert.Equal(Hash(style), digest);
        Assert.Contains("--fsus-color-action-primary:#225533", Encoding.UTF8.GetString(style));
        style[0] ^= 0xff;
        Assert.Equal(digest, Hash(registry.ReadStyle(digest)!));
        Assert.Null(registry.ReadStyle(new string('0', 64)));
        clock.Now = Now.AddSeconds(1);
        Assert.Null(registry.ReadStyle(digest));
        clock.Now = Now;
        Assert.Null(registry.ReadStyle(digest));
    }

    [Theory]
    [InlineData("#aaaaff", "appearance-palette-contrast")]
    [InlineData("red; } @import 'https://invalid'", "appearance-palette-color")]
    [InlineData("#225533", "appearance-entry-shape", "../../theme.css")]
    [InlineData("#225533", "appearance-entry-shape", "manifest.json", true)]
    public void MalformedSignedThemesCannotIntroduceStylesheetContent(string color, string expected, string? member = null, bool link = false)
    {
        var store = new AppearanceMemoryStore();
        using var signer = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var source = store.Add(signer, Theme(color, member, link), "summer");
        store.Configure(signer, [source], "summer");
        Assert.Equal(expected, Assert.Throws<ExtensionRejectedException>(() => AppearanceRegistry.Load(store.Read, new TestClock())).Code);
    }

    [Fact]
    public void ActivationAndApprovedSignerComeFromTheHostConfiguration()
    {
        var store = new AppearanceMemoryStore();
        using var original = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        using var wrong = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var source = store.Add(original, Theme(), "summer");
        store.Configure(original, [source], null);
        var clock = new TestClock();
        Assert.Null(AppearanceRegistry.Load(store.Read, clock).StyleDigest);
        store.Configure(wrong, [source], "summer");
        Assert.Equal("archive-signature", Assert.Throws<ExtensionRejectedException>(() => AppearanceRegistry.Load(store.Read, clock)).Code);
        store.Configure(original, [source], "winter");
        Assert.Equal("appearance-active-reference", Assert.Throws<ExtensionRejectedException>(() => AppearanceRegistry.Load(store.Read, clock)).Code);
    }

    [Fact]
    public void OnlineSelectionUsesThePublishedArchiveDigestAndNeverRevivesAnExpiredSelection()
    {
        var store = new AppearanceMemoryStore();
        using var signer = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var source = store.Add(signer, Theme(), "summer");
        store.Configure(signer, [source], null);
        var clock = new TestClock();
        var registry = AppearanceRegistry.Load(store.Read, clock);
        var option = Assert.Single(registry.Available());
        Assert.Equal(new AppearancePackage("summer", "1.0", source.ArchiveSha256, false), option);
        Assert.Null(registry.FontDetail(option.ArchiveDigest));
        Assert.Equal(new AppearanceSelection(), registry.Default);
        Assert.Empty(registry.SelectedStyle(registry.Default, 0)!);
        var selection = new AppearanceSelection(option.ArchiveDigest);
        Assert.Contains("#225533", Encoding.UTF8.GetString(registry.SelectedStyle(selection, 1)!));
        Assert.Null(registry.SelectedStyle(new AppearanceSelection(FontDigest: option.ArchiveDigest), 1));
        clock.Now = Now.AddHours(2);
        Assert.Null(registry.SelectedStyle(selection, 1));
        clock.Now = Now;
        Assert.False(registry.IsCurrent(selection));
        Assert.Empty(registry.Available());
        Assert.True(registry.IsCurrent(registry.Default));
    }

    [Fact]
    public void LegacyFontUsesApprovedArchiveAndExactFaceBytes()
    {
        var store = new AppearanceMemoryStore();
        using var signer = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var font = LegacyFontBytes();
        var descriptor = store.Add(signer, LegacyFont(font), "legacy", "fsfont-v1");
        store.Configure(signer, [descriptor], null, activeFont: "fsusblog.font.fixture");
        var clock = new TestClock();
        var registry = AppearanceRegistry.Load(store.Read, clock);
        var listed = Assert.Single(registry.Available());
        Assert.Equal(new AppearancePackage("fsusblog.font.fixture", "1.0.0", descriptor.ArchiveSha256, true), listed);
        Assert.Equal(font, registry.ReadFont(Hash(font)));
        Assert.Equal(new AppearanceFontDetail("fsusblog.font.fixture", "1.0.0", descriptor.ArchiveSha256, "Fixture Sans", "Fixture Sans",
            "OFL-1.1", "Fixture license.", 400, "normal", Hash(font), font.Length, "U+0000-00FF",
            new("npm-fontsource", "@fontsource/google-sans", "5.2.1", "Google Fonts")), registry.FontDetail(descriptor.ArchiveSha256));
        Assert.Null(registry.FontDetail(Hash(font)));
        var style = Assert.IsType<byte[]>(registry.SelectedStyle(registry.Default, 7));
        Assert.Contains("unicode-range:U+0000-00FF", Encoding.UTF8.GetString(style));
        Assert.Contains("/font/7/" + Hash(font), Encoding.UTF8.GetString(style));

        store.Tamper(descriptor.ArchiveSha256 + ".fsfont");
        Assert.Equal("archive-digest", Assert.Throws<ExtensionRejectedException>(() => AppearanceRegistry.Load(store.Read, clock)).Code);
        clock.Now = Now.AddHours(2);
        Assert.Null(registry.FontDetail(descriptor.ArchiveSha256));
        clock.Now = Now;
        Assert.Null(registry.FontDetail(descriptor.ArchiveSha256));
    }

    [Theory]
    [InlineData("range", "appearance-fsfont-unsupported")]
    [InlineData("preload", "appearance-fsfont-unsupported")]
    [InlineData("critical", "appearance-fsfont-unsupported")]
    [InlineData("category", "appearance-fsfont-unsupported")]
    [InlineData("locale", "appearance-fsfont-unsupported")]
    [InlineData("compatibility", "appearance-fsfont-unsupported")]
    [InlineData("source", "appearance-font-provenance")]
    [InlineData("hash", "appearance-font-provenance")]
    [InlineData("extra", "appearance-entry-shape")]
    [InlineData("link", "appearance-entry-shape")]
    [InlineData("budget", "appearance-entry-size")]
    public void SignedLegacyFontRejectsUnsupportedOrMismatchedContents(string variation, string expected)
    {
        var store = new AppearanceMemoryStore();
        using var signer = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var source = store.Add(signer, LegacyFont(LegacyFontBytes(), variation), "legacy", "fsfont-v1");
        store.Configure(signer, [source], null);
        Assert.Equal(expected, Assert.Throws<ExtensionRejectedException>(() => AppearanceRegistry.Load(store.Read, new TestClock())).Code);
    }

    [Fact]
    public void SignedLegacyPaletteKeepsTheOriginalArchiveCoordinateAndEmitsTheSameV2Tokens()
    {
        var store = new AppearanceMemoryStore();
        using var signer = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        using var differentSigner = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var archive = LegacyTheme();
        var source = store.Add(signer, archive, "legacy-theme", "fstheme-v1-palette");
        var clock = new TestClock();
        store.Configure(signer, [source], null);
        var registry = AppearanceRegistry.Load(store.Read, clock);
        Assert.Null(registry.StyleDigest);
        var choice = Assert.Single(registry.Available());
        Assert.Equal(new AppearancePackage("fsusblog.theme.fixture", "1.0.0", Hash(archive), false), choice);
        var selection = new AppearanceSelection(choice.ArchiveDigest);
        var css = Encoding.UTF8.GetString(Assert.IsType<byte[]>(registry.SelectedStyle(selection, 1)));
        Assert.Contains("html:root:not(.dark){--fsus-color-action-primary:#663322;--fsus-color-action-primary-hover:#774433}", css);
        Assert.Contains("html:root.dark{--fsus-color-action-primary:#eecc99;--fsus-color-action-primary-hover:#ffddcc}", css);
        Assert.DoesNotContain("data-theme", css);
        Assert.DoesNotContain("preview", css);
        clock.Now = Now.AddHours(1);
        Assert.Null(registry.SelectedStyle(selection, 1));
        clock.Now = Now;
        Assert.False(registry.IsCurrent(selection));
        store.Configure(differentSigner, [source], null);
        Assert.Equal("archive-signature", Assert.Throws<ExtensionRejectedException>(() => AppearanceRegistry.Load(store.Read, clock)).Code);
    }

    [Theory]
    [InlineData("minimal-ink", "appearance-fstheme-unsupported")]
    [InlineData("extra-asset", "appearance-fstheme-unsupported")]
    [InlineData("configuration", "appearance-fstheme-unsupported")]
    [InlineData("theme-css", "appearance-fstheme-unsupported")]
    [InlineData("selector-budget", "appearance-fstheme-unsupported")]
    [InlineData("wrong-scope", "appearance-fstheme-palette")]
    [InlineData("unknown-role", "appearance-fstheme-palette")]
    [InlineData("duplicate", "appearance-fstheme-palette")]
    [InlineData("css-url", "appearance-fstheme-palette")]
    [InlineData("contrast", "appearance-palette-contrast")]
    public void SignedLegacyPaletteRejectsUnsupportedThemeSemantics(string variation, string expected)
    {
        var store = new AppearanceMemoryStore();
        using var signer = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var source = store.Add(signer, LegacyTheme(variation), "legacy-theme", "fstheme-v1-palette");
        store.Configure(signer, [source], null);
        Assert.Equal(expected, Assert.Throws<ExtensionRejectedException>(() => AppearanceRegistry.Load(store.Read, new TestClock())).Code);
    }

    private static byte[] LegacyTheme(string variation = "")
    {
        var minimalInk = variation == "minimal-ink";
        var id = minimalInk ? "fsusblog.theme.minimal-ink" : "fsusblog.theme.fixture";
        var manifest = new
        {
            id, name = minimalInk ? "Minimal Ink" : "Fixture accents", version = "1.0.0", fsusblog = ">=1.3.0 <1.4.0",
            author = "example", description = "A reading theme", type = "theme",
            entry = new { tokens = "styles/tokens.css", theme = "styles/theme.css" }, modes = new[] { "light", "dark" },
            supports = new { @public = true, admin = false, console = false, highContrast = minimalInk, reducedMotion = minimalInk, rtl = false },
            assets = new { preview = "assets/preview.png" }, configSchema = "config/schema.json",
            permissions = new { script = false, network = false, filesystem = false },
            budgets = new { cssBytes = 65536, assetBytes = 524288, maxSelectors = variation == "selector-budget" ? 1 : 512, maxSelectorDepth = 4,
                maxImportant = 8, maxMotionDurationMs = 1000, previewBytes = 262144 }
        };
        var tokens = minimalInk ? $$""":root[data-theme="{{id}}"] { --fsus-color-page-bg: #fff; }""" : $$"""
            :root[data-theme="{{id}}"] { --fsus-color-action-primary: #663322; --fsus-color-action-primary-hover: #774433; }
            :root[data-theme="{{id}}"][data-color-scheme="dark"] { --fsus-color-action-primary: #eecc99; --fsus-color-action-primary-hover: #ffddcc; }
            """;
        tokens = variation switch
        {
            "wrong-scope" => tokens.Replace("[data-color-scheme=\"dark\"]", "[data-color-scheme=\"light\"]", StringComparison.Ordinal),
            "unknown-role" => tokens.Replace("--fsus-color-action-primary:", "--fsus-color-action-primary-bg:", StringComparison.Ordinal),
            "duplicate" => tokens.Replace("#663322;", "#663322; --fsus-color-action-primary:#123443;", StringComparison.Ordinal),
            "css-url" => tokens.Replace("#663322;", "url(https://untrusted.invalid);", StringComparison.Ordinal),
            "contrast" => tokens.Replace("#663322;", "#aaaaff;", StringComparison.Ordinal),
            _ => tokens
        };
        var style = minimalInk ? $$"""[data-theme="{{id}}"] .fsus-theme-scope { background: var(--fsus-color-page-bg); }"""
            : variation == "theme-css" ? "@import url('unsafe');" : "\n";
        var properties = minimalInk ? "\"fontScale\":{\"type\":\"number\"},\"showAuthor\":{\"type\":\"boolean\"}"
            : variation == "configuration" ? "\"fontScale\":{\"type\":\"number\"}" : "";
        const string pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNoAAAAggCBd81ytgAAAABJRU5ErkJggg==";
        using var output = new MemoryStream();
        using (var zip = new ZipArchive(output, ZipArchiveMode.Create, leaveOpen: true))
        {
            Write("manifest.json", JsonSerializer.SerializeToUtf8Bytes(manifest));
            Write("styles/tokens.css", Encoding.UTF8.GetBytes(tokens));
            Write("styles/theme.css", Encoding.UTF8.GetBytes(style));
            Write("assets/preview.png", minimalInk ? [0x89, 0x50, 0x4e, 0x47] : Convert.FromBase64String(pixel));
            Write("config/schema.json", Encoding.UTF8.GetBytes($$$"""
                {"type":"object","additionalProperties":false,"properties":{ {{{properties}}} }}
                """));
            if (variation == "extra-asset") Write("docs/README.md", "extra"u8);

            void Write(string name, ReadOnlySpan<byte> content)
            {
                using var stream = zip.CreateEntry(name).Open();
                stream.Write(content);
            }
        }
        return output.ToArray();
    }

    private static byte[] LegacyFontBytes()
    {
        var bytes = new byte[48];
        "wOF2"u8.CopyTo(bytes);
        bytes[5] = 1;  // SFNT flavor 0x00010000.
        bytes[11] = 48;
        bytes[13] = 1;
        return bytes;
    }

    private static byte[] LegacyFont(byte[] font, string variation = "")
    {
        var source = new { kind = "npm-fontsource", package = "@fontsource/google-sans", version = "5.2.1", upstream = "Google Fonts" };
        const string path = "fonts/body-regular.woff2";
        var manifest = new
        {
            id = "fsusblog.font.fixture", name = "Fixture Sans", family = "Fixture Sans", version = "1.0.0",
            fsusblog = variation == "compatibility" ? ">=1.4.0 <2.0.0" : ">=1.3.0 <1.4.0", type = "font",
            category = variation == "category" ? "prose-sans" : "ui-sans",
            scripts = Array.Empty<string>(), locales = variation == "locale" ? new[] { "en-US" } : [],
            faces = new[] { new { weight = 400, style = "normal", file = path, contentHash = Hash(variation == "hash" ? [] : font),
                unicodeRange = variation == "range" ? "U+0000-00FF;background:red" : "U+0000-00FF", critical = variation == "critical" } },
            license = new { name = "OFL-1.1", file = "license/LICENSE.txt", source = "license/source.json" },
            source, budgets = new { criticalBytes = 0, totalBytes = variation == "budget" ? 4 : 1_048_576, maxFaces = 1 },
            loading = new { display = "swap", preload = variation == "preload" ? new[] { "400" } : [], defer = Array.Empty<string>() }
        };
        using var output = new MemoryStream();
        using (var archive = new ZipArchive(output, ZipArchiveMode.Create, leaveOpen: true))
        {
            if (variation != "extra") Add("fonts/", []);
            Add("license/", []);
            Add("manifest.json", JsonSerializer.SerializeToUtf8Bytes(manifest));
            Add("license/LICENSE.txt", "Fixture license."u8);
            Add("license/source.json", JsonSerializer.SerializeToUtf8Bytes(variation == "source" ? source with { upstream = "Other" } : source));
            Add(path, font, link: variation == "link");
            if (variation == "extra") Add("fonts/other.woff2", []);

            void Add(string name, ReadOnlySpan<byte> bytes, bool link = false)
            {
                var entry = archive.CreateEntry(name);
                if (link) entry.ExternalAttributes = unchecked((int)0xa1ff0000);
                using var stream = entry.Open();
                stream.Write(bytes);
            }
        }
        return output.ToArray();
    }

    private sealed class AppearanceMemoryStore : AppearancePackageStore
    {
        private readonly Dictionary<string, byte[]> _files = new(StringComparer.Ordinal);

        protected override void Put(string name, byte[] bytes) => _files[name] = bytes.ToArray();

        internal void Tamper(string name)
        {
            var data = _files[name].ToArray();
            data[0] ^= 1;
            _files[name] = data;
        }

        internal byte[] Read(string name, int limit)
        {
            if (!_files.TryGetValue(name, out var bytes)) throw new FileNotFoundException("Missing in-memory appearance fixture.", name);
            if (bytes.Length is < 1 || bytes.Length > limit) throw new ExtensionRejectedException("installed-file-size");
            return bytes.ToArray();
        }
    }
}
