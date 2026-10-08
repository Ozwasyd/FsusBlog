using FsusBlog.Server.Infrastructure.Memory.Contracts;

namespace FsusBlog.Server.Infrastructure.Memory.Disk;

/// <summary>Native failure diagnostics preserve the distinction hidden by a coarse tier result.</summary>
public enum DiskFileSystemFailure
{
    Unavailable,
    SpaceOrInodesExhausted,
    QuotaExceeded,
    ReadOnly,
    PermissionDenied,
    OwnershipChanged,
    ScanBudgetRejected
}

/// <summary>No payload/path contents are included; the original errno remains inspectable.</summary>
public sealed class DiskFileSystemException : IOException
{
    internal DiskFileSystemException(string action, int nativeError, DiskFileSystemFailure kind)
        : base($"Cannot {action}; filesystem={kind}; errno={nativeError}.", nativeError)
    {
        NativeError = nativeError;
        Kind = kind;
    }

    public int NativeError
    {
        get;
    }
    public DiskFileSystemFailure Kind
    {
        get;
    }
    public MemoryFailure OperationFailure => Kind switch
    {
        DiskFileSystemFailure.SpaceOrInodesExhausted or DiskFileSystemFailure.QuotaExceeded
            or DiskFileSystemFailure.ScanBudgetRejected => MemoryFailure.BudgetRejected,
        DiskFileSystemFailure.OwnershipChanged => MemoryFailure.OwnershipViolation,
        _ => MemoryFailure.TierUnavailable
    };
}
