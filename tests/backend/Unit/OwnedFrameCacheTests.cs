using System.Buffers;
using System.Collections.Concurrent;

using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Results;

using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using StackExchange.Redis;
namespace FsusBlog.Server.Tests.Unit;

public sealed class OwnedFrameCacheTests
{
    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    public async Task SetOwnedFrame_RetainsSensitiveBufferAcrossRedisAwaitAndReaderThenReleasesOnce()
    {
        var pool = new MultiTrackingArrayPool();
        (OwnedAedsFrame owner, byte[] backing) = BuildFrame(pool, AedsFrameType.AdminStats, 4096);
        OwnedAedsFrameReadLease responseLease = owner.AcquireReadLease();
        var writeEntered = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseWrite = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        IDatabase db = Substitute.For<IDatabase>();
        db.StringSetAsync(
                Arg.Any<RedisKey>(),
                Arg.Any<RedisValue>(),
                Arg.Any<TimeSpan?>(),
                Arg.Any<When>(),
                Arg.Any<CommandFlags>())
            .Returns(async call =>
            {
                byte[] observed = (byte[])call.ArgAt<RedisValue>(1)!;
                Assert.Equal(owner.LogicalLength, observed.Length);
                writeEntered.TrySetResult(true);
                await releaseWrite.Task;
                Assert.Equal(owner.LogicalLength, observed.Length);
                return true;
            });
        using var memory = new MemoryCache(new MemoryCacheOptions());
        using UnifiedCache cache = CreateCache(memory, db);

        Task set = cache.SetOwnedFrameAsync(CachePolicyId.AdminStatsFrame, "core:main", owner);
        await writeEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(0, pool.ReturnCount);
        Assert.Equal(AedsFrameHeader.Magic, BitConverter.ToUInt32(responseLease.Memory.Span[..4]));

        releaseWrite.TrySetResult(true);
        await set;
        Assert.Equal(1, cache.GetOwnedFrameResidencySnapshot().EntryCount);
        await cache.RemoveAsync(CachePolicyId.AdminStatsFrame, "core:main");
        Assert.Equal(0, pool.ReturnCount);

        responseLease.Dispose();

        Assert.True(SpinWait.SpinUntil(() => pool.ReturnCount == 1, TimeSpan.FromSeconds(5)));
        Assert.True(pool.WasCleared(backing));
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    public async Task ReplaceAndShutdown_RetireEachOwnerOnceAndResidencyTracksBackingCapacity()
    {
        var pool = new MultiTrackingArrayPool(extraCapacity: 113);
        (OwnedAedsFrame first, byte[] firstBacking) = BuildFrame(pool, AedsFrameType.ArticleList, 1024);
        OwnedAedsFrameReadLease firstReader = first.AcquireReadLease();
        (OwnedAedsFrame second, byte[] secondBacking) = BuildFrame(pool, AedsFrameType.ArticleList, 2048);
        IDatabase db = SuccessfulDatabase();
        using var memory = new MemoryCache(new MemoryCacheOptions());
        UnifiedCache cache = CreateCache(memory, db);

        await cache.SetOwnedFrameAsync(CachePolicyId.ArticleListFrame, "v:1:home", first);
        await cache.SetOwnedFrameAsync(CachePolicyId.ArticleListFrame, "v:1:home", second);

        Assert.Equal(0, pool.ReturnCount);
        OwnedFrameCacheResidencySnapshot residency = cache.GetOwnedFrameResidencySnapshot();
        Assert.Equal(1, residency.EntryCount);
        Assert.Equal(first.LogicalLength + second.LogicalLength, residency.LogicalBytes);
        Assert.Equal(first.Capacity + second.Capacity, residency.CapacityBytes);
        Assert.True(residency.CapacityBytes > residency.LogicalBytes);

        firstReader.Dispose();
        Assert.True(SpinWait.SpinUntil(() => pool.WasReturned(firstBacking), TimeSpan.FromSeconds(5)));
        Assert.True(SpinWait.SpinUntil(
            () => cache.GetOwnedFrameResidencySnapshot().CapacityBytes == second.Capacity,
            TimeSpan.FromSeconds(5)));
        cache.Dispose();
        cache.Dispose();

        Assert.True(SpinWait.SpinUntil(() => pool.WasReturned(secondBacking), TimeSpan.FromSeconds(5)));
        Assert.Equal(2, pool.ReturnCount);
        Assert.Equal(default, cache.GetOwnedFrameResidencySnapshot());
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Boundary)]
    public async Task CancellationAfterRedisCommit_ConsumesRootButOutstandingReaderRemainsValid()
    {
        var pool = new MultiTrackingArrayPool();
        (OwnedAedsFrame owner, byte[] backing) = BuildFrame(pool, AedsFrameType.CommentUserCursor, 2048);
        OwnedAedsFrameReadLease reader = owner.AcquireReadLease();
        var releaseWrite = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        IDatabase db = Substitute.For<IDatabase>();
        db.StringSetAsync(
                Arg.Any<RedisKey>(),
                Arg.Any<RedisValue>(),
                Arg.Any<TimeSpan?>(),
                Arg.Any<When>(),
                Arg.Any<CommandFlags>())
            .Returns(_ => releaseWrite.Task);
        using var memory = new MemoryCache(new MemoryCacheOptions());
        using UnifiedCache cache = CreateCache(memory, db);
        using var cts = new CancellationTokenSource();

        Task set = cache.SetOwnedFrameAsync(
            CachePolicyId.UserCommentCursorFrame,
            "account:42",
            owner,
            cancellationToken: cts.Token);
        await cts.CancelAsync();
        releaseWrite.TrySetResult(true);

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => set);
        Assert.Equal(owner.LogicalLength, reader.Memory.Length);
        Assert.Equal(0, pool.ReturnCount);
        reader.Dispose();
        Assert.True(SpinWait.SpinUntil(() => pool.WasReturned(backing), TimeSpan.FromSeconds(5)));
        Assert.True(pool.WasCleared(backing));
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    public async Task RedisL2Backfill_OwnsExactSensitiveArrayUntilEvictionAndReaderCompletion()
    {
        byte[] frame = new AedsEncoder().Encode(AedsFrameType.AdminStats, [1, 2, 3]);
        IDatabase db = Substitute.For<IDatabase>();
        db.StringGetAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>())
            .Returns(Task.FromResult((RedisValue)frame));
        db.KeyDeleteAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>()).Returns(Task.FromResult(true));
        using var memory = new MemoryCache(new MemoryCacheOptions());
        using UnifiedCache cache = CreateCache(memory, db);

        OwnedFrameCacheReadResult read = await cache.TryGetOwnedFrameAsync(
            CachePolicyId.AdminStatsFrame,
            "core:main",
            AedsFrameType.AdminStats);
        Assert.True(read.Hit);
        Assert.NotNull(read.Lease);

        await cache.RemoveAsync(CachePolicyId.AdminStatsFrame, "core:main");
        Assert.Contains(frame, static value => value != 0);
        read.Lease!.Dispose();

        Assert.Throws<ObjectDisposedException>(() => read.Lease!.Memory.ToArray());
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Negative, InvariantId = "aeds-owned-frame-fail-closed")]
    public async Task AlreadyDisposedCache_ConsumesTransferredSensitiveOwner()
    {
        var pool = new MultiTrackingArrayPool();
        (OwnedAedsFrame owner, byte[] backing) = BuildFrame(pool, AedsFrameType.AdminStats, 1024);
        using var memory = new MemoryCache(new MemoryCacheOptions());
        UnifiedCache cache = CreateCache(memory, SuccessfulDatabase());
        cache.Dispose();

        await Assert.ThrowsAsync<ObjectDisposedException>(() => cache.SetOwnedFrameAsync(
            CachePolicyId.AdminStatsFrame,
            "core:main",
            owner));

        Assert.True(SpinWait.SpinUntil(() => pool.WasReturned(backing), TimeSpan.FromSeconds(5)));
        Assert.True(pool.WasCleared(backing));
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Negative, InvariantId = "aeds-owned-frame-fail-closed")]
    public async Task DisposeDuringRedisWrite_PreventsPostShutdownInstallAndReleasesOwner()
    {
        var pool = new MultiTrackingArrayPool();
        (OwnedAedsFrame owner, byte[] backing) = BuildFrame(pool, AedsFrameType.AdminStats, 2048);
        var writeEntered = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseWrite = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        IDatabase db = Substitute.For<IDatabase>();
        db.StringSetAsync(
                Arg.Any<RedisKey>(),
                Arg.Any<RedisValue>(),
                Arg.Any<TimeSpan?>(),
                Arg.Any<When>(),
                Arg.Any<CommandFlags>())
            .Returns(async _ =>
            {
                writeEntered.TrySetResult(true);
                await releaseWrite.Task;
                return true;
            });
        using var memory = new MemoryCache(new MemoryCacheOptions());
        UnifiedCache cache = CreateCache(memory, db);

        Task set = cache.SetOwnedFrameAsync(CachePolicyId.AdminStatsFrame, "core:main", owner);
        await writeEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        cache.Dispose();
        releaseWrite.TrySetResult(true);
        await set;

        Assert.Equal(0, cache.GetOwnedFrameResidencySnapshot().EntryCount);
        Assert.True(SpinWait.SpinUntil(() => pool.WasReturned(backing), TimeSpan.FromSeconds(5)));
        Assert.True(pool.WasCleared(backing));
    }

    [Fact]
    public async Task L2ReadAndRemove_AreOrderedSoInvalidationCannotBeResurrected()
    {
        byte[] frame = new AedsEncoder().Encode(AedsFrameType.AdminStats, [4, 5, 6]);
        var readEntered = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseRead = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var deleteEntered = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        IDatabase db = Substitute.For<IDatabase>();
        db.StringGetAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>())
            .Returns(async _ =>
            {
                readEntered.TrySetResult(true);
                await releaseRead.Task;
                return (RedisValue)frame;
            });
        db.KeyDeleteAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>())
            .Returns(_ =>
            {
                deleteEntered.TrySetResult(true);
                return Task.FromResult(true);
            });
        using var memory = new MemoryCache(new MemoryCacheOptions());
        using UnifiedCache cache = CreateCache(memory, db);

        Task<OwnedFrameCacheReadResult> readTask = cache.TryGetOwnedFrameAsync(
            CachePolicyId.AdminStatsFrame,
            "core:main",
            AedsFrameType.AdminStats);
        await readEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Task removeTask = cache.RemoveAsync(CachePolicyId.AdminStatsFrame, "core:main");
        await Task.Yield();
        Assert.False(deleteEntered.Task.IsCompleted);

        releaseRead.TrySetResult(true);
        OwnedFrameCacheReadResult read = await readTask;
        await removeTask;
        Assert.True(deleteEntered.Task.IsCompleted);
        Assert.Equal(0, cache.GetOwnedFrameResidencySnapshot().EntryCount);
        Assert.True(cache.GetOwnedFrameResidencySnapshot().CapacityBytes > 0);

        read.Lease!.Dispose();
        Assert.True(SpinWait.SpinUntil(
            () => cache.GetOwnedFrameResidencySnapshot() == default,
            TimeSpan.FromSeconds(5)));
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Negative, InvariantId = "aeds-owned-frame-fail-closed")]
    public async Task MemoryCacheAdmissionFailure_PreservesPreviousOwnerAndCounters()
    {
        var firstPool = new MultiTrackingArrayPool();
        (OwnedAedsFrame first, byte[] firstBacking) = BuildFrame(firstPool, AedsFrameType.ArticleList, 1024);
        var secondPool = new MultiTrackingArrayPool();
        (OwnedAedsFrame second, byte[] secondBacking) = BuildFrame(secondPool, AedsFrameType.ArticleList, 2048);
        using var memory = new FaultInjectingMemoryCache();
        using UnifiedCache cache = CreateCache(memory, SuccessfulDatabase());

        await cache.SetOwnedFrameAsync(CachePolicyId.ArticleListFrame, "v:1:home", first);
        memory.ThrowOnNextCreate = true;
        await Assert.ThrowsAsync<InvalidOperationException>(() => cache.SetOwnedFrameAsync(
            CachePolicyId.ArticleListFrame,
            "v:1:home",
            second));

        Assert.True(SpinWait.SpinUntil(() => secondPool.WasReturned(secondBacking), TimeSpan.FromSeconds(5)));
        OwnedFrameCacheResidencySnapshot snapshot = cache.GetOwnedFrameResidencySnapshot();
        Assert.Equal(1, snapshot.EntryCount);
        Assert.Equal(first.LogicalLength, snapshot.LogicalBytes);
        Assert.Equal(first.Capacity, snapshot.CapacityBytes);
        OwnedFrameCacheReadResult read = await cache.TryGetOwnedFrameAsync(
            CachePolicyId.ArticleListFrame,
            "v:1:home",
            AedsFrameType.ArticleList);
        Assert.Equal(first.LogicalLength, read.Lease!.Length);
        read.Lease.Dispose();

        cache.Dispose();
        Assert.True(SpinWait.SpinUntil(() => firstPool.WasReturned(firstBacking), TimeSpan.FromSeconds(5)));
    }

    [Fact]
    public async Task InvalidSensitiveL2Frame_IsClearedAfterValidationFailure()
    {
        byte[] frame = new AedsEncoder().Encode(AedsFrameType.AdminStats, [7, 8, 9]);
        frame[^1] ^= 0xff;
        IDatabase db = Substitute.For<IDatabase>();
        db.StringGetAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>())
            .Returns(Task.FromResult((RedisValue)frame));
        db.KeyDeleteAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>()).Returns(Task.FromResult(true));
        using var memory = new MemoryCache(new MemoryCacheOptions());
        using UnifiedCache cache = CreateCache(memory, db);

        OwnedFrameCacheReadResult read = await cache.TryGetOwnedFrameAsync(
            CachePolicyId.AdminStatsFrame,
            "core:main",
            AedsFrameType.AdminStats);

        Assert.False(read.Hit);
        Assert.Null(read.Lease);
        Assert.All(frame, static value => Assert.Equal(0, value));
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    public async Task MemoryCacheCompaction_RetiresOwnerExactlyOnce()
    {
        var pool = new MultiTrackingArrayPool();
        (OwnedAedsFrame owner, byte[] backing) = BuildFrame(pool, AedsFrameType.ArticleList, 1024);
        using var memory = new MemoryCache(new MemoryCacheOptions());
        using UnifiedCache cache = CreateCache(memory, SuccessfulDatabase());
        await cache.SetOwnedFrameAsync(CachePolicyId.ArticleListFrame, "v:1:home", owner);

        memory.Compact(1.0);

        Assert.True(SpinWait.SpinUntil(() => pool.WasReturned(backing), TimeSpan.FromSeconds(5)));
        Assert.True(SpinWait.SpinUntil(
            () => cache.GetOwnedFrameResidencySnapshot() == default,
            TimeSpan.FromSeconds(5)));
        Assert.Equal(1, pool.ReturnCount);
    }

    [Fact]
    public async Task ReversedMultiKeyInvalidations_AcquireOrderedGatesWithoutDeadlock()
    {
        var firstPool = new MultiTrackingArrayPool();
        (OwnedAedsFrame first, byte[] firstBacking) = BuildFrame(firstPool, AedsFrameType.ArticleList, 1024);
        var secondPool = new MultiTrackingArrayPool();
        (OwnedAedsFrame second, byte[] secondBacking) = BuildFrame(secondPool, AedsFrameType.ArticleList, 2048);
        IDatabase db = SuccessfulDatabase();
        db.KeyDeleteAsync(Arg.Any<RedisKey[]>(), Arg.Any<CommandFlags>())
            .Returns(Task.FromResult(2L));
        using var memory = new MemoryCache(new MemoryCacheOptions());
        using UnifiedCache cache = CreateCache(memory, db);
        await cache.SetOwnedFrameAsync(CachePolicyId.ArticleListFrame, "a", first);
        await cache.SetOwnedFrameAsync(CachePolicyId.ArticleListFrame, "b", second);

        Task forward = cache.RemoveManyAsync(
            [
                new(CachePolicyId.ArticleListFrame, "a"),
                new(CachePolicyId.ArticleListFrame, "b")
            ]);
        Task reverse = cache.RemoveManyAsync(
            [
                new(CachePolicyId.ArticleListFrame, "b"),
                new(CachePolicyId.ArticleListFrame, "a")
            ]);

        await Task.WhenAll(forward, reverse).WaitAsync(TimeSpan.FromSeconds(5));
        Assert.True(SpinWait.SpinUntil(() => firstPool.WasReturned(firstBacking), TimeSpan.FromSeconds(5)));
        Assert.True(SpinWait.SpinUntil(() => secondPool.WasReturned(secondBacking), TimeSpan.FromSeconds(5)));
        Assert.Equal(default, cache.GetOwnedFrameResidencySnapshot());
    }

    private static UnifiedCache CreateCache(IMemoryCache memory, IDatabase db)
    {
        IConnectionMultiplexer redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(db);
        return new UnifiedCache(
            memory,
            redis,
            new CachePolicyRegistry(),
            new DefaultRuntimeKeyScope(),
            NullLogger<UnifiedCache>.Instance);
    }

    private static IDatabase SuccessfulDatabase()
    {
        IDatabase db = Substitute.For<IDatabase>();
        db.StringSetAsync(
                Arg.Any<RedisKey>(),
                Arg.Any<RedisValue>(),
                Arg.Any<TimeSpan?>(),
                Arg.Any<When>(),
                Arg.Any<CommandFlags>())
            .Returns(Task.FromResult(true));
        return db;
    }

    private static (OwnedAedsFrame Owner, byte[] Backing) BuildFrame(
        ArrayPool<byte> pool,
        AedsFrameType frameType,
        int payloadLength)
    {
        var writer = new AedsFrameBufferWriter(payloadLength + AedsFrameHeader.Size, pool);
        writer.Write(new byte[payloadLength]);
        writer.Seal(frameType);
        OwnedAedsFrame owner = writer.DetachOwnedFrame();
        return (owner, ((MultiTrackingArrayPool)pool).LastRentedBuffer!);
    }

    private sealed class MultiTrackingArrayPool(int extraCapacity = 0) : ArrayPool<byte>
    {
        private readonly ConcurrentDictionary<byte[], bool> _returned = new(ReferenceEqualityComparer.Instance);
        private readonly ConcurrentDictionary<byte[], bool> _cleared = new(ReferenceEqualityComparer.Instance);
        private int _returnCount;

        internal byte[]? LastRentedBuffer
        {
            get; private set;
        }
        internal int ReturnCount
        {
            get => Volatile.Read(ref _returnCount);
        }

        public override byte[] Rent(int minimumLength)
        {
            byte[] buffer = new byte[checked(Math.Max(1, minimumLength) + extraCapacity)];
            LastRentedBuffer = buffer;
            return buffer;
        }

        public override void Return(byte[] array, bool clearArray = false)
        {
            if (clearArray)
            {
                Array.Clear(array);
            }
            _cleared[array] = clearArray;
            Assert.True(_returned.TryAdd(array, true), "A pooled frame backing array was returned more than once.");
            Interlocked.Increment(ref _returnCount);
        }

        internal bool WasReturned(byte[] buffer) => _returned.ContainsKey(buffer);
        internal bool WasCleared(byte[] buffer) => _cleared.TryGetValue(buffer, out bool clear) && clear;
    }

    private sealed class FaultInjectingMemoryCache : IMemoryCache
    {
        private readonly MemoryCache _inner = new(new MemoryCacheOptions());
        private int _throwOnNextCreate;

        internal bool ThrowOnNextCreate
        {
            set => Volatile.Write(ref _throwOnNextCreate, value ? 1 : 0);
        }

        public ICacheEntry CreateEntry(object key)
        {
            if (Interlocked.Exchange(ref _throwOnNextCreate, 0) != 0)
            {
                throw new InvalidOperationException("synthetic memory-cache admission failure");
            }

            return _inner.CreateEntry(key);
        }

        public void Remove(object key) => _inner.Remove(key);

        public bool TryGetValue(object key, out object? value) => _inner.TryGetValue(key, out value);

        public void Dispose() => _inner.Dispose();
    }
}

