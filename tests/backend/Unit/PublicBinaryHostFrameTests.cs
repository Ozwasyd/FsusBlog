using System.Buffers;
using System.IO.Pipelines;
using System.Runtime.InteropServices;
using System.Text;

using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Infrastructure.Memory.Accounting;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Lifetime;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;

using Microsoft.AspNetCore.Http.Features;

namespace FsusBlog.Server.Tests.Unit;

// Finite managed fixtures exercise the actual host owner and original response method.
// They do not qualify native allocation, publication or automatic production admission.
public sealed class PublicBinaryHostFrameTests
{
    [Theory]
    [InlineData(0)]
    [InlineData(13)]
    public async Task HostMemoryMatchesArrayFactoryBytesMetadataAndOriginalIntegrity(int payloadLength)
    {
        byte[] payload = Encoding.UTF8.GetBytes("中文😀abc").AsSpan(0, payloadLength).ToArray();
        byte[] frame = Frame(payload);
        var fixture = new Fixture(frame);
        using ManagedMemoryBacking owner = fixture.Owner;
        PublicHotReadOptions options = Options(frame.Length);
        PublicBinaryArtifact reference = PublicHotReadBinaryArtifactFactory.FromPayload(
            new AedsEncoder(), AedsFrameType.ArticleDetail, payload, "public,max-age=17", 7, options);
        ReadOnlyMemory<byte> captured = default;
        MemoryOperationResult<MemoryOperationCompletion> result = await Consume(owner, options, (artifact, _) =>
        {
            Assert.True(artifact.Frame.Span.SequenceEqual(reference.Frame.Span));
            Assert.Equal(reference.ETag, artifact.ETag);
            Assert.Equal(reference.Version, artifact.Version);
            Assert.Equal(reference.CacheControl, artifact.CacheControl);
            Assert.Equal(reference.FrameType, artifact.FrameType);
            Assert.True(artifact.BrotliFrame.IsEmpty);
            Assert.True(artifact.GzipFrame.IsEmpty);
            Assert.False(MemoryMarshal.TryGetArray(artifact.Frame, out _));
            PublicArtifactIntegrityContext context = PublicArtifactIntegrityContext.ForArticle(42);
            Assert.Equal(PublicHotReadArtifactIntegrity.Seal(reference, context).FrameIntegrityTag,
                PublicHotReadArtifactIntegrity.Seal(artifact, context).FrameIntegrityTag);
            Assert.Equal(1, owner.Snapshot().Readers);
            Assert.Single(fixture.Ledger.Allocations());
            captured = artifact.Frame;
            return ValueTask.CompletedTask;
        });
        Assert.True(result.Succeeded);
        Assert.Throws<ObjectDisposedException>(() => _ = captured.Span.Length);
        Assert.Equal(0, owner.Snapshot().Readers);
        Assert.Equal(frame.Length, fixture.Ledger.Snapshot().Used["payload"]);
    }

    [Theory]
    [InlineData("GET")]
    [InlineData("HEAD")]
    [InlineData("304")]
    [InlineData("identity-rejected")]
    public async Task OriginalResponsePreservesIdentityBytesStatusAndHeaders(string scenario)
    {
        byte[] payload = Encoding.UTF8.GetBytes("中文😀 body");
        byte[] frame = Frame(payload);
        var fixture = new Fixture(frame);
        using ManagedMemoryBacking owner = fixture.Owner;
        PublicHotReadOptions options = Options(frame.Length);
        PublicBinaryArtifact reference = PublicHotReadBinaryArtifactFactory.FromPayload(
            new AedsEncoder(), AedsFrameType.ArticleDetail, payload, "public,max-age=17", 7, options);
        DefaultHttpContext expected = Context(scenario, reference.ETag);
        DefaultHttpContext actual = Context(scenario, reference.ETag);
        await WriteOriginal(expected, reference, options);
        Assert.True((await Consume(owner, options, (artifact, _) =>
            new ValueTask(WriteOriginal(actual, artifact, options)))).Succeeded);
        Assert.Equal(expected.Response.StatusCode, actual.Response.StatusCode);
        Assert.Equal(expected.Response.ContentLength, actual.Response.ContentLength);
        Assert.Equal(expected.Response.ContentType, actual.Response.ContentType);
        Assert.Equal(expected.Response.Headers.OrderBy(pair => pair.Key).ToArray(),
            actual.Response.Headers.OrderBy(pair => pair.Key).ToArray());
        Assert.True(((MemoryStream)expected.Response.Body).ToArray().AsSpan()
            .SequenceEqual(((MemoryStream)actual.Response.Body).ToArray()));
        Assert.Equal(scenario == "304" ? 304 : scenario == "identity-rejected" ? 406 : 200,
            actual.Response.StatusCode);
        Assert.Equal(scenario == "GET" ? frame.Length : 0, actual.Response.Body.Length);
        Assert.Equal(0, owner.Snapshot().Readers);
    }

