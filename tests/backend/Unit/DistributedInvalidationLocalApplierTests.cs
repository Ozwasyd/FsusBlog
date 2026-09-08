using System.Collections.Frozen;

using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Distributed;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Storage;

using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

using NSubstitute;

using StackExchange.Redis;

namespace FsusBlog.Server.Tests.Unit;

public sealed class DistributedInvalidationLocalApplierTests
{
    [Fact]
    public async Task CommentMutation_LeavesUnrelatedArticleTaxonomyAndSeoResident()
    {
        await using Fixture fixture = await Fixture.CreateAsync();
        fixture.SeedArticle(1, [1, 2, 3]);
        fixture.SeedArticle(2, [4, 5, 6]);
        fixture.SeedPolicy(CachePolicyId.CategoryFrame, "all", [7]);
        fixture.SeedPolicy(CachePolicyId.SystemSeo, "main", [8]);
        fixture.PublishSnapshot(articles: [1, 2], category: true, seoHtml: true);
        IReadOnlyList<CachePolicyStorageSnapshot> before = fixture.LocalCache.SnapshotResidency();
        Assert.True(fixture.HotRead.Current.TryGetArticle(1, out PublicBinaryArtifact beforeOne));
        Assert.True(fixture.HotRead.Current.TryGetArticle(2, out PublicBinaryArtifact beforeTwo));
        byte[] articleOneBytes = beforeOne.Frame.ToArray();
        byte[] articleTwoBytes = beforeTwo.Frame.ToArray();

        DistributedInvalidationLocalApplyResult? result = await fixture.Applier.ApplyAsync(
            Event(
                DistributedInvalidationEventKinds.CommentMutation,
                ["comments", "stats"],
                ["article:1:comments"],
                ["public-hot-read"]));

        Assert.NotNull(result);
        Assert.True(result.IsApplied);
        Assert.False(result.FullReconcile);
        Assert.Equal(0, result.AotRouteCount);
        Assert.Equal(1, result.HotReadFragmentCount);
        Assert.True(fixture.HotRead.IsReady);
        Assert.True(fixture.HotRead.Current.TryGetArticle(1, out PublicBinaryArtifact articleOne));
        Assert.True(fixture.HotRead.Current.TryGetArticle(2, out PublicBinaryArtifact articleTwo));
        Assert.Equal(articleOneBytes, articleOne.Frame.ToArray());
        Assert.Equal(articleTwoBytes, articleTwo.Frame.ToArray());
        Assert.True(fixture.HotRead.Current.TryGetCategory(out _));
        Assert.True(fixture.HotRead.Current.TryGetHtml(PublicHotReadRouteKeys.HtmlPath("home"), out _));
        AssertResidencyUnchanged(before, fixture.LocalCache.SnapshotResidency(), CachePolicyId.ArticleDetail);
        AssertResidencyUnchanged(before, fixture.LocalCache.SnapshotResidency(), CachePolicyId.CategoryFrame);
        AssertResidencyUnchanged(before, fixture.LocalCache.SnapshotResidency(), CachePolicyId.SystemSeo);
        Assert.Contains("fullReconcile:false", fixture.CacheRuntime.Snapshot().LastDetail, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ArticleMutation_KeepsPublicHotReadReadyAndUnrelatedRouteBytes()
    {
        await using Fixture fixture = await Fixture.CreateAsync();
        fixture.SeedArticle(1, [11]);
        fixture.SeedArticle(2, [22]);
        fixture.PublishSnapshot(articles: [1, 2], category: true, seoHtml: true);
        Assert.True(fixture.HotRead.Current.TryGetArticle(2, out PublicBinaryArtifact beforeTwo));
        byte[] unchanged = beforeTwo.Frame.ToArray();

        DistributedInvalidationLocalApplyResult? result = await fixture.Applier.ApplyAsync(
            Event(
                DistributedInvalidationEventKinds.ArticleMutation,
                ["article-list", "hot-articles", "stats"],
                ["article:1"],
                ["article-detail:1", "public-aot", "public-hot-read"]));

        Assert.NotNull(result);
        Assert.True(result.IsApplied);
        Assert.False(result.FullReconcile);
        Assert.True(fixture.HotRead.IsReady);
        Assert.False(fixture.HotRead.Current.TryGetArticle(1, out _));
        Assert.True(fixture.HotRead.Current.TryGetArticle(2, out PublicBinaryArtifact remaining));
        Assert.Equal(unchanged, remaining.Frame.ToArray());
        Assert.True(fixture.HotRead.Current.TryGetCategory(out _));
        Assert.False(fixture.TryGetL1(CachePolicyId.ArticleDetail, "1"));
        Assert.True(fixture.TryGetL1(CachePolicyId.ArticleDetail, "2"));
    }

    [Theory]
    [InlineData("taxonomy")]
    [InlineData("seo")]
    [InlineData("system-page")]
    public async Task ExactKindMatrix_DoesNotClearUnrelatedArticleDetail(string matrix)
    {
        await using Fixture fixture = await Fixture.CreateAsync();
        fixture.SeedArticle(9, [9]);
        fixture.SeedPolicy(CachePolicyId.CategoryFrame, "all", [3]);
        fixture.SeedPolicy(CachePolicyId.SystemSeo, "main", [4]);
        fixture.PublishSnapshot(articles: [9], category: true, seoHtml: true);
        DistributedInvalidationEvent invalidation = matrix switch
        {
            "taxonomy" => Event(
                DistributedInvalidationEventKinds.TaxonomyMutation,
                ["article-list", "category", "tag"],
                ["taxonomy:*"],
                ["public-aot", "public-hot-read"]),
            "seo" => Event(
                DistributedInvalidationEventKinds.SeoMutation,
                ["seo"],
                ["system:seo"],
                ["public-aot"]),
            "system-page" => Event(
                DistributedInvalidationEventKinds.SystemPageMutation,
                ["system-page"],
                ["system-page:about"],
                ["public-aot"]),
            _ => throw new InvalidOperationException(matrix)
        };

        DistributedInvalidationLocalApplyResult? result = await fixture.Applier.ApplyAsync(invalidation);

        Assert.NotNull(result);
        Assert.True(result.IsApplied);
        Assert.False(result.FullReconcile);
        Assert.True(fixture.HotRead.IsReady);
        Assert.True(fixture.HotRead.Current.TryGetArticle(9, out _));
        if (matrix == "taxonomy")
        {
            Assert.Equal(3, result.AotRouteCount);
        }
        else
        {
            Assert.True(result.AotRouteCount > 0);
        }
        Assert.True(fixture.TryGetL1(CachePolicyId.ArticleDetail, "9"));
        if (matrix == "taxonomy")
        {
            Assert.False(fixture.HotRead.Current.TryGetCategory(out _));
        }
    }

    [Fact]
    public async Task UnknownTarget_EstablishesFullReconcileAndFailsClosed()
    {
        await using Fixture fixture = await Fixture.CreateAsync();
        fixture.SeedArticle(1, [1]);
        fixture.PublishSnapshot(articles: [1], category: true, seoHtml: true);

        DistributedInvalidationLocalApplyResult? result = await fixture.Applier.ApplyAsync(
            Event(
                DistributedInvalidationEventKinds.ArticleMutation,
                ["unknown-target"],
                ["article:1"],
                ["public-aot"]));

        Assert.NotNull(result);
        Assert.True(result.FullReconcile);
        Assert.Equal(DistributedInvalidationLocalApplyStatus.FailedTerminal, result.LocalApplyStatus);
        Assert.False(result.IsApplied);
        Assert.False(fixture.HotRead.IsReady);
        Assert.Equal("distributed_full_reconcile", fixture.CacheRuntime.Snapshot().LastKind);
    }

    [Fact]
    public async Task ConcurrentDisjointEvents_DoNotExpandEachOthersScope()
    {
        await using Fixture fixture = await Fixture.CreateAsync();
        fixture.SeedArticle(1, [1]);
        fixture.SeedArticle(2, [2]);
        fixture.SeedPolicy(CachePolicyId.SystemSeo, "main", [3]);
        fixture.PublishSnapshot(articles: [1, 2], category: true, seoHtml: true);

        Task<DistributedInvalidationLocalApplyResult?> article = fixture.Applier.ApplyAsync(
            Event(
                DistributedInvalidationEventKinds.ArticleMutation,
                ["article-list"],
                ["article:1"],
                ["public-aot", "public-hot-read"],
                "event-article"));
        Task<DistributedInvalidationLocalApplyResult?> comment = fixture.Applier.ApplyAsync(
            Event(
                DistributedInvalidationEventKinds.CommentMutation,
                ["comments", "stats"],
                ["article:2:comments"],
                ["public-hot-read"],
                "event-comment"));
        DistributedInvalidationLocalApplyResult?[] results = await Task.WhenAll(article, comment);

        Assert.All(results, static result =>
        {
            Assert.NotNull(result);
            Assert.True(result.IsApplied);
            Assert.False(result.FullReconcile);
        });
        Assert.True(fixture.HotRead.IsReady);
        Assert.False(fixture.HotRead.Current.TryGetArticle(1, out _));
        Assert.True(fixture.HotRead.Current.TryGetArticle(2, out _));
        Assert.True(fixture.HotRead.Current.TryGetCategory(out _));
        Assert.True(fixture.TryGetL1(CachePolicyId.ArticleDetail, "2"));
        Assert.True(fixture.TryGetL1(CachePolicyId.SystemSeo, "main"));
        Assert.False(fixture.TryGetL1(CachePolicyId.ArticleDetail, "1"));
    }

    [Fact]
    public async Task FragmentRebuildTerminalFailure_EstablishesFullReconcileAndFailsClosed()
    {
        var state = new InMemoryPublicHotArtifactDeliveryStateStore();
        var queue = new PublicHotArtifactUpdateQueue(
            Options.Create(new PublicHotReadOptions { UpdateQueueCapacity = 8, PublicHotRecoveryMaximumAttempts = 1 }),
            state,
            state);
        var store = new PublicHotReadStore();
        store.Publish(CreateSnapshot([1], category: true, seoHtml: true));
        var ledger = Substitute.For<IDistributedInvalidationDeliveryLedger>();
        ledger.RecordFullReconcileObligationAsync(
                Arg.Any<string>(),
                Arg.Any<string>(),
                Arg.Any<string>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);
        await using ServiceProvider services = new ServiceCollection()
            .AddScoped<IPublicHotArtifactProjector, TerminalFragmentProjector>()
            .AddSingleton(new DistributedInvalidationOptions
            {
                RuntimeMode = RuntimeModeKind.StaticRole,
                NodeId = "node-b",
                Topology = DistributedInvalidationTopologyManifest.Create(
                    DistributedInvalidationOptions.DefaultChannel,
                    ["node-a", "node-b"])
            })
            .AddSingleton<IDistributedInvalidationDeliveryLedger>(ledger)
            .AddSingleton<IRuntimeKeyScope, DefaultRuntimeKeyScope>()
            .BuildServiceProvider();
        PublicHotArtifactEnqueueResult enqueued = await queue.EnqueueDistributedFragmentsAsync(
            ["article:1"],
            "distributed-invalidation:article_mutation:event-fail");
        PublicHotArtifactUpdate pending = (await queue.LoadRecoveryUpdateAsync(CancellationToken.None))!.Value;
        var worker = new PublicHotArtifactUpdateWorker(
            queue,
            store,
            new NoopRevocations(),
            CreateRuntime(),
            services.GetRequiredService<IServiceScopeFactory>(),
            Options.Create(new PublicHotReadOptions { UpdateDebounceMilliseconds = 0, PublicHotRecoveryMaximumAttempts = 1 }),
            NullLogger<PublicHotArtifactUpdateWorker>.Instance);

        await worker.ProcessOnceAsync(pending, CancellationToken.None);

        Assert.False(store.IsReady);
        PublicHotArtifactObligation failed = (await state.GetActiveAsync(CancellationToken.None))!;
        Assert.True(failed.IsTerminal);
        await ledger.Received().RecordFullReconcileObligationAsync(
            Arg.Any<string>(),
            "node-b",
            "fragment-rebuild-failed",
            Arg.Any<CancellationToken>());
        Assert.True(enqueued.DeliveryGeneration > 0);
    }

    private static void AssertResidencyUnchanged(
        IReadOnlyList<CachePolicyStorageSnapshot> before,
        IReadOnlyList<CachePolicyStorageSnapshot> after,
        CachePolicyId policyId)
    {
        CachePolicyStorageSnapshot previous = before.Single(item => item.PolicyId == policyId);
        CachePolicyStorageSnapshot current = after.Single(item => item.PolicyId == policyId);
        Assert.Equal(previous.KeyCount, current.KeyCount);
        Assert.Equal(previous.Bytes, current.Bytes);
    }

    private static DistributedInvalidationEvent Event(
        string kind,
        IReadOnlyList<string> cacheTags,
        IReadOnlyList<string> routeKeys,
        IReadOnlyList<string> artifactKeys,
        string? eventId = null)
        => DistributedInvalidationEvent.Create(
            eventId ?? $"event-{kind}",
            kind,
            "node-a",
            "test",
            cacheTags,
            routeKeys,
            artifactKeys,
            $"trace-{eventId ?? kind}",
            TimeProvider.System);

    private static PublicHotReadSnapshot CreateSnapshot(int[] articles, bool category, bool seoHtml)
    {
        var frames = articles.ToDictionary(
            static id => id,
            static id => CreateArticle(id));
        PublicBinaryArtifact categoryFrame = category
            ? new(CreateFrame(AedsFrameType.CategoryList), "\"cat\"", "public,max-age=60", 1, AedsFrameType.CategoryList)
            : default;
        FrozenDictionary<string, PublicHtmlArtifact> html = seoHtml
            ? new Dictionary<string, PublicHtmlArtifact>
            {
                [PublicHotReadRouteKeys.HtmlPath("home")] = PublicHotReadHtmlArtifactFactory.FromHtml(
                    "<!doctype html><html><body>home</body></html>",
                    "public,max-age=60",
                    "renderer",
                    "frontend")
            }.ToFrozenDictionary(StringComparer.Ordinal)
            : FrozenDictionary<string, PublicHtmlArtifact>.Empty;
        return new PublicHotReadSnapshot(
            1,
            frames.ToFrozenDictionary(),
            FrozenDictionary<PublicListKey, PublicBinaryArtifact>.Empty,
            categoryFrame,
            default,
            html,
            PublicHotReadPublicationEvidence.CreateVerified(1, DateTimeOffset.UtcNow));
    }

    private static PublicBinaryArtifact CreateArticle(int id)
        => new(CreateFrame(AedsFrameType.ArticleDetail, [(byte)id]), $"\"{id}\"", "public,max-age=60", 1, AedsFrameType.ArticleDetail);

    private static byte[] CreateFrame(AedsFrameType frameType, byte[]? payload = null)
        => new AedsEncoder().Encode(frameType, payload ?? []);

    private static DeploymentRuntimeState CreateRuntime()
    {
        IConfiguration configuration = new ConfigurationBuilder().Build();
        return new DeploymentRuntimeState(
            new ReleaseIdentityProvider(configuration),
            configuration,
            new TestWebHostEnvironment(),
            TimeProvider.System);
    }

    private sealed class Fixture : IAsyncDisposable
    {
        private readonly MemoryCache _memory = new(new MemoryCacheOptions());
        private readonly Dictionary<int, byte[]> _articleBytes = [];
        private readonly CachePolicyRegistry _policies = new();

        private Fixture()
        {
            LocalCache = new CacheLocalStore(_memory, TimeProvider.System);
            var redis = Substitute.For<IConnectionMultiplexer>();
            redis.GetDatabase(Arg.Any<int>(), Arg.Any<object>()).Returns(Substitute.For<IDatabase>());
            var environment = Substitute.For<IWebHostEnvironment>();
            environment.ContentRootPath.Returns(Path.GetTempPath());
            environment.WebRootPath.Returns(Path.GetTempPath());
            PublicAot = new PublicAotFileShellCache(
                environment,
                redis,
                NullLogger<PublicAotFileShellCache>.Instance,
                configuration: new ConfigurationBuilder().Build(),
                publicArtifactStorage: Substitute.For<IPublicArtifactStorage>());
            HotRead = new PublicHotReadStore();
            Delivery = new InMemoryPublicHotArtifactDeliveryStateStore();
            Queue = new PublicHotArtifactUpdateQueue(
                Options.Create(new PublicHotReadOptions { UpdateQueueCapacity = 8 }),
                Delivery,
                Delivery);
            CacheRuntime = new CacheInvalidationRuntimeState();
            Applier = new DistributedInvalidationLocalApplier(
                LocalCache,
                PublicAot,
                new PublicAotInvalidationTracker(new InMemoryPublicAotInvalidationGenerationAuthority()),
                new PublicAotSsrRuntimeState(new ConfigurationBuilder().Build()),
                HotRead,
                Queue,
                Substitute.For<IAotSeoConfigSnapshot>(),
                CacheRuntime,
                NullLogger<DistributedInvalidationLocalApplier>.Instance);
        }

        public CacheLocalStore LocalCache
        {
            get;
        }
        public PublicAotFileShellCache PublicAot
        {
            get;
        }
        public PublicHotReadStore HotRead
        {
            get;
        }
        public InMemoryPublicHotArtifactDeliveryStateStore Delivery
        {
            get;
        }
        public PublicHotArtifactUpdateQueue Queue
        {
            get;
        }
        public CacheInvalidationRuntimeState CacheRuntime
        {
            get;
        }
        public DistributedInvalidationLocalApplier Applier
        {
            get;
        }

        public static Task<Fixture> CreateAsync()
            => Task.FromResult(new Fixture());

        public void SeedArticle(int articleId, byte[] payload)
        {
            _articleBytes[articleId] = payload;
            SeedPolicy(CachePolicyId.ArticleDetail, articleId.ToString(), payload);
        }

        public void SeedPolicy(CachePolicyId policyId, string identity, byte[] payload)
        {
            Assert.True(_policies.TryGet(policyId, out CachePolicy policy));
            LocalCache.Set(
                policy,
                CacheL1Key.ForString("default", policyId, identity),
                policy.BuildKey(identity),
                payload);
        }

        public bool TryGetL1(CachePolicyId policyId, string identity)
            => LocalCache.TryGet(CacheL1Key.ForString("default", policyId, identity), out _);

        public byte[] ArticleBytes(int articleId)
            => _articleBytes[articleId];

        public void PublishSnapshot(int[] articles, bool category, bool seoHtml)
            => HotRead.Publish(CreateSnapshot(articles, category, seoHtml));

        public ValueTask DisposeAsync()
        {
            _memory.Dispose();
            return ValueTask.CompletedTask;
        }
    }

    private sealed class TerminalFragmentProjector : IPublicHotArtifactProjector
    {
        public Task<PublicHotReadSnapshot> BuildInitialSnapshotAsync(CancellationToken cancellationToken)
            => throw new InvalidDataException("fragment-rebuild-failed");

        public Task<PublicHotReadSnapshot> RebuildAfterArticleMutationAsync(
            PublicHotReadSnapshot current,
            int articleId,
            CancellationToken cancellationToken)
            => throw new InvalidDataException("fragment-rebuild-failed");

        public Task<PublicHotReadSnapshot> RebuildAfterViewProjectionAsync(
            PublicHotReadSnapshot current,
            IReadOnlyCollection<int> articleIds,
            CancellationToken cancellationToken)
            => throw new InvalidDataException("fragment-rebuild-failed");
    }

    private sealed class NoopRevocations : IPublicArtifactRevocationCoordinator
    {
        public long CurrentGeneration => 0;
        public Task BeginArticleMutationFenceAsync(int articleId, CancellationToken cancellationToken = default)
            => Task.CompletedTask;
        public Task BeginGlobalMutationFenceAsync(CancellationToken cancellationToken = default)
            => Task.CompletedTask;
        public Task<bool> RecoverPendingMutationFenceAsync(
            PublicArtifactTombstone tombstone,
            CancellationToken cancellationToken = default)
            => Task.FromResult(false);
        public Task RevokeArticleAsync(int articleId, CancellationToken cancellationToken = default)
            => Task.CompletedTask;
        public Task RevokeAllAsync(CancellationToken cancellationToken = default)
            => Task.CompletedTask;
        public Task CompleteRebuildAsync(
            IReadOnlyCollection<int>? articleIds,
            long maximumGeneration,
            CancellationToken cancellationToken = default)
            => Task.CompletedTask;
    }

    private sealed class TestWebHostEnvironment : IWebHostEnvironment
    {
        public string EnvironmentName
        {
            get;
            set;
        } = Environments.Development;
        public string ApplicationName
        {
            get;
            set;
        } = "FsusBlog.Server.Tests";
        public string WebRootPath
        {
            get;
            set;
        } = Path.GetTempPath();
        public IFileProvider WebRootFileProvider
        {
            get;
            set;
        } = new NullFileProvider();
        public string ContentRootPath
        {
            get;
            set;
        } = Path.GetTempPath();
        public IFileProvider ContentRootFileProvider
        {
            get;
            set;
        } = new NullFileProvider();
    }
}
