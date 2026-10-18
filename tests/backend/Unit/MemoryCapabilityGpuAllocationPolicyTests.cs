using FsusBlog.Server.Infrastructure.Memory.Accounting;
using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Devices;
using FsusBlog.Server.Infrastructure.Memory.Platform;

namespace FsusBlog.Server.Tests.Unit;

// Controlled observations exercise the actual GPU owner and common accounting.
// They do not qualify Metal, hardware, or production physical upper bounds.
public sealed class MemoryCapabilityGpuAllocationPolicyTests
{
    [Fact]
    public async Task FrozenPolicySuppliesExplicitBoundsAndOwnerCommitsActualObservation()
    {
        var fixture = new Fixture();
        var policy = fixture.Policy();
        GpuMemoryLimits limits = policy.TryGetLimits(fixture.Context, fixture.Ledger).Value!;
        Assert.Equal(32, limits.MaximumObservedDeviceCapacityBytes);
        Assert.Equal(32, limits.MaximumObservedStagingCapacityBytes);
        var driver = new ObservingDriver(32);
        using var owner = fixture.Owner(driver, limits);
        var allocated = owner.TryAllocate(new(new(Guid.NewGuid()), new(1), new(Guid.NewGuid())), 4, new(1));
        Assert.True(allocated.Succeeded);
        Assert.Equal(4, driver.RequestedBytes);
        Assert.Equal(32, Assert.Single(fixture.Ledger.Allocations()).Descriptor!.Layout.CapacityBytes);
        Assert.Equal(32, fixture.Ledger.Snapshot().Used["host"]);
        allocated.Value!.Dispose();
        MemoryCapabilityOwner lifecycle = MemoryCapabilityOwner.FromGpu(owner);
        lifecycle.BeginRetirement();
        await lifecycle.Drained;
        Assert.Equal(1, driver.FreeCalls);
        Assert.All(fixture.Ledger.Snapshot().Used.Values, used => Assert.Equal(0, used));
    }

    [Theory]
    [InlineData(null, 32L)]
    [InlineData(32L, null)]
    public void MissingOwnerDeclaredBoundNeverFallsBackToLogicalBytes(long? device, long? staging)
    {
        var fixture = new Fixture();
        var bound = fixture.Bound with
        {
            Limits = fixture.Bound.Limits with
            {
                MaximumObservedDeviceCapacityBytes = device,
                MaximumObservedStagingCapacityBytes = staging
            }
        };
        Assert.Equal(MemoryFailure.TierUnavailable, fixture.Policy(bound).TryGetLimits(fixture.Context, fixture.Ledger).Failure);
        Assert.Equal(MemoryFailure.TierUnavailable,
            new MemoryCapabilityGpuAllocationPolicy(null).TryGetLimits(fixture.Context, fixture.Ledger).Failure);
        Assert.Empty(fixture.Ledger.Allocations());
        Assert.Equal(0, fixture.Ledger.Snapshot().Reservations);
    }

    [Fact]
    public void StaleIdentityRevisionAndMonotonicExpiryCannotReusePolicyInputs()
    {
        var fixture = new Fixture();
        var policy = fixture.Policy();
        Assert.Equal(MemoryFailure.StaleLocation,
            policy.TryGetLimits(fixture.Context with
            {
                PolicyRevision = 2
            }, fixture.Ledger).Failure);
        Assert.Equal(MemoryFailure.StaleLocation,
            policy.TryGetLimits(fixture.Context with
            {
                Identity = fixture.Context.Identity with
                {
                    Epoch = new(2)
                }
            }, fixture.Ledger).Failure);
        Assert.Equal(MemoryFailure.StaleLocation,
            policy.TryGetLimits(fixture.Context with
            {
                Identity = fixture.Context.Identity with
                {
                    IdentityDigest = "other-driver"
                }
            }, fixture.Ledger).Failure);
        fixture.Clock.AdvanceMonotonic(TimeSpan.FromMinutes(1));
        fixture.Clock.Utc -= TimeSpan.FromHours(1);
        Assert.Equal(MemoryFailure.TierUnavailable, policy.TryGetLimits(fixture.Context, fixture.Ledger).Failure);
        Assert.Empty(fixture.Ledger.Allocations());
    }

