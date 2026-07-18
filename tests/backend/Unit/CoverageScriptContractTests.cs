using System.Diagnostics;
using System.Text.Json;

using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class CoverageScriptContractTests
{
    private static readonly string[] s_coverageScripts =
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
        string script = BackendTestPaths.FromRoot(relativePath);

        Assert.True(File.Exists(script), $"{relativePath} must exist.");
        if (!OperatingSystem.IsWindows())
        {
            UnixFileMode mode = File.GetUnixFileMode(script);
            Assert.NotEqual(
                UnixFileMode.None,
                mode & (UnixFileMode.UserExecute | UnixFileMode.GroupExecute | UnixFileMode.OtherExecute));
        }
    }

    [Theory]
    [MemberData(nameof(CoverageScriptPaths))]
    public async Task CoverageScripts_DryRunEmitsContractSchemaAndTerminates(string relativePath)
    {
        string script = BackendTestPaths.FromRoot(relativePath);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using Process process = new()
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = "bash",
                WorkingDirectory = BackendTestPaths.RepositoryRoot,
                RedirectStandardError = true,
                RedirectStandardOutput = true
            }
        };
        process.StartInfo.ArgumentList.Add(script);
        process.StartInfo.ArgumentList.Add("--dry-run");

        process.Start();
        Task<string> stdoutTask = process.StandardOutput.ReadToEndAsync(timeout.Token);
        Task<string> stderrTask = process.StandardError.ReadToEndAsync(timeout.Token);
        await process.WaitForExitAsync(timeout.Token);
        string stdout = await stdoutTask;
        string stderr = await stderrTask;

        Assert.True(process.ExitCode == 0, $"{relativePath} dry-run failed: {stderr}");
        using JsonDocument document = JsonDocument.Parse(stdout);
        JsonElement output = document.RootElement;
        Assert.Equal("dry-run", output.GetProperty("status").GetString());
        Assert.StartsWith("fsusblog.coverage.", output.GetProperty("schema").GetString(), StringComparison.Ordinal);
    }

    public static IEnumerable<object[]> CoverageScriptPaths()
        => s_coverageScripts.Select(static script => new object[] { script });
}
