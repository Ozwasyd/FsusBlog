using System.Diagnostics;

namespace FsusBlog.Server.Tests;

public sealed class IgnoreRulesTests
{
    [Theory]
    [InlineData(".env")]
    [InlineData("FsusBlog.Client/.env.development.local")]
    [InlineData("FsusBlog.Server/Logs/log-20990101.txt")]
    [InlineData("FsusBlog.Client/test-results/result.json")]
    [InlineData("FsusBlog.Client/tmp-admin-flow-probe.mjs")]
    [InlineData("FsusBlog.Client/coverage/lcov.info")]
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
        string root = FindRepositoryRoot();
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

    private static string FindRepositoryRoot()
    {
        DirectoryInfo? current = new(AppContext.BaseDirectory);
        while (current is not null)
        {
            if (Directory.Exists(Path.Combine(current.FullName, ".git")))
            {
                return current.FullName;
            }

            current = current.Parent;
        }

        throw new InvalidOperationException("Could not find repository root.");
    }

    private sealed record GitCheckIgnoreResult(bool Ignored, string StandardOutput, string StandardError);
}
