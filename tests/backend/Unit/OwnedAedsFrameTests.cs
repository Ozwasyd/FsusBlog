using System.Buffers;

using FsusBlog.Core.Algorithms;

namespace FsusBlog.Server.Tests.Unit;

public sealed class OwnedAedsFrameTests
{
    private static readonly AedsEncoder s_encoder = new();

    [Fact]
    public void DetachOwnedFrame_PreservesWireBytesAndReportsLogicalAndBackingSizes()
    {
        byte[] payload = Enumerable.Range(0, 37).Select(static value => (byte)value).ToArray();
        byte[] expected = s_encoder.Encode(AedsFrameType.ArticleList, payload);
        var pool = new TrackingArrayPool(extraCapacity: 29);
        var writer = new AedsFrameBufferWriter(initialCapacity: 32, pool);
        writer.Write(payload);
        writer.Seal(AedsFrameType.ArticleList);

        using OwnedAedsFrame owned = writer.DetachOwnedFrame();
        writer.Dispose();
        using OwnedAedsFrameReadLease lease = owned.AcquireReadLease();

        Assert.Equal(AedsFrameType.ArticleList, owned.FrameType);
        Assert.Equal(expected.Length, owned.LogicalLength);
        Assert.Equal(pool.LastRentedBuffer!.Length, owned.Capacity);
        Assert.True(owned.Capacity > owned.LogicalLength);
        Assert.True(owned.IsPooled);
        Assert.False(owned.RequiresClear);
        Assert.Equal(expected, lease.Memory.ToArray());
        Assert.Equal(0, pool.ReturnCount);
    }

    [Fact]
    public void Retire_DefersExactlyOnePoolReturnUntilEveryReadLeaseEnds()
    {
        var pool = new TrackingArrayPool();
        var writer = new AedsFrameBufferWriter(64, pool);
        writer.Write([1, 2, 3, 4]);
        writer.Seal(AedsFrameType.AdminStats);
        OwnedAedsFrame owned = writer.DetachOwnedFrame();
        OwnedAedsFrameReadLease first = owned.AcquireReadLease();
        OwnedAedsFrameReadLease second = owned.AcquireReadLease();

        Assert.True(owned.Retire());
        Assert.False(owned.Retire());
        Assert.Equal(0, pool.ReturnCount);
        Assert.False(owned.TryAcquireReadLease(out OwnedAedsFrameReadLease? rejected));
        Assert.Null(rejected);
        Assert.Throws<ObjectDisposedException>(() => owned.AcquireReadLease());

        first.Dispose();
        first.Dispose();
        Assert.Equal(0, pool.ReturnCount);

        second.Dispose();
        second.Dispose();
        owned.Dispose();
        writer.Dispose();

        Assert.Equal(1, pool.ReturnCount);
        Assert.True(pool.LastClearArray);
        Assert.All(pool.LastRentedBuffer!, static value => Assert.Equal((byte)0, value));
    }

    [Fact]
    public void ReleasedLease_InvalidatesPreviouslyCapturedReadOnlyMemory()
    {
        var pool = new TrackingArrayPool();
        using var writer = new AedsFrameBufferWriter(64, pool);
        writer.Write([7, 8, 9]);
        writer.Seal(AedsFrameType.ArticleDetail);
        using OwnedAedsFrame owned = writer.DetachOwnedFrame();
        OwnedAedsFrameReadLease lease = owned.AcquireReadLease();
        ReadOnlyMemory<byte> captured = lease.Memory;

        owned.Retire();
        lease.Dispose();

        Assert.Throws<ObjectDisposedException>(() => lease.Memory.ToArray());
        Assert.Throws<ObjectDisposedException>(() => captured.ToArray());
        Assert.Equal(1, pool.ReturnCount);
    }

