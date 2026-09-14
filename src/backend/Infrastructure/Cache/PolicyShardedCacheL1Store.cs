using System.Buffers;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace FsusBlog.Server.Infrastructure.Cache;

public sealed record CacheL1PolicyResidencySnapshot(
    CachePolicyId PolicyId,
    int MaxEntries,
    long MaxLogicalBytes,
    long MaxCapacityBytes,
    long Entries,
    long LogicalBytes,
    long CapacityBytes,
    long Hits,
    long Misses,
    long ExpiredEvictions,
    long CapacityEvictions,
    long ReplacedEvictions,
    long InvalidatedEvictions,
    long AdmissionRejects,
    long ContendedLockWaitTicks);

public sealed class PolicyShardedCacheL1Store : IDisposable
{
    private const long DefaultGlobalCapacityCeiling = 256L * 1024 * 1024;
    internal const int FixedCapacityBytesPerEntry = 192;
    internal const int ReadLeaseAllocationBudgetBytes = 256;
    private readonly Partition?[] _partitions;
    private readonly ConcurrentDictionary<string, CacheL1Key> _keysByRedisKey = new(StringComparer.Ordinal);
    private readonly string _scopeToken;
    private readonly TimeProvider _timeProvider;
    private int _disposed;

    public PolicyShardedCacheL1Store(
        ICachePolicyRegistry policyRegistry,
        IRuntimeKeyScope runtimeKeyScope,
        TimeProvider timeProvider)
    {
        ArgumentNullException.ThrowIfNull(policyRegistry);
        ArgumentNullException.ThrowIfNull(runtimeKeyScope);
        ArgumentNullException.ThrowIfNull(timeProvider);
        _scopeToken = string.IsNullOrWhiteSpace(runtimeKeyScope.ScopeToken)
            ? "default"
            : runtimeKeyScope.ScopeToken;
        _timeProvider = timeProvider;

        CachePolicy[] policies = Enum.GetValues<CachePolicyId>()
            .Select(id => policyRegistry.TryGet(id, out CachePolicy policy) ? policy : null)
            .Where(static policy => policy is not null && policy.L1Ttl > TimeSpan.Zero)
            .Cast<CachePolicy>()
            .ToArray();
        int slots = Math.Max(1, Enum.GetValues<CachePolicyId>().Max(static id => (int)id) + 1);
        _partitions = new Partition?[slots];
        if (policies.Length == 0)
        {
            return;
        }

        long available = Math.Max(1L, GC.GetGCMemoryInfo().TotalAvailableMemoryBytes);
        long globalCapacity = Math.Max(1L, Math.Min(DefaultGlobalCapacityCeiling, available / 20));
        long fairCapacity = Math.Max(1L, globalCapacity / policies.Length);
        foreach (CachePolicy policy in policies)
        {
            ValidateBudget(policy);
            long capacity = Math.Min(policy.L1MaxCapacityBytes, fairCapacity);
            long logical = Math.Min(policy.L1MaxLogicalBytes, capacity);
            _partitions[(int)policy.Id] = new Partition(
                policy.Id,
                policy.L1MaxEntries,
                logical,
                capacity,
                policy.L1EvictionPolicy,
                policy.SecurityCritical);
        }
    }

    public PolicyShardedCacheL1Store(ICachePolicyRegistry policyRegistry, IRuntimeKeyScope runtimeKeyScope)
        : this(policyRegistry, runtimeKeyScope, TimeProvider.System)
    {
    }

    internal PolicyShardedCacheL1Store(ICachePolicyRegistry policyRegistry, TimeProvider timeProvider)
        : this(policyRegistry, new DefaultRuntimeKeyScope(), timeProvider)
    {
    }

    internal PolicyShardedCacheL1Store(ICachePolicyRegistry policyRegistry)
        : this(policyRegistry, new DefaultRuntimeKeyScope(), TimeProvider.System)
    {
    }

