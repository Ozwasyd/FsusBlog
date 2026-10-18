using FsusBlog.Server.Infrastructure.Memory.Contracts;

namespace FsusBlog.Server.Infrastructure.Memory.Disk;

/// <summary>
/// The existing policy owner supplies a frozen conservative file/extents/metadata charge
/// before creation. A native block observation alone cannot produce this upper bound.
/// Implementing this interface does not itself qualify a backend or activate Auto.
/// </summary>
public interface IDiskPhysicalAllocationPolicy
{
    MemoryOperationResult<DiskPhysicalAllocationBound> TryGetBound(DiskFileFootprint root, long logicalBytes);
}

/// <summary>The retained upper bound is root-, capacity-, revision- and time-scoped.</summary>
public sealed record DiskPhysicalAllocationBound(string CapacityIdentity, ulong RootInode,
    long MaximumLogicalBytes, long MaximumChargeBytes, ulong PolicyRevision, DateTimeOffset ValidUntil);
