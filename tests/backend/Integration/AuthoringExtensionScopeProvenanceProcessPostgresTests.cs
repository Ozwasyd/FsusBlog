using System.Diagnostics;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
public sealed class AuthoringExtensionScopeProvenanceProcessPostgresTests
{
    private const string WorkerRequestVariable = "FSUS_PROVENANCE_CRASH_WORKER_REQUEST";
    private sealed record WorkerRequest(string ConnectionString, AuthoringExtensionScopeRegistration Registration, string ReadyPath);

    [Fact]
    public async Task ProcessDeathAfterOriginalCommit_ResumesOnlyTheSameDurablePendingRecord()
    {
        string? workerRequestPath = Environment.GetEnvironmentVariable(WorkerRequestVariable);
        if (workerRequestPath is not null)
        {
            WorkerRequest request = JsonSerializer.Deserialize<WorkerRequest>(await File.ReadAllTextAsync(workerRequestPath))!;
            await using var worker = new AuthoringExtensionScopeProvenancePostgresTests.Harness(request.ConnectionString);
            await worker.InitializeOriginalAsync(request.Registration, true);
            await File.WriteAllTextAsync(request.ReadyPath, "original-insert-and-witness-committed");
            await Task.Delay(Timeout.InfiniteTimeSpan);
            return;
        }

        // The child has no collection fixture and starts no container. This parent owns the
        // isolated database and cleans it even after killing the child test-host process tree.
        var postgres = new PostgresSchemaMigrationFixture();
        string directory = Path.Combine(Path.GetTempPath(), $"fsus-provenance-crash-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        Process? process = null;
        try
        {
            await postgres.InitializeAsync();
            await using AuthoringExtensionScopeProvenancePostgresTests.Harness host =
                await AuthoringExtensionScopeProvenancePostgresTests.CreateHarnessAsync(postgres);
            AuthoringExtensionScopeRegistration registration = await host.BeginAsync();
            await host.RefuseAsync(registration.Scope);
            string ready = Path.Combine(directory, "committed");
            string requestPath = Path.Combine(directory, "request.json");
            await File.WriteAllTextAsync(requestPath, JsonSerializer.Serialize(new WorkerRequest(host.ConnectionString, registration, ready)));
            string project = Path.GetFullPath("../../../../../tests/backend/FsusBlog.Server.Tests.csproj", AppContext.BaseDirectory);
            var start = new ProcessStartInfo(Environment.GetEnvironmentVariable("DOTNET_HOST_PATH") ?? "dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            };
            foreach (string argument in new[] { "test", project, "--no-build", "--no-restore", "--filter",
                $"FullyQualifiedName={GetType().FullName}.{nameof(ProcessDeathAfterOriginalCommit_ResumesOnlyTheSameDurablePendingRecord)}", "-v:q" })
            {
                start.ArgumentList.Add(argument);
            }
            start.Environment[WorkerRequestVariable] = requestPath;
            process = Process.Start(start)!;
            Task<string> output = process.StandardOutput.ReadToEndAsync();
            Task<string> errors = process.StandardError.ReadToEndAsync();
            long started = Stopwatch.GetTimestamp();
            while (!File.Exists(ready) && !process.HasExited && Stopwatch.GetElapsedTime(started) < TimeSpan.FromSeconds(30))
            {
                await Task.Delay(20);
            }
            Assert.True(File.Exists(ready), "Child failed to reach the committed original creation witness boundary.");
            process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync();
            await Task.WhenAll(output, errors);
            await host.RefuseAsync(registration.Scope);
            await host.CompleteAsync(registration);
            await using IAuthoringExtensionApprovalScope held = await host.AcquireAsync(registration.Scope);
            await held.VerifyCurrentAsync(default);
        }
        finally
        {
            if (process is not null)
            {
                if (!process.HasExited)
                {
                    process.Kill(entireProcessTree: true);
                    await process.WaitForExitAsync();
                }
                process.Dispose();
            }
            Directory.Delete(directory, recursive: true);
            await postgres.DisposeAsync();
        }
    }
}
