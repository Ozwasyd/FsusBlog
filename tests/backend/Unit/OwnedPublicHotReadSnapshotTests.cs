using System.Buffers;
using System.Collections.Frozen;
using System.IO.Pipelines;

using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Infrastructure.Memory.Accounting;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Lifetime;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;

using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.Options;

namespace FsusBlog.Server.Tests.Unit;

// Managed fixtures use the existing publication-evidence test constructor, not a new verifier.
// Their finite shared-hold limits and visibility data do not qualify a production workload.
public sealed class OwnedPublicHotReadSnapshotTests
{
    [Theory]
    [InlineData("GET")]
    [InlineData("HEAD")]
    [InlineData("304")]
    public async Task SuppliedRealLeasesSurviveBackingRetirementAndServeOriginalIdentity(string method)
    {
        using var fixture = new Fixture();
        var store = Store(fixture.Clock);
        try
        {
            store.Publish(fixture.Snapshot);
            fixture.Owner.Close();
            Assert.Equal(fixture.Owner.Content, fixture.Lease.Content);
            Assert.Equal(fixture.Owner.Location, fixture.Lease.Location);
            Assert.Equal(1, fixture.Owner.Snapshot().Readers);
            Assert.False(fixture.Owner.Drained.IsCompleted);
            DefaultHttpContext context = Context(method: method == "HEAD" ? "HEAD" : "GET");
            if (method == "304")
            {
                context.Request.Headers.IfNoneMatch = fixture.Artifact.ETag;
            }
            await Serve(context, store);
            Assert.Equal(method == "304" ? 304 : 200, context.Response.StatusCode);
            Assert.Equal(fixture.Artifact.ETag, context.Response.Headers.ETag);
            Assert.Equal("2", context.Response.Headers["X-Fsus-Frame-Version"]);
            Assert.Equal("identity", context.Response.Headers["X-Fsus-Frame-Encoding"]);
            Assert.Equal(method == "304" ? 0 : fixture.Frame.Length, context.Response.ContentLength);
            Assert.Equal(method == "GET" ? fixture.Frame : [], ((MemoryStream)context.Response.Body).ToArray());
            Assert.Equal(fixture.Frame.Length, fixture.Ledger.Snapshot().Used["payload"]);
        }
        finally
        {
            Drop(store);
        }
        await fixture.Owner.Drained;
        Assert.Equal(0, fixture.Ledger.Snapshot().Used["payload"]);
        Assert.Throws<ObjectDisposedException>(() => _ = fixture.Artifact.Frame.Span.Length);
    }

    [Fact]
    public async Task ContentReplacementKeepsTheOldReadThroughOriginalPipeCompletion()
    {
        using var first = new Fixture();
        using var second = new Fixture(2, clock: first.Clock);
        var store = Store(first.Clock);
        store.Publish(first.Snapshot);
        first.Owner.Close();
        var pipe = new Pipe(new PipeOptions(pauseWriterThreshold: 1, resumeWriterThreshold: 1));
        Task operation = Serve(PipeContext(pipe.Writer), store);
        try
        {
            Assert.False(operation.IsCompleted);
            store.Publish(second.Snapshot);
            Assert.Same(second.Snapshot, store.Current);
            Assert.False(first.Owner.Drained.IsCompleted);
            Assert.Equal(first.Frame.Length, first.Ledger.Snapshot().Used["payload"]);
            await ReadAndFinish(pipe, operation, first.Frame);
            await first.Owner.Drained.WaitAsync(TimeSpan.FromSeconds(30));
            Assert.Equal(0, first.Ledger.Snapshot().Used["payload"]);
            DefaultHttpContext fresh = Context();
            await Serve(fresh, store);
            Assert.Equal(second.Frame, ((MemoryStream)fresh.Response.Body).ToArray());
        }
        finally
        {
            Drop(store);
            await FinishPipe(pipe, operation);
        }
    }

