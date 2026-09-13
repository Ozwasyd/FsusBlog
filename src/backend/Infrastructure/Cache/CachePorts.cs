namespace FsusBlog.Server.Infrastructure.Cache;

public readonly record struct CacheReadResult<T>(bool Hit, T? Value);
public readonly record struct CacheKeyIdentity(CachePolicyId PolicyId, string Identity, string? Version = null);
public readonly record struct CachePrefixIdentity(CachePolicyId PolicyId, string IdentityPrefix);
public sealed record CachePolicyStorageSnapshot(
    CachePolicyId PolicyId,
    long KeyCount,
    long Bytes,
    long CapacityBytes = 0);

public sealed record CacheL1InvalidationPolicyReceipt(
    CachePolicyId PolicyId,
    int EntryCount,
    long Bytes);

public sealed record CacheL1InvalidationReceipt(
    IReadOnlyList<CacheL1InvalidationPolicyReceipt> ByPolicy)
{
    public int EntryCount => ByPolicy.Sum(static item => item.EntryCount);

    public long Bytes => ByPolicy.Sum(static item => item.Bytes);
}

public interface ICacheLocalInvalidator
{
    CacheL1InvalidationReceipt InvalidateLocal(IReadOnlyList<CacheKeyIdentity> keys);

    CacheL1InvalidationReceipt ReconcileAllLocal();
}

public interface ICachePayloadCodec<T>
{
    byte[] Encode(T value);

    (bool Success, T? Value) Decode(ReadOnlyMemory<byte> payload);
}

public interface ICacheKeyResolver
{
    string BuildKey(CachePolicyId policyId, string identity, string? version = null);

    string BuildKey(CachePolicyId policyId, int identity, string? version = null)
        => BuildKey(policyId, identity.ToString(System.Globalization.CultureInfo.InvariantCulture), version);
}

public interface ICacheTypedReader
{
    Task<CacheReadResult<T>> TryGetAsync<T>(CachePolicyId policyId, string identity, Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder, CancellationToken cancellationToken = default);

    Task<CacheReadResult<T>> TryGetAsync<T>(CachePolicyId policyId, int identity, Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder, CancellationToken cancellationToken = default)
        => TryGetAsync(policyId, identity.ToString(System.Globalization.CultureInfo.InvariantCulture), decoder, cancellationToken);

    Task<CacheReadResult<T>> TryGetAsync<T>(CachePolicyId policyId, string identity, ICachePayloadCodec<T> codec, CancellationToken cancellationToken = default)
        => TryGetAsync(policyId, identity, codec.Decode, cancellationToken);

}

public interface ICacheRawReader
{
    Task<CacheReadResult<byte[]>> TryGetRawAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default);

    Task<CacheReadResult<byte[]>> TryGetRawAsync(CachePolicyId policyId, int identity, CancellationToken cancellationToken = default)
        => TryGetRawAsync(policyId, identity.ToString(System.Globalization.CultureInfo.InvariantCulture), cancellationToken);

    Task<CacheReadResult<ReadOnlyMemory<byte>>> TryGetRawReadonlyAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default);

    Task<CacheReadResult<ReadOnlyMemory<byte>>> TryGetRawReadonlyAsync(CachePolicyId policyId, int identity, CancellationToken cancellationToken = default)
        => TryGetRawReadonlyAsync(policyId, identity.ToString(System.Globalization.CultureInfo.InvariantCulture), cancellationToken);

}

public interface ICacheStringReader
{
    Task<string?> GetStringAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default);
}

public interface ICacheRawWriter
{
    Task SetRawAsync(CachePolicyId policyId, string identity, byte[] value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default);

    Task SetRawAsync(CachePolicyId policyId, int identity, byte[] value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default)
        => SetRawAsync(policyId, identity.ToString(System.Globalization.CultureInfo.InvariantCulture), value, l2TtlOverride, cancellationToken);

    Task SetNegativeAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default);

}

public interface ICacheStringWriter
{
    Task SetStringAsync(CachePolicyId policyId, string identity, string value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default);
}

public interface ICacheCompareExchangeStore
{
    Task<bool> TrySetStringIfValueAsync(CachePolicyId policyId, string identity, string value, string compareIdentity, string expectedCompareValue, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default)
        => throw new NotSupportedException("Compare-and-set string writes are not supported by this store.");

