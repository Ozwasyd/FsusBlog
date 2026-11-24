using FsusBlog.V2.Tests;
using static FsusBlog.V2.Tests.AppearancePackageStore;

public sealed class AppearanceRegistryTests : IDisposable
{
    private readonly AppearanceMemoryStore _store = new();
    private readonly ECDsa _signer = ECDsa.Create(ECCurve.NamedCurves.nistP256);
    private readonly TestClock _clock = new();

    public void Dispose() => _signer.Dispose();

    [Fact]
    public void SignedThemeIsImmutableAndKnownKeyExpiryLatchesAcrossClockRollback()
    {
        Configure(Theme(), "summer", activeTheme: "summer", cutoff: Now.AddSeconds(1));
        var registry = Load();
        var digest = Assert.IsType<string>(registry.StyleDigest);
        var style = Assert.IsType<byte[]>(registry.ReadStyle(digest));
        Assert.Equal(Hash(style), digest);
        Assert.Contains("--fsus-color-action-primary:#225533", Encoding.UTF8.GetString(style));
        style[0] ^= 0xff;
        Assert.Equal(digest, Hash(registry.ReadStyle(digest)!));
        Assert.Null(registry.ReadStyle(new string('0', 64)));
        _clock.Now = Now.AddSeconds(1);
        Assert.Null(registry.ReadStyle(digest));
        _clock.Now = Now;
        Assert.Null(registry.ReadStyle(digest));
    }

    [Theory]
    [InlineData("#aaaaff", "appearance-palette-contrast")]
    [InlineData("red; } @import 'https://invalid'", "appearance-palette-color")]
    [InlineData("#225533", "appearance-entry-shape", "../../theme.css")]
    [InlineData("#225533", "appearance-entry-shape", "manifest.json", true)]
    public void MalformedSignedThemesCannotIntroduceStylesheetContent(string color, string expected, string? member = null, bool link = false)
    {
        Configure(Theme(color, member, link), "summer", activeTheme: "summer");
        AssertLoadRejected(expected);
    }

    [Fact]
    public void ActivationAndApprovedSignerComeFromTheHostConfiguration()
    {
        using var wrong = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var source = Configure(Theme(), "summer");
        Assert.Null(Load().StyleDigest);
        _store.Configure(wrong, [source], "summer");
        AssertLoadRejected("archive-signature");
        _store.Configure(_signer, [source], "winter");
        AssertLoadRejected("appearance-active-reference");
    }

    [Fact]
    public void OnlineSelectionUsesThePublishedArchiveDigestAndNeverRevivesAnExpiredSelection()
    {
        var source = Configure(Theme(), "summer");
        var registry = Load();
        var option = Assert.Single(registry.Available());
        Assert.Equal(new AppearancePackage("summer", "1.0", source.ArchiveSha256, false), option);
        Assert.Null(registry.FontDetail(option.ArchiveDigest));
        Assert.Equal(new AppearanceSelection(), registry.Default);
        Assert.Empty(registry.SelectedStyle(registry.Default, 0)!);
        var selection = new AppearanceSelection(option.ArchiveDigest);
        Assert.Contains("#225533", Encoding.UTF8.GetString(registry.SelectedStyle(selection, 1)!));
        Assert.Null(registry.SelectedStyle(new AppearanceSelection(FontDigest: option.ArchiveDigest), 1));
        _clock.Now = Now.AddHours(2);
        Assert.Null(registry.SelectedStyle(selection, 1));
        _clock.Now = Now;
        Assert.False(registry.IsCurrent(selection));
        Assert.Empty(registry.Available());
        Assert.True(registry.IsCurrent(registry.Default));
    }

    [Fact]
    public void LegacyFontUsesApprovedArchiveAndExactFaceBytes()
    {
        var font = LegacyFontBytes();
        var descriptor = Configure(LegacyFont(font), "legacy", "fsfont-v1", activeFont: "fsusblog.font.fixture");
        var registry = Load();
        Assert.Equal(new AppearancePackage("fsusblog.font.fixture", "1.0.0", descriptor.ArchiveSha256, true), Assert.Single(registry.Available()));
        Assert.Equal(font, registry.ReadFont(Hash(font)));
        Assert.Equal(new AppearanceFontDetail("fsusblog.font.fixture", "1.0.0", descriptor.ArchiveSha256, "Fixture Sans", "Fixture Sans",
            "OFL-1.1", "Fixture license.", 400, "normal", Hash(font), font.Length, "U+0000-00FF",
            new("npm-fontsource", "@fontsource/google-sans", "5.2.1", "Google Fonts")), registry.FontDetail(descriptor.ArchiveSha256));
        Assert.Null(registry.FontDetail(Hash(font)));
        var css = Encoding.UTF8.GetString(Assert.IsType<byte[]>(registry.SelectedStyle(registry.Default, 7)));
        Assert.Contains("unicode-range:U+0000-00FF", css);
        Assert.Contains("/font/7/" + Hash(font), css);

        _store.Tamper(descriptor.ArchiveSha256 + ".fsfont");
        AssertLoadRejected("archive-digest");
        _clock.Now = Now.AddHours(2);
        Assert.Null(registry.FontDetail(descriptor.ArchiveSha256));
        _clock.Now = Now;
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
        Configure(LegacyFont(LegacyFontBytes(), variation), "legacy", "fsfont-v1");
        AssertLoadRejected(expected);
    }

