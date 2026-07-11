using System.IO.Pipelines;
using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Infrastructure.Binary;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;

namespace FsusBlog.Server.Tests.Unit;

public sealed class BinaryTransportHotPathContractTests
{
    [Fact]
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

        BinaryRequestPayload result = await new BinaryRequestBinder().ReadFrameAsync(
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

        BinaryRequestPayload result = await new BinaryRequestBinder().ReadFrameAsync(
            context,
            aeds,
            AedsFrameType.SiteSubscriptionRequest,
            CancellationToken.None);

        Assert.False(result.IsSuccess);
        Assert.Equal("AEDS payload crc mismatch", result.Error.Message);
        Assert.True(stream.ReadCount > 3, $"Expected segmented I/O but observed {stream.ReadCount} reads.");
        await reader.CompleteAsync();
    }

    [Fact]
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

    private static DefaultHttpContext CreateContext(PipeReader reader, long? contentLength)
    {
        var context = new DefaultHttpContext();
        context.Features.Set<IRequestBodyPipeFeature>(new RequestBodyPipeFeature(reader));
        context.Request.ContentType = "application/octet-stream";
        context.Request.ContentLength = contentLength;
        return context;
    }

    private sealed class RequestBodyPipeFeature(PipeReader reader) : IRequestBodyPipeFeature
    {
        public PipeReader Reader { get; } = reader;
    }

    private sealed class SegmentedReadStream(byte[] bytes, int[] segmentSizes) : Stream
    {
        private int _offset;
        private int _segment;

        public int ReadCount { get; private set; }
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

        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    private sealed class CancelableBlockingReadStream : Stream
    {
        public TaskCompletionSource ReadStarted { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public bool CancellationObserved { get; private set; }
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
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
