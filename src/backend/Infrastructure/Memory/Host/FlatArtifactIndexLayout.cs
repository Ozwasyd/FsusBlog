using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;

using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;

namespace FsusBlog.Server.Infrastructure.Memory.Host;

/// <summary>Finite build and acquisition limits supplied by the existing admission owner.</summary>
internal sealed record FlatArtifactIndexLimits(int MaximumEntries, int MaximumKeyBytes,
    int MaximumReaders, int MaximumNativeBytes)
{
    internal bool IsValid => MaximumEntries > 0 && MaximumEntries <= int.MaxValue / 4
        && MaximumKeyBytes > 0 && MaximumKeyBytes <= 4096
        && MaximumReaders > 0 && MaximumNativeBytes > 0;
}

/// <summary>Checked process-local layout; this is never a portable disk encoding.</summary>
internal sealed class FlatArtifactIndexLayout
{
    internal const int Alignment = 8;
    internal static int DescriptorBytes => Unsafe.SizeOf<FlatArtifactDescriptor>();
    internal static int IdSlotBytes => Unsafe.SizeOf<FlatArtifactIdSlot>();
    internal static int RouteSlotBytes => Unsafe.SizeOf<FlatArtifactRouteSlot>();

    private FlatArtifactIndexLayout(int count, int slots, int idOffset, int routeOffset,
        int keyOffset, int keyBytes, MemoryAllocationLayout allocation)
    {
        Count = count;
        Slots = slots;
        IdOffset = idOffset;
        RouteOffset = routeOffset;
        KeyOffset = keyOffset;
        KeyBytes = keyBytes;
        Allocation = allocation;
    }

    internal int Count
    {
        get;
    }
    internal int Slots
    {
        get;
    }
    internal int IdOffset
    {
        get;
    }
    internal int RouteOffset
    {
        get;
    }
    internal int KeyOffset
    {
        get;
    }
    internal int KeyBytes
    {
        get;
    }
    internal MemoryAllocationLayout Allocation
    {
        get;
    }

    internal static bool IsUnmanagedRecord<T>() => !RuntimeHelpers.IsReferenceOrContainsReferences<T>();

    internal static MemoryOperationResult<FlatArtifactIndexLayout> TryPlan(int count, int keyBytes,
        FlatArtifactIndexLimits limits)
    {
        ArgumentNullException.ThrowIfNull(limits);
        if (RuntimeInformation.ProcessArchitecture is not (Architecture.X64 or Architecture.Arm64))
        {
            return MemoryOperationResult<FlatArtifactIndexLayout>.Reject(MemoryFailure.UnsupportedCapability);
        }
        if (!limits.IsValid || count < 0 || count > limits.MaximumEntries || keyBytes < 0
            || (long)keyBytes > (long)count * limits.MaximumKeyBytes
            || !IsUnmanagedRecord<FlatArtifactDescriptor>() || !IsUnmanagedRecord<FlatArtifactIdSlot>()
            || !IsUnmanagedRecord<FlatArtifactRouteSlot>() || DescriptorBytes != 104
            || IdSlotBytes != 16 || RouteSlotBytes != 16)
        {
            return MemoryOperationResult<FlatArtifactIndexLayout>.Reject(MemoryFailure.BoundsViolation);
        }
        try
        {
            int slots = 1;
            while (slots < checked(count * 2))
            {
                slots = checked(slots * 2);
            }
            int idOffset = checked(count * DescriptorBytes);
            int routeOffset = checked(idOffset + slots * IdSlotBytes);
            int keyOffset = checked(routeOffset + slots * RouteSlotBytes);
            int logical = checked(keyOffset + keyBytes);
            MemoryOperationResult<MemoryAllocationLayout> allocation = MemoryAllocationLayout.TryPlan(
                logical, 1, Alignment, limits.MaximumNativeBytes);
            return allocation.Succeeded
                ? MemoryOperationResult<FlatArtifactIndexLayout>.Success(new(count, slots, idOffset,
                    routeOffset, keyOffset, keyBytes, allocation.Value!))
                : MemoryOperationResult<FlatArtifactIndexLayout>.Reject(allocation.Failure!.Value);
        }
        catch (OverflowException)
        {
            return MemoryOperationResult<FlatArtifactIndexLayout>.Reject(MemoryFailure.BoundsViolation);
        }
    }

    internal bool Contains(int offset, int count, int elementBytes, int alignment)
        => offset >= 0 && count >= 0 && elementBytes > 0 && alignment > 0
            && (alignment & (alignment - 1)) == 0 && offset % alignment == 0
            && offset <= Allocation.LogicalBytes
            && (long)count * elementBytes <= Allocation.LogicalBytes - offset;

    internal bool ContainsKey(int offset, int length, int maximumKeyBytes)
        => offset >= 0 && length > 0 && length <= maximumKeyBytes
            && offset <= KeyBytes && length <= KeyBytes - offset;

    internal static bool TryCanonicalize(string? route, int maximumKeyBytes, out string canonical)
    {
        canonical = string.Empty;
        if (route is null || route.Length == 0 || route.Length > maximumKeyBytes)
        {
            return false;
        }
        // CORRECTNESS: Preserve the established route owner, including its non-ASCII
        // hashing and existing-path semantics. The index never defines normalization.
        canonical = PublicHotReadRouteKeys.HtmlPath(route);
        return Encoding.UTF8.GetByteCount(canonical) <= maximumKeyBytes;
    }

    internal static uint RouteHash(ReadOnlySpan<byte> key)
    {
        uint hash = 2166136261;
        foreach (byte value in key)
        {
            hash = unchecked((hash ^ value) * 16777619);
        }
        return hash;
    }
}

internal readonly record struct FlatArtifactIdSlot(long Id, int Record, int Reserved);
internal readonly record struct FlatArtifactRouteSlot(uint Hash, int Record, int Offset, int Length);
