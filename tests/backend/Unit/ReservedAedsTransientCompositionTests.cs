using System.Buffers;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Memory.Transient;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Tests.Helpers;

namespace FsusBlog.Server.Tests.Unit;

// Finite fixture budgets exercise the existing managed owner, not native qualification or production defaults.
public sealed class ReservedAedsTransientCompositionTests
{
    [Theory]
    [InlineData(0)]
    [InlineData(5)]
    public async Task CanonicalBytesBorrowTheOperationLeaseAndRejectAccessAfterCompletion(int payloadLength)
    {
        var (ledger, host, _) = TransientMemoryTestLedger.Create(32);
        using var pool = new TransientBufferPool(ledger, host, TransientWorkload.Encoding, new(32, 4, 0, 0));
        using IMemoryOwner<byte> destination = pool.TryRent(AedsFrameHeader.Size + payloadLength).Value!;
        var encoder = new AedsEncoder();
        byte[] payload = [1, 2, 0, 255, 128];
        byte[] reference = encoder.Encode(AedsFrameType.ArticleDetail, payload.AsSpan(0, payloadLength));
        ReadOnlyMemory<byte> captured = default;
        await PublicHotReadBinaryArtifactFactory.ConsumeReservedPayloadAsync(
            encoder, AedsFrameType.ArticleDetail, payload.AsMemory(0, payloadLength), (TransientBufferLease)destination,
            new()
            {
                MaxFrameBytes = reference.Length
            }, (frame, _) =>
            {
                Assert.True(frame.Span.SequenceEqual(reference));
                Assert.Equal(reference.Length, frame.Length);
                Assert.Equal(2, pool.Snapshot().Holds);
                Assert.Equal(((TransientBufferLease)destination).Capacity, ledger.Snapshot().Used["host"]);
                captured = frame;
                return ValueTask.CompletedTask;
            }, CancellationToken.None);

        Assert.Throws<ObjectDisposedException>(() => _ = captured.Span.Length);
        Assert.Equal(1, pool.Snapshot().Holds);
        Assert.Single(ledger.EventWindow().Events, item => item.Kind == "committed");
    }

