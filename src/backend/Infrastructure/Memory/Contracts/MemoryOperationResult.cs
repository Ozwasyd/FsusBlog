namespace FsusBlog.Server.Infrastructure.Memory.Contracts;

public enum MemoryFailure
{
    BudgetRejected,
    TierUnavailable,
    UnsupportedCapability,
    Cancelled,
    Corruption,
    DeviceLost,
    OwnershipViolation,
    BoundsViolation,
    StaleLocation
}

public enum MemoryOwnerDisposition
{
    RetainOriginal,
    RetireFaultedOwner
}

// CORRECTNESS: Expected admission failures never erase corruption or ownership failures.
public sealed class MemoryOperationResult<T> where T : class
{
    private MemoryOperationResult(T? value, MemoryFailure? failure)
    {
        Value = value;
        Failure = failure;
    }

    public T? Value
    {
        get;
    }
    public MemoryFailure? Failure
    {
        get;
    }
    public bool Succeeded => Failure is null;
    public bool IsCorrectnessFailure => Failure is MemoryFailure.Corruption or MemoryFailure.OwnershipViolation
        or MemoryFailure.BoundsViolation or MemoryFailure.StaleLocation;
    public MemoryOwnerDisposition Disposition => Failure is MemoryFailure.Corruption or MemoryFailure.DeviceLost
        ? MemoryOwnerDisposition.RetireFaultedOwner : MemoryOwnerDisposition.RetainOriginal;

    public static MemoryOperationResult<T> Success(T value)
    {
        ArgumentNullException.ThrowIfNull(value);
        return new(value, null);
    }

    public static MemoryOperationResult<T> Reject(MemoryFailure failure)
    {
        if (!Enum.IsDefined(failure))
        {
            throw new ArgumentOutOfRangeException(nameof(failure));
        }
        return new(null, failure);
    }
}
