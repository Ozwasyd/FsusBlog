using System.Collections.Frozen;

using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Options;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicHotReadVersionStickinessTests
{
    private static readonly DateTimeOffset s_now = DateTimeOffset.Parse("2026-07-15T12:00:00Z");
    private const string Key = "article:42";

    [Fact]
    public void DefaultWindow_IsShortAndClampedToSnapshotAge()
    {
        Assert.Equal(TimeSpan.FromSeconds(2), PublicHotReadVersionStickiness.DefaultWindow);
        Assert.Equal(TimeSpan.FromSeconds(2), PublicHotReadVersionStickiness.ResolveWindow(
            TimeSpan.FromSeconds(30),
            TimeSpan.FromSeconds(2)));
        Assert.Equal(TimeSpan.Zero, PublicHotReadVersionStickiness.ResolveWindow(TimeSpan.Zero, TimeSpan.FromMinutes(5)));
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            PublicHotReadVersionStickiness.ResolveWindow(TimeSpan.FromSeconds(-1), TimeSpan.FromMinutes(5)));

        var clock = new MutableTimeProvider(s_now);
        var store = new PublicHotReadStore(options: Options.Create(StickinessOptions()), timeProvider: clock);
        Assert.Equal(TimeSpan.FromSeconds(2), store.VersionStickinessWindowForTests);
    }

    [Fact]
    public void Select_SameKeyDoesNotFlapAdjacentGenerationsAcrossTiersInsideWindow()
    {
        PublicHotReadVersionPin pin = new(Key, 1, "\"v1\"", s_now.AddSeconds(2));
        PublicHotReadVersionCandidate[] candidates =
        [
            new(Key, 2, "\"v2\"", PublicHotReadCacheTier.L0),
            new(Key, 1, "\"v1\"", PublicHotReadCacheTier.L1),
            new(Key, 2, "\"v2\"", PublicHotReadCacheTier.L2),
            new(Key, 1, "\"v1\"", PublicHotReadCacheTier.Endpoint)
        ];

        PublicHotReadVersionSelection selected = PublicHotReadVersionStickiness.Select(
            Key,
            pin,
            candidates,
            s_now.AddMilliseconds(500),
            TimeSpan.FromSeconds(2),
            PublicHotReadPublishCause.SoftRefresh);

        Assert.True(selected.Serve);
        Assert.Equal(1, selected.Generation);
        Assert.Equal("\"v1\"", selected.ETag);
        Assert.Equal(PublicHotReadCacheTier.L1, selected.Tier);
        Assert.Equal("sticky", selected.Reason);
        Assert.Equal(pin, selected.NextPin);
    }

    [Fact]
    public void Select_PrefersL0WhenPinnedGenerationIsPresentOnEveryTier()
    {
        PublicHotReadVersionPin pin = new(Key, 4, "\"v4\"", s_now.AddSeconds(2));
        PublicHotReadVersionCandidate[] candidates =
        [
            new(Key, 4, "\"v4\"", PublicHotReadCacheTier.Endpoint),
            new(Key, 4, "\"v4\"", PublicHotReadCacheTier.L2),
            new(Key, 4, "\"v4\"", PublicHotReadCacheTier.L1),
            new(Key, 4, "\"v4\"", PublicHotReadCacheTier.L0),
            new(Key, 5, "\"v5\"", PublicHotReadCacheTier.L0)
        ];

        PublicHotReadVersionSelection selected = PublicHotReadVersionStickiness.Select(
            Key,
            pin,
            candidates,
            s_now,
            TimeSpan.FromSeconds(2),
            PublicHotReadPublishCause.SoftRefresh);

        Assert.Equal(4, selected.Generation);
        Assert.Equal(PublicHotReadCacheTier.L0, selected.Tier);
        Assert.Equal("sticky", selected.Reason);
    }

    [Fact]
    public void Select_AfterWindowFreshnessAdvancesToLatestTier()
    {
        PublicHotReadVersionPin pin = new(Key, 1, "\"v1\"", s_now.AddSeconds(2));
        PublicHotReadVersionCandidate[] candidates =
        [
            new(Key, 1, "\"v1\"", PublicHotReadCacheTier.L1),
            new(Key, 2, "\"v2\"", PublicHotReadCacheTier.L0)
        ];

        PublicHotReadVersionSelection selected = PublicHotReadVersionStickiness.Select(
            Key,
            pin,
            candidates,
            s_now.AddSeconds(2),
            TimeSpan.FromSeconds(2),
            PublicHotReadPublishCause.SoftRefresh);

        Assert.True(selected.Serve);
        Assert.Equal(2, selected.Generation);
        Assert.Equal("\"v2\"", selected.ETag);
        Assert.Equal(PublicHotReadCacheTier.L0, selected.Tier);
        Assert.Equal("expired", selected.Reason);
        Assert.Equal(2, selected.NextPin.Generation);
        Assert.True(selected.NextPin.StickyUntilUtc > s_now.AddSeconds(2));
    }

    [Fact]
    public void Select_ContentPublishAdvancesImmediately()
    {
        PublicHotReadVersionPin pin = new(Key, 1, "\"v1\"", s_now.AddSeconds(2));
        PublicHotReadVersionCandidate[] candidates =
        [
            new(Key, 1, "\"v1\"", PublicHotReadCacheTier.L0),
            new(Key, 2, "\"v2\"", PublicHotReadCacheTier.L0)
        ];

        PublicHotReadVersionSelection selected = PublicHotReadVersionStickiness.Select(
            Key,
            pin,
            candidates,
            s_now.AddMilliseconds(10),
            TimeSpan.FromSeconds(2),
            PublicHotReadPublishCause.Content);

        Assert.True(selected.Serve);
        Assert.Equal(2, selected.Generation);
        Assert.Equal("\"v2\"", selected.ETag);
        Assert.Equal("publish", selected.Reason);
        Assert.Equal(2, selected.NextPin.Generation);
    }

    [Fact]
    public void Select_DoesNotFlapToAdjacentTierWhenPinnedGenerationIsMissing()
    {
        PublicHotReadVersionPin pin = new(Key, 1, "\"v1\"", s_now.AddSeconds(2));
        PublicHotReadVersionCandidate[] candidates =
        [
            new(Key, 2, "\"v2\"", PublicHotReadCacheTier.L1),
            new(Key, 2, "\"v2\"", PublicHotReadCacheTier.Endpoint)
        ];

        PublicHotReadVersionSelection selected = PublicHotReadVersionStickiness.Select(
            Key,
            pin,
            candidates,
            s_now,
            TimeSpan.FromSeconds(2),
            PublicHotReadPublishCause.SoftRefresh);

        Assert.False(selected.Serve);
        Assert.Equal(1, selected.Generation);
        Assert.Equal("sticky-missing", selected.Reason);
        Assert.Equal(pin, selected.NextPin);
    }

    [Fact]
    public void Select_HardInvalidationDoesNotServePinnedGeneration()
    {
        PublicHotReadVersionPin pin = new(Key, 1, "\"v1\"", s_now.AddSeconds(2));
        PublicHotReadVersionCandidate[] candidates =
        [
            new(Key, 1, "\"v1\"", PublicHotReadCacheTier.L0),
            new(Key, 1, "\"v1\"", PublicHotReadCacheTier.L1)
        ];

        PublicHotReadVersionSelection selected = PublicHotReadVersionStickiness.Select(
            Key,
            pin,
            candidates,
            s_now,
            TimeSpan.FromSeconds(2),
            PublicHotReadPublishCause.HardInvalidation);

        Assert.False(selected.Serve);
        Assert.Equal(0, selected.Generation);
        Assert.Equal("hard-invalidation", selected.Reason);
        Assert.Equal(0, selected.NextPin.Generation);
    }

    [Theory]
    [InlineData("last-good", PublicHotArtifactDirtyReason.SoftRefresh, "SoftRefresh")]
    [InlineData("last-good:rebuild-in-flight", PublicHotArtifactDirtyReason.SoftRefresh, "SoftRefresh")]
    [InlineData("sanity-age-refresh", PublicHotArtifactDirtyReason.SoftRefresh, "SoftRefresh")]
    [InlineData("view-projection", PublicHotArtifactDirtyReason.ViewProjection, "SoftRefresh")]
    [InlineData("article-updated", PublicHotArtifactDirtyReason.Content, "Content")]
    [InlineData("last-good+article-updated", PublicHotArtifactDirtyReason.Content | PublicHotArtifactDirtyReason.SoftRefresh, "Content")]
    [InlineData("scheduled-publish", PublicHotArtifactDirtyReason.ScheduledPublish | PublicHotArtifactDirtyReason.Content, "Content")]
    public void Classify_DistinguishesSoftRefreshFromPublish(
        string reason,
        PublicHotArtifactDirtyReason dirtyReason,
        string expected)
    {
        Assert.Equal(
            expected,
            PublicHotReadVersionStickiness.Classify(dirtyReason, reason, currentVersion: 1).ToString());
        Assert.Equal(
            "Content",
            PublicHotReadVersionStickiness.Classify(dirtyReason, reason, currentVersion: 0).ToString());
    }

    [Fact]
    public async Task SoftRefresh_SameClientKeepsPinnedGenerationUntilWindowExpires()
    {
        var clock = new MutableTimeProvider(s_now);
        PublicHotReadOptions options = StickinessOptions();
        var store = new PublicHotReadStore(options: Options.Create(options), timeProvider: clock);
        var counters = new PublicHotReadCounters(Options.Create(options));
        byte[] first = Frame([1, 1, 1]);
        byte[] second = Frame([2, 2, 2]);
        store.Publish(Snapshot(first, "\"v1\"", version: 1));
        store.PublishSoftRefresh(Snapshot(second, "\"v2\"", version: 2));

        Assert.Equal(2, store.Current.Version);
        Assert.Equal(1, store.StickySnapshotForTests.Version);
        Assert.True(store.TryGetRequestSnapshot(out PublicHotReadSnapshot sticky, out string reason));
        Assert.Equal("sticky", reason);
        Assert.Equal(1, sticky.Version);
        Assert.Same(store.StickySnapshotForTests, sticky);

        DefaultHttpContext firstRequest = Context("/api/binary/article/42.aeds");
        DefaultHttpContext secondRequest = Context("/api/binary/article/42.aeds");
        int nextCalled = 0;
        await Serve(firstRequest, store, options, counters, () => nextCalled++);
        await Serve(secondRequest, store, options, counters, () => nextCalled++);

        Assert.Equal(0, nextCalled);
        Assert.Equal(StatusCodes.Status200OK, firstRequest.Response.StatusCode);
        Assert.Equal("\"v1\"", firstRequest.Response.Headers.ETag.ToString());
        Assert.Equal(first, Body(firstRequest));
        Assert.Equal("\"v1\"", secondRequest.Response.Headers.ETag.ToString());
        Assert.Equal(first, Body(secondRequest));
        Assert.Equal(2, counters.Snapshot().LastGoodHit);
        Assert.Equal(0, counters.Snapshot().FreshL0Hit);

        clock.Advance(TimeSpan.FromSeconds(2));
        Assert.True(store.TryGetRequestSnapshot(out PublicHotReadSnapshot advanced, out string advancedReason));
        Assert.Equal("ok", advancedReason);
        Assert.Equal(2, advanced.Version);

        DefaultHttpContext afterWindow = Context("/api/binary/article/42.aeds");
        await Serve(afterWindow, store, options, counters, () => nextCalled++);
        Assert.Equal(0, nextCalled);
        Assert.Equal("\"v2\"", afterWindow.Response.Headers.ETag.ToString());
        Assert.Equal(second, Body(afterWindow));
        Assert.Equal(1, counters.Snapshot().FreshL0Hit);
    }

    [Fact]
    public async Task ContentPublish_AdvancesGenerationImmediatelyInsideWindow()
    {
        var clock = new MutableTimeProvider(s_now);
        PublicHotReadOptions options = StickinessOptions();
        var store = new PublicHotReadStore(options: Options.Create(options), timeProvider: clock);
        var counters = new PublicHotReadCounters(Options.Create(options));
        store.Publish(Snapshot(Frame([1]), "\"v1\"", version: 1));
        byte[] published = Frame([9, 9]);
        store.Publish(Snapshot(published, "\"v2\"", version: 2));

        Assert.True(store.TryGetRequestSnapshot(out PublicHotReadSnapshot snapshot, out string reason));
        Assert.Equal("ok", reason);
        Assert.Equal(2, snapshot.Version);
        Assert.Equal(2, store.StickySnapshotForTests.Version);

        DefaultHttpContext context = Context("/api/binary/article/42.aeds");
        await Serve(context, store, options, counters, () => throw new InvalidOperationException("endpoint"));
        Assert.Equal("\"v2\"", context.Response.Headers.ETag.ToString());
        Assert.Equal(published, Body(context));
        Assert.Equal(1, counters.Snapshot().FreshL0Hit);
        Assert.Equal(0, counters.Snapshot().LastGoodHit);
    }

    [Fact]
    public async Task HardInvalidation_ClearsPinAndDoesNotServeStaleBytes()
    {
        var clock = new MutableTimeProvider(s_now);
        PublicHotReadOptions options = StickinessOptions();
        var store = new PublicHotReadStore(options: Options.Create(options), timeProvider: clock);
        var counters = new PublicHotReadCounters(Options.Create(options));
        byte[] frame = Frame([3, 3, 3]);
        store.Publish(Snapshot(frame, "\"v1\"", version: 1));
        store.PublishSoftRefresh(Snapshot(Frame([4]), "\"v2\"", version: 2));
        Assert.Equal("sticky", StoreReason(store));

        store.InvalidateDistributedSnapshot("content-must-drop", PublicHotReadInvalidationPolicy.DropToEmpty);

        Assert.Equal(0, store.StickySnapshotForTests.Version);
        Assert.False(store.TryGetRequestSnapshot(out PublicHotReadSnapshot after, out string reason));
        Assert.StartsWith("invalidated-drop-to-empty:", reason, StringComparison.Ordinal);
        Assert.Equal(0, after.Version);

        DefaultHttpContext context = Context("/api/binary/article/42.aeds");
        bool nextCalled = false;
        await Serve(context, store, options, counters, () => nextCalled = true);
        Assert.False(nextCalled);
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, context.Response.StatusCode);
        Assert.Equal(0, context.Response.Body.Length);
        Assert.Equal(0, counters.Snapshot().LastGoodHit);
        Assert.Equal(0, counters.Snapshot().FreshL0Hit);
    }

    [Fact]
    public async Task SoftRefresh_KeepsL0HitWhenCurrentGenerationDroppedTheKey()
    {
        var clock = new MutableTimeProvider(s_now);
        PublicHotReadOptions options = StickinessOptions();
        var store = new PublicHotReadStore(options: Options.Create(options), timeProvider: clock);
        var counters = new PublicHotReadCounters(Options.Create(options));
        byte[] frame = Frame([5, 5]);
        store.Publish(Snapshot(frame, "\"v1\"", version: 1));
        store.PublishSoftRefresh(EmptySnapshot(version: 2));

        DefaultHttpContext context = Context("/api/binary/article/42.aeds");
        bool nextCalled = false;
        await Serve(context, store, options, counters, () => nextCalled = true);

        Assert.False(nextCalled);
        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.Equal("\"v1\"", context.Response.Headers.ETag.ToString());
        Assert.Equal(frame, Body(context));

        clock.Advance(TimeSpan.FromSeconds(2));
        DefaultHttpContext afterWindow = Context("/api/binary/article/42.aeds");
        await Serve(afterWindow, store, options, counters, () => nextCalled = true);
        Assert.True(nextCalled);
        Assert.Equal(0, afterWindow.Response.Body.Length);
    }

    [Fact]
    public void RetainLastGood_DoesNotAdvancePinOffStickyGeneration()
    {
        var clock = new MutableTimeProvider(s_now);
        var store = new PublicHotReadStore(options: Options.Create(StickinessOptions()), timeProvider: clock);
        store.Publish(Snapshot(Frame([1]), "\"v1\"", version: 1));
        store.PublishSoftRefresh(Snapshot(Frame([2]), "\"v2\"", version: 2));
        Assert.Equal(1, store.StickySnapshotForTests.Version);

        store.InvalidateDistributedSnapshot("rebuild-in-flight", PublicHotReadInvalidationPolicy.RetainLastGood);

        Assert.Equal(1, store.StickySnapshotForTests.Version);
        Assert.True(store.TryGetRequestSnapshot(out PublicHotReadSnapshot snapshot, out string reason));
        Assert.Equal("sticky", reason);
        Assert.Equal(1, snapshot.Version);
    }

    private static string StoreReason(PublicHotReadStore store)
    {
        store.TryGetRequestSnapshot(out _, out string reason);
        return reason;
    }

    private static Task Serve(
        HttpContext context,
        PublicHotReadStore store,
        PublicHotReadOptions options,
        PublicHotReadCounters counters,
        Action onNext)
        => PublicHotReadFastPath.TryServeAsync(
            context,
            _ =>
            {
                onNext();
                return Task.CompletedTask;
            },
            store,
            options,
            counters);

    private static PublicHotReadOptions StickinessOptions()
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
            MaxSnapshotAge = TimeSpan.FromMinutes(5),
            VersionStickinessWindow = TimeSpan.FromSeconds(2)
        };

    private static byte[] Frame(byte[] payload)
        => new AedsEncoder().Encode(AedsFrameType.ArticleDetail, payload);

    private static PublicHotReadSnapshot Snapshot(byte[] frame, string etag, long version)
        => new(
            version,
            new Dictionary<int, PublicBinaryArtifact>
            {
                [42] = new PublicBinaryArtifact(
                    frame,
                    etag,
                    "public,max-age=60",
                    version,
                    AedsFrameType.ArticleDetail)
            }.ToFrozenDictionary(),
            FrozenDictionary<PublicListKey, PublicBinaryArtifact>.Empty,
            default,
            default,
            FrozenDictionary<string, PublicHtmlArtifact>.Empty,
            PublicHotReadPublicationEvidence.CreateVerified(version, s_now));

    private static PublicHotReadSnapshot EmptySnapshot(long version)
        => new(
            version,
            FrozenDictionary<int, PublicBinaryArtifact>.Empty,
            FrozenDictionary<PublicListKey, PublicBinaryArtifact>.Empty,
            default,
            default,
            FrozenDictionary<string, PublicHtmlArtifact>.Empty,
            PublicHotReadPublicationEvidence.CreateVerified(version, s_now));

    private static DefaultHttpContext Context(string path)
    {
        var context = new DefaultHttpContext();
        context.Request.Method = HttpMethods.Get;
        context.Request.Path = path;
        context.Response.Body = new MemoryStream();
        return context;
    }

    private static byte[] Body(DefaultHttpContext context)
        => ((MemoryStream)context.Response.Body).ToArray();

    private sealed class MutableTimeProvider(DateTimeOffset now) : TimeProvider
    {
        private DateTimeOffset _now = now;

        public override DateTimeOffset GetUtcNow() => _now;

        internal void Advance(TimeSpan duration) => _now += duration;
    }
}