public sealed class OwnedFrameResponseResultTests
{
    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    public async Task PreencodedResult_ReleasesLeaseOnNotModifiedAndHeadPaths()
    {
        await AssertEarlyReturnReleasesAsync("GET", ifNoneMatch: "\"v1\"");
        await AssertEarlyReturnReleasesAsync("HEAD", ifNoneMatch: null);
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Negative, InvariantId = "aeds-owned-frame-fail-closed")]
    public async Task PreencodedResult_ReleasesLeaseWhenBodyWriteThrows()
    {
        var pool = new ResponseTrackingArrayPool();
        OwnedAedsFrame owner = BuildResponseFrame(pool);
        OwnedAedsFrameReadLease lease = owner.AcquireReadLease();
        owner.Retire();
        var result = new BinaryPreencodedFrameResult(lease);
        var context = new DefaultHttpContext();
        context.Request.Method = HttpMethods.Get;
        context.Response.Body = new ThrowingWriteStream();

        await Assert.ThrowsAsync<IOException>(() => result.ExecuteAsync(context));

        Assert.Equal(1, pool.ReturnCount);
        Assert.Throws<ObjectDisposedException>(() => lease.Memory.ToArray());
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Boundary)]
    public async Task PreencodedResult_ReleasesLeaseWhenRequestIsAlreadyCancelled()
    {
        var pool = new ResponseTrackingArrayPool();
        OwnedAedsFrame owner = BuildResponseFrame(pool);
        OwnedAedsFrameReadLease lease = owner.AcquireReadLease();
        owner.Retire();
        var result = new BinaryPreencodedFrameResult(lease);
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();
        var context = new DefaultHttpContext();
        context.Request.Method = HttpMethods.Get;
        context.RequestAborted = cts.Token;
        context.Response.Body = new CancellationAwareWriteStream();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => result.ExecuteAsync(context));

        Assert.Equal(1, pool.ReturnCount);
        Assert.Throws<ObjectDisposedException>(() => lease.Memory.ToArray());
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Concurrency, ConcurrencyHarness = "fsusblog.real-concurrency.v1")]
    public async Task PreencodedResult_RejectsConcurrentSecondExecutionAndFirstStillReleasesOnce()
    {
        var pool = new ResponseTrackingArrayPool();
        OwnedAedsFrame owner = BuildResponseFrame(pool);
        OwnedAedsFrameReadLease lease = owner.AcquireReadLease();
        owner.Retire();
        var result = new BinaryPreencodedFrameResult(lease);
        var writeEntered = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseWrite = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var firstContext = new DefaultHttpContext();
        firstContext.Request.Method = HttpMethods.Get;
        firstContext.Response.Body = new CoordinatedWriteStream(writeEntered, releaseWrite);
        var secondContext = new DefaultHttpContext();
        secondContext.Request.Method = HttpMethods.Get;
        secondContext.Response.Body = new MemoryStream();

        Task first = result.ExecuteAsync(firstContext);
        await writeEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await Assert.ThrowsAsync<InvalidOperationException>(() => result.ExecuteAsync(secondContext));
        Assert.Equal(0, pool.ReturnCount);
        releaseWrite.TrySetResult(true);
        await first;

        Assert.Equal(1, pool.ReturnCount);
        Assert.Throws<ObjectDisposedException>(() => lease.Memory.ToArray());
    }

    private static async Task AssertEarlyReturnReleasesAsync(string method, string? ifNoneMatch)
    {
        var pool = new ResponseTrackingArrayPool();
        OwnedAedsFrame owner = BuildResponseFrame(pool);
        OwnedAedsFrameReadLease lease = owner.AcquireReadLease();
        owner.Retire();
        var result = new BinaryPreencodedFrameResult(
            lease,
            metadata: new BinaryFrameResponseMetadata(ETag: "\"v1\""));
        var context = new DefaultHttpContext();
        context.Request.Method = method;
        if (ifNoneMatch is not null)
        {
            context.Request.Headers.IfNoneMatch = ifNoneMatch;
        }
        context.Response.Body = new MemoryStream();

        await result.ExecuteAsync(context);

        Assert.Equal(1, pool.ReturnCount);
        Assert.Throws<ObjectDisposedException>(() => lease.Memory.ToArray());
    }

    private static OwnedAedsFrame BuildResponseFrame(ResponseTrackingArrayPool pool)
    {
        var writer = new AedsFrameBufferWriter(64, pool);
        writer.Write([1, 2, 3]);
        writer.Seal(AedsFrameType.AdminStats);
        return writer.DetachOwnedFrame();
    }

    private sealed class ResponseTrackingArrayPool : ArrayPool<byte>
    {
        private int _returnCount;
        internal int ReturnCount
        {
            get => Volatile.Read(ref _returnCount);
        }
        public override byte[] Rent(int minimumLength) => new byte[Math.Max(1, minimumLength)];
        public override void Return(byte[] array, bool clearArray = false)
        {
            if (clearArray)
                Array.Clear(array);
            Assert.Equal(1, Interlocked.Increment(ref _returnCount));
        }
    }

    private sealed class ThrowingWriteStream : MemoryStream
    {
        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
            => ValueTask.FromException(new IOException("synthetic response write failure"));
    }

    private sealed class CancellationAwareWriteStream : MemoryStream
    {
        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
            => ValueTask.FromCanceled(cancellationToken);
    }

    private sealed class CoordinatedWriteStream(
        TaskCompletionSource<bool> writeEntered,
        TaskCompletionSource<bool> releaseWrite) : MemoryStream
    {
        public override async ValueTask WriteAsync(
            ReadOnlyMemory<byte> buffer,
            CancellationToken cancellationToken = default)
        {
            writeEntered.TrySetResult(true);
            await releaseWrite.Task.WaitAsync(cancellationToken);
        }
    }
}