    [Fact]
    public void SignedLegacyPaletteKeepsTheOriginalArchiveCoordinateAndEmitsTheSameV2Tokens()
    {
        using var differentSigner = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var archive = LegacyTheme();
        var source = Configure(archive, "legacy-theme", "fstheme-v1-palette");
        var registry = Load();
        Assert.Null(registry.StyleDigest);
        var choice = Assert.Single(registry.Available());
        Assert.Equal(new AppearancePackage("fsusblog.theme.fixture", "1.0.0", Hash(archive), false), choice);
        var selection = new AppearanceSelection(choice.ArchiveDigest);
        var css = Encoding.UTF8.GetString(Assert.IsType<byte[]>(registry.SelectedStyle(selection, 1)));
        Assert.Contains("html:root:not(.dark){--fsus-color-action-primary:#663322;--fsus-color-action-primary-hover:#774433}", css);
        Assert.Contains("html:root.dark{--fsus-color-action-primary:#eecc99;--fsus-color-action-primary-hover:#ffddcc}", css);
        Assert.DoesNotContain("data-theme", css);
        Assert.DoesNotContain("preview", css);
        _clock.Now = Now.AddHours(1);
        Assert.Null(registry.SelectedStyle(selection, 1));
        _clock.Now = Now;
        Assert.False(registry.IsCurrent(selection));
        _store.Configure(differentSigner, [source], null);
        AssertLoadRejected("archive-signature");
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
        Configure(LegacyTheme(variation), "legacy-theme", "fstheme-v1-palette");
        AssertLoadRejected(expected);
    }

    private Descriptor Configure(byte[] archive, string id, string? format = null, string? activeTheme = null, DateTimeOffset? cutoff = null, string? activeFont = null)
    {
        var descriptor = _store.Add(_signer, archive, id, format);
        _store.Configure(_signer, [descriptor], activeTheme, cutoff, activeFont);
        return descriptor;
    }

    private AppearanceRegistry Load() => AppearanceRegistry.Load(_store.Read, _clock);
    private void AssertLoadRejected(string code) => SignedExtensionFixture.AssertRejected(code, () => Load());

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
        var replacement = variation switch
        {
            "wrong-scope" => ("[data-color-scheme=\"dark\"]", "[data-color-scheme=\"light\"]"),
            "unknown-role" => ("--fsus-color-action-primary:", "--fsus-color-action-primary-bg:"),
            "duplicate" => ("#663322;", "#663322; --fsus-color-action-primary:#123443;"),
            "css-url" => ("#663322;", "url(https://untrusted.invalid);"),
            "contrast" => ("#663322;", "#aaaaff;"),
            _ => default((string Old, string New)?)
        };
        if (replacement is var (oldText, newText)) tokens = tokens.Replace(oldText, newText, StringComparison.Ordinal);
        var style = minimalInk ? $$"""[data-theme="{{id}}"] .fsus-theme-scope { background: var(--fsus-color-page-bg); }"""
            : variation == "theme-css" ? "@import url('unsafe');" : "\n";
        var properties = minimalInk ? "\"fontScale\":{\"type\":\"number\"},\"showAuthor\":{\"type\":\"boolean\"}"
            : variation == "configuration" ? "\"fontScale\":{\"type\":\"number\"}" : "";
        const string pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNoAAAAggCBd81ytgAAAABJRU5ErkJggg==";
        List<(string, byte[], bool)> entries =
        [
            ("manifest.json", JsonSerializer.SerializeToUtf8Bytes(manifest), false),
            ("styles/tokens.css", Encoding.UTF8.GetBytes(tokens), false),
            ("styles/theme.css", Encoding.UTF8.GetBytes(style), false),
            ("assets/preview.png", minimalInk ? [0x89, 0x50, 0x4e, 0x47] : Convert.FromBase64String(pixel), false),
            ("config/schema.json", Encoding.UTF8.GetBytes($$$"""{"type":"object","additionalProperties":false,"properties":{ {{{properties}}} }}"""), false),
        ];
        if (variation == "extra-asset") entries.Add(("docs/README.md", "extra"u8.ToArray(), false));
        return MakeZip([.. entries]);
    }

    private static byte[] LegacyFontBytes()
    {
        var bytes = new byte[48];
        "wOF2"u8.CopyTo(bytes);
        bytes[5] = 1;
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
        List<(string, byte[], bool)> entries =
        [
            ("license/", [], false),
            ("manifest.json", JsonSerializer.SerializeToUtf8Bytes(manifest), false),
            ("license/LICENSE.txt", "Fixture license."u8.ToArray(), false),
            ("license/source.json", JsonSerializer.SerializeToUtf8Bytes(variation == "source" ? source with { upstream = "Other" } : source), false),
            (path, font, variation == "link"),
        ];
        if (variation != "extra") entries.Insert(0, ("fonts/", [], false));
        else entries.Add(("fonts/other.woff2", [], false));
        return MakeZip([.. entries]);
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
