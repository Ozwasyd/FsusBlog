using System.Buffers;

using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.NotificationStream;

namespace FsusBlog.Server.Infrastructure.Memory.Transient;

/// <summary>
/// Copies an already qualified encoded notification into one admitted immutable owner.
/// Existing frame retains, recipient queues, replay and actual write completion remain authoritative.
/// </summary>
public static class NotificationPayloadLease
{
    public static MemoryOperationResult<SharedNotificationStreamFrame> TryCreate(
        TransientBufferPool pool, ReadOnlySpan<byte> qualifiedPayload)
    {
        ArgumentNullException.ThrowIfNull(pool);
        if (pool.Workload != TransientWorkload.WebSocketFanout)
        {
            return MemoryOperationResult<SharedNotificationStreamFrame>.Reject(MemoryFailure.BoundsViolation);
        }
        MemoryOperationResult<TransientBufferLease> rent = pool.TryRent(qualifiedPayload.Length);
        if (!rent.Succeeded)
        {
            return MemoryOperationResult<SharedNotificationStreamFrame>.Reject(rent.Failure!.Value);
        }
        IMemoryOwner<byte> owner = rent.Value!;
        bool transferred = false;
        try
        {
            qualifiedPayload.CopyTo(owner.Memory.Span);
            var result = MemoryOperationResult<SharedNotificationStreamFrame>.Success(
                SharedNotificationStreamFrame.FromOwnedMemory(owner, qualifiedPayload.Length));
            transferred = true;
            return result;
        }
        finally
        {
            if (!transferred)
            {
                owner.Dispose();
            }
        }
    }
}