    internal bool TryAcquire(CacheL1Key key, out CacheL1ReadLease lease)
    {
        ThrowIfDisposed();
        Partition? partition = ResolvePartition(key.PolicyId);
        if (partition is null)
        {
            lease = null!;
            return false;
        }

        bool lockTaken = false;
        long waitStartedAt = 0;
        if (!Monitor.TryEnter(partition.Gate))
        {
            waitStartedAt = Stopwatch.GetTimestamp();
            Monitor.Enter(partition.Gate);
        }

        lockTaken = true;
        try
        {
            if (waitStartedAt != 0)
            {
                partition._contendedLockWaitTicks += Stopwatch.GetTimestamp() - waitStartedAt;
            }

            if (!partition.Entries.TryGetValue(key, out Entry? entry))
            {
                partition._misses++;
                lease = null!;
                return false;
            }

            if (_timeProvider.GetTimestamp() >= entry.ExpiresAtTimestamp)
            {
                RemoveEntry(partition, entry, CacheL1EvictionReason.Expired, clearPayload: true);
                partition._misses++;
                lease = null!;
                return false;
            }

            partition.Lru.Remove(entry.LruNode);
            partition.Lru.AddLast(entry.LruNode);
            partition._hits++;
            entry._leaseCount++;
            lease = new CacheL1ReadLease(this, partition, entry);
            return true;
        }
        finally
        {
            if (lockTaken)
            {
                Monitor.Exit(partition.Gate);
            }
        }
    }

    internal bool TryGet(CacheL1Key key, out byte[] bytes)
    {
        if (!TryAcquire(key, out CacheL1ReadLease lease))
        {
            bytes = null!;
            return false;
        }

        using (lease)
        {
            bytes = lease.Memory.ToArray();
            return true;
        }
    }

    internal bool TrySetOwned(CachePolicy policy, CacheL1Key key, string redisKey, byte[] bytes)
    {
        ThrowIfDisposed();
        ArgumentNullException.ThrowIfNull(policy);
        ArgumentNullException.ThrowIfNull(redisKey);
        ArgumentNullException.ThrowIfNull(bytes);
        Partition? partition = ResolvePartition(policy.Id);
        if (partition is null || policy.L1Ttl <= TimeSpan.Zero)
        {
            return false;
        }

        long logicalBytes = bytes.LongLength;
        long capacityBytes = MeasureCapacityBytes(key, redisKey, bytes);
        if (logicalBytes > partition.MaxLogicalBytes || capacityBytes > partition.MaxCapacityBytes)
        {
            Interlocked.Increment(ref partition._admissionRejects);
            return false;
        }

        long ttlTimestampDelta = (long)Math.Ceiling(policy.L1Ttl.TotalSeconds * _timeProvider.TimestampFrequency);
        long expiresAtTimestamp = _timeProvider.GetTimestamp() + Math.Max(1L, ttlTimestampDelta);

        if (_keysByRedisKey.TryGetValue(redisKey, out CacheL1Key indexedKey) && indexedKey != key)
        {
            _ = Remove(indexedKey, redisKey);
        }

        lock (partition.Gate)
        {
            if (Volatile.Read(ref _disposed) != 0)
            {
                return false;
            }

            if (partition.Entries.TryGetValue(key, out Entry? previous))
            {
                if (previous.RedisKey == redisKey && previous._leaseCount == 0)
                {
                    ReplaceUnleasedEntry(
                        partition,
                        previous,
                        bytes,
                        expiresAtTimestamp,
                        logicalBytes,
                        capacityBytes);
                    return true;
                }

                RemoveEntry(partition, previous, CacheL1EvictionReason.Replaced, clearPayload: !ReferenceEquals(previous.Bytes, bytes));
            }

            while (partition.Entries.Count >= partition.MaxEntries
                || partition._logicalBytes + logicalBytes > partition.MaxLogicalBytes
                || partition._capacityBytes + capacityBytes > partition.MaxCapacityBytes)
            {
                LinkedListNode<CacheL1Key>? oldest = partition.Lru.First;
                if (oldest is null || !partition.Entries.TryGetValue(oldest.Value, out Entry? victim))
                {
                    throw new InvalidOperationException($"cache_l1_partition_corrupt:{policy.Id}");
                }

                RemoveEntry(partition, victim, CacheL1EvictionReason.Capacity, clearPayload: true);
            }

            var node = new LinkedListNode<CacheL1Key>(key);
            var entry = new Entry(
                key,
                redisKey,
                bytes,
                expiresAtTimestamp,
                logicalBytes,
                capacityBytes,
                partition.Sensitive,
                node);
            partition.Entries.Add(key, entry);
            _keysByRedisKey[redisKey] = key;
            partition.Lru.AddLast(node);
            partition._logicalBytes += logicalBytes;
            partition._capacityBytes += capacityBytes;
            return true;
        }
    }

