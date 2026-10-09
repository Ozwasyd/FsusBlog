using System.Runtime.InteropServices;

using FsusBlog.Server.Infrastructure.Memory.Contracts;

namespace FsusBlog.Server.Infrastructure.PublicReadArtifacts;

public sealed partial class PublicHotReadSnapshot
{
    private readonly PublicHotReadSnapshotHostOwnership? _hostOwnership;
    private readonly object? _hostOwnershipGate;
    private IDisposable? _hostRootHold;
    private PublicHotReadStore? _hostPublicationOwner;

    internal bool HasHostOwnership => _hostOwnership is not null;

    /// <summary>
    /// Consumes exclusive disposal custody of actual admitted host read leases, including
    /// failed construction after binding validation. The original evidence and bytes are
    /// unchanged. Shared holds use the caller's finite bound; this supplies no qualification.
    /// </summary>
    internal PublicHotReadSnapshot WithHostReadLeases(IReadOnlyList<IMemoryHostReadLease> leases, int maximumHolds)
    {
        if (HasHostOwnership)
        {
            throw new InvalidOperationException("This snapshot already owns host read leases.");
        }
        PublicHotReadSnapshotHostOwnership ownership = PublicHotReadSnapshotHostOwnership.Create(this, leases, maximumHolds);
        try
        {
            return new PublicHotReadSnapshot(Version, _articleFramesById, _listFrames, _categoryFrame, _tagFrame,
                _htmlBaseByPath, PublicationEvidence, _htmlOverlayByPath, _htmlRemovedPaths, _htmlFrameCount,
                PublicArticleCount, ArticleFrameLimit, ownership);
        }
        catch
        {
            ownership.AbortInitialization();
            throw;
        }
    }

    internal void ClaimHostPublication(PublicHotReadStore owner)
    {
        if (_hostOwnership is null || _hostOwnershipGate is not { } gate)
        {
            return;
        }
        lock (gate)
        {
            ObjectDisposedException.ThrowIf(_hostRootHold is null, this);
            if (_hostPublicationOwner is not null && !ReferenceEquals(_hostPublicationOwner, owner))
            {
                throw new InvalidOperationException("An owned snapshot cannot transfer to another publication owner.");
            }
            _hostPublicationOwner = owner;
        }
    }

    internal IDisposable? DetachHostRoot(PublicHotReadStore? owner)
    {
        if (_hostOwnership is null || _hostOwnershipGate is not { } gate)
        {
            return null;
        }
        lock (gate)
        {
            if (!ReferenceEquals(_hostPublicationOwner, owner))
            {
                throw new InvalidOperationException("Only the current disposal owner can retire the snapshot hold.");
            }
            return Interlocked.Exchange(ref _hostRootHold, null);
        }
    }

    internal void DisposeUnpublishedHostOwnership() => DetachHostRoot(null)?.Dispose();

    internal void DisposeUnclaimedHostOwnership()
    {
        if (_hostOwnershipGate is not { } gate)
        {
            return;
        }
        IDisposable? release;
        lock (gate)
        {
            release = _hostPublicationOwner is null ? Interlocked.Exchange(ref _hostRootHold, null) : null;
        }
        release?.Dispose();
    }

    internal MemoryOperationResult<IDisposable> TryRetainHostConsumption()
    {
        if (_hostOwnership is not { } ownership || _hostOwnershipGate is not { } gate)
        {
            throw new InvalidOperationException("This snapshot has no host ownership.");
        }
        lock (gate)
        {
            return _hostRootHold is null
                ? MemoryOperationResult<IDisposable>.Reject(MemoryFailure.OwnershipViolation)
                : ownership.TryRetain();
        }
    }
}

/// <summary>
/// Shares already acquired real read holds across immutable snapshot copies and consumers.
/// Store references determine publication roles; this owns no registry, allocator or eligibility.
/// </summary>
internal sealed class PublicHotReadSnapshotHostOwnership
{
    private readonly object _gate = new();
    private readonly int _maximumHolds;
    private IMemoryHostReadLease[]? _leases;
    private int _holds;

    private PublicHotReadSnapshotHostOwnership(IMemoryHostReadLease[] leases, int maximumHolds)
    {
        _leases = leases;
        _maximumHolds = maximumHolds;
    }

