internal static partial class XunitAdapterProgram
{
    private static string? ResolveReferencePack(string targetFramework)
    {
        List<string> candidates = new();
        string? runtimeRoot = ResolveDotnetRoot();
        if (!string.IsNullOrWhiteSpace(runtimeRoot))
            candidates.Add(runtimeRoot);
        string? dotnetRoot = Environment.GetEnvironmentVariable("DOTNET_ROOT");
        if (!string.IsNullOrWhiteSpace(dotnetRoot))
            candidates.Add(dotnetRoot);
        string? dotnet = FindOnPath("dotnet");
        if (dotnet is not null)
        {
            FileInfo info = new(dotnet);
            string resolved = info.LinkTarget is null
                ? dotnet
                : Path.GetFullPath(Path.Combine(info.DirectoryName ?? "", info.LinkTarget));
            candidates.Add(Path.GetDirectoryName(resolved) ?? "");
        }
        candidates.Add("/usr/share/dotnet");
        candidates.Add("/usr/lib/dotnet");
        foreach (string candidate in candidates.Where(item => !string.IsNullOrWhiteSpace(item)))
        {
            string packRoot = Path.Combine(candidate, "packs", "Microsoft.NETCore.App.Ref");
            if (!Directory.Exists(packRoot))
                continue;
            string? best = null;
            foreach (string version in Directory.EnumerateDirectories(packRoot).OrderBy(item => item, StringComparer.Ordinal).Reverse())
            {
                string refDir = Path.Combine(version, "ref", targetFramework);
                if (Directory.Exists(refDir))
                {
                    best = refDir;
                    break;
                }
            }
            if (best is not null)
                return best;
        }
        return null;
    }

    private static string? ResolveDotnetRoot()
    {
        string? dotnetRoot = Environment.GetEnvironmentVariable("DOTNET_ROOT");
        if (!string.IsNullOrWhiteSpace(dotnetRoot) && Directory.Exists(dotnetRoot))
            return dotnetRoot;
        string runtimeDir = System.Runtime.InteropServices.RuntimeEnvironment.GetRuntimeDirectory();
        if (!string.IsNullOrWhiteSpace(runtimeDir))
        {
            string candidate = Path.GetFullPath(Path.Combine(runtimeDir, "..", "..", "..", ".."));
            if (Directory.Exists(Path.Combine(candidate, "shared")))
                return candidate;
        }
        foreach (string candidate in new[] { "/usr/share/dotnet", "/usr/lib/dotnet" })
        {
            if (Directory.Exists(Path.Combine(candidate, "shared")))
                return candidate;
        }
        string? dotnet = FindOnPath("dotnet");
        if (dotnet is not null)
        {
            FileInfo info = new(dotnet);
            if (info.LinkTarget is not null)
            {
                string resolved = Path.GetFullPath(Path.Combine(info.DirectoryName ?? "", info.LinkTarget));
                string root = Path.GetDirectoryName(resolved) ?? "";
                if (Directory.Exists(Path.Combine(root, "shared")))
                    return root;
            }
            string fromPath = Path.GetDirectoryName(Path.GetDirectoryName(dotnet)) ?? "";
            if (Directory.Exists(Path.Combine(fromPath, "shared")))
                return fromPath;
        }
        return null;
    }

    private static string? FindOnPath(string executable)
    {
        string pathValue = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string directory in pathValue.Split(Path.PathSeparator))
        {
            if (string.IsNullOrWhiteSpace(directory))
                continue;
            string candidate = Path.Combine(directory.Trim(), executable);
            if (File.Exists(candidate))
                return candidate;
            if (OperatingSystem.IsWindows() && File.Exists(candidate + ".exe"))
                return candidate + ".exe";
        }
        return null;
    }

}
