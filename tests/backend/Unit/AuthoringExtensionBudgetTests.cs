using System.Collections.Immutable;
using System.Diagnostics;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;

namespace FsusBlog.Server.Tests;

public sealed class AuthoringExtensionBudgetTests
{
    private static readonly AuthoringResourceMeasurement s_zero = new(
        TimeSpan.Zero,
        0,
        0,
        0,
        0,
        0,
        0,
        0);

    [Fact]
    public async Task ExecuteAsync_WithinBudget_ReturnsValueAndMeasuredTelemetry()
    {
        var measurements = new MeasurementSource(
            new AuthoringResourceMeasurement(TimeSpan.Zero, 1024, 0, 0, 0, 0, 0, 0),
            new AuthoringResourceMeasurement(TimeSpan.FromMilliseconds(5), 2048, 10, 20, 0, 30, 40, 50));
        BudgetFixture fixture = CreateFixture(measurements);

        AuthoringBudgetResult<string> result = await fixture.Supervisor.ExecuteAsync(
            fixture.Identity,
            fixture.Budget,
            new Operation<string>("ok"));

        Assert.Equal(AuthoringBudgetStatus.Completed, result.Status);
        Assert.Equal("ok", result.Value);
        Assert.Equal(20, result.Telemetry.OutboundBytes);
        Assert.Single(fixture.Telemetry.Items);
    }

    [Theory]
    [InlineData("cpu")]
    [InlineData("memory")]
    [InlineData("inbound")]
    [InlineData("outbound")]
    [InlineData("restart")]
    [InlineData("network")]
    [InlineData("file")]
    [InlineData("state")]
    public async Task ExecuteAsync_MeasuredBreach_QuarantinesWithoutReturningValue(string dimension)
    {
        AuthoringResourceMeasurement after = dimension switch
        {
            "cpu" => new AuthoringResourceMeasurement(TimeSpan.FromSeconds(2), 1, 0, 0, 0, 0, 0, 0),
            "memory" => new AuthoringResourceMeasurement(TimeSpan.Zero, 20_000, 0, 0, 0, 0, 0, 0),
            "inbound" => new AuthoringResourceMeasurement(TimeSpan.Zero, 1, 20_000, 0, 0, 0, 0, 0),
            "outbound" => new AuthoringResourceMeasurement(TimeSpan.Zero, 1, 0, 20_000, 0, 0, 0, 0),
            "restart" => new AuthoringResourceMeasurement(TimeSpan.Zero, 1, 0, 0, 2, 0, 0, 0),
            "network" => new AuthoringResourceMeasurement(TimeSpan.Zero, 1, 0, 0, 0, 20_000, 0, 0),
            "file" => new AuthoringResourceMeasurement(TimeSpan.Zero, 1, 0, 0, 0, 0, 20_000, 0),
            "state" => new AuthoringResourceMeasurement(TimeSpan.Zero, 1, 0, 0, 0, 0, 0, 20_000),
            _ => throw new InvalidOperationException()
        };
        BudgetFixture fixture = CreateFixture(new MeasurementSource(s_zero, after));

        AuthoringBudgetResult<string> result = await fixture.Supervisor.ExecuteAsync(
            fixture.Identity,
            fixture.Budget,
            new Operation<string>("must-not-escape"));

        Assert.Equal(AuthoringBudgetStatus.Breached, result.Status);
        Assert.Null(result.Value);
        Assert.Single(fixture.Containment.Reasons);
        Assert.Equal(1, fixture.Core.ProbeCount);
    }

    [Fact]
    public async Task ExecuteAsync_WallTimeout_QuarantinesAndDoesNotRetry()
    {
        BudgetFixture fixture = CreateFixture(new MeasurementSource(s_zero, s_zero));
        var operation = new NeverCompletesOperation();

        AuthoringBudgetResult<string> result = await fixture.Supervisor.ExecuteAsync(
            fixture.Identity,
            fixture.Budget with
            {
                MaximumWallTime = TimeSpan.FromMilliseconds(10)
            },
            operation);

        Assert.Equal(AuthoringBudgetStatus.Breached, result.Status);
        Assert.Equal("wall-time-budget-exceeded", result.StableReason);
        Assert.Equal(1, operation.CallCount);
        Assert.Single(fixture.Containment.Reasons);
    }

