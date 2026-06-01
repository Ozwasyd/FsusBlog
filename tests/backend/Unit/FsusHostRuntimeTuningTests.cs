using FsusBlog.Server.Infrastructure.Bootstrap;
using Microsoft.Extensions.Configuration;

namespace FsusBlog.Server.Tests.Unit;

public sealed class FsusHostRuntimeTuningTests
{
    [Fact]
    public void Apply_WithNoRuntimeTuningConfiguration_DoesNotForceAggressiveDefaults()
    {
        IConfiguration configuration = new ConfigurationBuilder().Build();

        FsusHostRuntimeTuningReport report = FsusHostRuntimeTuning.Apply(configuration);

        Assert.Null(report.ReadyToRun);
        Assert.Null(report.QuickJitForLoops);
        Assert.Null(report.TieredPgo);
        Assert.False(report.ReadyToRunApplied);
        Assert.False(report.QuickJitForLoopsApplied);
        Assert.False(report.TieredPgoApplied);
        Assert.False(report.ThreadPoolApplied);
        Assert.Equal(report.BeforeWorkerThreads, report.AfterWorkerThreads);
        Assert.Equal(report.BeforeCompletionPortThreads, report.AfterCompletionPortThreads);
    }

    [Fact]
    public void Apply_WithDotnetRuntimeSettings_DoesNotMutateStartupEnvironmentVariables()
    {
        string? originalReadyToRun = Environment.GetEnvironmentVariable("DOTNET_ReadyToRun");
        string? originalQuickJit = Environment.GetEnvironmentVariable("DOTNET_TC_QuickJitForLoops");
        string? originalTieredPgo = Environment.GetEnvironmentVariable("DOTNET_TieredPGO");
        try
        {
            Environment.SetEnvironmentVariable("DOTNET_ReadyToRun", null);
            Environment.SetEnvironmentVariable("DOTNET_TC_QuickJitForLoops", null);
            Environment.SetEnvironmentVariable("DOTNET_TieredPGO", null);
            IConfiguration configuration = new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["RuntimeTuning:ReadyToRun"] = "1",
                    ["RuntimeTuning:QuickJitForLoops"] = "1",
                    ["RuntimeTuning:TieredPGO"] = "1"
                })
                .Build();

            FsusHostRuntimeTuningReport report = FsusHostRuntimeTuning.Apply(configuration);

            Assert.Equal("1", report.ReadyToRun);
            Assert.Equal("1", report.QuickJitForLoops);
            Assert.Equal("1", report.TieredPgo);
            Assert.False(report.ReadyToRunApplied);
            Assert.False(report.QuickJitForLoopsApplied);
            Assert.False(report.TieredPgoApplied);
            Assert.Null(Environment.GetEnvironmentVariable("DOTNET_ReadyToRun"));
            Assert.Null(Environment.GetEnvironmentVariable("DOTNET_TC_QuickJitForLoops"));
            Assert.Null(Environment.GetEnvironmentVariable("DOTNET_TieredPGO"));
        }
        finally
        {
            Environment.SetEnvironmentVariable("DOTNET_ReadyToRun", originalReadyToRun);
            Environment.SetEnvironmentVariable("DOTNET_TC_QuickJitForLoops", originalQuickJit);
            Environment.SetEnvironmentVariable("DOTNET_TieredPGO", originalTieredPgo);
        }
    }

    [Fact]
    public void DockerAndProjectFiles_UseConsistentThroughputReadyToRunProfile()
    {
        string root = FindRepoRoot();
        string project = File.ReadAllText(Path.Combine(root, "src/backend/FsusBlog.Server.csproj"));
        string dockerfile = File.ReadAllText(Path.Combine(root, "ops/docker/FsusBlog.Server.Dockerfile"));

        Assert.Contains("<PublishReadyToRun>false</PublishReadyToRun>", project, StringComparison.Ordinal);
        Assert.Contains("/p:PublishReadyToRun=false", dockerfile, StringComparison.Ordinal);
        Assert.DoesNotContain("<PublishReadyToRun>true</PublishReadyToRun>", project, StringComparison.Ordinal);
    }

    [Fact]
    public void Dockerfile_PinsVcpkgAndKeepsNpmOutOfRuntimeBase()
    {
        string dockerfile = File.ReadAllText(Path.Combine(FindRepoRoot(), "ops/docker/FsusBlog.Server.Dockerfile"));

        Assert.Contains("ARG VCPKG_COMMIT=", dockerfile, StringComparison.Ordinal);
        Assert.Contains("git checkout \"${VCPKG_COMMIT}\"", dockerfile, StringComparison.Ordinal);
        Assert.Contains("apk add --no-cache icu-data-full icu-libs krb5-libs nodejs", dockerfile, StringComparison.Ordinal);
        Assert.DoesNotContain("icu-data-full icu-libs krb5-libs nodejs npm", dockerfile, StringComparison.Ordinal);
    }

    private static string FindRepoRoot()
    {
        DirectoryInfo? current = new(AppContext.BaseDirectory);
        while (current is not null)
        {
            if (File.Exists(Path.Combine(current.FullName, "FsusBlog.slnx")))
            {
                return current.FullName;
            }

            current = current.Parent;
        }

        throw new DirectoryNotFoundException("repo root not found");
    }
}
