using System.Buffers;
using System.IO.Pipelines;
using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Infrastructure.Results;
using Microsoft.AspNetCore.Http.Features;

namespace FsusBlog.Server.Tests.Unit;

public sealed class BinaryFramePipeWriterTests
{
    [Fact]
    public async Task BinaryResults_UseOneEffectivePipeCommitPerResponse()
    {
        await AssertSingleCommitAsync(new BinaryFrameResult(
            AedsFrameType.ArticleList,
            payload =>
            {
                payload.Write(new byte[] { 1, 2 });
                payload.Write(new byte[] { 3, 4 });
            }));
        await AssertSingleCommitAsync(new BinaryFramePayloadResult(
            new AedsEncoder(),
            AedsFrameType.ArticleList,
            new byte[] { 1, 2, 3, 4 }));
        await AssertSingleCommitAsync(new BinaryPreencodedFrameResult(
            new AedsEncoder().Encode(AedsFrameType.ArticleList, [1, 2, 3, 4])));
    }

    [Fact]
    public async Task BinaryResults_PropagateCanceledRequestWithoutCompletedFlush()
    {
        IResult[] results =
        [
            new BinaryFrameResult(AedsFrameType.ArticleList, payload => payload.Write(new byte[] { 1 })),
            new BinaryFramePayloadResult(new AedsEncoder(), AedsFrameType.ArticleList, new byte[] { 1 }),
            new BinaryPreencodedFrameResult(new AedsEncoder().Encode(AedsFrameType.ArticleList, [1]))
        ];

        foreach (IResult result in results)
        {
            var pipe = new Pipe();
            var writer = new CountingPipeWriter(pipe.Writer);
            var context = CreateContext(writer);
            using var cts = new CancellationTokenSource();
            cts.Cancel();
            context.RequestAborted = cts.Token;

            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => result.ExecuteAsync(context));

            Assert.Equal(1, writer.AdvanceCalls);
            Assert.Equal(0, writer.FlushCalls);
            await writer.CompleteAsync();
            await pipe.Reader.CompleteAsync();
        }
    }

    [Fact]
    public async Task PreencodedResult_PropagatesRealPipeBackpressure()
    {
        var pipe = new Pipe(new PipeOptions(pauseWriterThreshold: 1, resumeWriterThreshold: 1));
        var writer = new CountingPipeWriter(pipe.Writer);
        var context = CreateContext(writer);
        var result = new BinaryPreencodedFrameResult(
            new AedsEncoder().Encode(AedsFrameType.ArticleDetail, new byte[128]));

        Task execution = result.ExecuteAsync(context);
        await Task.Yield();
        Assert.False(execution.IsCompleted);

        ReadResult read = await pipe.Reader.ReadAsync();
        Assert.False(read.Buffer.IsEmpty);
        pipe.Reader.AdvanceTo(read.Buffer.End);
        await execution.WaitAsync(TimeSpan.FromSeconds(5));

        Assert.Equal(1, writer.WriteAsyncCalls);
        Assert.Equal(1, writer.FlushCalls);
        await writer.CompleteAsync();
        await pipe.Reader.CompleteAsync();
    }

    private static async Task AssertSingleCommitAsync(IResult result)
    {
        var pipe = new Pipe();
        var writer = new CountingPipeWriter(pipe.Writer);
        var context = CreateContext(writer);

        await result.ExecuteAsync(context);

        Assert.Equal(1, writer.FlushCalls);
        Assert.Equal(1, writer.AdvanceCalls);
        ReadResult read = await pipe.Reader.ReadAsync();
        Assert.False(read.Buffer.IsEmpty);
        pipe.Reader.AdvanceTo(read.Buffer.End);
        await writer.CompleteAsync();
        await pipe.Reader.CompleteAsync();
    }

    private static DefaultHttpContext CreateContext(PipeWriter writer)
    {
        var context = new DefaultHttpContext();
        context.Features.Set<IHttpResponseBodyFeature>(new PipeResponseBodyFeature(writer));
        return context;
    }

    private sealed class PipeResponseBodyFeature(PipeWriter writer) : IHttpResponseBodyFeature
    {
        public Stream Stream => Stream.Null;
        public PipeWriter Writer => writer;
        public void DisableBuffering() { }
        public Task StartAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task SendFileAsync(string path, long offset, long? count, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();
        public Task CompleteAsync() => writer.CompleteAsync().AsTask();
    }

    private sealed class CountingPipeWriter(PipeWriter inner) : PipeWriter
    {
        private int _advancedSinceFlush;

        public int WriteAsyncCalls { get; private set; }
        public int FlushCalls { get; private set; }
        public int BufferedWriteCommits { get; private set; }
        public int AdvanceCalls { get; private set; }

        public override void Advance(int bytes)
        {
            inner.Advance(bytes);
            AdvanceCalls++;
            _advancedSinceFlush += bytes;
        }

        public override void CancelPendingFlush() => inner.CancelPendingFlush();
        public override void Complete(Exception? exception = null) => inner.Complete(exception);
        public override ValueTask CompleteAsync(Exception? exception = null) => inner.CompleteAsync(exception);

        public override ValueTask<FlushResult> FlushAsync(CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            FlushCalls++;
            if (_advancedSinceFlush > 0)
            {
                BufferedWriteCommits++;
                _advancedSinceFlush = 0;
            }

            return inner.FlushAsync(cancellationToken);
        }

        public override Memory<byte> GetMemory(int sizeHint = 0) => inner.GetMemory(sizeHint);
        public override Span<byte> GetSpan(int sizeHint = 0) => inner.GetSpan(sizeHint);

        public override ValueTask<FlushResult> WriteAsync(
            ReadOnlyMemory<byte> source,
            CancellationToken cancellationToken = default)
        {
            WriteAsyncCalls++;
            source.CopyTo(GetMemory(source.Length));
            Advance(source.Length);
            return FlushAsync(cancellationToken);
        }
    }
}
