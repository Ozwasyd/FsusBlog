using System.Diagnostics;
using System.Text.Json;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class IntegrityProofVerificationMatrixTests
{
    [Fact]
    public async Task VerificationTool_EmitsOfflineReleaseEvidenceAndPropagatesFailure()
    {
        string tempRoot = Directory.CreateTempSubdirectory("fsus-integrity-proof-tool-").FullName;
        try
        {
            string bin = Path.Combine(tempRoot, "bin");
            Directory.CreateDirectory(bin);
            string dotnet = Path.Combine(bin, "dotnet");
            string invocation = Path.Combine(tempRoot, "dotnet-invocation.txt");
            await File.WriteAllTextAsync(dotnet, FakeDotnet);
            File.SetUnixFileMode(dotnet, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);

            string acceptedOutput = Path.Combine(tempRoot, "accepted.json");
            ProcessResult accepted = await RunToolAsync(bin, invocation, acceptedOutput, exitCode: 0);
            Assert.Equal(0, accepted.ExitCode);
            using (JsonDocument evidence = JsonDocument.Parse(await File.ReadAllTextAsync(acceptedOutput)))
            {
                JsonElement root = evidence.RootElement;
                Assert.Equal("fsusblog.integrity-proof-verification.v1", root.GetProperty("schema").GetString());
                Assert.Equal("ok", root.GetProperty("status").GetString());
                Assert.True(root.GetProperty("releaseEvidence").GetBoolean());
                Assert.False(root.GetProperty("externalNetwork").GetBoolean());
                Assert.Equal("FullyQualifiedName~IntegrityProofVerification", root.GetProperty("filter").GetString());
                Assert.Contains(
                    root.GetProperty("command").EnumerateArray(),
                    static value => string.Equals(
                        value.GetString(),
                        "FullyQualifiedName~IntegrityProofVerification",
                        StringComparison.Ordinal));
                Assert.Equal(
                    new[]
                    {
                        "payload tamper",
                        "signature tamper",
                        "keyId tamper",
                        "algorithm mismatch",
                        "log deletion",
                        "log reorder",
                        "checkpoint tamper"
                    },
                    root.GetProperty("tamperMatrix").EnumerateArray().Select(static value => value.GetString()).ToArray());
                Assert.Equal(
                    new[] { "articleRevisionId", "revisionNo", "ArticleDetailAeds", "PublicHotRead", "PublicAOT" },
                    root.GetProperty("publicModels").EnumerateArray().Select(static value => value.GetString()).ToArray());
            }

            string commandLine = await File.ReadAllTextAsync(invocation);
            Assert.Contains("test tests/backend/FsusBlog.Server.Tests.csproj", commandLine, StringComparison.Ordinal);
            Assert.Contains("--filter FullyQualifiedName~IntegrityProofVerification", commandLine, StringComparison.Ordinal);

            string rejectedOutput = Path.Combine(tempRoot, "rejected.json");
            ProcessResult rejected = await RunToolAsync(bin, invocation, rejectedOutput, exitCode: 17);
            Assert.Equal(17, rejected.ExitCode);
            using JsonDocument failedEvidence = JsonDocument.Parse(await File.ReadAllTextAsync(rejectedOutput));
            Assert.Equal("failed", failedEvidence.RootElement.GetProperty("status").GetString());
            Assert.False(failedEvidence.RootElement.GetProperty("externalNetwork").GetBoolean());
        }
        finally
        {
            Directory.Delete(tempRoot, recursive: true);
        }
    }

    private static async Task<ProcessResult> RunToolAsync(
        string bin,
        string invocation,
        string output,
        int exitCode)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = "node",
            WorkingDirectory = BackendTestPaths.RepositoryRoot,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        };
        startInfo.ArgumentList.Add(BackendTestPaths.FromRoot("tools", "integrity", "verify-proof-fixtures.mjs"));
        startInfo.ArgumentList.Add("--out");
        startInfo.ArgumentList.Add(output);
        startInfo.Environment["PATH"] = $"{bin}:/usr/bin:/bin";
        startInfo.Environment["FSUSBLOG_FAKE_DOTNET_INVOCATION"] = invocation;
        startInfo.Environment["FSUSBLOG_FAKE_DOTNET_EXIT"] = exitCode.ToString(System.Globalization.CultureInfo.InvariantCulture);

        using Process process = Process.Start(startInfo)!;
        Task<string> stdout = process.StandardOutput.ReadToEndAsync();
        Task<string> stderr = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        return new ProcessResult(process.ExitCode, await stdout, await stderr);
    }

    private const string FakeDotnet = """
        #!/usr/bin/env bash
        set -euo pipefail
        printf '%s\n' "$*" > "$FSUSBLOG_FAKE_DOTNET_INVOCATION"
        exit "$FSUSBLOG_FAKE_DOTNET_EXIT"
        """;

    private sealed record ProcessResult(int ExitCode, string StandardOutput, string StandardError);
}
