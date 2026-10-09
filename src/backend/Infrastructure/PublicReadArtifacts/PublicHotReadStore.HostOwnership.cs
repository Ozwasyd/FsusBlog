using FsusBlog.Server.Infrastructure.Memory.Contracts;

namespace FsusBlog.Server.Infrastructure.PublicReadArtifacts;

public partial class PublicHotReadStore
{
    private static void DisposeIntermediateHostClone(PublicHotReadSnapshot previous,
        PublicHotReadSnapshot next, PublicHotReadSnapshot preserved)
    {
        if (!ReferenceEquals(previous, next) && !ReferenceEquals(previous, preserved))
        {
            previous.DisposeUnclaimedHostOwnership();
        }
    }

    internal bool TryGetRequestSnapshotForConsumption(out PublicHotReadSnapshot snapshot, out string reason,
        out IDisposable? hold, out MemoryFailure? failure)
    {
        hold = null;
        failure = null;
        bool selected = TryGetRequestSnapshot(out snapshot, out reason);
        if (!snapshot.HasHostOwnership && !Volatile.Read(ref _sticky).HasHostOwnership)
        {
            return selected;
        }

        IDisposable? expired = null;
        lock (_gate)
        {
            PublicHotReadSnapshot sticky = _sticky;
            if (sticky.HasHostOwnership && _stickyUntilUtcTicks > 0 && _timeProvider.GetUtcNow().UtcTicks >= _stickyUntilUtcTicks)
            {
                ClearStickyPinLocked();
                expired = DetachInactiveHostRootLocked(sticky);
            }
            selected = TryGetRequestSnapshot(out snapshot, out reason);
            if (selected && snapshot.HasHostOwnership)
            {
                MemoryOperationResult<IDisposable> retention = snapshot.TryRetainHostConsumption();
                selected = retention.Succeeded;
                hold = retention.Value;
                failure = retention.Failure;
            }
        }
        expired?.Dispose();
        return selected;
    }

    private IDisposable? DetachInactiveHostRootLocked(PublicHotReadSnapshot snapshot)
        => ReferenceEquals(snapshot, _current) || ReferenceEquals(snapshot, _lastGood) || ReferenceEquals(snapshot, _sticky)
            ? null : snapshot.DetachHostRoot(this);

    private static void DisposeRetiredHostRoots(IDisposable? current, IDisposable? lastGood, IDisposable? sticky)
    {
        Exception? failure = null;
        Release(current);
        Release(lastGood);
        Release(sticky);
        if (failure is not null)
        {
            throw new InvalidOperationException("Snapshot host retirement failed.", failure);
        }

        void Release(IDisposable? hold)
        {
            try
            {
                hold?.Dispose();
            }
            catch (Exception exception)
            {
                failure ??= exception;
            }
        }
    }
}
