using System.Buffers;
using System.IO.Pipelines;
using System.Text;

using FsusBlog.Server.Infrastructure.Memory.Transient;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Tests.Helpers;

using Microsoft.AspNetCore.Http.Features;

namespace FsusBlog.Server.Tests.Unit;

// Managed fixture budgets exercise the original response/lease owners, not production or native qualification.
public sealed class CspNonceTransientResponseTests
{
    [Theory]
    [InlineData("n")]
    [InlineData("longer_nonce_123")]
    public async Task AdmittedScratchStreamsCanonicalMultilingualBytesWithoutChangingTemplate(string nonce)
    {
        CspNonceUtf8Template template = Template();
        string digest = template.TemplateDigest;
        byte[] integrity = template.IntegrityBytes.ToArray();
        byte[] reference = Render(template, nonce);
        var (ledger, host, _) = TransientMemoryTestLedger.Create(64);
        using var pool = new TransientBufferPool(ledger, host, TransientWorkload.Encoding, new(64, 4, 0, 0));
        using IMemoryOwner<byte> scratch = pool.TryRent(Encoding.UTF8.GetByteCount(nonce)).Value!;
        var pipe = new Pipe();
        var writer = new ObservedPipeWriter(pipe.Writer);
        try
        {
            await CspNonceHtmlResponseWriter.WriteBodyAsync(Context(writer).Response, template, nonce,
                (TransientBufferLease)scratch, CancellationToken.None);
            ReadResult read = await pipe.Reader.ReadAsync();
            Assert.True(read.Buffer.ToArray().AsSpan().SequenceEqual(reference));
            pipe.Reader.AdvanceTo(read.Buffer.End);
            Assert.Equal(1, writer.FlushCalls);
            Assert.True(writer.AdvanceCalls >= template.SlotCount + 1);
            Assert.Equal(digest, template.TemplateDigest);
            Assert.True(template.IntegrityBytes.Span.SequenceEqual(integrity));
            Assert.Equal(1, pool.Snapshot().Holds);
            Assert.Equal(((TransientBufferLease)scratch).Capacity, ledger.Snapshot().Used["host"]);
        }
        finally
        {
            await pipe.Reader.CompleteAsync();
            await writer.CompleteAsync();
        }
    }

