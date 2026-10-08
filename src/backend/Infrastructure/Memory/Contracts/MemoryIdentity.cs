namespace FsusBlog.Server.Infrastructure.Memory.Contracts;

// OWNERSHIP: Content identity survives residency changes; addresses never identify an owner.
public readonly record struct BlobId(Guid Value);
public readonly record struct AllocationId(Guid Value);
public readonly record struct BlockId(Guid Value);
public readonly record struct ContentGeneration(ulong Value);
public readonly record struct RepresentationId(Guid Value);
public readonly record struct ResidencyRevision(ulong Value);
public readonly record struct DeviceEpoch(ulong Value);

public readonly record struct MemoryContentIdentity(BlobId Blob, ContentGeneration Generation, RepresentationId Representation)
{
    public void Validate()
    {
        if (Blob.Value == Guid.Empty || Generation.Value == 0 || Representation.Value == Guid.Empty)
        {
            throw new ArgumentException("Content identity requires nonempty IDs and a positive generation.");
        }
    }
}

public readonly record struct MemoryLocationToken(AllocationId Allocation, BlockId Block, ResidencyRevision Revision, DeviceEpoch Epoch)
{
    public void Validate()
    {
        if (Allocation.Value == Guid.Empty || Block.Value == Guid.Empty || Revision.Value == 0 || Epoch.Value == 0)
        {
            throw new ArgumentException("Location identity requires nonempty IDs and positive revision/epoch.");
        }
    }

    public bool IsCurrent(MemoryLocationToken current)
    {
        Validate();
        current.Validate();
        return this == current;
    }
}
