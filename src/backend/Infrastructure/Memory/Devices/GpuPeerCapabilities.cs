using FsusBlog.Server.Infrastructure.Memory.Capabilities;

namespace FsusBlog.Server.Infrastructure.Memory.Devices;

public enum GpuMappingCoherency
{
    Unknown,
    DriverSynchronized,
    Coherent
}

/// <summary>Reporting a large aperture never proves that an allocation is CPU mappable.</summary>
public sealed record GpuPeerCapabilityFacts(
    MemoryDetection LargeBar,
    MemoryDetection AllocationCpuMapping,
    GpuMappingCoherency Coherency,
    MemoryDetection PeerTransfer,
    int ApiVersion,
    string MappingReason)
{
    public static GpuPeerCapabilityFacts ClassicDeviceAllocation(int apiVersion, MemoryDetection peerTransfer)
        => new(MemoryDetection.Unknown, MemoryDetection.Unsupported, GpuMappingCoherency.Unknown,
            peerTransfer, apiVersion,
            "The classic device-allocation API provides no supported CPU mapping; use admitted DMA staging.");
}

public enum GpuPeerPath
{
    DmaStaging,
    MappedDeviceRead,
    PeerTransfer,
    RequirementFailed
}

public sealed record GpuPeerPathDecision(GpuPeerPath Path, string Reason);

/// <summary>Consumes the owning capability authority's qualifications and frozen workload result.</summary>
public static class GpuPeerPathSelection
{
    public static bool ShouldProbe(MemoryCapabilityMode mode)
        => MemoryCapabilityPolicy.Validate(mode) != MemoryCapabilityMode.Disabled;

    public static GpuPeerPathDecision Select(
        MemoryCapabilityStatus status,
        GpuPeerCapabilityFacts facts,
        GpuPeerPath candidate,
        MemoryQualification workloadQualification,
        MemoryAdmission operationAdmission,
        string workloadReason)
    {
        ArgumentNullException.ThrowIfNull(status);
        ArgumentNullException.ThrowIfNull(facts);
        MemoryCapabilityPolicy.Validate(status.Requested);
        if (candidate is not (GpuPeerPath.MappedDeviceRead or GpuPeerPath.PeerTransfer))
        {
            throw new ArgumentOutOfRangeException(nameof(candidate));
        }
        if (!Enum.IsDefined(workloadQualification) || !Enum.IsDefined(operationAdmission))
        {
            throw new ArgumentException("Qualification and admission must be defined contract values.");
        }
        string? reason = status.Requested == MemoryCapabilityMode.Disabled ? "Capability disabled."
            : facts.ApiVersion <= 0 ? "Driver API version is not verified."
            : candidate == GpuPeerPath.MappedDeviceRead && facts.AllocationCpuMapping != MemoryDetection.Present ? facts.MappingReason
            : candidate == GpuPeerPath.MappedDeviceRead && facts.Coherency is not (GpuMappingCoherency.DriverSynchronized or GpuMappingCoherency.Coherent) ? "Mapped allocation coherency is not verified."
            : candidate == GpuPeerPath.PeerTransfer && facts.PeerTransfer != MemoryDetection.Present ? "Peer support is " + facts.PeerTransfer + "."
            : status.Detection != MemoryDetection.Present ? status.Reason
            : status.ReleaseQualification != MemoryQualification.Qualified ? "Release qualification is " + status.ReleaseQualification + ". " + status.Reason
            : status.RuntimeQualification != MemoryQualification.Qualified ? "Runtime qualification is " + status.RuntimeQualification + ". " + status.Reason
            : status.OnlineState != MemoryOnlineState.Online ? "Capability is " + status.OnlineState + ". " + status.Reason
            : workloadQualification != MemoryQualification.Qualified ? "Workload qualification is " + workloadQualification + ". " + workloadReason
            : operationAdmission != MemoryAdmission.Admitted ? "Operation admission is " + operationAdmission + "."
            : null;
        return reason is null
            ? new(candidate, "Qualified workload and admitted operation.")
            : new(status.Requested == MemoryCapabilityMode.Required ? GpuPeerPath.RequirementFailed : GpuPeerPath.DmaStaging, reason);
    }
}
