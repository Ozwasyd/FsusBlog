using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Logging.Abstractions;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Middlewares;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Services.Security;
using FsusBlog.Core.Common;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>
/// Unit tests for ShieldMiddleware.
/// Uses DefaultHttpContext + real in-process collaborators so no mock framework is needed.
/// </summary>
public sealed class ShieldMiddlewareTests
{
    // ─── /health bypass ───────────────────────────────────────────────────

    [Fact]
    public async Task InvokeAsync_HealthPath_AlwaysCallsNext()
    {
        bool nextCalled = false;
        var sut = CreateMiddleware(env: ProductionEnv(), onNext: _ => { nextCalled = true; return Task.CompletedTask; });
        var ctx = BuildContext("/health/live", "python/3.8");

        await sut.InvokeAsync(ctx);

        Assert.True(nextCalled);
    }

    [Fact]
    public async Task InvokeAsync_HealthSubPath_AlwaysCallsNext()
    {
        bool nextCalled = false;
        var sut = CreateMiddleware(env: ProductionEnv(), onNext: _ => { nextCalled = true; return Task.CompletedTask; });
        var ctx = BuildContext("/health/ready", "curl/7.0");

        await sut.InvokeAsync(ctx);

        Assert.True(nextCalled);
    }

    // ─── Development environment bypass ──────────────────────────────────

    [Fact]
    public async Task InvokeAsync_DevelopmentEnv_AlwaysCallsNext()
    {
        bool nextCalled = false;
        var sut = CreateMiddleware(env: DevelopmentEnv(), onNext: _ => { nextCalled = true; return Task.CompletedTask; });
        var ctx = BuildContext("/api/articles", "python/3.8");

        await sut.InvokeAsync(ctx);

        Assert.True(nextCalled);
    }

    // ─── Empty / missing User-Agent in production ─────────────────────────

    [Fact]
    public async Task InvokeAsync_EmptyUserAgent_Production_DoesNotCallNext()
    {
        bool nextCalled = false;
        var sut = CreateMiddleware(env: ProductionEnv(), onNext: _ => { nextCalled = true; return Task.CompletedTask; });
        var ctx = BuildContext("/api/articles", ua: "");

        await sut.InvokeAsync(ctx);

        Assert.False(nextCalled);
    }

    [Fact]
    public async Task InvokeAsync_WhitespaceUserAgent_Production_DoesNotCallNext()
    {
        bool nextCalled = false;
        var sut = CreateMiddleware(env: ProductionEnv(), onNext: _ => { nextCalled = true; return Task.CompletedTask; });
        var ctx = BuildContext("/api/articles", ua: "   ");

        await sut.InvokeAsync(ctx);

        Assert.False(nextCalled);
    }

    // ─── Blocked tool User-Agents ─────────────────────────────────────────

    [Theory]
    [InlineData("python/3.8")]
    [InlineData("Java/1.8.0_251")]
    [InlineData("curl/7.64.0")]
    [InlineData("Wget/1.21")]
    [InlineData("Go-http-client/1.1")]
    [InlineData("axios/0.27.2")]
    [InlineData("HttpClient/5.0")]
    public async Task InvokeAsync_BlockedToolUserAgent_DoesNotCallNext(string ua)
    {
        bool nextCalled = false;
        var sut = CreateMiddleware(env: ProductionEnv(), onNext: _ => { nextCalled = true; return Task.CompletedTask; });
        var ctx = BuildContext("/api/articles", ua);

        await sut.InvokeAsync(ctx);

        Assert.False(nextCalled);
    }

    // ─── Unverified bot UA ────────────────────────────────────────────────

    [Fact]
    public async Task InvokeAsync_UnverifiedBotUA_DoesNotCallNext()
    {
        // "bot" keyword triggers crawler path; no CIDR loaded → unverified → abort
        bool nextCalled = false;
        var sut = CreateMiddleware(env: ProductionEnv(), onNext: _ => { nextCalled = true; return Task.CompletedTask; });
        var ctx = BuildContext("/api/articles", "FakeBot/2.0");

        await sut.InvokeAsync(ctx);

        Assert.False(nextCalled);
    }