    [Fact]
    public async Task OuterWaitCancellationKeepsTheReadLeaseThroughOriginalPipeCompletion()
    {
        byte[] frame = Frame([1, 2, 3]);
        var fixture = new Fixture(frame);
        using ManagedMemoryBacking owner = fixture.Owner;
        var pipe = new Pipe(new PipeOptions(pauseWriterThreshold: 1, resumeWriterThreshold: 1));
        DefaultHttpContext context = PipeContext(pipe.Writer);
        using var outerWait = new CancellationTokenSource();
        ReadOnlyMemory<byte> captured = default;
        Task<MemoryOperationResult<MemoryOperationCompletion>> operation = Consume(owner, Options(frame.Length), (artifact, _) =>
        {
            captured = artifact.Frame;
            return new ValueTask(WriteOriginal(context, artifact, Options(frame.Length)));
        }).AsTask();
        try
        {
            Assert.False(operation.IsCompleted);
            Assert.Equal(1, owner.Snapshot().Readers);
            outerWait.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => operation.WaitAsync(outerWait.Token));
            owner.Close();
            Assert.False(owner.Drained.IsCompleted);
            Assert.Equal(frame.Length, fixture.Ledger.Snapshot().Used["payload"]);
            Assert.True(captured.Span.SequenceEqual(frame));
            ReadResult read = await pipe.Reader.ReadAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(30));
            Assert.True(read.Buffer.ToArray().AsSpan().SequenceEqual(frame));
            pipe.Reader.AdvanceTo(read.Buffer.End);
            Assert.True((await operation.WaitAsync(TimeSpan.FromSeconds(30))).Succeeded);
            await owner.Drained.WaitAsync(TimeSpan.FromSeconds(30));
            Assert.Throws<ObjectDisposedException>(() => _ = captured.Span.Length);
            Assert.Equal(0, fixture.Ledger.Snapshot().Used["payload"]);
            Assert.Single(fixture.Ledger.EventWindow().Events, entry => entry.Kind == "allocation-released");
        }
        finally
        {
            await pipe.Reader.CompleteAsync();
            await pipe.Writer.CompleteAsync();
            await ObserveTerminal(operation);
        }
    }

    [Fact]
    public async Task OriginalPendingWriteCancellationPropagatesAndEndsOnlyItsReadHold()
    {
        byte[] frame = Frame([4]);
        var fixture = new Fixture(frame);
        using ManagedMemoryBacking owner = fixture.Owner;
        var pipe = new Pipe(new PipeOptions(pauseWriterThreshold: 1, resumeWriterThreshold: 1));
        using var cancellation = new CancellationTokenSource();
        DefaultHttpContext context = PipeContext(pipe.Writer);
        context.RequestAborted = cancellation.Token;
        Task<MemoryOperationResult<MemoryOperationCompletion>> operation = Consume(owner, Options(frame.Length),
            (artifact, token) =>
            {
                Assert.Equal(context.RequestAborted, token);
                return new ValueTask(WriteOriginal(context, artifact, Options(frame.Length)));
            }, cancellation.Token).AsTask();
        try
        {
            Assert.False(operation.IsCompleted);
            Assert.Equal(1, owner.Snapshot().Readers);
            cancellation.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => operation.WaitAsync(TimeSpan.FromSeconds(30)));
            Assert.Equal(0, owner.Snapshot().Readers);
            Assert.Equal(frame.Length, fixture.Ledger.Snapshot().Used["payload"]);
            owner.Close();
            await owner.Drained;
            Assert.Equal(0, fixture.Ledger.Snapshot().Used["payload"]);
        }
        finally
        {
            await pipe.Reader.CompleteAsync();
            await pipe.Writer.CompleteAsync();
            await ObserveTerminal(operation);
        }
    }

    [Fact]
    public async Task ConsumerFailurePropagatesWithoutReturningTheRootBacking()
    {
        byte[] frame = Frame([5]);
        var fixture = new Fixture(frame);
        using ManagedMemoryBacking owner = fixture.Owner;
        var failure = new IOException("consumer failed");
        ReadOnlyMemory<byte> captured = default;
        IOException observed = await Assert.ThrowsAsync<IOException>(() => Consume(owner, Options(frame.Length), (artifact, _) =>
        {
            captured = artifact.Frame;
            throw failure;
        }).AsTask());
        Assert.Same(failure, observed);
        Assert.Throws<ObjectDisposedException>(() => _ = captured.Span.Length);
        Assert.Equal(0, owner.Snapshot().Readers);
        Assert.Equal(frame.Length, fixture.Ledger.Snapshot().Used["payload"]);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task InvalidFrameOrCeilingRejectsAndReturnsTheAcquiredReadHold(bool oversized)
    {
        byte[] frame = oversized ? Frame([6]) : new byte[16];
        var fixture = new Fixture(frame);
        using ManagedMemoryBacking owner = fixture.Owner;
        await Assert.ThrowsAsync<InvalidOperationException>(() => Consume(owner,
            Options(oversized ? frame.Length - 1 : frame.Length), NeverConsume).AsTask());
        Assert.Equal(0, owner.Snapshot().Readers);
        Assert.Equal(frame.Length, fixture.Ledger.Snapshot().Used["payload"]);
    }

    [Fact]
    public async Task StaleLocationPreservesTheOriginalTypedRejection()
    {
        byte[] frame = Frame([7]);
        var fixture = new Fixture(frame);
        using ManagedMemoryBacking owner = fixture.Owner;
        MemoryLocationToken stale = owner.Location with
        {
            Revision = new(2)
        };
        MemoryOperationResult<MemoryOperationCompletion> result = await Consume(owner, Options(frame.Length), NeverConsume,
            expectedLocation: stale);
        Assert.Equal(MemoryFailure.StaleLocation, result.Failure);
        Assert.True(result.IsCorrectnessFailure);
        Assert.Equal(0, owner.Snapshot().Readers);
        Assert.Equal(frame.Length, fixture.Ledger.Snapshot().Used["payload"]);
    }

    [Fact]
    public async Task ReadHoldLimitRejectsBeforeConsumerWithoutAnotherPhysicalCharge()
    {
        byte[] frame = Frame([8]);
        var fixture = new Fixture(frame, holdLimit: 1);
        using ManagedMemoryBacking owner = fixture.Owner;
        MemoryOperationResult<MemoryOperationCompletion> result = await Consume(owner, Options(frame.Length), NeverConsume);
        Assert.Equal(MemoryFailure.BudgetRejected, result.Failure);
        Assert.Equal(0, owner.Snapshot().Readers);
        Assert.Single(fixture.Ledger.Allocations());
        Assert.Single(fixture.Ledger.EventWindow().Events, entry => entry.Kind == "committed");
    }

    [Fact]
    public async Task PreCanceledInputDoesNotAcquireOrCallTheConsumer()
    {
        byte[] frame = Frame([9]);
        var fixture = new Fixture(frame);
        using ManagedMemoryBacking owner = fixture.Owner;
        var source = new ObservedSource(owner);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => Consume(source, Options(frame.Length), NeverConsume,
            cancellation.Token, owner.Location).AsTask());
        Assert.Equal(0, source.Acquisitions);
        Assert.Equal(0, owner.Snapshot().Readers);
    }

    [Fact]
    public async Task CompressionRequestRejectsWithoutAcquisitionOrCompatibilityCopy()
    {
        byte[] frame = Frame([10]);
        var fixture = new Fixture(frame);
        using ManagedMemoryBacking owner = fixture.Owner;
        var source = new ObservedSource(owner);
        PublicHotReadOptions options = Options(frame.Length);
        options.EnablePrecompressedBinaryVariants = true;
        MemoryOperationResult<MemoryOperationCompletion> result = await Consume(source, options, NeverConsume,
            expectedLocation: owner.Location);
        Assert.Equal(MemoryFailure.UnsupportedCapability, result.Failure);
        Assert.Equal(0, source.Acquisitions);
        Assert.Equal(0, owner.Snapshot().Readers);
        Assert.Single(fixture.Ledger.Allocations());
    }

    [Fact]
    public async Task RepeatedBorrowingEndsEachReadHoldAndRefundsTheBackingOnce()
    {
        byte[] frame = Frame([11]);
        var fixture = new Fixture(frame);
        using ManagedMemoryBacking owner = fixture.Owner;
        for (int index = 0; index < 4; index++)
        {
            ReadOnlyMemory<byte> captured = default;
            Assert.True((await Consume(owner, Options(frame.Length), (artifact, _) =>
            {
                captured = artifact.Frame;
                Assert.True(captured.Span.SequenceEqual(frame));
                return ValueTask.CompletedTask;
            })).Succeeded);
            Assert.Throws<ObjectDisposedException>(() => _ = captured.Span.Length);
            Assert.Equal(0, owner.Snapshot().Readers);
            Assert.Equal(frame.Length, fixture.Ledger.Snapshot().Used["payload"]);
        }
        owner.Close();
        await owner.Drained;
        owner.Dispose();
        Assert.Equal(0, fixture.Ledger.Snapshot().Used["payload"]);
        Assert.Single(fixture.Ledger.EventWindow().Events, entry => entry.Kind == "allocation-released");
    }

    private static ValueTask<MemoryOperationResult<MemoryOperationCompletion>> Consume(
        IMemoryHostViewSource source, PublicHotReadOptions options,
        Func<PublicBinaryArtifact, CancellationToken, ValueTask> consumer,
        CancellationToken token = default, MemoryLocationToken? expectedLocation = null)
        => PublicHotReadBinaryArtifactFactory.ConsumeHostFrameAsync(source,
            expectedLocation ?? ((ManagedMemoryBacking)source).Location, AedsFrameType.ArticleDetail,
            "public,max-age=17", 7, options, consumer, token);

    private static ValueTask NeverConsume(PublicBinaryArtifact artifact, CancellationToken token)
        => throw new InvalidOperationException("rejected input must not reach its consumer");

    private static byte[] Frame(byte[] payload) => new AedsEncoder().Encode(AedsFrameType.ArticleDetail, payload);

    private static PublicHotReadOptions Options(int ceiling) => new()
    {
        EnablePrecompressedBinaryVariants = false,
        MaxFrameBytes = ceiling
    };

    private static DefaultHttpContext Context(string scenario = "GET", string etag = "")
    {
        var context = new DefaultHttpContext();
        context.Request.Method = scenario == "HEAD" ? HttpMethods.Head : HttpMethods.Get;
        context.Response.Body = new MemoryStream();
        if (scenario == "304")
        {
            context.Request.Headers.IfNoneMatch = etag;
        }
        if (scenario == "identity-rejected")
        {
            context.Request.Headers.AcceptEncoding = "identity;q=0";
        }
        return context;
    }

    private static DefaultHttpContext PipeContext(PipeWriter writer)
    {
        DefaultHttpContext context = Context();
        context.Features.Set<IHttpResponseBodyFeature>(new PipeBodyFeature(writer));
        return context;
    }

    private static Task WriteOriginal(DefaultHttpContext context, PublicBinaryArtifact artifact, PublicHotReadOptions options)
    {
        PublicArtifactIntegrityContext integrity = PublicArtifactIntegrityContext.ForArticle(42);
        return PublicHotReadFastPath.WriteBinaryFrame(context,
            _ => throw new InvalidOperationException("ordinary valid identity must not fall back"),
            PublicHotReadArtifactIntegrity.Seal(artifact, integrity), integrity, new PublicHotReadCounters(), options,
            "article", "42", false, false, false);
    }

    private static async Task ObserveTerminal(Task operation)
    {
        try
        {
            await operation.WaitAsync(TimeSpan.FromSeconds(30));
        }
        catch (OperationCanceledException)
        {
        }
    }

    private sealed class ObservedSource(IMemoryHostViewSource source) : IMemoryHostViewSource
    {
        public int Acquisitions
        {
            get; private set;
        }
        public MemoryOperationResult<IMemoryHostReadLease> TryAcquireHostView(MemoryLocationToken expectedLocation)
        {
            Acquisitions++;
            return source.TryAcquireHostView(expectedLocation);
        }
    }

    private sealed class Fixture
    {
        public Fixture(byte[] frame, int holdLimit = 8)
        {
            var payload = new ResourceDomainId(Guid.NewGuid());
            var operations = new ResourceDomainId(Guid.NewGuid());
            var topology = new MemoryResourceTopology([
                new(payload, "payload", MemoryResourceUnit.Bytes, null),
                new(operations, "operations", MemoryResourceUnit.OperationSlots, null)
            ]);
            Ledger = new MemoryReservationCoordinator(topology, [
                new(payload, MemoryResourceUnit.Bytes, frame.Length),
                new(operations, MemoryResourceUnit.OperationSlots, 1)
            ], policyRevision: 1, entryLimit: 16, eventCapacity: 64);
            MemoryOperationResult<ManagedMemoryBacking> creation = ManagedMemoryBacking.TryCreate(Ledger, payload, operations,
                new(new(Guid.NewGuid()), new(7), new(Guid.NewGuid())), new(1), new(1), frame, frame.Length, holdLimit);
            Assert.True(creation.Succeeded);
            Owner = creation.Value!;
        }
        public MemoryReservationCoordinator Ledger
        {
            get;
        }
        public ManagedMemoryBacking Owner
        {
            get;
        }
    }

    private sealed class PipeBodyFeature(PipeWriter writer) : IHttpResponseBodyFeature
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
}
