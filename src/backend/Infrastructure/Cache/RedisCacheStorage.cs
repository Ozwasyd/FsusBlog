using System.Collections.Concurrent;
using System.Diagnostics;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Testing;

using Microsoft.Extensions.Caching.Memory;

using StackExchange.Redis;

namespace FsusBlog.Server.Infrastructure.Cache;

internal sealed class UnifiedCache(
    IMemoryCache memoryCache,
    PolicyShardedCacheL1Store localStore,
    IRedisConnectionProvider connectionProvider,
    ICachePolicyRegistry policyRegistry,
    IRuntimeKeyScope keyScope,
    ICacheKeyResolver keyResolver,
    CacheSingleFlightCoordinator coordination,
    ICacheTelemetry telemetry,
    ILogger<UnifiedCache> logger,
    IRedisOperationExecutor? redisOperations = null) : ICacheTypedReader,
    ICacheRawReader,
    ICacheStringReader,
    ICacheRawWriter,
    ICacheStringWriter,
    ICacheCompareExchangeStore,
    ICacheCounterStore,
    ICacheOneTimeStore,
    ICacheOneTimeExchangeStore,
    ICacheInvalidationStore,
    ICacheLeaseStore,
    ICacheDiagnostics,
    IOwnedFrameCache,
    ICacheLocalInvalidator,
    IDisposable
{
    public UnifiedCache(
        IConnectionMultiplexer redis,
        ICachePolicyRegistry policyRegistry,
        IRuntimeKeyScope keyScope,
        ILogger<UnifiedCache> logger,
        IRedisOperationExecutor? redisOperations = null)
        : this(
            new MemoryCache(new MemoryCacheOptions()),
            new PolicyShardedCacheL1Store(policyRegistry, keyScope),
            new DirectRedisConnectionProvider(redis),
            policyRegistry,
            keyScope,
            new CacheKeyResolver(policyRegistry, keyScope, Microsoft.Extensions.Logging.Abstractions.NullLogger<CacheKeyResolver>.Instance),
            new CacheSingleFlightCoordinator(
                new CacheKeyResolver(policyRegistry, keyScope, Microsoft.Extensions.Logging.Abstractions.NullLogger<CacheKeyResolver>.Instance)),
            new CacheTelemetry(),
            logger,
            redisOperations ?? CreateDirectRedisExecutor(redis))
    {
    }

    internal UnifiedCache(
        IMemoryCache memoryCache,
        PolicyShardedCacheL1Store localStore,
        IConnectionMultiplexer redis,
        ICachePolicyRegistry policyRegistry,
        IRuntimeKeyScope keyScope,
        ICacheKeyResolver keyResolver,
        CacheSingleFlightCoordinator coordination,
        ICacheTelemetry telemetry,
        ILogger<UnifiedCache> logger,
        IRedisOperationExecutor? redisOperations = null)
        : this(
            memoryCache,
            localStore,
            new DirectRedisConnectionProvider(redis),
            policyRegistry,
            keyScope,
            keyResolver,
            coordination,
            telemetry,
            logger,
            redisOperations ?? CreateDirectRedisExecutor(redis))
    {
    }

    private static readonly TimeSpan s_missingPolicyL2Ttl = TimeSpan.FromMinutes(5);
    private const string RegistryKeyPrefix = "cache:registry:";
    private const int PrefixInvalidationBatchSize = 256;
    private const string DeleteKeysAndRegistryMembersScript = """
        for i = 2, #KEYS do
            redis.call('DEL', KEYS[i])
            redis.call('SREM', KEYS[1], KEYS[i])
        end
        return #KEYS - 1
        """;

    private readonly IRedisOperationExecutor _redisOperations = redisOperations
        ?? new RedisOperationExecutor(connectionProvider, new RedisOperationBudgetCatalog(), TimeProvider.System);
    private readonly ConcurrentDictionary<CacheL1Key, OwnedFrameL1Entry> _ownedFrameEntries = new();
    private readonly ConcurrentDictionary<string, OwnedFrameL1Entry> _ownedFrameKeysByRedisKey = new(StringComparer.Ordinal);
    private readonly object _l1MutationLock = new();
    private long _ownedFrameLogicalBytes;
    private long _ownedFrameCapacityBytes;
    private int _ownedFrameEntryCount;
    private int _disposed;

    private string BuildKey(CachePolicyId policyId, string identity, string? version = null)
        => keyResolver.BuildKey(policyId, identity, version);

    private string BuildKey(CachePolicyId policyId, int identity, string? version = null)
        => keyResolver.BuildKey(policyId, identity, version);

    private static string RuntimeEvidenceIdentity(CacheIdentity identity)
        => identity.Kind == CacheIdentityKind.Integer
            ? identity.IntegerValue.ToString(System.Globalization.CultureInfo.InvariantCulture)
            : identity.StringValue!;

    public Task<CacheReadResult<T>> TryGetAsync<T>(
        CachePolicyId policyId,
        string identity,
        Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder,
        CancellationToken cancellationToken = default)
        => TryGetCoreAsync(policyId, CacheIdentity.FromString(identity), decoder, cancellationToken);

    public Task<CacheReadResult<T>> TryGetAsync<T>(
        CachePolicyId policyId,
        int identity,
        Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder,
        CancellationToken cancellationToken = default)
        => TryGetCoreAsync(policyId, CacheIdentity.FromInteger(identity), decoder, cancellationToken);

    private async Task<CacheReadResult<T>> TryGetCoreAsync<T>(
        CachePolicyId policyId,
        CacheIdentity identity,
        Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder,
        CancellationToken cancellationToken)
    {
        RuntimeCacheL1BoundaryEvidenceScope l1Evidence =
            RuntimeCacheL1BoundaryEvidenceScope.Begin(policyId, CacheL1Operation.Typed);
        CacheL1HitObservation l1Observation = telemetry.BeginL1Hit(policyId, CacheL1Operation.Typed);
        l1Evidence = l1Evidence.Pause();
        CachePolicy policy = ResolvePolicy(policyId);
        CacheL1Key l1Key = identity.ToL1Key(keyScope.ScopeToken, policyId);
        cancellationToken.ThrowIfCancellationRequested();
        if (TryAcquireL1(l1Key, out PolicyShardedCacheL1Store.CacheL1ReadLease l1Lease))
        {
            using (l1Lease)
            {
                ReadOnlyMemory<byte> l1Bytes = l1Lease.Memory;
                if (l1Bytes.Length == 0)
                {
                    l1Evidence = l1Evidence.Resume();
                    telemetry.RecordL1Hit(policyId, CacheL1Operation.Typed, negative: true, l1Observation);
                    _ = l1Evidence.Complete(l1Observation.Sampled, "hit-negative");
                    RuntimeCacheEvidenceObservation.Current?.RecordCacheEvent(
                        "typed-l1",
                        RuntimeEvidenceIdentity(identity),
                        "negative");
                    return new CacheReadResult<T>(true, default);
                }

                var (l1Success, l1Value) = decoder(l1Bytes);
                if (l1Success)
                {
                    l1Evidence = l1Evidence.Resume();
                    telemetry.RecordL1Hit(policyId, CacheL1Operation.Typed, negative: false, l1Observation);
                    _ = l1Evidence.Complete(l1Observation.Sampled, "hit");
                    RuntimeCacheEvidenceObservation.Current?.RecordCacheEvent(
                        "typed-l1",
                        RuntimeEvidenceIdentity(identity),
                        "hit");
                    return new CacheReadResult<T>(true, l1Value);
                }
            }

            _ = l1Evidence.Complete(l1Observation.Sampled, "decode-failed");
            RuntimeCacheEvidenceObservation.Current?.RecordCacheEvent(
                "typed-l1",
                RuntimeEvidenceIdentity(identity),
                "invalidated");
            string corruptRedisKey = BuildRedisKey(policy, identity);
            RemoveL1(l1Key, corruptRedisKey);
            cancellationToken.ThrowIfCancellationRequested();
            _ = await ExecuteDatabaseAsync(
                ResolveMutationPort(policyId),
                (database, _) => database.KeyDeleteAsync(corruptRedisKey),
                cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            await UnregisterKeyAsync(policyId, corruptRedisKey).ConfigureAwait(false);
            using Activity? decodeActivity = FsusObservability.StartActivity("cache.get", "cache", ActivityKind.Client);
            FsusObservability.SetTag(decodeActivity, "fsus.cache.operation", "get");
            string decodePolicyName = CachePolicyTelemetry.Name(policyId);
            FsusObservability.SetTag(decodeActivity, "fsus.cache.policy", decodePolicyName);
            decodeActivity?.SetStatus(ActivityStatusCode.Error, "cache_decode_failed");
            logger.LogWarning("Cache decode failed for policy {PolicyId} at {CacheLayer}", decodePolicyName, "l1");
            telemetry.RecordOperation("get", decodePolicyName, "l1", "decode_failed", l1Observation.Sampled ? FsusObservability.GetElapsed(l1Observation.StartedAt) : TimeSpan.Zero);
            return new CacheReadResult<T>(false, default);
        }

        _ = l1Evidence.Complete(l1Observation.Sampled, "miss");
        long startedAt = Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.get", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "get");
        string policyName = CachePolicyTelemetry.Name(policyId);
        FsusObservability.SetTag(activity, "fsus.cache.policy", policyName);
        string key = BuildRedisKey(policy, identity);
        cancellationToken.ThrowIfCancellationRequested();
        RedisValue l2Value = await ReadRedisAsync(policyId, key, "get", policyName, activity, startedAt, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (l2Value.IsNull)
        {
            telemetry.RecordOperation("get", policyName, "l2", "miss", FsusObservability.GetElapsed(startedAt));
            return new CacheReadResult<T>(false, default);
        }

        byte[] bytes = (byte[])l2Value!;
        if (bytes.Length == 0)
        {
            SetL1(policy, l1Key, key, bytes);
            telemetry.RecordOperation("get", policyName, "l2", "hit_negative", FsusObservability.GetElapsed(startedAt));
            return new CacheReadResult<T>(true, default);
        }

        var (success, value) = decoder(bytes);
        if (!success)
        {
            _ = await ExecuteDatabaseAsync(
                ResolveMutationPort(policyId),
                (database, _) => database.KeyDeleteAsync(key),
                cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            await UnregisterKeyAsync(policyId, key).ConfigureAwait(false);
            activity?.SetStatus(ActivityStatusCode.Error, "cache_decode_failed");
            logger.LogWarning("Cache decode failed for policy {PolicyId} at {CacheLayer}", policyName, "l2");
            telemetry.RecordOperation("get", policyName, "l2", "decode_failed", FsusObservability.GetElapsed(startedAt));
            return new CacheReadResult<T>(false, default);
        }

        SetL1(policy, l1Key, key, bytes);
        telemetry.RecordOperation("get", policyName, "l2", "hit", FsusObservability.GetElapsed(startedAt));
        return new CacheReadResult<T>(true, value);
    }

    public Task<CacheReadResult<byte[]>> TryGetRawAsync(
        CachePolicyId policyId,
        string identity,
        CancellationToken cancellationToken = default)
        => TryGetRawCoreAsync(policyId, CacheIdentity.FromString(identity), cancellationToken);

    public Task<CacheReadResult<byte[]>> TryGetRawAsync(
        CachePolicyId policyId,
        int identity,
        CancellationToken cancellationToken = default)
        => TryGetRawCoreAsync(policyId, CacheIdentity.FromInteger(identity), cancellationToken);

    private async Task<CacheReadResult<byte[]>> TryGetRawCoreAsync(
        CachePolicyId policyId,
        CacheIdentity identity,
        CancellationToken cancellationToken)
    {
        CacheL1HitObservation l1Observation = telemetry.BeginL1Hit(policyId, CacheL1Operation.Raw);
        CachePolicy policy = ResolvePolicy(policyId);
        CacheL1Key l1Key = identity.ToL1Key(keyScope.ScopeToken, policyId);
        cancellationToken.ThrowIfCancellationRequested();
        if (TryAcquireL1(l1Key, out PolicyShardedCacheL1Store.CacheL1ReadLease l1Lease))
        {
            using (l1Lease)
            {
                telemetry.RecordL1Hit(policyId, CacheL1Operation.Raw, negative: false, l1Observation);
                return new CacheReadResult<byte[]>(true, l1Lease.Memory.ToArray());
            }
        }

        long startedAt = Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.get_raw", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "get_raw");
        string policyName = CachePolicyTelemetry.Name(policyId);
        FsusObservability.SetTag(activity, "fsus.cache.policy", policyName);
        string key = BuildRedisKey(policy, identity);
        RedisValue l2Value = await ReadRedisAsync(policyId, key, "get_raw", policyName, activity, startedAt, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (l2Value.IsNull)
        {
            telemetry.RecordOperation("get_raw", policyName, "l2", "miss", FsusObservability.GetElapsed(startedAt));
            return new CacheReadResult<byte[]>(false, default);
        }

        byte[] bytes = (byte[])l2Value!;
        SetL1(policy, l1Key, key, bytes);
        telemetry.RecordOperation("get_raw", policyName, "l2", "hit", FsusObservability.GetElapsed(startedAt));
        return new CacheReadResult<byte[]>(true, CopyRawBytes(bytes));
    }

    public Task<CacheReadResult<ReadOnlyMemory<byte>>> TryGetRawReadonlyAsync(
        CachePolicyId policyId,
        string identity,
        CancellationToken cancellationToken = default)
        => TryGetRawReadonlyCoreAsync(policyId, CacheIdentity.FromString(identity), cancellationToken);

    public Task<CacheReadResult<ReadOnlyMemory<byte>>> TryGetRawReadonlyAsync(
        CachePolicyId policyId,
        int identity,
        CancellationToken cancellationToken = default)
        => TryGetRawReadonlyCoreAsync(policyId, CacheIdentity.FromInteger(identity), cancellationToken);

    private async Task<CacheReadResult<ReadOnlyMemory<byte>>> TryGetRawReadonlyCoreAsync(
        CachePolicyId policyId,
        CacheIdentity identity,
        CancellationToken cancellationToken)
    {
        CacheL1HitObservation l1Observation = telemetry.BeginL1Hit(policyId, CacheL1Operation.Readonly);
        CachePolicy policy = ResolvePolicy(policyId);
        CacheL1Key l1Key = identity.ToL1Key(keyScope.ScopeToken, policyId);
        cancellationToken.ThrowIfCancellationRequested();
        if (TryAcquireL1(l1Key, out PolicyShardedCacheL1Store.CacheL1ReadLease l1Lease))
        {
            using (l1Lease)
            {
                telemetry.RecordL1Hit(policyId, CacheL1Operation.Readonly, negative: false, l1Observation);
                return new CacheReadResult<ReadOnlyMemory<byte>>(true, l1Lease.Memory.ToArray());
            }
        }

        long startedAt = Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.get_raw_readonly", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "get_raw_readonly");
        string policyName = CachePolicyTelemetry.Name(policyId);
        FsusObservability.SetTag(activity, "fsus.cache.policy", policyName);
        string key = BuildRedisKey(policy, identity);
        RedisValue l2Value = await ReadRedisAsync(policyId, key, "get_raw_readonly", policyName, activity, startedAt, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (l2Value.IsNull)
        {
            telemetry.RecordOperation("get_raw_readonly", policyName, "l2", "miss", FsusObservability.GetElapsed(startedAt));
            return new CacheReadResult<ReadOnlyMemory<byte>>(false, default);
        }

        byte[] bytes = (byte[])l2Value!;
        SetL1(policy, l1Key, key, bytes);
        telemetry.RecordOperation("get_raw_readonly", policyName, "l2", "hit", FsusObservability.GetElapsed(startedAt));
        return new CacheReadResult<ReadOnlyMemory<byte>>(true, bytes.ToArray());
    }

    public Task<OwnedFrameCacheReadResult> TryGetOwnedFrameAsync(
        CachePolicyId policyId,
        string identity,
        AedsFrameType expectedFrameType,
        CancellationToken cancellationToken = default)
        => TryGetOwnedFrameCoreAsync(
            policyId,
            CacheIdentity.FromString(identity),
            expectedFrameType,
            cancellationToken);

    public Task<OwnedFrameCacheReadResult> TryGetOwnedFrameAsync(
        CachePolicyId policyId,
        int identity,
        AedsFrameType expectedFrameType,
        CancellationToken cancellationToken = default)
        => TryGetOwnedFrameCoreAsync(
            policyId,
            CacheIdentity.FromInteger(identity),
            expectedFrameType,
            cancellationToken);

    private async Task<OwnedFrameCacheReadResult> TryGetOwnedFrameCoreAsync(
        CachePolicyId policyId,
        CacheIdentity identity,
        AedsFrameType expectedFrameType,
        CancellationToken cancellationToken)
    {
        ThrowIfDisposed();
        CacheL1HitObservation l1Observation = telemetry.BeginL1Hit(policyId, CacheL1Operation.OwnedFrame);
        CachePolicy policy = ResolvePolicy(policyId);
        CacheL1Key l1Key = identity.ToL1Key(keyScope.ScopeToken, policyId);
        cancellationToken.ThrowIfCancellationRequested();
        if (TryGetOwnedL1(l1Key, expectedFrameType, out OwnedAedsFrameReadLease? l1Lease))
        {
            telemetry.RecordL1Hit(policyId, CacheL1Operation.OwnedFrame, negative: false, l1Observation);
            return new OwnedFrameCacheReadResult(true, l1Lease);
        }
        if (TryGetNegativeL1(l1Key))
        {
            telemetry.RecordL1Hit(policyId, CacheL1Operation.OwnedFrame, negative: true, l1Observation);
            return OwnedFrameCacheReadResult.NegativeHit;
        }

        long startedAt = Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.get_owned_frame", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "get_owned_frame");
        string policyName = CachePolicyTelemetry.Name(policyId);
        FsusObservability.SetTag(activity, "fsus.cache.policy", policyName);
        string key = BuildRedisKey(policy, identity);
        await using IAsyncDisposable mutationGate = await coordination.AcquireMutationAsync(
                key,
                cancellationToken)
            .ConfigureAwait(false);
        ThrowIfDisposed();
        cancellationToken.ThrowIfCancellationRequested();
        if (TryGetOwnedL1(l1Key, expectedFrameType, out l1Lease))
        {
            telemetry.RecordOperation("get_owned_frame", policyName, "l1", "hit_after_wait", FsusObservability.GetElapsed(startedAt));
            return new OwnedFrameCacheReadResult(true, l1Lease);
        }
        if (TryGetNegativeL1(l1Key))
        {
            telemetry.RecordOperation("get_owned_frame", policyName, "l1", "hit_negative_after_wait", FsusObservability.GetElapsed(startedAt));
            return OwnedFrameCacheReadResult.NegativeHit;
        }

        RedisValue l2Value = await ReadRedisAsync(
                policyId,
                key,
                "get_owned_frame",
                policyName,
                activity,
                startedAt,
                cancellationToken)
            .ConfigureAwait(false);
        if (l2Value.IsNull)
        {
            cancellationToken.ThrowIfCancellationRequested();
            telemetry.RecordOperation("get_owned_frame", policyName, "l2", "miss", FsusObservability.GetElapsed(startedAt));
            return default;
        }

        byte[]? bytes = (byte[])l2Value!;
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (bytes.Length == 0)
            {
                SetL1(policy, l1Key, key, bytes);
                bytes = null;
                telemetry.RecordOperation("get_owned_frame", policyName, "l2", "hit_negative", FsusObservability.GetElapsed(startedAt));
                return OwnedFrameCacheReadResult.NegativeHit;
            }

            Result<AedsDecodeResult> decoded = new AedsEncoder().TryDecode(bytes);
            if (!decoded.IsSuccess || decoded.Value.FrameType != expectedFrameType)
            {
                _ = await ExecuteDatabaseAsync(
                    ResolveMutationPort(policyId),
                    (database, _) => database.KeyDeleteAsync(key),
                    cancellationToken).ConfigureAwait(false);
                cancellationToken.ThrowIfCancellationRequested();
                await UnregisterKeyAsync(policyId, key).ConfigureAwait(false);
                RemoveL1(l1Key, key);
                activity?.SetStatus(ActivityStatusCode.Error, "cache_frame_validation_failed");
                logger.LogWarning(
                    "Owned cache frame validation failed for policy {PolicyId}; expected {ExpectedFrameType}",
                    policyName,
                    expectedFrameType);
                telemetry.RecordOperation("get_owned_frame", policyName, "l2", "decode_failed", FsusObservability.GetElapsed(startedAt));
                return default;
            }

            OwnedAedsFrame owner = OwnedAedsFrame.TakeOwnership(bytes, expectedFrameType);
            bytes = null;
            OwnedAedsFrameReadLease? responseLease = null;
            try
            {
                responseLease = owner.AcquireReadLease();
                bool installed = SetOwnedL1(policy, l1Key, key, owner);
                if (!installed)
                {
                    owner.Retire();
                }

                telemetry.RecordOperation("get_owned_frame", policyName, "l2", "hit", FsusObservability.GetElapsed(startedAt));
                return new OwnedFrameCacheReadResult(true, responseLease);
            }
            catch
            {
                responseLease?.Dispose();
                owner.Retire();
                throw;
            }
        }
        finally
        {
            // Any byte[] that did not reach an owner is an invalid/cancelled boundary. Clear it
            // conservatively because a corrupted frame cannot be trusted to identify its own
            // sensitivity class.
            bytes?.AsSpan().Clear();
        }
    }

    public async Task SetOwnedFrameAsync(
        CachePolicyId policyId,
        string identity,
        OwnedAedsFrame frame,
        TimeSpan? l2TtlOverride = null,
        CancellationToken cancellationToken = default)
    {
        _ = await SetOwnedFrameCoreAsync(
                policyId,
                CacheIdentity.FromString(identity),
                frame,
                l2TtlOverride,
                publicationGuard: null,
                cancellationToken)
            .ConfigureAwait(false);
    }

    public Task<bool> TrySetOwnedFrameAsync(
        CachePolicyId policyId,
        string identity,
        OwnedAedsFrame frame,
        OwnedFramePublicationGuard publicationGuard,
        TimeSpan? l2TtlOverride = null,
        CancellationToken cancellationToken = default)
        => SetOwnedFrameCoreAsync(
            policyId,
            CacheIdentity.FromString(identity),
            frame,
            l2TtlOverride,
            publicationGuard,
            cancellationToken);

    public async Task SetOwnedFrameAsync(
        CachePolicyId policyId,
        int identity,
        OwnedAedsFrame frame,
        TimeSpan? l2TtlOverride = null,
        CancellationToken cancellationToken = default)
    {
        _ = await SetOwnedFrameCoreAsync(
                policyId,
                CacheIdentity.FromInteger(identity),
                frame,
                l2TtlOverride,
                publicationGuard: null,
                cancellationToken)
            .ConfigureAwait(false);
    }

    private async Task<bool> SetOwnedFrameCoreAsync(
        CachePolicyId policyId,
        CacheIdentity identity,
        OwnedAedsFrame frame,
        TimeSpan? l2TtlOverride,
        OwnedFramePublicationGuard? publicationGuard,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(frame);
        bool installed = false;

        try
        {
            ThrowIfDisposed();
            long startedAt = Stopwatch.GetTimestamp();
            using Activity? activity = FsusObservability.StartActivity("cache.set_owned_frame", "cache", ActivityKind.Client);
            FsusObservability.SetTag(activity, "fsus.cache.operation", "set_owned_frame");
            string policyName = CachePolicyTelemetry.Name(policyId);
            FsusObservability.SetTag(activity, "fsus.cache.policy", policyName);
            CachePolicy policy = ResolvePolicy(policyId);
            CacheL1Key l1Key = identity.ToL1Key(keyScope.ScopeToken, policyId);
            string key = BuildRedisKey(policy, identity);
            TimeSpan? l2Ttl = ResolveL2Expiry(key, policy, l2TtlOverride);
            cancellationToken.ThrowIfCancellationRequested();
            await using IAsyncDisposable mutationGate = await coordination.AcquireMutationAsync(
                    key,
                    cancellationToken)
                .ConfigureAwait(false);
            ThrowIfDisposed();
            cancellationToken.ThrowIfCancellationRequested();
            using OwnedAedsFrameReadLease writeLease = frame.AcquireReadLease();
            RedisValue redisValue = writeLease.Memory;
            bool published = await PublishValueAsync(
                    policyId,
                    key,
                    redisValue,
                    l2Ttl,
                    publicationGuard,
                    cancellationToken)
                .ConfigureAwait(false);
            if (!published)
            {
                return false;
            }
            cancellationToken.ThrowIfCancellationRequested();
            installed = SetOwnedL1(policy, l1Key, key, frame);

            OwnedFrameCacheTelemetry.RecordBuild(
                policyId,
                frame.FrameType,
                frame.LogicalLength,
                frame.Capacity,
                frame.IsPooled ? "pooled" : "exact");
            telemetry.RecordOperation("set_owned_frame", policyName, "l2", "ok", FsusObservability.GetElapsed(startedAt));
            return true;
        }
        finally
        {
            if (!installed)
            {
                frame.Retire();
            }
        }
    }

    public OwnedFrameCacheResidencySnapshot GetOwnedFrameResidencySnapshot()
    {
        lock (_l1MutationLock)
        {
            return new OwnedFrameCacheResidencySnapshot(
                _ownedFrameEntryCount,
                _ownedFrameLogicalBytes,
                _ownedFrameCapacityBytes);
        }
    }

    public Task SetRawAsync(
        CachePolicyId policyId,
        string identity,
        byte[] value,
        TimeSpan? l2TtlOverride = null,
        CancellationToken cancellationToken = default)
        => SetRawCoreAsync(policyId, CacheIdentity.FromString(identity), value, l2TtlOverride, cancellationToken);

    public Task SetRawAsync(
        CachePolicyId policyId,
        int identity,
        byte[] value,
        TimeSpan? l2TtlOverride = null,
        CancellationToken cancellationToken = default)
        => SetRawCoreAsync(policyId, CacheIdentity.FromInteger(identity), value, l2TtlOverride, cancellationToken);

    private async Task SetRawCoreAsync(
        CachePolicyId policyId,
        CacheIdentity identity,
        byte[] value,
        TimeSpan? l2TtlOverride,
        CancellationToken cancellationToken)
    {
        long startedAt = Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.set", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "set");
        string policyName = CachePolicyTelemetry.Name(policyId);
        FsusObservability.SetTag(activity, "fsus.cache.policy", policyName);
        cancellationToken.ThrowIfCancellationRequested();
        CachePolicy policy = ResolvePolicy(policyId);
        CacheL1Key l1Key = identity.ToL1Key(keyScope.ScopeToken, policyId);
        string key = BuildRedisKey(policy, identity);
        TimeSpan? l2Ttl = ResolveL2Expiry(key, policy, l2TtlOverride);
        byte[] cachedValue = CopyRawBytes(value);
        cancellationToken.ThrowIfCancellationRequested();
        _ = await PublishValueAsync(policyId, key, cachedValue, l2Ttl, null, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        SetL1(policy, l1Key, key, cachedValue);
        telemetry.RecordOperation("set", policyName, "l2", "ok", FsusObservability.GetElapsed(startedAt));
    }

    public Task SetNegativeAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
        => SetNegativeCoreAsync(policyId, identity, cancellationToken);

    public async Task<string?> GetStringAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
    {
        CacheReadResult<string> read = await TryGetAsync<string>(policyId, identity, static bytes => (true, System.Text.Encoding.UTF8.GetString(bytes.Span)), cancellationToken);
        return read.Hit ? read.Value : null;
    }

    public async Task SetStringAsync(CachePolicyId policyId, string identity, string value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default)
    {
        await SetRawAsync(policyId, identity, System.Text.Encoding.UTF8.GetBytes(value), l2TtlOverride, cancellationToken);
    }

    public async Task<bool> TrySetStringIfValueAsync(
        CachePolicyId policyId,
        string identity,
        string value,
        string compareIdentity,
        string expectedCompareValue,
        TimeSpan? l2TtlOverride = null,
        CancellationToken cancellationToken = default)
    {
        long startedAt = Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.set_cas", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "set_cas");
        string policyName = CachePolicyTelemetry.Name(policyId);
        FsusObservability.SetTag(activity, "fsus.cache.policy", policyName);
        CacheIdentity cacheIdentity = CacheIdentity.FromString(identity);
        CacheL1Key l1Key = cacheIdentity.ToL1Key(keyScope.ScopeToken, policyId);
        CachePolicy policy = ResolvePolicy(policyId);
        string key = BuildRedisKey(policy, cacheIdentity);
        string compareKey = BuildKey(policyId, compareIdentity);
        cancellationToken.ThrowIfCancellationRequested();
        TimeSpan? l2Ttl = ResolveL2Expiry(key, policy, l2TtlOverride);
        byte[] cachedValue = System.Text.Encoding.UTF8.GetBytes(value);
        RemoveL1(l1Key, key);
        cancellationToken.ThrowIfCancellationRequested();
        bool committed = await ExecuteDatabaseAsync(
            ResolveMutationPort(policyId),
            async (database, _) =>
            {
                ITransaction transaction = database.CreateTransaction();
                transaction.AddCondition(Condition.StringEqual(compareKey, expectedCompareValue));
                Task<bool> setTask = transaction.StringSetAsync(key, cachedValue, l2Ttl, When.Always, CommandFlags.None);
                bool executed = await transaction.ExecuteAsync(CommandFlags.None).ConfigureAwait(false);
                return executed && await setTask.ConfigureAwait(false);
            },
            cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (!committed)
        {
            telemetry.RecordOperation("set_cas", policyName, "l2", "conflict", FsusObservability.GetElapsed(startedAt));
            return false;
        }

        await RegisterKeyAsync(policyId, key, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        SetL1(policy, l1Key, key, cachedValue);
        telemetry.RecordOperation("set_cas", policyName, "l2", "ok", FsusObservability.GetElapsed(startedAt));
        return true;
    }

    public async Task<bool> TrySetVersionedStringAsync(
        CachePolicyId policyId,
        string identity,
        string value,
        string version,
        bool allowOverwrite = false,
        TimeSpan? l2TtlOverride = null,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(version))
        {
            throw new ArgumentException("Cache version must be non-empty.", nameof(version));
        }

        long startedAt = Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.set_versioned", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "set_versioned");
        string policyName = CachePolicyTelemetry.Name(policyId);
        FsusObservability.SetTag(activity, "fsus.cache.policy", policyName);
        CacheIdentity cacheIdentity = CacheIdentity.FromString(identity);
        CacheL1Key l1Key = cacheIdentity.ToL1Key(keyScope.ScopeToken, policyId);
        CachePolicy policy = ResolvePolicy(policyId);
        string key = BuildRedisKey(policy, cacheIdentity);
        cancellationToken.ThrowIfCancellationRequested();
        TimeSpan? l2Ttl = ResolveL2Expiry(key, policy, l2TtlOverride);
        long ttlMilliseconds = l2Ttl.HasValue
            ? Math.Max(1L, (long)Math.Ceiling(l2Ttl.Value.TotalMilliseconds))
            : -1L;
        RemoveL1(l1Key, key);
        cancellationToken.ThrowIfCancellationRequested();
        const string Script = """
local current = redis.call('GET', KEYS[1])
if current then
  local first = string.find(current, '|', 1, true)
  local second = nil
  if first then
    second = string.find(current, '|', first + 1, true)
  end
  local payloadVersion = first and string.sub(current, 1, first - 1) or ''
  if not first or not second or (payloadVersion ~= 'v1' and payloadVersion ~= 'v2' and payloadVersion ~= 'v3') then
    return 0
  end
  local currentVersion = string.sub(current, first + 1, second - 1)
  if ARGV[4] == '0' then
    if currentVersion ~= ARGV[2] then
      return 0
    end
  else
    local currentNumeric = tonumber(currentVersion)
    local incomingNumeric = tonumber(ARGV[2])
    if currentNumeric and incomingNumeric and incomingNumeric < currentNumeric then
      return 0
    end
  end
end
if tonumber(ARGV[3]) and tonumber(ARGV[3]) > 0 then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[3])
else
  redis.call('SET', KEYS[1], ARGV[1])
end
return 1
""";
        RedisResult result = await ExecuteDatabaseAsync(
            ResolveMutationPort(policyId),
            (database, _) => database.ScriptEvaluateAsync(
                Script,
                [key],
                [value, version, ttlMilliseconds, allowOverwrite ? "1" : "0"],
                CommandFlags.None),
            cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        bool updated = (long)result == 1L;
        if (!updated)
        {
            telemetry.RecordOperation("set_versioned", policyName, "l2", "conflict", FsusObservability.GetElapsed(startedAt));
            return false;
        }

        await RegisterKeyAsync(policyId, key, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        SetL1(policy, l1Key, key, System.Text.Encoding.UTF8.GetBytes(value));
        telemetry.RecordOperation("set_versioned", policyName, "l2", "ok", FsusObservability.GetElapsed(startedAt));
        return true;
    }

    public async Task<long> IncrementAsync(CachePolicyId policyId, string identity, long value = 1, CancellationToken cancellationToken = default)
    {
        long startedAt = Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.increment", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "increment");
        FsusObservability.SetTag(activity, "fsus.cache.policy", CachePolicyTelemetry.Name(policyId));
        cancellationToken.ThrowIfCancellationRequested();
        string key = BuildKey(policyId, identity);
        RemoveL1(policyId, CacheIdentity.FromString(identity), key);
        cancellationToken.ThrowIfCancellationRequested();
        long updated = await ExecuteDatabaseAsync(
            ResolveCounterPort(policyId),
            (database, _) => database.StringIncrementAsync(key, value),
            cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        await RegisterKeyAsync(policyId, key, cancellationToken).ConfigureAwait(false);
        telemetry.RecordOperation("increment", CachePolicyTelemetry.Name(policyId), "l2", "ok", FsusObservability.GetElapsed(startedAt));
        return updated;
    }

    public async Task<long[]> IncrementManyAsync(
        CachePolicyId policyId,
        IReadOnlyList<string> identities,
        long value = 1,
        CancellationToken cancellationToken = default)
    {
        if (identities.Count == 0)
        {
            return [];
        }

        long startedAt = Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.increment_many", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "increment_many");
        FsusObservability.SetTag(activity, "fsus.cache.policy", CachePolicyTelemetry.Name(policyId));
        cancellationToken.ThrowIfCancellationRequested();
        RedisKey[] keys = new RedisKey[identities.Count];
        string[] keyStrings = new string[identities.Count];
        for (int i = 0; i < identities.Count; i++)
        {
            string key = BuildKey(policyId, identities[i]);
            keyStrings[i] = key;
            keys[i] = key;
            RemoveL1(policyId, CacheIdentity.FromString(identities[i]), key);
        }

        cancellationToken.ThrowIfCancellationRequested();
        const string Script = """
local result = {}
for i = 1, #KEYS do
  result[i] = redis.call('INCRBY', KEYS[i], ARGV[1])
end
return result
""";
        RedisResult result = await ExecuteDatabaseAsync(
            ResolveCounterPort(policyId),
            (database, _) => database.ScriptEvaluateAsync(
                Script,
                keys,
                [value],
                CommandFlags.None),
            cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        RedisResult[] values = (RedisResult[])result!;
        if (values.Length != keys.Length)
        {
            throw new InvalidOperationException("Redis returned an invalid multi-counter increment result.");
        }

        long[] updated = new long[values.Length];
        for (int i = 0; i < keys.Length; i++)
        {
            updated[i] = (long)values[i];
            await RegisterKeyAsync(policyId, keyStrings[i], cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
        }

        telemetry.RecordOperation("increment_many", CachePolicyTelemetry.Name(policyId), "l2", "ok", FsusObservability.GetElapsed(startedAt));
        return updated;
    }

    public async Task<long> IncrementWithExpiryAsync(
        CachePolicyId policyId,
        string identity,
        TimeSpan ttl,
        long value = 1,
        CancellationToken cancellationToken = default)
    {
        if (ttl <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(ttl), "Counter expiry must be positive.");
        }

        long startedAt = Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.increment_expiring", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "increment_expiring");
        FsusObservability.SetTag(activity, "fsus.cache.policy", CachePolicyTelemetry.Name(policyId));
        cancellationToken.ThrowIfCancellationRequested();
        string key = BuildKey(policyId, identity);
        RemoveL1(policyId, CacheIdentity.FromString(identity), key);
        cancellationToken.ThrowIfCancellationRequested();
        const string Script = """
local current = redis.call('INCRBY', KEYS[1], ARGV[1])
if redis.call('PTTL', KEYS[1]) < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return current
""";
        long ttlMilliseconds = Math.Max(1L, (long)Math.Ceiling(ttl.TotalMilliseconds));
        RedisResult result = await ExecuteDatabaseAsync(
            ResolveCounterPort(policyId),
            (database, _) => database.ScriptEvaluateAsync(
                Script,
                [key],
                [value, ttlMilliseconds],
                CommandFlags.None),
            cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        await RegisterKeyAsync(policyId, key, cancellationToken).ConfigureAwait(false);
        telemetry.RecordOperation("increment_expiring", CachePolicyTelemetry.Name(policyId), "l2", "ok", FsusObservability.GetElapsed(startedAt));
        return (long)result;
    }

    public async Task<long> IncrementClampedWithExpiryAsync(
        CachePolicyId policyId,
        string identity,
        long delta,
        long maxValue,
        TimeSpan ttl,
        CancellationToken cancellationToken = default)
    {
        if (ttl <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(ttl), "Counter expiry must be positive.");
        }

        if (maxValue < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(maxValue), "Counter max value must be non-negative.");
        }

        long startedAt = Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.increment_clamped_expiring", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "increment_clamped_expiring");
        FsusObservability.SetTag(activity, "fsus.cache.policy", CachePolicyTelemetry.Name(policyId));
        cancellationToken.ThrowIfCancellationRequested();
        string key = BuildKey(policyId, identity);
        RemoveL1(policyId, CacheIdentity.FromString(identity), key);
        cancellationToken.ThrowIfCancellationRequested();
        long ttlMilliseconds = Math.Max(1L, (long)Math.Ceiling(ttl.TotalMilliseconds));
        delta = Math.Clamp(delta, -maxValue, maxValue);
        const string Script = """
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local nextValue = current + tonumber(ARGV[1])
local maxValue = tonumber(ARGV[2])
if nextValue < 0 then
  nextValue = 0
end
if nextValue > maxValue then
  nextValue = maxValue
end
redis.call('SET', KEYS[1], tostring(nextValue))
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return nextValue
""";
        RedisResult result = await ExecuteDatabaseAsync(
            ResolveCounterPort(policyId),
            (database, _) => database.ScriptEvaluateAsync(
                Script,
                [key],
                [delta, maxValue, ttlMilliseconds],
                CommandFlags.None),
            cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        await RegisterKeyAsync(policyId, key, cancellationToken).ConfigureAwait(false);
        telemetry.RecordOperation("increment_clamped_expiring", CachePolicyTelemetry.Name(policyId), "l2", "ok", FsusObservability.GetElapsed(startedAt));
        return (long)result;
    }

    public async Task<long[]> IncrementManyWithExpiryAsync(
        CachePolicyId policyId,
        IReadOnlyList<string> identities,
        TimeSpan ttl,
        long value = 1,
        CancellationToken cancellationToken = default)
    {
        if (identities.Count == 0)
        {
            return [];
        }

        if (ttl <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(ttl), "Counter expiry must be positive.");
        }

        long startedAt = Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.increment_many_expiring", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "increment_many_expiring");
        FsusObservability.SetTag(activity, "fsus.cache.policy", CachePolicyTelemetry.Name(policyId));
        cancellationToken.ThrowIfCancellationRequested();
        RedisKey[] keys = new RedisKey[identities.Count];
        string[] keyStrings = new string[identities.Count];
        for (int i = 0; i < identities.Count; i++)
        {
            string key = BuildKey(policyId, identities[i]);
            keyStrings[i] = key;
            keys[i] = key;
            RemoveL1(policyId, CacheIdentity.FromString(identities[i]), key);
        }

        cancellationToken.ThrowIfCancellationRequested();
        const string Script = """
local result = {}
local expiryApplied = 0
for i = 1, #KEYS do
  result[i] = redis.call('INCRBY', KEYS[i], ARGV[1])
  if redis.call('PTTL', KEYS[i]) < 0 then
    redis.call('PEXPIRE', KEYS[i], ARGV[2])
    expiryApplied = expiryApplied + 1
  end
end
result[#KEYS + 1] = expiryApplied
return result
""";
        long ttlMilliseconds = Math.Max(1L, (long)Math.Ceiling(ttl.TotalMilliseconds));
        RedisResult result = await ExecuteDatabaseAsync(
            ResolveCounterPort(policyId),
            (database, _) => database.ScriptEvaluateAsync(
                Script,
                keys,
                [value, ttlMilliseconds],
                CommandFlags.None),
            cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        RedisResult[] values = (RedisResult[])result!;
        if (values.Length != keys.Length && values.Length != keys.Length + 1)
        {
            throw new InvalidOperationException("Redis returned an invalid expiring multi-counter increment result.");
        }

        long expiryApplied = values.Length == keys.Length + 1 ? (long)values[^1] : 0;
        long[] updated = new long[keys.Length];
        for (int i = 0; i < keys.Length; i++)
        {
            updated[i] = (long)values[i];
            await RegisterKeyAsync(policyId, keyStrings[i], cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
        }

        TimeSpan elapsed = FsusObservability.GetElapsed(startedAt);
        string policyName = CachePolicyTelemetry.Name(policyId);
        telemetry.RecordOperation("increment_many_expiring", policyName, "l2", "ok", elapsed);
        FsusObservability.RecordIncrementManyWithExpiry(policyName, keys.Length, expiryApplied, elapsed);
        if (policyId == CachePolicyId.SecurityMfaChallenge)
        {
            FsusObservability.RecordMfaCounterExpired(expiryApplied);
        }

        return updated;
    }

    public async Task<bool> TryAcquireLeaseAsync(CachePolicyId policyId, string identity, string value, TimeSpan ttl, CancellationToken cancellationToken = default)
    {
        long startedAt = Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.lease", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "lease");
        FsusObservability.SetTag(activity, "fsus.cache.policy", CachePolicyTelemetry.Name(policyId));
        string key = BuildKey(policyId, identity);
        bool acquired = await ExecuteDatabaseAsync(
            RedisOperationPort.UnifiedCacheLease,
            (database, _) => database.StringSetAsync(key, value, ttl, When.NotExists),
            cancellationToken).ConfigureAwait(false);
        telemetry.RecordOperation("lease", CachePolicyTelemetry.Name(policyId), "l2", acquired ? "acquired" : "contended", FsusObservability.GetElapsed(startedAt));
        return acquired;
    }

    public async Task<bool> TryRenewLeaseAsync(
        CachePolicyId policyId,
        string identity,
        string expectedValue,
        TimeSpan ttl,
        CancellationToken cancellationToken = default)
    {
        long startedAt = Stopwatch.GetTimestamp();
        string policyName = CachePolicyTelemetry.Name(policyId);
        using Activity? activity = FsusObservability.StartActivity("cache.lease_renew", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "lease_renew");
        FsusObservability.SetTag(activity, "fsus.cache.policy", policyName);
        cancellationToken.ThrowIfCancellationRequested();
        string key = BuildKey(policyId, identity);
        const string Script = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
""";
        RedisResult result = await ExecuteDatabaseAsync(
            RedisOperationPort.UnifiedCacheLease,
            (database, _) => database.ScriptEvaluateAsync(
                Script,
                [key],
                [expectedValue, checked((long)ttl.TotalMilliseconds)],
                CommandFlags.None),
            cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        bool renewed = (long)result == 1L;
        telemetry.RecordOperation("lease_renew", policyName, "l2", renewed ? "renewed" : "lost", FsusObservability.GetElapsed(startedAt));
        return renewed;
    }

    public async Task<bool> TryReleaseLeaseAsync(
        CachePolicyId policyId,
        string identity,
        string expectedValue,
        CancellationToken cancellationToken = default)
    {
        long startedAt = Stopwatch.GetTimestamp();
        string policyName = CachePolicyTelemetry.Name(policyId);
        using Activity? activity = FsusObservability.StartActivity("cache.lease_release", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "lease_release");
        FsusObservability.SetTag(activity, "fsus.cache.policy", policyName);
        string key = BuildKey(policyId, identity);
        const string Script = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
""";
        RedisResult result = await ExecuteDatabaseAsync(
            RedisOperationPort.UnifiedCacheLease,
            (database, _) => database.ScriptEvaluateAsync(
                Script,
                [key],
                [expectedValue],
                CommandFlags.None),
            cancellationToken).ConfigureAwait(false);
        bool released = (long)result == 1L;
        telemetry.RecordOperation("lease_release", policyName, "l2", released ? "released" : "lost", FsusObservability.GetElapsed(startedAt));
        return released;
    }

    public async Task<bool> ConsumeOnceAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
    {
        long startedAt = Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.consume_once", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "consume_once");
        FsusObservability.SetTag(activity, "fsus.cache.policy", CachePolicyTelemetry.Name(policyId));
        cancellationToken.ThrowIfCancellationRequested();
        string key = BuildKey(policyId, identity);
        RemoveL1(policyId, CacheIdentity.FromString(identity), key);
        cancellationToken.ThrowIfCancellationRequested();
        bool ok = await ExecuteDatabaseAsync(
            RedisOperationPort.UnifiedCacheAtomic,
            async (database, commandCancellation) =>
            {
                commandCancellation.ThrowIfCancellationRequested();
                ITransaction transaction = database.CreateTransaction();
                _ = transaction.AddCondition(Condition.KeyExists(key));
                _ = transaction.KeyDeleteAsync(key);
                return await transaction.ExecuteAsync(CommandFlags.None).ConfigureAwait(false);
            },
            cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (ok)
        {
            await UnregisterKeyAsync(policyId, key, cancellationToken).ConfigureAwait(false);
        }

        telemetry.RecordOperation("consume_once", CachePolicyTelemetry.Name(policyId), "l2", ok ? "consumed" : "miss", FsusObservability.GetElapsed(startedAt));
        return ok;
    }

    public async Task<CacheReadResult<T>> ConsumeOnceAndGetAsync<T>(
        CachePolicyId policyId,
        string identity,
        Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder,
        CancellationToken cancellationToken = default)
    {
        long startedAt = Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.consume_once_get", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "consume_once_get");
        FsusObservability.SetTag(activity, "fsus.cache.policy", CachePolicyTelemetry.Name(policyId));
        cancellationToken.ThrowIfCancellationRequested();
        string key = BuildKey(policyId, identity);
        RemoveL1(policyId, CacheIdentity.FromString(identity), key);
        cancellationToken.ThrowIfCancellationRequested();
        RedisValue value = await ExecuteDatabaseAsync(
            RedisOperationPort.UnifiedCacheAtomic,
            (database, _) => database.StringGetDeleteAsync(key),
            cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (!value.HasValue)
        {
            telemetry.RecordOperation("consume_once_get", CachePolicyTelemetry.Name(policyId), "l2", "miss", FsusObservability.GetElapsed(startedAt));
            return new CacheReadResult<T>(false, default);
        }

        byte[] bytes = (byte[])value!;
        if (bytes.Length == 0)
        {
            await UnregisterKeyAsync(policyId, key, cancellationToken).ConfigureAwait(false);
            telemetry.RecordOperation("consume_once_get", CachePolicyTelemetry.Name(policyId), "l2", "hit_negative", FsusObservability.GetElapsed(startedAt));
            return new CacheReadResult<T>(true, default);
        }

        var (success, decoded) = decoder(bytes);
        if (!success)
        {
            await UnregisterKeyAsync(policyId, key, cancellationToken).ConfigureAwait(false);
            telemetry.RecordOperation("consume_once_get", CachePolicyTelemetry.Name(policyId), "l2", "decode_failed", FsusObservability.GetElapsed(startedAt));
            return new CacheReadResult<T>(false, default);
        }

        await UnregisterKeyAsync(policyId, key, cancellationToken).ConfigureAwait(false);
        telemetry.RecordOperation("consume_once_get", CachePolicyTelemetry.Name(policyId), "l2", "consumed", FsusObservability.GetElapsed(startedAt));
        return new CacheReadResult<T>(true, decoded);
    }

    public async Task<CacheReadResult<T>> ExchangeOnceAndGetAsync<T>(
        CachePolicyId sourcePolicyId,
        string sourceIdentity,
        CachePolicyId targetPolicyId,
        string targetIdentity,
        byte[] targetValue,
        TimeSpan targetTtl,
        Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> sourceDecoder,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(targetValue);
        ArgumentNullException.ThrowIfNull(sourceDecoder);
        if (targetTtl <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(targetTtl));
        }

        long startedAt = Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.exchange_once_get", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "exchange_once_get");
        FsusObservability.SetTag(activity, "fsus.cache.policy", CachePolicyTelemetry.Name(sourcePolicyId));
        cancellationToken.ThrowIfCancellationRequested();

        CacheIdentity sourceCacheIdentity = CacheIdentity.FromString(sourceIdentity);
        CacheIdentity targetCacheIdentity = CacheIdentity.FromString(targetIdentity);
        CachePolicy sourcePolicy = ResolvePolicy(sourcePolicyId);
        CachePolicy targetPolicy = ResolvePolicy(targetPolicyId);
        string sourceKey = BuildRedisKey(sourcePolicy, sourceCacheIdentity);
        string targetKey = BuildRedisKey(targetPolicy, targetCacheIdentity);
        if (string.Equals(sourceKey, targetKey, StringComparison.Ordinal))
        {
            throw new ArgumentException("Source and target cache identities must differ.", nameof(targetIdentity));
        }

        RemoveL1(sourcePolicyId, sourceCacheIdentity, sourceKey);
        RemoveL1(targetPolicyId, targetCacheIdentity, targetKey);
        long ttlMilliseconds = Math.Max(1L, (long)Math.Ceiling(targetTtl.TotalMilliseconds));
        const string Script = """
local source = redis.call('GET', KEYS[1])
if not source then
  return {0}
end
redis.call('DEL', KEYS[1])
redis.call('SET', KEYS[2], ARGV[1], 'PX', ARGV[2])
return {1, source}
""";
        RedisResult result = await ExecuteDatabaseAsync(
            RedisOperationPort.UnifiedCacheAtomic,
            (database, _) => database.ScriptEvaluateAsync(
                Script,
                [sourceKey, targetKey],
                [targetValue, ttlMilliseconds],
                CommandFlags.None),
            cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        RedisResult[] values = (RedisResult[])result!;
        if (values.Length == 0 || (long)values[0] != 1L)
        {
            telemetry.RecordOperation("exchange_once_get", CachePolicyTelemetry.Name(sourcePolicyId), "l2", "miss", FsusObservability.GetElapsed(startedAt));
            return new CacheReadResult<T>(false, default);
        }
        if (values.Length != 2)
        {
            throw new InvalidOperationException("Redis returned an invalid one-time exchange result.");
        }

        byte[]? sourceValue = (byte[]?)values[1];
        if (sourceValue is null)
        {
            _ = await ExecuteDatabaseAsync(
                RedisOperationPort.UnifiedCacheAtomic,
                (database, _) => database.KeyDeleteAsync(targetKey, CommandFlags.None),
                cancellationToken).ConfigureAwait(false);
            throw new InvalidOperationException("Redis returned an empty one-time exchange payload.");
        }
        var (success, decoded) = sourceDecoder(sourceValue);
        if (!success)
        {
            _ = await ExecuteDatabaseAsync(
                RedisOperationPort.UnifiedCacheAtomic,
                (database, _) => database.KeyDeleteAsync(targetKey, CommandFlags.None),
                cancellationToken).ConfigureAwait(false);
            await UnregisterKeyAsync(sourcePolicyId, sourceKey, cancellationToken).ConfigureAwait(false);
            telemetry.RecordOperation("exchange_once_get", CachePolicyTelemetry.Name(sourcePolicyId), "l2", "decode_failed", FsusObservability.GetElapsed(startedAt));
            return new CacheReadResult<T>(false, default);
        }

        await UnregisterKeyAsync(sourcePolicyId, sourceKey, cancellationToken).ConfigureAwait(false);
        await RegisterKeyAsync(targetPolicyId, targetKey, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        telemetry.RecordOperation("exchange_once_get", CachePolicyTelemetry.Name(sourcePolicyId), "l2", "exchanged", FsusObservability.GetElapsed(startedAt));
        return new CacheReadResult<T>(true, decoded);
    }

    public Task RemoveAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
        => RemoveCoreAsync(policyId, CacheIdentity.FromString(identity), cancellationToken);

    public Task RemoveAsync(CachePolicyId policyId, int identity, CancellationToken cancellationToken = default)
        => RemoveCoreAsync(policyId, CacheIdentity.FromInteger(identity), cancellationToken);

    private async Task RemoveCoreAsync(CachePolicyId policyId, CacheIdentity identity, CancellationToken cancellationToken)
    {
        long startedAt = Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.remove", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "remove");
        string policyName = CachePolicyTelemetry.Name(policyId);
        FsusObservability.SetTag(activity, "fsus.cache.policy", policyName);
        CachePolicy policy = ResolvePolicy(policyId);
        string key = BuildRedisKey(policy, identity);
        await using IAsyncDisposable mutationGate = await coordination.AcquireMutationAsync(
                key,
                cancellationToken)
            .ConfigureAwait(false);
        RemoveL1(policyId, identity, key);
        cancellationToken.ThrowIfCancellationRequested();
        _ = await ExecuteDatabaseAsync(
            ResolveMutationPort(policyId),
            (database, _) => database.KeyDeleteAsync(key),
            cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        await UnregisterKeyAsync(policyId, key).ConfigureAwait(false);
        telemetry.RecordOperation("remove", policyName, "l2", "ok", FsusObservability.GetElapsed(startedAt));
    }

    public async Task RemoveManyAsync(IReadOnlyList<CacheKeyIdentity> keys, CancellationToken cancellationToken = default)
    {
        if (keys.Count == 0)
        {
            return;
        }

        long startedAt = Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.remove_many", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "remove_many");
        FsusObservability.SetTag(activity, "fsus.cache.policy", "mixed");

        var unregisteredRedisKeys = new List<RedisKey>(keys.Count);
        var registryMembersByPolicy = new Dictionary<CachePolicyId, List<RedisValue>>();
        var seenKeys = new HashSet<string>(StringComparer.Ordinal);
        var resolvedKeys = new List<(CachePolicyId PolicyId, string Identity, string? Version, string RedisKey)>(keys.Count);
        foreach (CacheKeyIdentity identity in keys)
        {
            cancellationToken.ThrowIfCancellationRequested();
            CachePolicy policy = ResolvePolicy(identity.PolicyId);
            string key = keyScope.PrefixKey(policy.BuildKey(identity.Identity, identity.Version));
            if (!seenKeys.Add(key))
            {
                continue;
            }

            resolvedKeys.Add((identity.PolicyId, identity.Identity, identity.Version, key));
            if (policy.RegisterKeysForPrefixInvalidation)
            {
                if (!registryMembersByPolicy.TryGetValue(identity.PolicyId, out List<RedisValue>? members))
                {
                    members = [];
                    registryMembersByPolicy[identity.PolicyId] = members;
                }

                members.Add(key);
                continue;
            }

            unregisteredRedisKeys.Add(key);
        }

        await using IAsyncDisposable mutationGates = await AcquireOwnedFrameMutationGatesAsync(
                seenKeys,
                cancellationToken)
            .ConfigureAwait(false);
        foreach ((CachePolicyId policyId, string identity, string? version, string redisKey) in resolvedKeys)
        {
            RemoveL1(policyId, CacheIdentity.FromString(identity, version), redisKey);
        }

        int redisBatches = 0;
        if (unregisteredRedisKeys.Count > 0)
        {
            _ = await ExecuteDatabaseAsync(
                RedisOperationPort.UnifiedCacheInvalidation,
                (database, _) => database.KeyDeleteAsync(unregisteredRedisKeys.ToArray()),
                cancellationToken).ConfigureAwait(false);
            redisBatches++;
        }

        foreach ((CachePolicyId policyId, List<RedisValue> members) in registryMembersByPolicy)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (members.Count == 0)
            {
                continue;
            }

            redisBatches += await DeleteKeysAndRegistryMembersAtomicAsync(policyId, members, cancellationToken).ConfigureAwait(false);
        }

        TimeSpan elapsed = FsusObservability.GetElapsed(startedAt);
        telemetry.RecordOperation("remove_many", "mixed", "l2", "ok", elapsed);
        FsusObservability.RecordCacheRemoveMany(seenKeys.Count, redisBatches, elapsed);
    }

    private async Task<int> DeleteKeysAndRegistryMembersAtomicAsync(
        CachePolicyId policyId,
        List<RedisValue> members,
        CancellationToken cancellationToken)
    {
        string registryKey = ResolveRegistryKey(policyId);
        int batches = 0;
        for (int offset = 0; offset < members.Count; offset += PrefixInvalidationBatchSize)
        {
            cancellationToken.ThrowIfCancellationRequested();
            int take = Math.Min(PrefixInvalidationBatchSize, members.Count - offset);
            RedisKey[] scriptKeys = new RedisKey[take + 1];
            scriptKeys[0] = registryKey;
            for (int i = 0; i < take; i++)
            {
                scriptKeys[i + 1] = members[offset + i].ToString();
            }

            _ = await ExecuteDatabaseAsync(
                RedisOperationPort.UnifiedCacheInvalidation,
                (database, _) => database.ScriptEvaluateAsync(
                    DeleteKeysAndRegistryMembersScript,
                    scriptKeys,
                    Array.Empty<RedisValue>()),
                cancellationToken).ConfigureAwait(false);
            batches++;
        }

        return batches;
    }

    public async Task RemoveByPrefixAsync(CachePolicyId policyId, string identityPrefix, CancellationToken cancellationToken = default)
    {
        long startedAt = Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.remove_prefix", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "remove_prefix");
        string policyName = CachePolicyTelemetry.Name(policyId);
        FsusObservability.SetTag(activity, "fsus.cache.policy", policyName);
        CachePolicy policy = ResolvePolicy(policyId);
        string prefix = keyScope.PrefixKey(policy.BuildKey(identityPrefix));
        string registryKey = ResolveRegistryKey(policyId);
        bool registryExists = await ExecuteDatabaseAsync(
            RedisOperationPort.UnifiedCacheInvalidation,
            (database, _) => database.KeyExistsAsync(registryKey),
            cancellationToken).ConfigureAwait(false);
        if (registryExists)
        {
            await DeleteRegisteredKeysByPrefixAsync(registryKey, prefix, cancellationToken).ConfigureAwait(false);
            telemetry.RecordOperation("remove_prefix", policyName, "l2", "ok", FsusObservability.GetElapsed(startedAt));

            return;
        }

        logger.LogInformation(
            "cache-prefix-invalidation-registry-missing {PolicyId} {IdentityPrefix}; using Redis keyspace scan fallback",
            policyId,
            identityPrefix);
        try
        {
            int recoveredKeys = await DeleteKeysByPrefixScanAsync(prefix, cancellationToken).ConfigureAwait(false);
            telemetry.RecordOperation(
                "remove_prefix",
                policyName,
                "l2",
                recoveredKeys > 0 ? "registry_missing_scan_recovered" : "registry_missing_scan_empty",
                FsusObservability.GetElapsed(startedAt));
        }
        catch (Exception ex)
        {
            logger.LogWarning(
                ex,
                "cache-prefix-invalidation-scan-failed {PolicyId} {IdentityPrefix}",
                policyId,
                identityPrefix);
            telemetry.RecordOperation("remove_prefix", policyName, "l2", "registry_missing_scan_failed", FsusObservability.GetElapsed(startedAt));
        }
    }

    public async Task RemoveByPrefixManyAsync(IReadOnlyList<CachePrefixIdentity> prefixes, CancellationToken cancellationToken = default)
    {
        if (prefixes.Count == 0)
        {
            return;
        }

        long startedAt = Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.remove_prefix_many", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "remove_prefix_many");
        FsusObservability.SetTag(activity, "fsus.cache.policy", "mixed");

        int registryScans = 0;
        int deletedKeys = 0;
        foreach (IGrouping<CachePolicyId, CachePrefixIdentity> group in prefixes.GroupBy(static item => item.PolicyId))
        {
            cancellationToken.ThrowIfCancellationRequested();
            CachePolicy policy = ResolvePolicy(group.Key);
            string[] resolvedPrefixes = group
                .Select(item => keyScope.PrefixKey(policy.BuildKey(item.IdentityPrefix)))
                .Distinct(StringComparer.Ordinal)
                .ToArray();
            if (resolvedPrefixes.Length == 0)
            {
                continue;
            }

            string registryKey = ResolveRegistryKey(group.Key);
            bool registryExists = await ExecuteDatabaseAsync(
                RedisOperationPort.UnifiedCacheInvalidation,
                (database, _) => database.KeyExistsAsync(registryKey),
                cancellationToken).ConfigureAwait(false);
            if (registryExists)
            {
                registryScans++;
                deletedKeys += await DeleteRegisteredKeysByPrefixesAsync(registryKey, resolvedPrefixes, cancellationToken).ConfigureAwait(false);
                continue;
            }

            logger.LogInformation(
                "cache-prefix-many-invalidation-registry-missing {PolicyId} {PrefixCount}; using Redis keyspace scan fallback",
                group.Key,
                resolvedPrefixes.Length);
            try
            {
                deletedKeys += await DeleteKeysByPrefixesScanAsync(resolvedPrefixes, cancellationToken).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                logger.LogWarning(
                    ex,
                    "cache-prefix-many-invalidation-scan-failed {PolicyId} {PrefixCount}",
                    group.Key,
                    resolvedPrefixes.Length);
                telemetry.RecordOperation("remove_prefix_many", group.Key.ToString(), "l2", "registry_missing_scan_failed", FsusObservability.GetElapsed(startedAt));
            }
        }

        TimeSpan elapsed = FsusObservability.GetElapsed(startedAt);
        telemetry.RecordOperation("remove_prefix_many", "mixed", "l2", "ok", elapsed);
        FsusObservability.RecordCacheRemovePrefixMany(prefixes.Count, registryScans, deletedKeys, elapsed);
    }

    public async Task<IReadOnlyList<CachePolicyStorageSnapshot>> GetPolicyStorageSnapshotsAsync(
        IReadOnlyList<CachePolicyId> policyIds,
        CancellationToken cancellationToken = default)
    {
        if (policyIds.Count == 0)
        {
            return Array.Empty<CachePolicyStorageSnapshot>();
        }

        var snapshots = new List<CachePolicyStorageSnapshot>(policyIds.Count);
        foreach (CachePolicyId policyId in policyIds)
        {
            cancellationToken.ThrowIfCancellationRequested();
            string registryKey = ResolveRegistryKey(policyId);
            long keyCount = 0;
            long bytes = 0;
            RedisValue[] registeredKeys = await ScanSetAsync(
                RedisOperationPort.UnifiedCacheMaintenance,
                registryKey,
                cancellationToken).ConfigureAwait(false);
            foreach (RedisValue registeredKey in registeredKeys)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (!registeredKey.HasValue)
                {
                    continue;
                }

                keyCount++;
                bytes += await ExecuteDatabaseAsync(
                    RedisOperationPort.UnifiedCacheMaintenance,
                    (database, _) => database.StringLengthAsync((RedisKey)registeredKey.ToString()),
                    cancellationToken).ConfigureAwait(false);
            }

            snapshots.Add(new CachePolicyStorageSnapshot(policyId, keyCount, bytes));
        }

        return snapshots;
    }

    public IReadOnlyList<CacheL1PolicyResidencySnapshot> GetL1PolicyResidencySnapshots()
        => localStore.SnapshotPolicyResidency();

    private async Task DeleteRegisteredKeysByPrefixAsync(
        string registryKey,
        string prefix,
        CancellationToken cancellationToken)
    {
        List<RedisKey> deleteKeys = new(PrefixInvalidationBatchSize);
        List<RedisValue> registryMembers = new(PrefixInvalidationBatchSize);
        RedisValue[] registeredKeys = await ScanSetAsync(
            RedisOperationPort.UnifiedCacheInvalidation,
            registryKey,
            cancellationToken).ConfigureAwait(false);
        foreach (RedisValue registeredKey in registeredKeys)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (registeredKey.IsNullOrEmpty)
            {
                continue;
            }

            string value = registeredKey.ToString();
            if (!value.StartsWith(prefix, StringComparison.Ordinal))
            {
                continue;
            }

            deleteKeys.Add(value);
            registryMembers.Add(value);

            if (deleteKeys.Count >= PrefixInvalidationBatchSize)
            {
                _ = await FlushRegisteredDeleteBatchAsync(registryKey, deleteKeys, registryMembers, cancellationToken).ConfigureAwait(false);
            }
        }

        if (deleteKeys.Count > 0)
        {
            _ = await FlushRegisteredDeleteBatchAsync(registryKey, deleteKeys, registryMembers, cancellationToken).ConfigureAwait(false);
        }
    }

    private async Task<int> DeleteRegisteredKeysByPrefixesAsync(
        string registryKey,
        IReadOnlyList<string> prefixes,
        CancellationToken cancellationToken)
    {
        var deleteKeys = new List<RedisKey>(PrefixInvalidationBatchSize);
        var registryMembers = new List<RedisValue>(PrefixInvalidationBatchSize);
        int deleted = 0;
        RedisValue[] registeredKeys = await ScanSetAsync(
            RedisOperationPort.UnifiedCacheInvalidation,
            registryKey,
            cancellationToken).ConfigureAwait(false);
        foreach (RedisValue registeredKey in registeredKeys)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (registeredKey.IsNullOrEmpty)
            {
                continue;
            }

            string value = registeredKey.ToString();
            if (!StartsWithAny(value, prefixes))
            {
                continue;
            }

            deleteKeys.Add(value);
            registryMembers.Add(value);

            if (deleteKeys.Count >= PrefixInvalidationBatchSize)
            {
                deleted += await FlushRegisteredDeleteBatchAsync(registryKey, deleteKeys, registryMembers, cancellationToken).ConfigureAwait(false);
            }
        }

        if (deleteKeys.Count > 0)
        {
            deleted += await FlushRegisteredDeleteBatchAsync(registryKey, deleteKeys, registryMembers, cancellationToken).ConfigureAwait(false);
        }

        return deleted;
    }

    private async Task<int> FlushRegisteredDeleteBatchAsync(
        string registryKey,
        List<RedisKey> deleteKeys,
        List<RedisValue> registryMembers,
        CancellationToken cancellationToken)
    {
        int count = deleteKeys.Count;
        RedisKey[] keys = deleteKeys.ToArray();
        RedisValue[] members = registryMembers.ToArray();
        await using (IAsyncDisposable mutationGates = await AcquireOwnedFrameMutationGatesAsync(
                         keys.Select(static key => key.ToString()),
                         cancellationToken)
                     .ConfigureAwait(false))
        {
            foreach (RedisKey key in keys)
            {
                RemoveL1ByRedisKey(key.ToString());
            }

            _ = await ExecuteDatabaseAsync(
                RedisOperationPort.UnifiedCacheInvalidation,
                (database, _) => database.KeyDeleteAsync(keys),
                cancellationToken).ConfigureAwait(false);
            _ = await ExecuteDatabaseAsync(
                RedisOperationPort.UnifiedCacheInvalidation,
                (database, _) => database.SetRemoveAsync(registryKey, members),
                cancellationToken).ConfigureAwait(false);
        }
        deleteKeys.Clear();
        registryMembers.Clear();
        return count;
    }

    private async Task<int> DeleteKeysByPrefixScanAsync(string prefix, CancellationToken cancellationToken)
    {
        string pattern = prefix + "*";
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var deleteKeys = new List<RedisKey>(PrefixInvalidationBatchSize);
        int deleted = 0;

        RedisKey[] scannedKeys = await ScanServerKeysAsync(pattern, cancellationToken).ConfigureAwait(false);
        foreach (RedisKey key in scannedKeys)
        {
            cancellationToken.ThrowIfCancellationRequested();
            string keyText = key.ToString();
            if (!seen.Add(keyText))
            {
                continue;
            }

            deleteKeys.Add(key);

            if (deleteKeys.Count >= PrefixInvalidationBatchSize)
            {
                deleted += await FlushScanDeleteBatchAsync(deleteKeys, cancellationToken).ConfigureAwait(false);
            }
        }

        if (deleteKeys.Count > 0)
        {
            deleted += await FlushScanDeleteBatchAsync(deleteKeys, cancellationToken).ConfigureAwait(false);
        }

        return deleted;
    }

    private async Task<int> DeleteKeysByPrefixesScanAsync(IReadOnlyList<string> prefixes, CancellationToken cancellationToken)
    {
        string scanPrefix = BuildCommonPrefix(prefixes);
        string pattern = scanPrefix + "*";
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var deleteKeys = new List<RedisKey>(PrefixInvalidationBatchSize);
        int deleted = 0;

        RedisKey[] scannedKeys = await ScanServerKeysAsync(pattern, cancellationToken).ConfigureAwait(false);
        foreach (RedisKey key in scannedKeys)
        {
            cancellationToken.ThrowIfCancellationRequested();
            string keyText = key.ToString();
            if (!seen.Add(keyText) || !StartsWithAny(keyText, prefixes))
            {
                continue;
            }

            deleteKeys.Add(key);

            if (deleteKeys.Count >= PrefixInvalidationBatchSize)
            {
                deleted += await FlushScanDeleteBatchAsync(deleteKeys, cancellationToken).ConfigureAwait(false);
            }
        }

        if (deleteKeys.Count > 0)
        {
            deleted += await FlushScanDeleteBatchAsync(deleteKeys, cancellationToken).ConfigureAwait(false);
        }

        return deleted;
    }

    private async Task<int> FlushScanDeleteBatchAsync(
        List<RedisKey> deleteKeys,
        CancellationToken cancellationToken)
    {
        int count = deleteKeys.Count;
        RedisKey[] keys = deleteKeys.ToArray();
        await using (IAsyncDisposable mutationGates = await AcquireOwnedFrameMutationGatesAsync(
                         keys.Select(static key => key.ToString()),
                         cancellationToken)
                     .ConfigureAwait(false))
        {
            foreach (RedisKey key in keys)
            {
                RemoveL1ByRedisKey(key.ToString());
            }

            _ = await ExecuteDatabaseAsync(
                RedisOperationPort.UnifiedCacheInvalidation,
                (database, _) => database.KeyDeleteAsync(keys),
                cancellationToken).ConfigureAwait(false);
        }
        deleteKeys.Clear();
        return count;
    }

    private Task<IAsyncDisposable> AcquireOwnedFrameMutationGatesAsync(
        IEnumerable<string> redisKeys,
        CancellationToken cancellationToken)
        => coordination.AcquireMutationsAsync(redisKeys, cancellationToken);

    private string BuildRedisKey(CachePolicy policy, CacheIdentity identity)
        => keyScope.PrefixKey(identity.BuildRedisKey(policy));

    private async Task<RedisValue> ReadRedisAsync(
        CachePolicyId policyId,
        string key,
        string operation,
        string policyName,
        Activity? activity,
        long startedAt,
        CancellationToken cancellationToken)
    {
        try
        {
            RedisOperationPort port = ResolveReadPort(policyId);
            return await _redisOperations.ExecuteAsync(
                port,
                (multiplexer, _) => multiplexer.GetDatabase().StringGetAsync(key),
                cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (RedisOperationUnavailableException exception)
            when (exception.Port.OperationClass == RedisOperationClass.ContentCacheRead)
        {
            activity?.SetStatus(ActivityStatusCode.Error, "redis_read_failed");
            activity?.AddEvent(new ActivityEvent(
                "redis.read.failed",
                tags: new ActivityTagsCollection
                {
                    ["exception.type"] = exception.GetType().FullName
                }));
            logger.LogError(exception, "Cache Redis read failed for policy {PolicyId} operation {Operation}", policyName, operation);
            telemetry.RecordOperation(operation, policyName, "l2", "redis_error", FsusObservability.GetElapsed(startedAt));
            return RedisValue.Null;
        }
    }

    private static RedisOperationPort ResolveReadPort(CachePolicyId policyId)
        => policyId switch
        {
            CachePolicyId.VisitLock
                or CachePolicyId.ArticleViewLock
                or CachePolicyId.BackgroundWorkerLease
                or CachePolicyId.PublicAotBackfillLease => RedisOperationPort.UnifiedCacheLease,
            CachePolicyId.SecurityBlockedUser
                or CachePolicyId.SecurityMfaChallenge
                or CachePolicyId.SecurityMfaProof
                or CachePolicyId.SecurityPowRisk
                or CachePolicyId.SecurityPasskeyRegChallenge
                or CachePolicyId.SecurityPasskeyAuthChallenge
                or CachePolicyId.HumanReadProof
                or CachePolicyId.SecurityPowProof
                or CachePolicyId.SystemCompliance
                or CachePolicyId.SecurityRecoveryKeyAttempt
                or CachePolicyId.SecurityRecoveryKeySession
                or CachePolicyId.SecurityChallengeProof
                or CachePolicyId.SecurityPoSpaceChallenge
                or CachePolicyId.AnonymousCommentTicket
                or CachePolicyId.SecurityPerceptionChallenge
                or CachePolicyId.SiteSubscriptionUnsubscribeProof
                or CachePolicyId.SecurityChallengeVerifyRateLimit
                or CachePolicyId.SecurityUserSessionValidation
                or CachePolicyId.SecurityChallengeEnvelope => RedisOperationPort.UnifiedCacheAtomic,
            _ => RedisOperationPort.UnifiedCacheRead
        };

    private static RedisOperationPort ResolveMutationPort(CachePolicyId policyId)
        => ResolveReadPort(policyId) switch
        {
            RedisOperationPort.UnifiedCacheAtomic => RedisOperationPort.UnifiedCacheAtomic,
            RedisOperationPort.UnifiedCacheLease => RedisOperationPort.UnifiedCacheLease,
            _ => RedisOperationPort.UnifiedCacheWrite
        };

    private static RedisOperationPort ResolveCounterPort(CachePolicyId policyId)
        => ResolveReadPort(policyId) switch
        {
            RedisOperationPort.UnifiedCacheAtomic => RedisOperationPort.UnifiedCacheAtomic,
            RedisOperationPort.UnifiedCacheLease => RedisOperationPort.UnifiedCacheLease,
            _ when policyId == CachePolicyId.AdminStats => RedisOperationPort.UnifiedCacheOptionalProjection,
            _ => RedisOperationPort.UnifiedCacheDistributedDelivery
        };

    private Task<T> ExecuteDatabaseAsync<T>(
        RedisOperationPort port,
        Func<IDatabase, CancellationToken, Task<T>> command,
        CancellationToken cancellationToken)
        => _redisOperations.ExecuteAsync(
            port,
            (multiplexer, token) => command(multiplexer.GetDatabase(), token),
            cancellationToken);

    private Task<RedisValue[]> ScanSetAsync(
        RedisOperationPort port,
        RedisKey key,
        CancellationToken cancellationToken)
        => ExecuteDatabaseAsync(
            port,
            async (database, token) =>
            {
                var values = new List<RedisValue>();
                await foreach (RedisValue value in database
                    .SetScanAsync(key, pageSize: PrefixInvalidationBatchSize)
                    .WithCancellation(token)
                    .ConfigureAwait(false))
                {
                    values.Add(value);
                }
                return values.ToArray();
            },
            cancellationToken);

    private Task<RedisKey[]> ScanServerKeysAsync(
        RedisValue pattern,
        CancellationToken cancellationToken)
        => _redisOperations.ExecuteAsync(
            RedisOperationPort.UnifiedCacheInvalidation,
            async (multiplexer, token) =>
            {
                var keys = new List<RedisKey>();
                int databaseId = multiplexer.GetDatabase().Database;
                foreach (System.Net.EndPoint endpoint in multiplexer.GetEndPoints())
                {
                    token.ThrowIfCancellationRequested();
                    IServer server = multiplexer.GetServer(endpoint);
                    if (!server.IsConnected)
                    {
                        continue;
                    }

                    await foreach (RedisKey key in server
                        .KeysAsync(databaseId, pattern, pageSize: PrefixInvalidationBatchSize)
                        .WithCancellation(token)
                        .ConfigureAwait(false))
                    {
                        keys.Add(key);
                    }
                }
                return keys.ToArray();
            },
            cancellationToken);

    private static IRedisOperationExecutor CreateDirectRedisExecutor(IConnectionMultiplexer redis)
        => new RedisOperationExecutor(
            new DirectRedisConnectionProvider(redis),
            new RedisOperationBudgetCatalog(),
            TimeProvider.System);

    private sealed class DirectRedisConnectionProvider(IConnectionMultiplexer redis) : IRedisConnectionProvider
    {
        public Task<IConnectionMultiplexer> WaitAsync() => Task.FromResult(redis);
    }

    private bool SetOwnedL1(
        CachePolicy policy,
        CacheL1Key l1Key,
        string redisKey,
        OwnedAedsFrame frame)
    {
        if (policy.L1Ttl <= TimeSpan.Zero
            || policy.L1MaxEntries <= 0
            || frame.LogicalLength > policy.L1MaxLogicalBytes
            || frame.Capacity > policy.L1MaxCapacityBytes)
        {
            return false;
        }

        var options = new MemoryCacheEntryOptions
        {
            AbsoluteExpirationRelativeToNow = policy.L1Ttl,
            Size = frame.Capacity
        };
        long ttlTimestampDelta = (long)Math.Ceiling(policy.L1Ttl.TotalSeconds * Stopwatch.Frequency);
        long expiresAtTimestamp = Stopwatch.GetTimestamp() + Math.Max(1L, ttlTimestampDelta);
        var entry = new OwnedFrameL1Entry(l1Key, redisKey, frame, expiresAtTimestamp);
        options.RegisterPostEvictionCallback(
            static (_, _, _, state) =>
            {
                if (state is OwnedFrameL1EvictionState eviction)
                {
                    eviction.Owner.OnOwnedFrameEvicted(eviction.RedisKey, eviction.Entry);
                }
            },
            new OwnedFrameL1EvictionState(this, redisKey, entry));

        lock (_l1MutationLock)
        {
            if (Volatile.Read(ref _disposed) != 0)
            {
                return false;
            }

            _ownedFrameEntries.TryGetValue(l1Key, out OwnedFrameL1Entry? previousL1Entry);
            _ownedFrameKeysByRedisKey.TryGetValue(redisKey, out OwnedFrameL1Entry? previousRedisEntry);
            try
            {
                memoryCache.Set(entry, entry, options);
            }
            catch
            {
                RetireOwnedEntry(entry);
                throw;
            }

            if (!entry.TryActivate())
            {
                SafeRemoveMemoryCacheEntry(entry);
                return false;
            }

            try
            {
                _ownedFrameEntries[l1Key] = entry;
                _ownedFrameKeysByRedisKey[redisKey] = entry;
            }
            catch
            {
                RestoreOwnedFrameIndex(l1Key, entry, previousL1Entry, _ownedFrameEntries);
                RestoreOwnedFrameIndex(redisKey, entry, previousRedisEntry, _ownedFrameKeysByRedisKey);
                RetireOwnedEntry(entry);
                throw;
            }

            _ownedFrameEntryCount++;
            _ownedFrameLogicalBytes += frame.LogicalLength;
            _ownedFrameCapacityBytes += frame.Capacity;
            entry.MarkAccounted();

            RemoveSupersededOwnedFrameEntry(previousL1Entry, entry);
            RemoveSupersededOwnedFrameEntry(previousRedisEntry, entry);

            EnforceOwnedFramePolicyBudget(policy);

            localStore.Remove(l1Key, redisKey);
        }

        return true;
    }

    private static void RestoreOwnedFrameIndex<TKey>(
        TKey key,
        OwnedFrameL1Entry attempted,
        OwnedFrameL1Entry? previous,
        ConcurrentDictionary<TKey, OwnedFrameL1Entry> index)
        where TKey : notnull
    {
        if (previous is null)
        {
            index.TryRemove(new KeyValuePair<TKey, OwnedFrameL1Entry>(key, attempted));
            return;
        }

        index.TryUpdate(key, previous, attempted);
    }

    private void OnOwnedFrameEvicted(string redisKey, OwnedFrameL1Entry entry)
    {
        lock (_l1MutationLock)
        {
            _ownedFrameEntries.TryRemove(
                new KeyValuePair<CacheL1Key, OwnedFrameL1Entry>(entry.L1Key, entry));
            _ownedFrameKeysByRedisKey.TryRemove(
                new KeyValuePair<string, OwnedFrameL1Entry>(redisKey, entry));
            RetireOwnedEntry(entry);
        }
    }

    private bool TryGetOwnedL1(
        CacheL1Key l1Key,
        AedsFrameType expectedFrameType,
        out OwnedAedsFrameReadLease? lease)
    {
        if (_ownedFrameEntries.TryGetValue(l1Key, out OwnedFrameL1Entry? entry))
        {
            if (Stopwatch.GetTimestamp() < entry.ExpiresAtTimestamp
                && entry.Frame.FrameType == expectedFrameType
                && entry.Frame.TryAcquireReadLease(out lease))
            {
                entry.Touch();
                return true;
            }

            _ownedFrameEntries.TryRemove(
                new KeyValuePair<CacheL1Key, OwnedFrameL1Entry>(l1Key, entry));
            _ownedFrameKeysByRedisKey.TryRemove(
                new KeyValuePair<string, OwnedFrameL1Entry>(entry.RedisKey, entry));
            SafeRemoveMemoryCacheEntry(entry);
            RetireOwnedEntry(entry);
        }

        lease = null;
        return false;
    }

    private void EnforceOwnedFramePolicyBudget(CachePolicy policy)
    {
        while (true)
        {
            OwnedFrameL1Entry[] residents = _ownedFrameEntries.Values
                .Where(entry => entry.L1Key.PolicyId == policy.Id)
                .ToArray();
            long logicalBytes = residents.Sum(static entry => (long)entry.Frame.LogicalLength);
            long capacityBytes = residents.Sum(static entry => (long)entry.Frame.Capacity);
            if (residents.Length <= policy.L1MaxEntries
                && logicalBytes <= policy.L1MaxLogicalBytes
                && capacityBytes <= policy.L1MaxCapacityBytes)
            {
                return;
            }

            OwnedFrameL1Entry victim = residents
                .OrderBy(static entry => entry.LastAccessTimestamp)
                .ThenBy(static entry => entry.RedisKey, StringComparer.Ordinal)
                .First();
            _ownedFrameEntries.TryRemove(
                new KeyValuePair<CacheL1Key, OwnedFrameL1Entry>(victim.L1Key, victim));
            _ownedFrameKeysByRedisKey.TryRemove(
                new KeyValuePair<string, OwnedFrameL1Entry>(victim.RedisKey, victim));
            SafeRemoveMemoryCacheEntry(victim);
            RetireOwnedEntry(victim);
        }
    }

    private bool TryGetNegativeL1(CacheL1Key l1Key)
    {
        if (!TryAcquireL1(l1Key, out PolicyShardedCacheL1Store.CacheL1ReadLease lease))
        {
            return false;
        }

        using (lease)
        {
            return lease.Memory.Length == 0;
        }
    }

    private void SetL1(CachePolicy policy, CacheL1Key l1Key, string redisKey, byte[] bytes)
    {
        _ = localStore.TrySetOwned(policy, l1Key, redisKey, bytes);
        lock (_l1MutationLock)
        {
            if (_ownedFrameEntries.TryRemove(l1Key, out OwnedFrameL1Entry? ownedEntry))
            {
                _ownedFrameKeysByRedisKey.TryRemove(
                    new KeyValuePair<string, OwnedFrameL1Entry>(ownedEntry.RedisKey, ownedEntry));
                SafeRemoveMemoryCacheEntry(ownedEntry);
                RetireOwnedEntry(ownedEntry);
            }
            if (_ownedFrameKeysByRedisKey.TryRemove(redisKey, out OwnedFrameL1Entry? ownedRedisEntry)
                && !ReferenceEquals(ownedRedisEntry, ownedEntry))
            {
                _ownedFrameEntries.TryRemove(
                    new KeyValuePair<CacheL1Key, OwnedFrameL1Entry>(ownedRedisEntry.L1Key, ownedRedisEntry));
                SafeRemoveMemoryCacheEntry(ownedRedisEntry);
                RetireOwnedEntry(ownedRedisEntry);
            }
        }
    }

    private bool TryAcquireL1(
        CacheL1Key l1Key,
        out PolicyShardedCacheL1Store.CacheL1ReadLease lease)
        => localStore.TryAcquire(l1Key, out lease);

    private CacheL1InvalidationPolicyReceipt RemoveL1(CacheL1Key l1Key, string? redisKey = null)
    {
        CacheL1InvalidationPolicyReceipt localReceipt = localStore.Remove(l1Key, redisKey);
        int entryCount = localReceipt.EntryCount;
        long bytes = localReceipt.Bytes;
        lock (_l1MutationLock)
        {
            if (_ownedFrameEntries.TryRemove(l1Key, out OwnedFrameL1Entry? directOwnedEntry))
            {
                _ownedFrameKeysByRedisKey.TryRemove(
                    new KeyValuePair<string, OwnedFrameL1Entry>(directOwnedEntry.RedisKey, directOwnedEntry));
                SafeRemoveMemoryCacheEntry(directOwnedEntry);
                RetireOwnedEntry(directOwnedEntry);
                entryCount++;
                bytes += directOwnedEntry.Frame.LogicalLength;
            }

            if (redisKey is not null)
            {
                if (_ownedFrameKeysByRedisKey.TryRemove(redisKey, out OwnedFrameL1Entry? indexedOwned)
                    && !ReferenceEquals(indexedOwned, directOwnedEntry))
                {
                    _ownedFrameEntries.TryRemove(
                        new KeyValuePair<CacheL1Key, OwnedFrameL1Entry>(indexedOwned.L1Key, indexedOwned));
                    SafeRemoveMemoryCacheEntry(indexedOwned);
                    RetireOwnedEntry(indexedOwned);
                    entryCount++;
                    bytes += indexedOwned.Frame.LogicalLength;
                }
            }
        }

        return new(l1Key.PolicyId, entryCount, bytes);
    }

    private CacheL1InvalidationPolicyReceipt RemoveL1(CachePolicyId policyId, CacheIdentity identity, string redisKey)
        => RemoveL1(identity.ToL1Key(keyScope.ScopeToken, policyId), redisKey);

    CacheL1InvalidationReceipt ICacheLocalInvalidator.InvalidateLocal(IReadOnlyList<CacheKeyIdentity> keys)
    {
        ArgumentNullException.ThrowIfNull(keys);
        if (keys.Count == 0)
        {
            return new(Array.Empty<CacheL1InvalidationPolicyReceipt>());
        }

        var receipts = new Dictionary<CachePolicyId, (int Entries, long Bytes)>();
        var seen = new HashSet<(CachePolicyId PolicyId, string Identity, string? Version)>();
        foreach (CacheKeyIdentity key in keys)
        {
            if (!seen.Add((key.PolicyId, key.Identity, key.Version)))
            {
                continue;
            }

            CachePolicy policy = ResolvePolicy(key.PolicyId);
            CacheIdentity identity = CacheIdentity.FromString(key.Identity, key.Version);
            string redisKey = BuildRedisKey(policy, identity);
            CacheL1InvalidationPolicyReceipt receipt = RemoveL1(key.PolicyId, identity, redisKey);
            if (receipts.TryGetValue(key.PolicyId, out (int Entries, long Bytes) current))
            {
                receipts[key.PolicyId] = (current.Entries + receipt.EntryCount, current.Bytes + receipt.Bytes);
            }
            else
            {
                receipts[key.PolicyId] = (receipt.EntryCount, receipt.Bytes);
            }
        }

        return new(
            receipts
                .OrderBy(static pair => pair.Key)
                .Select(static pair => new CacheL1InvalidationPolicyReceipt(pair.Key, pair.Value.Entries, pair.Value.Bytes))
                .ToArray());
    }

    CacheL1InvalidationReceipt ICacheLocalInvalidator.ReconcileAllLocal()
    {
        CacheL1InvalidationReceipt localReceipt = localStore.ReconcileAllLocal();
        var receipts = localReceipt.ByPolicy
            .ToDictionary(static item => item.PolicyId, static item => (item.EntryCount, item.Bytes));
        lock (_l1MutationLock)
        {
            OwnedFrameL1Entry[] owned = [.. _ownedFrameEntries.Values];
            _ownedFrameEntries.Clear();
            _ownedFrameKeysByRedisKey.Clear();
            foreach (OwnedFrameL1Entry entry in owned)
            {
                SafeRemoveMemoryCacheEntry(entry);
                RetireOwnedEntry(entry);
                if (receipts.TryGetValue(entry.L1Key.PolicyId, out (int Entries, long Bytes) current))
                {
                    receipts[entry.L1Key.PolicyId] = (
                        current.Entries + 1,
                        current.Bytes + entry.Frame.LogicalLength);
                }
                else
                {
                    receipts[entry.L1Key.PolicyId] = (1, entry.Frame.LogicalLength);
                }
            }
        }

        return new(
            receipts
                .OrderBy(static pair => pair.Key)
                .Select(static pair => new CacheL1InvalidationPolicyReceipt(pair.Key, pair.Value.Item1, pair.Value.Item2))
                .ToArray());
    }

    private void RemoveL1ByRedisKey(string redisKey)
    {
        localStore.RemoveByRedisKey(redisKey);
        lock (_l1MutationLock)
        {
            if (_ownedFrameKeysByRedisKey.TryRemove(redisKey, out OwnedFrameL1Entry? ownedEntry))
            {
                _ownedFrameEntries.TryRemove(
                    new KeyValuePair<CacheL1Key, OwnedFrameL1Entry>(ownedEntry.L1Key, ownedEntry));
                SafeRemoveMemoryCacheEntry(ownedEntry);
                RetireOwnedEntry(ownedEntry);
            }
        }
    }

    private void RemoveSupersededOwnedFrameEntry(OwnedFrameL1Entry? previous, OwnedFrameL1Entry current)
    {
        if (previous is null || ReferenceEquals(previous, current))
        {
            return;
        }

        _ownedFrameEntries.TryRemove(
            new KeyValuePair<CacheL1Key, OwnedFrameL1Entry>(previous.L1Key, previous));
        _ownedFrameKeysByRedisKey.TryRemove(
            new KeyValuePair<string, OwnedFrameL1Entry>(previous.RedisKey, previous));
        SafeRemoveMemoryCacheEntry(previous);
        RetireOwnedEntry(previous);
    }

    private void RetireOwnedEntry(OwnedFrameL1Entry entry)
    {
        lock (_l1MutationLock)
        {
            OwnedFrameL1Entry.Retirement retirement = entry.TryRetire();
            if (retirement == OwnedFrameL1Entry.Retirement.AlreadyRetired)
            {
                return;
            }

            if (retirement == OwnedFrameL1Entry.Retirement.Active)
            {
                if (!entry.TryUnaccount())
                {
                    entry.Frame.Retire();
                    return;
                }

                _ownedFrameEntryCount--;
                _ = entry.Frame.Retire(_ => OnOwnedFrameBackingReleased(entry));
                return;
            }

            entry.Frame.Retire();
        }
    }

    private void OnOwnedFrameBackingReleased(OwnedFrameL1Entry entry)
    {
        lock (_l1MutationLock)
        {
            _ownedFrameLogicalBytes -= entry.Frame.LogicalLength;
            _ownedFrameCapacityBytes -= entry.Frame.Capacity;
        }
    }

    private void SafeRemoveMemoryCacheEntry(object key)
    {
        try
        {
            memoryCache.Remove(key);
        }
        catch (ObjectDisposedException)
        {
            // The frame indexes and lease owner remain authoritative during shutdown.
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "Owned-frame memory-cache entry removal failed during retirement");
        }
    }

    private static byte[] CopyRawBytes(byte[] bytes)
        => bytes.Length == 0 ? Array.Empty<byte>() : bytes.ToArray();

    internal static byte[] CopyRawBytesForTests(byte[] bytes)
        => CopyRawBytes(bytes);

    internal static ReadOnlyMemory<byte> BorrowRawBytesReadonlyForTests(byte[] bytes)
        => bytes;

    private async Task SetNegativeCoreAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken)
    {
        CachePolicy policy = ResolvePolicy(policyId);
        if (!policy.NegativeTtl.HasValue || policy.NegativeTtl.Value <= TimeSpan.Zero)
        {
            return;
        }

        CacheIdentity cacheIdentity = CacheIdentity.FromString(identity);
        CacheL1Key l1Key = cacheIdentity.ToL1Key(keyScope.ScopeToken, policyId);
        string key = BuildRedisKey(policy, cacheIdentity);
        _ = await PublishValueAsync(policyId, key, Array.Empty<byte>(), policy.NegativeTtl, null, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        SetL1(policy, l1Key, key, Array.Empty<byte>());
    }

    private async Task<bool> PublishValueAsync(
        CachePolicyId policyId,
        string key,
        RedisValue value,
        TimeSpan? ttl,
        OwnedFramePublicationGuard? publicationGuard,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        CacheRebuildLeaseScope? scope = CacheRebuildLeaseScope.Current;
        if (scope is null)
        {
            RedisOperationPort port = ResolveMutationPort(policyId);
            try
            {
                _ = await _redisOperations.ExecuteAsync(
                    port,
                    (multiplexer, _) => multiplexer.GetDatabase().StringSetAsync(
                        key,
                        value,
                        ttl,
                        When.Always,
                        CommandFlags.None),
                    cancellationToken).ConfigureAwait(false);
            }
            catch (RedisOperationUnavailableException exception)
                when (exception.Port.OperationClass == RedisOperationClass.ContentCacheWrite)
            {
                logger.LogWarning(
                    exception,
                    "Cache Redis write degraded for policy {PolicyId}; retaining the local result",
                    CachePolicyTelemetry.Name(policyId));
                telemetry.RecordOperation(
                    "set",
                    CachePolicyTelemetry.Name(policyId),
                    "l2",
                    "redis_degraded",
                    TimeSpan.Zero);
                if (publicationGuard.HasValue)
                {
                    throw;
                }

                return true;
            }
            cancellationToken.ThrowIfCancellationRequested();
            await RegisterKeyAsync(policyId, key, cancellationToken).ConfigureAwait(false);
            return true;
        }

        scope.EnsureActive();
        bool register = ResolvePolicy(policyId).RegisterKeysForPrefixInvalidation;
        var keys = new List<RedisKey>
        {
            key,
            register ? ResolveRegistryKey(policyId) : key,
            publicationGuard.HasValue
                ? BuildKey(publicationGuard.Value.PolicyId, publicationGuard.Value.Identity)
                : key
        };
        var values = new List<RedisValue>
        {
            value,
            ttl.HasValue ? Math.Max(1, checked((long)ttl.Value.TotalMilliseconds)) : 0,
            register ? 1 : 0,
            publicationGuard.HasValue ? 1 : 0,
            publicationGuard?.ExpectedValue ?? 0
        };
        for (CacheRebuildLeaseScope? lease = scope; lease is not null; lease = lease.Parent)
        {
            if (!ReferenceEquals(lease.Store, this))
            {
                throw new CacheCoordinationException("publication-store-mismatch", policyId);
            }
            keys.Add(BuildKey(lease.PolicyId, lease.Identity));
            values.Add(lease.Value);
        }

        // The authority check and publication share a Redis linearization point.
        // Checking a token before issuing SET would leave a lease-expiry race.
        const string Script = """
if ARGV[4] == '1' and tonumber(redis.call('GET', KEYS[3]) or '0') ~= tonumber(ARGV[5]) then return -2 end
for i = 4, #KEYS do
  if redis.call('GET', KEYS[i]) ~= ARGV[i + 2] then return 0 end
end
if ARGV[3] == '1' then
  local registryType = redis.call('TYPE', KEYS[2]).ok
  if registryType ~= 'none' and registryType ~= 'set' then return -1 end
end
if tonumber(ARGV[2]) > 0 then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
else
  redis.call('SET', KEYS[1], ARGV[1])
end
if ARGV[3] == '1' then redis.call('SADD', KEYS[2], KEYS[1]) end
return 1
""";
        RedisResult result = await _redisOperations.ExecuteAsync(
            RedisOperationPort.UnifiedCacheLease,
            (multiplexer, _) => multiplexer.GetDatabase().ScriptEvaluateAsync(
                Script,
                keys.ToArray(),
                values.ToArray()),
            cancellationToken).ConfigureAwait(false);
        if ((long)result == -2)
        {
            return false;
        }
        if ((long)result != 1)
        {
            throw new CacheCoordinationException((long)result == 0 ? "publication-lease-lost" : "publication-registry-invalid", policyId);
        }
        cancellationToken.ThrowIfCancellationRequested();
        scope.EnsureActive();
        return true;
    }

    private static TimeSpan ApplyDeterministicJitter(string cacheKey, TimeSpan baseTtl, double jitterRatio)
    {
        if (baseTtl <= TimeSpan.Zero || jitterRatio <= 0d)
        {
            return baseTtl;
        }

        long jitterWindow = (long)(baseTtl.Ticks * jitterRatio);
        if (jitterWindow <= 0)
        {
            return baseTtl;
        }

        ulong hash = ComputeDeterministicHash(cacheKey);
        ulong span = (ulong)(jitterWindow * 2L) + 1UL;
        long offset = (long)(hash % span) - jitterWindow;
        long adjustedTicks = Math.Max(1L, baseTtl.Ticks + offset);
        return TimeSpan.FromTicks(adjustedTicks);
    }

    private static ulong ComputeDeterministicHash(ReadOnlySpan<char> input)
    {
        const ulong Offset = 14695981039346656037UL;
        const ulong Prime = 1099511628211UL;

        ulong hash = Offset;
        for (int i = 0; i < input.Length; i++)
        {
            hash ^= input[i];
            hash *= Prime;
        }

        return hash;
    }

    internal static string BuildRegistryKey(CachePolicyId policyId)
        => $"{RegistryKeyPrefix}{(int)policyId}";

    private string ResolveRegistryKey(CachePolicyId policyId)
        => keyScope.PrefixKey(BuildRegistryKey(policyId));

    internal static string BuildRegistryKeyForTests(CachePolicyId policyId)
        => BuildRegistryKey(policyId);

    internal static TimeSpan ApplyDeterministicJitterForTests(TimeSpan baseTtl, double jitterRatio, string cacheKey)
        => ApplyDeterministicJitter(cacheKey, baseTtl, jitterRatio);

    private static TimeSpan? ResolveL2Expiry(string cacheKey, CachePolicy policy, TimeSpan? l2TtlOverride)
    {
        if (l2TtlOverride.HasValue)
        {
            return ToRedisExpiry(l2TtlOverride.Value);
        }

        return ToRedisExpiry(ApplyDeterministicJitter(cacheKey, policy.L2Ttl, policy.L2JitterRatio));
    }

    private static TimeSpan? ToRedisExpiry(TimeSpan ttl)
        => ttl == Timeout.InfiniteTimeSpan ? null : ttl;

    internal static IReadOnlyList<string> FilterRegistryKeys(string prefix, ReadOnlySpan<RedisValue> registeredKeys)
    {
        var matches = new List<string>(registeredKeys.Length);
        foreach (RedisValue key in registeredKeys)
        {
            if (key.IsNullOrEmpty)
            {
                continue;
            }

            string value = key.ToString();
            if (value.StartsWith(prefix, StringComparison.Ordinal))
            {
                matches.Add(value);
            }
        }

        return matches;
    }

    internal static IReadOnlyList<string> FilterRegistryKeysByPrefixes(IReadOnlyList<string> prefixes, ReadOnlySpan<RedisValue> registeredKeys)
    {
        var matches = new List<string>(registeredKeys.Length);
        foreach (RedisValue key in registeredKeys)
        {
            if (key.IsNullOrEmpty)
            {
                continue;
            }

            string value = key.ToString();
            if (StartsWithAny(value, prefixes))
            {
                matches.Add(value);
            }
        }

        return matches;
    }

    internal static string BuildCommonPrefixForTests(IReadOnlyList<string> prefixes)
        => BuildCommonPrefix(prefixes);

    private static bool StartsWithAny(string value, IReadOnlyList<string> prefixes)
    {
        foreach (string prefix in prefixes)
        {
            if (value.StartsWith(prefix, StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }

    private static string BuildCommonPrefix(IReadOnlyList<string> prefixes)
    {
        if (prefixes.Count == 0)
        {
            return string.Empty;
        }

        string common = prefixes[0];
        for (int i = 1; i < prefixes.Count && common.Length > 0; i++)
        {
            string current = prefixes[i];
            int length = Math.Min(common.Length, current.Length);
            int index = 0;
            while (index < length && common[index] == current[index])
            {
                index++;
            }

            common = common[..index];
        }

        return common;
    }

    private async Task RegisterKeyAsync(
        CachePolicyId policyId,
        string key,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!ResolvePolicy(policyId).RegisterKeysForPrefixInvalidation)
        {
            return;
        }

        RedisOperationPort port = ResolveMutationPort(policyId);
        try
        {
            _ = await ExecuteDatabaseAsync(
                port,
                (database, _) => database.SetAddAsync(ResolveRegistryKey(policyId), key),
                cancellationToken).ConfigureAwait(false);
        }
        catch (RedisOperationUnavailableException exception)
            when (exception.Port.OperationClass == RedisOperationClass.ContentCacheWrite)
        {
            logger.LogDebug(
                exception,
                "Cache registry write degraded for policy {PolicyId}",
                CachePolicyTelemetry.Name(policyId));
        }
    }

    private async Task UnregisterKeyAsync(CachePolicyId policyId, string key, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!ResolvePolicy(policyId).RegisterKeysForPrefixInvalidation)
        {
            return;
        }

        RedisOperationPort port = ResolveMutationPort(policyId);
        try
        {
            _ = await ExecuteDatabaseAsync(
                port,
                (database, _) => database.SetRemoveAsync(ResolveRegistryKey(policyId), key),
                cancellationToken).ConfigureAwait(false);
        }
        catch (RedisOperationUnavailableException exception)
            when (exception.Port.OperationClass == RedisOperationClass.ContentCacheWrite)
        {
            logger.LogDebug(
                exception,
                "Cache registry removal degraded for policy {PolicyId}",
                CachePolicyTelemetry.Name(policyId));
        }
    }

    private CachePolicy ResolvePolicy(CachePolicyId policyId)
    {
        if (policyRegistry.TryGet(policyId, out CachePolicy policy))
        {
            return policy;
        }

        logger.LogError("Cache policy missing: {PolicyId}", policyId);
        return new CachePolicy(
            policyId,
            "missing",
            $"policy-{policyId}",
            TimeSpan.Zero,
            s_missingPolicyL2Ttl,
            null,
            null,
            true);
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        localStore.Dispose();
        OwnedFrameL1Entry[] entries;
        lock (_l1MutationLock)
        {
            entries = _ownedFrameEntries.Values.ToArray();
            _ownedFrameEntries.Clear();
            _ownedFrameKeysByRedisKey.Clear();
            foreach (OwnedFrameL1Entry entry in entries)
            {
                SafeRemoveMemoryCacheEntry(entry);
            }
        }

        foreach (OwnedFrameL1Entry entry in entries)
        {
            RetireOwnedEntry(entry);
        }
    }

    private void ThrowIfDisposed()
    {
        ObjectDisposedException.ThrowIf(Volatile.Read(ref _disposed) != 0, this);
    }

    private sealed class OwnedFrameL1Entry(
        CacheL1Key l1Key,
        string redisKey,
        OwnedAedsFrame frame,
        long expiresAtTimestamp)
    {
        private const int CreatedState = 0;
        private const int ActiveState = 1;
        private const int RetiredState = 2;
        private int _state;
        private int _accounted;
        private long _lastAccessTimestamp = Stopwatch.GetTimestamp();

        internal CacheL1Key L1Key { get; } = l1Key;
        internal string RedisKey { get; } = redisKey;
        internal OwnedAedsFrame Frame { get; } = frame;
        internal long ExpiresAtTimestamp { get; } = expiresAtTimestamp;
        internal long LastAccessTimestamp => Volatile.Read(ref _lastAccessTimestamp);

        internal void Touch() => Volatile.Write(ref _lastAccessTimestamp, Stopwatch.GetTimestamp());

        internal bool TryActivate()
            => Interlocked.CompareExchange(ref _state, ActiveState, CreatedState) == CreatedState;

        internal void MarkAccounted() => Volatile.Write(ref _accounted, 1);

        internal bool TryUnaccount() => Interlocked.Exchange(ref _accounted, 0) == 1;

        internal Retirement TryRetire()
        {
            int previous = Interlocked.Exchange(ref _state, RetiredState);
            return previous switch
            {
                ActiveState => Retirement.Active,
                CreatedState => Retirement.NotActive,
                _ => Retirement.AlreadyRetired
            };
        }

        internal enum Retirement : byte
        {
            AlreadyRetired = 0,
            NotActive = 1,
            Active = 2
        }
    }

    private sealed record OwnedFrameL1EvictionState(
        UnifiedCache Owner,
        string RedisKey,
        OwnedFrameL1Entry Entry);

}