    [Fact]
    public void PinnedLease_DefersOwnerReleaseUntilMemoryHandleIsUnpinned()
    {
        var pool = new TrackingArrayPool();
        using var writer = new AedsFrameBufferWriter(64, pool);
        writer.Write([1, 2, 3]);
        writer.Seal(AedsFrameType.CommentArticleCursor);
        OwnedAedsFrame owned = writer.DetachOwnedFrame();
        OwnedAedsFrameReadLease lease = owned.AcquireReadLease();
        MemoryHandle handle = lease.Memory.Pin();

        owned.Retire();
        lease.Dispose();
        Assert.Equal(0, pool.ReturnCount);

        handle.Dispose();
        Assert.Equal(1, pool.ReturnCount);

        owned.Dispose();
    }

    [Fact]
    public void ConcurrentRetireAndLeaseDisposal_ReturnPooledBufferOnce()
    {
        var pool = new TrackingArrayPool();
        using var writer = new AedsFrameBufferWriter(128, pool);
        writer.Write(new byte[64]);
        writer.Seal(AedsFrameType.AdminStats);
        OwnedAedsFrame owned = writer.DetachOwnedFrame();
        OwnedAedsFrameReadLease[] leases = Enumerable.Range(0, 64)
            .Select(_ => owned.AcquireReadLease())
            .ToArray();

        Parallel.Invoke(
            () => owned.Retire(),
            () => owned.Dispose(),
            () => Parallel.ForEach(leases, static lease => lease.Dispose()),
            () => Parallel.ForEach(leases, static lease => lease.Dispose()));

        Assert.True(owned.IsRetired);
        Assert.Equal(0, owned.ActiveReadLeaseCount);
        Assert.Equal(1, pool.ReturnCount);
        Assert.True(pool.LastClearArray);
    }

    [Theory]
    [InlineData(AedsFrameType.Unknown, true)]
    [InlineData(AedsFrameType.AdminStats, true)]
    [InlineData(AedsFrameType.CurrentUserSnapshot, true)]
    [InlineData(AedsFrameType.ArticleList, false)]
    [InlineData(AedsFrameType.PublicAotBootstrap, false)]
    public void DetachedOwner_UsesSensitivityAllowlistWhenReturningPoolBuffer(
        AedsFrameType frameType,
        bool expectedClear)
    {
        var pool = new TrackingArrayPool();
        using var writer = new AedsFrameBufferWriter(64, pool);
        writer.Write([0xDE, 0xAD, 0xBE, 0xEF]);
        writer.Seal(frameType);
        OwnedAedsFrame owned = writer.DetachOwnedFrame();

        owned.Retire();

        Assert.Equal(1, pool.ReturnCount);
        Assert.Equal(expectedClear, pool.LastClearArray);
        Assert.Equal(expectedClear, owned.RequiresClear);
        Assert.Equal(
            expectedClear,
            pool.LastRentedBuffer!.All(static value => value == 0));
    }

    [Theory]
    [InlineData(AedsFrameType.AdminStats, true)]
    [InlineData(AedsFrameType.ArticleDetail, false)]
    public void ExactOwner_ClearsSensitiveFramesButKeepsPublicImmutableFrames(
        AedsFrameType frameType,
        bool expectedClear)
    {
        byte[] frame = s_encoder.Encode(frameType, [1, 2, 3]);
        using OwnedAedsFrame owned = OwnedAedsFrame.TakeOwnership(frame, frameType);

        owned.Retire();

        Assert.False(owned.IsPooled);
        Assert.Equal(frame.Length, owned.LogicalLength);
        Assert.Equal(frame.Length, owned.Capacity);
        Assert.Equal(expectedClear, frame.All(static value => value == 0));
    }

    [Fact]
    public void DetachOwnedFrame_RequiresSealAndInvalidatesWriterAfterTransfer()
    {
        var pool = new TrackingArrayPool();
        var writer = new AedsFrameBufferWriter(64, pool);
        writer.Write([1, 2, 3]);
        Assert.Throws<InvalidOperationException>(() => writer.DetachOwnedFrame());

        writer.Seal(AedsFrameType.ArticleList);
        using OwnedAedsFrame owned = writer.DetachOwnedFrame();

        Assert.Throws<ObjectDisposedException>(() => writer.Write([4]));
        Assert.Throws<ObjectDisposedException>(() => writer.WrittenFrame.ToArray());
        writer.Dispose();
        Assert.Equal(0, pool.ReturnCount);
    }