    [Fact]
    public async Task ExecuteAsync_LiveMeasurementBreach_CancelsBeforeWallLimit()
    {
        BudgetFixture fixture = CreateFixture(new MeasurementSource(
            s_zero,
            new AuthoringResourceMeasurement(TimeSpan.Zero, 20_000, 0, 0, 0, 0, 0, 0)));
        var operation = new NeverCompletesOperation();

        AuthoringBudgetResult<string> result = await fixture.Supervisor.ExecuteAsync(
            fixture.Identity,
            fixture.Budget with
            {
                MaximumWallTime = TimeSpan.FromSeconds(2)
            },
            operation);

        Assert.Equal(AuthoringBudgetStatus.Breached, result.Status);
        Assert.Equal("memory-budget-exceeded", result.StableReason);
        Assert.Equal(1, operation.CallCount);
        Assert.Single(fixture.Containment.Reasons);
    }

    [Fact]
    public async Task ExecuteAsync_MissingMeasurementAuthority_FailsClosedBeforeOperation()
    {
        var containment = new Containment();
        var telemetry = new TelemetrySink();
        var core = new CoreContinuity();
        var supervisor = new AuthoringExtensionBudgetSupervisor(
            new FailingMeasurementSource(),
            containment,
            telemetry,
            core,
            TimeProvider.System);
        BudgetFixture fixture = CreateFixture(new MeasurementSource(s_zero, s_zero));
        var operation = new CountingOperation();

        AuthoringBudgetResult<string> result = await supervisor.ExecuteAsync(
            fixture.Identity,
            fixture.Budget,
            operation);

        Assert.Equal(AuthoringBudgetStatus.Breached, result.Status);
        Assert.Equal("measurement-authority-failed", result.StableReason);
        Assert.Equal(0, operation.CallCount);
        Assert.Single(containment.Reasons);
        Assert.Single(telemetry.Items);
        Assert.Equal(1, core.ProbeCount);
    }

    [Fact]
    public async Task ExecuteAsync_AdmissionBreach_DoesNotStartOperation()
    {
        BudgetFixture fixture = CreateFixture(new MeasurementSource(
            new AuthoringResourceMeasurement(TimeSpan.Zero, 20_000, 0, 0, 0, 0, 0, 0),
            s_zero));
        var operation = new CountingOperation();

        AuthoringBudgetResult<string> result = await fixture.Supervisor.ExecuteAsync(
            fixture.Identity,
            fixture.Budget,
            operation);

        Assert.Equal(AuthoringBudgetStatus.Breached, result.Status);
        Assert.Equal("memory-budget-exceeded", result.StableReason);
        Assert.Equal(0, operation.CallCount);
        Assert.Single(fixture.Containment.Reasons);
    }