    [Fact]
    public async Task CanceledOuterWaitCannotRefundScratchWhileRealPipeFlushIsBackpressured()
    {
        CspNonceUtf8Template template = Template();
        byte[] reference = Render(template, "pending_nonce");
        var (ledger, host, _) = TransientMemoryTestLedger.Create(64);
        using var pool = new TransientBufferPool(ledger, host, TransientWorkload.Encoding, new(64, 4, 0, 0));
        using IMemoryOwner<byte> scratch = pool.TryRent(13).Value!;
        int capacity = ((TransientBufferLease)scratch).Capacity;
        var pipe = new Pipe(new PipeOptions(pauseWriterThreshold: 1, resumeWriterThreshold: 1));
        var writer = new ObservedPipeWriter(pipe.Writer);
        using var outerWait = new CancellationTokenSource();
        Task operation = CspNonceHtmlResponseWriter.WriteBodyAsync(Context(writer).Response, template,
            "pending_nonce", (TransientBufferLease)scratch, CancellationToken.None);
        try
        {
            Assert.Equal(1, writer.FlushCalls);
            Assert.False(operation.IsCompleted);
            Assert.Equal(2, pool.Snapshot().Holds);
            outerWait.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => operation.WaitAsync(outerWait.Token));
            scratch.Dispose();
            pool.Dispose();
            Assert.False(pool.Drained.IsCompleted);
            Assert.Equal(capacity, ledger.Snapshot().Used["host"]);
            ReadResult read = await pipe.Reader.ReadAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(30));
            Assert.True(read.Buffer.ToArray().AsSpan().SequenceEqual(reference));
            pipe.Reader.AdvanceTo(read.Buffer.End);
            await operation.WaitAsync(TimeSpan.FromSeconds(30));
            await pool.Drained.WaitAsync(TimeSpan.FromSeconds(30));
            Assert.Equal(0, ledger.Snapshot().Used["host"]);
            Assert.Single(ledger.EventWindow().Events, item => item.Kind == "allocation-released");
        }
        finally
        {
            await pipe.Reader.CompleteAsync();
            await writer.CompleteAsync();
            await ObserveTerminal(operation);
        }
    }

    [Fact]
    public async Task PreCanceledRequestWritesNoBodyAndReleasesOnlyTheOperationHold()
    {
        var (ledger, host, _) = TransientMemoryTestLedger.Create(64);
        using var pool = new TransientBufferPool(ledger, host, TransientWorkload.Encoding, new(64, 4, 0, 0));
        using IMemoryOwner<byte> scratch = pool.TryRent(16).Value!;
        var pipe = new Pipe();
        var writer = new ObservedPipeWriter(pipe.Writer);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        try
        {
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => CspNonceHtmlResponseWriter.WriteBodyAsync(
                Context(writer).Response, Template(), "cancel_nonce", (TransientBufferLease)scratch, cancellation.Token));
            Assert.Equal(0, writer.AdvanceCalls);
            Assert.Equal(0, writer.FlushCalls);
            Assert.Equal(1, pool.Snapshot().Holds);
            Assert.Equal(16, ledger.Snapshot().Used["host"]);
            scratch.Dispose();
            Assert.Equal(0, ledger.Snapshot().Used["host"]);
        }
        finally
        {
            await pipe.Reader.CompleteAsync();
            await writer.CompleteAsync();
        }
    }

    [Fact]
    public async Task SegmentCancellationPreservesOriginalSingleAdvanceAndNoFlush()
    {
        var (ledger, host, _) = TransientMemoryTestLedger.Create(64);
        using var pool = new TransientBufferPool(ledger, host, TransientWorkload.Encoding, new(64, 4, 0, 0));
        using IMemoryOwner<byte> scratch = pool.TryRent(32).Value!;
        var pipe = new Pipe();
        using var cancellation = new CancellationTokenSource();
        var writer = new ObservedPipeWriter(pipe.Writer) { Advanced = cancellation.Cancel };
        CspNonceUtf8Template template = Template();
        string digest = template.TemplateDigest;
        try
        {
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => CspNonceHtmlResponseWriter.WriteBodyAsync(
                Context(writer).Response, template, "cancel_between_segments", (TransientBufferLease)scratch, cancellation.Token));
            Assert.Equal(1, writer.AdvanceCalls);
            Assert.Equal(0, writer.FlushCalls);
            Assert.Equal(1, pool.Snapshot().Holds);
            Assert.Equal(digest, template.TemplateDigest);
        }
        finally
        {
            await pipe.Reader.CompleteAsync();
            await writer.CompleteAsync();
        }
    }

    [Fact]
    public async Task CompletedReaderIsStillAnAbortedResponseAfterExactlyOneFlush()
    {
        var (ledger, host, _) = TransientMemoryTestLedger.Create(64);
        using var pool = new TransientBufferPool(ledger, host, TransientWorkload.Encoding, new(64, 4, 0, 0));
        using IMemoryOwner<byte> scratch = pool.TryRent(16).Value!;
        var pipe = new Pipe();
        await pipe.Reader.CompleteAsync();
        var writer = new ObservedPipeWriter(pipe.Writer);
        try
        {
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => CspNonceHtmlResponseWriter.WriteBodyAsync(
                Context(writer).Response, Template(), "aborted_nonce", (TransientBufferLease)scratch, CancellationToken.None));
            Assert.Equal(1, writer.FlushCalls);
            Assert.Equal(1, pool.Snapshot().Holds);
            scratch.Dispose();
            Assert.Equal(0, ledger.Snapshot().Used["host"]);
        }
        finally
        {
            await writer.CompleteAsync();
        }
    }

    [Fact]
    public async Task LogicalScratchBoundRejectsEvenWhenChargedPhysicalBucketWouldFit()
    {
        var (ledger, host, _) = TransientMemoryTestLedger.Create(64);
        using var pool = new TransientBufferPool(ledger, host, TransientWorkload.Encoding, new(64, 4, 0, 0));
        using IMemoryOwner<byte> scratch = pool.TryRent(17).Value!;
        Assert.Equal(32, ((TransientBufferLease)scratch).Capacity);
        var pipe = new Pipe();
        var writer = new ObservedPipeWriter(pipe.Writer);
        scratch.Memory.Span.Fill(90);
        try
        {
            await Assert.ThrowsAsync<ArgumentException>(() => CspNonceHtmlResponseWriter.WriteBodyAsync(
                Context(writer).Response, Template(), new string('a', 18), (TransientBufferLease)scratch, CancellationToken.None));
            Assert.Equal(0, writer.AdvanceCalls);
            Assert.Equal(0, writer.FlushCalls);
            Assert.True(scratch.Memory.Span.IndexOfAnyExcept((byte)90) < 0);
            Assert.Equal(1, pool.Snapshot().Holds);
            Assert.Equal(32, ledger.Snapshot().Used["host"]);
        }
        finally
        {
            await pipe.Reader.CompleteAsync();
            await writer.CompleteAsync();
        }
    }

    [Fact]
    public async Task RepeatedValidAndInvalidNonceFlowsReuseClearedBackingAndRefundOnce()
    {
        var (ledger, host, _) = TransientMemoryTestLedger.Create(64);
        using var pool = new TransientBufferPool(ledger, host, TransientWorkload.Encoding, new(64, 4, 1, 64));
        CspNonceUtf8Template template = Template();
        string digest = template.TemplateDigest;
        for (int iteration = 0; iteration < 4; iteration++)
        {
            using IMemoryOwner<byte> scratch = pool.TryRent(16).Value!;
            Assert.True(scratch.Memory.Span.IndexOfAnyExcept((byte)0) < 0);
            var pipe = new Pipe();
            var writer = new ObservedPipeWriter(pipe.Writer);
            try
            {
                if (iteration % 2 == 0)
                {
                    await Assert.ThrowsAsync<InvalidOperationException>(() => CspNonceHtmlResponseWriter.WriteBodyAsync(
                        Context(writer).Response, template, "invalid_nonce?", (TransientBufferLease)scratch, CancellationToken.None));
                    Assert.Equal(0, writer.AdvanceCalls);
                    Assert.Equal(0, writer.FlushCalls);
                }
                else
                {
                    await CspNonceHtmlResponseWriter.WriteBodyAsync(Context(writer).Response, template,
                        "valid_nonce", (TransientBufferLease)scratch, CancellationToken.None);
                    ReadResult read = await pipe.Reader.ReadAsync();
                    Assert.True(read.Buffer.ToArray().AsSpan().SequenceEqual(Render(template, "valid_nonce")));
                    pipe.Reader.AdvanceTo(read.Buffer.End);
                    Assert.Equal(1, writer.FlushCalls);
                }
                Assert.Equal(1, pool.Snapshot().Holds);
                Assert.Equal(digest, template.TemplateDigest);
            }
            finally
            {
                await pipe.Reader.CompleteAsync();
                await writer.CompleteAsync();
            }
        }
        Assert.Single(ledger.EventWindow().Events, item => item.Kind == "committed");
        Assert.Equal(16, ledger.Snapshot().Used["host"]);
        pool.Dispose();
        Assert.True(pool.Drained.IsCompletedSuccessfully);
        Assert.Equal(0, ledger.Snapshot().Used["host"]);
        Assert.Single(ledger.EventWindow().Events, item => item.Kind == "allocation-released");
    }

    [Fact]
    public async Task HoldBudgetRejectionDoesNotEncodeNonceOrWriteTheResponse()
    {
        var (ledger, host, _) = TransientMemoryTestLedger.Create(64);
        using var pool = new TransientBufferPool(ledger, host, TransientWorkload.Encoding, new(64, 1, 0, 0));
        using IMemoryOwner<byte> scratch = pool.TryRent(16).Value!;
        scratch.Memory.Span.Fill(90);
        var pipe = new Pipe();
        var writer = new ObservedPipeWriter(pipe.Writer);
        try
        {
            await Assert.ThrowsAsync<InsufficientMemoryException>(() => CspNonceHtmlResponseWriter.WriteBodyAsync(
                Context(writer).Response, Template(), "valid_nonce", (TransientBufferLease)scratch, CancellationToken.None));
            Assert.True(scratch.Memory.Span.IndexOfAnyExcept((byte)90) < 0);
            Assert.Equal(0, writer.AdvanceCalls);
            Assert.Equal(0, writer.FlushCalls);
            Assert.Equal(1, pool.Snapshot().Holds);
        }
        finally
        {
            await pipe.Reader.CompleteAsync();
            await writer.CompleteAsync();
        }
    }

    [Fact]
    public async Task RequestCancellationTerminatesTheRealPendingFlushBeforeHoldRelease()
    {
        var (ledger, host, _) = TransientMemoryTestLedger.Create(64);
        using var pool = new TransientBufferPool(ledger, host, TransientWorkload.Encoding, new(64, 4, 0, 0));
        using IMemoryOwner<byte> scratch = pool.TryRent(16).Value!;
        var pipe = new Pipe(new PipeOptions(pauseWriterThreshold: 1, resumeWriterThreshold: 1));
        var writer = new ObservedPipeWriter(pipe.Writer);
        using var cancellation = new CancellationTokenSource();
        Task operation = CspNonceHtmlResponseWriter.WriteBodyAsync(Context(writer).Response, Template(),
            "cancel_nonce", (TransientBufferLease)scratch, cancellation.Token);
        try
        {
            Assert.False(operation.IsCompleted);
            Assert.Equal(2, pool.Snapshot().Holds);
            cancellation.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => operation.WaitAsync(TimeSpan.FromSeconds(30)));
            Assert.Equal(1, writer.FlushCalls);
            Assert.Equal(1, pool.Snapshot().Holds);
            Assert.Equal(16, ledger.Snapshot().Used["host"]);
            scratch.Dispose();
            pool.Dispose();
            await pool.Drained.WaitAsync(TimeSpan.FromSeconds(30));
            Assert.Equal(0, ledger.Snapshot().Used["host"]);
        }
        finally
        {
            await pipe.Reader.CompleteAsync();
            await writer.CompleteAsync();
            await ObserveTerminal(operation);
        }
    }

    private static async Task ObserveTerminal(Task operation)
    {
        try
        {
            await operation.WaitAsync(TimeSpan.FromSeconds(30));
        }
        catch (OperationCanceledException)
        {
            // Aborting the fixture reader terminates the original flush before cleanup returns.
        }
    }

    private static CspNonceUtf8Template Template()
        => Assert.IsType<CspNonceUtf8Template>(CspNonceUtf8Template.Compile(
            "<html><head><style>.字{color:red}</style></head><body>中文🙂<script>globalThis.emoji='😀'</script></body></html>",
            "nonce-composition-fixture"));

    private static byte[] Render(CspNonceUtf8Template template, string nonce)
    {
        var writer = new ArrayBufferWriter<byte>();
        template.Write(writer, Encoding.UTF8.GetBytes(nonce));
        return writer.WrittenSpan.ToArray();
    }

    private static DefaultHttpContext Context(PipeWriter writer)
    {
        var context = new DefaultHttpContext();
        context.Features.Set<IHttpResponseBodyFeature>(new PipeResponseBodyFeature(writer));
        return context;
    }

    private sealed class PipeResponseBodyFeature(PipeWriter writer) : IHttpResponseBodyFeature
    {
        public Stream Stream => Stream.Null;
        public PipeWriter Writer => writer;
        public void DisableBuffering()
        {
        }
        public Task StartAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task SendFileAsync(string path, long offset, long? count, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();
        public Task CompleteAsync() => writer.CompleteAsync().AsTask();
    }

    private sealed class ObservedPipeWriter(PipeWriter inner) : PipeWriter
    {
        public Action? Advanced
        {
            get; set;
        }
        public int AdvanceCalls
        {
            get; private set;
        }
        public int FlushCalls
        {
            get; private set;
        }
        public override void Advance(int bytes)
        {
            inner.Advance(bytes);
            AdvanceCalls++;
            Advanced?.Invoke();
        }
        public override Memory<byte> GetMemory(int sizeHint = 0) => inner.GetMemory(sizeHint);
        public override Span<byte> GetSpan(int sizeHint = 0) => inner.GetSpan(sizeHint);
        public override void CancelPendingFlush() => inner.CancelPendingFlush();
        public override void Complete(Exception? exception = null) => inner.Complete(exception);
        public override ValueTask CompleteAsync(Exception? exception = null) => inner.CompleteAsync(exception);
        public override ValueTask<FlushResult> FlushAsync(CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            FlushCalls++;
            return inner.FlushAsync(cancellationToken);
        }
    }
}
