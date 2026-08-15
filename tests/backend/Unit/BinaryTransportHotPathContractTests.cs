using System.Buffers;
using System.Diagnostics.Metrics;
using System.IO.Pipelines;

using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Middlewares;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Shared.Contracts.Governance;

using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.DependencyInjection;
namespace FsusBlog.Server.Tests.Unit;

public sealed class BinaryTransportHotPathContractTests
{
    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    public async Task BinaryRequestBinder_SegmentedFrameRoundTripsPayloadAndFrameType()
    {
        var aeds = new AedsEncoder();
        byte[] expectedPayload = Enumerable.Range(0, 257)
            .Select(static value => unchecked((byte)value))
            .ToArray();
        byte[] frame = aeds.Encode(AedsFrameType.SiteSubscriptionRequest, expectedPayload);
        await using var stream = new SegmentedReadStream(frame, [1, 2, 3, 5, 8, 13]);
        PipeReader reader = PipeReader.Create(
            stream,
            new StreamPipeReaderOptions(bufferSize: 32, minimumReadSize: 1, leaveOpen: true));
        var context = CreateContext(reader, frame.Length);

        using BinaryRequestPayload result = await new BinaryRequestBinder().ReadFrameAsync(
            context,
            aeds,
            AedsFrameType.SiteSubscriptionRequest,
            CancellationToken.None);

        Assert.True(result.IsSuccess, result.Error.Message);
        Assert.Equal(AedsFrameType.SiteSubscriptionRequest, result.FrameType);
        Assert.Equal(expectedPayload, result.Payload.ToArray());
        Assert.True(stream.ReadCount > 6, $"Expected segmented I/O but observed {stream.ReadCount} reads.");

        await context.Response.CompleteAsync();
        await reader.CompleteAsync();
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Negative, InvariantId = "aeds-crc-invariant")]
    public async Task BinaryRequestBinder_CorruptedSegmentedFrameReturnsStableCrcFailure()
    {
        var aeds = new AedsEncoder();
        byte[] frame = aeds.Encode(
            AedsFrameType.SiteSubscriptionRequest,
            "segmented-crc"u8.ToArray());
        frame[^1] ^= 0x40;
        await using var stream = new SegmentedReadStream(frame, [2, 1, 4, 3]);
        PipeReader reader = PipeReader.Create(
            stream,
            new StreamPipeReaderOptions(bufferSize: 16, minimumReadSize: 1, leaveOpen: true));
        var context = CreateContext(reader, frame.Length);

        var pool = new TrackingArrayPool();
        BinaryRequestPayload result = await new BinaryRequestBinder(pool).ReadFrameAsync(
            context,
            aeds,
            AedsFrameType.SiteSubscriptionRequest,
            CancellationToken.None);

        Assert.False(result.IsSuccess);
        Assert.Equal("AEDS payload crc mismatch", result.Error.Message);
        Assert.Equal(1, pool.RentCount);
        Assert.Equal(1, pool.ReturnCount);
        Assert.Equal(0, pool.OutstandingCount);
        Assert.True(stream.ReadCount > 3, $"Expected segmented I/O but observed {stream.ReadCount} reads.");
        await reader.CompleteAsync();
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Mutation)]
    public async Task BinaryRequestBinder_TruncatedPayloadReturnsRentedLeaseImmediately()
    {
        var aeds = new AedsEncoder();
        byte[] frame = aeds.Encode(AedsFrameType.SiteSubscriptionRequest, "truncated"u8.ToArray());
        byte[] truncated = frame[..(AedsFrameHeader.Size + 2)];
        PipeReader reader = PipeReader.Create(new MemoryStream(truncated));
        var context = CreateContext(reader, contentLength: null);
        var pool = new TrackingArrayPool();

        BinaryRequestPayload result = await new BinaryRequestBinder(pool).ReadFrameAsync(
            context,
            aeds,
            AedsFrameType.SiteSubscriptionRequest,
            CancellationToken.None);

        Assert.False(result.IsSuccess);
        Assert.Equal("AEDS payload length mismatch", result.Error.Message);
        Assert.Equal(1, pool.RentCount);
        Assert.Equal(1, pool.ReturnCount);
        Assert.Equal(0, pool.OutstandingCount);
        await reader.CompleteAsync();
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Mutation)]
    public async Task ApiBinaryResponseMiddleware_ReturnsSuccessfulLeaseWithoutResponseCompletion()
    {
        var aeds = new AedsEncoder();
        byte[] expectedPayload = "middleware-success"u8.ToArray();
        byte[] frame = aeds.Encode(AedsFrameType.SiteSubscriptionRequest, expectedPayload);
        PipeReader reader = PipeReader.Create(new MemoryStream(frame));
        var context = CreateContext(reader, frame.Length);
        var pool = new TrackingArrayPool();
        var binder = new BinaryRequestBinder(pool);
        BinaryRequestPayload captured = default;
        var middleware = new ApiBinaryResponseMiddleware(async httpContext =>
        {
            captured = await binder.ReadFrameAsync(
                httpContext,
                aeds,
                AedsFrameType.SiteSubscriptionRequest,
                CancellationToken.None);
            Assert.True(captured.IsSuccess, captured.Error.Message);
            Assert.Equal(expectedPayload, captured.Payload.ToArray());
        });

        await middleware.InvokeAsync(context, aeds);

        Assert.Equal(1, pool.RentCount);
        Assert.Equal(1, pool.ReturnCount);
        Assert.Equal(0, pool.OutstandingCount);
        Assert.Throws<ObjectDisposedException>(() => captured.Payload.ToArray());

        await context.Response.CompleteAsync();
        Assert.Equal(1, pool.ReturnCount);
        await reader.CompleteAsync();
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Mutation)]
    public async Task ApiBinaryResponseMiddleware_ReturnsLeaseWhenHandlerThrows()
    {
        var aeds = new AedsEncoder();
        byte[] frame = aeds.Encode(AedsFrameType.SiteSubscriptionRequest, "handler-throws"u8.ToArray());
        PipeReader reader = PipeReader.Create(new MemoryStream(frame));
        var context = CreateContext(reader, frame.Length);
        var pool = new TrackingArrayPool();
        var binder = new BinaryRequestBinder(pool);
        var middleware = new ApiBinaryResponseMiddleware(async httpContext =>
        {
            BinaryRequestPayload payload = await binder.ReadFrameAsync(
                httpContext,
                aeds,
                AedsFrameType.SiteSubscriptionRequest,
                CancellationToken.None);
            Assert.True(payload.IsSuccess, payload.Error.Message);
            throw new InvalidOperationException("handler failure");
        });

        await Assert.ThrowsAsync<InvalidOperationException>(() => middleware.InvokeAsync(context, aeds));

        Assert.Equal(1, pool.RentCount);
        Assert.Equal(1, pool.ReturnCount);
        Assert.Equal(0, pool.OutstandingCount);
        await reader.CompleteAsync();
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Mutation)]
    public async Task ApiBinaryResponseMiddleware_ReturnsLeaseWhenClientDisconnectsAfterBinding()
    {
        var aeds = new AedsEncoder();
        byte[] frame = aeds.Encode(AedsFrameType.SiteSubscriptionRequest, "disconnect"u8.ToArray());
        PipeReader reader = PipeReader.Create(new MemoryStream(frame));
        var context = CreateContext(reader, frame.Length);
        var pool = new TrackingArrayPool();
        var binder = new BinaryRequestBinder(pool);
        using var disconnected = new CancellationTokenSource();
        context.RequestAborted = disconnected.Token;
        var middleware = new ApiBinaryResponseMiddleware(async httpContext =>
        {
            BinaryRequestPayload payload = await binder.ReadFrameAsync(
                httpContext,
                aeds,
                AedsFrameType.SiteSubscriptionRequest,
                httpContext.RequestAborted);
            Assert.True(payload.IsSuccess, payload.Error.Message);
            disconnected.Cancel();
            throw new OperationCanceledException(httpContext.RequestAborted);
        });

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => middleware.InvokeAsync(context, aeds));

        Assert.Equal(1, pool.RentCount);
        Assert.Equal(1, pool.ReturnCount);
        Assert.Equal(0, pool.OutstandingCount);
        await reader.CompleteAsync();
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Mutation)]
    public async Task BinaryRequestPayload_EarlyDisposeAndPipelineCleanupReturnLeaseOnce()
    {
        var aeds = new AedsEncoder();
        byte[] frame = aeds.Encode(AedsFrameType.SiteSubscriptionRequest, "early-dispose"u8.ToArray());
        PipeReader reader = PipeReader.Create(new MemoryStream(frame));
        var context = CreateContext(reader, frame.Length);
        var pool = new TrackingArrayPool();
        var binder = new BinaryRequestBinder(pool);
        var middleware = new ApiBinaryResponseMiddleware(async httpContext =>
        {
            BinaryRequestPayload payload = await binder.ReadFrameAsync(
                httpContext,
                aeds,
                AedsFrameType.SiteSubscriptionRequest,
                CancellationToken.None);
            payload.Dispose();
            payload.Dispose();
        });

        await middleware.InvokeAsync(context, aeds);
        await context.Response.CompleteAsync();

        Assert.Equal(1, pool.RentCount);
        Assert.Equal(1, pool.ReturnCount);
        Assert.Equal(0, pool.OutstandingCount);
        await reader.CompleteAsync();
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Mutation)]
    public void BinaryRequestPoolMetrics_ArePublishedOnServerMeter()
    {
        var instruments = new HashSet<string>(StringComparer.Ordinal);
        using var listener = new MeterListener
        {
            InstrumentPublished = (instrument, meterListener) =>
            {
                if (instrument.Meter.Name == FsusObservability.MeterName
                    && instrument.Name.StartsWith("fsus.binary_request.pool.", StringComparison.Ordinal))
                {
                    instruments.Add(instrument.Name);
                    meterListener.EnableMeasurementEvents(instrument);
                }
            }
        };
        listener.Start();

        using var lease = new TestLeaseScope(new BinaryRequestBufferLease(new TrackingArrayPool(), 16));
        listener.RecordObservableInstruments();

        Assert.Contains("fsus.binary_request.pool.rent_count", instruments);
        Assert.Contains("fsus.binary_request.pool.return_count", instruments);
        Assert.Contains("fsus.binary_request.pool.rented_bytes", instruments);
        Assert.Contains("fsus.binary_request.pool.returned_bytes", instruments);
        Assert.Contains("fsus.binary_request.pool.outstanding", instruments);
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Mutation)]
    public async Task BinaryRequestBinder_CancellationInterruptsBlockedPipeRead()
    {
        await using var stream = new CancelableBlockingReadStream();
        PipeReader reader = PipeReader.Create(
            stream,
            new StreamPipeReaderOptions(bufferSize: 16, minimumReadSize: 1, leaveOpen: true));
        var context = CreateContext(reader, contentLength: null);
        using var cancellation = new CancellationTokenSource();

        Task<BinaryRequestPayload> pending = new BinaryRequestBinder().ReadFrameAsync(
            context,
            new AedsEncoder(),
            AedsFrameType.SiteSubscriptionRequest,
            cancellation.Token);
        await stream.ReadStarted.Task.WaitAsync(TimeSpan.FromSeconds(1));
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending);
        Assert.True(stream.CancellationObserved);
        await reader.CompleteAsync();
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Mutation)]
    public async Task BinaryRequestBinder_CancellationAfterHeaderReturnsRentedLease()
    {
        var aeds = new AedsEncoder();
        byte[] frame = aeds.Encode(AedsFrameType.SiteSubscriptionRequest, "blocked-payload"u8.ToArray());
        await using var stream = new PrefixThenBlockingReadStream(frame[..AedsFrameHeader.Size]);
        PipeReader reader = PipeReader.Create(
            stream,
            new StreamPipeReaderOptions(bufferSize: 16, minimumReadSize: 1, leaveOpen: true));
        var context = CreateContext(reader, contentLength: null);
        var pool = new TrackingArrayPool();
        using var cancellation = new CancellationTokenSource();

        Task<BinaryRequestPayload> pending = new BinaryRequestBinder(pool).ReadFrameAsync(
            context,
            aeds,
            AedsFrameType.SiteSubscriptionRequest,
            cancellation.Token);
        await stream.BlockedReadStarted.Task.WaitAsync(TimeSpan.FromSeconds(1));
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending);
        Assert.Equal(1, pool.RentCount);
        Assert.Equal(1, pool.ReturnCount);
        Assert.Equal(0, pool.OutstandingCount);
        await reader.CompleteAsync();
    }

    private static DefaultHttpContext CreateContext(PipeReader reader, long? contentLength)
    {
        var context = new DefaultHttpContext();
        context.Features.Set<IRequestBodyPipeFeature>(new RequestBodyPipeFeature(reader));
        context.Request.ContentType = "application/octet-stream";
        context.Request.ContentLength = contentLength;
        context.Request.Method = HttpMethods.Post;
        context.Request.Path = "/api/binary/test";
        context.Response.Body = new MemoryStream();
        context.RequestServices = new ServiceCollection()
            .AddSingleton<IBinaryEnvelopePolicy, BinaryEnvelopePolicy>()
            .BuildServiceProvider();
        return context;
    }

    private sealed class TrackingArrayPool : ArrayPool<byte>
    {
        private readonly object _sync = new();
        private readonly HashSet<byte[]> _outstanding = new(ReferenceEqualityComparer.Instance);

        public int RentCount
        {
            get; private set;
        }
        public int ReturnCount
        {
            get; private set;
        }
        public int OutstandingCount
        {
            get
            {
                lock (_sync)
                {
                    return _outstanding.Count;
                }
            }
        }

        public override byte[] Rent(int minimumLength)
        {
            byte[] buffer = new byte[Math.Max(1, minimumLength)];
            lock (_sync)
            {
                RentCount++;
                Assert.True(_outstanding.Add(buffer));
            }

            return buffer;
        }

        public override void Return(byte[] array, bool clearArray = false)
        {
            lock (_sync)
            {
                Assert.True(_outstanding.Remove(array), "A buffer was returned more than once.");
                ReturnCount++;
            }

            if (clearArray)
            {
                Array.Clear(array);
            }
        }
    }

    private sealed class TestLeaseScope(BinaryRequestBufferLease lease) : IDisposable
    {
        public void Dispose() => lease.Dispose("test");
    }

    private sealed class RequestBodyPipeFeature(PipeReader reader) : IRequestBodyPipeFeature
    {
        public PipeReader Reader { get; } = reader;
    }

    private sealed class SegmentedReadStream(byte[] bytes, int[] segmentSizes) : Stream
    {
        private int _offset;
        private int _segment;

        public int ReadCount
        {
            get; private set;
        }
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => bytes.Length;
        public override long Position
        {
            get => _offset;
            set => throw new NotSupportedException();
        }

        public override int Read(byte[] buffer, int offset, int count)
            => Read(buffer.AsSpan(offset, count));

        public override int Read(Span<byte> buffer)
        {
            if (_offset >= bytes.Length)
            {
                return 0;
            }

            ReadCount++;
            int segmentSize = segmentSizes[_segment++ % segmentSizes.Length];
            int count = Math.Min(Math.Min(segmentSize, buffer.Length), bytes.Length - _offset);
            bytes.AsSpan(_offset, count).CopyTo(buffer);
            _offset += count;
            return count;
        }

        public override ValueTask<int> ReadAsync(
            Memory<byte> buffer,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return ValueTask.FromResult(Read(buffer.Span));
        }

        public override Task<int> ReadAsync(
            byte[] buffer,
            int offset,
            int count,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult(Read(buffer.AsSpan(offset, count)));
        }

        public override void Flush()
        {
        }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    private sealed class CancelableBlockingReadStream : Stream
    {
        public TaskCompletionSource ReadStarted
        {
            get;
        } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public bool CancellationObserved
        {
            get; private set;
        }
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        public override async ValueTask<int> ReadAsync(
            Memory<byte> buffer,
            CancellationToken cancellationToken = default)
        {
            ReadStarted.TrySetResult();
            try
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
                return 0;
            }
            catch (OperationCanceledException)
            {
                CancellationObserved = true;
                throw;
            }
        }

        public override async Task<int> ReadAsync(
            byte[] buffer,
            int offset,
            int count,
            CancellationToken cancellationToken)
            => await ReadAsync(buffer.AsMemory(offset, count), cancellationToken);

        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override void Flush()
        {
        }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    private sealed class PrefixThenBlockingReadStream(byte[] prefix) : Stream
    {
        private int _offset;

        public TaskCompletionSource BlockedReadStarted
        {
            get;
        } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        public override async ValueTask<int> ReadAsync(
            Memory<byte> buffer,
            CancellationToken cancellationToken = default)
        {
            if (_offset < prefix.Length)
            {
                int count = Math.Min(buffer.Length, prefix.Length - _offset);
                prefix.AsSpan(_offset, count).CopyTo(buffer.Span);
                _offset += count;
                return count;
            }

            BlockedReadStarted.TrySetResult();
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            return 0;
        }

        public override Task<int> ReadAsync(
            byte[] buffer,
            int offset,
            int count,
            CancellationToken cancellationToken)
            => ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();

        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override void Flush()
        {
        }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