    [Fact]
    public async Task DropRejectsNewReadsWhileCanceledOuterWaitKeepsOriginalConsumptionAlive()
    {
        using var fixture = new Fixture();
        var store = Store(fixture.Clock);
        store.Publish(fixture.Snapshot);
        fixture.Owner.Close();
        var pipe = new Pipe(new PipeOptions(pauseWriterThreshold: 1, resumeWriterThreshold: 1));
        Task operation = Serve(PipeContext(pipe.Writer), store);
        using var outerWait = new CancellationTokenSource();
        try
        {
            Assert.False(operation.IsCompleted);
            outerWait.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => operation.WaitAsync(outerWait.Token));
            Drop(store);
            Assert.False(fixture.Owner.Drained.IsCompleted);
            Assert.Equal(fixture.Frame.Length, fixture.Ledger.Snapshot().Used["payload"]);
            DefaultHttpContext rejected = Context();
            await Serve(rejected, store);
            Assert.Equal(503, rejected.Response.StatusCode);
            Assert.Equal(0, rejected.Response.Body.Length);
            await ReadAndFinish(pipe, operation, fixture.Frame);
            await fixture.Owner.Drained.WaitAsync(TimeSpan.FromSeconds(30));
            Assert.Equal(0, fixture.Ledger.Snapshot().Used["payload"]);
            Assert.Single(fixture.Ledger.EventWindow().Events, entry => entry.Kind == "allocation-released");
        }
        finally
        {
            Drop(store);
            await FinishPipe(pipe, operation);
        }
    }

    [Fact]
    public async Task RequestCancellationEndsTheOriginalWriteBeforeReturningDroppedOwnership()
    {
        using var fixture = new Fixture();
        var store = Store(fixture.Clock);
        store.Publish(fixture.Snapshot);
        fixture.Owner.Close();
        var pipe = new Pipe(new PipeOptions(pauseWriterThreshold: 1, resumeWriterThreshold: 1));
        using var cancellation = new CancellationTokenSource();
        DefaultHttpContext context = PipeContext(pipe.Writer);
        context.RequestAborted = cancellation.Token;
        Task operation = Serve(context, store);
        try
        {
            Assert.False(operation.IsCompleted);
            Drop(store);
            Assert.False(fixture.Owner.Drained.IsCompleted);
            cancellation.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => operation.WaitAsync(TimeSpan.FromSeconds(30)));
            await fixture.Owner.Drained.WaitAsync(TimeSpan.FromSeconds(30));
            Assert.Equal(0, fixture.Ledger.Snapshot().Used["payload"]);
        }
        finally
        {
            Drop(store);
            await FinishPipe(pipe, operation);
        }
    }

    [Fact]
    public async Task RetainLastGoodKeepsTheSuppliedLeaseUntilOriginalDrop()
    {
        using var fixture = new Fixture();
        var store = Store(fixture.Clock);
        store.Publish(fixture.Snapshot);
        fixture.Owner.Close();
        try
        {
            store.InvalidateDistributedSnapshot("unit-refresh", PublicHotReadInvalidationPolicy.RetainLastGood);
            Assert.Same(fixture.Snapshot, store.LastGoodSnapshotForTests);
            Assert.False(fixture.Owner.Drained.IsCompleted);
            DefaultHttpContext context = Context();
            var counters = new PublicHotReadCounters();
            await PublicHotReadFastPath.TryServeAsync(context, NeverNext, store, Options(), counters);
            Assert.Equal(fixture.Frame, ((MemoryStream)context.Response.Body).ToArray());
            Assert.Equal(1, counters.Snapshot().LastGoodHit);
        }
        finally
        {
            Drop(store);
        }
        await fixture.Owner.Drained;
        Assert.Equal(0, fixture.Ledger.Snapshot().Used["payload"]);
    }

    [Fact]
    public async Task SoftRefreshKeepsThePinnedRealOwnerUntilOriginalWindowExpires()
    {
        using var first = new Fixture();
        using var second = new Fixture(2, clock: first.Clock);
        var store = Store(first.Clock, TimeSpan.FromSeconds(2));
        store.Publish(first.Snapshot);
        first.Owner.Close();
        try
        {
            first.Clock.Advance(TimeSpan.FromMilliseconds(500));
            store.PublishSoftRefresh(second.Snapshot);
            Assert.Same(first.Snapshot, store.StickySnapshotForTests);
            DefaultHttpContext pinned = Context();
            await Serve(pinned, store);
            Assert.Equal(first.Frame, ((MemoryStream)pinned.Response.Body).ToArray());
            Assert.False(first.Owner.Drained.IsCompleted);
            first.Clock.Advance(TimeSpan.FromSeconds(2));
            DefaultHttpContext fresh = Context();
            await Serve(fresh, store);
            Assert.Equal(second.Frame, ((MemoryStream)fresh.Response.Body).ToArray());
            await first.Owner.Drained.WaitAsync(TimeSpan.FromSeconds(30));
            Assert.Equal(0, first.Ledger.Snapshot().Used["payload"]);
        }
        finally
        {
            Drop(store);
        }
    }

    [Fact]
    public async Task SharedHoldBudgetRejectsBeforeBodyOrEndpointWithoutReleasingPublication()
    {
        using var fixture = new Fixture(maximumHolds: 1);
        var store = Store(fixture.Clock);
        try
        {
            store.Publish(fixture.Snapshot);
            DefaultHttpContext context = Context();
            await Serve(context, store);
            Assert.Equal(503, context.Response.StatusCode);
            Assert.Equal(0, context.Response.Body.Length);
            Assert.Equal(1, fixture.Owner.Snapshot().Readers);
            Assert.Equal(fixture.Frame.Length, fixture.Ledger.Snapshot().Used["payload"]);
        }
        finally
        {
            Drop(store);
        }
    }

    [Theory]
    [InlineData("/api/binary/admin/users", false)]
    [InlineData("/api/binary/article/42.aeds", true)]
    public async Task SensitiveAndCredentialBypassDoesNotSpendTheOnlySharedHold(string path, bool credential)
    {
        using var fixture = new Fixture(maximumHolds: 1);
        var store = Store(fixture.Clock);
        bool nextCalled = false;
        try
        {
            store.Publish(fixture.Snapshot);
            DefaultHttpContext context = Context(path);
            if (credential)
            {
                context.Request.Headers.Authorization = "Bearer unit-credential";
            }
            await PublicHotReadFastPath.TryServeAsync(context, _ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            }, store, Options(), new PublicHotReadCounters());
            Assert.True(nextCalled);
            Assert.Equal(0, context.Response.Body.Length);
            Assert.Equal(1, fixture.Owner.Snapshot().Readers);
        }
        finally
        {
            Drop(store);
        }
    }

    [Theory]
    [InlineData("empty")]
    [InlineData("future")]
    [InlineData("version")]
    public async Task OriginalPublicationRejectionLeavesCurrentAndCallerCleanupIntact(string invalid)
    {
        using var current = new Fixture();
        PublicHotReadPublicationEvidence evidence = PublicHotReadPublicationEvidence.CreateVerified(2, current.Clock.GetUtcNow());
        evidence = invalid switch
        {
            "empty" => PublicHotReadPublicationEvidence.Empty,
            "future" => evidence with { VisibilityCutoffUtc = current.Clock.GetUtcNow().AddSeconds(1) },
            _ => evidence with { SourceVersion = 3 }
        };
        using var candidate = new Fixture(2, evidence: evidence, clock: current.Clock);
        var store = Store(current.Clock);
        try
        {
            store.Publish(current.Snapshot);
            candidate.Owner.Close();
            Assert.Throws<InvalidOperationException>(() => store.Publish(candidate.Snapshot));
            Assert.Same(current.Snapshot, store.Current);
            Assert.False(candidate.Owner.Drained.IsCompleted);
            candidate.Snapshot.DisposeUnpublishedHostOwnership();
            await candidate.Owner.Drained;
            Assert.Equal(0, candidate.Ledger.Snapshot().Used["payload"]);
        }
        finally
        {
            Drop(store);
        }
    }

    [Fact]
    public async Task DistributedCopiesShareRealReadsAndReleaseEveryIntermediateHold()
    {
        using var fixture = new Fixture(maximumHolds: 3);
        var store = Store(fixture.Clock);
        try
        {
            store.Publish(fixture.Snapshot);
            Assert.Equal(2, store.ApplyDistributedFragments(["taxonomy:category", "article:42"]));
            Assert.Equal(3, store.Current.Version);
            Assert.False(store.Current.CategoryFrameReady);
            Assert.False(store.Current.TryGetArticle(42, out _));
            Assert.Equal(1, fixture.Owner.Snapshot().Readers);
            Assert.Single(fixture.Ledger.Allocations());
            Assert.Throws<InvalidOperationException>(() => fixture.Snapshot.DisposeUnpublishedHostOwnership());
            Drop(store);
            fixture.Owner.Close();
            await fixture.Owner.Drained.WaitAsync(TimeSpan.FromSeconds(30));
            Assert.Equal(0, fixture.Ledger.Snapshot().Used["payload"]);
        }
        finally
        {
            Drop(store);
        }
    }

    [Fact]
    public async Task InterruptedFragmentReturnsItsUnpublishedCloneBeforeTheNextRead()
    {
        using var fixture = new Fixture(maximumHolds: 2);
        var store = Store(fixture.Clock);
        try
        {
            store.Publish(fixture.Snapshot);
            Assert.Throws<InvalidDataException>(() => store.ApplyDistributedFragments(["taxonomy:category", "unsupported:unit"]));
            Assert.Same(fixture.Snapshot, store.Current);
            DefaultHttpContext context = Context();
            await Serve(context, store);
            Assert.Equal(200, context.Response.StatusCode);
            Assert.Equal(fixture.Frame, ((MemoryStream)context.Response.Body).ToArray());
        }
        finally
        {
            Drop(store);
        }
    }

    [Fact]
    public async Task RepeatedPublishUsesOneSuppliedReadAndReturnsItOnce()
    {
        using var fixture = new Fixture();
        var store = Store(fixture.Clock);
        store.Publish(fixture.Snapshot);
        store.Publish(fixture.Snapshot);
        fixture.Owner.Close();
        Assert.Equal(1, fixture.Owner.Snapshot().Readers);
        Assert.Single(fixture.Ledger.Allocations());
        Drop(store);
        Drop(store);
        await fixture.Owner.Drained;
        Assert.Single(fixture.Ledger.EventWindow().Events, entry => entry.Kind == "allocation-released");
    }

    [Fact]
    public void AnotherStoreCannotConsumeTheAlreadyTransferredSnapshot()
    {
        using var fixture = new Fixture();
        var first = Store(fixture.Clock);
        var second = Store(fixture.Clock);
        try
        {
            first.Publish(fixture.Snapshot);
            Assert.Throws<InvalidOperationException>(() => second.Publish(fixture.Snapshot));
            Assert.Same(PublicHotReadSnapshot.Empty, second.Current);
            Assert.Same(fixture.Snapshot, first.Current);
        }
        finally
        {
            Drop(first);
            Drop(second);
        }
    }

    [Fact]
    public void OrdinaryLeaseInputMustMatchTheExistingOpaqueRepresentation()
    {
        using var first = new Fixture();
        using var second = new Fixture(2, clock: first.Clock);
        Assert.Throws<ArgumentException>(() => first.Prepared.WithHostReadLeases([second.Lease], 8));
        Assert.True(first.Lease.Memory.Span.SequenceEqual(first.Frame));
        Assert.True(second.Lease.Memory.Span.SequenceEqual(second.Frame));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    public void InvalidSharedBoundDoesNotConsumeTheCallerLease(int limit)
    {
        using var fixture = new Fixture();
        Assert.Throws<ArgumentOutOfRangeException>(() => fixture.Prepared.WithHostReadLeases([fixture.Lease], limit));
        Assert.True(fixture.Lease.Memory.Span.SequenceEqual(fixture.Frame));
        Assert.Equal(1, fixture.Owner.Snapshot().Readers);
    }

    [Fact]
    public async Task UnpublishedSnapshotCleanupIsIdempotentWithoutReturningLiveSiblingData()
    {
        using var fixture = new Fixture(maximumHolds: 2);
        PublicHotReadSnapshot sibling = fixture.Snapshot.WithoutCategory();
        fixture.Owner.Close();
        fixture.Snapshot.DisposeUnpublishedHostOwnership();
        fixture.Snapshot.DisposeUnpublishedHostOwnership();
        Assert.False(fixture.Owner.Drained.IsCompleted);
        Assert.True(sibling.TryGetArticle(42, out PublicBinaryArtifact artifact));
        Assert.True(artifact.Frame.Span.SequenceEqual(fixture.Frame));
        sibling.DisposeUnpublishedHostOwnership();
        await fixture.Owner.Drained;
        Assert.Equal(0, fixture.Ledger.Snapshot().Used["payload"]);
    }

    [Fact]
    public void OwnedAttachmentRejectsPrecompressionBeforeArrayOnlySchemaValidation()
    {
        using var fixture = new Fixture();
        PublicBinaryArtifact compressed = fixture.Artifact with
        {
            BrotliFrame = new byte[] { 1 },
            BrotliETag = "unit"
        };
        var prepared = new PublicHotReadSnapshot(1,
            new Dictionary<int, PublicBinaryArtifact> { [42] = compressed }.ToFrozenDictionary(),
            FrozenDictionary<PublicListKey, PublicBinaryArtifact>.Empty, default, default,
            FrozenDictionary<string, PublicHtmlArtifact>.Empty, fixture.Prepared.PublicationEvidence);
        Assert.Throws<NotSupportedException>(() => prepared.WithHostReadLeases([fixture.Lease], 8));
        Assert.True(fixture.Lease.Memory.Span.SequenceEqual(fixture.Frame));
    }

    [Fact]
    public async Task ExpiredOwnedStickyIsReleasedWhenTheNewCurrentUsesOriginalArrays()
    {
        using var fixture = new Fixture();
        var store = Store(fixture.Clock, TimeSpan.FromSeconds(2));
        byte[] frame = new AedsEncoder().Encode(AedsFrameType.ArticleDetail, new byte[] { 2 });
        var next = new PublicHotReadSnapshot(2,
            new Dictionary<int, PublicBinaryArtifact>
            {
                [42] = new(frame, "unit-array", "public,max-age=17", 2, AedsFrameType.ArticleDetail)
            }.ToFrozenDictionary(), FrozenDictionary<PublicListKey, PublicBinaryArtifact>.Empty, default, default,
            FrozenDictionary<string, PublicHtmlArtifact>.Empty,
            PublicHotReadPublicationEvidence.CreateVerified(2, fixture.Clock.GetUtcNow()));
        try
        {
            store.Publish(fixture.Snapshot);
            fixture.Owner.Close();
            store.PublishSoftRefresh(next);
            Assert.False(fixture.Owner.Drained.IsCompleted);
            fixture.Clock.Advance(TimeSpan.FromSeconds(3));
            DefaultHttpContext context = Context();
            await Serve(context, store);
            Assert.Equal(frame, ((MemoryStream)context.Response.Body).ToArray());
            await fixture.Owner.Drained.WaitAsync(TimeSpan.FromSeconds(30));
        }
        finally
        {
            Drop(store);
        }
    }

    private static Task Serve(DefaultHttpContext context, PublicHotReadStore store)
        => PublicHotReadFastPath.TryServeAsync(context, NeverNext, store, Options(), new PublicHotReadCounters());

    private static Task NeverNext(HttpContext context)
        => throw new InvalidOperationException("Managed fixture must not enter the endpoint.");

    private static void Drop(PublicHotReadStore store)
        => store.InvalidateDistributedSnapshot("unit-drop", PublicHotReadInvalidationPolicy.DropToEmpty);

    private static PublicHotReadOptions Options() => new()
    {
        EnablePrecompressedBinaryVariants = false,
        VersionStickinessWindow = TimeSpan.Zero,
        FailOpenWhenNotReady = false
    };

    private static PublicHotReadStore Store(MutableClock clock, TimeSpan? stickiness = null)
    {
        PublicHotReadOptions options = Options();
        options.VersionStickinessWindow = stickiness ?? TimeSpan.Zero;
        return new(options: Microsoft.Extensions.Options.Options.Create(options), timeProvider: clock);
    }

    private static DefaultHttpContext Context(string path = "/api/binary/article/42.aeds", string method = "GET")
    {
        var context = new DefaultHttpContext();
        context.Request.Path = path;
        context.Request.Method = method;
        context.Response.Body = new MemoryStream();
        return context;
    }

    private static DefaultHttpContext PipeContext(PipeWriter writer)
    {
        DefaultHttpContext context = Context();
        context.Features.Set<IHttpResponseBodyFeature>(new PipeBodyFeature(writer));
        return context;
    }

    private static async Task ReadAndFinish(Pipe pipe, Task operation, byte[] expected)
    {
        ReadResult result = await pipe.Reader.ReadAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(30));
        Assert.Equal(expected, result.Buffer.ToArray());
        pipe.Reader.AdvanceTo(result.Buffer.End);
        await operation.WaitAsync(TimeSpan.FromSeconds(30));
    }

    private static async Task FinishPipe(Pipe pipe, Task operation)
    {
        await pipe.Reader.CompleteAsync();
        await pipe.Writer.CompleteAsync();
        try
        {
            await operation.WaitAsync(TimeSpan.FromSeconds(30));
        }
        catch (OperationCanceledException)
        {
        }
    }

    private sealed class Fixture : IDisposable
    {
        public Fixture(long version = 1, int maximumHolds = 8, PublicHotReadPublicationEvidence? evidence = null,
            MutableClock? clock = null)
        {
            Clock = clock ?? new MutableClock();
            Frame = new AedsEncoder().Encode(AedsFrameType.ArticleDetail, new byte[] { checked((byte)version) });
            var payload = new ResourceDomainId(Guid.NewGuid());
            var operations = new ResourceDomainId(Guid.NewGuid());
            var topology = new MemoryResourceTopology([
                new(payload, "payload", MemoryResourceUnit.Bytes, null),
                new(operations, "operations", MemoryResourceUnit.OperationSlots, null)
            ]);
            Ledger = new MemoryReservationCoordinator(topology, [
                new(payload, MemoryResourceUnit.Bytes, Frame.Length),
                new(operations, MemoryResourceUnit.OperationSlots, 1)
            ], policyRevision: 1, entryLimit: 16, eventCapacity: 64);
            Owner = ManagedMemoryBacking.TryCreate(Ledger, payload, operations,
                new(new(Guid.NewGuid()), new(checked((ulong)version)), new(Guid.NewGuid())), new(1), new(1),
                Frame, Frame.Length, 8).Value ?? throw new InvalidOperationException("Managed fixture admission failed.");
            Lease = Owner.TryAcquireHostView(Owner.Location).Value ?? throw new InvalidOperationException("Managed fixture read failed.");
            Artifact = PublicHotReadBinaryArtifactFactory.FromHostReadLease(Lease, AedsFrameType.ArticleDetail,
                "public,max-age=17", version, Options());
            PublicBinaryArtifact category = PublicHotReadBinaryArtifactFactory.FromPayload(new AedsEncoder(),
                AedsFrameType.CategoryList, [], "public,max-age=17", version, Options());
            Prepared = new PublicHotReadSnapshot(version,
                new Dictionary<int, PublicBinaryArtifact> { [42] = Artifact }.ToFrozenDictionary(),
                FrozenDictionary<PublicListKey, PublicBinaryArtifact>.Empty, category, default,
                FrozenDictionary<string, PublicHtmlArtifact>.Empty,
                evidence ?? PublicHotReadPublicationEvidence.CreateVerified(version, Clock.GetUtcNow()));
            Snapshot = Prepared.WithHostReadLeases([Lease], maximumHolds);
        }
        public MutableClock Clock
        {
            get;
        }
        public byte[] Frame
        {
            get;
        }
        public ManagedMemoryBacking Owner
        {
            get;
        }
        public IMemoryHostReadLease Lease
        {
            get;
        }
        public MemoryReservationCoordinator Ledger
        {
            get;
        }
        public PublicBinaryArtifact Artifact
        {
            get;
        }
        public PublicHotReadSnapshot Prepared
        {
            get;
        }
        public PublicHotReadSnapshot Snapshot
        {
            get;
        }
        public void Dispose()
        {
            Snapshot.DisposeUnclaimedHostOwnership();
            Owner.Dispose();
        }
    }

    private sealed class MutableClock : TimeProvider
    {
        private DateTimeOffset _now = DateTimeOffset.Parse("2026-10-09T10:00:00Z");
        public override DateTimeOffset GetUtcNow() => _now;
        public void Advance(TimeSpan amount) => _now += amount;
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