    [Fact]
    public void SharedHostAndParentCapsCannotSpendDeviceAndStagingBoundsIndependently()
    {
        var fixture = new Fixture();
        Assert.Null(fixture.Ledger.ApplyGovernedBounds(1, 7, new Dictionary<string, long> { ["host"] = 63 }));
        Assert.Equal(MemoryFailure.BudgetRejected, fixture.Policy().TryGetLimits(fixture.Context, fixture.Ledger).Failure);
        Assert.Empty(fixture.Ledger.Allocations());
        Assert.Equal(0, fixture.Ledger.Snapshot().Reservations);
    }

    [Fact]
    public async Task PressureAfterPolicyResolutionStillRejectsBeforeDriverAllocation()
    {
        var fixture = new Fixture();
        GpuMemoryLimits limits = fixture.Policy().TryGetLimits(fixture.Context, fixture.Ledger).Value!;
        Assert.Null(fixture.Ledger.ApplyGovernedBounds(1, 7, new Dictionary<string, long> { ["host"] = 31 }));
        var driver = new ObservingDriver(32);
        using var owner = fixture.Owner(driver, limits);
        Assert.Equal(MemoryFailure.BudgetRejected,
            owner.TryAllocate(new(new(Guid.NewGuid()), new(1), new(Guid.NewGuid())), 4, new(1)).Failure);
        Assert.Equal(0, driver.AllocateCalls);
        owner.Dispose();
        await owner.Drained;
        Assert.All(fixture.Ledger.Snapshot().Used.Values, used => Assert.Equal(0, used));
    }

    [Theory]
    [InlineData(null, MemoryFailure.UnsupportedCapability)]
    [InlineData(2UL, MemoryFailure.BoundsViolation)]
    [InlineData(64UL, MemoryFailure.BudgetRejected)]
    public async Task InvalidObservationDoesNotCommitRequestOrEraseTheOriginalNegativeControl(ulong? observed, MemoryFailure expected)
    {
        var fixture = new Fixture();
        var driver = new ObservingDriver(observed);
        using var owner = fixture.Owner(driver, fixture.Policy().TryGetLimits(fixture.Context, fixture.Ledger).Value!);
        Assert.Equal(expected, owner.TryAllocate(new(new(Guid.NewGuid()), new(1), new(Guid.NewGuid())), 4, new(1)).Failure);
        Assert.Equal(1, driver.FreeCalls);
        Assert.Empty(fixture.Ledger.Allocations());
        Assert.Equal(0, fixture.Ledger.Snapshot().Reservations);
        owner.Dispose();
        await owner.Drained;
    }

    [Fact]
    public void InvalidDeclaredBoundsAreRejectedBeforePolicyUse()
    {
        var fixture = new Fixture();
        Assert.Throws<ArgumentException>(() => fixture.Policy(fixture.Bound with
        {
            Limits = fixture.Bound.Limits with
            {
                MaximumObservedDeviceCapacityBytes = 3
            }
        }));
        Assert.Throws<ArgumentException>(() => fixture.Policy(fixture.Bound with { ValidUntil = DateTimeOffset.MaxValue }));
    }

