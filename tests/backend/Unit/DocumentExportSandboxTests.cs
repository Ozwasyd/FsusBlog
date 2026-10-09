using System.Diagnostics;
using System.Reflection;
using System.Reflection.Emit;
using System.Text;

using FsusBlog.Server.Services.DocumentExport;
using FsusBlog.Server.Tests.Helpers;

namespace FsusBlog.Server.Tests.Unit;

public sealed class DocumentExportSandboxTests : IDisposable
{
    private readonly DocumentExportTestToolFixture _fixture = new();

    [Fact]
    public async Task UsesExactBrokeredToolMinimalEnvironmentNoNetworkAndPostCleanupReceipt()
    {
        (DocumentExportFrozenInput input, DocumentExportTask task) = DocumentExportTestToolFixture.ValidTask();
        DocumentExportSandboxResult result = await _fixture.CreateSandbox().ExecuteAsync(
            task,
            input,
            _fixture.Tool,
            DocumentExportTestToolFixture.RequestBytes(input));

        Assert.True(result.Receipt.NetworkNamespaceIsolated);
        Assert.Equal(0, result.Receipt.NetworkAttemptsAllowed);
        Assert.Equal(0, result.Receipt.ExternalWrites);
        Assert.Equal(0, result.Receipt.ProcessesRemaining);
        Assert.True(result.Receipt.ProcessTreeTerminated);
        Assert.True(result.Receipt.RunDirectoryRemoved);
        Assert.Equal("none", result.Receipt.FailureCode);
        Assert.Equal(1, result.Receipt.AttemptNumber);
        Assert.True(result.Receipt.RootProcessId > 0);
        Assert.True(result.Receipt.RootProcessStartIdentity > 0);
        Assert.Contains(
            result.Receipt.RootProcessStartIdentitySource,
            new[] { "proc-stat-starttime-ticks", "systemd-exec-main-start-monotonic-usec" });
        Assert.Equal(0, result.Receipt.TerminationSignal);
        Assert.True(result.Receipt.AuthorityEstablishedBeforeStart);
        Assert.StartsWith("fsusblog-document-export-", result.Receipt.UnitName, StringComparison.Ordinal);
        Assert.EndsWith($"/{result.Receipt.UnitName}", result.Receipt.ControlGroup, StringComparison.Ordinal);
        Assert.Equal(DocumentExportSystemdCgroupAuthority.CpuAccountingSource, result.Receipt.CpuAccountingSource);
        Assert.Equal(0, result.Receipt.CpuObservedOverrunMicroseconds);
        Assert.Equal(0, result.Receipt.CpuDetectionLatencyMilliseconds);
        Assert.False(result.Receipt.CgroupKillIssued);
        Assert.False(result.Receipt.FinalCgroupPopulated);
        Assert.True(result.Receipt.UnitRemoved);
        Assert.True(result.Receipt.CgroupRemoved);
        Assert.Empty(Directory.EnumerateDirectories(_fixture.RunsRoot));
        DocumentExportSandboxRuntime.ValidateReceipt(
            result.Receipt,
            result.Plan,
            task,
            input,
            _fixture.Tool,
            _fixture.HostBuildDigest,
            result.OutputBytes);
    }

    [Fact]
    public async Task RejectsUnregisteredShellFloatingPathAndChangedExecutableBytes()
    {
        (DocumentExportFrozenInput input, DocumentExportTask task) = DocumentExportTestToolFixture.ValidTask();
        DocumentExportSandboxRuntime sandbox = _fixture.CreateSandbox();
        DocumentExportToolContract shell = _fixture.Tool with
        {
            ExecutablePath = "/usr/bin/sh",
            ExecutableDigest = DocumentExportTestToolFixture.Digest(File.ReadAllBytes("/usr/bin/sh")),
            Arguments = ["-c", "true"]
        };

        await Assert.ThrowsAsync<InvalidDataException>(() => sandbox.ExecuteAsync(
            task,
            input,
            shell,
            Encoding.UTF8.GetBytes("{}")));
        await Assert.ThrowsAsync<InvalidDataException>(() => sandbox.ExecuteAsync(
            task,
            input,
            _fixture.Tool with
            {
                ExecutablePath = "renderer-worker"
            },
            Encoding.UTF8.GetBytes("{}")));

        await File.AppendAllTextAsync(_fixture.Tool.ExecutablePath, "drift", Encoding.UTF8);
        await Assert.ThrowsAsync<InvalidDataException>(() => sandbox.ExecuteAsync(
            task,
            input,
            _fixture.Tool,
            Encoding.UTF8.GetBytes("{}")));
    }

