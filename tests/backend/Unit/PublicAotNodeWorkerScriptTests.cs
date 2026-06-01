using FsusBlog.Server.Infrastructure.PublicAot;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;

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
    public void ServerPublicSsrScript_ExposesLineProtocolWorkerCommands()
    {
        string repoRoot = FindRepoRoot();
        string rendererPath = Path.Combine(repoRoot, "src", "backend", "Infrastructure", "PublicAot", "PublicAotNodeSsrRenderer.cs");
        string source = File.ReadAllText(rendererPath);
        string coreScript = File.ReadAllText(Path.Combine(repoRoot, "src", "frontend", "scripts", "server-public-ssr.worker-core.mjs"));
        string viteScript = File.ReadAllText(Path.Combine(repoRoot, "src", "frontend", "scripts", "server-public-ssr.vite.mjs"));
        string bundleScript = File.ReadAllText(Path.Combine(repoRoot, "src", "frontend", "scripts", "server-public-ssr.bundle.mjs"));

        Assert.Contains("--worker", source);
        Assert.Contains("server-public-ssr.vite.mjs", source);
        Assert.Contains("server-public-ssr.bundle.mjs", source);
        Assert.Contains("public_aot_production_worker_must_use_prebuilt_bundle", source);
        Assert.Contains("requestId", source);
        Assert.Contains("buildEntry", coreScript);
        Assert.Contains("validateBundle", coreScript);
        Assert.Contains("shutdown", coreScript);
        Assert.Contains("createServer", viteScript);
        Assert.Contains("ssrLoadModule", viteScript);
        Assert.DoesNotContain("createServer", bundleScript);
        Assert.DoesNotContain("ssrLoadModule", bundleScript);
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

    private static string FindRepoRoot()
    {
        string current = AppContext.BaseDirectory;
        while (!string.IsNullOrWhiteSpace(current))
        {
            if (File.Exists(Path.Combine(current, "FsusBlog.slnx")) ||
                File.Exists(Path.Combine(current, "src", "backend", "Infrastructure", "PublicAot", "PublicAotNodeSsrRenderer.cs")))
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