    private sealed class Fixture
    {
        public FixtureClock Clock { get; } = new();
        public MemoryReservationCoordinator Ledger
        {
            get;
        }
        public MemoryCapabilityProbeContext Context
        {
            get;
        }
        public MemoryCapabilityGpuAllocationBound Bound
        {
            get;
        }
        public Fixture()
        {
            ResourceDomainId host = new(Guid.NewGuid());
            ResourceDomainId device = new(Guid.NewGuid());
            ResourceDomainId staging = new(Guid.NewGuid());
            ResourceDomainId slots = new(Guid.NewGuid());
            var topology = new MemoryResourceTopology([new(host, "host", MemoryResourceUnit.Bytes, null),
                new(device, "device", MemoryResourceUnit.Bytes, host), new(staging, "staging", MemoryResourceUnit.Bytes, host),
                new(slots, "slots", MemoryResourceUnit.OperationSlots, null)]);
            Ledger = new(topology, [new(host, MemoryResourceUnit.Bytes, 128), new(device, MemoryResourceUnit.Bytes, 64),
                new(staging, MemoryResourceUnit.Bytes, 64), new(slots, MemoryResourceUnit.OperationSlots, 4)], 7, 16, 32);
            Context = new("controlled-gpu", 1, 1, new(new string('a', 64), new(1)));
            Bound = new(Context.CapabilityId, 1, 7, Context.Identity, new(device, staging, slots), new(4, 8, 4, 4, 4)
            {
                MaximumObservedDeviceCapacityBytes = 32,
                MaximumObservedStagingCapacityBytes = 32
            }, Clock.Utc.AddMinutes(1));
        }
        public MemoryCapabilityGpuAllocationPolicy Policy(MemoryCapabilityGpuAllocationBound? bound = null)
            => new(bound ?? Bound, Clock);
        public GpuMemoryDevice Owner(IGpuDriverSession driver, GpuMemoryLimits limits)
            => new(driver, Ledger, Bound.Domains, limits, Context.Identity.Epoch,
                new(Context.CapabilityId, 1, MemoryCapabilityMode.Auto, MemoryDetection.Present,
                    MemoryQualification.Qualified, MemoryQualification.Qualified, MemoryOnlineState.Online,
                    "controlled-fixture", MemoryAdmission.Admitted, "fixture only, not hardware qualification"));
    }

    private sealed class FixtureClock : TimeProvider
    {
        private long _timestamp;
        public DateTimeOffset Utc { get; set; } = new(2026, 10, 8, 0, 0, 0, TimeSpan.Zero);
        public override DateTimeOffset GetUtcNow() => Utc;
        public override long GetTimestamp() => _timestamp;
        public override long TimestampFrequency => TimeSpan.TicksPerSecond;
        public void AdvanceMonotonic(TimeSpan duration) => _timestamp += duration.Ticks;
    }

    private sealed class ObservingDriver(ulong? observed) : IGpuDriverSession, IGpuMetalAllocationObservation
    {
        public GpuDeviceIdentity Identity { get; } = new("controlled", "controlled", "controlled", 1, true);
        public int AllocateCalls
        {
            get; private set;
        }
        public int FreeCalls
        {
            get; private set;
        }
        public long RequestedBytes
        {
            get; private set;
        }
        public GpuDeviceAddress AllocateDevice(long bytes)
        {
            RequestedBytes = bytes;
            AllocateCalls++;
            return new(1);
        }
        public ulong? ObservedDeviceCapacity(GpuDeviceAddress address) => observed;
        public ulong? ObservedHostCapacity(GpuHostAddress address) => throw new NotSupportedException();
        public void FreeDevice(GpuDeviceAddress address) => FreeCalls++;
        public GpuHostAddress AllocateHost(long bytes, bool cpuReadback) => throw new NotSupportedException();
        public void FreeHost(GpuHostAddress address) => throw new NotSupportedException();
        public void WriteHost(GpuHostAddress address, ReadOnlySpan<byte> source) => throw new NotSupportedException();
        public void ReadHost(GpuHostAddress address, Span<byte> destination) => throw new NotSupportedException();
        public GpuSubmission SubmitUpload(GpuHostAddress source, GpuDeviceAddress destination, long bytes) => throw new NotSupportedException();
        public GpuSubmission SubmitReadback(GpuDeviceAddress source, GpuHostAddress destination, long bytes) => throw new NotSupportedException();
        public GpuCompletion Query(GpuSubmission submission) => throw new NotSupportedException();
        public void ReleaseSubmission(GpuSubmission submission) => throw new NotSupportedException();
        public void Dispose()
        {
        }
    }
}
