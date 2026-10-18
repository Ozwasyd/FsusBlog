using FsusBlog.Server.Infrastructure.Memory.Contracts;

namespace FsusBlog.Server.Infrastructure.PublicReadArtifacts;

public partial class PublicHotReadStore
{
    private PublicHotReadSnapshotOwnershipPolicy? _snapshotOwnershipPolicy;
    private PublicHotReadSnapshotOwnershipPolicy? _pendingSnapshotOwnershipPolicy;
    private int _snapshotOwnershipAdmissions;

    internal MemoryOperationResult<PublicHotReadSnapshotOwnershipPolicyUpdate> TryApplySnapshotOwnershipPolicy(
        PublicHotReadSnapshotOwnershipPolicy policy)
    {
        ArgumentNullException.ThrowIfNull(policy);
        lock (_gate)
        {
            if (_pendingSnapshotOwnershipPolicy is not null)
            {
                return MemoryOperationResult<PublicHotReadSnapshotOwnershipPolicyUpdate>.Reject(MemoryFailure.TierUnavailable);
            }
            if (_snapshotOwnershipPolicy is { } previous)
            {
                if (policy.Revision <= previous.Revision)
                {
                    return MemoryOperationResult<PublicHotReadSnapshotOwnershipPolicyUpdate>.Reject(MemoryFailure.StaleLocation);
                }
                if (policy.Baseline.EvidenceDigest == previous.Baseline.EvidenceDigest
                    || policy.Baseline.FrozenAt <= previous.Baseline.FrozenAt)
                {
                    return MemoryOperationResult<PublicHotReadSnapshotOwnershipPolicyUpdate>.Reject(MemoryFailure.BoundsViolation);
                }
            }
            if (_snapshotOwnershipAdmissions > 0)
            {
                _pendingSnapshotOwnershipPolicy = policy;
            }
            else
            {
                _snapshotOwnershipPolicy = policy;
            }
            return MemoryOperationResult<PublicHotReadSnapshotOwnershipPolicyUpdate>.Success(
                new(policy.Revision, _pendingSnapshotOwnershipPolicy is not null));
        }
    }

    internal MemoryOperationResult<PublicHotReadSnapshot> TryAttachSnapshotHostOwnership(
        PublicHotReadSnapshot snapshot, IReadOnlyList<IMemoryHostReadLease> leases, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        ArgumentNullException.ThrowIfNull(leases);
        PublicHotReadSnapshotOwnershipPolicy policy;
        lock (_gate)
        {
            if (_pendingSnapshotOwnershipPolicy is not null || _snapshotOwnershipPolicy is not { } current)
            {
                return MemoryOperationResult<PublicHotReadSnapshot>.Reject(MemoryFailure.TierUnavailable);
            }
            if (_snapshotOwnershipAdmissions == int.MaxValue)
            {
                return MemoryOperationResult<PublicHotReadSnapshot>.Reject(MemoryFailure.BudgetRejected);
            }
            policy = current;
            _snapshotOwnershipAdmissions++;
        }
        PublicHotReadSnapshotOwnershipAdmission? admission = null;
        PublicHotReadSnapshot? attached = null;
        bool counted = true;
        try
        {
            MemoryOperationResult<PublicHotReadSnapshotOwnershipAdmission> reserved = policy.TryReserve(
                snapshot, leases.Count, now, ReleaseSnapshotOwnershipAdmission);
            if (!reserved.Succeeded)
            {
                counted = false;
                ReleaseSnapshotOwnershipAdmission();
                return MemoryOperationResult<PublicHotReadSnapshot>.Reject(reserved.Failure!.Value);
            }
            admission = reserved.Value!;
            counted = false;
            attached = snapshot.WithHostReadLeases(leases, policy.MaximumHolds, admission);
            return MemoryOperationResult<PublicHotReadSnapshot>.Success(attached);
        }
        catch
        {
            if (attached is not null)
            {
                attached.DisposeUnpublishedHostOwnership();
            }
            else if (admission is not null)
            {
                admission.DisposeUntransferred();
            }
            else if (counted)
            {
                ReleaseSnapshotOwnershipAdmission();
            }
            throw;
        }
    }

    private void ReleaseSnapshotOwnershipAdmission()
    {
        lock (_gate)
        {
            if (_snapshotOwnershipAdmissions <= 0)
            {
                throw new InvalidOperationException("Snapshot ownership admission underflow.");
            }
            if (--_snapshotOwnershipAdmissions == 0 && _pendingSnapshotOwnershipPolicy is { } next)
            {
                _snapshotOwnershipPolicy = next;
                _pendingSnapshotOwnershipPolicy = null;
            }
        }
    }

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
        try
        {
            expired?.Dispose();
        }
        catch
        {
            hold?.Dispose();
            hold = null;
            throw;
        }
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
