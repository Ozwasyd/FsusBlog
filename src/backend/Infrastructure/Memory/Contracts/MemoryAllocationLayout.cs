namespace FsusBlog.Server.Infrastructure.Memory.Contracts;

// ACCOUNTING: Logical bytes, alignment padding and retained backing slack are
// separate observations. This arithmetic contract never calls an allocator.
public sealed class MemoryAllocationLayout
{
    private MemoryAllocationLayout(long logicalBytes, long alignedBytes, long capacityBytes, long alignmentBytes)
    {
        LogicalBytes = logicalBytes;
        AlignedBytes = alignedBytes;
        CapacityBytes = capacityBytes;
        AlignmentBytes = alignmentBytes;
    }

    public long LogicalBytes
    {
        get;
    }
    public long AlignedBytes
    {
        get;
    }
    public long CapacityBytes
    {
        get;
    }
    public long AlignmentBytes
    {
        get;
    }
    public long AlignmentSlack => AlignedBytes - LogicalBytes;
    public long RetainedSlack => CapacityBytes - AlignedBytes;

    public static MemoryOperationResult<MemoryAllocationLayout> TryCreate(long logicalBytes,
        long capacityBytes, long alignmentBytes)
    {
        if (logicalBytes < 0 || capacityBytes <= 0 || alignmentBytes <= 0
            || (alignmentBytes & (alignmentBytes - 1)) != 0
            || capacityBytes % alignmentBytes != 0)
        {
            return MemoryOperationResult<MemoryAllocationLayout>.Reject(MemoryFailure.BoundsViolation);
        }
        long aligned;
        try
        {
            aligned = checked(logicalBytes + (alignmentBytes - 1)) & ~(alignmentBytes - 1);
        }
        catch (OverflowException)
        {
            return MemoryOperationResult<MemoryAllocationLayout>.Reject(MemoryFailure.BoundsViolation);
        }
        if (aligned > capacityBytes)
        {
            return MemoryOperationResult<MemoryAllocationLayout>.Reject(MemoryFailure.BoundsViolation);
        }
        return MemoryOperationResult<MemoryAllocationLayout>.Success(
            new MemoryAllocationLayout(logicalBytes, aligned, capacityBytes, alignmentBytes));
    }

    public static MemoryOperationResult<MemoryAllocationLayout> TryPlan(long count, long elementBytes,
        long alignmentBytes, long maximumCapacity)
    {
        if (count <= 0 || elementBytes <= 0 || maximumCapacity <= 0 || alignmentBytes <= 0
            || (alignmentBytes & (alignmentBytes - 1)) != 0)
        {
            return MemoryOperationResult<MemoryAllocationLayout>.Reject(MemoryFailure.BoundsViolation);
        }
        long logical;
        long capacity;
        try
        {
            logical = checked(count * elementBytes);
            capacity = checked(logical + (alignmentBytes - 1)) & ~(alignmentBytes - 1);
        }
        catch (OverflowException)
        {
            return MemoryOperationResult<MemoryAllocationLayout>.Reject(MemoryFailure.BoundsViolation);
        }
        return capacity > maximumCapacity
            ? MemoryOperationResult<MemoryAllocationLayout>.Reject(MemoryFailure.BoundsViolation)
            : TryCreate(logical, capacity, alignmentBytes);
    }
}

// OWNERSHIP: A physical descriptor belongs to one charge. Content generations,
// roles, slices and pins reference that owner without registering another charge.
public sealed class MemoryAllocationDescriptor
{
    public MemoryAllocationDescriptor(AllocationId allocation, ResourceDomainId domain, MemoryAllocationLayout layout)
    {
        ArgumentNullException.ThrowIfNull(layout);
        if (allocation.Value == Guid.Empty || domain.Value == Guid.Empty)
        {
            throw new ArgumentException("A physical descriptor requires an allocation and resource domain.");
        }
        Allocation = allocation;
        Domain = domain;
        Layout = layout;
    }

    public AllocationId Allocation
    {
        get;
    }
    public ResourceDomainId Domain
    {
        get;
    }
    public MemoryAllocationLayout Layout
    {
        get;
    }
}
