using System.Collections.Concurrent;
using System.Net;
using System.Security.Claims;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Middlewares;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Security;
using FsusBlog.Server.Services.Security;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AntiCrawlerPipelineTests
{
    [Fact]
    public async Task TestServer_PartitionsVerifiedCrawlerSocialPreviewAndOrdinaryReadsWhileRejectingFakeCrawler()
    {
        var sink = new CapturingRiskSink();
        await using WebApplication server = await CreateServerAsync(SecuritySystemModes.Enforce, sink);
        using HttpClient client = server.GetTestClient();

        Assert.Equal(HttpStatusCode.OK, (await SendAsync(client, "/article/42", "Googlebot/2.1", "66.249.64.1")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await SendAsync(client, "/article/42", "Googlebot/2.1", "66.249.64.1")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await SendAsync(client, "/article/42", "Googlebot/2.1", "66.249.64.1")).StatusCode);
        Assert.Equal(HttpStatusCode.TooManyRequests, (await SendAsync(client, "/article/42", "Googlebot/2.1", "66.249.64.1")).StatusCode);

        Assert.Equal(HttpStatusCode.OK, (await SendAsync(client, "/article/42", "Twitterbot/1.0", "198.51.100.10")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await SendAsync(client, "/article/42", "Twitterbot/1.0", "198.51.100.10")).StatusCode);
        Assert.Equal(HttpStatusCode.TooManyRequests, (await SendAsync(client, "/article/42", "Twitterbot/1.0", "198.51.100.10")).StatusCode);

        Assert.Equal(HttpStatusCode.OK, (await SendAsync(client, "/article/42", "Mozilla/5.0", "203.0.113.10")).StatusCode);
        Assert.Equal(HttpStatusCode.TooManyRequests, (await SendAsync(client, "/article/42", "Mozilla/5.0", "203.0.113.10")).StatusCode);

        HttpResponseMessage fakeCrawler = await SendAsync(client, "/article/42", "Googlebot/2.1", "203.0.113.20");
        Assert.Equal(HttpStatusCode.Forbidden, fakeCrawler.StatusCode);
        Assert.Contains(sink.Signals, static signal =>
            signal.Reason == SecurityRiskReason.FakeCrawler
            && signal.Detail == "fake_crawler");
    }

    [Theory]
    [InlineData(SecuritySystemModes.Observe, true)]
    [InlineData(SecuritySystemModes.Disabled, false)]
    public async Task TestServer_FakeCrawlerPassesInNonEnforcingModesWithExpectedRiskSignal(
        string mode,
        bool expectsSignal)
    {
        var sink = new CapturingRiskSink();
        await using WebApplication server = await CreateServerAsync(mode, sink);
        using HttpClient client = server.GetTestClient();

        HttpResponseMessage response = await SendAsync(client, "/article/43", "Googlebot/2.1", "203.0.113.30");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(
            expectsSignal,
            sink.Signals.Any(static signal => signal.Reason == SecurityRiskReason.FakeCrawler));
    }

    [Fact]
    public async Task TestServer_RateLimiterRejectionRiskWritesAreBoundedPerClientAndPath()
    {
        var sink = new CapturingRiskSink();
        await using WebApplication server = await CreateServerAsync(SecuritySystemModes.Disabled, sink);
        using HttpClient client = server.GetTestClient();

        Assert.Equal(HttpStatusCode.OK, (await SendAsync(client, "/article/9091", "Mozilla/5.0", "203.0.113.240")).StatusCode);
        for (int i = 0; i < 8; i++)
        {
            Assert.Equal(
                HttpStatusCode.TooManyRequests,
                (await SendAsync(client, "/article/9091", "Mozilla/5.0", "203.0.113.240")).StatusCode);
        }

        Assert.Equal(
            4,
            sink.Signals.Count(static signal =>
                signal.Reason == SecurityRiskReason.RateLimited
                && signal.Source == SecurityRiskSources.RateLimiter));
    }

    [Fact]
    public async Task TestServer_FixedIpLimiterKeepsAuthenticatedAdminPrincipalBounded()
    {
        var sink = new CapturingRiskSink();
        await using WebApplication server = await CreateServerAsync(SecuritySystemModes.Disabled, sink);
        using HttpClient client = server.GetTestClient();

        Assert.Equal(HttpStatusCode.OK, (await SendAsync(client, "/admin/ping", "Mozilla/5.0", "203.0.113.250", admin: true)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await SendAsync(client, "/admin/ping", "Mozilla/5.0", "203.0.113.250", admin: true)).StatusCode);
        Assert.Equal(HttpStatusCode.TooManyRequests, (await SendAsync(client, "/admin/ping", "Mozilla/5.0", "203.0.113.250", admin: true)).StatusCode);
    }

    [Fact]
    public async Task TestServer_LoopbackRequestsBypassSharedRateLimitPolicies()
    {
        var sink = new CapturingRiskSink();
        await using WebApplication server = await CreateServerAsync(SecuritySystemModes.Disabled, sink);
        using HttpClient client = server.GetTestClient();

        for (int i = 0; i < 8; i++)
        {
            Assert.Equal(HttpStatusCode.OK, (await SendAsync(client, "/article/42", "Mozilla/5.0", "127.0.0.1")).StatusCode);
            Assert.Equal(HttpStatusCode.OK, (await SendAsync(client, "/admin/ping", "Mozilla/5.0", "127.0.0.1", admin: true)).StatusCode);
            Assert.Equal(HttpStatusCode.OK, (await SendAsync(client, "/read-proof", "Mozilla/5.0", "127.0.0.1")).StatusCode);
            Assert.Equal(HttpStatusCode.OK, (await SendAsync(client, "/notification-stream", "Mozilla/5.0", "::1")).StatusCode);
        }

        Assert.DoesNotContain(sink.Signals, static signal => signal.Reason == SecurityRiskReason.RateLimited);
    }

    [Fact]
    public async Task TestServer_RateLimiterTestsCanDisableLoopbackBypass()
    {
        var sink = new CapturingRiskSink();
        await using WebApplication server = await CreateServerAsync(
            SecuritySystemModes.Disabled,
            sink,
            loopbackBypassEnabled: false);
        using HttpClient client = server.GetTestClient();

        Assert.Equal(HttpStatusCode.OK, (await SendAsync(client, "/article/42", "Mozilla/5.0", "127.0.0.1")).StatusCode);
        Assert.Equal(HttpStatusCode.TooManyRequests, (await SendAsync(client, "/article/42", "Mozilla/5.0", "127.0.0.1")).StatusCode);
    }

    private static async Task<WebApplication> CreateServerAsync(
        string mode,
        CapturingRiskSink sink,
        bool loopbackBypassEnabled = true)
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["RateLimiting:AdminPermitLimit"] = "2",
                ["RateLimiting:AdminQueueLimit"] = "0",
                ["RateLimiting:LoopbackBypassEnabled"] = loopbackBypassEnabled.ToString()
            })
            .Build();
        var detector = new CrawlerDetectorService(
            NullLogger<CrawlerDetectorService>.Instance,
            new MemoryCache(new MemoryCacheOptions()),
            configuration);
        detector.UpdateCidrLists(["66.249.64.0/19"], ["40.77.167.0/24"]);
        var policy = new FixedPolicyProvider(CreateOptions(mode));
        var governor = new AdaptivePowGovernor(Substitute.For<IUnifiedCache>(), configuration);

        var options = new WebApplicationOptions { EnvironmentName = Environments.Production };
        WebApplicationBuilder builder = WebApplication.CreateBuilder(options);
        builder.WebHost.UseTestServer();
        builder.Configuration.Sources.Clear();
        builder.Services.AddSingleton(configuration);
        builder.Services.AddSingleton<IAntiCrawlerPolicyProvider>(policy);
        builder.Services.AddSingleton(detector);
        builder.Services.AddSingleton<ISecurityRiskSignalSink>(sink);
        builder.Services.AddSingleton(governor);
        builder.Services.AddRouting();
        builder.Services.AddFsusRateLimiting();

        WebApplication app = builder.Build();
        app.Use(async (context, next) =>
                {
                    if (context.Request.Headers.TryGetValue("X-Test-Remote-Ip", out var value)
                        && IPAddress.TryParse(value.ToString(), out IPAddress? address))
                    {
                        context.Connection.RemoteIpAddress = address;
                    }

                    if (context.Request.Headers["X-Test-Admin"] == "1")
                    {
                        context.User = new ClaimsPrincipal(new ClaimsIdentity(
                        [
                            new Claim("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind),
                            new Claim("admin_id", "17")
                        ],
                        authenticationType: "test"));
                    }

                    await next(context);
                });
        app.UseMiddleware<ShieldMiddleware>();
        app.UseRouting();
        app.UseRateLimiter();
        app.MapGet("/article/{id:int}", static async context =>
                    {
                        context.Response.StatusCode = StatusCodes.Status200OK;
                        await context.Response.WriteAsync("ok");
                    }).RequireRateLimiting("public_read");
        app.MapGet("/admin/ping", static async context =>
                    {
                        context.Response.StatusCode = StatusCodes.Status200OK;
                        await context.Response.WriteAsync("ok");
                    }).RequireRateLimiting("fixed_ip");
        app.MapGet("/read-proof", static async context =>
                    {
                        context.Response.StatusCode = StatusCodes.Status200OK;
                        await context.Response.WriteAsync("ok");
                    }).RequireRateLimiting("read_proof");
        app.MapGet("/notification-stream", static async context =>
                    {
                        context.Response.StatusCode = StatusCodes.Status200OK;
                        await context.Response.WriteAsync("ok");
                    }).RequireRateLimiting("notification_stream");
        await app.StartAsync();
        return app;
    }

    private static async Task<HttpResponseMessage> SendAsync(
        HttpClient client,
        string path,
        string userAgent,
        string remoteIp,
        bool admin = false)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, path);
        request.Headers.TryAddWithoutValidation("User-Agent", userAgent);
        request.Headers.TryAddWithoutValidation("X-Test-Remote-Ip", remoteIp);
        if (admin)
        {
            request.Headers.TryAddWithoutValidation("X-Test-Admin", "1");
        }
        return await client.SendAsync(request);
    }

    private static AntiCrawlerPolicyOptions CreateOptions(string mode)
        => new(
            Mode: mode,
            PublicReadChallengeEnabled: true,
            SearchCrawlerVerificationEnabled: true,
            SocialPreviewGuardEnabled: true,
            RiskScoringEnabled: true,
            EventPersistenceEnabled: true,
            DashboardAggregationEnabled: true,
            CidrAutoUpdateEnabled: true,
            IllegalPathHardAbortEnabled: true,
            RequireChallengeScore: 50,
            BlockScore: 100,
            MaxRiskScore: 200,
            DefaultRiskTtlSeconds: 600,
            ZeroRiskCacheTtlSeconds: 3,
            FixedIpPermitLimit: 1,
            FixedIpQueueLimit: 0,
            VerifiedCrawlerFixedIpPermitLimit: 3,
            PublicReadPermitLimit: 1,
            PublicReadQueueLimit: 0,
            VerifiedCrawlerPublicReadPermitLimit: 3,
            SocialPreviewPublicReadPermitLimit: 2,
            ReadProofPermitLimit: 1,
            CidrUpdateIntervalMinutes: 1440,
            CidrInitialDelaySeconds: 0,
            CidrMinUpdateIntervalMinutes: 30,
            GoogleCrawlerRangesUrl: "https://developers.google.com/static/search/apis/ipranges/googlebot.json",
            BingCrawlerRangesUrl: "https://www.bing.com/toolbox/bingbot.json",
            SnapshotPath: null,
            SocialPreviewAllowedPathPrefixes: ["/", "/article/"],
            BlockedUserAgentKeywords: ["python", "curl"],
            SecurityChallengeReference: "security.pow");

    private sealed class FixedPolicyProvider(AntiCrawlerPolicyOptions options) : IAntiCrawlerPolicyProvider
    {
        public AntiCrawlerPolicySnapshot Current { get; } = new(
            "test",
            DateTimeOffset.Parse("2026-07-11T08:00:00Z"),
            "test",
            "test",
            options);
    }

    private sealed class CapturingRiskSink : ISecurityRiskSignalSink
    {
        private readonly ConcurrentQueue<SecurityRiskSignal> _signals = new();

        public IReadOnlyCollection<SecurityRiskSignal> Signals => _signals.ToArray();

        public ValueTask AddRiskAsync(
            SecurityRiskSignal signal,
            CancellationToken cancellationToken = default)
        {
            _signals.Enqueue(signal);
            return ValueTask.CompletedTask;
        }
    }
}