    internal CacheL1InvalidationPolicyReceipt Remove(CacheL1Key key, string? redisKey = null)
    {
        Partition? partition = ResolvePartition(key.PolicyId);
        if (partition is null)
        {
            return new(key.PolicyId, 0, 0);
        }

        lock (partition.Gate)
        {
            int count = 0;
            long bytes = 0;
            if (partition.Entries.TryGetValue(key, out Entry? direct))
            {
                count++;
                bytes += direct.LogicalBytes;
                RemoveEntry(partition, direct, CacheL1EvictionReason.Invalidated, clearPayload: true);
            }

            if (redisKey is not null
                && _keysByRedisKey.TryGetValue(redisKey, out CacheL1Key indexedKey)
                && indexedKey != key
                && indexedKey.PolicyId == key.PolicyId
                && partition.Entries.TryGetValue(indexedKey, out Entry? indexed))
            {
                count++;
                bytes += indexed.LogicalBytes;
                RemoveEntry(partition, indexed, CacheL1EvictionReason.Invalidated, clearPayload: true);
            }

            return new(key.PolicyId, count, bytes);
        }
    }

    internal void RemoveByRedisKey(string redisKey)
    {
        if (_keysByRedisKey.TryGetValue(redisKey, out CacheL1Key key))
        {
            _ = Remove(key, redisKey);
        }
    }

    internal CacheL1InvalidationReceipt InvalidateLocal(IReadOnlyList<CacheKeyIdentity> keys)
    {
        ArgumentNullException.ThrowIfNull(keys);
        var receipts = new Dictionary<CachePolicyId, (int Entries, long Bytes)>();
        foreach (CacheKeyIdentity key in keys.Distinct())
        {
            CacheL1Key l1Key = CacheIdentity
                .FromString(key.Identity, key.Version)
                .ToL1Key(_scopeToken, key.PolicyId);
            CacheL1InvalidationPolicyReceipt receipt = Remove(l1Key);
            receipts.TryGetValue(key.PolicyId, out (int Entries, long Bytes) current);
            receipts[key.PolicyId] = (current.Entries + receipt.EntryCount, current.Bytes + receipt.Bytes);
        }

        return new(receipts
            .OrderBy(static pair => pair.Key)
            .Select(static pair => new CacheL1InvalidationPolicyReceipt(pair.Key, pair.Value.Entries, pair.Value.Bytes))
            .ToArray());
    }

    internal IReadOnlyList<CachePolicyStorageSnapshot> SnapshotResidency()
        => SnapshotPolicyResidency()
            .Where(static item => item.Entries > 0)
            .Select(static item => new CachePolicyStorageSnapshot(
                item.PolicyId,
                item.Entries,
                item.LogicalBytes,
                item.CapacityBytes))
            .ToArray();

