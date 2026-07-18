using FsusBlog.Core.Algorithms;

namespace FsusBlog.Server.Infrastructure.Cache;

public readonly record struct OwnedFrameCacheReadResult
{
    public OwnedFrameCacheReadResult(bool hit, OwnedAedsFrameReadLease? lease)
    {
        if (hit != (lease is not null))
        {
            throw new ArgumentException("An owned-frame cache hit must contain exactly one read lease.", nameof(lease));
        }

        Hit = hit;
        Lease = lease;
    }

    public bool Hit { get; }

    public OwnedAedsFrameReadLease? Lease { get; }
}

/// <summary>
/// A consistent physical-residency snapshot. EntryCount is the number of indexed L1 roots;
/// logical and capacity bytes continue to include retired roots until their last read lease
/// releases the backing storage.
/// </summary>
public readonly record struct OwnedFrameCacheResidencySnapshot(
    int EntryCount,
    long LogicalBytes,
    long CapacityBytes);

/// <summary>
/// Lease-aware cache boundary for immutable pre-encoded AEDS frames. This API is deliberately
/// separate from raw payload caching so pooled backing arrays can never escape as untracked
/// <see cref="ReadOnlyMemory{T}"/> values.
/// </summary>
public interface IOwnedFrameCache
{
    Task<OwnedFrameCacheReadResult> TryGetOwnedFrameAsync(
        CachePolicyId policyId,
        string identity,
        AedsFrameType expectedFrameType,
        CancellationToken cancellationToken = default);

    Task<OwnedFrameCacheReadResult> TryGetOwnedFrameAsync(
        CachePolicyId policyId,
        int identity,
        AedsFrameType expectedFrameType,
        CancellationToken cancellationToken = default)
        => TryGetOwnedFrameAsync(
            policyId,
            identity.ToString(System.Globalization.CultureInfo.InvariantCulture),
            expectedFrameType,
            cancellationToken);

    /// <summary>
    /// Transfers the root ownership of <paramref name="frame"/> to the cache. Ownership is
    /// consumed on success, cancellation, and exception; callers that need to write the same
    /// frame to a response must acquire a read lease before invoking this method.
    /// </summary>
    Task SetOwnedFrameAsync(
        CachePolicyId policyId,
        string identity,
        OwnedAedsFrame frame,
        TimeSpan? l2TtlOverride = null,
        CancellationToken cancellationToken = default);

    Task SetOwnedFrameAsync(
        CachePolicyId policyId,
        int identity,
        OwnedAedsFrame frame,
        TimeSpan? l2TtlOverride = null,
        CancellationToken cancellationToken = default)
        => SetOwnedFrameAsync(
            policyId,
            identity.ToString(System.Globalization.CultureInfo.InvariantCulture),
            frame,
            l2TtlOverride,
            cancellationToken);

    OwnedFrameCacheResidencySnapshot GetOwnedFrameResidencySnapshot();
}
