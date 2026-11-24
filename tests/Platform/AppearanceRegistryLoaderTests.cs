using FsusBlog.V2.Tests;
using static FsusBlog.V2.Tests.AppearancePackageStore;

namespace FsusBlog.V2.Platform.Tests;

public sealed class AppearanceRegistryLoaderTests
{
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

    private sealed class AppearanceDirectory : AppearancePackageStore, IDisposable
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

        protected override void Put(string name, byte[] bytes)
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