    [Fact]
    public async Task CanceledOuterWaitKeepsTheEncodedFrameChargedUntilConsumerCompletion()
    {
        var (ledger, host, _) = TransientMemoryTestLedger.Create(32);
        using var pool = new TransientBufferPool(ledger, host, TransientWorkload.Encoding, new(32, 4, 0, 0));
        using IMemoryOwner<byte> destination = pool.TryRent(17).Value!;
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var complete = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var cancellation = new CancellationTokenSource();
        byte[] reference = new AedsEncoder().Encode(AedsFrameType.ArticleList, new byte[] { 91 });
        Task operation = PublicHotReadBinaryArtifactFactory.ConsumeReservedPayloadAsync(
            new AedsEncoder(), AedsFrameType.ArticleList, new byte[] { 91 }, (TransientBufferLease)destination,
            new(), async (frame, token) =>
            {
                Assert.Equal(cancellation.Token, token);
                entered.SetResult();
                await complete.Task;
                Assert.True(frame.Span.SequenceEqual(reference));
            }, cancellation.Token).AsTask();
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(30));
            cancellation.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => operation.WaitAsync(cancellation.Token));
            destination.Dispose();
            pool.Dispose();
            Assert.False(pool.Drained.IsCompleted);
            Assert.Equal(32, ledger.Snapshot().Used["host"]);
        }
        finally
        {
            complete.TrySetResult();
            await operation;
        }
        await pool.Drained;
        Assert.Equal(0, ledger.Snapshot().Used["host"]);
        Assert.Single(ledger.EventWindow().Events, item => item.Kind == "allocation-released");
    }

    [Fact]
    public async Task ConsumerFailureReleasesOnlyItsOperationHold()
    {
        var (ledger, host, _) = TransientMemoryTestLedger.Create(32);
        using var pool = new TransientBufferPool(ledger, host, TransientWorkload.Encoding, new(32, 4, 0, 0));
        using IMemoryOwner<byte> destination = pool.TryRent(17).Value!;
        var failure = new IOException("consumer failed");
        ReadOnlyMemory<byte> captured = default;
        IOException observed = await Assert.ThrowsAsync<IOException>(() => PublicHotReadBinaryArtifactFactory.ConsumeReservedPayloadAsync(
            new AedsEncoder(), AedsFrameType.ArticleList, new byte[] { 1 }, (TransientBufferLease)destination, new(), (frame, _) =>
            {
                captured = frame;
                throw failure;
            }, CancellationToken.None).AsTask());

        Assert.Same(failure, observed);
        Assert.Throws<ObjectDisposedException>(() => _ = captured.Span.Length);
        Assert.Equal(1, pool.Snapshot().Holds);
        Assert.Equal(32, ledger.Snapshot().Used["host"]);
        destination.Dispose();
        Assert.Equal(0, ledger.Snapshot().Used["host"]);
    }

    [Fact]
    public void UndersizedLeaseRejectsBeforeWritingOrInvokingConsumer()
    {
        var (ledger, host, _) = TransientMemoryTestLedger.Create(32);
        using var pool = new TransientBufferPool(ledger, host, TransientWorkload.Encoding, new(32, 4, 0, 0));
        using IMemoryOwner<byte> destination = pool.TryRent(16).Value!;
        destination.Memory.Span.Fill(90);
        Assert.Throws<ArgumentException>(() => PublicHotReadBinaryArtifactFactory.ConsumeReservedPayloadAsync(
            new AedsEncoder(), AedsFrameType.ArticleList, new byte[] { 1 }, (TransientBufferLease)destination, new(),
            (_, _) => throw new InvalidOperationException("consumer must not run"), CancellationToken.None));
        Assert.True(destination.Memory.Span.IndexOfAnyExcept((byte)90) < 0);
        Assert.Equal(1, pool.Snapshot().Holds);
    }

    [Fact]
    public void ArtifactCeilingRejectsBeforeWritingOrInvokingConsumer()
    {
        var (ledger, host, _) = TransientMemoryTestLedger.Create(32);
        using var pool = new TransientBufferPool(ledger, host, TransientWorkload.Encoding, new(32, 4, 0, 0));
        using IMemoryOwner<byte> destination = pool.TryRent(17).Value!;
        destination.Memory.Span.Fill(90);
        Assert.Throws<InvalidOperationException>(() => PublicHotReadBinaryArtifactFactory.ConsumeReservedPayloadAsync(
            new AedsEncoder(), AedsFrameType.ArticleList, new byte[] { 1 }, (TransientBufferLease)destination,
            new()
            {
                MaxFrameBytes = 16
            }, (_, _) => throw new InvalidOperationException("consumer must not run"), CancellationToken.None));
        Assert.True(destination.Memory.Span.IndexOfAnyExcept((byte)90) < 0);
        Assert.Equal(1, pool.Snapshot().Holds);
    }

    [Fact]
    public void PreCanceledOperationRejectsBeforeWritingOrRetaining()
    {
        var (ledger, host, _) = TransientMemoryTestLedger.Create(32);
        using var pool = new TransientBufferPool(ledger, host, TransientWorkload.Encoding, new(32, 4, 0, 0));
        using IMemoryOwner<byte> destination = pool.TryRent(17).Value!;
        destination.Memory.Span.Fill(90);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        Assert.Throws<OperationCanceledException>(() => PublicHotReadBinaryArtifactFactory.ConsumeReservedPayloadAsync(
            new AedsEncoder(), AedsFrameType.ArticleList, new byte[] { 1 }, (TransientBufferLease)destination, new(),
            (_, _) => throw new InvalidOperationException("consumer must not run"), cancellation.Token));
        Assert.True(destination.Memory.Span.IndexOfAnyExcept((byte)90) < 0);
        Assert.Equal(1, pool.Snapshot().Holds);
    }

    [Fact]
    public async Task AliasedPayloadRejectsBeforeMutatingTheSource()
    {
        var (ledger, host, _) = TransientMemoryTestLedger.Create(32);
        using var pool = new TransientBufferPool(ledger, host, TransientWorkload.Encoding, new(32, 4, 0, 0));
        using IMemoryOwner<byte> destination = pool.TryRent(17).Value!;
        destination.Memory.Span.Fill(90);
        await Assert.ThrowsAsync<ArgumentException>(() => PublicHotReadBinaryArtifactFactory.ConsumeReservedPayloadAsync(
            new AedsEncoder(), AedsFrameType.ArticleList, destination.Memory[..1], (TransientBufferLease)destination, new(),
            (_, _) => throw new InvalidOperationException("consumer must not run"), CancellationToken.None).AsTask());
        Assert.True(destination.Memory.Span.IndexOfAnyExcept((byte)90) < 0);
        Assert.Equal(1, pool.Snapshot().Holds);
    }

    [Fact]
    public async Task RepeatedFailureAndSuccessReuseOnlyClearedChargedBacking()
    {
        var (ledger, host, _) = TransientMemoryTestLedger.Create(32);
        using var pool = new TransientBufferPool(ledger, host, TransientWorkload.Encoding, new(32, 4, 1, 32));
        for (int iteration = 0; iteration < 4; iteration++)
        {
            using IMemoryOwner<byte> destination = pool.TryRent(17).Value!;
            Assert.True(destination.Memory.Span.IndexOfAnyExcept((byte)0) < 0);
            Task operation = PublicHotReadBinaryArtifactFactory.ConsumeReservedPayloadAsync(
                new AedsEncoder(), AedsFrameType.ArticleList, new byte[] { 1 }, (TransientBufferLease)destination, new(),
                (_, _) => iteration % 2 == 0 ? ValueTask.FromException(new IOException("consumer failed")) : ValueTask.CompletedTask,
                CancellationToken.None).AsTask();
            if (iteration % 2 == 0)
            {
                await Assert.ThrowsAsync<IOException>(() => operation);
            }
            else
            {
                await operation;
            }
            Assert.Equal(1, pool.Snapshot().Holds);
        }
        Assert.Single(ledger.EventWindow().Events, item => item.Kind == "committed");
        Assert.Equal(32, ledger.Snapshot().Used["host"]);
        pool.Dispose();
        Assert.True(pool.Drained.IsCompletedSuccessfully);
        Assert.Equal(0, ledger.Snapshot().Used["host"]);
        Assert.Single(ledger.EventWindow().Events, item => item.Kind == "allocation-released");
    }

    [Fact]
    public async Task ExhaustedHoldBudgetRejectsBeforeEncoding()
    {
        var (ledger, host, _) = TransientMemoryTestLedger.Create(32);
        using var pool = new TransientBufferPool(ledger, host, TransientWorkload.Encoding, new(32, 1, 0, 0));
        using IMemoryOwner<byte> destination = pool.TryRent(17).Value!;
        destination.Memory.Span.Fill(90);
        await Assert.ThrowsAsync<InsufficientMemoryException>(() => PublicHotReadBinaryArtifactFactory.ConsumeReservedPayloadAsync(
            new AedsEncoder(), AedsFrameType.ArticleList, new byte[] { 1 }, (TransientBufferLease)destination, new(),
            (_, _) => throw new InvalidOperationException("consumer must not run"), CancellationToken.None).AsTask());
        Assert.True(destination.Memory.Span.IndexOfAnyExcept((byte)90) < 0);
        Assert.Equal(1, pool.Snapshot().Holds);
        Assert.Equal(32, ledger.Snapshot().Used["host"]);
    }

    [Fact]
    public async Task CancellationDuringCanonicalEncodingPreventsConsumerDeliveryAndReleasesTheOperationHold()
    {
        var (ledger, host, _) = TransientMemoryTestLedger.Create(32);
        using var pool = new TransientBufferPool(ledger, host, TransientWorkload.Encoding, new(32, 4, 0, 0));
        using IMemoryOwner<byte> destination = pool.TryRent(17).Value!;
        using var cancellation = new CancellationTokenSource();
        var encoder = new CancelAfterEncoding(cancellation);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => PublicHotReadBinaryArtifactFactory.ConsumeReservedPayloadAsync(
            encoder, AedsFrameType.ArticleList, new byte[] { 1 }, (TransientBufferLease)destination, new(),
            (_, _) => throw new InvalidOperationException("Canceled encoded frame must not reach the consumer."), cancellation.Token).AsTask());
        Assert.True(encoder.WroteCanonicalFrame);
        Assert.Equal(1, pool.Snapshot().Holds);
        Assert.Equal(32, ledger.Snapshot().Used["host"]);
        destination.Dispose();
        Assert.Equal(0, ledger.Snapshot().Used["host"]);
        Assert.Single(ledger.EventWindow().Events, item => item.Kind == "allocation-released");
    }

    private sealed class CancelAfterEncoding(CancellationTokenSource cancellation) : IAedsEncoder
    {
        private readonly AedsEncoder _encoder = new();
        public bool WroteCanonicalFrame
        {
            get; private set;
        }
        public byte[] Encode(AedsFrameType frameType, ReadOnlySpan<byte> payload, ushort version = AedsFrameHeader.CurrentVersion, uint flags = 0)
            => _encoder.Encode(frameType, payload, version, flags);
        public void WriteFrame(AedsFrameType frameType, ReadOnlySpan<byte> payload, IBufferWriter<byte> destination, ushort version = AedsFrameHeader.CurrentVersion, uint flags = 0)
        {
            _encoder.WriteFrame(frameType, payload, destination, version, flags);
            WroteCanonicalFrame = true;
            cancellation.Cancel();
        }
        public void WriteHeader(AedsFrameType frameType, ReadOnlySpan<byte> payload, IBufferWriter<byte> destination, ushort version = AedsFrameHeader.CurrentVersion, uint flags = 0)
            => _encoder.WriteHeader(frameType, payload, destination, version, flags);
        public Result<AedsDecodeResult> TryDecode(ReadOnlyMemory<byte> frame) => _encoder.TryDecode(frame);
    }
}
