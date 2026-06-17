using System.Diagnostics;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests;

public sealed class IgnoreRulesTests
{
    [Theory]
    [InlineData(".env")]
    [InlineData(".venv/bin/activate")]
    [InlineData("tools/__pycache__/helper.cpython-312.pyc")]
    [InlineData(".pytest_cache/README.md")]
    [InlineData("htmlcov/index.html")]
    [InlineData(".coverage.unit")]
    [InlineData("src/frontend/.env.development.local")]
    [InlineData("src/backend/Logs/log-20990101.txt")]
    [InlineData("src/frontend/test-results/result.json")]
    [InlineData("src/frontend/tmp-admin-flow-probe.mjs")]
    [InlineData("src/frontend/coverage/lcov.info")]
    public async Task GitIgnore_CoversLocalRuntimeArtifacts(string path)
    {
        GitCheckIgnoreResult result = await GitCheckIgnoreAsync(path);

        Assert.True(result.Ignored, $"Expected {path} to be ignored. stderr={result.StandardError}");
    }

    [Fact]
    public async Task GitIgnore_DoesNotIgnoreControlledWasmReleaseArtifact()
    {
        GitCheckIgnoreResult result = await GitCheckIgnoreAsync("build/artifacts/wasm-release/aeds_decoder.wasm");

        Assert.False(result.Ignored, $"Controlled wasm artifact should stay trackable. stdout={result.StandardOutput}");
    }

    private static async Task<GitCheckIgnoreResult> GitCheckIgnoreAsync(string path)
    {
        string root = BackendTestPaths.RepositoryRoot;
        GitCheckIgnoreResult result = await RunGitCheckIgnoreAsync(root, path);
        if (!result.Ignored &&
            result.StandardError.Contains("beyond a symbolic link", StringComparison.Ordinal) &&
            TryFindSymbolicLinkPrefix(root, path, out string symbolicPrefix) &&
            GitIgnoreCoversDirectory(root, symbolicPrefix))
        {
            return new GitCheckIgnoreResult(true, string.Empty, result.StandardError);
        }

        return result;
    }

    private static async Task<GitCheckIgnoreResult> RunGitCheckIgnoreAsync(string root, string path)
    {
        var startInfo = new ProcessStartInfo("git", $"check-ignore --quiet -- {path}")
        {
            WorkingDirectory = root,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };

        using Process process = Process.Start(startInfo) ?? throw new InvalidOperationException("Failed to start git.");
        string stdout = await process.StandardOutput.ReadToEndAsync();
        string stderr = await process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        return new GitCheckIgnoreResult(process.ExitCode == 0, stdout, stderr);
    }

    private static bool TryFindSymbolicLinkPrefix(string root, string relativePath, out string symbolicPrefix)
    {
        string[] segments = relativePath.Split(['/', '\\'], StringSplitOptions.RemoveEmptyEntries);
        for (int i = 1; i < segments.Length; i++)
        {
            string candidateRelativePath = string.Join(Path.DirectorySeparatorChar, segments.Take(i));
            string candidateFullPath = Path.Combine(root, candidateRelativePath);
            try
            {
                var fileInfo = new FileInfo(candidateFullPath);
                var directoryInfo = new DirectoryInfo(candidateFullPath);
                if (!string.IsNullOrEmpty(fileInfo.LinkTarget) ||
                    !string.IsNullOrEmpty(directoryInfo.LinkTarget) ||
                    (File.GetAttributes(candidateFullPath) & FileAttributes.ReparsePoint) != 0)
                {
                    symbolicPrefix = string.Join('/', segments.Take(i));
                    return true;
                }
            }
            catch (FileNotFoundException)
            {
            }
            catch (DirectoryNotFoundException)
            {
            }
        }

        symbolicPrefix = string.Empty;
        return false;
    }

    private static bool GitIgnoreCoversDirectory(string root, string relativeDirectory)
    {
        string normalizedDirectory = relativeDirectory.Replace('\\', '/').TrimEnd('/');
        string directoryName = Path.GetFileName(normalizedDirectory);
        foreach (string rawLine in File.ReadLines(Path.Combine(root, ".gitignore")))
        {
            string line = rawLine.Trim();
            if (line.Length == 0 || line.StartsWith('#') || line.StartsWith('!'))
            {
                continue;
            }

            string normalizedRule = line.Replace('\\', '/').TrimEnd('/');
            if (normalizedRule == normalizedDirectory ||
                normalizedRule == $"{normalizedDirectory}/**" ||
                normalizedRule == directoryName ||
                normalizedRule == $"**/{directoryName}")
            {
                return true;
            }
        }

        return false;
    }

    private sealed record GitCheckIgnoreResult(bool Ignored, string StandardOutput, string StandardError);
}
