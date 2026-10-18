using System.Net;
using System.Net.Http.Headers;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AdminRequestJwtFeatureTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RealJwtAndProjection_AttachDistinctSameOwnerFeatures_AndDisposeAtResponseEnd(bool cookie)
    {
        AdminAuthenticatedRequestLifetime? observed = null;
        var projection = new AdminSessionProjection(new AdminSessionProjectionLimits(16, 16, 1024 * 1024));
        await using WebApplication app = await StartAsync(projection, lifetime => observed = lifetime);
        using HttpClient client = app.GetTestClient();
        string? previousDigest = null;
        foreach (string sessionId in new[] { "first", "second" })
        {
            string token = Issue(app, sessionId);
            Seed(projection, sessionId, token);
            using var request = new HttpRequestMessage(HttpMethod.Get, "/api/binary/admin/producer-test");
            if (cookie)
            {
                request.Headers.Add("Cookie", $"AdminAccessToken={token}");
            }
            else
            {
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            }
            using HttpResponseMessage response = await client.SendAsync(request);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            AdminAuthenticatedRequestLifetime lifetime = Assert.IsType<AdminAuthenticatedRequestLifetime>(observed);
            Assert.NotEqual(previousDigest, lifetime.BindingDigest);
            previousDigest = lifetime.BindingDigest;
            // RegisterForDispose executes on response completion in the real bearer handler pipeline.
            Assert.False(lifetime.IsCurrent);
            Assert.True(lifetime.Invalidated.IsCancellationRequested);
            Assert.Equal(0, projection.ActiveRequestLifetimeCount);
        }
    }

    [Fact]
    public async Task MockedValidRecord_NeverMintsAuthenticatedFeature()
    {
        AdminAuthenticatedRequestLifetime? observed = null;
        var projection = new AdminSessionProjection(new AdminSessionProjectionLimits(16, 16, 1024 * 1024));
        IAdminSessionValidationService mocked = Substitute.For<IAdminSessionValidationService>();
        mocked.ValidateAsync(Arg.Any<System.Security.Claims.ClaimsPrincipal>(), Arg.Any<string>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(AdminSessionValidationResult.Valid));
        await using WebApplication app = await StartAsync(projection, lifetime => observed = lifetime, mocked);
        using HttpClient client = app.GetTestClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/binary/admin/producer-test");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", Issue(app, "unprojected"));
        using HttpResponseMessage response = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Null(observed);
        Assert.Equal(0, projection.ActiveRequestLifetimeCount);
    }

    [Theory]
    [InlineData("bad-signature")]
    [InlineData("revoked")]
    [InlineData("wrong-hash")]
    [InlineData("not-ready")]
    public async Task AuthenticationFailure_DoesNotAttachFeatureOrLeakRegistration(string failure)
    {
        bool reached = false;
        var projection = new AdminSessionProjection(new AdminSessionProjectionLimits(16, 16, 1024 * 1024));
        await using WebApplication app = await StartAsync(projection, _ => reached = true);
        string token = Issue(app, "first");
        Seed(projection, "first", failure == "wrong-hash" ? "other" : token);
        if (failure == "bad-signature")
        {
            int signature = token.LastIndexOf('.') + 1;
            token = token[..signature] + (token[signature] == 'A' ? 'B' : 'A') + token[(signature + 1)..];
        }
        if (failure == "revoked")
        {
            DateTimeOffset now = DateTimeOffset.UtcNow;
            projection.Apply(new AdminSessionProjectionSessionUpdate("first", 7,
                AdminAuthenticatedRequestLifetimeTests.Hash(token), now, now.AddMinutes(10), now.AddHours(1), 2, 2,
                new AdminSessionProjectionPrincipalUpdate(7, AdminSessionProjectionPrincipalStatus.Active, 1, 1)));
        }
        if (failure == "not-ready")
        {
            projection.MarkNotReady("test");
        }
        using HttpClient client = app.GetTestClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/binary/admin/producer-test");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        using HttpResponseMessage response = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.False(reached);
        Assert.Equal(0, projection.ActiveRequestLifetimeCount);
    }

    private static async Task<WebApplication> StartAsync(AdminSessionProjection projection,
        Action<AdminAuthenticatedRequestLifetime?> observe, IAdminSessionValidationService? validator = null)
    {
        WebApplicationBuilder builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = Environments.Development });
        builder.WebHost.UseTestServer();
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Jwt:KeyVersion"] = "producer-test",
            ["Jwt:SecretKey"] = TestSecrets.JwtSigningKey,
            ["Jwt:Issuer"] = "producer-test",
            ["Jwt:Audience"] = "producer-test",
            ["AuthCookies:AllowInsecureTransportCookies"] = "true"
        });
        builder.Services.AddSingleton(projection);
        builder.Services.AddSingleton(Substitute.For<IAdminSessionTouchScheduler>());
        if (validator is null)
        {
            builder.Services.AddSingleton<IAdminSessionValidationService, AdminSessionValidationService>();
        }
        else
        {
            builder.Services.AddSingleton(validator);
        }
        builder.Services.AddSingleton(Substitute.For<IUserSessionValidationService>());
        builder.Services.AddSingleton<AuthCookieService>();
        builder.Services.AddJwtAuthentication(builder.Configuration);
        builder.Services.AddAuthorization();
        WebApplication app = builder.Build();
        app.UseAuthentication();
        app.UseAuthorization();
        app.MapGet("/api/binary/admin/producer-test", (HttpContext context) =>
        {
            AdminAuthenticatedRequestLifetime? lifetime = context.Features.Get<IAdminAuthenticatedRequestFeature>()?.Lifetime;
            if (lifetime is not null)
            {
                Assert.True(lifetime.IsCurrent);
            }
            observe(lifetime);
            return "ok";
        }).RequireAuthorization();
        await app.StartAsync();
        return app;
    }

    private static string Issue(WebApplication app, string sessionId)
        => app.Services.GetRequiredService<IJwtHelper>().GenerateAdminAccessToken(
            new AdminPrincipal { Id = 7, Handle = "producer-admin" },
            new AdminSession { SessionId = sessionId, AdminPrincipalId = 7 },
            [AdminPermissions.AdminManage]).Token;

    private static void Seed(AdminSessionProjection projection, string sessionId, string token)
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        Assert.True(projection.Apply(new AdminSessionProjectionSessionUpdate(sessionId, 7,
            AdminAuthenticatedRequestLifetimeTests.Hash(token), null, now.AddMinutes(10), now.AddHours(1), 1, 1,
            new AdminSessionProjectionPrincipalUpdate(7, AdminSessionProjectionPrincipalStatus.Active, 1, 1))).Accepted);
        Assert.True(projection.MarkReady(1));
    }
}
