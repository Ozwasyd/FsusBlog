using System.Net;
using System.Net.Http.Json;
using System.Security.Claims;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Operations;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Caching.Distributed;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class SecurityChallengeProtocolActivationGuardTests
{
    [Fact]
    public async Task Guard_RemainsClosedUntilDurableAppliedReceiptAndExactFenceThenPersistsOpenMarker()
    {
        ServiceProvider services = new ServiceCollection().AddDistributedMemoryCache().BuildServiceProvider();
        IReleaseIdentityProvider identity = Substitute.For<IReleaseIdentityProvider>();
        identity.Current.Returns(new ReleaseIdentitySnapshot("release-a", "green", "commit", "image", $"sha256:{new string('a', 64)}", true));
        IConfiguration configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["FSUSBLOG_DEPLOYMENT_GENERATION"] = "42"
        }).Build();
        ISecurityChallengeKindCutoverStore store = Substitute.For<ISecurityChallengeKindCutoverStore>();
        IActiveReleaseFence fence = Substitute.For<IActiveReleaseFence>();
        IWebHostEnvironment environment = Substitute.For<IWebHostEnvironment>();
        environment.EnvironmentName.Returns("Production");
        var guard = new SecurityChallengeProtocolActivationGuard(
            services.GetRequiredService<IDistributedCache>(), identity, environment, configuration, store, fence);
        var request = new SecurityChallengeProtocolActivationRequest(
            "operation-a", new string('b', 64), new string('c', 64), "release-a", "green", 42);

        Assert.False(await guard.IsOpenAsync());
        store.ReadReceiptAsync("operation-a", Arg.Any<CancellationToken>())
            .Returns((SecurityChallengeKindCutoverReceipt?)null);
        SecurityChallengeProtocolActivationResult premature = await guard.ActivateAsync(request);
        Assert.False(premature.Accepted);
        await store.DidNotReceive().PrepareAsync(
            Arg.Any<SecurityChallengeKindCutoverIntent>(),
            Arg.Any<CancellationToken>());

        store.ReadReceiptAsync("operation-a", Arg.Any<CancellationToken>()).Returns(AppliedReceipt());
        fence.VerifyAsync(Arg.Any<ActiveReleaseFenceVerifyRequest>(), Arg.Any<CancellationToken>()).Returns(Verified());

        SecurityChallengeProtocolActivationResult result = await guard.ActivateAsync(request);

        Assert.True(result.Accepted);
        Assert.Equal("open", result.Status);
        Assert.True(await guard.IsOpenAsync());
        fence.VerifyAsync(Arg.Any<ActiveReleaseFenceVerifyRequest>(), Arg.Any<CancellationToken>())
            .Returns(RejectedFence());
        Assert.False(await guard.IsOpenAsync());
    }

    [Theory]
    [InlineData("Production", false)]
    [InlineData("Development", true)]
    [InlineData("Testing", true)]
    public async Task InvalidReleaseSlotOnlyBypassesActivationInExplicitLocalEnvironments(
        string environmentName,
        bool expectedOpen)
    {
        ServiceProvider services = new ServiceCollection().AddDistributedMemoryCache().BuildServiceProvider();
        IReleaseIdentityProvider identity = Substitute.For<IReleaseIdentityProvider>();
        identity.Current.Returns(new ReleaseIdentitySnapshot("release-a", "invalid", "commit", "image", "digest", true));
        IWebHostEnvironment environment = Substitute.For<IWebHostEnvironment>();
        environment.EnvironmentName.Returns(environmentName);
        var guard = new SecurityChallengeProtocolActivationGuard(
            services.GetRequiredService<IDistributedCache>(),
            identity,
            environment,
            new ConfigurationBuilder().Build(),
            Substitute.For<ISecurityChallengeKindCutoverStore>(),
            Substitute.For<IActiveReleaseFence>());

        Assert.Equal(expectedOpen, await guard.IsOpenAsync());
    }

    [Fact]
    public async Task ProductionCacheFailureFailsClosed()
    {
        IDistributedCache cache = Substitute.For<IDistributedCache>();
        cache.GetAsync(Arg.Any<string>(), Arg.Any<CancellationToken>())
            .Returns<Task<byte[]?>>(_ => throw new InvalidOperationException("cache unavailable"));
        IReleaseIdentityProvider identity = Substitute.For<IReleaseIdentityProvider>();
        identity.Current.Returns(new ReleaseIdentitySnapshot("release-a", "green", "commit", "image", "digest", true));
        IWebHostEnvironment environment = Substitute.For<IWebHostEnvironment>();
        environment.EnvironmentName.Returns("Production");
        IConfiguration configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["FSUSBLOG_DEPLOYMENT_GENERATION"] = "42"
        }).Build();
        var guard = new SecurityChallengeProtocolActivationGuard(
            cache, identity, environment, configuration,
            Substitute.For<ISecurityChallengeKindCutoverStore>(),
            Substitute.For<IActiveReleaseFence>());

        Assert.False(await guard.IsOpenAsync());
    }

    [Fact]
    public async Task RealEndpoint_RejectsClosedWindowAndReturnsOpenOnlyFromGuard()
    {
        ISecurityChallengeProtocolActivationGuard guard = Substitute.For<ISecurityChallengeProtocolActivationGuard>();
        guard.ActivateAsync(Arg.Any<SecurityChallengeProtocolActivationRequest>(), Arg.Any<CancellationToken>())
            .Returns(new SecurityChallengeProtocolActivationResult(
                SecurityChallengeProtocolActivationGuard.ResultSchemaVersion, false, "closed",
                "cutover_receipt_not_verified", "operation-a", "release-a", "green", 42, null));
        WebApplicationBuilder builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Configuration["AllowedHosts"] = "*";
        builder.Services.AddAuthorization();
        builder.Services.AddRateLimiter(options => options.AddFixedWindowLimiter("fixed_ip", limiter =>
        {
            limiter.PermitLimit = 10;
            limiter.Window = TimeSpan.FromMinutes(1);
        }));
        builder.Services.AddSingleton(guard);
        await using WebApplication app = builder.Build();
        app.UseRouting();
        app.Use(async (context, next) =>
        {
            context.Connection.RemoteIpAddress = IPAddress.Loopback;
            context.User = new ClaimsPrincipal(new ClaimsIdentity(
            [
                new Claim("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind),
                new Claim("admin_id", "39"),
                new Claim(AdminPermissions.PermissionClaimType, AdminPermissions.SystemConfig)
            ], "test"));
            await next(context);
        });
        app.UseAuthorization();
        app.UseRateLimiter();
        app.MapActiveReleaseFenceEndpoints();
        await app.StartAsync();

        var payload = new SecurityChallengeProtocolActivationRequest(
            "operation-a", new string('b', 64), new string('c', 64), "release-a", "green", 42);
        HttpClient client = app.GetTestClient();
        client.BaseAddress = new Uri("http://localhost");
        HttpResponseMessage response = await client.PostAsJsonAsync(
            ActiveReleaseFenceEndpoints.ChallengeProtocolActivatePath,
            payload);
        string responseText = await response.Content.ReadAsStringAsync();
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        SecurityChallengeProtocolActivationResult? body = System.Text.Json.JsonSerializer.Deserialize<SecurityChallengeProtocolActivationResult>(responseText, new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web));
        Assert.NotNull(body);
        Assert.False(body.Accepted);
        Assert.Equal("closed", body.Status);
    }

    private static SecurityChallengeKindCutoverReceipt AppliedReceipt() => new(
        SecurityChallengeKindCutover.ReceiptSchemaVersion, "operation-a", new string('b', 64),
        "release-a", "green", 42, [3, 10, 13], new string('c', 64), false, true, false,
        "applied", null, true, true, true, 1, 1, 1, 1, new string('d', 64), DateTimeOffset.UtcNow);

    private static ActiveReleaseFenceOperationResult Verified() => new(
        true, true, "verified", null, false,
        new ActiveReleaseFenceSnapshot(true, ActiveReleaseFenceStatuses.Active, "release-a", "green", 42,
            $"sha256:{new string('a', 64)}", DateTimeOffset.UtcNow, null));

    private static ActiveReleaseFenceOperationResult RejectedFence() => new(
        false, false, "rejected", "active_release_generation_mismatch", false,
        new ActiveReleaseFenceSnapshot(false, ActiveReleaseFenceStatuses.Revoked, "release-b", "blue", 43,
            $"sha256:{new string('b', 64)}", DateTimeOffset.UtcNow, DateTimeOffset.UtcNow));
}
