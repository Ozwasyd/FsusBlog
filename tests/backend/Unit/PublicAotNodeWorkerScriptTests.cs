using System.Reflection;

using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Logging.Abstractions;

using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Tests.Unit;
using FsusBlog.Shared.Contracts.Outputs;
namespace FsusBlog.Server.Tests;

public sealed class PublicAotNodeWorkerScriptTests
{
    [Theory]
    [InlineData(int.MinValue, 1)]
    [InlineData(int.MinValue, 3)]
    [InlineData(-1, 4)]
    [InlineData(0, 4)]
    [InlineData(int.MaxValue, 7)]
    public void NodeWorkerPoolIndex_HandlesOverflowAndNeverReturnsNegative(int counter, int workerCount)
    {
        int index = PublicAotNodeSsrRenderer.CalculateWorkerIndexForTests(counter, workerCount);

        Assert.InRange(index, 0, workerCount - 1);
    }

    [Fact]
    public async Task ServerPublicSsrScript_ExecutesLineProtocolWorkerCommands()
    {
        using var temp = new TempDirectory();
        string workerScript = Path.Combine(temp.Path, "runtime-worker.mjs");
        string okPayload = PublicAotBinaryPayload.EncodeObject(
            new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["ok"] = true
            });
        string failurePayload = PublicAotBinaryPayload.EncodeObject(
            new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["ok"] = false,
                ["error"] = "runtime-artifact-protocol-rejected"
            });
        await File.WriteAllTextAsync(workerScript, $$"""
            import { createInterface } from 'node:readline'

            const okPayload = '{{okPayload}}'
            const failurePayload = '{{failurePayload}}'
            const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
            input.once('line', (line) => {
              const parts = line.split('\t')
              const requestId = parts[0] ?? ''
              const command = parts[1] ?? ''
              const encodedRequest = parts[2] ?? ''
              const valid = requestId.length > 0 &&
                command === 'validateBundle' &&
                /^[A-Za-z0-9_-]+$/.test(encodedRequest)
              process.stdout.write(`${requestId}\t${valid ? okPayload : failurePayload}\n`)
              input.close()
            })
            """);
        IConfiguration configuration = CreateConfiguration(new Dictionary<string, string?>
        {
            ["PublicAot:SsrClientRoot"] = temp.Path,
            ["PublicAot:SsrWorkerScript"] = "./runtime-worker.mjs",
            ["PublicAot:SsrWorkerMode"] = "PerRequest",
            ["PublicAot:SsrRequestTimeoutSeconds"] = "5"
        });
        var runtimeState = new PublicAotSsrRuntimeState(configuration);
        await using var renderer = new PublicAotNodeSsrRenderer(
            new TestWebHostEnvironment(temp.Path, "Development"),
            configuration,
            runtimeState,
            NullLogger<PublicAotNodeSsrRenderer>.Instance);
        var bundle = new PublicAotShellBundleContract
        {
            Entries =
            [
                new PublicAotShellEntryContract
                {
                    PageId = PublicPageId.Home,
                    RouteKey = "home",
                    Html = "<main data-runtime-artifact=\"home\"></main>"
                }
            ]
        };

        var result = await renderer.ValidateBundleAsync(bundle);

        Assert.True(result.IsSuccess, result.Error.Message);
        Assert.NotNull(runtimeState.CreateSnapshot(0, 1).LastWorkerStartUtc);
    }

    [Fact]
    public async Task BoundedOutputReader_RejectsOversizedSsrResponse()
    {
        InvalidOperationException ex = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            PublicAotNodeSsrRenderer.ReadProcessOutputBoundedForTests(new string('x', 128), maxBytes: 32));

        Assert.Contains("public_aot_worker_stdout_too_large", ex.Message);
    }

    [Fact]
    public void PooledWorkerPipeLoops_StartDirectlyAndPropagateCancellation()
    {
        Type workerClient = typeof(PublicAotNodeSsrRenderer).GetNestedType("NodeWorkerClient", BindingFlags.NonPublic)!;
        IReadOnlyList<string> readerCallers = RuntimeMetadataInspection.FindMethodsCallingMember(
            workerClient,
            static member => member.DeclaringType?.IsAssignableFrom(typeof(StreamReader)) == true
                && member.Name == nameof(StreamReader.ReadLineAsync));
        Assert.Contains(readerCallers, static caller => caller.Contains("<ReadStdoutLoopAsync>", StringComparison.Ordinal));
        Assert.Contains(readerCallers, static caller => caller.Contains("<ReadStderrLoopAsync>", StringComparison.Ordinal));

        IReadOnlyList<string> restartCallers = RuntimeMetadataInspection.FindMethodsCallingMember(
            workerClient,
            static member => member.DeclaringType?.Name == "NodeWorkerClient"
                && member.Name is "ReadStdoutLoopAsync" or "ReadStderrLoopAsync");
        Assert.Contains(restartCallers, static caller => caller.Contains("<RestartAsync>", StringComparison.Ordinal));
        Assert.DoesNotContain(RuntimeMetadataInspection.FindMethodsCallingMember(
            workerClient,
            static member => member.DeclaringType == typeof(Task) && member.Name == nameof(Task.Run)),
            static caller => caller.Contains("<RestartAsync>", StringComparison.Ordinal));

        IReadOnlyList<string> cancellationFilterCallers = RuntimeMetadataInspection.FindMethodsCallingMember(
            workerClient,
            static member => member == typeof(OperationCanceledException));
        Assert.Contains(cancellationFilterCallers,
            static caller => caller.Contains("<ReadStdoutLoopAsync>", StringComparison.Ordinal));
        Assert.Contains(cancellationFilterCallers,
            static caller => caller.Contains("<ReadStderrLoopAsync>", StringComparison.Ordinal));
        Assert.Contains(RuntimeMetadataInspection.FindMethodsCallingMember(
            workerClient,
            static member => member.DeclaringType == typeof(CancellationTokenSource) && member.Name == nameof(CancellationTokenSource.Cancel)),
            static caller => caller.Contains("<StopCurrentWorkerAsync>", StringComparison.Ordinal));
    }

    [Fact]
    public void ProductionWorkerResource_RequiresPrebuiltBundle()
    {
        using var temp = new TempDirectory();
        string webRoot = Path.Combine(temp.Path, "wwwroot");
        string serverRoot = Path.Combine(webRoot, "server");
        Directory.CreateDirectory(serverRoot);
        File.WriteAllText(Path.Combine(serverRoot, "server-public-ssr.bundle.mjs"), "export {}\n");

        var env = new TestWebHostEnvironment(temp.Path, "Production") { WebRootPath = webRoot };
        IConfiguration configuration = CreateConfiguration([]);

        PublicAotSsrWorkerResourceStatus missing = PublicAotNodeSsrRenderer.CheckWorkerResourceForTests(env, configuration);

        Assert.Equal("failed", missing.Status);
        Assert.Contains("public_aot_ssr_bundle_missing", missing.Error);

        File.WriteAllText(Path.Combine(serverRoot, "public-ssr.mjs"), "export {}\n");
        PublicAotSsrWorkerResourceStatus ready = PublicAotNodeSsrRenderer.CheckWorkerResourceForTests(env, configuration);

        Assert.Equal("ok", ready.Status);
        Assert.True(ready.IsProduction);
        Assert.True(ready.UsesPrebuiltBundle);
        Assert.Equal("./server/server-public-ssr.bundle.mjs", ready.WorkerScript);
        Assert.EndsWith(Path.Combine("wwwroot", "server", "public-ssr.mjs"), ready.BundlePath);
    }

    [Fact]
    public void ProductionWorkerResource_RejectsConfiguredViteWorker()
    {
        using var temp = new TempDirectory();
        string clientRoot = Path.Combine(temp.Path, "client");
        string scriptsRoot = Path.Combine(clientRoot, "scripts");
        Directory.CreateDirectory(scriptsRoot);
        File.WriteAllText(Path.Combine(scriptsRoot, "server-public-ssr.vite.mjs"), "export {}\n");

        var env = new TestWebHostEnvironment(temp.Path, "Production");
        IConfiguration configuration = CreateConfiguration(new Dictionary<string, string?>
        {
            ["PublicAot:SsrClientRoot"] = clientRoot,
            ["PublicAot:SsrWorkerScript"] = "./scripts/server-public-ssr.vite.mjs"
        });

        PublicAotSsrWorkerResourceStatus status = PublicAotNodeSsrRenderer.CheckWorkerResourceForTests(env, configuration);

        Assert.Equal("failed", status.Status);
        Assert.Contains("public_aot_production_worker_must_use_prebuilt_bundle", status.Error);
    }

    private static IConfiguration CreateConfiguration(Dictionary<string, string?> values)
        => new ConfigurationBuilder()
            .AddInMemoryCollection(values)
            .Build();

    private sealed class TempDirectory : IDisposable
    {
        public string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"fsus-aot-worker-{Guid.NewGuid():N}");

        public TempDirectory()
        {
            Directory.CreateDirectory(Path);
        }

        public void Dispose()
        {
            try
            {
                Directory.Delete(Path, recursive: true);
            }
            catch
            {
            }
        }
    }

    private sealed class TestWebHostEnvironment(string root, string environmentName) : IWebHostEnvironment
    {
        public string ApplicationName { get; set; } = "FsusBlog.Tests";
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string WebRootPath { get; set; } = Path.Combine(root, "wwwroot");
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
        public string ContentRootPath { get; set; } = root;
        public string EnvironmentName { get; set; } = environmentName;
    }
}
