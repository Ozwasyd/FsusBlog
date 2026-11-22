namespace FsusBlog.V2.Platform.Tests;

internal sealed class PlatformScratchDirectory : IDisposable
{
    internal string FullName { get; }

    internal PlatformScratchDirectory(string prefix)
    {
        var root = Directory.CreateTempSubdirectory(prefix);
        FullName = OperatingSystem.IsMacOS() && root.FullName.StartsWith("/var/", StringComparison.Ordinal)
            ? "/private" + root.FullName
            : root.FullName;
    }

    public void Dispose() => Directory.Delete(FullName, recursive: true);
}
