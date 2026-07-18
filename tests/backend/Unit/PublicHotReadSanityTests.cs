using System.Collections.Frozen;
using System.Runtime.InteropServices;

using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Options;
namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicHotReadSanityTests
{
    private static readonly DateTimeOffset s_now = DateTimeOffset.Parse("2026-07-15T12:00:00Z");

    [Fact]
    public void Publish_RejectsCandidateWhoseSealedPayloadWasTamperedAfterBuild()
    {
        byte[] frame = Frame([1, 2, 3, 4]);
        PublicHotReadSnapshot candidate = Snapshot(frame, s_now);
        frame[2] ^= 0xff;
        var store = Store(new MutableTimeProvider(s_now));

        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() => store.Publish(candidate));

        Assert.Contains("snapshot integrity or schema invalid", error.Message, StringComparison.Ordinal);
        Assert.Same(PublicHotReadSnapshot.Empty, store.Current);
        Assert.False(store.IsReady);
    }

    [Fact]
    public async Task Request_TamperedPublishedPayloadFallsBackToCanonicalEndpointPipeline()
    {
        byte[] frame = Frame([1, 2, 3, 4]);
        var clock = new MutableTimeProvider(s_now);
        PublicHotReadOptions options = SanityOptions();
        var store = new PublicHotReadStore(options: Options.Create(options), timeProvider: clock);
        var counters = new PublicHotReadCounters(Options.Create(options));
        store.Publish(Snapshot(frame, s_now));
        frame[0] ^= 0xff;
        DefaultHttpContext context = Context("/api/binary/article/42.aeds");
        bool nextCalled = false;

        await PublicHotReadFastPath.TryServeAsync(
            context,
            _ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            },
            store,
            options,
            counters);

        Assert.True(nextCalled);
        Assert.Equal(0, context.Response.Body.Length);
        Assert.Equal(1, counters.Snapshot().SanityFallback);
    }

    [Fact]
    public async Task Request_StaleSnapshotFallsBackWithoutServingOldBytes()
    {
        var clock = new MutableTimeProvider(s_now);
        PublicHotReadOptions options = SanityOptions();
        options.MaxSnapshotAge = TimeSpan.FromMinutes(1);
        var store = new PublicHotReadStore(options: Options.Create(options), timeProvider: clock);
        var counters = new PublicHotReadCounters(Options.Create(options));
        store.Publish(Snapshot(Frame([1, 2, 3, 4]), s_now));
        clock.Advance(TimeSpan.FromMinutes(2));
        DefaultHttpContext context = Context("/api/binary/article/42.aeds");
        bool nextCalled = false;

        await PublicHotReadFastPath.TryServeAsync(
            context,
            _ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            },
            store,
            options,
            counters);

        Assert.True(nextCalled);
        Assert.Equal(0, context.Response.Body.Length);
        Assert.Equal(1, counters.Snapshot().SanityFallback);
    }

    [Fact]
    public void RefreshSchedule_BecomesDueAtHalfOfConfiguredMaximumAge()
    {
        var clock = new MutableTimeProvider(s_now);
        PublicHotReadOptions options = SanityOptions();
        options.MaxSnapshotAge = TimeSpan.FromMinutes(4);
        var store = new PublicHotReadStore(options: Options.Create(options), timeProvider: clock);
        store.Publish(Snapshot(Frame([1, 2, 3, 4]), s_now));

        Assert.Equal(TimeSpan.FromMinutes(2), store.SnapshotRefreshInterval);
        Assert.False(store.ShouldRefreshSnapshot());

        clock.Advance(TimeSpan.FromMinutes(2));

        Assert.True(store.ShouldRefreshSnapshot());
    }

    [Fact]
    public void Publish_OversizedCandidateStillFailsBeforeAtomicSwap()
    {
        PublicHotReadOptions options = SanityOptions();
        options.MaxRawBytes = 1;
        var store = new PublicHotReadStore(
            options: Options.Create(options),
            timeProvider: new MutableTimeProvider(s_now));

        InvalidOperationException error = Assert.Throws<InvalidOperationException>(
            () => store.Publish(Snapshot([1, 2, 3, 4], s_now)));

        Assert.Contains("raw:", error.Message, StringComparison.Ordinal);
        Assert.Same(PublicHotReadSnapshot.Empty, store.Current);
    }

    [Fact]
    public void Publish_InvalidAedsSchemaFailsClosedEvenWhenPayloadHmacIsValid()
    {
        var store = Store(new MutableTimeProvider(s_now));

        InvalidOperationException error = Assert.Throws<InvalidOperationException>(
            () => store.Publish(Snapshot([1, 2, 3, 4], s_now)));

        Assert.Contains("integrity or schema invalid", error.Message, StringComparison.Ordinal);
        Assert.False(store.IsReady);
    }

    [Fact]
    public void Publish_FutureVisibilityCutoffFailsClosed()
    {
        var store = Store(new MutableTimeProvider(s_now));

        InvalidOperationException error = Assert.Throws<InvalidOperationException>(
            () => store.Publish(Snapshot(Frame([1]), s_now.AddTicks(1))));

        Assert.Contains("cutoff is in the future", error.Message, StringComparison.Ordinal);
        Assert.False(store.IsReady);
    }

    [Fact]
    public void Publish_CutoffExactlyAtMaximumAgeIsAccepted()
    {
        PublicHotReadOptions options = SanityOptions();
        var store = new PublicHotReadStore(
            options: Options.Create(options),
            timeProvider: new MutableTimeProvider(s_now));

        store.Publish(Snapshot(Frame([1]), s_now - options.MaxSnapshotAge));

        Assert.True(store.IsReady);
    }

    [Fact]
    public void Publish_RebindingSealedArtifactToAnotherRouteFailsMetadataHmac()
    {
        PublicHotReadSnapshot original = Snapshot(Frame([1, 2, 3]), s_now);
        Assert.True(original.TryGetArticle(42, out PublicBinaryArtifact sealedArtifact));
        var rebound = new PublicHotReadSnapshot(
            1,
            new Dictionary<int, PublicBinaryArtifact> { [43] = sealedArtifact }.ToFrozenDictionary(),
            FrozenDictionary<PublicListKey, PublicBinaryArtifact>.Empty,
            default,
            default,
            FrozenDictionary<string, PublicHtmlArtifact>.Empty,
            PublicHotReadPublicationEvidence.CreateVerified(1, s_now));
        var store = Store(new MutableTimeProvider(s_now));

        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() => store.Publish(rebound));

        Assert.Contains("integrity or schema invalid", error.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("br")]
    [InlineData("gzip")]
    public async Task Request_TamperedCompressedVariantFallsBackWithoutServingBytes(string encoding)
    {
        PublicHotReadOptions options = SanityOptions();
        options.MinPrecompressedFrameBytes = 1;
        options.MinCompressionSavingsPercent = 0;
        options.MinResidentVariantClientSharePercent = 0;
        PublicBinaryArtifact artifact = PublicHotReadBinaryArtifactFactory.FromPayload(
            new AedsEncoder(),
            AedsFrameType.ArticleDetail,
            Enumerable.Repeat((byte)'a', 4096).ToArray(),
            "public,max-age=60",
            1,
            options);
        var store = new PublicHotReadStore(
            options: Options.Create(options),
            timeProvider: new MutableTimeProvider(s_now));
        store.Publish(Snapshot(artifact, s_now));
        Assert.True(store.Current.TryGetArticle(42, out PublicBinaryArtifact published));
        ReadOnlyMemory<byte> selected = encoding == "br" ? published.BrotliFrame : published.GzipFrame;
        Assert.True(MemoryMarshal.TryGetArray(selected, out ArraySegment<byte> segment));
        segment.Array![segment.Offset] ^= 0xff;
        DefaultHttpContext context = Context("/api/binary/article/42.aeds");
        context.Request.Headers.AcceptEncoding = encoding;
        bool nextCalled = false;
        var counters = new PublicHotReadCounters(Options.Create(options));

        await PublicHotReadFastPath.TryServeAsync(
            context,
            _ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            },
            store,
            options,
            counters);

        Assert.True(nextCalled);
        Assert.Equal(0, context.Response.Body.Length);
        Assert.Equal(1, counters.Snapshot().SanityFallback);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Request_TamperedHtmlBodyOrNonceTemplateFallsBack(bool tamperTemplate)
    {
        PublicHotReadOptions options = SanityOptions();
        var store = new PublicHotReadStore(
            options: Options.Create(options),
            timeProvider: new MutableTimeProvider(s_now));
        store.Publish(EmptySnapshot(s_now));
        PublicHtmlArtifact artifact = PublicHotReadHtmlArtifactFactory.FromHtml(
            "<!doctype html><html><head></head><body><script>ok()</script></body></html>",
            "public,max-age=60");
        store.PublishHtml("home", PublicPageId.Home, artifact);
        string routeKey = PublicHotReadRouteKeys.HtmlPath("home");
        Assert.True(store.Current.TryGetHtml(routeKey, out PublicHtmlArtifact published));
        ReadOnlyMemory<byte> selected = tamperTemplate
            ? Assert.IsType<CspNonceUtf8Template>(published.CspNonceTemplate).IntegrityBytes
            : published.Bytes;
        Assert.True(MemoryMarshal.TryGetArray(selected, out ArraySegment<byte> segment));
        segment.Array![segment.Offset] ^= 0xff;
        DefaultHttpContext context = Context("/");
        context.Request.Headers.Accept = "text/html";
        bool nextCalled = false;
        var counters = new PublicHotReadCounters(Options.Create(options));

        await PublicHotReadFastPath.TryServeAsync(
            context,
            _ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            },
            store,
            options,
            counters);

        Assert.True(nextCalled);
        Assert.Equal(0, context.Response.Body.Length);
        Assert.Equal(1, counters.Snapshot().SanityFallback);
    }

    [Fact]
    public async Task TransitioningArticleTombstoneWinsBeforeFastPathCanReadSnapshot()
    {
        var registry = new PublicArtifactRevocationRegistry();
        registry.Apply(new PublicArtifactTombstone(42, 7, s_now.ToUnixTimeMilliseconds()));
        DefaultHttpContext context = Context("/api/binary/article/42.aeds");
        bool nextCalled = false;

        await PublicArtifactRevocationMiddleware.TryHandleAsync(
            context,
            _ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            },
            registry);

        Assert.False(nextCalled);
        Assert.Equal(StatusCodes.Status410Gone, context.Response.StatusCode);
        Assert.Equal("no-store, no-cache, must-revalidate", context.Response.Headers.CacheControl);
        Assert.Equal("g7", context.Response.Headers["X-Fsus-Revoked"]);
    }

    [Fact]
    public async Task RevocationPipeline_BlocksOldSnapshotUntilNewGenerationIsPublishedAndCleared()
    {
        byte[] oldFrame = Frame([1]);
        byte[] newFrame = Frame([2]);
        PublicHotReadOptions options = SanityOptions();
        var store = new PublicHotReadStore(
            options: Options.Create(options),
            timeProvider: new MutableTimeProvider(s_now));
        store.Publish(Snapshot(oldFrame, s_now, version: 1));
        var registry = new PublicArtifactRevocationRegistry();
        var tombstone = new PublicArtifactTombstone(42, 7, s_now.ToUnixTimeMilliseconds(), PurgeConfirmed: true);
        registry.Apply(tombstone);
        RequestDelegate pipeline = context => PublicArtifactRevocationMiddleware.TryHandleAsync(
            context,
            next => PublicHotReadFastPath.TryServeAsync(
                next,
                _ => throw new InvalidOperationException("canonical endpoint should not run"),
                store,
                options,
                new PublicHotReadCounters(Options.Create(options))),
            registry);
        DefaultHttpContext transitioning = Context("/api/binary/article/42.aeds");

        await pipeline(transitioning);

        Assert.Equal(StatusCodes.Status410Gone, transitioning.Response.StatusCode);
        Assert.Empty(((MemoryStream)transitioning.Response.Body).ToArray());

        store.Publish(Snapshot(newFrame, s_now, version: 2));
        registry.Clear(tombstone);
        DefaultHttpContext converged = Context("/api/binary/article/42.aeds");

        await pipeline(converged);

        Assert.Equal(StatusCodes.Status200OK, converged.Response.StatusCode);
        Assert.Equal(newFrame, ((MemoryStream)converged.Response.Body).ToArray());
        Assert.NotEqual(oldFrame, ((MemoryStream)converged.Response.Body).ToArray());
    }

    private static PublicHotReadStore Store(TimeProvider clock)
        => new(options: Options.Create(SanityOptions()), timeProvider: clock);

    private static byte[] Frame(byte[] payload)
        => new AedsEncoder().Encode(AedsFrameType.ArticleDetail, payload);

    private static PublicHotReadSnapshot Snapshot(byte[] frame, DateTimeOffset cutoff, long version = 1)
        => Snapshot(
            new PublicBinaryArtifact(
                frame,
                "\"article-42\"",
                "public,max-age=60",
                version,
                AedsFrameType.ArticleDetail),
            cutoff,
            version);

    private static PublicHotReadSnapshot Snapshot(
        PublicBinaryArtifact artifact,
        DateTimeOffset cutoff,
        long version = 1)
        => new(
            version,
            new Dictionary<int, PublicBinaryArtifact>
            {
                [42] = artifact
            }.ToFrozenDictionary(),
            FrozenDictionary<PublicListKey, PublicBinaryArtifact>.Empty,
            default,
            default,
            FrozenDictionary<string, PublicHtmlArtifact>.Empty,
            PublicHotReadPublicationEvidence.CreateVerified(version, cutoff));

    private static PublicHotReadSnapshot EmptySnapshot(DateTimeOffset cutoff)
        => new(
            1,
            FrozenDictionary<int, PublicBinaryArtifact>.Empty,
            FrozenDictionary<PublicListKey, PublicBinaryArtifact>.Empty,
            default,
            default,
            FrozenDictionary<string, PublicHtmlArtifact>.Empty,
            PublicHotReadPublicationEvidence.CreateVerified(1, cutoff));

    private static PublicHotReadOptions SanityOptions()
        => new()
        {
            MaxResidentBytes = 1_000_000,
            MaxRawBytes = 1_000_000,
            MaxCompressedBytes = 1_000_000,
            MaxHtmlBytes = 1_000_000,
            MaxSnapshotOverlapBytes = 2_000_000,
            MaxArticleResidentBytes = 1_000_000,
            MaxArtifactObjects = 10_000,
            MaxRetiringSnapshots = 4,
            MaxRetiringBytes = 1_000_000,
            RetiringSnapshotDeadline = TimeSpan.FromMinutes(5),
            MaxSnapshotAge = TimeSpan.FromMinutes(5)
        };

    private static DefaultHttpContext Context(string path)
    {
        var context = new DefaultHttpContext();
        context.Request.Method = HttpMethods.Get;
        context.Request.Path = path;
        context.Response.Body = new MemoryStream();
        return context;
    }

    private sealed class MutableTimeProvider(DateTimeOffset now) : TimeProvider
    {
        private DateTimeOffset _now = now;

        public override DateTimeOffset GetUtcNow() => _now;

        internal void Advance(TimeSpan duration) => _now += duration;
    }
}