    [Fact]
    public void Builders_ProduceWireEquivalentPooledAndExactOwners()
    {
        byte[] payload = Enumerable.Range(0, 257).Select(static value => unchecked((byte)value)).ToArray();
        byte[] expected = s_encoder.Encode(AedsFrameType.ArticleDetail, payload);

        using OwnedAedsFrame pooled = AedsOwnedFrameBuilder.BuildOwned(
            AedsFrameType.ArticleDetail,
            destination => destination.Write(payload),
            initialCapacity: 32);
        using OwnedAedsFrame exact = AedsOwnedFrameBuilder.BuildExact(
            AedsFrameType.ArticleDetail,
            destination => destination.Write(payload),
            initialCapacity: 32);
        using OwnedAedsFrameReadLease pooledLease = pooled.AcquireReadLease();
        using OwnedAedsFrameReadLease exactLease = exact.AcquireReadLease();

        Assert.Equal(expected, pooledLease.Memory.ToArray());
        Assert.Equal(expected, exactLease.Memory.ToArray());
        Assert.True(pooled.IsPooled);
        Assert.False(exact.IsPooled);
        Assert.Equal(exact.LogicalLength, exact.Capacity);
    }

    [Fact]
    public void BuildExact_RejectsPayloadLengthChangesBetweenPasses()
    {
        int pass = 0;

        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() =>
            AedsOwnedFrameBuilder.BuildExact(
                AedsFrameType.AdminStats,
                destination =>
                {
                    pass++;
                    destination.Write(pass == 1 ? [1, 2] : [1]);
                },
                initialCapacity: 32));

        Assert.Contains("length changed", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void PoolReturnFailure_StillCompletesBackingReleaseAccountingCallback()
    {
        var pool = new ThrowingReturnArrayPool();
        using var writer = new AedsFrameBufferWriter(64, pool);
        writer.Write([1, 2, 3]);
        writer.Seal(AedsFrameType.AdminStats);
        OwnedAedsFrame owned = writer.DetachOwnedFrame();
        int releasedCapacity = 0;

        Assert.Throws<InvalidOperationException>(() => owned.Retire(
            capacity => releasedCapacity = capacity));

        Assert.Equal(owned.Capacity, releasedCapacity);
        Assert.True(owned.IsRetired);
        Assert.Equal(0, owned.ActiveReadLeaseCount);
    }

    private sealed class TrackingArrayPool(int extraCapacity = 0) : ArrayPool<byte>
    {
        private readonly object _gate = new();
        private byte[]? _outstanding;

        public byte[]? LastRentedBuffer
        {
            get; private set;
        }
        public int ReturnCount
        {
            get; private set;
        }
        public bool LastClearArray
        {
            get; private set;
        }

        public override byte[] Rent(int minimumLength)
        {
            lock (_gate)
            {
                Assert.Null(_outstanding);
                _outstanding = new byte[checked(Math.Max(1, minimumLength) + extraCapacity)];
                LastRentedBuffer = _outstanding;
                return _outstanding;
            }
        }

        public override void Return(byte[] array, bool clearArray = false)
        {
            lock (_gate)
            {
                Assert.Same(_outstanding, array);
                _outstanding = null;
                ReturnCount++;
                LastClearArray = clearArray;
                if (clearArray)
                {
                    Array.Clear(array);
                }
            }
        }
    }

    private sealed class ThrowingReturnArrayPool : ArrayPool<byte>
    {
        public override byte[] Rent(int minimumLength) => new byte[Math.Max(1, minimumLength)];

        public override void Return(byte[] array, bool clearArray = false)
            => throw new InvalidOperationException("synthetic pool return failure");
    }
}
