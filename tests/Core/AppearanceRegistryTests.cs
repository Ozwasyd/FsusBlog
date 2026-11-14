using System.IO.Compression;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using FsusBlog.V2.Core.Extensions;

public sealed class AppearanceRegistryTests
{
    private static readonly DateTimeOffset Now = new(2026, 11, 15, 0, 0, 0, TimeSpan.Zero);

    [Fact]
    public void SignedThemeIsImmutableAndKnownKeyExpiryLatchesAcrossClockRollback()
    {
        if (OperatingSystem.IsWindows() || (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS())) return;
        using var disk = new AppearanceDirectory();
        using var signer = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var clock = new TestClock();
        var source = disk.Add(signer, Theme(), "summer");
        disk.Configure(signer, [source], "summer", Now.AddSeconds(1));
        var registry = AppearanceRegistry.Load(disk.Root, clock);
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
        if (OperatingSystem.IsWindows() || (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS())) return;
        using var disk = new AppearanceDirectory();
        using var signer = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var source = disk.Add(signer, Theme(color, member, link), "summer");
        disk.Configure(signer, [source], "summer");
        Assert.Equal(expected, Assert.Throws<ExtensionRejectedException>(() => AppearanceRegistry.Load(disk.Root, new TestClock())).Code);
    }

    [Fact]
    public void ActivationAndApprovedSignerComeFromTheHostConfiguration()
    {
        if (OperatingSystem.IsWindows() || (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS())) return;
        using var disk = new AppearanceDirectory();
        using var original = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        using var wrong = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var source = disk.Add(original, Theme(), "summer");
        disk.Configure(original, [source], null);
        var clock = new TestClock();
        Assert.Null(AppearanceRegistry.Load(disk.Root, clock).StyleDigest);
        disk.Configure(wrong, [source], "summer");
        Assert.Equal("archive-signature", Assert.Throws<ExtensionRejectedException>(() => AppearanceRegistry.Load(disk.Root, clock)).Code);
        disk.Configure(original, [source], "winter");
        Assert.Equal("appearance-active-reference", Assert.Throws<ExtensionRejectedException>(() => AppearanceRegistry.Load(disk.Root, clock)).Code);
    }

    [Fact]
    public void OnlineSelectionUsesThePublishedArchiveDigestAndNeverRevivesAnExpiredSelection()
    {
        if (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS()) return;
        using var disk = new AppearanceDirectory();
        using var signer = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var source = disk.Add(signer, Theme(), "summer");
        disk.Configure(signer, [source], null);
        var clock = new TestClock();
        var registry = AppearanceRegistry.Load(disk.Root, clock);
        var option = Assert.Single(registry.Available());
        Assert.Equal(new AppearancePackage("summer", "1.0", source.ArchiveSha256, false), option);
        Assert.Equal(new AppearanceSelection(), registry.Default);
        Assert.Empty(registry.SelectedStyle(registry.Default, 0)!);
        var selection = new AppearanceSelection(option.ArchiveDigest);
        Assert.Contains("#225533", System.Text.Encoding.UTF8.GetString(registry.SelectedStyle(selection, 1)!));
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
        if (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS()) return;
        using var disk = new AppearanceDirectory();
        using var signer = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var font = LegacyFontBytes();
        var descriptor = disk.Add(signer, LegacyFont(font), "legacy", "fsfont-v1");
        disk.Configure(signer, [descriptor], null, activeFont: "fsusblog.font.fixture");
        var clock = new TestClock();
        var registry = AppearanceRegistry.Load(disk.Root, clock);
        var listed = Assert.Single(registry.Available());
        Assert.Equal(new AppearancePackage("fsusblog.font.fixture", "1.0.0", descriptor.ArchiveSha256, true), listed);
        Assert.Equal(font, registry.ReadFont(Hash(font)));
        var style = Assert.IsType<byte[]>(registry.SelectedStyle(registry.Default, 7));
        Assert.Contains("unicode-range:U+0000-00FF", System.Text.Encoding.UTF8.GetString(style));
        Assert.Contains("/font/7/" + Hash(font), System.Text.Encoding.UTF8.GetString(style));

        var path = Path.Combine(disk.Root.FullName, descriptor.ArchiveSha256 + ".fsfont");
        var data = File.ReadAllBytes(path);
        data[0] ^= 1;
        File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        File.WriteAllBytes(path, data);
        File.SetUnixFileMode(path, UnixFileMode.UserRead);
        Assert.Equal("archive-digest", Assert.Throws<ExtensionRejectedException>(() => AppearanceRegistry.Load(disk.Root, clock)).Code);
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
        if (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS()) return;
        using var disk = new AppearanceDirectory();
        using var signer = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var source = disk.Add(signer, LegacyFont(LegacyFontBytes(), variation), "legacy", "fsfont-v1");
        disk.Configure(signer, [source], null);
        Assert.Equal(expected, Assert.Throws<ExtensionRejectedException>(() => AppearanceRegistry.Load(disk.Root, new TestClock())).Code);
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

    private static byte[] Theme(string color = "#225533", string? member = null, bool link = false)
    {
        using var result = new MemoryStream();
        using (var zip = new ZipArchive(result, ZipArchiveMode.Create, leaveOpen: true))
        {
            var entry = zip.CreateEntry("manifest.json");
            if (link) entry.ExternalAttributes = unchecked((int)0xa1ff0000);
            using (var file = entry.Open()) JsonSerializer.Serialize(file, new
            {
                Format = 1, Id = "summer", Version = "1.0", Kind = "theme", Publisher = "site.operator",
                SignatureReference = "signature/one", TrustPolicyReference = "trust/policy",
                Theme = new { LightAccent = color, LightHover = "#447733", DarkAccent = "#99eeaa", DarkHover = "#cceedd" }
            });
            if (member is not null && !link)
            {
                foreach (var name in new[] { member, "LICENSE.txt" })
                using (var extra = zip.CreateEntry(name).Open()) extra.Write("forbidden"u8);
            }
        }
        return result.ToArray();
    }

    private static string Hash(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));