    internal IReadOnlyList<CacheL1PolicyResidencySnapshot> SnapshotPolicyResidency()
    {
        var snapshots = new List<CacheL1PolicyResidencySnapshot>();
        foreach (Partition? partition in _partitions)
        {
            if (partition is null)
            {
                continue;
            }

            lock (partition.Gate)
            {
                snapshots.Add(new CacheL1PolicyResidencySnapshot(
                    partition.PolicyId,
                    partition.MaxEntries,
                    partition.MaxLogicalBytes,
                    partition.MaxCapacityBytes,
                    partition.Entries.Count,
                    partition._logicalBytes,
                    partition._capacityBytes,
                    partition._hits,
                    partition._misses,
                    partition._expiredEvictions,
                    partition._capacityEvictions,
                    partition._replacedEvictions,
                    partition._invalidatedEvictions,
                    partition._admissionRejects,
                    partition._contendedLockWaitTicks));
            }
        }

        return snapshots;
    }

    internal CacheL1InvalidationReceipt ReconcileAllLocal()
    {
        var receipts = new List<CacheL1InvalidationPolicyReceipt>();
        foreach (Partition? partition in _partitions)
        {
            if (partition is null)
            {
                continue;
            }

            lock (partition.Gate)
            {
                int count = partition.Entries.Count;
                long bytes = partition._logicalBytes;
                foreach (Entry entry in partition.Entries.Values)
                {
                    entry._retired = true;
                    entry._clearOnRelease = true;
                    _keysByRedisKey.TryRemove(
                        new KeyValuePair<string, CacheL1Key>(entry.RedisKey, entry.Key));
                    if (entry._leaseCount == 0)
                    {
                        ClearSensitive(entry);
                    }
                }

                partition.Entries.Clear();
                partition.Lru.Clear();
                partition._logicalBytes = 0;
                partition._capacityBytes = 0;
                if (count > 0)
                {
                    receipts.Add(new CacheL1InvalidationPolicyReceipt(partition.PolicyId, count, bytes));
                }
            }
        }

        return new(receipts);
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        _ = ReconcileAllLocal();
    }

    private Partition? ResolvePartition(CachePolicyId policyId)
    {
        int index = (int)policyId;
        return (uint)index < (uint)_partitions.Length ? _partitions[index] : null;
    }

    private void RemoveEntry(
        Partition partition,
        Entry entry,
        CacheL1EvictionReason reason,
        bool clearPayload)
    {
        partition.Entries.Remove(entry.Key);
        _keysByRedisKey.TryRemove(new KeyValuePair<string, CacheL1Key>(entry.RedisKey, entry.Key));

        partition.Lru.Remove(entry.LruNode);
        partition._logicalBytes -= entry.LogicalBytes;
        partition._capacityBytes -= entry.CapacityBytes;
        if (reason == CacheL1EvictionReason.Expired)
        {
            partition._expiredEvictions++;
        }
        else if (reason == CacheL1EvictionReason.Capacity)
        {
            partition._capacityEvictions++;
        }
        else if (reason == CacheL1EvictionReason.Replaced)
        {
            partition._replacedEvictions++;
        }
        else if (reason == CacheL1EvictionReason.Invalidated)
        {
            partition._invalidatedEvictions++;
        }

        entry._retired = true;
        entry._clearOnRelease = clearPayload;
        if (clearPayload && entry._leaseCount == 0)
        {
            ClearSensitive(entry);
        }
    }

    private void ReplaceUnleasedEntry(
        Partition partition,
        Entry entry,
        byte[] bytes,
        long expiresAtTimestamp,
        long logicalBytes,
        long capacityBytes)
    {
        while (partition._logicalBytes - entry.LogicalBytes + logicalBytes > partition.MaxLogicalBytes
            || partition._capacityBytes - entry.CapacityBytes + capacityBytes > partition.MaxCapacityBytes)
        {
            LinkedListNode<CacheL1Key>? candidate = partition.Lru.First;
            while (candidate is not null && candidate.Value == entry.Key)
            {
                candidate = candidate.Next;
            }

            if (candidate is null || !partition.Entries.TryGetValue(candidate.Value, out Entry? victim))
            {
                throw new InvalidOperationException($"cache_l1_partition_corrupt:{partition.PolicyId}");
            }

            RemoveEntry(partition, victim, CacheL1EvictionReason.Capacity, clearPayload: true);
        }

        if (!ReferenceEquals(entry.Bytes, bytes))
        {
            ClearSensitive(entry);
        }

        partition._logicalBytes += logicalBytes - entry.LogicalBytes;
        partition._capacityBytes += capacityBytes - entry.CapacityBytes;
        entry.Bytes = bytes;
        entry.ExpiresAtTimestamp = expiresAtTimestamp;
        entry.LogicalBytes = logicalBytes;
        entry.CapacityBytes = capacityBytes;
        partition.Lru.Remove(entry.LruNode);
        partition.Lru.AddLast(entry.LruNode);
        partition._replacedEvictions++;
    }