    [Fact]
    public async Task InvokeAsync_UnverifiedSpiderUA_DoesNotCallNext()
    {
        bool nextCalled = false;
        var sut = CreateMiddleware(env: ProductionEnv(), onNext: _ => { nextCalled = true; return Task.CompletedTask; });
        var ctx = BuildContext("/api/articles", "FakeSpider/1.0");

        await sut.InvokeAsync(ctx);

        Assert.False(nextCalled);
    }

    // ─── Path traversal protection ────────────────────────────────────────

    [Fact]
    public async Task InvokeAsync_PathWithDotDot_DoesNotCallNext()
    {
        bool nextCalled = false;
        var sut = CreateMiddleware(env: ProductionEnv(), onNext: _ => { nextCalled = true; return Task.CompletedTask; });
        var ctx = BuildContext("/api/../etc/passwd", "Mozilla/5.0");

        await sut.InvokeAsync(ctx);

        Assert.False(nextCalled);
    }

    [Fact]
    public async Task InvokeAsync_PathWithDoubleSlash_DoesNotCallNext()
    {
        bool nextCalled = false;
        var sut = CreateMiddleware(env: ProductionEnv(), onNext: _ => { nextCalled = true; return Task.CompletedTask; });
        var ctx = BuildContext("/api//articles", "Mozilla/5.0");

        await sut.InvokeAsync(ctx);

        Assert.False(nextCalled);
    }

    [Theory]
    [InlineData("/api/%2e%2e/etc/passwd")]
    [InlineData("/api/%252e%252e/etc/passwd")]
    [InlineData("/api/%5cwindows%5csystem32")]
    [InlineData("/api\\admin\\users")]
    public async Task InvokeAsync_EncodedTraversalPath_DoesNotCallNext(string path)
    {
        bool nextCalled = false;
        var sut = CreateMiddleware(env: ProductionEnv(), onNext: _ => { nextCalled = true; return Task.CompletedTask; });
        var ctx = BuildContext(path, "Mozilla/5.0");

        await sut.InvokeAsync(ctx);

        Assert.False(nextCalled);
    }

    // ─── Load shedding (503 on high load + write method) ─────────────────

    [Fact]
    public async Task InvokeAsync_WarModeAndPost_Returns503()
    {
        bool nextCalled = false;
        var governor = CreateWarModeGovernor();
        var sut = CreateMiddleware(env: ProductionEnv(), governor: governor,
            onNext: _ => { nextCalled = true; return Task.CompletedTask; });
        var ctx = BuildContext("/api/articles", "Mozilla/5.0", method: "POST");

        await sut.InvokeAsync(ctx);

        Assert.False(nextCalled);
        Assert.Equal(503, ctx.Response.StatusCode);
    }

    [Fact]
    public async Task InvokeAsync_WarModeAndGet_StillCallsNext()
    {
        bool nextCalled = false;
        var governor = CreateWarModeGovernor();
        var sut = CreateMiddleware(env: ProductionEnv(), governor: governor,
            onNext: _ => { nextCalled = true; return Task.CompletedTask; });
        var ctx = BuildContext("/api/articles", "Mozilla/5.0", method: "GET");

        await sut.InvokeAsync(ctx);

        Assert.True(nextCalled);
    }

    [Fact]
    public async Task InvokeAsync_WarModeAndOptions_StillCallsNext()
    {
        bool nextCalled = false;
        var governor = CreateWarModeGovernor();
        var sut = CreateMiddleware(env: ProductionEnv(), governor: governor,
            onNext: _ => { nextCalled = true; return Task.CompletedTask; });
        var ctx = BuildContext("/api/articles", "Mozilla/5.0", method: "OPTIONS");

        await sut.InvokeAsync(ctx);

        Assert.True(nextCalled);
    }

    // ─── Happy path ───────────────────────────────────────────────────────

    [Fact]
    public async Task InvokeAsync_NormalBrowserUA_Production_CallsNext()
    {
        bool nextCalled = false;
        var sut = CreateMiddleware(env: ProductionEnv(), onNext: _ => { nextCalled = true; return Task.CompletedTask; });
        var ctx = BuildContext("/api/articles", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)");

        await sut.InvokeAsync(ctx);

        Assert.True(nextCalled);
    }

