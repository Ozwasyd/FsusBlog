namespace FsusBlog.Server.Infrastructure.Memory.Disk;

/// <summary>A descriptor-bound observation, not a reservation or total filesystem metadata bound.</summary>
public sealed record DiskFileFootprint(string CapacityIdentity, ulong Inode, long LogicalBytes,
    long AllocatedFileBytes, bool IsDirectory, DateTimeOffset SampledAt, DiskObjectChangeStamp ChangeStamp)
{
    public long ObservedInodes => 1;
}

/// <summary>Detects observed namespace/data changes; this is not an exclusive filesystem grant.</summary>
public sealed record DiskObjectChangeStamp(long ModifiedSeconds, uint ModifiedNanoseconds,
    long ChangedSeconds, uint ChangedNanoseconds);
