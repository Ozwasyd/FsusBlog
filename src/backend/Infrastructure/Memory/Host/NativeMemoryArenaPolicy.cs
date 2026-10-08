using System.Runtime.InteropServices;

using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;

namespace FsusBlog.Server.Infrastructure.Memory.Host;

/// <summary>
/// Finite source policy supplied by the workload owner. Construction validates
/// arithmetic; it does not certify workload calibration or authorize activation.
/// </summary>
public sealed class NativeMemoryArenaPolicy
{
    public NativeMemoryArenaPolicy(int blockCapacity, int maximumOversizedCapacity,
        long maximumArenaCapacity, int maximumBlocks, int maximumSlices, int holdLimit, int alignment = 1)
    {
        if (blockCapacity <= 0 || maximumOversizedCapacity < blockCapacity || maximumArenaCapacity < blockCapacity
            || maximumBlocks <= 0 || maximumSlices <= 0 || holdLimit <= 0 || alignment <= 0
            || (alignment & (alignment - 1)) != 0 || (alignment != 1 && alignment < IntPtr.Size)
            || blockCapacity % alignment != 0 || maximumOversizedCapacity % alignment != 0)
        {
            throw new ArgumentOutOfRangeException(nameof(blockCapacity), "Native policy requires finite compatible bounds.");
        }
        BlockCapacity = blockCapacity;
        MaximumOversizedCapacity = maximumOversizedCapacity;
        MaximumArenaCapacity = maximumArenaCapacity;
        MaximumBlocks = maximumBlocks;
        MaximumSlices = maximumSlices;
        HoldLimit = holdLimit;
        Alignment = alignment;
    }

    public int BlockCapacity
    {
        get;
    }
    public int MaximumOversizedCapacity
    {
        get;
    }
    public long MaximumArenaCapacity
    {
        get;
    }
    public int MaximumBlocks
    {
        get;
    }
    public int MaximumSlices
    {
        get;
    }
    public int HoldLimit
    {
        get;
    }
    public int Alignment
    {
        get;
    }

    internal MemoryOperationResult<MemoryAllocationLayout> Plan(long logicalBytes)
    {
        MemoryOperationResult<MemoryAllocationLayout> rounded = MemoryAllocationLayout.TryPlan(
            logicalBytes, 1, Alignment, MaximumOversizedCapacity);
        return !rounded.Succeeded || rounded.Value!.CapacityBytes > BlockCapacity
            ? rounded
            : MemoryAllocationLayout.TryCreate(logicalBytes, BlockCapacity, Alignment);
    }
}

/// <summary>Discovery inputs for the existing capability authority; no allocator is invoked.</summary>
public sealed record NativeMemoryBackendDiscovery(MemoryCapabilityStatus Status, string Framework, Architecture Architecture)
{
    public static NativeMemoryBackendDiscovery Discover(MemoryCapabilityPolicyRevision policy)
    {
        ArgumentNullException.ThrowIfNull(policy);
        MemoryCapabilityMode mode = policy.Requested("NativeMemory");
        bool disabled = mode == MemoryCapabilityMode.Disabled;
        return new(new MemoryCapabilityStatus("NativeMemory", policy.Revision, mode,
            disabled ? MemoryDetection.Unknown : MemoryDetection.Present,
            MemoryQualification.NotVerified, MemoryQualification.NotVerified,
            disabled ? MemoryOnlineState.Disabled : MemoryOnlineState.Offline, null,
            MemoryAdmission.NotEvaluated,
            disabled ? "Discovery and use disabled by the capability owner."
                : "BCL allocator source available; target release and bounded runtime qualification remain required."),
            RuntimeInformation.FrameworkDescription, RuntimeInformation.ProcessArchitecture);
    }
}
