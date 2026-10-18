using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Devices;

using Xunit;

namespace FsusBlog.Server.Tests.Unit;

public sealed class GpuPeerCapabilitiesTests
{
    [Fact]
    public void LargeBarReportingDoesNotSupplyCpuMapping()
    {
        GpuPeerCapabilityFacts facts = GpuPeerCapabilityFacts.ClassicDeviceAllocation(12000, MemoryDetection.Present)
            with
        {
            LargeBar = MemoryDetection.Present
        };
        Assert.Equal(MemoryDetection.Unsupported, facts.AllocationCpuMapping);
        Assert.Equal(GpuMappingCoherency.Unknown, facts.Coherency);
        Assert.Equal(MemoryDetection.Present, facts.PeerTransfer);
        Assert.Contains("DMA staging", facts.MappingReason);
        Assert.Equal(GpuPeerPath.DmaStaging, GpuPeerPathSelection.Select(Qualified(MemoryCapabilityMode.Auto),
            facts, GpuPeerPath.MappedDeviceRead, MemoryQualification.Qualified, MemoryAdmission.Admitted, "qualified").Path);
        Assert.Equal(GpuPeerPath.RequirementFailed, GpuPeerPathSelection.Select(Qualified(MemoryCapabilityMode.Required),
            facts, GpuPeerPath.MappedDeviceRead, MemoryQualification.Qualified, MemoryAdmission.Admitted, "qualified").Path);
    }

    [Theory]
    [InlineData(GpuPeerPath.MappedDeviceRead)]
    [InlineData(GpuPeerPath.PeerTransfer)]
    public void OmittedAutoSelectsQualifiedAdmittedWorkload(GpuPeerPath path)
    {
        var revision = new MemoryCapabilityPolicyRevision(1, new Dictionary<string, MemoryCapabilityMode>());
        MemoryCapabilityStatus status = Qualified(revision.Requested("gpu.peer"));
        Assert.Equal(path, GpuPeerPathSelection.Select(status, Supported(), path,
            MemoryQualification.Qualified, MemoryAdmission.Admitted, "frozen owner rule").Path);
    }

    [Theory]
    [InlineData(MemoryQualification.NotVerified)]
    [InlineData(MemoryQualification.Rejected)]
    public void UnqualifiedWorkloadFallsBackAndRequiredFails(MemoryQualification qualification)
    {
        GpuPeerPathDecision automatic = GpuPeerPathSelection.Select(Qualified(MemoryCapabilityMode.Auto), Supported(),
            GpuPeerPath.PeerTransfer, qualification, MemoryAdmission.Admitted, "tail latency gate failed");
        Assert.Equal(GpuPeerPath.DmaStaging, automatic.Path);
        Assert.Contains("tail latency gate failed", automatic.Reason);
        Assert.Equal(GpuPeerPath.RequirementFailed, GpuPeerPathSelection.Select(Qualified(MemoryCapabilityMode.Required), Supported(),
            GpuPeerPath.PeerTransfer, qualification, MemoryAdmission.Admitted, "frozen owner rule").Path);
    }

    [Fact]
    public void DisabledSkipsProbeAndDoesNotSelectEvenQualifiedPath()
    {
        Assert.False(GpuPeerPathSelection.ShouldProbe(MemoryCapabilityMode.Disabled));
        Assert.Equal(GpuPeerPath.DmaStaging, GpuPeerPathSelection.Select(Qualified(MemoryCapabilityMode.Disabled), Supported(),
            GpuPeerPath.MappedDeviceRead, MemoryQualification.Qualified, MemoryAdmission.Admitted, "qualified").Path);
    }

    [Fact]
    public void PresentMappingWithUnknownCoherencyDoesNotSelect()
    {
        var facts = Supported() with
        {
            Coherency = GpuMappingCoherency.Unknown
        };
        var decision = GpuPeerPathSelection.Select(Qualified(MemoryCapabilityMode.Auto), facts,
            GpuPeerPath.MappedDeviceRead, MemoryQualification.Qualified, MemoryAdmission.Admitted, "qualified");
        Assert.Equal(GpuPeerPath.DmaStaging, decision.Path);
        Assert.Contains("coherency", decision.Reason);
    }

    [Theory]
    [InlineData(MemoryAdmission.BudgetRejected)]
    [InlineData(MemoryAdmission.Ineligible)]
    [InlineData(MemoryAdmission.Cancelled)]
    [InlineData(MemoryAdmission.NotEvaluated)]
    public void RejectedAdmissionNeverSelectsCandidate(MemoryAdmission admission)
    {
        var decision = GpuPeerPathSelection.Select(Qualified(MemoryCapabilityMode.Auto), Supported(), GpuPeerPath.PeerTransfer,
            MemoryQualification.Qualified, admission, "qualified");
        Assert.Equal(GpuPeerPath.DmaStaging, decision.Path);
        Assert.Contains(admission.ToString(), decision.Reason);
    }

    [Fact]
    public void NotVerifiedRuntimeAndUnsupportedArchitectureRemainDifferentReasons()
    {
        var unavailable = Qualified(MemoryCapabilityMode.Auto) with
        {
            RuntimeQualification = MemoryQualification.NotVerified,
            Reason = "No local GPU hardware."
        };
        var unsupported = Qualified(MemoryCapabilityMode.Auto) with
        {
            Detection = MemoryDetection.Unsupported,
            Reason = "The installed driver has no mapping API."
        };
        Assert.Contains("NotVerified", GpuPeerPathSelection.Select(unavailable, Supported(), GpuPeerPath.PeerTransfer,
            MemoryQualification.Qualified, MemoryAdmission.Admitted, "qualified").Reason);
        Assert.Contains("no mapping API", GpuPeerPathSelection.Select(unsupported, Supported(), GpuPeerPath.MappedDeviceRead,
            MemoryQualification.Qualified, MemoryAdmission.Admitted, "qualified").Reason);
    }

    private static GpuPeerCapabilityFacts Supported()
        => new(MemoryDetection.Unknown, MemoryDetection.Present, GpuMappingCoherency.DriverSynchronized,
            MemoryDetection.Present, 12000, "supported test mapping API");

    private static MemoryCapabilityStatus Qualified(MemoryCapabilityMode mode)
        => new("gpu.peer", 1, mode, MemoryDetection.Present, MemoryQualification.Qualified,
            MemoryQualification.Qualified, MemoryOnlineState.Online, "CUDA peer", MemoryAdmission.NotEvaluated, "available");
}
