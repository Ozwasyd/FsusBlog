using System.Diagnostics;
using System.Security;
using System.Text.Json;
using System.Text.Json.Nodes;

using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class IntegrityProofVerificationMatrixTests
{
    [Fact]
    public async Task ProjectionTool_EmitsIndependentReceiptAndPropagatesFailure()
    {
        string tempRoot = BackendTestPaths.FromRoot(
            ".tmp",
            $"integrity-proof-projection-{Guid.NewGuid():N}");
        Directory.CreateDirectory(tempRoot);
        try
        {
            string catalogFile = Path.Combine(tempRoot, "catalog.json");
            string trxFile = Path.Combine(tempRoot, "backend.trx");
            string sourceFile = Path.Combine(tempRoot, "source.json");
            string producerFile = Path.Combine(tempRoot, "producer.json");
            string projectedFile = Path.Combine(tempRoot, "projected.json");
            string sourceRelativePath = Path.GetRelativePath(BackendTestPaths.RepositoryRoot, sourceFile)
                .Replace(Path.DirectorySeparatorChar, '/');

            JsonNode catalog = JsonNode.Parse(await File.ReadAllTextAsync(BackendTestPaths.FromRoot(
                "tests",
                "fixtures",
                "evidence-projection",
                "integrity-proof-verification.json")))!;
            catalog["requiredArtifactDeclarations"]![0]!["path"] = sourceRelativePath;
            await File.WriteAllTextAsync(catalogFile, catalog.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));

            IEnumerable<string> sourceTestIds = catalog["producerAssertions"]!.AsArray()
                .Select(static entry => entry!["sourceTestId"]!.GetValue<string>());
            string results = string.Join(
                Environment.NewLine,
                sourceTestIds.Select(static id =>
                    $"    <UnitTestResult testName=\"{SecurityElement.Escape(id)}\" outcome=\"Passed\" />"));
            await File.WriteAllTextAsync(
                trxFile,
                $"<?xml version=\"1.0\" encoding=\"utf-8\"?>{Environment.NewLine}<TestRun><Results>{Environment.NewLine}{results}{Environment.NewLine}</Results></TestRun>{Environment.NewLine}");

            string commit = new('a', 40);
            string fingerprint = new('b', 64);
            ProcessResult produced = await RunNodeAsync(
                "tools/test/produce-integrity-proof-evidence.mjs",
                "--catalog", catalogFile,
                "--trx", trxFile,
                "--root", BackendTestPaths.RepositoryRoot,
                "--commit", commit,
                "--worktree-fingerprint", fingerprint,
                "--run-id", "run-1",
                "--namespace", "namespace-1",
                "--producer-output", producerFile,
                "--source-output", sourceFile);
            Assert.Equal(0, produced.ExitCode);
            Assert.True(File.Exists(producerFile));
            Assert.True(File.Exists(sourceFile));

            ProcessResult accepted = await RunNodeAsync(
                "tools/test/project-evidence.mjs",
                "--catalog", catalogFile,
                "--producer", producerFile,
                "--output", projectedFile,
                "--root", BackendTestPaths.RepositoryRoot,
                "--commit", commit,
                "--worktree-fingerprint", fingerprint,
                "--run-id", "run-1",
                "--namespace", "namespace-1");
            Assert.Equal(0, accepted.ExitCode);
            using (JsonDocument evidence = JsonDocument.Parse(await File.ReadAllTextAsync(projectedFile)))
            {
                JsonElement root = evidence.RootElement;
                Assert.Equal("fsusblog.evidence-projection-receipt.v1", root.GetProperty("schema").GetString());
                Assert.Equal("success", root.GetProperty("status").GetString());
                Assert.Equal(10, root.GetProperty("testIds").GetArrayLength());
                Assert.Equal(0, root.GetProperty("executionBoundary").GetProperty("dotnetTestLaunchCount").GetInt32());
            }

            File.Delete(projectedFile);
            ProcessResult rejected = await RunNodeAsync(
                "tools/test/project-evidence.mjs",
                "--catalog", catalogFile,
                "--producer", producerFile,
                "--output", projectedFile,
                "--root", BackendTestPaths.RepositoryRoot,
                "--commit", commit,
                "--worktree-fingerprint", fingerprint,
                "--run-id", "run-2",
                "--namespace", "namespace-1");
            Assert.NotEqual(0, rejected.ExitCode);
            Assert.Contains("another run", rejected.StandardError, StringComparison.Ordinal);
            Assert.False(File.Exists(projectedFile));
        }
        finally
        {
            Directory.Delete(tempRoot, recursive: true);
        }
    }

    private static async Task<ProcessResult> RunNodeAsync(string script, params string[] arguments)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = "node",
            WorkingDirectory = BackendTestPaths.RepositoryRoot,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        };
        startInfo.ArgumentList.Add(BackendTestPaths.FromRoot(script.Split('/')));
        foreach (string argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }

        using Process process = Process.Start(startInfo)!;
        Task<string> stdout = process.StandardOutput.ReadToEndAsync();
        Task<string> stderr = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        return new ProcessResult(process.ExitCode, await stdout, await stderr);
    }

    private sealed record ProcessResult(int ExitCode, string StandardOutput, string StandardError);
}
