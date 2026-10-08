using FsusBlog.Server.Infrastructure.Memory.Accounting;
using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Control;
using FsusBlog.Server.Infrastructure.Memory.Lifetime;
using FsusBlog.Server.Infrastructure.Memory.Pressure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class MemoryGovernorTests
{
    private const string Candidate = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static readonly ResourceDomainId s_host = new(Guid.NewGuid());
    private static readonly ResourceDomainId s_slots = new(Guid.NewGuid());
    private static readonly DateTimeOffset s_origin = DateTimeOffset.UnixEpoch;

    [Fact]
    public void MissingOrUnqualifiedBaselineAndPressureReturnExplicitUnmetPrerequisite()
    {
        var setup = Setup();
        AssertFrozen(MemoryGovernor.Evaluate(null, null, Input(setup.Ledger, 1)), MemoryGovernorReason.MissingPolicy);
        var unqualified = Policy(setup.Ledger, MemoryQualification.NotVerified);
        AssertFrozen(MemoryGovernor.Evaluate(unqualified, null, Input(setup.Ledger, 1)), MemoryGovernorReason.BaselineUnqualified);
        AssertFrozen(MemoryGovernor.Evaluate(setup.Policy, null, Input(setup.Ledger, 1) with
        {
            ExternalConstraints = []
        }), MemoryGovernorReason.MissingPressure);
        Assert.Equal(0, setup.Ledger.Snapshot().Used["host"]);
    }

    [Fact]
    public void SameInputSequenceProducesSameTargetsReasonsAndOrderedDegradation()
    {
        var setup = Setup();
        using MemoryReservation held = setup.Ledger.TryReserve([new(s_host, MemoryResourceUnit.Bytes, 80)]).Value!;
        MemoryGovernorDecision first = MemoryGovernor.Evaluate(setup.Policy, null, Input(setup.Ledger, 1));
        MemoryGovernorInput input = Input(setup.Ledger, 2, usage: 185);
        MemoryGovernorDecision left = MemoryGovernor.Evaluate(setup.Policy, first, input);
        MemoryGovernorDecision right = MemoryGovernor.Evaluate(setup.Policy, first, input);
        Assert.Equal(MemoryGovernorState.Pressure, left.State);
        Assert.Equal(left.Sequence, right.Sequence);
        Assert.Equal(left.Reason, right.Reason);
        Assert.Equal(left.Targets, right.Targets);
        Assert.Equal(left.EffectiveHardCaps, right.EffectiveHardCaps);
        Assert.Equal(left.Degradation, right.Degradation);
        Assert.Equal(Enum.GetValues<MemoryGovernorDegradation>(), left.Degradation);
        Assert.False(left.AllowPromotion);
        Assert.Equal(60, left.Targets["host"]);
        Assert.Equal(4, left.Targets["slots"]);
    }

    [Fact]
    public void LowerExternalBoundRetainsRealAllocationAndReaderUntilActualOwnerRelease()
    {
        var setup = Setup();
        var content = new MemoryContentIdentity(new(Guid.NewGuid()), new(1), new(Guid.NewGuid()));
        ManagedMemoryBacking owner = ManagedMemoryBacking.TryCreate(setup.Ledger, s_host, s_slots,
            content, new(1), new(1), new byte[16], 64, 8).Value!;
        using IMemoryHostReadLease reader = owner.TryAcquireHostView(owner.Location).Value!;
        MemoryGovernorDecision first = MemoryGovernor.Evaluate(setup.Policy, null, Input(setup.Ledger, 1));
        MemoryGovernorDecision lower = MemoryGovernor.Evaluate(setup.Policy, first, Input(setup.Ledger, 2, limit: 30, usage: 64) with
        {
            ProtectedAndInFlight = new Dictionary<string, long> { ["host"] = 64 }
        });
        Assert.Equal(MemoryGovernorState.Infeasible, lower.State);
        Assert.Equal(30, lower.EffectiveHardCaps["host"]);
        Assert.Equal(44, lower.ReclaimRequested["host"]);
        Assert.False(lower.AllowGrowth);
        owner.Dispose();
        Assert.False(owner.Drained.IsCompleted);
        Assert.Equal(64, setup.Ledger.Snapshot().Used["host"]);
        Assert.Equal(16, reader.Memory.Length);
        MemoryGovernorDecision pending = MemoryGovernor.Evaluate(setup.Policy, lower, Input(setup.Ledger, 3, limit: 30, usage: 64) with
        {
            ProtectedAndInFlight = new Dictionary<string, long> { ["host"] = 64 },
            Feedback = [new(lower.Sequence, "host", 44, 0, 0, 0, 44)]
        });
        Assert.Equal(44, Assert.Single(pending.Feedback).Blocked);
        Assert.Equal(0, Assert.Single(pending.Feedback).AllocatorRelinquished);
        Assert.Equal(64, setup.Ledger.Snapshot().Used["host"]);
        reader.Dispose();
        Assert.True(owner.Drained.IsCompleted);
        Assert.Equal(0, setup.Ledger.Snapshot().Used["host"]);
    }

    [Fact]
    public void OscillationResetsRecoveryWindowAndGrowthIsRateBounded()
    {
        var setup = Setup();
        using MemoryReservation held = setup.Ledger.TryReserve([new(s_host, MemoryResourceUnit.Bytes, 80)]).Value!;
        MemoryGovernorDecision current = MemoryGovernor.Evaluate(setup.Policy, null, Input(setup.Ledger, 1, usage: 195));
        Assert.Equal(MemoryGovernorState.Critical, current.State);
        Assert.Equal(20, current.Targets["host"]);
        current = MemoryGovernor.Evaluate(setup.Policy, current, Input(setup.Ledger, 2));
        Assert.Equal(MemoryGovernorState.Recovering, current.State);
        current = MemoryGovernor.Evaluate(setup.Policy, current, Input(setup.Ledger, 3, usage: 185));
        Assert.Equal(MemoryGovernorState.Pressure, current.State);
        current = MemoryGovernor.Evaluate(setup.Policy, current, Input(setup.Ledger, 4));
        Assert.False(current.AllowGrowth);
        current = MemoryGovernor.Evaluate(setup.Policy, current, Input(setup.Ledger, 6));
        Assert.False(current.AllowGrowth);
        current = MemoryGovernor.Evaluate(setup.Policy, current, Input(setup.Ledger, 7));
        Assert.True(current.AllowGrowth);
        Assert.Equal(25, current.Targets["host"]);
        Assert.Equal(MemoryGovernorReason.BoundedGrowth, current.Reason);
    }

    [Fact]
    public void MissingStaleMigratedOrFaultedSourceRetainsLatestHardConstraint()
    {
        var setup = Setup();
        using MemoryReservation held = setup.Ledger.TryReserve([new(s_host, MemoryResourceUnit.Bytes, 80)]).Value!;
        MemoryGovernorDecision first = MemoryGovernor.Evaluate(setup.Policy, null, Input(setup.Ledger, 1, limit: 70, usage: 55));
        MemoryGovernorInput next = Input(setup.Ledger, 2) with
        {
            ExternalConstraints = []
        };
        MemoryGovernorDecision missing = MemoryGovernor.Evaluate(setup.Policy, first, next);
        AssertFrozen(missing, MemoryGovernorReason.MissingPressure);
        Assert.Equal(70, missing.EffectiveHardCaps["host"]);
        Assert.Equal(60, missing.Targets["host"]);
        MemoryGovernorExternalConstraint constraint = Input(setup.Ledger, 1).ExternalConstraints[0];
        AssertFrozen(MemoryGovernor.Evaluate(setup.Policy, first, Input(setup.Ledger, 20) with
        {
            ExternalConstraints = [constraint]
        }), MemoryGovernorReason.StalePressure);
        AssertFrozen(MemoryGovernor.Evaluate(setup.Policy, first, Input(setup.Ledger, 2) with
        {
            DomainRevision = 2
        }), MemoryGovernorReason.DomainChanged);
        MemoryGovernorDecision fault = MemoryGovernor.Evaluate(setup.Policy, first, Input(setup.Ledger, 2) with
        {
            ControllerFaulted = true
        });
        Assert.Equal(MemoryGovernorState.Faulted, fault.State);
        Assert.Equal(70, fault.EffectiveHardCaps["host"]);
        Assert.False(fault.AllowGrowth);
    }

    [Fact]
    public void LedgerChargeCannotBeOverriddenByLowExternalUsageOrUnverifiedServiceFlags()
    {
        var setup = Setup();
        using MemoryReservation reservation = setup.Ledger.TryReserve([new(s_host, MemoryResourceUnit.Bytes, 250)]).Value!;
        MemoryGovernorDecision decision = MemoryGovernor.Evaluate(setup.Policy, null, Input(setup.Ledger, 1, usage: 0));
        Assert.Equal(MemoryGovernorState.Pressure, decision.State);
        Assert.Equal(190, decision.ReclaimRequested["host"]);
        Assert.Equal(250, setup.Ledger.Snapshot().Used["host"]);
        reservation.Dispose();
        var unverified = new MemoryGovernorServicePressure(1, MemoryQualification.NotVerified,
            s_origin.AddSeconds(2), true, true, true);
        MemoryGovernorDecision normal = MemoryGovernor.Evaluate(setup.Policy, decision,
            Input(setup.Ledger, 2) with
            {
                ServicePressure = unverified
            });
        Assert.NotEqual(MemoryGovernorState.Critical, normal.State);
        MemoryGovernorDecision critical = MemoryGovernor.Evaluate(setup.Policy, normal,
            Input(setup.Ledger, 3) with
            {
                ServicePressure = unverified with
                {
                    Qualification = MemoryQualification.Qualified,
                    SampledAt = s_origin.AddSeconds(3)
                }
            });
        Assert.Equal(MemoryGovernorState.Critical, critical.State);
        Assert.Equal(MemoryGovernorReason.SustainedServicePressure, critical.Reason);
    }

    [Fact]
    public void HistoricalOccupancyOrFileFaultsWithoutQualifiedActivityDoNotCreateSwapEmergency()
    {
        var setup = Setup();
        var activity = new MemoryGovernorServicePressure(1, MemoryQualification.Qualified,
            s_origin.AddSeconds(1), false, true, true);
        Assert.Equal(MemoryGovernorState.Normal,
            MemoryGovernor.Evaluate(setup.Policy, null, Input(setup.Ledger, 1) with
            {
                ServicePressure = activity
            }).State);
        Assert.Equal(MemoryGovernorState.Normal,
            MemoryGovernor.Evaluate(setup.Policy, null, Input(setup.Ledger, 1) with
            {
                ServicePressure = activity with
                {
                    SustainedSwapActivity = true,
                    SustainedStalls = false
                }
            }).State);
    }

    [Fact]
    public void WrongRevisionInvalidFeedbackAndClockResetFreezeInsteadOfReleasingCapacity()
    {
        var setup = Setup();
        using MemoryReservation reservation = setup.Ledger.TryReserve([new(s_host, MemoryResourceUnit.Bytes, 80)]).Value!;
        MemoryGovernorDecision first = MemoryGovernor.Evaluate(setup.Policy, null, Input(setup.Ledger, 1, usage: 195));
        AssertFrozen(MemoryGovernor.Evaluate(setup.Policy, first, Input(setup.Ledger, 2) with
        {
            CandidateCommit = new string('b', 40)
        }), MemoryGovernorReason.RevisionMismatch);
        AssertFrozen(MemoryGovernor.Evaluate(setup.Policy, first, Input(setup.Ledger, 2) with
        {
            Feedback = [new(first.Sequence, "host", 60, 40, 41, 0, 0)]
        }), MemoryGovernorReason.InvalidInput);
        AssertFrozen(MemoryGovernor.Evaluate(setup.Policy, first, Input(setup.Ledger, 1)), MemoryGovernorReason.ClockDiscontinuity);
        Assert.Equal(80, setup.Ledger.Snapshot().Used["host"]);
    }

    [Fact]
    public void FrozenPolicyRejectsUnknownScopesAliasedResourcesAndInvalidNumericalInputs()
    {
        var setup = Setup();
        MemoryGovernorResourcePolicy resource = Resource();
        Assert.Throws<ArgumentException>(() => Policy(setup.Ledger, resources: [resource with { ExitHeadroom = resource.EntryHeadroom }]));
        Assert.Throws<ArgumentException>(() => Policy(setup.Ledger, resources: [resource with { MaximumGrowthPerSecond = 0 }]));
        Assert.Throws<ArgumentException>(() => Policy(setup.Ledger, resources: [resource with { RequiresExternalConstraint = false }]));
        Assert.Throws<ArgumentException>(() => Policy(setup.Ledger, resources: [resource, resource]));
    }

    [Fact]
    public void SiblingUsageReducesTheSameScopedAllowanceWithoutSummingOverlappingMeasurements()
    {
        var setup = Setup();
        MemoryGovernorDecision constrained = MemoryGovernor.Evaluate(setup.Policy, null, Input(setup.Ledger, 1, usage: 195));
        Assert.Equal(5, constrained.EffectiveHardCaps["host"]);
        Assert.Equal(5, constrained.Targets["host"]);
        Assert.Equal(MemoryFailure.BudgetRejected, setup.Ledger.TryReserveUnderBounds(
            [new(s_host, MemoryResourceUnit.Bytes, 6), new(s_slots, MemoryResourceUnit.OperationSlots, 1)],
            constrained.Targets, constrained.AccountingRevision).Failure);
        Assert.All(setup.Ledger.Snapshot().Used.Values, used => Assert.Equal(0, used));
    }

    [Fact]
    public void WallClockForwardJumpCannotSkipTheMonotonicRecoveryWindow()
    {
        var setup = Setup();
        MemoryGovernorDecision first = MemoryGovernor.Evaluate(setup.Policy, null, Input(setup.Ledger, 1, usage: 195));
        MemoryGovernorDecision recovering = MemoryGovernor.Evaluate(setup.Policy, first, Input(setup.Ledger, 2));
        var now = s_origin.AddHours(1);
        MemoryPressureObservation usage = new(MemoryPressureMetric.ScopedExternalUsageBytes, MemoryResourceUnit.Bytes,
            MemoryPressureScope.ExternalResourceDomain, s_host, 1, MemoryObservationState.Available, 100,
            "fixture-scoped-provider", now, 3000, 1000);
        MemoryPressureObservation limit = new(MemoryPressureMetric.ScopedExternalLimitBytes, MemoryResourceUnit.Bytes,
            MemoryPressureScope.ExternalResourceDomain, s_host, 1, MemoryObservationState.Available, 200,
            "fixture-scoped-provider", now, 3000, 1000);
        MemoryGovernorDecision jumped = MemoryGovernor.Evaluate(setup.Policy, recovering, Input(setup.Ledger, 3) with
        {
            Now = now,
            ExternalConstraints = [new("host", MemoryQualification.Qualified, usage, limit)]
        });
        Assert.Equal(MemoryGovernorState.Recovering, jumped.State);
        Assert.False(jumped.AllowGrowth);
    }

    [Fact]
    public void MissingPreviousDecisionCannotHideTheCanonicalEnforcedBound()
    {
        var setup = Setup();
        Assert.Null(setup.Ledger.ApplyGovernedBounds(1, 1, new Dictionary<string, long> { ["host"] = 20 }));
        MemoryGovernorInput input = Input(setup.Ledger, 1);
        Assert.Equal(1000, input.Accounting.HardCaps["host"]);
        Assert.Equal(20, input.Accounting.EnforcedHardCaps["host"]);
        MemoryGovernorDecision missingPolicy = MemoryGovernor.Evaluate(null, null, input);
        AssertFrozen(missingPolicy, MemoryGovernorReason.MissingPolicy);
        Assert.Equal(20, missingPolicy.EffectiveHardCaps["host"]);
        MemoryGovernorDecision missingSource = MemoryGovernor.Evaluate(setup.Policy, null, input with
        {
            ExternalConstraints = []
        });
        AssertFrozen(missingSource, MemoryGovernorReason.MissingPressure);
        Assert.Equal(20, missingSource.EffectiveHardCaps["host"]);
        MemoryGovernorDecision invalidFeedback = MemoryGovernor.Evaluate(setup.Policy, null, input with
        {
            Feedback = [new(1, "host", 1, 0, 0, 0, 0)]
        });
        AssertFrozen(invalidFeedback, MemoryGovernorReason.InvalidInput);
        Assert.Equal(20, invalidFeedback.EffectiveHardCaps["host"]);
    }

    [Fact]
    public void QualifiedRecoveryCanGrowIndependentSlotsAfterTheStableWindow()
    {
        var setup = Setup();
        MemoryGovernorDecision pressure = MemoryGovernor.Evaluate(setup.Policy, null, Input(setup.Ledger, 1, usage: 185));
        Assert.Equal(MemoryGovernorState.Pressure, pressure.State);
        Assert.Null(setup.Ledger.ApplyGovernedBounds(pressure.Sequence, 1, pressure.Targets));
        Assert.Equal(4, setup.Ledger.Snapshot().EnforcedHardCaps["slots"]);
        MemoryGovernorDecision recovering = MemoryGovernor.Evaluate(setup.Policy, pressure, Input(setup.Ledger, 2));
        Assert.Equal(MemoryGovernorState.Recovering, recovering.State);
        Assert.Equal(4, recovering.Targets["slots"]);
        Assert.Null(setup.Ledger.ApplyGovernedBounds(recovering.Sequence, 1, recovering.Targets));
        MemoryGovernorDecision stable = MemoryGovernor.Evaluate(setup.Policy, recovering, Input(setup.Ledger, 5));
        Assert.Equal(MemoryGovernorState.Normal, stable.State);
        Assert.Equal(8, stable.EffectiveHardCaps["slots"]);
        Assert.Equal(7, stable.Targets["slots"]);
        Assert.Null(setup.Ledger.ApplyGovernedBounds(stable.Sequence, 1, stable.Targets));
        Assert.Equal(7, setup.Ledger.Snapshot().EnforcedHardCaps["slots"]);
    }

    [Fact]
    public void MissingPolicyStillReportsCanonicalOverCapCommitments()
    {
        var setup = Setup();
        using MemoryReservation held = setup.Ledger.TryReserve([new(s_host, MemoryResourceUnit.Bytes, 80)]).Value!;
        setup.Ledger.ReviseLimits(2, [new(s_host, MemoryResourceUnit.Bytes, 30), new(s_slots, MemoryResourceUnit.OperationSlots, 8)]);
        MemoryGovernorDecision missing = MemoryGovernor.Evaluate(null, null, Input(setup.Ledger, 1));
        AssertFrozen(missing, MemoryGovernorReason.MissingPolicy);
        Assert.True(missing.OverTarget);
        Assert.Empty(missing.Targets);
        Assert.Equal(30, missing.EffectiveHardCaps["host"]);
        Assert.Equal(80, setup.Ledger.Snapshot().Used["host"]);
        Assert.Equal(MemoryFailure.BudgetRejected, setup.Ledger.TryReserve([new(s_host, MemoryResourceUnit.Bytes, 1)]).Failure);
    }

    [Theory]
    [InlineData(11000L, 0L)]
    [InlineData(long.MaxValue, long.MinValue)]
    public void FrozenWallClockCannotMakeMonotonicallyExpiredPressureFresh(long currentTimestamp, long sourceTimestamp)
    {
        var setup = Setup();
        MemoryGovernorInput firstInput = Input(setup.Ledger, 1);
        MemoryGovernorDecision first = MemoryGovernor.Evaluate(setup.Policy, null, firstInput);
        MemoryPressureObservation Sample(MemoryPressureMetric metric, long value)
            => new(metric, MemoryResourceUnit.Bytes, MemoryPressureScope.ExternalResourceDomain, s_host, 1,
                MemoryObservationState.Available, value, "fixture-scoped-provider", firstInput.Now, sourceTimestamp, 1000);
        MemoryGovernorDecision expired = MemoryGovernor.Evaluate(setup.Policy, first, firstInput with
        {
            Timestamp = currentTimestamp,
            ExternalConstraints = [new("host", MemoryQualification.Qualified,
                Sample(MemoryPressureMetric.ScopedExternalUsageBytes, 0),
                Sample(MemoryPressureMetric.ScopedExternalLimitBytes, 1000))]
        });
        AssertFrozen(expired, MemoryGovernorReason.StalePressure);
        Assert.Equal(first.EffectiveHardCaps["host"], expired.EffectiveHardCaps["host"]);
        Assert.Equal(first.Targets["host"], expired.Targets["host"]);
    }

    private static void AssertFrozen(MemoryGovernorDecision decision, MemoryGovernorReason reason)
    {
        Assert.Equal(MemoryGovernorState.UnmetPrerequisite, decision.State);
        Assert.Equal(reason, decision.Reason);
        Assert.False(decision.AllowGrowth);
        Assert.False(decision.AllowPromotion);
    }

    private static (MemoryReservationCoordinator Ledger, MemoryGovernorPolicy Policy) Setup()
    {
        var topology = new MemoryResourceTopology([new(s_host, "host", MemoryResourceUnit.Bytes, null),
            new(s_slots, "slots", MemoryResourceUnit.OperationSlots, null)]);
        var ledger = new MemoryReservationCoordinator(topology,
            [new(s_host, MemoryResourceUnit.Bytes, 1000), new(s_slots, MemoryResourceUnit.OperationSlots, 8)], 1, 32, 64);
        return (ledger, Policy(ledger));
    }

    private static MemoryGovernorResourcePolicy Resource() => new(s_host, 100, 60, 20, 10, 20, 40, 5, true);

    // Synthetic contract facts exercise an inactive decision function. They are not
    // baseline calibration, release qualification or production controller activation.
    private static MemoryGovernorPolicy Policy(MemoryReservationCoordinator ledger,
        MemoryQualification qualification = MemoryQualification.Qualified, IEnumerable<MemoryGovernorResourcePolicy>? resources = null)
        => new(1, 1, new(Candidate, "fixture-only", new string('0', 64), s_origin, qualification), ledger.Topology,
            resources ?? [Resource(), new(s_slots, 8, 4, 1, 0, 1, 2, 1, false)], TimeSpan.FromSeconds(10), TimeSpan.FromSeconds(3));

    private static MemoryGovernorInput Input(MemoryReservationCoordinator ledger, int seconds, long limit = 200, long usage = 100)
        => new(Candidate, 1, s_origin.AddSeconds(seconds), seconds * 1000L, 1000, ledger.Snapshot(),
            [new("host", MemoryQualification.Qualified,
                Observation(MemoryPressureMetric.ScopedExternalUsageBytes, usage, seconds),
                Observation(MemoryPressureMetric.ScopedExternalLimitBytes, limit, seconds))],
            new Dictionary<string, long>(), [], null, false);

    private static MemoryPressureObservation Observation(MemoryPressureMetric metric, long value, int seconds)
        => new(metric, MemoryResourceUnit.Bytes, MemoryPressureScope.ExternalResourceDomain, s_host, 1,
            MemoryObservationState.Available, value, "fixture-scoped-provider", s_origin.AddSeconds(seconds), seconds * 1000L, 1000);
}