    internal static PublicHotReadSnapshotHostOwnership Create(PublicHotReadSnapshot snapshot,
        IReadOnlyList<IMemoryHostReadLease> leases, int maximumHolds)
    {
        ArgumentNullException.ThrowIfNull(leases);
        if (maximumHolds <= 0 || leases.Count == 0)
        {
            throw new ArgumentOutOfRangeException(nameof(maximumHolds), "Actual leases and a finite positive hold bound are required.");
        }
        var opaque = new HashSet<ReadOnlyMemory<byte>>();
        foreach (PublicBinaryArtifact artifact in snapshot.ArticleArtifacts.Select(pair => pair.Value)
            .Concat(snapshot.ListArtifacts.Select(pair => pair.Value)).Append(snapshot.CategoryFrame).Append(snapshot.TagFrame))
        {
            if (!artifact.BrotliFrame.IsEmpty || !artifact.GzipFrame.IsEmpty)
            {
                throw new NotSupportedException("Owned host snapshots require identity-only binary representations until compression validation is admitted.");
            }
            Add(artifact.Frame);
        }
        if (leases.Count > opaque.Count)
        {
            throw new ArgumentException("Host leases must bind existing opaque binary representations.", nameof(leases));
        }
        var unique = new HashSet<IMemoryHostReadLease>(ReferenceEqualityComparer.Instance);
        var supplied = new IMemoryHostReadLease[leases.Count];
        for (int index = 0; index < supplied.Length; index++)
        {
            IMemoryHostReadLease lease = leases[index] ?? throw new ArgumentException("Null host lease.", nameof(leases));
            lease.Content.Validate();
            lease.Location.Validate();
            if (!unique.Add(lease) || !opaque.Remove(lease.Memory))
            {
                throw new ArgumentException("Each actual lease must bind one existing representation.", nameof(leases));
            }
            supplied[index] = lease;
        }
        if (opaque.Count != 0 || snapshot.HtmlArtifacts.Any(pair => !IsArrayOrEmpty(pair.Value.Bytes)))
        {
            throw new ArgumentException("Every opaque binary representation requires its actual lease; opaque HTML is unsupported.", nameof(leases));
        }
        return new(supplied, maximumHolds);

        void Add(ReadOnlyMemory<byte> memory)
        {
            if (!IsArrayOrEmpty(memory))
            {
                opaque.Add(memory);
            }
        }
    }

    private static bool IsArrayOrEmpty(ReadOnlyMemory<byte> memory)
        => memory.IsEmpty || MemoryMarshal.TryGetArray(memory, out _);

    internal MemoryOperationResult<IDisposable> TryRetain()
    {
        lock (_gate)
        {
            if (_leases is null)
            {
                return MemoryOperationResult<IDisposable>.Reject(MemoryFailure.OwnershipViolation);
            }
            if (_holds >= _maximumHolds)
            {
                return MemoryOperationResult<IDisposable>.Reject(MemoryFailure.BudgetRejected);
            }
            var hold = new Hold(this);
            _holds++;
            return MemoryOperationResult<IDisposable>.Success(hold);
        }
    }

    internal void AbortInitialization()
    {
        IMemoryHostReadLease[]? release = null;
        lock (_gate)
        {
            if (_holds == 0)
            {
                release = _leases;
                _leases = null;
            }
        }
        DisposeAll(release);
    }

    private void Release()
    {
        IMemoryHostReadLease[]? release = null;
        lock (_gate)
        {
            if (_holds <= 0)
            {
                throw new InvalidOperationException("Snapshot host hold underflow.");
            }
            if (--_holds == 0)
            {
                release = _leases;
                _leases = null;
            }
        }
        DisposeAll(release);
    }

    private static void DisposeAll(IMemoryHostReadLease[]? leases)
    {
        Exception? failure = null;
        foreach (IMemoryHostReadLease lease in leases ?? [])
        {
            try
            {
                lease.Dispose();
            }
            catch (Exception exception)
            {
                failure ??= exception;
            }
        }
        if (failure is not null)
        {
            throw new InvalidOperationException("Host read lease retirement failed.", failure);
        }
    }

    private sealed class Hold(PublicHotReadSnapshotHostOwnership owner) : IDisposable
    {
        private PublicHotReadSnapshotHostOwnership? _owner = owner;
        public void Dispose() => Interlocked.Exchange(ref _owner, null)?.Release();
    }
}
