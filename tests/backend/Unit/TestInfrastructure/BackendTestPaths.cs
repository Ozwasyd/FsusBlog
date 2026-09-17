using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;

namespace FsusBlog.Server.Tests.TestInfrastructure;

internal static class BackendTestPaths
{
    public const string RepositoryRootEnvironmentVariable = "FSUSBLOG_REPO_ROOT";

    private static readonly string[] s_requiredRootAnchors =
    [
        "FsusBlog.slnx",
        Path.Combine("src", "backend"),
        Path.Combine("tests", "backend")
    ];

    public static string RepositoryRoot
        => ResolveRepositoryRoot();

    public static string ResolveRepositoryRoot(
        [CallerFilePath] string callerFilePath = "",
        string? appBaseDirectory = null)
        => ResolveRepositoryRootCore(
            Environment.GetEnvironmentVariable(RepositoryRootEnvironmentVariable),
            callerFilePath,
            appBaseDirectory ?? AppContext.BaseDirectory);

    public static string FromRoot(params string[] segments)
        => Path.Combine([RepositoryRoot, .. segments]);

    public static string ReadAllTextFromRoot(params string[] segments)
        => File.ReadAllText(FromRoot(segments));

    public static JsonObject ReadJsonFromRoot(params string[] segments)
        => JsonNode.Parse(ReadAllTextFromRoot(segments))!.AsObject();

    internal static string ResolveRepositoryRootCore(
        string? environmentRoot,
        string? callerFilePath,
        string? appBaseDirectory)
    {
        var checkedStarts = new List<string>();
        if (!string.IsNullOrWhiteSpace(environmentRoot))
        {
            string normalizedEnvironmentRoot = NormalizeDirectory(environmentRoot);
            checkedStarts.Add($"{RepositoryRootEnvironmentVariable}={normalizedEnvironmentRoot}");
            if (IsRepositoryRoot(normalizedEnvironmentRoot))
            {
                return normalizedEnvironmentRoot;
            }

            throw CreateResolutionFailure(checkedStarts);
        }

        foreach (string? start in EnumerateStartPaths(callerFilePath, appBaseDirectory))
        {
            if (string.IsNullOrWhiteSpace(start))
            {
                continue;
            }

            string current = NormalizeStartPath(start);
            checkedStarts.Add(current);
            while (!string.IsNullOrWhiteSpace(current))
            {
                if (IsRepositoryRoot(current))
                {
                    return NormalizeDirectory(current);
                }

                DirectoryInfo? parent = Directory.GetParent(current);
                if (parent is null)
                {
                    break;
                }

                current = parent.FullName;
            }
        }

        throw CreateResolutionFailure(checkedStarts);
    }

    private static IEnumerable<string?> EnumerateStartPaths(string? callerFilePath, string? appBaseDirectory)
    {
        if (!string.IsNullOrWhiteSpace(callerFilePath))
        {
            yield return callerFilePath;
        }

        if (!string.IsNullOrWhiteSpace(appBaseDirectory))
        {
            yield return appBaseDirectory;
        }
    }

    private static bool IsRepositoryRoot(string candidate)
        => File.Exists(Path.Combine(candidate, "FsusBlog.slnx")) &&
            Directory.Exists(Path.Combine(candidate, "src", "backend")) &&
            Directory.Exists(Path.Combine(candidate, "tests", "backend"));

    private static string NormalizeStartPath(string path)
    {
        string fullPath = Path.GetFullPath(path);
        if (Directory.Exists(fullPath))
        {
            return NormalizeDirectory(fullPath);
        }

        string? directory = Path.GetDirectoryName(fullPath);
        return NormalizeDirectory(string.IsNullOrWhiteSpace(directory) ? fullPath : directory);
    }

    private static string NormalizeDirectory(string path)
        => new DirectoryInfo(Path.GetFullPath(path)).FullName;

    private static DirectoryNotFoundException CreateResolutionFailure(IReadOnlyList<string> checkedStarts)
        => new(
            "Unable to locate FsusBlog repository root. " +
            $"Checked start paths: {string.Join(", ", checkedStarts.Distinct(StringComparer.Ordinal))}. " +
            $"Expected anchors at the same root: {string.Join(", ", s_requiredRootAnchors)}.");
}