    private static void ClearSensitive(Entry entry)
    {
        if (entry.Sensitive)
        {
            entry.Bytes.AsSpan().Clear();
        }
    }

    private void Release(Partition partition, Entry entry)
    {
        lock (partition.Gate)
        {
            if (entry._leaseCount <= 0)
            {
                throw new InvalidOperationException($"cache_l1_lease_underflow:{partition.PolicyId}");
            }

            entry._leaseCount--;
            if (entry._retired && entry._clearOnRelease && entry._leaseCount == 0)
            {
                ClearSensitive(entry);
            }
        }
    }

    private static void ValidateBudget(CachePolicy policy)
    {
        if (policy.L1MaxEntries <= 0
            || policy.L1MaxLogicalBytes <= 0
            || policy.L1MaxCapacityBytes <= 0
            || policy.L1MaxLogicalBytes > policy.L1MaxCapacityBytes
            || !Enum.IsDefined(policy.L1EvictionPolicy))
        {
            throw new InvalidOperationException($"cache_l1_policy_budget_invalid:{policy.Id}");
        }
    }

    private void ThrowIfDisposed()
        => ObjectDisposedException.ThrowIf(Volatile.Read(ref _disposed) != 0, this);

    internal static long MeasureCapacityBytes(CacheL1Key key, string redisKey, byte[] bytes)
        => checked(
            bytes.LongLength
            + FixedCapacityBytesPerEntry
            + MeasureStringCapacity(key.Scope)
            + MeasureStringCapacity(key.StringIdentity)
            + MeasureStringCapacity(key.Version)
            + MeasureStringCapacity(redisKey));

    private static long MeasureStringCapacity(string? value)
        => value is null ? 0 : checked(sizeof(char) * (long)value.Length);

    internal sealed class Partition(
        CachePolicyId policyId,
        int maxEntries,
        long maxLogicalBytes,
        long maxCapacityBytes,
        CacheL1EvictionPolicy evictionPolicy,
        bool sensitive)
    {
        internal CachePolicyId PolicyId { get; } = policyId;
        internal int MaxEntries { get; } = maxEntries;
        internal long MaxLogicalBytes { get; } = maxLogicalBytes;
        internal long MaxCapacityBytes { get; } = maxCapacityBytes;
        internal CacheL1EvictionPolicy EvictionPolicy { get; } = evictionPolicy;
        internal bool Sensitive { get; } = sensitive;
        internal object Gate { get; } = new();
        internal Dictionary<CacheL1Key, Entry> Entries { get; } = [];
        internal LinkedList<CacheL1Key> Lru { get; } = [];
        internal long _logicalBytes;
        internal long _capacityBytes;
        internal long _hits;
        internal long _misses;
        internal long _expiredEvictions;
        internal long _capacityEvictions;
        internal long _replacedEvictions;
        internal long _invalidatedEvictions;
        internal long _admissionRejects;
        internal long _contendedLockWaitTicks;
    }