    [Fact]
    public void ConstructorRejectsRegistryAndLimitDriftBeforeCreatingItsRunRoot()
    {
        string duplicateRoot = Path.Combine(_fixture.Root, "duplicate-runs");
        Assert.Throws<InvalidDataException>(() => new DocumentExportSandboxRuntime(
            duplicateRoot,
            [_fixture.Tool, _fixture.Tool],
            _fixture.HostBuildDigest,
            _fixture.CreateAuthority()));
        Assert.False(Directory.Exists(duplicateRoot));

        string unknownLimitRoot = Path.Combine(_fixture.Root, "unknown-limit-runs");
        Assert.Throws<InvalidDataException>(() => new DocumentExportSandboxRuntime(
            unknownLimitRoot,
            [_fixture.Tool],
            _fixture.HostBuildDigest,
            _fixture.CreateAuthority(),
            new Dictionary<string, DocumentExportResourceBudgets>(StringComparer.Ordinal)
            {
                ["document-export.unknown"] = DocumentExportContractCatalog.RequireProvider("self-contained-html").Budgets
            }));
        Assert.False(Directory.Exists(unknownLimitRoot));
    }

    [Fact]
    public async Task CancellationKillsOwnedProcessTreeThenSealsFailureReceipt()
    {
        (DocumentExportFrozenInput input, DocumentExportTask task) = DocumentExportTestToolFixture.ValidTask();
        using var cancellation = new CancellationTokenSource();
        Task<DocumentExportSandboxResult> execution = _fixture.CreateSandbox().ExecuteAsync(
            task,
            input,
            _fixture.Tool,
            DocumentExportTestToolFixture.RequestBytes(input, "sleep"),
            cancellation.Token);
        using var startDeadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        while (!Directory.Exists(_fixture.RunsRoot)
            || !Directory.EnumerateFiles(_fixture.RunsRoot, "started", SearchOption.AllDirectories).Any())
        {
            await Task.Delay(10, startDeadline.Token);
        }
        cancellation.Cancel();

        DocumentExportSandboxCancelledException exception = await Assert.ThrowsAsync<DocumentExportSandboxCancelledException>(
            async () => await execution);

        AssertFailureReceipt(exception.Plan, exception.Receipt, task, input, "cancelled", "cancelled");
    }

    [Fact]
    public async Task PreStartFailureCleansRunDirectoryAndSealsReceiptWithoutClaimingIsolation()
    {
        (DocumentExportFrozenInput input, DocumentExportTask task) = DocumentExportTestToolFixture.ValidTask();
        DocumentExportSandboxRuntime sandbox = _fixture.CreateSandbox();
        Directory.CreateDirectory(_fixture.RunsRoot);
        UnixFileMode? originalMode = null;
        if (!OperatingSystem.IsWindows())
        {
            originalMode = File.GetUnixFileMode(_fixture.RunsRoot);
            File.SetUnixFileMode(_fixture.RunsRoot, UnixFileMode.UserRead | UnixFileMode.UserExecute);
        }
        try
        {
            DocumentExportSandboxExecutionException exception = await Assert.ThrowsAsync<DocumentExportSandboxExecutionException>(
                () => sandbox.ExecuteAsync(
                    task,
                    input,
                    _fixture.Tool,
                    DocumentExportTestToolFixture.RequestBytes(input)));

            Assert.Equal(0, exception.Receipt.RootProcessId);
            Assert.Equal(0, exception.Receipt.RootProcessStartIdentity);
            Assert.False(exception.Receipt.NetworkNamespaceIsolated);
            Assert.Equal(0, exception.Receipt.ProcessesRemaining);
            Assert.True(exception.Receipt.ProcessTreeTerminated);
            Assert.True(exception.Receipt.RunDirectoryRemoved);
            DocumentExportSandboxRuntime.ValidateFailureReceipt(
                exception.Receipt,
                exception.Plan,
                task,
                input,
                _fixture.Tool,
                _fixture.HostBuildDigest,
                "failed",
                "execution-failed");
        }
        finally
        {
            if (!OperatingSystem.IsWindows() && originalMode is { } mode)
                File.SetUnixFileMode(_fixture.RunsRoot, mode);
        }
    }

    [Fact]
    public Task ProcessCountBudgetTerminatesTreeAndSealsFailureReceipt()
        => AssertBudget(
            "many-processes",
            "process-count-budget",
            DocumentExportContractCatalog.RequireProvider("self-contained-html").Budgets with
            {
                MaxProcessCount = 2
            });

    [Fact]
    public Task MemoryBudgetTerminatesTreeAndSealsFailureReceipt()
        => AssertBudget(
            "memory-budget",
            "memory-budget",
            DocumentExportContractCatalog.RequireProvider("self-contained-html").Budgets with
            {
                MaxWorkingSetBytes = 32L * 1024 * 1024
            });

