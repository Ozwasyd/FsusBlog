using System.Diagnostics;
using System.Text.Json;

namespace FsusBlog.Server.Tests.Unit;

public sealed class CoverageScriptContractTests
{
    private static readonly string[] CoverageScripts =
    [
        "tools/coverage/collect-backend-coverage.sh",
        "tools/coverage/collect-frontend-coverage.sh",
        "tools/coverage/merge-coverage.sh",
        "tools/coverage/check-scope-snapshot.sh",
        "tools/coverage/check-threshold.sh"
    ];

    [Theory]
    [MemberData(nameof(CoverageScriptPaths))]
    public void CoverageScripts_ExistAndAreExecutable(string relativePath)
    {
        string script = Path.Combine(FindRepoRoot(), relativePath);

        Assert.True(File.Exists(script), $"{relativePath} must exist.");

        if (!OperatingSystem.IsWindows())
        {
            UnixFileMode mode = File.GetUnixFileMode(script);
            Assert.True((mode & (UnixFileMode.UserExecute | UnixFileMode.GroupExecute | UnixFileMode.OtherExecute)) != 0,
                $"{relativePath} must be executable.");
        }
    }

    [Theory]
    [MemberData(nameof(CoverageScriptPaths))]
    public void CoverageScripts_DryRunEmitsContractSchema(string relativePath)
    {
        string root = FindRepoRoot();
        string script = Path.Combine(root, relativePath);
        using Process process = new()
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = "bash",
                WorkingDirectory = root,
                RedirectStandardError = true,
                RedirectStandardOutput = true
            }
        };
        process.StartInfo.ArgumentList.Add(script);
        process.StartInfo.ArgumentList.Add("--dry-run");

        process.Start();
        string stdout = process.StandardOutput.ReadToEnd();
        string stderr = process.StandardError.ReadToEnd();
        process.WaitForExit();

        Assert.True(process.ExitCode == 0, $"{relativePath} dry-run failed: {stderr}");

        using JsonDocument document = JsonDocument.Parse(stdout);
        JsonElement rootElement = document.RootElement;
        Assert.Equal("dry-run", rootElement.GetProperty("status").GetString());
        Assert.StartsWith("fsusblog.coverage.", rootElement.GetProperty("schema").GetString(), StringComparison.Ordinal);
    }

    [Fact]
    public void FrontendCoverageCollection_DefaultsLocalVitestThresholdsToArtifactOnly()
    {
        string source = File.ReadAllText(Path.Combine(
            FindRepoRoot(),
            "tools",
            "coverage",
            "collect-frontend-coverage.sh"));

        Assert.Contains(
            "FSUSBLOG_FRONTEND_COVERAGE_LINE_THRESHOLD=\"${FSUSBLOG_FRONTEND_COVERAGE_LINE_THRESHOLD:-0}\"",
            source,
            StringComparison.Ordinal);
        Assert.Contains(
            "FSUSBLOG_FRONTEND_COVERAGE_BRANCH_THRESHOLD=\"${FSUSBLOG_FRONTEND_COVERAGE_BRANCH_THRESHOLD:-0}\"",
            source,
            StringComparison.Ordinal);
        Assert.Contains(
            "FSUSBLOG_FRONTEND_COVERAGE_FUNCTION_THRESHOLD=\"${FSUSBLOG_FRONTEND_COVERAGE_FUNCTION_THRESHOLD:-0}\"",
            source,
            StringComparison.Ordinal);
        Assert.Contains(
            "FSUSBLOG_FRONTEND_COVERAGE_STATEMENT_THRESHOLD=\"${FSUSBLOG_FRONTEND_COVERAGE_STATEMENT_THRESHOLD:-0}\"",
            source,
            StringComparison.Ordinal);
    }

    public static IEnumerable<object[]> CoverageScriptPaths()
    {
        foreach (string script in CoverageScripts)
        {
            yield return [script];
        }
    }

    private static string FindRepoRoot()
    {
        string current = AppContext.BaseDirectory;
        while (!string.IsNullOrWhiteSpace(current))
        {
            if (File.Exists(Path.Combine(current, "FsusBlog.slnx")))
            {
                return current;
            }

            DirectoryInfo? parent = Directory.GetParent(current);
            if (parent is null)
            {
                break;
            }

            current = parent.FullName;
        }

        throw new DirectoryNotFoundException("Unable to locate repository root.");
    }
}
