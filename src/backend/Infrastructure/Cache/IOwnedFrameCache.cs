using FsusBlog.Core.Algorithms;

namespace FsusBlog.Server.Infrastructure.Cache;

public readonly record struct OwnedFrameCacheReadResult
{
    public OwnedFrameCacheReadResult(bool hit, OwnedAedsFrameReadLease? lease, bool negative = false)
    {
        if (!hit && (lease is not null || negative))
        {
            throw new ArgumentException("An owned-frame cache miss cannot contain a lease or a negative marker.", nameof(lease));
        }

        if (hit && ((lease is not null) == negative))
        {
            throw new ArgumentException("An owned-frame cache hit must contain exactly one frame lease or negative marker.", nameof(lease));
        }

        Hit = hit;
        Lease = lease;
        Negative = negative;
    }

    public bool Hit
    {
        get;
    }

    public OwnedAedsFrameReadLease? Lease
    {
        get;
    }

    public bool Negative
    {
        get;
    }

    public static OwnedFrameCacheReadResult NegativeHit => new(true, null, negative: true);
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

public readonly record struct OwnedFramePublicationGuard(
    CachePolicyId PolicyId,
    string Identity,
    long ExpectedValue);

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

    /// <summary>
    /// Publishes only when the authoritative counter still equals the expected value at the
    /// same Redis linearization point as the frame write. A false result consumes the frame
    /// without installing it in L1 or L2.
    /// </summary>
    async Task<bool> TrySetOwnedFrameAsync(
        CachePolicyId policyId,
        string identity,
        OwnedAedsFrame frame,
        OwnedFramePublicationGuard publicationGuard,
        TimeSpan? l2TtlOverride = null,
        CancellationToken cancellationToken = default)
    {
        await SetOwnedFrameAsync(
                policyId,
                identity,
                frame,
                l2TtlOverride,
                cancellationToken)
            .ConfigureAwait(false);
        return true;
    }

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