    private sealed class TestClock : TimeProvider
    {
        internal DateTimeOffset Now { get; set; } = AppearanceRegistryTests.Now;
        public override DateTimeOffset GetUtcNow() => Now;
    }

    private sealed record Descriptor(string Source, string ArchiveSha256, string SignatureSha256, string? Format = null);

    private sealed class AppearanceDirectory : IDisposable
    {
        public DirectoryInfo Root { get; }

        public AppearanceDirectory()
        {
            Root = Directory.CreateTempSubdirectory("fsus-appearance-");
            if (OperatingSystem.IsMacOS() && Root.FullName.StartsWith("/var/", StringComparison.Ordinal)) Root = new("/private" + Root.FullName);
        }

        internal Descriptor Add(ECDsa signer, byte[] zip, string id, string? format = null)
        {
            var signed = signer.SignData(zip, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
            var manifest = new Descriptor($"approved-source/{id}", Hash(zip), Hash(signed), format);
            Put(manifest.ArchiveSha256 + (format is null ? ".zip" : ".fsfont"), zip);
            Put(manifest.SignatureSha256 + ".signature", signed);
            return manifest;
        }

        internal void Configure(ECDsa signer, Descriptor[] packages, string? activeTheme, DateTimeOffset? cutoff = null, string? activeFont = null)
        {
            var config = new
            {
                Keys = new ExtensionPublisherKey[] { new("site.operator", "first", [.. signer.ExportSubjectPublicKeyInfo()], Now.AddHours(-1), Now.AddHours(1), cutoff) },
                Sources = packages.Select(p => new ApprovedExtensionSource(p.Source, "provenance/reviewed", "site.operator", "first", p.ArchiveSha256, "signature/one", "trust/policy")),
                Packages = packages,
                ActiveTheme = activeTheme,
                ActiveFont = activeFont
            };
            Put("appearance.json", JsonSerializer.SerializeToUtf8Bytes(config));
        }

        private void Put(string name, byte[] bytes)
        {
            if (OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
            var nameInRoot = Path.Combine(Root.FullName, name);
            using (var incoming = new FileStream(nameInRoot + ".tmp", FileMode.CreateNew, FileAccess.Write)) incoming.Write(bytes);
            File.SetUnixFileMode(nameInRoot + ".tmp", UnixFileMode.UserRead);
            File.Move(nameInRoot + ".tmp", nameInRoot, overwrite: true);
        }

        public void Dispose() => Root.Delete(recursive: true);
    }
}
