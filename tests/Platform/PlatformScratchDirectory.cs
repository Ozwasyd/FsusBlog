namespace FsusBlog.V2.Platform.Tests;

internal sealed class PlatformScratchDirectory : IDisposable
{
    internal const UnixFileMode Mode0700 = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute;
    internal static bool IsPosix => !OperatingSystem.IsWindows() && (OperatingSystem.IsLinux() || OperatingSystem.IsMacOS());

    internal string FullName { get; }
    internal DirectoryInfo Info { get; }

    internal PlatformScratchDirectory(string prefix, bool restrictMode = false)
    {
        var root = Directory.CreateTempSubdirectory(prefix);
        FullName = OperatingSystem.IsMacOS() && root.FullName.StartsWith("/var/", StringComparison.Ordinal)
            ? "/private" + root.FullName
            : root.FullName;
        Info = new DirectoryInfo(FullName);
        if (restrictMode && !OperatingSystem.IsWindows()) File.SetUnixFileMode(FullName, Mode0700);
    }

    internal DirectoryInfo CreatePrivateSubdirectory(string name)
    {
        var directory = Directory.CreateDirectory(Path.Combine(FullName, name));
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(directory.FullName, Mode0700);
        return directory;
    }

    internal static void WriteReadOnly(string directory, string name, byte[] bytes)
    {
        if (OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        var target = Path.Combine(directory, name);
        var temporary = target + ".test";
        File.WriteAllBytes(temporary, bytes);
        File.SetUnixFileMode(temporary, UnixFileMode.UserRead);
        File.Move(temporary, target, overwrite: true);
    }

    public void Dispose()
    {
        if (!OperatingSystem.IsWindows() && Directory.Exists(FullName)) File.SetUnixFileMode(FullName, Mode0700);
        Directory.Delete(FullName, recursive: true);
    }
}