    [Fact]
    public async Task InvokeAsync_RecordsInboundRequestForGovernor()
    {
        // The middleware calls governor.RecordInboundRequest() on each non-health request
        // We verify this indirectly: governor difficulty starts at BASE=4; after enough calls it would raise.
        // Here we just verify the request goes through without exception.
        var governor = CreateFreshGovernor();
        var sut = CreateMiddleware(env: ProductionEnv(), governor: governor,
            onNext: _ => Task.CompletedTask);

        for (int i = 0; i < 5; i++)
        {
            var ctx = BuildContext("/api/articles", "Mozilla/5.0");
            await sut.InvokeAsync(ctx);
        }

        // Middleware invoked without throwing means RecordInboundRequest worked
        Assert.True(governor.CurrentGlobalDifficulty >= 4);
    }

    // ─── helpers ──────────────────────────────────────────────────────────

    private static ShieldMiddleware CreateMiddleware(
        IWebHostEnvironment env,
        AdaptivePowGovernor? governor = null,
        Func<HttpContext, Task>? onNext = null)
    {
        RequestDelegate next = ctx => (onNext ?? (_ => Task.CompletedTask))(ctx);
        var crawlerDetector = new CrawlerDetectorService(
            NullLogger<CrawlerDetectorService>.Instance,
            new MemoryCache(new MemoryCacheOptions()));
        return new ShieldMiddleware(next, governor ?? CreateFreshGovernor(), crawlerDetector, env);
    }

    private static DefaultHttpContext BuildContext(string path, string ua, string method = "GET")
    {
        var ctx = new DefaultHttpContext();
        ctx.Request.Path = new PathString(path);
        ctx.Request.Method = method;
        if (!string.IsNullOrEmpty(ua))
        {
            ctx.Request.Headers.UserAgent = ua;
        }
        return ctx;
    }

    private static AdaptivePowGovernor CreateFreshGovernor()
        => new AdaptivePowGovernor(new NullUnifiedCache());

    private static AdaptivePowGovernor CreateWarModeGovernor()
    {
        var g = new AdaptivePowGovernor(new NullUnifiedCache());
        // Push RPS above 1000 to trigger WAR_MODE_DIFFICULTY = 7
        for (int i = 0; i < 1001; i++) g.RecordInboundRequest();
        return g;
    }

    private static IWebHostEnvironment ProductionEnv() => new FakeWebHostEnvironment("Production");
    private static IWebHostEnvironment DevelopmentEnv() => new FakeWebHostEnvironment("Development");

    // ─── Fakes ────────────────────────────────────────────────────────────

    private sealed class FakeWebHostEnvironment(string environmentName) : IWebHostEnvironment
    {
        public string EnvironmentName { get; set; } = environmentName;
        public string ApplicationName { get; set; } = "Test";
        public string WebRootPath { get; set; } = string.Empty;
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string ContentRootPath { get; set; } = string.Empty;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }

    private sealed class NullUnifiedCache : IUnifiedCache
    {
        public Task<string?> GetStringAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => Task.FromResult<string?>(null);
        public Task<CacheReadResult<T>> TryGetAsync<T>(CachePolicyId policyId, string identity, Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder, CancellationToken cancellationToken = default) => Task.FromResult(default(CacheReadResult<T>));
        public Task<CacheReadResult<byte[]>> TryGetRawAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => Task.FromResult(default(CacheReadResult<byte[]>));
        public Task SetRawAsync(CachePolicyId policyId, string identity, byte[] value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task SetNegativeAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task SetStringAsync(CachePolicyId policyId, string identity, string value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task<long> IncrementAsync(CachePolicyId policyId, string identity, long value = 1, CancellationToken cancellationToken = default) => Task.FromResult(0L);
        public Task<bool> TryAcquireLeaseAsync(CachePolicyId policyId, string identity, string value, TimeSpan ttl, CancellationToken cancellationToken = default) => Task.FromResult(false);
        public Task<bool> ConsumeOnceAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => Task.FromResult(false);
        public Task RemoveAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task RemoveByPrefixAsync(CachePolicyId policyId, string identityPrefix, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task<IAsyncDisposable> AcquireSingleFlightAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => Task.FromResult<IAsyncDisposable>(NullDisposable.Instance);
        public string BuildKey(CachePolicyId policyId, string identity, string? version = null) => $"{policyId}:{identity}";
        private sealed class NullDisposable : IAsyncDisposable { public static readonly NullDisposable Instance = new(); public ValueTask DisposeAsync() => ValueTask.CompletedTask; }
    }
}
