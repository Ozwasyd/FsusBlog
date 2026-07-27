using System.Reflection;

using FsusBlog.Core.Cache;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.Spa;

using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using StackExchange.Redis;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicAotArtifactStoreBoundaryTests
{
    [Fact]
    public void LookupAndBackfill_UseVersionedRuntimeScopedKeysThroughArtifactPort()
    {
        var cache = Substitute.For<IPublicAotShellCache>();
        var writer = Substitute.For<IPublicAotCacheWriter>();
        var scheduler = Substitute.For<IPublicAotBackfillScheduler>();
        PublicAotBackfillRequest? scheduled = null;
        scheduler.TrySchedule(Arg.Do<PublicAotBackfillRequest>(request => scheduled = request)).Returns(true);
        var manifest = Substitute.For<ISpaAssetManifestService>();
        manifest.GetFrontendAssetVersion(Arg.Any<HttpContext>()).Returns("frontend-v1");
        var tracker = new PublicAotInvalidationTracker();
        var store = new PublicAotArtifactStore(
            cache,
            writer,
            scheduler,
            manifest,
            new PrefixRuntimeKeyScope("test-session:"),
            tracker);
        var context = new DefaultHttpContext();
        var match = new PublicAotRouteMatch(
            PublicPageKind.Home,
            PublicPageId.Home,
            "home",
            "/",
            "/",
            string.Empty);

        PublicAotArtifactLookup lookup = store.CreateLookup(context, match);
        bool queued = store.TryScheduleBackfill(context, match, lookup);

        string baseKey = string.Concat(
            "test-session:",
            CacheKeyBuilder.PublicAotDocument(PublicPageId.Home, "home", "zh-CN"));
        string invalidationKey = string.Concat(
            "test-session:",
            CacheKeyBuilder.PublicAotDocument(PublicPageId.Home, "home"));
        Assert.Equal(string.Concat(baseKey, ":iv:0"), lookup.DocumentCacheKey);
        Assert.Equal("frontend-v1", lookup.FrontendAssetVersion);
        Assert.Equal("prod-manifest", lookup.AssetMode);
        Assert.Equal("zh-CN", lookup.ExpectedLocale);
        Assert.True(queued);
        Assert.NotNull(scheduled);
        Assert.Equal(lookup.DocumentCacheKey, scheduled.CacheKey);
        Assert.Equal(invalidationKey, scheduled.InvalidationKey);
        Assert.Equal(lookup.PagePrefixKey, scheduled.PagePrefixKey);
        Assert.Equal(0, scheduled.ScheduledInvalidationVersion);
        Assert.Equal("frontend-v1", scheduled.FrontendAssetVersion);
    }

    [Fact]
    public void IsRenderable_RejectsCacheEntryWhoseLocaleDiffersFromLookup()
    {
        var manifest = Substitute.For<ISpaAssetManifestService>();
        manifest.GetFrontendAssetVersion(Arg.Any<HttpContext>()).Returns("frontend-v1");
        var store = new PublicAotArtifactStore(
            Substitute.For<IPublicAotShellCache>(),
            Substitute.For<IPublicAotCacheWriter>(),
            Substitute.For<IPublicAotBackfillScheduler>(),
            manifest,
            new PrefixRuntimeKeyScope(string.Empty),
            new PublicAotInvalidationTracker());
        PublicAotArtifactLookup lookup = store.CreateLookup(new DefaultHttpContext(), new PublicAotRouteMatch(
            PublicPageKind.Home,
            PublicPageId.Home,
            "home",
            "/",
            "/",
            string.Empty));
        const string Html = "<!doctype html><html><body>wrong locale</body></html>";
        PublicAotHtmlArtifact document = PublicAotHtmlArtifactFactory.FromHtml(
            Html,
            PublicAotConstants.RendererVersion,
            "frontend-v1");
        var entry = new PublicAotCacheEntry
        {
            RendererVersion = PublicAotConstants.RendererVersion,
            FrontendAssetVersion = "frontend-v1",
            Locale = "ja-JP",
            ExpiresAtUtc = DateTimeOffset.UtcNow.AddMinutes(5),
            Value = Html,
            Document = document
        };

        Assert.False(store.IsRenderable(entry, lookup));
    }

    [Fact]
    public void Lookup_UsesAnInvalidationGenerationForNonListRoutes()
    {
        var cache = Substitute.For<IPublicAotShellCache>();
        var writer = Substitute.For<IPublicAotCacheWriter>();
        var scheduler = Substitute.For<IPublicAotBackfillScheduler>();
        var manifest = Substitute.For<ISpaAssetManifestService>();
        manifest.GetFrontendAssetVersion(Arg.Any<HttpContext>()).Returns("frontend-v1");
        var store = new PublicAotArtifactStore(
            cache,
            writer,
            scheduler,
            manifest,
            new PrefixRuntimeKeyScope(string.Empty),
            new PublicAotInvalidationTracker());
        PublicAotRouteMatch match = ArticleMatch();

        PublicAotArtifactLookup lookup = store.CreateLookup(new DefaultHttpContext(), match);

        Assert.Equal(
            string.Concat(CacheKeyBuilder.PublicAotDocument(PublicPageId.ArticleDetail, "article:42", "zh-CN"), ":iv:0"),
            lookup.DocumentCacheKey);
    }

    [Fact]
    public async Task Lookup_DurableGenerationDoesNotReviveTheLv0DiskArtifact()
    {
        using var temp = new TemporaryDirectory();
        var database = Substitute.For<IDatabase>();
        database.SetAddAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue>(), Arg.Any<CommandFlags>())
            .Returns(Task.FromResult(true));
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(database);
        var cache = new PublicAotFileShellCache(
            new TestWebHostEnvironment(temp.Root),
            redis,
            NullLogger<PublicAotFileShellCache>.Instance);
        var tracker = new PublicAotInvalidationTracker();
        var scheduler = Substitute.For<IPublicAotBackfillScheduler>();
        var manifest = Substitute.For<ISpaAssetManifestService>();
        manifest.GetFrontendAssetVersion(Arg.Any<HttpContext>()).Returns("frontend-v1");
        var store = new PublicAotArtifactStore(
            cache,
            Substitute.For<IPublicAotCacheWriter>(),
            scheduler,
            manifest,
            new PrefixRuntimeKeyScope(string.Empty),
            tracker);
        PublicAotRouteMatch match = ArticleMatch();
        string lv0Key = string.Concat(
            CacheKeyBuilder.PublicAotDocument(match.PageId, match.RouteKey),
            ":iv:0");
        await cache.SetAsync(new PublicAotCacheEntry
        {
            CacheKey = lv0Key,
            PageId = match.PageId,
            RouteKey = match.RouteKey,
            Source = PublicAotWriteSource.ServerSsrBackfill,
            Value = "<html>lv0</html>",
            RendererVersion = PublicAotConstants.RendererVersion,
            FrontendAssetVersion = "frontend-v1",
            GeneratedAtUtc = DateTimeOffset.UtcNow,
            ExpiresAtUtc = DateTimeOffset.UtcNow.AddHours(1)
        });
        Assert.NotNull(await cache.TryGetEntryAsync(lv0Key, "frontend-v1"));

        for (int generation = 0; generation < 5; generation++)
        {
            tracker.MarkKey(CacheKeyBuilder.PublicAotDocument(match.PageId, match.RouteKey));
        }

        PublicAotArtifactLookup lookup = store.CreateLookup(new DefaultHttpContext(), match);

        Assert.EndsWith(":iv:5", lookup.DocumentCacheKey, StringComparison.Ordinal);
        Assert.Null(await store.TryGetEntryAsync(lookup, CancellationToken.None));
        Assert.NotNull(await cache.TryGetEntryAsync(lv0Key, "frontend-v1"));
    }

    [Fact]
    public async Task WriteBackfill_RechecksAssetVersionAfterCommitGuard_AndRejectsStaleArtifact()
    {
        var cache = Substitute.For<IPublicAotShellCache>();
        var writer = Substitute.For<IPublicAotCacheWriter>();
        var scheduler = Substitute.For<IPublicAotBackfillScheduler>();
        string assetVersion = "frontend-v1";
        var manifest = Substitute.For<ISpaAssetManifestService>();
        manifest.GetFrontendAssetVersion().Returns(_ => assetVersion);
        var store = new PublicAotArtifactStore(
            cache,
            writer,
            scheduler,
            manifest,
            new PrefixRuntimeKeyScope(string.Empty),
            new PublicAotInvalidationTracker());
        var match = new PublicAotRouteMatch(
            PublicPageKind.Home,
            PublicPageId.Home,
            "home",
            "/",
            "/",
            string.Empty);
        var request = new PublicAotBackfillRequest(match.Kind, match.RouteKey, match.Path, match.QueryString, "cache:home")
        {
            FrontendAssetVersion = assetVersion
        };

        bool written = await store.WriteBackfillAsync(
            request,
            new PublicAotBackfillDocument(match, "<html></html>", PublicAotConstants.RendererVersion, DateTimeOffset.UnixEpoch),
            _ =>
            {
                assetVersion = "frontend-v2";
                return Task.CompletedTask;
            },
            CancellationToken.None);

        Assert.False(written);
        Assert.Empty(writer.ReceivedCalls());
    }

    [Fact]
    public async Task WriteBackfill_RejectsInvalidationThatHappensAfterTheInitialCurrentCheck()
    {
        var cache = Substitute.For<IPublicAotShellCache>();
        var writer = Substitute.For<IPublicAotCacheWriter>();
        var scheduler = Substitute.For<IPublicAotBackfillScheduler>();
        var manifest = Substitute.For<ISpaAssetManifestService>();
        manifest.GetFrontendAssetVersion().Returns("frontend-v1");
        var tracker = new PublicAotInvalidationTracker();
        var store = new PublicAotArtifactStore(
            cache,
            writer,
            scheduler,
            manifest,
            new PrefixRuntimeKeyScope(string.Empty),
            tracker);
        var match = new PublicAotRouteMatch(
            PublicPageKind.ArticleDetail,
            PublicPageId.ArticleDetail,
            "article:42",
            "/article/42",
            "/article/42",
            string.Empty);
        string cacheKey = CacheKeyBuilder.PublicAotDocument(match.PageId, match.RouteKey) + ":iv:0";
        string pagePrefixKey = CacheKeyBuilder.PublicAotDocument(match.PageId, string.Empty);
        var request = new PublicAotBackfillRequest(match.Kind, match.RouteKey, match.Path, match.QueryString, cacheKey)
        {
            InvalidationKey = CacheKeyBuilder.PublicAotDocument(match.PageId, match.RouteKey),
            PagePrefixKey = pagePrefixKey,
            ScheduledInvalidationVersion = 0,
            FrontendAssetVersion = "frontend-v1"
        };

        Assert.True(store.IsCurrentBackfill(request));
        await tracker.WithInvalidationLockAsync([pagePrefixKey], () =>
        {
            tracker.MarkPrefix(pagePrefixKey);
            return Task.CompletedTask;
        }, CancellationToken.None);

        bool written = await store.WriteBackfillAsync(
            request,
            new PublicAotBackfillDocument(match, "<html></html>", PublicAotConstants.RendererVersion, DateTimeOffset.UnixEpoch),
            beforeCommit: null,
            CancellationToken.None);

        Assert.False(written);
        Assert.Empty(writer.ReceivedCalls());
    }

    [Fact]
    public async Task WriteBackfill_RecordsGenerationAndDigestReceiptForThePublishedArtifact()
    {
        var cache = Substitute.For<IPublicAotShellCache>();
        var writer = Substitute.For<IPublicAotCacheWriter>();
        var scheduler = Substitute.For<IPublicAotBackfillScheduler>();
        var manifest = Substitute.For<ISpaAssetManifestService>();
        manifest.GetFrontendAssetVersion().Returns("frontend-v1");
        var tracker = new PublicAotInvalidationTracker();
        var store = new PublicAotArtifactStore(
            cache,
            writer,
            scheduler,
            manifest,
            new PrefixRuntimeKeyScope(string.Empty),
            tracker);
        var match = new PublicAotRouteMatch(
            PublicPageKind.About,
            PublicPageId.About,
            "about",
            "/about",
            "/about",
            string.Empty);
        string cacheKey = CacheKeyBuilder.PublicAotDocument(match.PageId, match.RouteKey) + ":iv:0";
        var request = new PublicAotBackfillRequest(match.Kind, match.RouteKey, match.Path, match.QueryString, cacheKey)
        {
            InvalidationKey = CacheKeyBuilder.PublicAotDocument(match.PageId, match.RouteKey),
            PagePrefixKey = CacheKeyBuilder.PublicAotDocument(match.PageId, string.Empty),
            ScheduledInvalidationVersion = 0,
            FrontendAssetVersion = "frontend-v1"
        };

        bool written = await store.WriteBackfillAsync(
            request,
            new PublicAotBackfillDocument(match, "<html>receipt</html>", PublicAotConstants.RendererVersion, DateTimeOffset.UnixEpoch),
            beforeCommit: null,
            CancellationToken.None);

        Assert.True(written);
        object?[] writeArguments = Assert.Single(writer.ReceivedCalls()).GetArguments();
        Assert.Equal(DateTimeOffset.UnixEpoch, writeArguments[8]);
        Assert.True(tracker.TryGetCommitReceipt(cacheKey, out PublicAotBackfillCommitReceipt? receipt));
        Assert.NotNull(receipt);
        Assert.Equal(0, receipt.ScheduledInvalidationVersion);
        Assert.Equal(0, receipt.CurrentInvalidationVersion);
        Assert.Equal(0, receipt.PublishedInvalidationVersion);
        Assert.Equal(64, receipt.PayloadDigest.Length);
        Assert.Equal(receipt.PayloadDigest, receipt.ArtifactDigest);
        Assert.Equal(receipt.PayloadDigest, receipt.HotReadDigest);
    }

    [Theory]
    [InlineData("route")]
    [InlineData("page")]
    [InlineData("global")]
    public async Task WriteBackfill_RejectsAnInvalidationThatOccursDuringRendering(string invalidationScope)
    {
        var cache = Substitute.For<IPublicAotShellCache>();
        var writer = Substitute.For<IPublicAotCacheWriter>();
        var scheduler = Substitute.For<IPublicAotBackfillScheduler>();
        var manifest = Substitute.For<ISpaAssetManifestService>();
        manifest.GetFrontendAssetVersion().Returns("frontend-v1");
        var tracker = new PublicAotInvalidationTracker();
        var store = new PublicAotArtifactStore(cache, writer, scheduler, manifest, new PrefixRuntimeKeyScope(string.Empty), tracker);
        PublicAotRouteMatch match = ArticleMatch();
        PublicAotBackfillRequest request = CreateRequest(match, generation: 0);

        Assert.True(store.IsCurrentBackfill(request));
        if (string.Equals(invalidationScope, "global", StringComparison.Ordinal))
        {
            await tracker.WithGlobalInvalidationLockAsync(() =>
            {
                tracker.MarkAll();
                return Task.CompletedTask;
            }, CancellationToken.None);
        }
        else
        {
            await tracker.WithInvalidationLockAsync([request.PagePrefixKey], () =>
            {
                if (string.Equals(invalidationScope, "route", StringComparison.Ordinal))
                {
                    tracker.MarkKey(request.InvalidationKey);
                }
                else
                {
                    tracker.MarkPrefix(request.PagePrefixKey);
                }
                return Task.CompletedTask;
            }, CancellationToken.None);
        }

        bool written = await store.WriteBackfillAsync(
            request,
            new PublicAotBackfillDocument(match, "<html>stale-render</html>", PublicAotConstants.RendererVersion, DateTimeOffset.UnixEpoch),
            beforeCommit: null,
            CancellationToken.None);

        Assert.False(written);
        Assert.Empty(writer.ReceivedCalls());
        Assert.False(tracker.TryGetCommitReceipt(request.CacheKey, out _));
    }

    [Fact]
    public async Task PublicationLock_BlocksInvalidationThroughArtifactAndHotReadPublication()
    {
        var cache = Substitute.For<IPublicAotShellCache>();
        var scheduler = Substitute.For<IPublicAotBackfillScheduler>();
        var manifest = Substitute.For<ISpaAssetManifestService>();
        manifest.GetFrontendAssetVersion().Returns("frontend-v1");
        var tracker = new PublicAotInvalidationTracker();
        var writer = new BlockingWriter();
        var store = new PublicAotArtifactStore(cache, writer, scheduler, manifest, new PrefixRuntimeKeyScope(string.Empty), tracker);
        PublicAotRouteMatch match = ArticleMatch();
        PublicAotBackfillRequest request = CreateRequest(match, generation: 0);

        Task<bool> publication = store.WriteBackfillAsync(
            request,
            new PublicAotBackfillDocument(match, "<html>old</html>", PublicAotConstants.RendererVersion, DateTimeOffset.UnixEpoch),
            beforeCommit: null,
            CancellationToken.None);
        await writer.FirstWriteEntered.Task;

        Task invalidation = tracker.WithInvalidationLockAsync([request.PagePrefixKey], () =>
        {
            tracker.MarkPrefix(request.PagePrefixKey);
            return Task.CompletedTask;
        }, CancellationToken.None);

        Assert.False(invalidation.IsCompleted);
        writer.ReleaseFirstWrite.SetResult();
        Assert.True(await publication);
        await invalidation;

        Assert.Equal(["<html>old</html>"], writer.PublishedHtml);
        Assert.True(tracker.WasInvalidatedAfter(request));
    }

    [Fact]
    public async Task ConcurrentBackfills_OlderGenerationCannotPublishLastAfterInvalidation()
    {
        var cache = Substitute.For<IPublicAotShellCache>();
        var scheduler = Substitute.For<IPublicAotBackfillScheduler>();
        var manifest = Substitute.For<ISpaAssetManifestService>();
        manifest.GetFrontendAssetVersion().Returns("frontend-v1");
        var tracker = new PublicAotInvalidationTracker();
        var writer = new BlockingWriter();
        var store = new PublicAotArtifactStore(cache, writer, scheduler, manifest, new PrefixRuntimeKeyScope(string.Empty), tracker);
        PublicAotRouteMatch match = ArticleMatch();
        PublicAotBackfillRequest oldRequest = CreateRequest(match, 0);

        Task<bool> oldPublication = store.WriteBackfillAsync(
            oldRequest,
            new PublicAotBackfillDocument(match, "<html>old</html>", PublicAotConstants.RendererVersion, DateTimeOffset.UnixEpoch),
            beforeCommit: null,
            CancellationToken.None);
        await writer.FirstWriteEntered.Task;
        Task invalidation = tracker.WithInvalidationLockAsync([oldRequest.PagePrefixKey], () =>
        {
            tracker.MarkPrefix(oldRequest.PagePrefixKey);
            return Task.CompletedTask;
        }, CancellationToken.None);
        Assert.False(invalidation.IsCompleted);

        writer.ReleaseFirstWrite.SetResult();
        Assert.True(await oldPublication);
        await invalidation;

        PublicAotBackfillRequest currentRequest = CreateRequest(match, 1);
        Assert.True(await store.WriteBackfillAsync(
            currentRequest,
            new PublicAotBackfillDocument(match, "<html>current</html>", PublicAotConstants.RendererVersion, DateTimeOffset.UnixEpoch),
            beforeCommit: null,
            CancellationToken.None));

        Assert.Equal(["<html>old</html>", "<html>current</html>"], writer.PublishedHtml);
        Assert.Equal("<html>current</html>", writer.PublishedHtml[^1]);
    }

    [Fact]
    public async Task BackfillStage_InvalidationRejectsBeforeAnyStagingOrPublication()
    {
        var cache = Substitute.For<IPublicAotShellCache>();
        var writer = new BlockingWriter();
        var manifest = Substitute.For<ISpaAssetManifestService>();
        manifest.GetFrontendAssetVersion().Returns("frontend-v1");
        var tracker = new PublicAotInvalidationTracker();
        var store = new PublicAotArtifactStore(cache, writer, Substitute.For<IPublicAotBackfillScheduler>(), manifest, new PrefixRuntimeKeyScope(string.Empty), tracker);
        PublicAotRouteMatch match = ArticleMatch();
        PublicAotBackfillRequest request = CreateRequest(match, 0);
        var stageEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseStage = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        Task<bool> write = store.WriteBackfillAsync(
            request,
            new PublicAotBackfillDocument(match, "<html>staged</html>", PublicAotConstants.RendererVersion, DateTimeOffset.UnixEpoch),
            async token =>
            {
                stageEntered.SetResult();
                await releaseStage.Task.WaitAsync(token);
            },
            CancellationToken.None);
        await stageEntered.Task;
        await tracker.WithInvalidationLockAsync([request.PagePrefixKey], () =>
        {
            tracker.MarkPrefix(request.PagePrefixKey);
            return Task.CompletedTask;
        }, CancellationToken.None);
        releaseStage.SetResult();

        Assert.False(await write);
        Assert.Empty(writer.PublishedHtml);
        Assert.False(tracker.TryGetCommitReceipt(request.CacheKey, out _));
    }

    [Fact]
    public void CommitReceipt_RejectsMissingGenerationOrDigestFields()
    {
        var tracker = new PublicAotInvalidationTracker();
        var incomplete = new PublicAotBackfillCommitReceipt(
            "cache:article:42",
            "cache:article:",
            0,
            0,
            0,
            "frontend-v1",
            PublicAotConstants.RendererVersion,
            string.Empty,
            string.Empty,
            string.Empty);

        Assert.Throws<InvalidOperationException>(() => tracker.RecordCommitReceipt(incomplete));

        var generationMismatch = incomplete with
        {
            PayloadDigest = new string('a', 64),
            ArtifactDigest = new string('b', 64),
            HotReadDigest = new string('c', 64),
            CurrentInvalidationVersion = 1,
            PublishedInvalidationVersion = 1
        };
        Assert.Throws<InvalidOperationException>(() => tracker.RecordCommitReceipt(generationMismatch));
    }

    [Fact]
    public void DependencyGraph_MovesStoragePortsOutOfShellWithoutCallback()
    {
        Type[] shellDependencies = Assert.Single(typeof(PublicAotShellService).GetConstructors(
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
            .GetParameters()
            .Select(static parameter => parameter.ParameterType)
            .ToArray();
        Assert.Contains(typeof(IPublicAotArtifactStore), shellDependencies);
        Assert.Contains(typeof(IPublicAotRuntimeState), shellDependencies);
        Assert.DoesNotContain(typeof(PublicAotSsrRuntimeState), shellDependencies);
        Assert.DoesNotContain(typeof(IPublicAotShellCache), shellDependencies);
        Assert.DoesNotContain(typeof(IPublicAotCacheWriter), shellDependencies);
        Assert.DoesNotContain(typeof(IPublicAotBackfillScheduler), shellDependencies);
        Assert.DoesNotContain(typeof(ISpaAssetManifestService), shellDependencies);
        Assert.DoesNotContain(typeof(IRuntimeKeyScope), shellDependencies);
        Assert.DoesNotContain(typeof(PublicAotInvalidationTracker), shellDependencies);

        ParameterInfo[] artifactDependencies = Assert.Single(typeof(PublicAotArtifactStore).GetConstructors(
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
            .GetParameters();
        Assert.DoesNotContain(
            artifactDependencies,
            static parameter => parameter.ParameterType == typeof(IPublicAotShellService)
                || parameter.ParameterType == typeof(PublicAotShellService));
    }

    private sealed class PrefixRuntimeKeyScope(string prefix) : IRuntimeKeyScope
    {
        public string PrefixKey(string key) => string.Concat(prefix, key);
    }

    private sealed class TemporaryDirectory : IDisposable
    {
        public string Root { get; } = Path.Combine(Path.GetTempPath(), $"fsus-public-aot-boundary-{Guid.NewGuid():N}");

        public TemporaryDirectory()
        {
            Directory.CreateDirectory(Path.Combine(Root, "wwwroot"));
        }

        public void Dispose()
        {
            try
            {
                Directory.Delete(Root, recursive: true);
            }
            catch
            {
            }
        }
    }

    private sealed class TestWebHostEnvironment(string root) : IWebHostEnvironment
    {
        public string ApplicationName { get; set; } = "FsusBlog.Tests";
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string WebRootPath { get; set; } = Path.Combine(root, "wwwroot");
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
        public string ContentRootPath { get; set; } = root;
        public string EnvironmentName { get; set; } = Environments.Development;
    }

    private static PublicAotRouteMatch ArticleMatch()
        => new(
            PublicPageKind.ArticleDetail,
            PublicPageId.ArticleDetail,
            "article:42",
            "/article/42",
            "/article/42",
            string.Empty);

    private static PublicAotBackfillRequest CreateRequest(PublicAotRouteMatch match, long generation)
    {
        string invalidationKey = CacheKeyBuilder.PublicAotDocument(match.PageId, match.RouteKey);
        return new PublicAotBackfillRequest(
            match.Kind,
            match.RouteKey,
            match.Path,
            match.QueryString,
            string.Concat(invalidationKey, ":iv:", generation.ToString()))
        {
            InvalidationKey = invalidationKey,
            PagePrefixKey = CacheKeyBuilder.PublicAotDocument(match.PageId, string.Empty),
            ScheduledInvalidationVersion = generation,
            FrontendAssetVersion = "frontend-v1"
        };
    }

    private sealed class BlockingWriter : IPublicAotCacheWriter
    {
        private int _writes;

        public TaskCompletionSource FirstWriteEntered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource ReleaseFirstWrite { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public List<string> PublishedHtml { get; } = [];

        public async Task WriteAsync(
            string cacheKey,
            PublicPageId pageId,
            string routeKey,
            string rendererVersion,
            string frontendAssetVersion,
            string locale,
            string html,
            PublicAotWriteSource source,
            DateTimeOffset? generatedAtUtc = null,
            TimeSpan? ttl = null,
            CancellationToken cancellationToken = default)
        {
            _ = cacheKey;
            _ = pageId;
            _ = routeKey;
            _ = rendererVersion;
            _ = frontendAssetVersion;
            _ = locale;
            _ = source;
            _ = generatedAtUtc;
            _ = ttl;
            cancellationToken.ThrowIfCancellationRequested();
            if (Interlocked.Increment(ref _writes) == 1)
            {
                FirstWriteEntered.SetResult();
                await ReleaseFirstWrite.Task.WaitAsync(cancellationToken);
            }
            PublishedHtml.Add(html);
        }
    }
}
