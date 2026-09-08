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
        UnixFileMode originalMode = File.GetUnixFileMode(_fixture.RunsRoot);
        File.SetUnixFileMode(_fixture.RunsRoot, UnixFileMode.UserRead | UnixFileMode.UserExecute);
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
            File.SetUnixFileMode(_fixture.RunsRoot, originalMode);
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
        string source = FsusBlog.Server.Tests.TestInfrastructure.BackendTestPaths.ReadAllTextFromRoot(
            "src", "backend", "Services", "DocumentExport", "DocumentExportSandbox.cs");

        Assert.Equal(0, source.Split("Process.Start(", StringSplitOptions.None).Length - 1);
        Assert.Equal(1, source.Split("new ProcessStartInfo(", StringSplitOptions.None).Length - 1);
        Assert.DoesNotContain("UseShellExecute = true", source, StringComparison.Ordinal);
        Assert.DoesNotContain("/bin/sh", source, StringComparison.Ordinal);
        Assert.DoesNotContain("HttpClient", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Environment.GetEnvironment", source, StringComparison.Ordinal);
        Assert.DoesNotContain("PATH", source, StringComparison.Ordinal);
        Assert.DoesNotContain("latest", source, StringComparison.OrdinalIgnoreCase);
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
