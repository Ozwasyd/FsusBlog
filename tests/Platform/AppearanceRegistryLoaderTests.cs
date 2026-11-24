using FsusBlog.V2.Tests;
using static FsusBlog.V2.Platform.Tests.PlatformScratchDirectory;
using static FsusBlog.V2.Tests.AppearancePackageStore;
using static FsusBlog.V2.Tests.SignedExtensionFixture;

namespace FsusBlog.V2.Platform.Tests;

public sealed class AppearanceRegistryLoaderTests
{
    [Fact]
    public void LoadsSignedThemeAndDetectsDiskTamperingAndPermissionDrift()
    {
        if (OperatingSystem.IsWindows() || !IsPosix) return;
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
        AssertRejected("private-root-link", () => AppearanceRegistryLoader.Load(new DirectoryInfo(symlinkRoot), clock));

        // Writable file inside root must be refused.
        var archivePath = Path.Combine(disk.Root.FullName, theme.ArchiveSha256 + ".zip");
        File.SetUnixFileMode(archivePath, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        AssertRejected("installed-file-shape", () => AppearanceRegistryLoader.Load(disk.Root, clock));

        // Tampered file restored to 0400 must still be refused by digest check.
        var data = File.ReadAllBytes(archivePath);
        data[0] ^= 1;
        File.WriteAllBytes(archivePath, data);
        File.SetUnixFileMode(archivePath, UnixFileMode.UserRead);
        AssertRejected("archive-digest", () => AppearanceRegistryLoader.Load(disk.Root, clock));

        // Non-0700 directory must be refused.
        File.SetUnixFileMode(disk.Root.FullName, Mode0700 | UnixFileMode.GroupRead);
        AssertRejected("private-root-mode", () => AppearanceRegistryLoader.Load(disk.Root, clock));
    }

    private sealed class AppearanceDirectory : AppearancePackageStore, IDisposable
    {
        private readonly PlatformScratchDirectory _outer = new("fsus-appearance-platform-");
        public string ParentPath => _outer.FullName;
        public DirectoryInfo Root { get; }

        public AppearanceDirectory() => Root = _outer.CreatePrivateSubdirectory("registry");

        protected override void Put(string name, byte[] bytes) => WriteReadOnly(Root.FullName, name, bytes);

        public void Dispose()
        {
            if (!OperatingSystem.IsWindows() && Directory.Exists(Root.FullName)) File.SetUnixFileMode(Root.FullName, Mode0700);
            _outer.Dispose();
        }
    }
}
