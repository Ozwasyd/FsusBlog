namespace FsusBlog.Server.Infrastructure.Memory.Disk;

/// <summary>
/// Aggregate from a completed bounded owner-namespace scan. No payload or per-file roster
/// is retained. Allocated blocks exclude unattributed filesystem metadata and shared extents.
/// Untracked files and missing tracked files prevent growth until owner reconciliation.
/// </summary>
public sealed record DiskSpillInventoryObservation(DiskFileFootprint Root, long OwnedFiles,
    long LogicalFileBytes, long AllocatedFileBytes, long UntrackedFiles,
    long UntrackedAllocatedFileBytes, DateTimeOffset ObservedAt);
