using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AdminPrincipalSecurityContractTests
{
    [Theory]
    [InlineData("Production", "true", false)]
    [InlineData("Development", null, false)]
    [InlineData("Development", "false", false)]
    [InlineData("Development", "true", true)]
    public async Task LocalAuthFixtureEndpoints_RegisterOnlyForDevelopmentWithExplicitFlag(
        string environmentName,
        string? allowFixture,
        bool shouldRegister)
    {
        var options = new WebApplicationOptions { EnvironmentName = environmentName };
        WebApplicationBuilder builder = WebApplication.CreateBuilder(options);
        if (allowFixture is not null)
        {
            builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
            {
                [LocalAuthFixtureEndpoints.AllowLocalAuthFixtureConfigurationKey] = allowFixture
            });
        }

        await using WebApplication app = builder.Build();
        app.MapLocalAuthFixtureEndpoints();

        string[] routes = ((IEndpointRouteBuilder)app).DataSources
            .SelectMany(static dataSource => dataSource.Endpoints)
            .OfType<RouteEndpoint>()
            .Select(static endpoint => endpoint.RoutePattern.RawText ?? string.Empty)
            .ToArray();

        Assert.Equal(shouldRegister, routes.Contains("/__local/auth-fixture/admin", StringComparer.Ordinal));
        Assert.Equal(shouldRegister, routes.Contains("/api/local/auth-fixture/admin", StringComparer.Ordinal));
        Assert.Equal(shouldRegister, routes.Contains("/__local/auth-fixture/status", StringComparer.Ordinal));
        Assert.Equal(shouldRegister, routes.Contains("/api/local/auth-fixture/status", StringComparer.Ordinal));
        Assert.Equal(shouldRegister, routes.Contains("/__local/auth-fixture/admin-sensitive-proof", StringComparer.Ordinal));
        Assert.Equal(shouldRegister, routes.Contains("/api/local/auth-fixture/admin-sensitive-proof", StringComparer.Ordinal));
    }

    [Fact]
    public void AnonymousIdentityRuntime_DoesNotGrantAdminFromLegacyUserRole()
    {
        string resolved = AnonymousIdentityRuntime.ResolveBackendRole(
            "admin",
            AnonymousIdentityRuntime.AnonymousAccountKind,
            anonymousIdentityModeEnabled: true);

        Assert.Equal(AnonymousIdentityRuntime.AuthenticatedRole, resolved);
    }

    [Fact]
    [Trait("ShardAffinity", "EndpointContractApplication")]
    public async Task AdminPrincipalCookie_IsOnlyPreferredForAdminAuthorizationMetadata()
    {
        await using EndpointContractSnapshot app = EndpointContractApplication.CreateSnapshot();

        var userContext = new DefaultHttpContext();
        userContext.Request.Path = "/api/binary/auth/me";
        userContext.SetEndpoint(EndpointContractApplication.Find(
            app,
            "/api/binary/auth/me",
            HttpMethods.Get));
        Assert.False(JwtServiceExtensions.ShouldPreferAdminCookie(userContext));

        var roleAdminContext = new DefaultHttpContext();
        roleAdminContext.Request.Path = "/api/binary/role-only";
        roleAdminContext.SetEndpoint(new Endpoint(
            static _ => Task.CompletedTask,
            new EndpointMetadataCollection(
                new AuthorizationPolicyBuilder().RequireRole("admin").Build()),
            "role-admin"));
        Assert.False(JwtServiceExtensions.ShouldPreferAdminCookie(roleAdminContext));

        var localFixtureProofContext = new DefaultHttpContext();
        localFixtureProofContext.Request.Path = "/api/local/auth-fixture/admin-sensitive-proof";
        Assert.True(JwtServiceExtensions.ShouldPreferAdminCookie(localFixtureProofContext));

        var localFixtureInternalProofContext = new DefaultHttpContext();
        localFixtureInternalProofContext.Request.Path = "/__local/auth-fixture/admin-sensitive-proof";
        Assert.True(JwtServiceExtensions.ShouldPreferAdminCookie(localFixtureInternalProofContext));

        var principalAdminContext = new DefaultHttpContext();
        principalAdminContext.Request.Path = "/api/binary/auth/admin/me";
        principalAdminContext.SetEndpoint(EndpointContractApplication.Find(
            app,
            "/api/binary/auth/admin/me",
            HttpMethods.Get));
        Assert.True(JwtServiceExtensions.ShouldPreferAdminCookie(principalAdminContext));
    }

    [Fact]
    [Trait("ShardAffinity", "EndpointContractApplication")]
    public async Task AdminPrincipalCookiePreference_CachesDecisionInHttpContextItems()
    {
        await using EndpointContractSnapshot app = EndpointContractApplication.CreateSnapshot();
        var context = new DefaultHttpContext();
        context.Request.Path = "/api/binary/auth/admin/me";
        context.SetEndpoint(EndpointContractApplication.Find(
            app,
            "/api/binary/auth/admin/me",
            HttpMethods.Get));

        Assert.True(JwtServiceExtensions.ShouldPreferAdminCookie(context));
        Assert.True(context.Items.TryGetValue("Fsus.AdminCookiePathDecision", out object? cached));
        Assert.Equal(true, cached);

        context.SetEndpoint(EndpointContractApplication.Find(
            app,
            "/api/binary/auth/me",
            HttpMethods.Get));
        Assert.True(JwtServiceExtensions.ShouldPreferAdminCookie(context));
        Assert.Equal(true, context.Items["Fsus.AdminCookiePathDecision"]);
    }

}
