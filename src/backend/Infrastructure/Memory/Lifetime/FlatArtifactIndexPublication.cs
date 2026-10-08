using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Host;

using FlatArtifactIndexLease = FsusBlog.Server.Infrastructure.Memory.Host.FlatArtifactIndex.FlatArtifactIndexLease;

namespace FsusBlog.Server.Infrastructure.Memory.Lifetime;

/// <summary>
/// Local generation holder for an existing publication owner. It transfers index ownership,
/// serializes selection with acquisition, and retires old generations after the swap.
/// It grants no content eligibility, revocation, capability selection or production activation.
/// </summary>
internal sealed class FlatArtifactIndexPublication : IDisposable
{
    private readonly object _gate = new();
    private FlatArtifactIndex? _current;
    private bool _closed;

    internal bool TryPublish(FlatArtifactIndex next)
    {
        ArgumentNullException.ThrowIfNull(next);
        lock (_gate)
        {
            if (_closed || ReferenceEquals(_current, next))
            {
                return false;
            }
            // OWNERSHIP: One holder may consume the initial ownership role. The
            // caller relinquishes its disposal responsibility on success.
            if (!next.TryClaimPublication())
            {
                return false;
            }
            FlatArtifactIndex? previous = _current;
            _current = next;
            previous?.Dispose();
            return true;
        }
    }

    internal MemoryOperationResult<FlatArtifactIndexLease> TryAcquire()
    {
        lock (_gate)
        {
            return _closed || _current is null
                ? MemoryOperationResult<FlatArtifactIndexLease>.Reject(MemoryFailure.TierUnavailable)
                : _current.TryAcquire(_current.Location);
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_closed)
            {
                return;
            }
            _closed = true;
            FlatArtifactIndex? previous = _current;
            _current = null;
            previous?.Dispose();
        }
    }
}
