using FsusBlog.Server.Infrastructure.Memory.Contracts;

namespace FsusBlog.Server.Infrastructure.Memory.Devices;

/// <summary>The device registry retains this operation even when the caller cancels or drops its wait.</summary>
public sealed class GpuPeerDeviceOperation : IDisposable
{
    private readonly TaskCompletionSource<MemoryOperationResult<GpuPeerDeviceOperation>> _completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
    internal GpuPeerDeviceOperation(GpuAllocation source, GpuAllocation destination)
    {
        Source = source;
        Destination = destination;
    }
    internal GpuAllocation Source
    {
        get;
    }
    internal GpuAllocation Destination
    {
        get;
    }
    internal bool Quarantined
    {
        get; set;
    }
    internal GpuPeerTransfer? Transfer
    {
        get; set;
    }
    public Task<MemoryOperationResult<GpuPeerDeviceOperation>> WaitAsync(CancellationToken cancellationToken = default)
        => _completion.Task.WaitAsync(cancellationToken);
    internal void Finish(MemoryFailure? failure)
        => _completion.TrySetResult(failure is null
            ? MemoryOperationResult<GpuPeerDeviceOperation>.Success(this)
            : MemoryOperationResult<GpuPeerDeviceOperation>.Reject(failure.Value));
    // Only the owning registry polls and drains the native operation.
    public void Dispose()
    {
    }
}
