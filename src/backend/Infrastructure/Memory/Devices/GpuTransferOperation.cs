using FsusBlog.Server.Infrastructure.Memory.Contracts;

namespace FsusBlog.Server.Infrastructure.Memory.Devices;

/// <summary>
/// Custody follows actual driver completion, independent of caller waits. Readback
/// consumers explicitly copy complete bytes into their admitted destination and dispose.
/// </summary>
public sealed class GpuTransferOperation : IDisposable
{
    private readonly GpuMemoryDevice _owner;
    private readonly TaskCompletionSource<MemoryOperationResult<GpuTransferOperation>> _completion = new(TaskCreationOptions.RunContinuationsAsynchronously);

    internal GpuTransferOperation(GpuMemoryDevice owner, GpuAllocation allocation, GpuStagingBuffer staging,
        IMemoryHostReadLease? source, IMemoryReservation reservation, bool newStaging, bool readback)
    {
        _owner = owner;
        Allocation = allocation;
        Staging = staging;
        Source = source;
        Reservation = reservation;
        NewStaging = newStaging;
        Readback = readback;
    }

    internal GpuAllocation Allocation
    {
        get;
    }
    internal GpuStagingBuffer Staging
    {
        get;
    }
    internal IMemoryHostReadLease? Source
    {
        get; set;
    }
    internal IMemoryReservation Reservation
    {
        get;
    }
    internal bool NewStaging
    {
        get;
    }
    internal bool Readback
    {
        get;
    }
    internal GpuSubmission Submission
    {
        get; set;
    }
    internal bool Submitted
    {
        get; set;
    }
    internal bool DriverComplete
    {
        get; set;
    }
    internal bool Quarantined
    {
        get; set;
    }
    internal bool ReleaseRequested
    {
        get; set;
    }

    public Task<MemoryOperationResult<GpuTransferOperation>> WaitAsync(CancellationToken cancellationToken = default)
        => _completion.Task.WaitAsync(cancellationToken);

    // CALLER: Destination is supplied by the existing admitted materialization/response owner.
    public void CopyReadbackTo(Span<byte> destination) => _owner.CopyReadback(this, destination);

    internal void Finish(MemoryFailure? failure)
        => _completion.TrySetResult(failure is null
            ? MemoryOperationResult<GpuTransferOperation>.Success(this)
            : MemoryOperationResult<GpuTransferOperation>.Reject(failure.Value));

    public void Dispose() => _owner.ReleaseOperation(this);
}