    [Fact]
    public async Task ExecuteAsync_RuntimeGateRejectsPolicyDrift()
    {
        BudgetFixture fixture = CreateFixture(new MeasurementSource(s_zero, s_zero));
        Assert.Equal(
            AuthoringBudgetStatus.Completed,
            (await fixture.Supervisor.ExecuteAsync(
                fixture.Identity,
                fixture.Budget,
                new Operation<string>("ok"))).Status);

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Supervisor.ExecuteAsync(
                fixture.Identity with
                {
                    PolicyDigest = new string('d', 64)
                },
                fixture.Budget,
                new Operation<string>("must-not-run")));
    }

    [Fact]
    public void FromManifest_UsesEveryManifestResourceCeiling()
    {
        AuthoringResourceLimits limits = AuthoringExtensionContractsTests.CreateManifest().Limits;

        AuthoringResourceBudget budget = AuthoringExtensionBudgetSupervisor.FromManifest(limits);

        Assert.Equal(limits.MaximumCpuTime, budget.MaximumCpuTime);
        Assert.Equal(limits.WallClock, budget.MaximumWallTime);
        Assert.Equal(limits.MemoryBytes, budget.MaximumMemoryBytes);
        Assert.Equal(limits.MaximumRequestBytes, budget.MaximumInboundBytes);
        Assert.Equal(limits.MaximumResponseBytes, budget.MaximumOutboundBytes);
        Assert.Equal(limits.MaximumConcurrentCalls, budget.MaximumConcurrency);
        Assert.Equal(limits.MaximumQueueDepth, budget.MaximumQueueDepth);
        Assert.Equal(limits.MaximumRestarts, budget.MaximumRestarts);
        Assert.Equal(limits.MaximumNetworkBytes, budget.MaximumNetworkBytes);
        Assert.Equal(limits.MaximumFileBytes, budget.MaximumFileBytes);
        Assert.Equal(limits.MaximumStateBytes, budget.MaximumStateBytes);
    }

    [Fact]
    public async Task LinuxMeasurementSource_ReportsOwnedProcessAndBrokerLedger()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }

        BudgetFixture fixture = CreateFixture(new MeasurementSource(s_zero, s_zero));
        using Process process = Process.GetCurrentProcess();
        var source = new LinuxProcAuthoringResourceMeasurementSource();
        source.Register(fixture.Identity.RuntimeIdentity, process.Id);
        source.RecordRestart(fixture.Identity.RuntimeIdentity);
        source.RecordBrokeredUsage(fixture.Identity.RuntimeIdentity, 11, 12, 13);

        AuthoringResourceMeasurement measured = await source.MeasureAsync(
            fixture.Identity,
            CancellationToken.None);

        Assert.True(measured.MemoryBytes > 0);
        Assert.Equal(1, measured.Restarts);
        Assert.Equal(11, measured.NetworkBytes);
        Assert.Equal(12, measured.FileBytes);
        Assert.Equal(13, measured.StateBytes);
        source.Unregister(fixture.Identity.RuntimeIdentity, process.Id);
    }

    [Fact]
    public async Task ExecuteAsync_RuntimeCrash_IsContainedAndCoreRemainsAvailable()
    {
        BudgetFixture fixture = CreateFixture(new MeasurementSource(s_zero, s_zero));

        AuthoringBudgetResult<string> result = await fixture.Supervisor.ExecuteAsync(
            fixture.Identity,
            fixture.Budget,
            new CrashingOperation());

        Assert.Equal(AuthoringBudgetStatus.Crashed, result.Status);
        Assert.Equal("runtime-crashed", result.StableReason);
        Assert.Equal(1, fixture.Core.ProbeCount);
    }

    [Fact]
    public async Task ExecuteAsync_QueueBudget_RejectsThirdConcurrentRequest()
    {
        BudgetFixture fixture = CreateFixture(new MeasurementSource(s_zero, s_zero));
        AuthoringResourceBudget budget = fixture.Budget with
        {
            MaximumConcurrency = 1,
            MaximumQueueDepth = 1
        };
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        Task<AuthoringBudgetResult<string>> first = fixture.Supervisor.ExecuteAsync(
            fixture.Identity with
            {
                RequestId = "request-1"
            },
            budget,
            new BlockingOperation(release.Task)).AsTask();
        await Task.Yield();
        Task<AuthoringBudgetResult<string>> second = fixture.Supervisor.ExecuteAsync(
            fixture.Identity with
            {
                RequestId = "request-2"
            },
            budget,
            new Operation<string>("second")).AsTask();
        await Task.Yield();

        AuthoringBudgetResult<string> third = await fixture.Supervisor.ExecuteAsync(
            fixture.Identity with
            {
                RequestId = "request-3"
            },
            budget,
            new Operation<string>("third"));

        Assert.Equal(AuthoringBudgetStatus.Rejected, third.Status);
        Assert.Equal("queue-budget-exceeded", third.StableReason);
        release.SetResult();
        await Task.WhenAll(first, second);
    }

    [Fact]
    public void TelemetryContract_HasNoPayloadSourceSecretOrFreeTextFields()
    {
        string[] names = typeof(AuthoringBudgetTelemetry).GetProperties()
            .Select(static property => property.Name)
            .ToArray();

        Assert.DoesNotContain(names, name => name.Contains("Payload", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(names, name => name.Contains("Source", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(names, name => name.Contains("Secret", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(names, name => name.Contains("Text", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task Telemetry_HashesDocumentAndRequestIdentities()
    {
        BudgetFixture fixture = CreateFixture(new MeasurementSource(s_zero, s_zero));

        AuthoringBudgetResult<string> result = await fixture.Supervisor.ExecuteAsync(
            fixture.Identity,
            fixture.Budget,
            new Operation<string>("ok"));

        Assert.NotEqual(fixture.Identity.DocumentId, result.Telemetry.Identity.DocumentIdentityDigest);
        Assert.NotEqual(fixture.Identity.RequestId, result.Telemetry.Identity.RequestIdentityDigest);
        Assert.Equal(64, result.Telemetry.Identity.DocumentIdentityDigest.Length);
        Assert.Equal(64, result.Telemetry.Identity.RequestIdentityDigest.Length);
    }

    [Fact]
    public async Task MeasuredBreach_QuarantinesTrackedRuntimeUntilExplicitApproval()
    {
        AuthoringExtensionManifest manifest = AuthoringExtensionContractsTests.CreateManifest();
        DateTimeOffset now = DateTimeOffset.UtcNow;
        var package = new VerifiedAuthoringPackage(
            AuthoringExtensionContractValidator.Verify(manifest),
            new AuthoringPackageArtifact([], [], "acme", "key-1", "source/1", "provenance/1"),
            new AuthoringPackageArchiveContents([], []),
            new AuthoringPackageTrustDecision(
                AuthoringPackageTrustStatus.Trusted,
                "acme",
                "key-1",
                now,
                now.AddMinutes(5)),
            new string('d', 64));
        AuthoringContributionDeclaration contribution = manifest.Contributions[0];
        ImmutableArray<AuthoringExecutionTarget> targets =
        [
            new AuthoringExecutionTarget(
                AuthoringExecutionResolutionStatus.Ready,
                contribution.ExecutionClass,
                manifest.Id,
                manifest.Version,
                manifest.PackageSha256,
                contribution.Id,
                contribution.Kind,
                contribution.Entrypoint.PathOrAdapterId,
                null,
                new string('e', 64),
                null)
        ];
        var resources = new AuthoringExtensionLifecycleResources(new EmptyHostResources());
        await resources.ActivateAtomicallyAsync(package, targets, 1, CancellationToken.None);
        var worker = new TrackedWorker();
        await resources.TrackWorkerAsync(manifest.Id, 1, worker);
        var supervisor = new AuthoringExtensionBudgetSupervisor(
            new MeasurementSource(s_zero, new AuthoringResourceMeasurement(
                TimeSpan.Zero,
                20_000,
                0,
                0,
                0,
                0,
                0,
                0)),
            new AuthoringLifecycleBudgetContainment(resources),
            new TelemetrySink(),
            new CoreContinuity(),
            TimeProvider.System);
        BudgetFixture fixture = CreateFixture(new MeasurementSource(s_zero, s_zero));

        AuthoringBudgetResult<string> result = await supervisor.ExecuteAsync(
            fixture.Identity,
            fixture.Budget,
            new Operation<string>("must-not-escape"));

        Assert.Equal(AuthoringBudgetStatus.Breached, result.Status);
        Assert.True(worker.Terminated);
        Assert.True(worker.Disposed);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await resources.ActivateAtomicallyAsync(package, targets, 2, CancellationToken.None));
        await resources.ClearQuarantineAsync(
            manifest.Id,
            "memory-budget-exceeded",
            "explicit-reenable-approval",
            CancellationToken.None);
        await resources.ActivateAtomicallyAsync(package, targets, 3, CancellationToken.None);
        Assert.True((await resources.RevokeAllAsync(manifest.Id, 3, CancellationToken.None)).IsEmpty);
    }

    private static BudgetFixture CreateFixture(MeasurementSource measurements)
    {
        var containment = new Containment();
        var telemetry = new TelemetrySink();
        var core = new CoreContinuity();
        var supervisor = new AuthoringExtensionBudgetSupervisor(
            measurements,
            containment,
            telemetry,
            core,
            TimeProvider.System);
        var identity = new AuthoringBudgetIdentity(
            new string('a', 64),
            "acme.author-tools",
            "1.0.0",
            new string('b', 64),
            "acme.command.format",
            "document-1",
            "request-1",
            1,
            new string('c', 64));
        var budget = new AuthoringResourceBudget(
            TimeSpan.FromSeconds(1),
            TimeSpan.FromSeconds(1),
            10_000,
            10_000,
            10_000,
            2,
            2,
            1,
            10_000,
            10_000,
            10_000);
        return new BudgetFixture(supervisor, identity, budget, containment, telemetry, core);
    }

    private sealed record BudgetFixture(
        AuthoringExtensionBudgetSupervisor Supervisor,
        AuthoringBudgetIdentity Identity,
        AuthoringResourceBudget Budget,
        Containment Containment,
        TelemetrySink Telemetry,
        CoreContinuity Core);

    private sealed class MeasurementSource(
        AuthoringResourceMeasurement before,
        AuthoringResourceMeasurement after) : IAuthoringResourceMeasurementSource
    {
        private int _calls;

        public ValueTask<AuthoringResourceMeasurement> MeasureAsync(
            AuthoringBudgetIdentity identity,
            CancellationToken cancellationToken) =>
            ValueTask.FromResult(++_calls % 2 == 1 ? before : after);
    }

    private sealed class FailingMeasurementSource : IAuthoringResourceMeasurementSource
    {
        public ValueTask<AuthoringResourceMeasurement> MeasureAsync(
            AuthoringBudgetIdentity identity,
            CancellationToken cancellationToken) =>
            ValueTask.FromException<AuthoringResourceMeasurement>(
                new AuthoringExtensionContractException("measurement unavailable"));
    }

    private sealed class Operation<T>(T value) : IAuthoringBudgetedRuntimeOperation<T>
    {
        public ValueTask<T> ExecuteAsync(CancellationToken cancellationToken) => ValueTask.FromResult(value);
    }

    private sealed class CountingOperation : IAuthoringBudgetedRuntimeOperation<string>
    {
        public int CallCount { get; private set; }

        public ValueTask<string> ExecuteAsync(CancellationToken cancellationToken)
        {
            CallCount++;
            return ValueTask.FromResult("unexpected");
        }
    }

    private sealed class NeverCompletesOperation : IAuthoringBudgetedRuntimeOperation<string>
    {
        public int CallCount
        {
            get; private set;
        }

        public async ValueTask<string> ExecuteAsync(CancellationToken cancellationToken)
        {
            CallCount++;
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            return string.Empty;
        }
    }

    private sealed class CrashingOperation : IAuthoringBudgetedRuntimeOperation<string>
    {
        public ValueTask<string> ExecuteAsync(CancellationToken cancellationToken) =>
            ValueTask.FromException<string>(new InvalidOperationException("crash"));
    }

    private sealed class BlockingOperation(Task release) : IAuthoringBudgetedRuntimeOperation<string>
    {
        public async ValueTask<string> ExecuteAsync(CancellationToken cancellationToken)
        {
            await release.WaitAsync(cancellationToken);
            return "first";
        }
    }

    private sealed class Containment : IAuthoringExtensionContainment
    {
        public List<string> Reasons { get; } = [];

        public ValueTask QuarantineAsync(
            AuthoringBudgetIdentity identity,
            string reason,
            CancellationToken cancellationToken)
        {
            Reasons.Add(reason);
            return ValueTask.CompletedTask;
        }
    }

    private sealed class TelemetrySink : IAuthoringBudgetTelemetrySink
    {
        public List<AuthoringBudgetTelemetry> Items { get; } = [];

        public ValueTask RecordAsync(AuthoringBudgetTelemetry telemetry, CancellationToken cancellationToken)
        {
            Items.Add(telemetry);
            return ValueTask.CompletedTask;
        }
    }

    private sealed class CoreContinuity : IAuthoringCoreContinuityProbe
    {
        public int ProbeCount
        {
            get; private set;
        }

        public ValueTask<bool> IsCoreAvailableAsync(CancellationToken cancellationToken)
        {
            ProbeCount++;
            return ValueTask.FromResult(true);
        }
    }

    private sealed class EmptyHostResources : IAuthoringLifecycleHostResourceAuthority
    {
        public ValueTask ActivateAtomicallyAsync(
            VerifiedAuthoringPackage package,
            ImmutableArray<AuthoringExecutionTarget> targets,
            CancellationToken cancellationToken) => ValueTask.CompletedTask;

        public ValueTask<AuthoringLifecycleHostResourceReport> RevokeAllAsync(
            string extensionId,
            CancellationToken cancellationToken) =>
            ValueTask.FromResult(new AuthoringLifecycleHostResourceReport(0, 0, 0, 0, 0));
    }

    private sealed class TrackedWorker : IAuthoringWorkerSandboxInstance
    {
        public AuthoringWorkerCapabilityReport CapabilityReport => new(
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            [],
            [],
            true,
            new string('f', 64));

        public bool Terminated
        {
            get; private set;
        }

        public bool Disposed
        {
            get; private set;
        }

        public ValueTask<AuthoringWorkerResponse> ExecuteAsync(
            AuthoringWorkerRequest request,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask TerminateAsync(string reason, CancellationToken cancellationToken)
        {
            Terminated = true;
            return ValueTask.CompletedTask;
        }

        public ValueTask DisposeAsync()
        {
            Disposed = true;
            return ValueTask.CompletedTask;
        }
    }
}
