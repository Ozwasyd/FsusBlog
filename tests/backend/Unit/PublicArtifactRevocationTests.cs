using System.Collections.Concurrent;
using System.Net;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Options;
namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicArtifactRevocationTests
{
    [Fact]
    public void Registry_RejectsStaleApplyAndClearForNewerGeneration()
    {
        var registry = new PublicArtifactRevocationRegistry();
        var first = new PublicArtifactTombstone(42, 10, 100);
        var newer = new PublicArtifactTombstone(42, 11, 200);

        registry.Apply(first);
        registry.Apply(newer);
        registry.Clear(first);
        registry.Apply(first);

        Assert.True(registry.TryGet(42, out PublicArtifactTombstone active));
        Assert.Equal(newer, active);
        Assert.Equal(11, registry.CurrentGeneration);

        registry.Clear(newer);
        registry.Apply(newer);
        Assert.False(registry.TryGet(42, out _));
    }

    [Theory]
    [InlineData("/api/binary/article/42.aeds", 42)]
    [InlineData("/article/42", 42)]
    [InlineData("/api/binary/article/list/home/1/10.aeds", 0)]
    [InlineData("/api/binary/article/hot/10.aeds", 0)]
    public async Task Middleware_RevokedArtifactReturnsGoneWithoutCallingNext(string path, int tombstoneArticleId)
    {
        var registry = new PublicArtifactRevocationRegistry();
        registry.Apply(tombstoneArticleId > 0
            ? new PublicArtifactTombstone(tombstoneArticleId, 17, 100)
            : PublicArtifactTombstone.ForGlobal(17, 100));
        DefaultHttpContext context = CreateContext(path);
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
        Assert.Equal("17", context.Response.Headers["X-Fsus-Generation"]);
        Assert.Equal("g17", context.Response.Headers["X-Fsus-Revoked"]);
        Assert.False(context.Response.Headers.ContainsKey("ETag"));
        Assert.False(context.Response.Headers.ContainsKey("Content-Encoding"));
        Assert.Equal(0, context.Response.ContentLength);
        Assert.Empty(((MemoryStream)context.Response.Body).ToArray());
    }

    [Fact]
    public async Task Middleware_MissingClassifierFeatureDoesNotReclassifyRequest()
    {
        var registry = new PublicArtifactRevocationRegistry();
        registry.Apply(PublicArtifactTombstone.ForGlobal(18, 100));
        DefaultHttpContext context = CreateContext("/api/binary/article/42.aeds", attachFeature: false);
        bool nextCalled = false;

        await PublicArtifactRevocationMiddleware.TryHandleAsync(
            context,
            _ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            },
            registry);

        Assert.True(nextCalled);
        Assert.False(context.Response.Headers.ContainsKey("X-Fsus-Revoked"));
    }

    [Fact]
    public async Task Registry_ExactTombstoneDoesNotApplyToUnrelatedOrAggregateRoutes()
    {
        var registry = new PublicArtifactRevocationRegistry();
        registry.Apply(new PublicArtifactTombstone(42, 19, 100));
        DefaultHttpContext unrelated = CreateContext("/api/binary/article/43.aeds");
        DefaultHttpContext aggregate = CreateContext("/api/binary/article/hot/10.aeds");
        int nextCalls = 0;

        await PublicArtifactRevocationMiddleware.TryHandleAsync(
            unrelated,
            _ =>
            {
                nextCalls++;
                return Task.CompletedTask;
            },
            registry);
        await PublicArtifactRevocationMiddleware.TryHandleAsync(
            aggregate,
            _ =>
            {
                nextCalls++;
                return Task.CompletedTask;
            },
            registry);

        Assert.Equal(2, nextCalls);
        PublicArtifactRevocationRegistrySnapshot snapshot = registry.MetricsSnapshot();
        Assert.Equal(1, snapshot.ActiveCount);
        Assert.Equal(2, snapshot.Misses);
        Assert.Equal(0, snapshot.GlobalHits);
    }

    [Fact]
    public async Task Registry_HighCardinalityLookupRemainsExactAndDoesNotScanForLatestGeneration()
    {
        var registry = new PublicArtifactRevocationRegistry();
        for (int articleId = 1; articleId <= 100_000; articleId++)
        {
            registry.Apply(new PublicArtifactTombstone(articleId, articleId, articleId));
        }

        DefaultHttpContext missing = CreateContext("/api/binary/article/100001.aeds");
        bool nextCalled = false;
        await PublicArtifactRevocationMiddleware.TryHandleAsync(
            missing,
            _ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            },
            registry);

        Assert.True(nextCalled);
        PublicArtifactRevocationRegistrySnapshot snapshot = registry.MetricsSnapshot();
        Assert.Equal(100_000, snapshot.ActiveCount);
        Assert.Equal(1, snapshot.Misses);
        Assert.Equal(0, snapshot.ExactHits);
    }

    [Fact]
    public void Registry_RequiresProtocolExplicitGlobalAndScopeTargets()
    {
        var registry = new PublicArtifactRevocationRegistry();

        registry.Apply(new PublicArtifactTombstone(0, 17, 100));
        registry.Apply(PublicArtifactTombstone.ForScope(PublicArtifactRevocationScope.None, 18, 100));

        Assert.Empty(registry.Snapshot());
        Assert.Equal(0, registry.MetricsSnapshot().Applies);
    }

    [Fact]
    public void Registry_ExactGlobalScopeAndMissMatrixUsesFixedPriority()
    {
        var registry = new PublicArtifactRevocationRegistry();
        var exact = new PublicArtifactTombstone(42, 10, 100);
        PublicArtifactTombstone global = PublicArtifactTombstone.ForGlobal(20, 200);
        PublicArtifactTombstone scope = PublicArtifactTombstone.ForScope(
            PublicArtifactRevocationScope.ArticleDetail,
            30,
            300);
        registry.Apply(exact);
        registry.Apply(global);
        registry.Apply(scope);

        AssertResolved(registry, "/api/binary/article/42.aeds", exact);
        AssertResolved(registry, "/api/binary/article/43.aeds", global);

        registry.Clear(global);

        AssertResolved(registry, "/api/binary/article/43.aeds", scope);
        AssertNotResolved(registry, "/api/binary/category.aeds");
        PublicArtifactRevocationRegistrySnapshot snapshot = registry.MetricsSnapshot();
        Assert.Equal(1, snapshot.ExactHits);
        Assert.Equal(1, snapshot.GlobalHits);
        Assert.Equal(1, snapshot.ScopeHits);
        Assert.Equal(1, snapshot.Misses);
    }

    [Theory]
    [InlineData("/api/binary/category.aeds", PublicArtifactRevocationScope.Category)]
    [InlineData("/api/binary/tag.aeds", PublicArtifactRevocationScope.Tag)]
    [InlineData("/api/binary/article/42.aeds", PublicArtifactRevocationScope.ArticleDetail)]
    [InlineData("/api/binary/article/list/home/1/10.aeds", PublicArtifactRevocationScope.ArticleList)]
    [InlineData("/api/binary/article/hot/10.aeds", PublicArtifactRevocationScope.ArticleHot)]
    [InlineData("/api/binary/article/featured/4.aeds", PublicArtifactRevocationScope.ArticleFeatured)]
    [InlineData("/api/binary/article/html/home.html", PublicArtifactRevocationScope.ArticleHtml)]
    [InlineData("/", PublicArtifactRevocationScope.PublicHtml)]
    public void Registry_ProtocolScopeMatchesClassifierRouteIdentity(
        string path,
        PublicArtifactRevocationScope scope)
    {
        var registry = new PublicArtifactRevocationRegistry();
        PublicArtifactTombstone tombstone = PublicArtifactTombstone.ForScope(scope, 35, 100);
        registry.Apply(tombstone);

        AssertResolved(registry, path, tombstone);
        Assert.Equal(1, registry.MetricsSnapshot().ScopeHits);
    }

    [Fact]
    public void Registry_ApplyClearDuplicateAndOutOfOrderRemainConsistentForEveryIndex()
    {
        PublicArtifactTombstone[] initial =
        [
            new PublicArtifactTombstone(42, 10, 100, TransitionPending: true),
            PublicArtifactTombstone.ForGlobal(10, 100, transitionPending: true),
            PublicArtifactTombstone.ForScope(
                PublicArtifactRevocationScope.ArticleHot,
                10,
                100,
                transitionPending: true)
        ];

        foreach (PublicArtifactTombstone first in initial)
        {
            var registry = new PublicArtifactRevocationRegistry();
            PublicArtifactTombstone duplicate = first with
            {
                PurgeConfirmed = true,
                TransitionPending = false
            };
            PublicArtifactTombstone stale = first with
            {
                Generation = 9
            };
            PublicArtifactTombstone newer = duplicate with
            {
                Generation = 11
            };
            PublicArtifactTombstone newest = duplicate with
            {
                Generation = 12
            };

            registry.Apply(first);
            registry.Apply(duplicate);
            Assert.Equal(duplicate, Assert.Single(registry.Snapshot()));

            registry.Clear(stale);
            registry.Apply(stale);
            Assert.Equal(duplicate, Assert.Single(registry.Snapshot()));

            registry.Apply(newer);
            registry.Clear(duplicate);
            Assert.Equal(newer, Assert.Single(registry.Snapshot()));

            registry.Clear(newer);
            registry.Apply(newer);
            Assert.Empty(registry.Snapshot());

            registry.Apply(newest);
            Assert.Equal(newest, Assert.Single(registry.Snapshot()));
            Assert.Equal(12, registry.CurrentGeneration);
            Assert.Equal(1, registry.MetricsSnapshot().ActiveCount);
        }
    }

    [Fact]
    public void Registry_ConcurrentApplyClearAndLookupLinearizesAtHighestGeneration()
    {
        var registry = new PublicArtifactRevocationRegistry();
        PublicHotReadRoute route = ResolveRoute("/api/binary/article/42.aeds");
        var failures = new ConcurrentQueue<string>();

        Parallel.For(1, 2_001, generation =>
        {
            PublicArtifactTombstone tombstone = new(42, generation, generation);
            registry.Apply(tombstone);
            if (registry.TryResolve(route, out PublicArtifactTombstone observed)
                && observed.Target != PublicArtifactRevocationTarget.ForArticle(42))
            {
                failures.Enqueue($"unexpected target {observed.Target}");
            }

            if ((generation & 1) == 0)
            {
                registry.Clear(tombstone);
            }
        });

        Assert.Empty(failures);
        Assert.False(registry.TryResolve(route, out _));
        Assert.Empty(registry.Snapshot());
        Assert.Equal(2_000, registry.CurrentGeneration);
        Assert.Equal(0, registry.MetricsSnapshot().ActiveCount);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(10_000)]
    [InlineData(100_000)]
    public void Registry_LookupAllocationBudgetIsIndependentOfActiveCount(int activeCount)
    {
        var registry = new PublicArtifactRevocationRegistry();
        for (int articleId = 1; articleId <= activeCount; articleId++)
        {
            registry.Apply(new PublicArtifactTombstone(articleId, articleId + 1L, articleId));
        }
        PublicHotReadRoute route = ResolveRoute("/api/binary/article/200001.aeds");
        for (int index = 0; index < 256; index++)
        {
            _ = registry.TryResolve(route, out _);
        }

        long before = GC.GetAllocatedBytesForCurrentThread();
        bool resolved = false;
        for (int index = 0; index < 4_096; index++)
        {
            resolved |= registry.TryResolve(route, out _);
        }
        long allocated = GC.GetAllocatedBytesForCurrentThread() - before;

        Assert.False(resolved);
        Assert.Equal(activeCount, registry.MetricsSnapshot().ActiveCount);
        Assert.True(allocated <= 512, $"lookup allocated {allocated} bytes with {activeCount} active tombstones");
    }

    [Fact]
    public async Task Middleware_GetHeadRangeAndQueryKeepSingleClassificationAndGoneContract()
    {
        foreach (string method in new[] { HttpMethods.Get, HttpMethods.Head })
        {
            foreach ((string? range, string? query) in new (string?, string?)[]
            {
                (null, null),
                ("bytes=0-1", null),
                (null, "?preview=1")
            })
            {
                var registry = new PublicArtifactRevocationRegistry();
                registry.Apply(new PublicArtifactTombstone(42, 40, 100));
                DefaultHttpContext context = CreateContext("/api/binary/article/42.aeds");
                context.Request.Method = method;
                context.Request.Headers.Range = range;
                context.Request.QueryString = new QueryString(query);
                context.Response.Headers.ETag = "\"old\"";
                context.Response.Headers.ContentEncoding = "gzip";
                PublicHotReadRequestFeature feature = Assert.IsType<PublicHotReadRequestFeature>(
                    context.Features.Get<PublicHotReadRequestFeature>());

                await PublicArtifactRevocationMiddleware.TryHandleAsync(
                    context,
                    _ => throw new InvalidOperationException("revoked request must not continue"),
                    registry);

                Assert.Equal(1, feature.ClassificationCount);
                Assert.Equal(StatusCodes.Status410Gone, context.Response.StatusCode);
                Assert.Equal("no-store, no-cache, must-revalidate", context.Response.Headers.CacheControl);
                Assert.Equal("none", context.Response.Headers.AcceptRanges);
                Assert.Equal("40", context.Response.Headers["X-Fsus-Generation"]);
                Assert.Equal("g40", context.Response.Headers["X-Fsus-Revoked"]);
                Assert.False(context.Response.Headers.ContainsKey("ETag"));
                Assert.False(context.Response.Headers.ContainsKey("Content-Encoding"));
                Assert.Equal(0, context.Response.ContentLength);
                Assert.Empty(((MemoryStream)context.Response.Body).ToArray());
            }
        }
    }

    [Fact]
    public async Task Middleware_CredentialBearingRequestBypassesClassifierAndRevocation()
    {
        var registry = new PublicArtifactRevocationRegistry();
        registry.Apply(PublicArtifactTombstone.ForGlobal(41, 100));
        DefaultHttpContext context = CreateContext("/api/binary/article/42.aeds", attachFeature: false);
        context.Request.Headers.Authorization = "Bearer credential";

        Assert.False(PublicHotReadFastPath.TryCreateRequestFeatureForTests(
            context,
            out PublicHotReadRequestFeature? feature,
            out _,
            out bool credentialBypass));
        Assert.Null(feature);
        Assert.True(credentialBypass);
        bool nextCalled = false;

        await PublicArtifactRevocationMiddleware.TryHandleAsync(
            context,
            _ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            },
            registry);

        Assert.True(nextCalled);
        Assert.False(context.Response.Headers.ContainsKey("X-Fsus-Revoked"));
    }

    [Fact]
    public void RevocationReadPath_HasNoClassifierCallOrValuesScan()
    {
        string source = File.ReadAllText(BackendTestPaths.FromRoot(
            "src",
            "backend",
            "Infrastructure",
            "PublicReadArtifacts",
            "PublicArtifactRevocation.cs"));
        string registry = Slice(
            source,
            "public sealed class PublicArtifactRevocationRegistry",
            "public readonly record struct PublicArtifactRevocationRegistrySnapshot");
        string lookup = Slice(
            registry,
            "internal bool TryResolve",
            "internal PublicArtifactRevocationRegistrySnapshot MetricsSnapshot");
        string middleware = source[source.IndexOf(
            "public static class PublicArtifactRevocationMiddleware",
            StringComparison.Ordinal)..];
        string observabilityRegistration = File.ReadAllText(BackendTestPaths.FromRoot(
            "src",
            "backend",
            "Infrastructure",
            "Observability",
            "FsusObservabilityServiceCollectionExtensions.cs"));

        Assert.DoesNotContain("TryCreateRequestFeature", middleware, StringComparison.Ordinal);
        Assert.DoesNotContain(".Values", lookup, StringComparison.Ordinal);
        Assert.DoesNotContain(
            "ConcurrentDictionary<int, PublicArtifactTombstone> _active",
            registry,
            StringComparison.Ordinal);
        Assert.DoesNotContain("legacy", registry, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("fsus.public_artifact_revocation.lookup.hit", registry, StringComparison.Ordinal);
        Assert.Contains("fsus.public_artifact_revocation.lookup.miss", registry, StringComparison.Ordinal);
        Assert.Contains("fsus.public_artifact_revocation.lookup.duration", registry, StringComparison.Ordinal);
        Assert.Contains("fsus.public_artifact_revocation.apply", registry, StringComparison.Ordinal);
        Assert.Contains("fsus.public_artifact_revocation.clear", registry, StringComparison.Ordinal);
        Assert.Contains("fsus.public_artifact_revocation.active.count", registry, StringComparison.Ordinal);
        Assert.Contains(
            "PublicArtifactRevocationRegistry.MeterName",
            observabilityRegistration,
            StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("/api/binary/auth/login")]
    [InlineData("/api/binary/admin/cache")]
    [InlineData("/api/notification/stream")]
    public async Task Middleware_DoesNotInterceptAuthenticatedAdminOrNotificationRoutes(string path)
    {
        var registry = new PublicArtifactRevocationRegistry();
        registry.Apply(PublicArtifactTombstone.ForGlobal(18, 100));
        DefaultHttpContext context = CreateContext(path);
        bool nextCalled = false;

        await PublicArtifactRevocationMiddleware.TryHandleAsync(
            context,
            ctx =>
            {
                nextCalled = true;
                ctx.Response.StatusCode = StatusCodes.Status202Accepted;
                return Task.CompletedTask;
            },
            registry);

        Assert.True(nextCalled);
        Assert.Equal(StatusCodes.Status202Accepted, context.Response.StatusCode);
        Assert.False(context.Response.Headers.ContainsKey("X-Fsus-Revoked"));
    }

    [Fact]
    public async Task Coordinator_PublishesEdgeMarkerPurgesCdnAndClearsOnlyAfterRebuild()
    {
        var tombstone = new PublicArtifactTombstone(42, 21, 100);
        var state = new FakeStateStore(tombstone);
        var registry = new PublicArtifactRevocationRegistry();
        var purger = new FakeCdnPurger();
        var coordinator = new PublicArtifactRevocationCoordinator(state, registry, purger);

        await coordinator.RevokeArticleAsync(42);

        Assert.True(registry.TryGet(42, out PublicArtifactTombstone active));
        Assert.Equal(tombstone with
        {
            PurgeConfirmed = true
        }, active);
        Assert.Equal(tombstone, Assert.Single(purger.Purged));
        Assert.Equal(2, state.Published.Count);
        Assert.False(state.Published[0].PurgeConfirmed);
        Assert.True(state.Published[1].PurgeConfirmed);
        Assert.All(state.Published, static revoke => Assert.Equal("revoke", revoke.Action));
        Assert.All(state.Published, static revoke =>
        {
            Assert.Equal(PublicArtifactRevocationTargetKind.ExactArticle, revoke.TargetKind);
            Assert.Equal(PublicArtifactRevocationScope.None, revoke.Scope);
        });

        DefaultHttpContext blocked = CreateContext("/api/binary/article/42.aeds");
        bool oldSnapshotReached = false;
        await PublicArtifactRevocationMiddleware.TryHandleAsync(
            blocked,
            _ =>
            {
                oldSnapshotReached = true;
                return Task.CompletedTask;
            },
            registry);
        Assert.False(oldSnapshotReached);
        Assert.Equal(StatusCodes.Status410Gone, blocked.Response.StatusCode);

        await coordinator.CompleteRebuildAsync([42], coordinator.CurrentGeneration);

        Assert.False(registry.TryGet(42, out _));
        Assert.Equal(tombstone with
        {
            PurgeConfirmed = true
        }, Assert.Single(state.Cleared));
        Assert.DoesNotContain(state.Published, static message => message.Action == "clear");
        DefaultHttpContext rebuilt = CreateContext("/api/binary/article/42.aeds");
        bool rebuiltSnapshotReached = false;
        await PublicArtifactRevocationMiddleware.TryHandleAsync(
            rebuilt,
            _ =>
            {
                rebuiltSnapshotReached = true;
                return Task.CompletedTask;
            },
            registry);
        Assert.True(rebuiltSnapshotReached);
    }

    [Fact]
    public async Task Coordinator_GlobalRevocationPublishesExplicitTarget()
    {
        var state = new FakeStateStore(new PublicArtifactTombstone(42, 22, 100));
        var registry = new PublicArtifactRevocationRegistry();
        var coordinator = new PublicArtifactRevocationCoordinator(state, registry, new FakeCdnPurger());

        await coordinator.RevokeAllAsync();

        PublicArtifactTombstone global = Assert.Single(registry.Snapshot());
        Assert.Equal(PublicArtifactRevocationTarget.Global, global.Target);
        Assert.All(state.Published, static message =>
        {
            Assert.Equal(PublicArtifactRevocationTargetKind.Global, message.TargetKind);
            Assert.Equal(PublicArtifactRevocationScope.None, message.Scope);
        });
    }

    [Fact]
    public async Task Coordinator_OldRebuildCannotClearNewerGeneration()
    {
        var first = new PublicArtifactTombstone(42, 30, 100, PurgeConfirmed: true);
        var newer = new PublicArtifactTombstone(42, 31, 200, PurgeConfirmed: true);
        var state = new FakeStateStore(first);
        var registry = new PublicArtifactRevocationRegistry();
        registry.Apply(first);
        long rebuildGeneration = registry.CurrentGeneration;
        registry.Apply(newer);
        var coordinator = new PublicArtifactRevocationCoordinator(state, registry, new FakeCdnPurger());

        await coordinator.CompleteRebuildAsync([42], rebuildGeneration);

        Assert.True(registry.TryGet(42, out PublicArtifactTombstone active));
        Assert.Equal(newer, active);
        Assert.Empty(state.Cleared);
    }

    [Fact]
    public async Task Coordinator_GlobalTombstoneRequiresFullRebuild()
    {
        PublicArtifactTombstone global = PublicArtifactTombstone.ForGlobal(
            32,
            100,
            purgeConfirmed: true);
        var state = new FakeStateStore(global);
        var registry = new PublicArtifactRevocationRegistry();
        registry.Apply(global);
        var coordinator = new PublicArtifactRevocationCoordinator(state, registry, new FakeCdnPurger());

        await coordinator.CompleteRebuildAsync([42], coordinator.CurrentGeneration);
        Assert.Contains(global, registry.Snapshot());

        await coordinator.CompleteRebuildAsync(null, coordinator.CurrentGeneration);
        Assert.DoesNotContain(global, registry.Snapshot());
        Assert.Equal(global, Assert.Single(state.Cleared));
    }

    [Fact]
    public async Task Coordinator_CdnFailureLeavesTombstoneFailClosed()
    {
        var tombstone = new PublicArtifactTombstone(42, 22, 100);
        var state = new FakeStateStore(tombstone);
        var registry = new PublicArtifactRevocationRegistry();
        var coordinator = new PublicArtifactRevocationCoordinator(state, registry, new FakeCdnPurger(fail: true));

        await Assert.ThrowsAsync<HttpRequestException>(() => coordinator.RevokeArticleAsync(42));

        Assert.True(registry.TryGet(42, out PublicArtifactTombstone active));
        Assert.Equal(tombstone, active);
        Assert.Equal("revoke", Assert.Single(state.Published).Action);
        Assert.Empty(state.Cleared);
    }

    [Fact]
    public async Task Coordinator_PreCommitFenceCannotClearUntilCommitPromotesSameGeneration()
    {
        var tombstone = new PublicArtifactTombstone(
            42,
            25,
            100,
            PurgeConfirmed: true,
            TransitionPending: false);
        var state = new FakeStateStore(tombstone);
        var registry = new PublicArtifactRevocationRegistry();
        var coordinator = new PublicArtifactRevocationCoordinator(state, registry, new FakeCdnPurger());

        await coordinator.BeginArticleMutationFenceAsync(42);

        Assert.True(registry.TryGet(42, out PublicArtifactTombstone pending));
        Assert.True(pending.PurgeConfirmed);
        Assert.True(pending.TransitionPending);
        await coordinator.CompleteRebuildAsync([42], coordinator.CurrentGeneration);
        Assert.True(registry.TryGet(42, out _));
        Assert.Empty(state.Cleared);

        await coordinator.RevokeArticleAsync(42);
        Assert.True(registry.TryGet(42, out PublicArtifactTombstone committed));
        Assert.False(committed.TransitionPending);
        Assert.Equal(pending.Generation, committed.Generation);

        await coordinator.CompleteRebuildAsync([42], coordinator.CurrentGeneration);
        Assert.False(registry.TryGet(42, out _));
        Assert.Equal(committed, Assert.Single(state.Cleared));
    }

    [Fact]
    public async Task Coordinator_CommittedTombstoneDoesNotBlockNextMutationFence()
    {
        var committed = new PublicArtifactTombstone(
            42,
            25,
            100,
            PurgeConfirmed: true,
            TransitionPending: false);
        var state = new FakeStateStore(committed);
        var registry = new PublicArtifactRevocationRegistry();
        registry.Apply(committed);
        var coordinator = new PublicArtifactRevocationCoordinator(state, registry, new FakeCdnPurger());

        await coordinator.BeginArticleMutationFenceAsync(42);

        Assert.True(registry.TryGet(42, out PublicArtifactTombstone pending));
        Assert.Equal(26, pending.Generation);
        Assert.True(pending.PurgeConfirmed);
        Assert.True(pending.TransitionPending);
    }

    [Fact]
    public async Task Coordinator_RecoveryPromotesExactPendingGenerationForRebuild()
    {
        var pending = new PublicArtifactTombstone(
            42,
            26,
            100,
            PurgeConfirmed: true,
            TransitionPending: true);
        var state = new FakeStateStore(pending);
        var registry = new PublicArtifactRevocationRegistry();
        registry.Apply(pending);
        var coordinator = new PublicArtifactRevocationCoordinator(state, registry, new FakeCdnPurger());

        bool recovered = await coordinator.RecoverPendingMutationFenceAsync(pending);

        Assert.True(recovered);
        Assert.True(registry.TryGet(42, out PublicArtifactTombstone committed));
        Assert.Equal(26, committed.Generation);
        Assert.False(committed.TransitionPending);
        PublicArtifactRevocationMessage message = Assert.Single(state.Published);
        Assert.Equal(26, message.Generation);
        Assert.False(message.TransitionPending);
    }

    [Fact]
    public async Task Coordinator_RecoveryCannotOverwriteNewerGeneration()
    {
        var stale = new PublicArtifactTombstone(
            42,
            26,
            100,
            PurgeConfirmed: true,
            TransitionPending: true);
        var newer = stale with
        {
            Generation = 27,
            RevokedAtUnixMilliseconds = 200
        };
        var state = new FakeStateStore(newer);
        var registry = new PublicArtifactRevocationRegistry();
        registry.Apply(newer);
        var coordinator = new PublicArtifactRevocationCoordinator(state, registry, new FakeCdnPurger());

        bool recovered = await coordinator.RecoverPendingMutationFenceAsync(stale);

        Assert.False(recovered);
        Assert.True(registry.TryGet(42, out PublicArtifactTombstone active));
        Assert.Equal(newer, active);
        Assert.Empty(state.Published);
    }

    [Fact]
    public async Task HttpCdnPurger_SendsIdempotentGenerationAndArtifactPaths()
    {
        HttpRequestMessage? captured = null;
        string? body = null;
        var handler = new DelegateHttpMessageHandler(async (request, cancellationToken) =>
        {
            captured = request;
            body = await request.Content!.ReadAsStringAsync(cancellationToken);
            return new HttpResponseMessage(HttpStatusCode.Accepted);
        });
        var purger = new HttpPublicArtifactCdnPurger(
            new StubHttpClientFactory(handler),
            Options.Create(new PublicArtifactRevocationOptions
            {
                CdnPurgeEnabled = true,
                CdnPurgeEndpoint = "https://cdn.example.test/purge",
                CdnPurgeBearerToken = "secret"
            }));

        await purger.PurgeAsync(new PublicArtifactTombstone(42, 23, 100), CancellationToken.None);

        Assert.NotNull(captured);
        Assert.Equal(HttpMethod.Post, captured.Method);
        Assert.Equal("Bearer", captured.Headers.Authorization?.Scheme);
        Assert.Equal("secret", captured.Headers.Authorization?.Parameter);
        Assert.Contains("fsus-public-artifact-g23", captured.Headers.GetValues("Idempotency-Key"));
        using JsonDocument document = JsonDocument.Parse(body!);
        Assert.Equal(23, document.RootElement.GetProperty("generation").GetInt64());
        Assert.Equal("g23", document.RootElement.GetProperty("marker").GetString());
        Assert.Contains(
            document.RootElement.GetProperty("paths").EnumerateArray().Select(static item => item.GetString()),
            static path => path == "/api/binary/article/42.aeds");
    }

    [Fact]
    public async Task HttpCdnPurger_UsesCloudflareNativePurgeApi()
    {
        HttpRequestMessage? captured = null;
        string? body = null;
        var handler = new DelegateHttpMessageHandler(async (request, cancellationToken) =>
        {
            captured = request;
            body = await request.Content!.ReadAsStringAsync(cancellationToken);
            return new HttpResponseMessage(HttpStatusCode.OK);
        });
        var purger = new HttpPublicArtifactCdnPurger(
            new StubHttpClientFactory(handler),
            Options.Create(new PublicArtifactRevocationOptions
            {
                CdnPurgeEnabled = true,
                CdnProvider = "Cloudflare",
                CloudflareZoneId = "abc123",
                CdnPurgeBearerToken = "secret"
            }));

        await purger.PurgeAsync(new PublicArtifactTombstone(42, 24, 100), CancellationToken.None);

        Assert.Equal(
            "https://api.cloudflare.com/client/v4/zones/abc123/purge_cache",
            captured?.RequestUri?.AbsoluteUri);
        using JsonDocument document = JsonDocument.Parse(body!);
        Assert.True(document.RootElement.GetProperty("purge_everything").GetBoolean());
    }

    private static void AssertResolved(
        PublicArtifactRevocationRegistry registry,
        string path,
        PublicArtifactTombstone expected)
    {
        Assert.True(registry.TryResolve(ResolveRoute(path), out PublicArtifactTombstone actual));
        Assert.Equal(expected, actual);
    }

    private static void AssertNotResolved(PublicArtifactRevocationRegistry registry, string path)
        => Assert.False(registry.TryResolve(ResolveRoute(path), out _));

    private static PublicHotReadRoute ResolveRoute(string path)
    {
        DefaultHttpContext context = CreateContext(path);
        return Assert.IsType<PublicHotReadRequestFeature>(
            context.Features.Get<PublicHotReadRequestFeature>()).Route;
    }

    private static string Slice(string source, string startMarker, string endMarker)
    {
        int start = source.IndexOf(startMarker, StringComparison.Ordinal);
        int end = source.IndexOf(endMarker, start, StringComparison.Ordinal);
        Assert.True(start >= 0, $"missing start marker: {startMarker}");
        Assert.True(end > start, $"missing end marker: {endMarker}");
        return source[start..end];
    }

    private static DefaultHttpContext CreateContext(string path, bool attachFeature = true)
    {
        var context = new DefaultHttpContext();
        context.Request.Method = HttpMethods.Get;
        context.Request.Path = path;
        context.Request.Headers.Accept = path.EndsWith(".aeds", StringComparison.Ordinal)
            ? "application/octet-stream"
            : "text/html";
        context.Response.Body = new MemoryStream();
        if (attachFeature
            && PublicHotReadFastPath.TryCreateRequestFeatureForTests(
                context,
                out PublicHotReadRequestFeature? feature))
        {
            context.Features.Set(feature);
        }

        return context;
    }

    private sealed class FakeStateStore(PublicArtifactTombstone tombstone) : IPublicArtifactRevocationStateStore
    {
        private PublicArtifactTombstone _current = tombstone;
        public List<PublicArtifactRevocationMessage> Published { get; } = [];
        public List<PublicArtifactTombstone> Cleared { get; } = [];

        public Task<PublicArtifactTombstone> BeginMutationFenceAsync(
            PublicArtifactRevocationTarget target,
            CancellationToken cancellationToken)
        {
            if (_current.TransitionPending || !_current.PurgeConfirmed)
            {
                throw new InvalidOperationException("public artifact mutation fence is already active");
            }

            _current = new PublicArtifactTombstone(
                target.ArticleId,
                _current.Generation + 1,
                _current.RevokedAtUnixMilliseconds + 1,
                PurgeConfirmed: false,
                TransitionPending: true,
                TargetKind: target.Kind,
                Scope: target.Scope);
            return Task.FromResult(_current);
        }

        public Task<PublicArtifactTombstone> RevokeAsync(
            PublicArtifactRevocationTarget target,
            CancellationToken cancellationToken)
        {
            _current = _current with
            {
                ArticleId = target.ArticleId,
                TargetKind = target.Kind,
                Scope = target.Scope
            };
            return Task.FromResult(_current);
        }

        public Task<PublicArtifactTombstone?> MarkTransitionCommittedAsync(
            PublicArtifactTombstone value,
            CancellationToken cancellationToken)
        {
            if (_current.Generation != value.Generation)
            {
                return Task.FromResult<PublicArtifactTombstone?>(null);
            }

            _current = value with
            {
                TransitionPending = false
            };
            return Task.FromResult<PublicArtifactTombstone?>(_current);
        }

        public Task<IReadOnlyList<PublicArtifactTombstone>> LoadActiveAsync(CancellationToken cancellationToken)
            => Task.FromResult<IReadOnlyList<PublicArtifactTombstone>>([]);

        public Task<PublicArtifactTombstone> ConfirmPurgeAsync(
            PublicArtifactTombstone value,
            CancellationToken cancellationToken)
        {
            _current = value with
            {
                PurgeConfirmed = true
            };
            return Task.FromResult(_current);
        }

        public Task<bool> ClearAsync(PublicArtifactTombstone value, CancellationToken cancellationToken)
        {
            Cleared.Add(value);
            return Task.FromResult(true);
        }

        public Task PublishAsync(PublicArtifactRevocationMessage message, CancellationToken cancellationToken)
        {
            Published.Add(message);
            return Task.CompletedTask;
        }
    }

    private sealed class FakeCdnPurger(bool fail = false) : IPublicArtifactCdnPurger
    {
        public List<PublicArtifactTombstone> Purged { get; } = [];

        public Task PurgeAsync(PublicArtifactTombstone tombstone, CancellationToken cancellationToken)
        {
            Purged.Add(tombstone);
            return fail
                ? Task.FromException(new HttpRequestException("cdn unavailable"))
                : Task.CompletedTask;
        }
    }

    private sealed class StubHttpClientFactory(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
    }

    private sealed class DelegateHttpMessageHandler(
        Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> send) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
            => send(request, cancellationToken);
    }
}
