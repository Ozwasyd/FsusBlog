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

    private sealed record Descriptor(string Source, string ArchiveSha256, string SignatureSha256);

    private sealed class AppearanceDirectory : IDisposable
    {
        public DirectoryInfo Root { get; }

        public AppearanceDirectory()
        {
            Root = Directory.CreateTempSubdirectory("fsus-appearance-");
            if (OperatingSystem.IsMacOS() && Root.FullName.StartsWith("/var/", StringComparison.Ordinal)) Root = new("/private" + Root.FullName);
        }

        internal Descriptor Add(ECDsa signer, byte[] zip, string id)
        {
            var signed = signer.SignData(zip, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
            var manifest = new Descriptor($"approved-source/{id}", Hash(zip), Hash(signed));
            Put(manifest.ArchiveSha256 + ".zip", zip);
            Put(manifest.SignatureSha256 + ".signature", signed);
            return manifest;
        }

        internal void Configure(ECDsa signer, Descriptor[] packages, string? activeTheme, DateTimeOffset? cutoff = null)
        {
            var config = new
            {
                Keys = new ExtensionPublisherKey[] { new("site.operator", "first", [.. signer.ExportSubjectPublicKeyInfo()], Now.AddHours(-1), Now.AddHours(1), cutoff) },
                Sources = packages.Select(p => new ApprovedExtensionSource(p.Source, "provenance/reviewed", "site.operator", "first", p.ArchiveSha256, "signature/one", "trust/policy")),
                Packages = packages,
                ActiveTheme = activeTheme,
                ActiveFont = (string?)null
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