    Task<bool> TrySetVersionedStringAsync(CachePolicyId policyId, string identity, string value, string version, bool allowOverwrite = false, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default)
        => throw new NotSupportedException("Version-guarded string writes are not supported by this store.");

}

public interface ICacheCounterStore
{
    Task<long> IncrementAsync(CachePolicyId policyId, string identity, long value = 1, CancellationToken cancellationToken = default);

    Task<long[]> IncrementManyAsync(CachePolicyId policyId, IReadOnlyList<string> identities, long value = 1, CancellationToken cancellationToken = default)
        => throw new NotSupportedException("Atomic multi-counter increments are not supported by this store.");

    Task<long> IncrementWithExpiryAsync(CachePolicyId policyId, string identity, TimeSpan ttl, long value = 1, CancellationToken cancellationToken = default)
        => throw new NotSupportedException("Atomic expiring counters are not supported by this store.");

    Task<long[]> IncrementManyWithExpiryAsync(CachePolicyId policyId, IReadOnlyList<string> identities, TimeSpan ttl, long value = 1, CancellationToken cancellationToken = default)
        => throw new NotSupportedException("Atomic multi-counter expiring increments are not supported by this store.");

    Task<long> IncrementClampedWithExpiryAsync(CachePolicyId policyId, string identity, long delta, long maxValue, TimeSpan ttl, CancellationToken cancellationToken = default)
        => throw new NotSupportedException("Atomic clamped expiring counters are not supported by this store.");

}

public interface ICacheOneTimeStore
{
    Task<bool> ConsumeOnceAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default);

    Task<CacheReadResult<T>> ConsumeOnceAndGetAsync<T>(CachePolicyId policyId, string identity, Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder, CancellationToken cancellationToken = default);
}

public interface ICacheOneTimeExchangeStore
{
    Task<CacheReadResult<T>> ExchangeOnceAndGetAsync<T>(
        CachePolicyId sourcePolicyId,
        string sourceIdentity,
        CachePolicyId targetPolicyId,
        string targetIdentity,
        byte[] targetValue,
        TimeSpan targetTtl,
        Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> sourceDecoder,
        CancellationToken cancellationToken = default);
}

public interface ICacheInvalidationStore
{
    Task RemoveAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default);

    Task RemoveAsync(CachePolicyId policyId, int identity, CancellationToken cancellationToken = default)
        => RemoveAsync(policyId, identity.ToString(System.Globalization.CultureInfo.InvariantCulture), cancellationToken);

    Task RemoveManyAsync(IReadOnlyList<CacheKeyIdentity> keys, CancellationToken cancellationToken = default);

    Task RemoveByPrefixAsync(CachePolicyId policyId, string identityPrefix, CancellationToken cancellationToken = default);

    Task RemoveByPrefixManyAsync(IReadOnlyList<CachePrefixIdentity> prefixes, CancellationToken cancellationToken = default);
}

public interface ICacheLeaseStore
{
    Task<bool> TryAcquireLeaseAsync(CachePolicyId policyId, string identity, string value, TimeSpan ttl, CancellationToken cancellationToken = default);

    Task<bool> TryRenewLeaseAsync(
        CachePolicyId policyId,
        string identity,
        string expectedValue,
        TimeSpan ttl,
        CancellationToken cancellationToken = default)
        => throw new NotSupportedException("Token-owned lease renewal is not supported by this store.");

    Task<bool> TryReleaseLeaseAsync(
        CachePolicyId policyId,
        string identity,
        string expectedValue,
        CancellationToken cancellationToken = default)
        => throw new NotSupportedException("Token-owned lease release is not supported by this store.");
}

public interface ICacheSingleFlightCoordinator
{
    Task<IAsyncDisposable> AcquireAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
        => throw new NotSupportedException("Single-flight coordination is not supported by this implementation.");

    bool IsHeld(CachePolicyId policyId, string identity) => false;
}

public interface ICacheDiagnostics
{
    IReadOnlyList<CacheL1PolicyResidencySnapshot> GetL1PolicyResidencySnapshots()
        => Array.Empty<CacheL1PolicyResidencySnapshot>();

    Task<IReadOnlyList<CachePolicyStorageSnapshot>> GetPolicyStorageSnapshotsAsync(IReadOnlyList<CachePolicyId> policyIds, CancellationToken cancellationToken = default)
        => Task.FromResult<IReadOnlyList<CachePolicyStorageSnapshot>>(
            policyIds.Select(static policyId => new CachePolicyStorageSnapshot(policyId, 0, 0)).ToArray());
}