    internal sealed class Entry(
        CacheL1Key key,
        string redisKey,
        byte[] bytes,
        long expiresAtTimestamp,
        long logicalBytes,
        long capacityBytes,
        bool sensitive,
        LinkedListNode<CacheL1Key> lruNode)
    {
        internal CacheL1Key Key { get; } = key;
        internal string RedisKey { get; } = redisKey;
        internal byte[] Bytes { get; set; } = bytes;
        internal long ExpiresAtTimestamp { get; set; } = expiresAtTimestamp;
        internal long LogicalBytes { get; set; } = logicalBytes;
        internal long CapacityBytes { get; set; } = capacityBytes;
        internal bool Sensitive { get; } = sensitive;
        internal LinkedListNode<CacheL1Key> LruNode { get; } = lruNode;
        internal int _leaseCount;
        internal bool _retired;
        internal bool _clearOnRelease;
    }

    internal sealed class CacheL1ReadLease : IDisposable
    {
        private LeaseMemoryManager? _memoryManager;

        internal CacheL1ReadLease(
            PolicyShardedCacheL1Store owner,
            Partition partition,
            Entry entry)
        {
            _memoryManager = new LeaseMemoryManager(
                entry.Bytes,
                () => owner.Release(partition, entry));
        }

        internal ReadOnlyMemory<byte> Memory
            => (Volatile.Read(ref _memoryManager)
                ?? throw new ObjectDisposedException(nameof(CacheL1ReadLease))).ReadOnlyMemory;

        public void Dispose()
        {
            LeaseMemoryManager? manager = Interlocked.Exchange(ref _memoryManager, null);
            if (manager is not null)
            {
                ((IDisposable)manager).Dispose();
            }
        }

        private sealed class LeaseMemoryManager(byte[] bytes, Action release) : MemoryManager<byte>
        {
            private readonly object _gate = new();
            private byte[]? _bytes = bytes;
            private Action? _release = release;
            private int _pinCount;
            private bool _disposed;

            internal ReadOnlyMemory<byte> ReadOnlyMemory => Memory;

            public override Span<byte> GetSpan()
            {
                lock (_gate)
                {
                    ThrowIfDisposed();
                    return _bytes;
                }
            }

            public override unsafe MemoryHandle Pin(int elementIndex = 0)
            {
                lock (_gate)
                {
                    ThrowIfDisposed();
                    if ((uint)elementIndex > (uint)_bytes!.Length)
                    {
                        throw new ArgumentOutOfRangeException(nameof(elementIndex));
                    }

                    GCHandle handle = GCHandle.Alloc(_bytes, GCHandleType.Pinned);
                    try
                    {
                        _pinCount++;
                        void* pointer = (byte*)handle.AddrOfPinnedObject().ToPointer() + elementIndex;
                        return new MemoryHandle(pointer, handle, this);
                    }
                    catch
                    {
                        _pinCount--;
                        handle.Free();
                        throw;
                    }
                }
            }

            public override void Unpin()
            {
                Action? release = null;
                lock (_gate)
                {
                    if (_pinCount <= 0)
                    {
                        throw new InvalidOperationException("A cache L1 memory handle was unpinned more than once.");
                    }

                    _pinCount--;
                    release = DetachAfterDisposeIfReady();
                }

                release?.Invoke();
            }

            protected override void Dispose(bool disposing)
            {
                Action? release = null;
                lock (_gate)
                {
                    if (_disposed)
                    {
                        return;
                    }

                    _disposed = true;
                    release = DetachAfterDisposeIfReady();
                }

                release?.Invoke();
            }

            private Action? DetachAfterDisposeIfReady()
            {
                if (!_disposed || _pinCount != 0)
                {
                    return null;
                }

                _bytes = null;
                Action? release = _release;
                _release = null;
                return release;
            }

            private void ThrowIfDisposed()
            {
                if (_disposed || _bytes is null)
                {
                    throw new ObjectDisposedException(nameof(CacheL1ReadLease));
                }
            }
        }
    }

    private enum CacheL1EvictionReason : byte
    {
        Replaced = 0,
        Expired = 1,
        Capacity = 2,
        Invalidated = 3
    }
}
