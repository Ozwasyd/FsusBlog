using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using FsusBlog.V2.Core.Extensions;
using FsusBlog.V2.Platform.Extensions;

namespace FsusBlog.V2.Platform.Tests;

public sealed class AppearanceRegistryLoaderTests
{
    private static readonly DateTimeOffset Now = new(2026, 11, 15, 0, 0, 0, TimeSpan.Zero);

    [Fact]
    public void LoadsSignedThemeAndDetectsDiskTamperingAndPermissionDrift()
    {
        if (OperatingSystem.IsWindows() || (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS())) return;
        using var disk = new AppearanceDirectory();
        using var signer = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var clock = new TestClock();
        var theme = disk.Add(signer, Theme(), "summer");
        disk.Configure(signer, [theme], "summer");

        var registry = AppearanceRegistryLoader.Load(disk.Root, clock);
        var digest = Assert.IsType<string>(registry.StyleDigest);
        var style = Assert.IsType<byte[]>(registry.ReadStyle(digest));
        Assert.Contains("--fsus-color-action-primary:#225533", Encoding.UTF8.GetString(style));

        // Symlinked root must be refused.
        var symlinkRoot = Path.Combine(disk.ParentPath, "linked-appearance");
        Directory.CreateSymbolicLink(symlinkRoot, disk.Root.FullName);
        Assert.Equal("private-root-link",
            Assert.Throws<ExtensionRejectedException>(() => AppearanceRegistryLoader.Load(new DirectoryInfo(symlinkRoot), clock)).Code);

        // Writable file inside root must be refused.
        var archivePath = Path.Combine(disk.Root.FullName, theme.ArchiveSha256 + ".zip");
        File.SetUnixFileMode(archivePath, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        Assert.Equal("installed-file-shape",
            Assert.Throws<ExtensionRejectedException>(() => AppearanceRegistryLoader.Load(disk.Root, clock)).Code);

        // Tampered file restored to 0400 must still be refused by digest check.
        var data = File.ReadAllBytes(archivePath);
        data[0] ^= 1;
        File.WriteAllBytes(archivePath, data);
        File.SetUnixFileMode(archivePath, UnixFileMode.UserRead);
        Assert.Equal("archive-digest",
            Assert.Throws<ExtensionRejectedException>(() => AppearanceRegistryLoader.Load(disk.Root, clock)).Code);

        // Non-0700 directory must be refused.
        File.SetUnixFileMode(disk.Root.FullName, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute | UnixFileMode.GroupRead);
        Assert.Equal("private-root-mode",
            Assert.Throws<ExtensionRejectedException>(() => AppearanceRegistryLoader.Load(disk.Root, clock)).Code);
    }

    private static byte[] Theme()
    {
        using var result = new MemoryStream();
        using (var zip = new ZipArchive(result, ZipArchiveMode.Create, leaveOpen: true))
        {
            using var file = zip.CreateEntry("manifest.json").Open();
            JsonSerializer.Serialize(file, new
            {
                Format = 1, Id = "summer", Version = "1.0", Kind = "theme", Publisher = "site.operator",
                SignatureReference = "signature/one", TrustPolicyReference = "trust/policy",
                Theme = new { LightAccent = "#225533", LightHover = "#447733", DarkAccent = "#99eeaa", DarkHover = "#cceedd" }
            });
        }
        return result.ToArray();
    }

    private static string Hash(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));

    private sealed class TestClock : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => Now;
    }

    private sealed record Descriptor(string Source, string ArchiveSha256, string SignatureSha256, string? Format = null);

    private sealed class AppearanceDirectory : IDisposable
    {
        public string ParentPath { get; }
        public DirectoryInfo Root { get; }

        public AppearanceDirectory()
        {
            var outer = Directory.CreateTempSubdirectory("fsus-appearance-platform-");
            ParentPath = OperatingSystem.IsMacOS() && outer.FullName.StartsWith("/var/", StringComparison.Ordinal)
                ? "/private" + outer.FullName
                : outer.FullName;
            Root = Directory.CreateDirectory(Path.Combine(ParentPath, "registry"));
            if (!OperatingSystem.IsWindows())
                File.SetUnixFileMode(Root.FullName, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }

        internal Descriptor Add(ECDsa signer, byte[] zip, string id, string? format = null)
        {
            var signed = signer.SignData(zip, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
            var manifest = new Descriptor($"approved-source/{id}", Hash(zip), Hash(signed), format);
            var suffix = format switch { "fsfont-v1" => ".fsfont", "fstheme-v1-palette" => ".fstheme", _ => ".zip" };
            Put(manifest.ArchiveSha256 + suffix, zip);
            Put(manifest.SignatureSha256 + ".signature", signed);
            return manifest;
        }

        internal void Configure(ECDsa signer, Descriptor[] packages, string? activeTheme)
        {
            var config = new
            {
                Keys = new ExtensionPublisherKey[] { new("site.operator", "first", [.. signer.ExportSubjectPublicKeyInfo()], Now.AddHours(-1), Now.AddHours(1)) },
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

        public void Dispose()
        {
            if (!OperatingSystem.IsWindows() && Directory.Exists(Root.FullName))
                File.SetUnixFileMode(Root.FullName, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            Directory.Delete(ParentPath, recursive: true);
        }
    }
}
