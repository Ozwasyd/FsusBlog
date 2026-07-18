using System.Diagnostics;
using System.Reflection;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Tests.TestInfrastructure;

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
    public void Apply_ReportsActualStartupEnvironmentAndProfileIdentity()
    {
        string[] names =
        [
            "DOTNET_ReadyToRun",
            "DOTNET_TC_QuickJitForLoops",
            "DOTNET_TieredPGO",
            "FSUSBLOG_RUNTIME_PROFILE_ID",
            "FSUSBLOG_RUNTIME_PROFILE_MANIFEST_DIGEST",
            "FSUSBLOG_RUNTIME_PROFILE_DIGEST",
            "FSUSBLOG_RUNTIME_GC_HEAP_COUNT_MODE",
            "FSUSBLOG_RUNTIME_GC_HEAP_HARD_LIMIT_MODE",
            "FSUSBLOG_RUNTIME_GC_HEAP_HARD_LIMIT_PERCENT",
            "FSUSBLOG_RUNTIME_THREAD_POOL_MODE",
            "FSUSBLOG_RUNTIME_THREAD_POOL_MIN_THREADS_PER_CPU",
            "FSUSBLOG_RUNTIME_TOPOLOGY_MODE",
            "DOTNET_GCHeapCount",
            "DOTNET_GCHeapHardLimit"
        ];
        Dictionary<string, string?> original = names.ToDictionary(
            static name => name,
            static name => Environment.GetEnvironmentVariable(name),
            StringComparer.Ordinal);
        try
        {
            Environment.SetEnvironmentVariable("DOTNET_ReadyToRun", "0");
            Environment.SetEnvironmentVariable("DOTNET_TC_QuickJitForLoops", "0");
            Environment.SetEnvironmentVariable("DOTNET_TieredPGO", "1");
            Environment.SetEnvironmentVariable("FSUSBLOG_RUNTIME_PROFILE_ID", "throughput-musl");
            Environment.SetEnvironmentVariable("FSUSBLOG_RUNTIME_PROFILE_MANIFEST_DIGEST", "sha256:" + new string('a', 64));
            Environment.SetEnvironmentVariable("FSUSBLOG_RUNTIME_PROFILE_DIGEST", "sha256:" + new string('b', 64));
            Environment.SetEnvironmentVariable("FSUSBLOG_RUNTIME_GC_HEAP_COUNT_MODE", "cpuset");
            Environment.SetEnvironmentVariable("FSUSBLOG_RUNTIME_GC_HEAP_HARD_LIMIT_MODE", "explicit-container-percent");
            Environment.SetEnvironmentVariable("FSUSBLOG_RUNTIME_GC_HEAP_HARD_LIMIT_PERCENT", "75");
            Environment.SetEnvironmentVariable("FSUSBLOG_RUNTIME_THREAD_POOL_MODE", "evidence-derived");
            Environment.SetEnvironmentVariable("FSUSBLOG_RUNTIME_THREAD_POOL_MIN_THREADS_PER_CPU", "0");
            Environment.SetEnvironmentVariable("FSUSBLOG_RUNTIME_TOPOLOGY_MODE", "physical-core-only");
            Environment.SetEnvironmentVariable("DOTNET_GCHeapCount", "4");
            Environment.SetEnvironmentVariable("DOTNET_GCHeapHardLimit", "c0000000");
            IConfiguration configuration = new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["RuntimeTuning:ReadyToRun"] = "1",
                    ["RuntimeTuning:QuickJitForLoops"] = "1",
                    ["RuntimeTuning:TieredPGO"] = "0"
                })
                .Build();

            FsusHostRuntimeTuningReport report = FsusHostRuntimeTuning.Apply(configuration);

            Assert.Equal("0", report.ReadyToRun);
            Assert.Equal("0", report.QuickJitForLoops);
            Assert.Equal("1", report.TieredPgo);
            Assert.Equal("throughput-musl", report.RuntimeProfileId);
            Assert.Matches("^sha256:[0-9a-f]{64}$", report.RuntimeProfileManifestDigest);
            Assert.Matches("^sha256:[0-9a-f]{64}$", report.RuntimeProfileDigest);
            Assert.NotEmpty(report.RuntimeIdentifier);
            Assert.NotEmpty(report.FrameworkDescription);
            Assert.True(report.ProcessorCount > 0);
            Assert.True(report.TotalAvailableMemoryBytes > 0);
            Assert.Equal("cpuset", report.GcHeapCountMode);
            Assert.Equal("explicit-container-percent", report.GcHeapHardLimitMode);
            Assert.Equal("75", report.GcHeapHardLimitPercent);
            Assert.Equal("4", report.GcHeapCountConfigured);
            Assert.Equal("c0000000", report.GcHeapHardLimitConfigured);
            Assert.Equal("evidence-derived", report.ThreadPoolMode);
            Assert.Equal("0", report.ThreadPoolMinThreadsPerCpuDeclared);
            Assert.Equal("physical-core-only", report.TopologyMode);
        }
        finally
        {
            foreach ((string name, string? value) in original)
            {
                Environment.SetEnvironmentVariable(name, value);
            }
        }
    }

    [Fact]
    public void RuntimeTuningLog_RuntimeMetadataSeparatesObservedConfigFromInProcessApplied()
    {
        string runtimeShape = RuntimeMetadataInspection.DescribeType(typeof(FsusHostRuntimeTuningLogService));

        Assert.Contains("ReadyToRunObserved={ReadyToRun}", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("ReadyToRunInProcessApplied={ReadyToRunApplied}", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("QuickJitForLoopsObserved={QuickJitForLoops}", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("QuickJitForLoopsInProcessApplied={QuickJitForLoopsApplied}", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("TieredPGOObserved={TieredPgo}", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("TieredPGOInProcessApplied={TieredPgoApplied}", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("Profile={RuntimeProfileId}", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("ProfileManifestDigest={RuntimeProfileManifestDigest}", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("ServerGC={ServerGc}", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("ProcessorCount={ProcessorCount}", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("TotalAvailableMemoryBytes={TotalAvailableMemoryBytes}", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("GCHeapCountMode={GcHeapCountMode}", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("GCHeapHardLimitMode={GcHeapHardLimitMode}", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("ThreadPoolMode={ThreadPoolMode}", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("TopologyMode={TopologyMode}", runtimeShape, StringComparison.Ordinal);
        Assert.DoesNotContain("StartupEnvMutated", runtimeShape, StringComparison.Ordinal);
    }

    [Fact]
    public void CompiledServerMetadata_UsesConsistentThroughputReadyToRunProfile()
    {
        IReadOnlyDictionary<string, string?> metadata = typeof(FsusHostRuntimeTuning).Assembly
            .GetCustomAttributes<AssemblyMetadataAttribute>()
            .ToDictionary(static attribute => attribute.Key, static attribute => attribute.Value, StringComparer.Ordinal);

        Assert.Equal("false", metadata["FsusBlog.PublishReadyToRun"], ignoreCase: true);
        Assert.Equal("false", metadata["FsusBlog.ReadyToRunUseCrossgen2"], ignoreCase: true);
    }

    [Fact]
    public async Task ImageRuntimeContract_RequiresPinnedVcpkgNodeAndNoNpm()
    {
        string root = Directory.CreateTempSubdirectory("fsus-image-contract-").FullName;
        try
        {
            string dockerLog = Path.Combine(root, "docker.log");
            string docker = Path.Combine(root, "docker");
            await File.WriteAllTextAsync(docker, FakeDockerScript);
            if (!OperatingSystem.IsWindows())
            {
                File.SetUnixFileMode(
                    docker,
                    UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            }

            ProcessResult accepted = await RunImageContractAsync(root, dockerLog, mode: "valid");
            Assert.Equal(0, accepted.ExitCode);
            using JsonDocument document = JsonDocument.Parse(accepted.StandardOutput);
            JsonElement contract = document.RootElement;
            Assert.Equal("ok", contract.GetProperty("status").GetString());
            Assert.Matches("^[0-9a-f]{40}$", contract.GetProperty("build").GetProperty("vcpkgCommit").GetString());
            Assert.Equal("required", contract.GetProperty("runtime").GetProperty("node").GetString());
            Assert.Equal("forbidden", contract.GetProperty("runtime").GetProperty("npm").GetString());
            Assert.Equal("throughput-musl", contract.GetProperty("runtime").GetProperty("profileId").GetString());
            Assert.Matches("^sha256:[0-9a-f]{64}$", contract.GetProperty("runtime").GetProperty("profileDigest").GetString());
            Assert.Equal("false", contract.GetProperty("runtime").GetProperty("publishReadyToRun").GetString());
            Assert.Equal("container-default", contract.GetProperty("runtime").GetProperty("gcHeapCountMode").GetString());
            Assert.Equal("container-limit", contract.GetProperty("runtime").GetProperty("gcHeapHardLimitMode").GetString());
            Assert.Equal(0, contract.GetProperty("runtime").GetProperty("gcHeapHardLimitPercent").GetInt32());
            Assert.Equal(0, contract.GetProperty("runtime").GetProperty("threadPoolMinThreadsPerCpu").GetInt32());
            string calls = await File.ReadAllTextAsync(dockerLog);
            Assert.Contains("pull ghcr.io/fsusblog/app@sha256:", calls, StringComparison.Ordinal);
            Assert.Contains("image inspect", calls, StringComparison.Ordinal);
            Assert.Contains("run --rm --entrypoint /bin/sh", calls, StringComparison.Ordinal);

            ProcessResult nodeMissing = await RunImageContractAsync(root, dockerLog, mode: "node-missing");
            Assert.NotEqual(0, nodeMissing.ExitCode);
            Assert.Contains("must provide node", nodeMissing.StandardError, StringComparison.Ordinal);

            ProcessResult npmPresent = await RunImageContractAsync(root, dockerLog, mode: "npm-present");
            Assert.NotEqual(0, npmPresent.ExitCode);
            Assert.Contains("must not provide npm", npmPresent.StandardError, StringComparison.Ordinal);

            ProcessResult unpinned = await RunImageContractAsync(root, dockerLog, mode: "vcpkg-unpinned");
            Assert.NotEqual(0, unpinned.ExitCode);
            Assert.Contains("vcpkg commit label", unpinned.StandardError, StringComparison.Ordinal);

            ProcessResult invalidGcMode = await RunImageContractAsync(root, dockerLog, mode: "gc-mode-invalid");
            Assert.NotEqual(0, invalidGcMode.ExitCode);
            Assert.Contains("GC heap count mode label", invalidGcMode.StandardError, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static async Task<ProcessResult> RunImageContractAsync(
        string fakeDockerDirectory,
        string dockerLog,
        string mode)
    {
        string imageRef = "ghcr.io/fsusblog/app@sha256:" + new string('a', 64);
        var startInfo = new ProcessStartInfo
        {
            FileName = "/bin/bash",
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        };
        startInfo.ArgumentList.Add(BackendTestPaths.FromRoot("tools", "deployment", "image-runtime-contract.sh"));
        startInfo.ArgumentList.Add(imageRef);
        startInfo.Environment["PATH"] = $"{fakeDockerDirectory}:/usr/bin:/bin";
        startInfo.Environment["FSUSBLOG_FAKE_DOCKER_LOG"] = dockerLog;
        startInfo.Environment["FSUSBLOG_FAKE_DOCKER_MODE"] = mode;

        using Process process = Process.Start(startInfo)!;
        Task<string> stdout = process.StandardOutput.ReadToEndAsync();
        Task<string> stderr = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        return new ProcessResult(process.ExitCode, await stdout, await stderr);
    }

    private const string FakeDockerScript = """
        #!/usr/bin/env bash
        set -euo pipefail
        printf '%s\n' "$*" >> "$FSUSBLOG_FAKE_DOCKER_LOG"
        mode="${FSUSBLOG_FAKE_DOCKER_MODE:-valid}"
        if [[ "$1" == "pull" ]]; then
          exit 0
        fi
        if [[ "$1" == "image" && "$2" == "inspect" ]]; then
          case "$*" in
            *io.fsusblog.build.vcpkg-commit*)
              [[ "$mode" == "vcpkg-unpinned" ]] && printf '%s\n' missing || printf '%s\n' eae1680538b86f962455c27abca2aad0dc304a4d
              ;;
            *io.fsusblog.runtime.node*) printf '%s\n' required ;;
            *io.fsusblog.runtime.npm*) printf '%s\n' forbidden ;;
            *io.fsusblog.runtime.publish-ready-to-run*) printf '%s\n' false ;;
            *io.fsusblog.runtime.profile-id*) printf '%s\n' throughput-musl ;;
            *io.fsusblog.runtime.profile-manifest-digest*) printf 'sha256:%064d\n' 0 ;;
            *io.fsusblog.runtime.profile-digest*) printf 'sha256:%064d\n' 1 ;;
            *io.fsusblog.runtime.base-family*) printf '%s\n' musl ;;
            *io.fsusblog.runtime.target-runtime*) printf '%s\n' linux-musl-x64 ;;
            *io.fsusblog.runtime.publish-single-file*) printf '%s\n' true ;;
            *io.fsusblog.runtime.tiered-pgo*) printf '%s\n' true ;;
            *io.fsusblog.runtime.quick-jit-for-loops*) printf '%s\n' true ;;
            *io.fsusblog.runtime.server-gc*) printf '%s\n' true ;;
            *io.fsusblog.runtime.native-aot*) printf '%s\n' false ;;
            *io.fsusblog.runtime.gc-heap-count-mode*) [[ "$mode" == "gc-mode-invalid" ]] && printf '%s\n' host-total || printf '%s\n' container-default ;;
            *io.fsusblog.runtime.gc-heap-hard-limit-mode*) printf '%s\n' container-limit ;;
            *io.fsusblog.runtime.gc-heap-hard-limit-percent*) printf '%s\n' 0 ;;
            *io.fsusblog.runtime.thread-pool-mode*) printf '%s\n' runtime-default ;;
            *io.fsusblog.runtime.thread-pool-min-threads-per-cpu*) printf '%s\n' 0 ;;
            *io.fsusblog.runtime.topology-mode*) printf '%s\n' smt-visible ;;
            *) exit 2 ;;
          esac
          exit 0
        fi
        if [[ "$1" == "run" ]]; then
          command_text="${*: -1}"
          if [[ "$command_text" == *"command -v node"* ]]; then
            [[ "$mode" != "node-missing" ]]
            exit
          fi
          if [[ "$command_text" == *"command -v npm"* ]]; then
            [[ "$mode" != "npm-present" ]]
            exit
          fi
        fi
        exit 2
        """;

    private sealed record ProcessResult(int ExitCode, string StandardOutput, string StandardError);
}
