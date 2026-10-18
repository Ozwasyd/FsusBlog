namespace FsusBlog.Server.Infrastructure.Memory.Contracts;

public sealed record MemoryResourceCharge(ResourceDomainId Domain, MemoryResourceUnit Unit, long Amount);

// ADMISSION: The allocation caller owns a reservation until commit transfers its charge.
public interface IMemoryReservation : IDisposable
{
    IReadOnlyList<MemoryResourceCharge> Reserved
    {
        get;
    }
    MemoryOperationResult<IMemoryAllocationCharge> Commit(AllocationId allocation, IReadOnlyList<MemoryResourceCharge> actualCharges);
    MemoryOperationResult<IMemoryAllocationCharge> CommitPhysical(MemoryAllocationDescriptor descriptor, IReadOnlyList<MemoryResourceCharge> actualCharges);
}

// OWNERSHIP: Only the backing owner's final role/read/pin/operation release disposes this charge.
public interface IMemoryAllocationCharge : IDisposable
{
    AllocationId Allocation
    {
        get;
    }
    // Null means resource/operation accounting without a verified physical layout.
    MemoryAllocationDescriptor? Descriptor
    {
        get;
    }
    IReadOnlyList<MemoryResourceCharge> ActualCharges
    {
        get;
    }
}

// OWNERSHIP: A host lease exposes only already CPU-readable storage. Access must have
// no disk, mapping, driver, qualification or transfer side effects. Captured Memory
// must reject access after lease disposal; it is not an owning transferable handle.
public interface IMemoryHostReadLease : IDisposable
{
    MemoryContentIdentity Content
    {
        get;
    }
    MemoryLocationToken Location
    {
        get;
    }
    ReadOnlyMemory<byte> Memory
    {
        get;
    }
}

public interface IMemoryHostViewSource
{
    MemoryOperationResult<IMemoryHostReadLease> TryAcquireHostView(MemoryLocationToken expectedLocation);
}

// MATERIALIZATION: Non-host tiers require this explicit asynchronous operation and
// operation-owned admission/staging; their numeric locations are never CPU pointers.
public interface IMemoryMaterializer
{
    ValueTask<MemoryOperationResult<IMemoryHostReadLease>> MaterializeAsync(
        MemoryContentIdentity content,
        MemoryLocationToken location,
        CancellationToken cancellationToken);
}
