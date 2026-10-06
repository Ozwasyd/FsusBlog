using System.Net;
using System.Net.Http.Json;
using System.Text;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Middlewares;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Services.Fixtures;

using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class LocalFixtureToolingBoundaryTests
{
    private const string Secret = "local-fixture-boundary-secret";
    private const string AuthPrepareBody = """
        {
          "schema": "fsusblog.auth-fixture-plan.v1",
          "strategy": "transaction-fixture",
          "producerId": "auth-session",
          "namespace": "boundary",
          "runId": "boundary-run",
          "profileId": "boundary-profile",
          "catalogDigest": "boundary-digest",
          "fixtureVariantPlanDigest": "boundary-digest",
          "producerVariantPlanDigest": "boundary-digest",
          "capabilities": [],
          "roles": [],
          "temporalContext": {},
          "resolvedTemporalRoles": {},
          "planDigest": "boundary-digest"
        }
        """;
    private static readonly (string Path, string Header, bool AllowsTest)[] s_routes =
    [
        ("/api/local/auth-fixture/prepare", "X-Fsus-Local-Auth-Fixture-Secret", false),
        ("/api/local/auth-fixture/verify", "X-Fsus-Local-Auth-Fixture-Secret", false),
        ("/__local/audit-fixture/prepare", LocalAuditFixtureEndpoints.LocalAuditFixtureSecretHeaderName, false),
        ("/__local/account-profile-preferences/prepare", LocalAccountProfilePreferenceFixtureEndpoints.SecretHeaderName, false),
        ("/__local/account-profile-preferences/verify", LocalAccountProfilePreferenceFixtureEndpoints.SecretHeaderName, false),
        ("/api/local/comment-fixture/prepare", LocalCommentFixtureEndpoints.SecretHeaderName, false),
        ("/api/local/comment-fixture/cleanup", LocalCommentFixtureEndpoints.SecretHeaderName, false),
        ("/api/local/messaging-fixture/prepare", LocalMessagingFixtureEndpoints.SecretHeaderName, false),
        ("/__local/security-fixture/apply", LocalSecurityFixtureEndpoints.LocalSecurityFixtureSecretHeaderName, true),
        ("/__local/security-fixture/observe", LocalSecurityFixtureEndpoints.LocalSecurityFixtureSecretHeaderName, true),
        ("/__local/security-fixture/cleanup", LocalSecurityFixtureEndpoints.LocalSecurityFixtureSecretHeaderName, true),
        ("/__local/security-fixture/observe-cleanup", LocalSecurityFixtureEndpoints.LocalSecurityFixtureSecretHeaderName, true)
    ];

    [Theory]
    [InlineData("Production", true)]
    [InlineData("Staging", true)]
    [InlineData("Development", false)]
    [InlineData("Test", false)]
    [InlineData("Development", true)]
    [InlineData("Test", true)]
    public async Task FixtureRoutes_RequireDeclaredEnvironmentAndExplicitGate(string environment, bool enabled)
    {
        WebApplicationBuilder builder = CreateBuilder(environment, enabled, Secret);
        RegisterFixturePorts(builder);
        await using WebApplication app = builder.Build();
        MapFixtureRoutes(app);

        string[] routes = GetRoutes(app);

        foreach ((string path, _, bool allowsTest) in s_routes)
        {
            bool expected = enabled && (environment == "Development" || (environment == "Test" && allowsTest));
            Assert.Equal(expected, routes.Contains(path, StringComparer.Ordinal));
        }
    }

    [Theory]
    [InlineData(Secret, "", "127.0.0.1", HttpStatusCode.Unauthorized)]
    [InlineData(Secret, "wrong", "127.0.0.1", HttpStatusCode.Unauthorized)]
    [InlineData("", Secret, "127.0.0.1", HttpStatusCode.Unauthorized)]
    [InlineData(Secret, Secret, "192.0.2.20", HttpStatusCode.NotFound)]
    [InlineData(Secret, Secret, "2001:db8::20", HttpStatusCode.NotFound)]
    public async Task FixtureRoutes_RejectUnauthorizedCallersBeforeInvokingAnyProducer(
        string configuredSecret,
        string providedSecret,
        string remoteAddress,
        HttpStatusCode expected)
    {
        WebApplicationBuilder builder = CreateBuilder("Development", true, configuredSecret);
        object[] ports = RegisterFixturePorts(builder);
        await using WebApplication app = builder.Build();
        app.Use(async (context, next) =>
        {
            context.Connection.RemoteIpAddress = IPAddress.Parse(remoteAddress);
            await next();
        });
        MapFixtureRoutes(app);
        await app.StartAsync();
        using HttpClient client = app.GetTestClient();

        foreach ((string path, string header, _) in s_routes)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, path)
            {
                Content = path == "/api/local/auth-fixture/prepare"
                    ? new StringContent(AuthPrepareBody, Encoding.UTF8, "application/json")
                    : JsonContent.Create(new
                    {
                    })
            };
            if (providedSecret.Length > 0)
            {
                request.Headers.Add(header, providedSecret);
            }
            using HttpResponseMessage response = await client.SendAsync(request);

            Assert.True(response.StatusCode == expected, $"{path}: expected {expected}, got {response.StatusCode}");
        }
        Assert.All(ports, static port => Assert.Empty(port.ReceivedCalls()));
    }

    [Theory]
    [InlineData("Production", Secret, false)]
    [InlineData("Staging", Secret, false)]
    [InlineData("Development", "", false)]
    [InlineData("Test", "", false)]
    [InlineData("Development", Secret, true)]
    [InlineData("Test", Secret, true)]
    public async Task RedisProbe_RequiresNonProductionAndConfiguredEvidenceSecret(
        string environment,
        string configuredSecret,
        bool expected)
    {
        WebApplicationBuilder builder = CreateBuilder(environment, false, configuredSecret);
        builder.Services.AddSingleton<RuntimeCacheEvidenceStore>();
        await using WebApplication app = builder.Build();
        app.MapRuntimeCacheEvidenceEndpoints();

        Assert.Equal(expected, GetRoutes(app).Contains(
            RuntimeCacheFaultAndRevocationScenarioEndpoints.RedisProbeRoute,
            StringComparer.Ordinal));
    }

    [Theory]
    [InlineData("", HttpStatusCode.Forbidden)]
    [InlineData("wrong", HttpStatusCode.Forbidden)]
    [InlineData(Secret, HttpStatusCode.BadRequest)]
    public async Task RedisProbe_RequiresMiddlewareAuthenticatedSecretBeforeOperationLookup(
        string providedSecret,
        HttpStatusCode expected)
    {
        WebApplicationBuilder builder = CreateBuilder("Test", false, Secret);
        IRedisOperationExecutor redis = Substitute.For<IRedisOperationExecutor>();
        builder.Services.AddSingleton(redis);
        builder.Services.AddSingleton<RedisOperationBudgetCatalog>();
        builder.Services.AddSingleton<RuntimeCacheEvidenceStore>();
        await using WebApplication app = builder.Build();
        app.UseMiddleware<RuntimeCacheEvidenceMiddleware>();
        app.MapRuntimeCacheEvidenceEndpoints();
        await app.StartAsync();
        using HttpClient client = app.GetTestClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, "/_fsus/testing/runtime-cache/redis-fault/not-a-class");
        if (providedSecret.Length > 0)
        {
            request.Headers.Add(RuntimeCacheEvidenceMiddleware.SecretHeader, providedSecret);
        }

        using HttpResponseMessage response = await client.SendAsync(request);

        Assert.Equal(expected, response.StatusCode);
        Assert.Empty(redis.ReceivedCalls());
    }

    private static WebApplicationBuilder CreateBuilder(string environment, bool enabled, string secret)
    {
        WebApplicationBuilder builder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            EnvironmentName = environment
        });
        builder.WebHost.UseTestServer();
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            [LocalAuthFixtureEndpoints.AllowLocalAuthFixtureConfigurationKey] = enabled.ToString(),
            [LocalAuthFixtureEndpoints.LocalAuthFixtureSecretConfigurationKey] = secret,
            [LocalPublicContentFixtureEndpoints.AllowLocalPublicContentFixtureConfigurationKey] = enabled.ToString(),
            [LocalPublicContentFixtureEndpoints.LocalPublicContentFixtureSecretConfigurationKey] = secret,
            [LocalAccountProfilePreferenceFixtureEndpoints.AllowConfigurationKey] = enabled.ToString(),
            [LocalAccountProfilePreferenceFixtureEndpoints.SecretConfigurationKey] = secret,
            [LocalCommentFixtureEndpoints.AllowConfigurationKey] = enabled.ToString(),
            [LocalCommentFixtureEndpoints.SecretConfigurationKey] = secret,
            [LocalMessagingFixtureEndpoints.AllowConfigurationKey] = enabled.ToString(),
            [LocalMessagingFixtureEndpoints.SecretConfigurationKey] = secret,
            [LocalSecurityFixtureEndpoints.AllowLocalSecurityFixtureConfigurationKey] = enabled.ToString(),
            [LocalSecurityFixtureEndpoints.LocalSecurityFixtureSecretConfigurationKey] = secret,
            [RuntimeCacheEvidenceMiddleware.SecretConfigurationKey] = secret
        });
        return builder;
    }

    private static object[] RegisterFixturePorts(WebApplicationBuilder builder)
    {
        IAuthFixtureSeeder auth = Substitute.For<IAuthFixtureSeeder>();
        IAuditFixtureProducer audit = Substitute.For<IAuditFixtureProducer>();
        IAccountProfilePreferenceFixtureService profile = Substitute.For<IAccountProfilePreferenceFixtureService>();
        ICommentFixtureSeeder comment = Substitute.For<ICommentFixtureSeeder>();
        IMessagingFixtureSeeder messaging = Substitute.For<IMessagingFixtureSeeder>();
        ISecurityFixtureCompositionRoot security = Substitute.For<ISecurityFixtureCompositionRoot>();
        builder.Services.AddSingleton(auth);
        builder.Services.AddSingleton(audit);
        builder.Services.AddSingleton(profile);
        builder.Services.AddSingleton(comment);
        builder.Services.AddSingleton(messaging);
        builder.Services.AddSingleton(security);
        builder.Services.AddSingleton(Substitute.For<ISqlSugarClient>());
        return [auth, audit, profile, comment, messaging, security];
    }

    private static void MapFixtureRoutes(WebApplication app)
    {
        app.MapLocalAuthFixtureEndpoints();
        app.MapLocalAuditFixtureEndpoints();
        app.MapLocalAccountProfilePreferenceFixtureEndpoints();
        app.MapLocalCommentFixtureEndpoints();
        app.MapLocalMessagingFixtureEndpoints();
        app.MapLocalSecurityFixtureEndpoints();
    }

    private static string[] GetRoutes(WebApplication app)
        => ((IEndpointRouteBuilder)app).DataSources
            .SelectMany(static source => source.Endpoints)
            .OfType<RouteEndpoint>()
            .Select(static endpoint => endpoint.RoutePattern.RawText ?? string.Empty)
            .ToArray();
}
