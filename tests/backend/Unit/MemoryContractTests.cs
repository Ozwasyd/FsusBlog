using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;

namespace FsusBlog.Server.Tests.Unit;

public sealed class MemoryContractTests
{
    [Fact]
    public void ResidencyAndDeviceChangesDoNotReviveAReusedContentLocation()
    {
        var content = new MemoryContentIdentity(new(Guid.NewGuid()), new(7), new(Guid.NewGuid()));
        var location = new MemoryLocationToken(new(Guid.NewGuid()), new(Guid.NewGuid()), new(3), new(11));
        content.Validate();
        location.Validate();
        MemoryLocationToken moved = location with
        {
            Revision = new(4)
        };
        MemoryLocationToken recycledDevice = location with
        {
            Epoch = new(12)
        };
        Assert.False(location.IsCurrent(moved));
        Assert.False(location.IsCurrent(recycledDevice));
        Assert.True(location.IsCurrent(location));
        Assert.Equal(new ContentGeneration(7), content.Generation);
        Assert.Throws<ArgumentException>(() => default(MemoryLocationToken).IsCurrent(location));
        Assert.Throws<ArgumentException>(() => default(MemoryContentIdentity).Validate());
    }

    [Fact]
    public void OmissionNormalizesToAutoAndAmbiguousOrNumericSettingsAreRejected()
    {
        Assert.Equal(0, (int)MemoryCapabilityMode.Auto);
        Assert.Equal(MemoryCapabilityPolicy.Parse("Auto"), MemoryCapabilityPolicy.Parse(null));
        Assert.Equal(MemoryCapabilityMode.Auto, default(MemoryCapabilityMode));
        foreach (string invalid in new[] { "Preferred", "auto", " Auto", "", "0", "3", "EnableGpu" })
        {
            Assert.Throws<ArgumentException>(() => MemoryCapabilityPolicy.Parse(invalid));
        }
        Assert.Throws<ArgumentOutOfRangeException>(() => MemoryCapabilityPolicy.Validate((MemoryCapabilityMode)3));
    }

    [Fact]
    public void RevisionCopiesInputsAndReportsRequiredChildDisabledParentConflict()
    {
        var settings = new Dictionary<string, MemoryCapabilityMode>
        {
            ["mapping"] = MemoryCapabilityMode.Required,
            ["gpu"] = MemoryCapabilityMode.Disabled
        };
        var revision = new MemoryCapabilityPolicyRevision(1, settings);
        settings["gpu"] = MemoryCapabilityMode.Auto;
        Assert.True(revision.HasRequiredDependencyConflict("mapping", "gpu"));
        Assert.Equal(MemoryCapabilityMode.Auto, revision.Requested("host"));
        Assert.Throws<ArgumentOutOfRangeException>(() => new MemoryCapabilityPolicyRevision(0, settings));
        settings["gpu"] = (MemoryCapabilityMode)42;
        Assert.Throws<ArgumentOutOfRangeException>(() => new MemoryCapabilityPolicyRevision(2, settings));
        Assert.Equal(MemoryCapabilityMode.Disabled, revision.Requested("gpu"));
    }

    [Fact]
    public void AliasedUmaLockedSubsetsAndSharedVolumePathsCannotAddCapacity()
    {
        var host = new ResourceDomainId(Guid.NewGuid());
        var uma = new ResourceDomainId(Guid.NewGuid());
        var locked = new ResourceDomainId(Guid.NewGuid());
        var volumeA = new ResourceDomainId(Guid.NewGuid());
        var volumeB = new ResourceDomainId(Guid.NewGuid());
        var topology = new MemoryResourceTopology([
            new(host, "host-physical", MemoryResourceUnit.Bytes, null),
            new(uma, "host-physical", MemoryResourceUnit.Bytes, null),
            new(locked, "locked-quota", MemoryResourceUnit.Bytes, host),
            new(volumeA, "volume-device-1", MemoryResourceUnit.Bytes, null),
            new(volumeB, "volume-device-1", MemoryResourceUnit.Bytes, null)
        ]);
        Assert.True(topology.SharesCapacityOrContainment(host, uma));
        Assert.True(topology.SharesCapacityOrContainment(host, locked));
        Assert.True(topology.SharesCapacityOrContainment(volumeA, volumeB));
        Assert.Throws<ArgumentException>(() => new MemoryResourceTopology([
            new(host, "host-physical", MemoryResourceUnit.Bytes, locked),
            new(locked, "locked-quota", MemoryResourceUnit.Bytes, host)
        ]));
        Assert.Throws<ArgumentException>(() => new MemoryResourceTopology([
            new(host, "host-physical", MemoryResourceUnit.Bytes, null),
            new(uma, "host-physical", MemoryResourceUnit.OperationSlots, null)
        ]));
    }

    [Fact]
    public void MissingDeniedMalformedAndStaleSamplesKeepUnknownValueAndSource()
    {
        var domain = new ResourceDomainId(Guid.NewGuid());
        DateTimeOffset time = DateTimeOffset.UtcNow;
        foreach (MemoryObservationState state in new[] { MemoryObservationState.Unknown, MemoryObservationState.Denied,
            MemoryObservationState.Malformed, MemoryObservationState.Stale })
        {
            var sample = new MemoryResourceObservation(domain, MemoryResourceUnit.Bytes, state, null, "fixture:host", time);
            Assert.Null(sample.Value);
            Assert.Equal(state, sample.State);
            Assert.Equal("fixture:host", sample.Source);
            Assert.Equal(time, sample.SampledAt);
            Assert.Throws<ArgumentException>(() => new MemoryResourceObservation(domain,
                MemoryResourceUnit.Bytes, state, 0, "fixture:host", time));
        }
        var zero = new MemoryResourceObservation(domain, MemoryResourceUnit.Bytes,
            MemoryObservationState.Available, 0, "fixture:known-empty", time);
        Assert.Equal(0, zero.Value);
        Assert.Throws<ArgumentException>(() => new MemoryResourceObservation(domain,
            MemoryResourceUnit.Bytes, MemoryObservationState.Available, null, "fixture:host", time));
    }

    [Fact]
    public void ExpectedRejectionRemainsDistinctFromCorrectnessFailureAndDeviceLoss()
    {
        MemoryOperationResult<object> rejection = MemoryOperationResult<object>.Reject(MemoryFailure.BudgetRejected);
        Assert.False(rejection.Succeeded);
        Assert.False(rejection.IsCorrectnessFailure);
        Assert.Null(rejection.Value);
        Assert.Equal(MemoryOwnerDisposition.RetainOriginal, rejection.Disposition);
        foreach (MemoryFailure failure in new[] { MemoryFailure.OwnershipViolation, MemoryFailure.BoundsViolation,
            MemoryFailure.StaleLocation, MemoryFailure.Corruption })
        {
            Assert.True(MemoryOperationResult<object>.Reject(failure).IsCorrectnessFailure);
        }
        Assert.Equal(MemoryOwnerDisposition.RetireFaultedOwner,
            MemoryOperationResult<object>.Reject(MemoryFailure.DeviceLost).Disposition);
        Assert.Throws<ArgumentOutOfRangeException>(() => MemoryOperationResult<object>.Reject((MemoryFailure)99));
        Assert.Throws<ArgumentNullException>(() => MemoryOperationResult<object>.Success(null!));
        Assert.True(MemoryOperationResult<object>.Success(new object()).Succeeded);
    }
}
