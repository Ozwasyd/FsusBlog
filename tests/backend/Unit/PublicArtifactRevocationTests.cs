using System.Net;
using System.Text.Json;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
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
    [InlineData("/api/binary/article/42.aeds")]
    [InlineData("/article/42")]
    [InlineData("/api/binary/article/list/home/1/10.aeds")]
    [InlineData("/api/binary/article/hot/10.aeds")]
    public async Task Middleware_RevokedArtifactReturnsGoneWithoutCallingNext(string path)
    {
        var registry = new PublicArtifactRevocationRegistry();
        registry.Apply(new PublicArtifactTombstone(42, 17, 100));
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

    [Theory]
    [InlineData("/api/binary/auth/login")]
    [InlineData("/api/binary/admin/cache")]
    [InlineData("/api/notification/stream")]
    public async Task Middleware_DoesNotInterceptAuthenticatedAdminOrNotificationRoutes(string path)
    {
        var registry = new PublicArtifactRevocationRegistry();
        registry.Apply(new PublicArtifactTombstone(0, 18, 100));
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
        Assert.Equal(tombstone with { PurgeConfirmed = true }, active);
        Assert.Equal(tombstone, Assert.Single(purger.Purged));
        Assert.Equal(2, state.Published.Count);
        Assert.False(state.Published[0].PurgeConfirmed);
        Assert.True(state.Published[1].PurgeConfirmed);
        Assert.All(state.Published, static revoke => Assert.Equal("revoke", revoke.Action));

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
        Assert.Equal(tombstone with { PurgeConfirmed = true }, Assert.Single(state.Cleared));
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
        var global = new PublicArtifactTombstone(0, 32, 100, PurgeConfirmed: true);
        var state = new FakeStateStore(global);
        var registry = new PublicArtifactRevocationRegistry();
        registry.Apply(global);
        var coordinator = new PublicArtifactRevocationCoordinator(state, registry, new FakeCdnPurger());

        await coordinator.CompleteRebuildAsync([42], coordinator.CurrentGeneration);
        Assert.True(registry.TryGet(0, out _));

        await coordinator.CompleteRebuildAsync(null, coordinator.CurrentGeneration);
        Assert.False(registry.TryGet(0, out _));
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
        var newer = stale with { Generation = 27, RevokedAtUnixMilliseconds = 200 };
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

    private static DefaultHttpContext CreateContext(string path)
    {
        var context = new DefaultHttpContext();
        context.Request.Method = HttpMethods.Get;
        context.Request.Path = path;
        context.Request.Headers.Accept = path.EndsWith(".aeds", StringComparison.Ordinal)
            ? "application/octet-stream"
            : "text/html";
        context.Response.Body = new MemoryStream();
        return context;
    }

    private sealed class FakeStateStore(PublicArtifactTombstone tombstone) : IPublicArtifactRevocationStateStore
    {
        private PublicArtifactTombstone _current = tombstone;
        public List<PublicArtifactRevocationMessage> Published { get; } = [];
        public List<PublicArtifactTombstone> Cleared { get; } = [];

        public Task<PublicArtifactTombstone> BeginMutationFenceAsync(
            int articleId,
            CancellationToken cancellationToken)
        {
            if (_current.TransitionPending || !_current.PurgeConfirmed)
            {
                throw new InvalidOperationException("public artifact mutation fence is already active");
            }

            _current = new PublicArtifactTombstone(
                articleId,
                _current.Generation + 1,
                _current.RevokedAtUnixMilliseconds + 1,
                PurgeConfirmed: false,
                TransitionPending: true);
            return Task.FromResult(_current);
        }

        public Task<PublicArtifactTombstone> RevokeArticleAsync(int articleId, CancellationToken cancellationToken)
        {
            _current = _current with { ArticleId = articleId };
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

            _current = value with { TransitionPending = false };
            return Task.FromResult<PublicArtifactTombstone?>(_current);
        }

        public Task<IReadOnlyList<PublicArtifactTombstone>> LoadActiveAsync(CancellationToken cancellationToken)
            => Task.FromResult<IReadOnlyList<PublicArtifactTombstone>>([]);

        public Task<PublicArtifactTombstone> ConfirmPurgeAsync(
            PublicArtifactTombstone value,
            CancellationToken cancellationToken)
        {
            _current = value with { PurgeConfirmed = true };
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
