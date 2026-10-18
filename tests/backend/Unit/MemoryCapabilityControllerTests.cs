using FsusBlog.Server.Infrastructure.Memory.Accounting;
using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Control;
using FsusBlog.Server.Infrastructure.Memory.Devices;
using FsusBlog.Server.Infrastructure.Memory.Lifetime;
using FsusBlog.Server.Infrastructure.Memory.Pressure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class MemoryCapabilityControllerTests
{
    private const string Candidate = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    [Fact]
    public async Task OmittedAutoActivatesAnAdmittedManagedProbeWithoutPopulatingAnyOtherBacking()
    {
        using var fixture = new Fixture();
        MemoryCapabilityControlResult result = Assert.Single(await fixture.Controller.TickAsync(fixture.Policy(), fixture.Governor(),
            new Dictionary<string, MemoryCapabilityRuntimeIdentity> { ["managed"] = fixture.Identity },
            new Dictionary<string, MemoryCapabilityReleaseBinding> { ["managed"] = fixture.Release() }));
        Assert.Equal(MemoryCapabilityControlReason.Ready, result.Reason);
        Assert.Equal(MemoryOnlineState.Online, result.Status.OnlineState);
        Assert.Equal(MemoryCapabilityMode.Auto, result.Status.Requested);
        Assert.Equal("managed.bcl", result.Status.EffectivePath);
        Assert.Equal(1, fixture.Probes);
        Assert.Single(fixture.Owners);
        Assert.Equal(16, fixture.Ledger.Snapshot().Used["host"]);
        Assert.Equal(0, fixture.Ledger.Snapshot().Used["slots"]);
        Assert.NotNull(fixture.Select());
        Assert.Equal(1, fixture.Probes);
    }

    [Fact]
    public async Task DisabledAndMissingOrUnqualifiedInputsPerformNoProbeOrReservation()
    {
        using var disabled = new Fixture(MemoryCapabilityMode.Disabled);
        Assert.Equal(MemoryCapabilityControlReason.Disabled, (await disabled.Probe()).Reason);
        Assert.Equal(0, disabled.Probes);
        Assert.All(disabled.Ledger.Snapshot().Used.Values, used => Assert.Equal(0, used));
        using var fixture = new Fixture(MemoryCapabilityMode.Required);
        MemoryCapabilityControlResult missing = await fixture.Controller.ProbeAsync("managed", fixture.Identity,
            fixture.Release(), null, fixture.Governor());
        Assert.Equal(MemoryCapabilityControlReason.UnmetBaseline, missing.Reason);
        Assert.False(missing.RequiredSatisfied);
        Assert.Equal(MemoryCapabilityControlReason.UnmetGovernor,
            (await fixture.Controller.ProbeAsync("managed", fixture.Identity, fixture.Release(), fixture.Policy(), null)).Reason);
        Assert.Equal(MemoryCapabilityControlReason.ReleaseUnqualified,
            (await fixture.Controller.ProbeAsync("managed", fixture.Identity,
                fixture.Release() with
                {
                    Qualification = MemoryQualification.NotVerified
                }, fixture.Policy(), fixture.Governor())).Reason);
        Assert.Equal(0, fixture.Probes);
        Assert.All(fixture.Ledger.Snapshot().Used.Values, used => Assert.Equal(0, used));
    }

    [Fact]
    public async Task DisableStopsNewAdmissionsBeforeActualOperationAndReaderDrain()
    {
        using var fixture = new Fixture();
        await fixture.Probe();
        ManagedMemoryBacking backing = Assert.Single(fixture.Owners);
        using IMemoryHostReadLease reader = backing.TryAcquireHostView(backing.Location).Value!;
        MemoryCapabilitySelection selection = fixture.Select()!;
        using MemoryCapabilityOperationLease operation = fixture.Controller.TryReserveOperation(selection,
            fixture.Admission(), fixture.Governor(), [new(fixture.Slots, MemoryResourceUnit.OperationSlots, 1)]).Value!;
        fixture.Controller.ApplyPolicy(fixture.Plan(2, MemoryCapabilityMode.Disabled));
        Assert.Equal(MemoryOnlineState.Draining, fixture.Controller.Snapshot()["managed"].OnlineState);
        Assert.Equal(MemoryFailure.TierUnavailable, fixture.Controller.TryReserveOperation(selection,
            fixture.Admission(), fixture.Governor(), [new(fixture.Slots, MemoryResourceUnit.OperationSlots, 1)]).Failure);
        Assert.Equal(MemoryRetirementState.Open, backing.Snapshot().State);
        Assert.Equal(16, fixture.Ledger.Snapshot().Used["host"]);
        operation.Dispose();
        Assert.Equal(MemoryRetirementState.Closing, backing.Snapshot().State);
        Assert.False(backing.Drained.IsCompleted);
        Assert.Equal(MemoryOnlineState.Draining, fixture.Controller.Snapshot()["managed"].OnlineState);
        Assert.Equal(4, reader.Memory.Length);
        reader.Dispose();
        Assert.True(backing.Drained.IsCompleted);
        Assert.Equal(MemoryOnlineState.Disabled, fixture.Controller.Snapshot()["managed"].OnlineState);
        Assert.All(fixture.Ledger.Snapshot().Used.Values, used => Assert.Equal(0, used));
    }

    [Fact]
    public async Task DisableDuringProbeRejectsItsStaleCompletionAndKeepsScratchUntilActualCompletion()
    {
        using var fixture = new Fixture();
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var resume = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        fixture.Behavior = async (context, _) =>
        {
            started.SetResult();
            await resume.Task;
            return fixture.ManagedOutcome(context);
        };
        Task<MemoryCapabilityControlResult> probing = fixture.Probe();
        await started.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(2, fixture.Ledger.Snapshot().Used["host"]);
        fixture.Controller.ApplyPolicy(fixture.Plan(2, MemoryCapabilityMode.Disabled));
        Assert.Equal(MemoryOnlineState.Draining, fixture.Controller.Snapshot()["managed"].OnlineState);
        Assert.Equal(2, fixture.Ledger.Snapshot().Used["host"]);
        resume.SetResult();
        Assert.Equal(MemoryCapabilityControlReason.StaleCompletion, (await probing).Reason);
        Assert.Equal(MemoryOnlineState.Disabled, fixture.Controller.Snapshot()["managed"].OnlineState);
        Assert.All(fixture.Ledger.Snapshot().Used.Values, used => Assert.Equal(0, used));
    }

    [Fact]
    public async Task OuterCancellationAbandonsWaiterWithoutFreeingTheActualProbe()
    {
        using var fixture = new Fixture();
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var resume = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        fixture.Behavior = async (context, _) =>
        {
            started.SetResult();
            await resume.Task;
            return fixture.ManagedOutcome(context);
        };
        using var cancellation = new CancellationTokenSource();
        Task<MemoryCapabilityControlResult> waiter = fixture.Controller.ProbeAsync("managed", fixture.Identity,
            fixture.Release(), fixture.Policy(), fixture.Governor(), cancellation.Token);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(10));
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () => await waiter);
        Assert.Equal(2, fixture.Ledger.Snapshot().Used["host"]);
        fixture.Controller.ApplyPolicy(fixture.Plan(2, MemoryCapabilityMode.Disabled));
        Task actual = fixture.Controller.AwaitPendingProbeAsync("managed");
        resume.SetResult();
        await actual.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(MemoryOnlineState.Disabled, fixture.Controller.Snapshot()["managed"].OnlineState);
        Assert.All(fixture.Ledger.Snapshot().Used.Values, used => Assert.Equal(0, used));
    }

    [Fact]
    public async Task IdentityChangeInvalidatesAnActiveProbeBeforeItsLateResultCanGoOnline()
    {
        using var fixture = new Fixture();
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var resume = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        fixture.Behavior = async (context, _) =>
        {
            started.SetResult();
            await resume.Task;
            return fixture.ManagedOutcome(context);
        };
        Task<MemoryCapabilityControlResult> old = fixture.Probe();
        await started.Task.WaitAsync(TimeSpan.FromSeconds(10));
        fixture.Identity = new(new string('d', 64), new(2));
        Assert.Equal(MemoryCapabilityControlReason.Draining, (await fixture.Probe()).Reason);
        resume.SetResult();
        Assert.Equal(MemoryCapabilityControlReason.StaleCompletion, (await old).Reason);
        Assert.Equal(MemoryOnlineState.Offline, fixture.Controller.Snapshot()["managed"].OnlineState);
        fixture.Clock.Advance(TimeSpan.FromSeconds(2));
        fixture.Behavior = null;
        Assert.Equal(MemoryOnlineState.Online, (await fixture.Probe()).Status.OnlineState);
    }

    [Fact]
    public async Task ProbeFaultCooldownAndCircuitAutomaticallyPermitFreshRecovery()
    {
        using var fixture = new Fixture();
        fixture.Behavior = (_, _) => throw new InvalidOperationException("fixture probe fault");
        Assert.Equal(MemoryCapabilityControlReason.ProbeFault, (await fixture.Probe()).Reason);
        Assert.Equal(MemoryCapabilityControlReason.RetryDeferred, (await fixture.Probe()).Reason);
        fixture.Clock.Advance(TimeSpan.FromSeconds(2));
        Assert.Equal(MemoryCapabilityControlReason.ProbeFault, (await fixture.Probe()).Reason);
        Assert.Equal(MemoryCapabilityControlReason.CircuitOpen, (await fixture.Probe()).Reason);
        Assert.Equal(2, fixture.Probes);
        Assert.All(fixture.Ledger.Snapshot().Used.Values, used => Assert.Equal(0, used));
        fixture.Clock.Advance(TimeSpan.FromSeconds(5));
        fixture.Behavior = null;
        Assert.Equal(MemoryOnlineState.Online, (await fixture.Probe()).Status.OnlineState);
        Assert.Equal(3, fixture.Probes);
    }

    [Fact]
    public async Task OperationBudgetRejectionLeavesBackendOnlineAndLaterAdmissionRecovers()
    {
        using var fixture = new Fixture();
        await fixture.Probe();
        MemoryCapabilitySelection selection = fixture.Select()!;
        using MemoryReservation occupied = fixture.Ledger.TryReserve([new(fixture.Slots, MemoryResourceUnit.OperationSlots, 8)]).Value!;
        Assert.Equal(MemoryFailure.BudgetRejected, fixture.Controller.TryReserveOperation(selection, fixture.Admission(),
            fixture.Governor(), [new(fixture.Slots, MemoryResourceUnit.OperationSlots, 1)]).Failure);
        Assert.Equal(MemoryOnlineState.Online, fixture.Controller.Snapshot()["managed"].OnlineState);
        Assert.Equal(MemoryAdmission.BudgetRejected, fixture.Controller.Snapshot()["managed"].LastAdmission);
        occupied.Dispose();
        using MemoryCapabilityOperationLease lease = fixture.Controller.TryReserveOperation(selection, fixture.Admission(),
            fixture.Governor(), [new(fixture.Slots, MemoryResourceUnit.OperationSlots, 1)]).Value!;
        Assert.Equal(1, fixture.Probes);
        Assert.Equal(MemoryAdmission.Admitted, fixture.Controller.Snapshot()["managed"].LastAdmission);
    }

    [Fact]
    public async Task ExpiredReleaseAndInvalidPolicyCannotRetainUsableSelectionOrChangeAcceptedRevision()
    {
        using var fixture = new Fixture();
        await fixture.Probe();
        Assert.Throws<ArgumentException>(() => fixture.Controller.ApplyPolicy(fixture.Plan(1, MemoryCapabilityMode.Disabled)));
        Assert.Equal(1UL, fixture.Controller.Snapshot()["managed"].PolicyRevision);
        Assert.Equal(MemoryOnlineState.Online, fixture.Controller.Snapshot()["managed"].OnlineState);
        fixture.Clock.Advance(TimeSpan.FromMinutes(2));
        Assert.Null(fixture.Select());
        Assert.Equal(MemoryQualification.NotVerified, fixture.Controller.Snapshot()["managed"].RuntimeQualification);
        Assert.Equal(MemoryCapabilityControlReason.ReleaseUnqualified,
            (await fixture.Controller.ProbeAsync("managed", fixture.Identity, fixture.Release() with
            {
                ValidUntil = fixture.Clock.GetUtcNow()
            }, fixture.Policy(), fixture.Governor())).Reason);
    }

    [Fact]
    public async Task ProbeDeadlineReturnsWithoutReleasingAnUncooperativeActualOperation()
    {
        using var fixture = new Fixture();
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var resume = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        fixture.Behavior = async (context, _) =>
        {
            started.SetResult();
            await resume.Task;
            return fixture.ManagedOutcome(context);
        };
        Task<MemoryCapabilityControlResult> probe = fixture.Controller.ProbeAsync("managed", fixture.Identity,
            fixture.Release(), fixture.Policy() with
            {
                MaximumProbeDuration = TimeSpan.FromMilliseconds(100)
            }, fixture.Governor());
        await started.Task.WaitAsync(TimeSpan.FromSeconds(10));
        try
        {
            Assert.Equal(MemoryCapabilityControlReason.ProbeTimedOut, (await probe.WaitAsync(TimeSpan.FromSeconds(10))).Reason);
            Assert.Equal(2, fixture.Ledger.Snapshot().Used["host"]);
            Assert.Equal(1, fixture.Ledger.Snapshot().Used["slots"]);
            Assert.Equal(MemoryCapabilityControlReason.Draining, (await fixture.Probe()).Reason);
            Assert.Equal(1, fixture.Probes);
        }
        finally
        {
            Task actual = fixture.Controller.AwaitPendingProbeAsync("managed");
            resume.TrySetResult();
            await actual.WaitAsync(TimeSpan.FromSeconds(10));
        }
        Assert.NotEqual(MemoryOnlineState.Online, fixture.Controller.Snapshot()["managed"].OnlineState);
        Assert.All(fixture.Ledger.Snapshot().Used.Values, used => Assert.Equal(0, used));
    }

    [Theory]
    [InlineData(MemoryDetection.Absent, MemoryCapabilityControlReason.Absent)]
    [InlineData(MemoryDetection.Unsupported, MemoryCapabilityControlReason.Unsupported)]
    [InlineData(MemoryDetection.Unknown, MemoryCapabilityControlReason.PermissionDenied)]
    public async Task RequiredAbsentUnsupportedAndDeniedKeepTheirDistinctFacts(MemoryDetection detection,
        MemoryCapabilityControlReason reason)
    {
        using var fixture = new Fixture(MemoryCapabilityMode.Required);
        fixture.Behavior = (_, _) => ValueTask.FromResult(new MemoryCapabilityProbeOutcome(detection,
            MemoryQualification.NotVerified, reason, null));
        MemoryCapabilityControlResult result = await fixture.Probe();
        Assert.Equal(reason, result.Reason);
        Assert.Equal(detection, result.Status.Detection);
        Assert.Equal(MemoryQualification.NotVerified, result.Status.RuntimeQualification);
        Assert.False(result.RequiredSatisfied);
        Assert.Null(fixture.Select());
        Assert.All(fixture.Ledger.Snapshot().Used.Values, used => Assert.Equal(0, used));
    }

    [Fact]
    public async Task ExistingBackingFactoryCannotEscapeThePublishedScopedProbeBudget()
    {
        using var fixture = new Fixture();
        fixture.Behavior = (context, _) =>
        {
            var content = new MemoryContentIdentity(new(Guid.NewGuid()), new(1), new(Guid.NewGuid()));
            MemoryOperationResult<ManagedMemoryBacking> oversized = ManagedMemoryBacking.TryCreate(fixture.Ledger,
                fixture.Host, fixture.Slots, content, new(context.Generation), context.Identity.Epoch, [], 101, 8);
            Assert.Equal(MemoryFailure.BudgetRejected, oversized.Failure);
            return ValueTask.FromResult(new MemoryCapabilityProbeOutcome(MemoryDetection.Present,
                MemoryQualification.Rejected, MemoryCapabilityControlReason.RuntimeUnqualified, null));
        };
        MemoryCapabilityControlResult result = await fixture.Probe();
        Assert.Equal(MemoryCapabilityControlReason.RuntimeUnqualified, result.Reason);
        Assert.Equal(MemoryQualification.Rejected, result.Status.RuntimeQualification);
        Assert.Empty(fixture.Owners);
        Assert.All(fixture.Ledger.Snapshot().Used.Values, used => Assert.Equal(0, used));
    }

    [Fact]
    public async Task ActualGpuDrainFailureRemainsFaultedAndRetainsItsCanonicalCharge()
    {
        using var fixture = new Fixture();
        var driver = new MemoryCapabilityGpuDriverFixture { FailFree = true };
        var qualification = new MemoryCapabilityStatus("fixture", 1, MemoryCapabilityMode.Auto, MemoryDetection.Present,
            MemoryQualification.Qualified, MemoryQualification.Qualified, MemoryOnlineState.Online,
            "fixture", MemoryAdmission.Admitted, "controlled driver only, not hardware qualification");
        using var device = new GpuMemoryDevice(driver, fixture.Ledger, new(fixture.Host, fixture.Host, fixture.Slots),
            new(64, 8, 4, 4, 4), new(1), qualification);
        using GpuAllocation allocation = device.TryAllocate(new(new(Guid.NewGuid()), new(1), new(Guid.NewGuid())), 32, new(1)).Value!;
        fixture.Behavior = (_, _) => ValueTask.FromResult(new MemoryCapabilityProbeOutcome(MemoryDetection.Present,
            MemoryQualification.Qualified, MemoryCapabilityControlReason.Ready, MemoryCapabilityOwner.FromGpu(device)));
        Assert.Equal(MemoryOnlineState.Online, (await fixture.Probe()).Status.OnlineState);
        fixture.Controller.ApplyPolicy(fixture.Plan(2, MemoryCapabilityMode.Disabled));
        MemoryCapabilityStatus status = fixture.Controller.Snapshot()["managed"];
        Assert.True(device.Drained.IsFaulted);
        Assert.Equal(MemoryOnlineState.Faulted, status.OnlineState);
        Assert.Equal(MemoryCapabilityControlReason.DrainFault.ToString(), status.Reason);
        Assert.Null(status.EffectivePath);
        Assert.Null(fixture.Select());
        Assert.Equal(32, fixture.Ledger.Snapshot().Used["host"]);
        Assert.Equal(0, driver.DisposeCalls);
    }

    private sealed class Fixture : IDisposable
    {
        public readonly ResourceDomainId Host = new(Guid.NewGuid());
        public readonly ResourceDomainId Slots = new(Guid.NewGuid());
        public readonly FixtureClock Clock = new();
        public readonly MemoryReservationCoordinator Ledger;
        public readonly MemoryCapabilityController Controller;
        public readonly List<ManagedMemoryBacking> Owners = [];
        public readonly TaskCompletionSource LastOutcome = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public MemoryCapabilityRuntimeIdentity Identity = new(new string('c', 64), new(1));
        public Func<MemoryCapabilityProbeContext, CancellationToken, ValueTask<MemoryCapabilityProbeOutcome>>? Behavior;
        public int Probes;

        public Fixture(MemoryCapabilityMode mode = MemoryCapabilityMode.Auto)
        {
            var topology = new MemoryResourceTopology([new(Host, "host", MemoryResourceUnit.Bytes, null),
                new(Slots, "slots", MemoryResourceUnit.OperationSlots, null)]);
            Ledger = new(topology, [new(Host, MemoryResourceUnit.Bytes, 1000), new(Slots, MemoryResourceUnit.OperationSlots, 8)], 1, 64, 128);
            Controller = new(Plan(1, mode), Ledger, [new("managed", "managed.bcl",
                [new(Host, MemoryResourceUnit.Bytes, 2), new(Slots, MemoryResourceUnit.OperationSlots, 1)], ProbeBackend)], Clock, Candidate);
        }

        public MemoryCapabilityPolicyPlan Plan(ulong revision, MemoryCapabilityMode mode)
            => new(revision, [new("managed", [], "host", 0)], mode == MemoryCapabilityMode.Auto
                ? new Dictionary<string, MemoryCapabilityMode>() : new Dictionary<string, MemoryCapabilityMode> { ["managed"] = mode }, 1);

        public MemoryCapabilityControlPolicy Policy()
            => new(1, 1, new(Candidate, "fixture-only", new string('0', 64), DateTimeOffset.UnixEpoch, MemoryQualification.Qualified),
                1, 2, TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(10), TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(5));

        public MemoryCapabilityReleaseBinding Release()
            => new(Candidate, Identity.IdentityDigest, MemoryQualification.Qualified, Clock.GetUtcNow().AddMinutes(1));

        public MemoryGovernorDecision Governor()
        {
            var policy = new MemoryGovernorPolicy(1, 1, Policy().Baseline, Ledger.Topology,
                [new(Host, 100, 60, 20, 10, 20, 40, 5, true), new(Slots, 8, 4, 1, 0, 1, 2, 1, false)],
                TimeSpan.FromSeconds(10), TimeSpan.FromSeconds(3));
            MemoryPressureObservation Observe(MemoryPressureMetric metric, long value) => new(metric, MemoryResourceUnit.Bytes,
                MemoryPressureScope.ExternalResourceDomain, Host, 1, MemoryObservationState.Available, value,
                "fixture-only-scoped-pressure", Clock.GetUtcNow(), Clock.GetTimestamp(), Clock.TimestampFrequency);
            return MemoryGovernor.Evaluate(policy, null, new(Candidate, 1, Clock.GetUtcNow(), Clock.GetTimestamp(),
                Clock.TimestampFrequency, Ledger.Snapshot(), [new("host", MemoryQualification.Qualified,
                    Observe(MemoryPressureMetric.ScopedExternalUsageBytes, 0), Observe(MemoryPressureMetric.ScopedExternalLimitBytes, 1000))],
                new Dictionary<string, long>(), [], null, false));
        }

        public MemoryCapabilityWorkloadAdmission Admission() => new(1, MemoryQualification.Qualified, MemoryAdmission.Admitted);
        public MemoryCapabilitySelection? Select() => Controller.Select("host", new Dictionary<string, MemoryCapabilityWorkloadAdmission>
        {
            ["managed"] = Admission()
        });
        public Task<MemoryCapabilityControlResult> Probe() => Controller.ProbeAsync("managed", Identity, Release(), Policy(), Governor());

        private async ValueTask<MemoryCapabilityProbeOutcome> ProbeBackend(MemoryCapabilityProbeContext context, CancellationToken cancellation)
        {
            Interlocked.Increment(ref Probes);
            return Behavior is null ? ManagedOutcome(context) : await Behavior(context, cancellation);
        }

        public MemoryCapabilityProbeOutcome ManagedOutcome(MemoryCapabilityProbeContext context)
        {
            var content = new MemoryContentIdentity(new(Guid.NewGuid()), new(1), new(Guid.NewGuid()));
            ManagedMemoryBacking backing = ManagedMemoryBacking.TryCreate(Ledger, Host, Slots, content,
                new(context.Generation), context.Identity.Epoch, new byte[] { 1, 2, 3, 4 }, 16, 8).Value!;
            Owners.Add(backing);
            LastOutcome.TrySetResult();
            return new(MemoryDetection.Present, MemoryQualification.Qualified, MemoryCapabilityControlReason.Ready,
                MemoryCapabilityOwner.FromManaged(backing));
        }

        public void Dispose()
        {
            Controller.ApplyPolicy(Plan(Controller.Snapshot()["managed"].PolicyRevision + 1, MemoryCapabilityMode.Disabled));
            foreach (ManagedMemoryBacking owner in Owners)
            {
                owner.Dispose();
            }
        }
    }

    private sealed class FixtureClock : TimeProvider
    {
        private DateTimeOffset _now = DateTimeOffset.UnixEpoch.AddSeconds(100);
        private long _timestamp = 100000;
        public override DateTimeOffset GetUtcNow() => _now;
        public override long GetTimestamp() => _timestamp;
        public override long TimestampFrequency => 1000;
        public void Advance(TimeSpan elapsed)
        {
            _now += elapsed;
            _timestamp += elapsed.Ticks / TimeSpan.TicksPerMillisecond;
        }
    }
}