    [Fact]
    public async Task CpuBudgetTerminatesTreeAndSealsFailureReceipt()
    {
        DocumentExportResourceBudgets limits =
            DocumentExportContractCatalog.RequireProvider("self-contained-html").Budgets with
            {
                CpuTime = TimeSpan.FromMilliseconds(25)
            };
        using var testDeadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));

        DocumentExportBudgetExceededException exception = await AssertBudget(
            "metered-work",
            "cpu-time-budget",
            limits,
            testDeadline.Token);

        DocumentExportBudgetExceededException hostFailure =
            Assert.IsType<DocumentExportBudgetExceededException>(exception.InnerException);
        Assert.Contains("exceeded its CPU-time budget", hostFailure.Message, StringComparison.Ordinal);
        Assert.True(exception.Receipt!.CpuMilliseconds > limits.CpuTime.TotalMilliseconds);
        Assert.True(exception.Receipt.CpuUsageMicroseconds > exception.Receipt.CpuBudgetMicroseconds);
        Assert.Equal(
            exception.Receipt.CpuUsageMicroseconds - exception.Receipt.CpuBudgetMicroseconds,
            exception.Receipt.CpuObservedOverrunMicroseconds);
        Assert.InRange(
            exception.Receipt.CpuDetectionLatencyMilliseconds,
            1,
            exception.Receipt.CpuPollIntervalMilliseconds + 100);
        Assert.True(exception.Receipt.CgroupKillIssued);
        Assert.Equal(137, exception.Receipt.ExitCode);
        Assert.Equal(9, exception.Receipt.TerminationSignal);
    }

    [Fact]
    public Task WallBudgetTerminatesTreeAndSealsFailureReceipt()
        => AssertBudget(
            "wall-budget",
            "wall-time-budget",
            DocumentExportContractCatalog.RequireProvider("self-contained-html").Budgets with
            {
                WallTime = TimeSpan.FromMilliseconds(1)
            });

    [Fact]
    public async Task DaemonizedSessionCannotEscapeWallLimitOrCgroupCleanup()
    {
        DocumentExportBudgetExceededException exception = await AssertBudget(
            "daemon-escape",
            "wall-time-budget",
            DocumentExportContractCatalog.RequireProvider("self-contained-html").Budgets with
            {
                WallTime = TimeSpan.FromMilliseconds(100)
            });

        Assert.True(exception.Receipt!.AuthorityEstablishedBeforeStart);
        Assert.True(exception.Receipt.TasksPeak >= 2);
        Assert.Equal("control-group", exception.Receipt.KillMode);
        Assert.Equal(0, exception.Receipt.ProcessesRemaining);
        Assert.False(exception.Receipt.FinalCgroupPopulated);
        Assert.True(exception.Receipt.UnitRemoved);
        Assert.True(exception.Receipt.CgroupRemoved);
    }

    [Fact]
    public Task OutputBudgetRejectsBeforeReadingAndSealsFailureReceipt()
        => AssertBudget("output-budget", "output-budget");

    [Fact]
    public Task StandardOutputBudgetDrainsBoundedlyAndSealsFailureReceipt()
        => AssertBudget("stdout-budget", "stdout-budget");

    [Fact]
    public Task StandardErrorBudgetDrainsBoundedlyAndSealsFailureReceipt()
        => AssertBudget("stderr-budget", "stderr-budget");

    [Fact]
    public Task FileCountBudgetTerminatesAndSealsFailureReceipt()
        => AssertBudget("file-count-budget", "file-count-budget");

    [Fact]
    public Task FileBytesBudgetTerminatesAndSealsFailureReceipt()
        => AssertBudget("file-bytes-budget", "file-bytes-budget");

    [Fact]
    public async Task InputAndMessageBudgetsRejectBeforeRunAdmission()
    {
        (DocumentExportFrozenInput input, DocumentExportTask task) = DocumentExportTestToolFixture.ValidTask();
        DocumentExportResourceBudgets limits =
            DocumentExportContractCatalog.RequireProvider("self-contained-html").Budgets with
            {
                MaxInputBytes = 8,
                MaxMessageBytes = 8
            };
        DocumentExportSandboxRuntime sandbox = _fixture.CreateSandbox(executionLimits: limits);

        await Assert.ThrowsAsync<InvalidDataException>(() => sandbox.ExecuteAsync(
            task,
            input,
            _fixture.Tool,
            new byte[9]));
        Assert.Empty(Directory.EnumerateDirectories(_fixture.RunsRoot));
    }

    private async Task<DocumentExportBudgetExceededException> AssertBudget(
        string mode,
        string failureCode,
        DocumentExportResourceBudgets? executionLimits = null,
        CancellationToken cancellationToken = default)
    {
        (DocumentExportFrozenInput input, DocumentExportTask task) = DocumentExportTestToolFixture.ValidTask();

        DocumentExportBudgetExceededException exception = await Assert.ThrowsAsync<DocumentExportBudgetExceededException>(
            () => _fixture.CreateSandbox(executionLimits: executionLimits).ExecuteAsync(
                task,
                input,
                _fixture.Tool,
                DocumentExportTestToolFixture.RequestBytes(input, mode),
                cancellationToken));

        Assert.NotNull(exception.Plan);
        Assert.NotNull(exception.Receipt);
        Assert.Equal(failureCode, exception.FailureCode);
        AssertFailureReceipt(
            exception.Plan!,
            exception.Receipt!,
            task,
            input,
            "budget-exceeded",
            failureCode);
        Assert.Equal(1, exception.Receipt!.AttemptNumber);
        return exception;
    }

    [Theory]
    [InlineData("two-files")]
    [InlineData("symlink-output")]
    public async Task RejectsArtifactMutationAndPreservesQualifiedFailureReceipt(string mode)
    {
        (DocumentExportFrozenInput input, DocumentExportTask task) = DocumentExportTestToolFixture.ValidTask();

        DocumentExportSandboxExecutionException exception = await Assert.ThrowsAsync<DocumentExportSandboxExecutionException>(
            () => _fixture.CreateSandbox().ExecuteAsync(
                task,
                input,
                _fixture.Tool,
                DocumentExportTestToolFixture.RequestBytes(input, mode)));

        Assert.False(exception.Receipt.CgroupKillIssued);
        AssertFailureReceipt(exception.Plan, exception.Receipt, task, input, "failed", "contract-rejected");
    }

    [Fact]
    public async Task TreatsUserStringsAsInputBytesInsteadOfArguments()
    {
        (DocumentExportFrozenInput input, DocumentExportTask task) = DocumentExportTestToolFixture.ValidTask(
            "```sh\nrm -rf /\n```\n\n$\\write18{ignored}\n\n<script>ignored</script>\n\ngraph TD; A-->B");
        DocumentExportSandboxResult result = await _fixture.CreateSandbox().ExecuteAsync(
            task,
            input,
            _fixture.Tool,
            DocumentExportTestToolFixture.RequestBytes(input, title: "$(touch /tmp/not-a-command); sh -c false"));

        Assert.Equal(DocumentExportDigest.Compute(new[] { "render" }), result.Receipt.CommandDigest);
        Assert.Equal(0, result.Receipt.ExternalWrites);
        Assert.Empty(Directory.EnumerateDirectories(_fixture.RunsRoot));
    }

    [Fact]
    public async Task ConcurrentTasksHaveDistinctRunOwnershipAndNoResidualFiles()
    {
        (DocumentExportFrozenInput input, DocumentExportTask task) = DocumentExportTestToolFixture.ValidTask();
        DocumentExportSandboxRuntime sandbox = _fixture.CreateSandbox();
        byte[] request = DocumentExportTestToolFixture.RequestBytes(input);

        DocumentExportSandboxResult[] results = await Task.WhenAll(
            sandbox.ExecuteAsync(task, input, _fixture.Tool, request),
            sandbox.ExecuteAsync(task, input, _fixture.Tool, request));

        Assert.NotEqual(results[0].Receipt.RunId, results[1].Receipt.RunId);
        Assert.Equal(results[0].Receipt.OutputDigest, results[1].Receipt.OutputDigest);
        Assert.Empty(Directory.EnumerateDirectories(_fixture.RunsRoot));
    }

    [Fact]
    public async Task IndependentVerifierRejectsReceiptAndBuildIdentityTamper()
    {
        (DocumentExportFrozenInput input, DocumentExportTask task) = DocumentExportTestToolFixture.ValidTask();
        DocumentExportSandboxResult result = await _fixture.CreateSandbox().ExecuteAsync(
            task,
            input,
            _fixture.Tool,
            DocumentExportTestToolFixture.RequestBytes(input));

        Assert.Throws<InvalidDataException>(() => DocumentExportSandboxRuntime.ValidateReceipt(
            result.Receipt with
            {
                ProcessesRemaining = 1
            },
            result.Plan,
            task,
            input,
            _fixture.Tool,
            _fixture.HostBuildDigest,
            result.OutputBytes));
        Assert.Throws<InvalidDataException>(() => DocumentExportSandboxRuntime.ValidateReceipt(
            result.Receipt,
            result.Plan,
            task,
            input,
            _fixture.Tool,
            DocumentExportTestToolFixture.Digest("other-build"),
            result.OutputBytes));

        DocumentExportSandboxReceipt authorityTamper = result.Receipt with
        {
            AuthorityEstablishedBeforeStart = false,
            ContentDigest = string.Empty
        };
        authorityTamper = authorityTamper with
        {
            ContentDigest = DocumentExportDigest.Compute(authorityTamper)
        };
        Assert.Throws<InvalidDataException>(() => DocumentExportSandboxRuntime.ValidateReceipt(
            authorityTamper,
            result.Plan,
            task,
            input,
            _fixture.Tool,
            _fixture.HostBuildDigest,
            result.OutputBytes));

        DocumentExportSandboxReceipt cpuAccountingTamper = result.Receipt with
        {
            CpuObservedOverrunMicroseconds = 1,
            ContentDigest = string.Empty
        };
        cpuAccountingTamper = cpuAccountingTamper with
        {
            ContentDigest = DocumentExportDigest.Compute(cpuAccountingTamper)
        };
        Assert.Throws<InvalidDataException>(() => DocumentExportSandboxRuntime.ValidateReceipt(
            cpuAccountingTamper,
            result.Plan,
            task,
            input,
            _fixture.Tool,
            _fixture.HostBuildDigest,
            result.OutputBytes));

        DocumentExportSandboxReceipt environmentTamper = result.Receipt with
        {
            EnvironmentDigest = DocumentExportTestToolFixture.Digest("inherited-environment"),
            ContentDigest = string.Empty
        };
        environmentTamper = environmentTamper with
        {
            ContentDigest = DocumentExportDigest.Compute(environmentTamper)
        };
        Assert.Throws<InvalidDataException>(() => DocumentExportSandboxRuntime.ValidateReceipt(
            environmentTamper,
            result.Plan,
            task,
            input,
            _fixture.Tool,
            _fixture.HostBuildDigest,
            result.OutputBytes));

        DocumentExportSandboxReceipt providerTamper = result.Receipt with
        {
            ProviderId = "document-export.other",
            ContentDigest = string.Empty
        };
        providerTamper = providerTamper with
        {
            ContentDigest = DocumentExportDigest.Compute(providerTamper)
        };
        Assert.Throws<InvalidDataException>(() => DocumentExportSandboxRuntime.ValidateReceipt(
            providerTamper,
            result.Plan,
            task,
            input,
            _fixture.Tool,
            _fixture.HostBuildDigest,
            result.OutputBytes));
    }

    [Fact]
    public void StaticGovernanceKeepsOneBrokerWithoutShellFetchOrInheritedEnvironment()
    {
        string compiled = string.Join('\n',
            RuntimeMetadataInspection.DescribeType(typeof(DocumentExportSandboxRuntime)),
            RuntimeMetadataInspection.DescribeConstructors(typeof(DocumentExportSandboxRuntime)));
        Assert.DoesNotContain("System.Diagnostics.Process.Start", compiled, StringComparison.Ordinal);
        Assert.Equal(1, compiled.Split("System.Diagnostics.ProcessStartInfo..ctor", StringSplitOptions.None).Length - 1);
        Assert.Equal(1, compiled.Split("System.Diagnostics.ProcessStartInfo.set_UseShellExecute", StringSplitOptions.None).Length - 1);
        Assert.DoesNotContain("/bin/sh", compiled, StringComparison.Ordinal);
        Assert.DoesNotContain("System.Net.Http.HttpClient", compiled, StringComparison.Ordinal);
        Assert.DoesNotContain("System.Environment.GetEnvironment", compiled, StringComparison.Ordinal);
        Assert.DoesNotContain("PATH", compiled, StringComparison.Ordinal);
        Assert.DoesNotContain("latest", compiled, StringComparison.OrdinalIgnoreCase);

        MethodInfo builder = Assert.IsAssignableFrom<MethodInfo>(typeof(DocumentExportSandboxRuntime).GetMethod(
            "BuildStartInfo", BindingFlags.Instance | BindingFlags.NonPublic));
        AssertCompiledSandboxBoundary(typeof(DocumentExportSandboxRuntime), builder);
        string runRoot = Path.Combine(_fixture.Root, "runs", "shape-check");
        ProcessStartInfo start = Assert.IsType<ProcessStartInfo>(builder.Invoke(_fixture.CreateSandbox(),
        [
            runRoot,
            Path.Combine(runRoot, "input"),
            Path.Combine(runRoot, "output"),
            Path.Combine(runRoot, "work"),
            _fixture.Tool.ExecutablePath,
            _fixture.Tool.RuntimeRoot,
            _fixture.Tool
        ]));
        Assert.False(start.UseShellExecute);
        Assert.Equal(runRoot, start.WorkingDirectory);
        Assert.Equal("/usr/bin/bwrap", start.FileName);
        Assert.Contains("--clearenv", start.ArgumentList);
        Assert.DoesNotContain("PATH", start.ArgumentList);
    }

    [Theory]
    [InlineData(typeof(BenignSandboxMetadataFixture))]
    [InlineData(typeof(MemberLiteralSandboxMetadataFixture))]
    public void CompiledSandboxBoundaryAcceptsBrokerAndIgnoresMemberShapedLiterals(Type type)
    {
        MethodInfo builder = RequireMetadataFixtureBuilder(type);
        IReadOnlyList<SandboxMemberSite> sites = ReadSandboxMemberSites(type);
        Assert.Equal(builder, Assert.Single(sites, IsStartInfoConstruction).Method);
        Assert.Equal(builder, Assert.Single(sites, IsShellExecuteSetter).Method);
        if (type == typeof(MemberLiteralSandboxMetadataFixture))
        {
            string compiled = DescribeSandboxTypeTree(type);
            Assert.Contains("System.Diagnostics.ProcessStartInfo..ctor", compiled, StringComparison.Ordinal);
            Assert.Contains("System.Diagnostics.ProcessStartInfo.set_UseShellExecute", compiled, StringComparison.Ordinal);
            Assert.Contains(sites, site => site.OpCode == OpCodes.Ldtoken && site.Member == typeof(ProcessStartInfo));
        }

        AssertCompiledSandboxBoundary(type, builder);
    }

    [Theory]
    [InlineData(typeof(ConstructorLiteralSandboxMetadataFixture), "constructor-literal", 0, 0)]
    [InlineData(typeof(SetterLiteralSandboxMetadataFixture), "setter-literal", 1, 0)]
    [InlineData(typeof(ExtraConstructorSandboxMetadataFixture), "extra-constructor", 2, 1)]
    [InlineData(typeof(ExtraSetterSandboxMetadataFixture), "extra-setter", 1, 2)]
    [InlineData(typeof(OutsideBuilderConstructorSandboxMetadataFixture), "outside-builder-constructor", 1, 1)]
    [InlineData(typeof(OutsideBuilderSetterSandboxMetadataFixture), "outside-builder-setter", 1, 1)]
    [InlineData(typeof(NestedStartSandboxMetadataFixture), "process-start", 1, 1)]
    [InlineData(typeof(NestedHttpClientSandboxMetadataFixture), "http-client", 1, 1)]
    [InlineData(typeof(NestedEnvironmentSandboxMetadataFixture), "inherited-environment", 1, 1)]
    [InlineData(typeof(NestedShellSandboxMetadataFixture), "/bin/sh", 1, 1)]
    [InlineData(typeof(NestedPathSandboxMetadataFixture), "PATH", 1, 1)]
    [InlineData(typeof(NestedLatestSandboxMetadataFixture), "latest", 1, 1)]
    public void CompiledSandboxBoundaryRejectsActualViolationsAndLiteralSpoofs(
        Type type,
        string violation,
        int constructions,
        int setters)
    {
        MethodInfo builder = RequireMetadataFixtureBuilder(type);
        IReadOnlyList<SandboxMemberSite> sites = ReadSandboxMemberSites(type);
        Assert.Equal(constructions, sites.Count(IsStartInfoConstruction));
        Assert.Equal(setters, sites.Count(IsShellExecuteSetter));
        string compiled = DescribeSandboxTypeTree(type);
        switch (violation)
        {
            case "constructor-literal":
                Assert.Contains("System.Diagnostics.ProcessStartInfo..ctor", compiled, StringComparison.Ordinal);
                break;
            case "setter-literal":
                Assert.Contains("System.Diagnostics.ProcessStartInfo.set_UseShellExecute", compiled, StringComparison.Ordinal);
                break;
            case "extra-constructor":
                Assert.Contains(sites, site => IsStartInfoConstruction(site) && site.Method.DeclaringType != type);
                break;
            case "extra-setter":
                Assert.Contains(sites, site => IsShellExecuteSetter(site) && site.Method.DeclaringType != type);
                break;
            case "outside-builder-constructor":
                Assert.NotEqual(builder, Assert.Single(sites, IsStartInfoConstruction).Method);
                break;
            case "outside-builder-setter":
                Assert.NotEqual(builder, Assert.Single(sites, IsShellExecuteSetter).Method);
                break;
            case "process-start":
                Assert.Contains(sites, site => IsProcessStart(site) && site.Method.DeclaringType != type);
                break;
            case "http-client":
                Assert.Contains(sites, site => IsHttpClientMember(site) && site.Method.DeclaringType != type);
                break;
            case "inherited-environment":
                Assert.Contains(sites, site => IsInheritedEnvironmentMember(site) && site.Method.DeclaringType != type);
                break;
            default:
                Assert.Contains(violation, compiled, StringComparison.Ordinal);
                Assert.Contains(type.GetNestedTypes(BindingFlags.NonPublic), nested => nested.Name == "Unused");
                break;
        }

        Assert.ThrowsAny<Xunit.Sdk.XunitException>(() => AssertCompiledSandboxBoundary(type, builder));
    }

    private static void AssertCompiledSandboxBoundary(Type type, MethodInfo builder)
    {
        IReadOnlyList<SandboxMemberSite> sites = ReadSandboxMemberSites(type);
        SandboxMemberSite construction = Assert.Single(sites, IsStartInfoConstruction);
        SandboxMemberSite setter = Assert.Single(sites, IsShellExecuteSetter);
        Assert.Equal(builder, construction.Method);
        Assert.Equal(builder, setter.Method);
        Assert.DoesNotContain(sites, IsProcessStart);
        Assert.DoesNotContain(sites, IsHttpClientMember);
        Assert.DoesNotContain(sites, IsInheritedEnvironmentMember);

        string compiled = DescribeSandboxTypeTree(type);
        Assert.DoesNotContain("System.Diagnostics.Process.Start", compiled, StringComparison.Ordinal);
        Assert.DoesNotContain("/bin/sh", compiled, StringComparison.Ordinal);
        Assert.DoesNotContain("System.Net.Http.HttpClient", compiled, StringComparison.Ordinal);
        Assert.DoesNotContain("System.Environment.GetEnvironment", compiled, StringComparison.Ordinal);
        Assert.DoesNotContain("PATH", compiled, StringComparison.Ordinal);
        Assert.DoesNotContain("latest", compiled, StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsStartInfoConstruction(SandboxMemberSite site)
        => site.OpCode == OpCodes.Newobj
            && site.Member is ConstructorInfo { DeclaringType: { } declaringType }
            && declaringType == typeof(ProcessStartInfo);

    private static bool IsShellExecuteSetter(SandboxMemberSite site)
        => (site.OpCode == OpCodes.Call || site.OpCode == OpCodes.Callvirt)
            && site.Member == typeof(ProcessStartInfo).GetProperty(nameof(ProcessStartInfo.UseShellExecute))!.SetMethod;

    private static bool IsProcessStart(SandboxMemberSite site)
        => site.Member is MethodInfo { DeclaringType: { } declaringType, Name: nameof(Process.Start) }
            && declaringType == typeof(Process);

    private static bool IsHttpClientMember(SandboxMemberSite site)
        => site.Member == typeof(System.Net.Http.HttpClient)
            || site.Member.DeclaringType == typeof(System.Net.Http.HttpClient);

    private static bool IsInheritedEnvironmentMember(SandboxMemberSite site)
        => site.Member is MethodInfo { DeclaringType: { } declaringType } method
            && declaringType == typeof(Environment)
            && method.Name.StartsWith("GetEnvironment", StringComparison.Ordinal);

    private static MethodInfo RequireMetadataFixtureBuilder(Type type)
        => Assert.IsAssignableFrom<MethodInfo>(type.GetMethod("BuildStartInfo", SandboxDeclaredMembers));

    private static string DescribeSandboxTypeTree(Type type)
        => string.Join('\n', EnumerateSandboxTypes(type).SelectMany(static inspected => new[]
        {
            RuntimeMetadataInspection.DescribeType(inspected),
            RuntimeMetadataInspection.DescribeConstructors(inspected)
        }));

    private static IEnumerable<Type> EnumerateSandboxTypes(Type type)
    {
        yield return type;
        foreach (Type nested in type.GetNestedTypes(BindingFlags.Public | BindingFlags.NonPublic))
        {
            foreach (Type descendant in EnumerateSandboxTypes(nested))
            {
                yield return descendant;
            }
        }
    }

    private static IReadOnlyList<SandboxMemberSite> ReadSandboxMemberSites(Type type)
    {
        // These are exact IL sites, not control-flow or receiver/value dataflow evidence.
        var sites = new List<SandboxMemberSite>();
        foreach (Type inspected in EnumerateSandboxTypes(type))
        {
            IEnumerable<MethodBase> methods = inspected.GetMethods(SandboxDeclaredMembers)
                .Cast<MethodBase>()
                .Concat(inspected.GetConstructors(SandboxDeclaredMembers));
            if (inspected.TypeInitializer is { } initializer)
            {
                methods = methods.Append(initializer);
            }
            foreach (MethodBase method in methods.Distinct())
            {
                byte[]? il = method.GetMethodBody()?.GetILAsByteArray();
                if (il is null)
                {
                    continue;
                }
                Type[] typeArguments = inspected.IsGenericType ? inspected.GetGenericArguments() : Type.EmptyTypes;
                Type[] methodArguments = method.IsGenericMethod ? method.GetGenericArguments() : Type.EmptyTypes;
                for (int offset = 0; offset < il.Length;)
                {
                    int instructionOffset = offset;
                    ushort value = il[offset++];
                    if (value == 0xfe)
                    {
                        Assert.True(offset < il.Length);
                        value = (ushort)(0xfe00 | il[offset++]);
                    }
                    Assert.True(s_sandboxOpCodes.TryGetValue(value, out OpCode opCode));
                    int operandSize = opCode.OperandType switch
                    {
                        OperandType.InlineNone => 0,
                        OperandType.ShortInlineBrTarget or OperandType.ShortInlineI or OperandType.ShortInlineVar => 1,
                        OperandType.InlineVar => 2,
                        OperandType.InlineBrTarget or OperandType.InlineField or OperandType.InlineI or OperandType.InlineMethod
                            or OperandType.InlineSig or OperandType.InlineString or OperandType.InlineTok or OperandType.InlineType
                            or OperandType.ShortInlineR => 4,
                        OperandType.InlineI8 or OperandType.InlineR => 8,
                        OperandType.InlineSwitch when offset + 4 <= il.Length
                            => checked(4 + (BitConverter.ToInt32(il, offset) * 4)),
                        _ => -1
                    };
                    Assert.True(operandSize >= 0 && operandSize <= il.Length - offset);
                    if (opCode.OperandType is OperandType.InlineField or OperandType.InlineMethod
                        or OperandType.InlineTok or OperandType.InlineType)
                    {
                        MemberInfo member = Assert.IsAssignableFrom<MemberInfo>(method.Module.ResolveMember(
                            BitConverter.ToInt32(il, offset), typeArguments, methodArguments));
                        sites.Add(new SandboxMemberSite(method, instructionOffset, opCode, member));
                    }
                    offset += operandSize;
                }
            }
        }
        return sites;
    }

    private const BindingFlags SandboxDeclaredMembers = BindingFlags.Instance | BindingFlags.Static
        | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly;

    private static readonly IReadOnlyDictionary<ushort, OpCode> s_sandboxOpCodes = typeof(OpCodes)
        .GetFields(BindingFlags.Public | BindingFlags.Static)
        .Where(static field => field.FieldType == typeof(OpCode))
        .Select(static field => (OpCode)field.GetValue(null)!)
        .GroupBy(static opCode => unchecked((ushort)opCode.Value))
        .ToDictionary(static group => group.Key, static group => group.First());

    private sealed record SandboxMemberSite(MethodBase Method, int Offset, OpCode OpCode, MemberInfo Member);

    private static class BenignSandboxMetadataFixture
    {
        public static ProcessStartInfo BuildStartInfo() => new("broker")
        {
            UseShellExecute = false
        };
    }

    private static class MemberLiteralSandboxMetadataFixture
    {
        public static ProcessStartInfo BuildStartInfo()
        {
            GC.KeepAlive("System.Diagnostics.ProcessStartInfo..ctor");
            GC.KeepAlive("System.Diagnostics.ProcessStartInfo.set_UseShellExecute");
            GC.KeepAlive(typeof(ProcessStartInfo));
            return new ProcessStartInfo("broker") { UseShellExecute = false };
        }
    }

    private static class ConstructorLiteralSandboxMetadataFixture
    {
        public static ProcessStartInfo BuildStartInfo()
        {
            GC.KeepAlive("System.Diagnostics.ProcessStartInfo..ctor");
            return null!;
        }
    }

    private static class SetterLiteralSandboxMetadataFixture
    {
        public static ProcessStartInfo BuildStartInfo()
        {
            GC.KeepAlive("System.Diagnostics.ProcessStartInfo.set_UseShellExecute");
            return new ProcessStartInfo("broker");
        }
    }

    private static class ExtraConstructorSandboxMetadataFixture
    {
        public static ProcessStartInfo BuildStartInfo() => new("broker")
        {
            UseShellExecute = false
        };

        private static class Unused
        {
            public static ProcessStartInfo Build() => new("other");
        }
    }

    private static class ExtraSetterSandboxMetadataFixture
    {
        public static ProcessStartInfo BuildStartInfo() => new("broker")
        {
            UseShellExecute = false
        };

        private static class Unused
        {
            public static void Set(ProcessStartInfo start) => start.UseShellExecute = false;
        }
    }

    private static class NestedStartSandboxMetadataFixture
    {
        public static ProcessStartInfo BuildStartInfo() => new("broker")
        {
            UseShellExecute = false
        };

        private static class Unused
        {
            public static Process? Start(ProcessStartInfo start) => Process.Start(start);
        }
    }

    private static class OutsideBuilderConstructorSandboxMetadataFixture
    {
        public static ProcessStartInfo BuildStartInfo() => Unused.Build();

        private static class Unused
        {
            public static ProcessStartInfo Build() => new("broker")
            {
                UseShellExecute = false
            };
        }
    }

    private static class OutsideBuilderSetterSandboxMetadataFixture
    {
        public static ProcessStartInfo BuildStartInfo()
        {
            var start = new ProcessStartInfo("broker");
            Unused.Set(start);
            return start;
        }

        private static class Unused
        {
            public static void Set(ProcessStartInfo start) => start.UseShellExecute = false;
        }
    }

    private static class NestedHttpClientSandboxMetadataFixture
    {
        public static ProcessStartInfo BuildStartInfo() => new("broker")
        {
            UseShellExecute = false
        };

        private static class Unused
        {
            public static System.Net.Http.HttpClient Create() => new();
        }
    }

    private static class NestedEnvironmentSandboxMetadataFixture
    {
        public static ProcessStartInfo BuildStartInfo() => new("broker")
        {
            UseShellExecute = false
        };

        private static class Unused
        {
            public static string? Read() => Environment.GetEnvironmentVariable("fixture-value");
        }
    }

    private static class NestedShellSandboxMetadataFixture
    {
        public static ProcessStartInfo BuildStartInfo() => new("broker")
        {
            UseShellExecute = false
        };

        private static class Unused
        {
            public static string Read() => "/bin/sh";
        }
    }

    private static class NestedPathSandboxMetadataFixture
    {
        public static ProcessStartInfo BuildStartInfo() => new("broker")
        {
            UseShellExecute = false
        };

        private static class Unused
        {
            public static string Read() => "PATH";
        }
    }

    private static class NestedLatestSandboxMetadataFixture
    {
        public static ProcessStartInfo BuildStartInfo() => new("broker")
        {
            UseShellExecute = false
        };

        private static class Unused
        {
            public static string Read() => "latest";
        }
    }

    public void Dispose() => _fixture.Dispose();

    private void AssertFailureReceipt(
        DocumentExportSandboxPlan plan,
        DocumentExportSandboxReceipt receipt,
        DocumentExportTask task,
        DocumentExportFrozenInput input,
        string status,
        string failureCode)
    {
        Assert.Equal(0, receipt.ProcessesRemaining);
        Assert.True(receipt.ProcessTreeTerminated);
        Assert.True(receipt.RunDirectoryRemoved);
        Assert.True(receipt.RootProcessId > 0);
        Assert.True(receipt.RootProcessStartIdentity > 0);
        Assert.Empty(Directory.EnumerateDirectories(_fixture.RunsRoot));
        DocumentExportSandboxRuntime.ValidateFailureReceipt(
            receipt,
            plan,
            task,
            input,
            _fixture.Tool,
            _fixture.HostBuildDigest,
            status,
            failureCode);
    }
}
