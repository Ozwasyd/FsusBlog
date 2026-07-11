using System.Net;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Services.Security;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "SecurityStateMachine")]
public sealed class UserSessionJwtAuthenticationTests
{
    [Fact]
    public async Task ProtectedEndpoint_RevokedOrdinarySessionFailsAuthenticationAndClearsOnlyUserCookies()
    {
        var userValidator = Substitute.For<IUserSessionValidationService>();
        userValidator.ValidateAsync(Arg.Any<System.Security.Claims.ClaimsPrincipal>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(UserSessionValidationResult.Invalid("user_session_revoked")));
        var adminValidator = Substitute.For<IAdminSessionValidationService>();
        await using WebApplication app = await StartHostAsync(userValidator, adminValidator);
        IssuedAccessToken token = app.Services.GetRequiredService<IJwtHelper>().GenerateAccessToken(
            OrdinaryAccount(),
            sessionId: "revoked-session",
            mfaVerified: true);
        using HttpClient client = app.GetTestClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, "/protected");
        request.Headers.Add("Cookie", $"AccessToken={token.Token}");

        using HttpResponseMessage response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        await userValidator.Received(1).ValidateAsync(
            Arg.Is<System.Security.Claims.ClaimsPrincipal>(principal =>
                principal.FindFirst("sid")!.Value == "revoked-session"),
            Arg.Any<CancellationToken>());
        await adminValidator.DidNotReceive().ValidateAsync(
            Arg.Any<System.Security.Claims.ClaimsPrincipal>(),
            Arg.Any<string>(),
            Arg.Any<CancellationToken>());
        string[] cookies = response.Headers.TryGetValues("Set-Cookie", out IEnumerable<string>? values)
            ? values.ToArray()
            : [];
        Assert.Contains(cookies, value => value.StartsWith("AccessToken=", StringComparison.Ordinal));
        Assert.Contains(cookies, value => value.StartsWith("RefreshToken=", StringComparison.Ordinal));
        Assert.Contains(cookies, value => value.StartsWith("SessionId=", StringComparison.Ordinal));
        Assert.DoesNotContain(cookies, value => value.StartsWith("AdminAccessToken=", StringComparison.Ordinal));
    }

    [Fact]
    public async Task AdminEndpoint_KeepsIndependentAdminSessionValidationPath()
    {
        var userValidator = Substitute.For<IUserSessionValidationService>();
        userValidator.ValidateAsync(Arg.Any<System.Security.Claims.ClaimsPrincipal>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(UserSessionValidationResult.Invalid("ordinary-validator-must-not-run")));
        var adminValidator = Substitute.For<IAdminSessionValidationService>();
        adminValidator.ValidateAsync(
                Arg.Any<System.Security.Claims.ClaimsPrincipal>(),
                Arg.Any<string>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(AdminSessionValidationResult.Valid));
        await using WebApplication app = await StartHostAsync(userValidator, adminValidator);
        var principal = new AdminPrincipal { Id = 7, Handle = "root" };
        var session = new AdminSession
        {
            SessionId = "admin-session",
            AdminPrincipalId = principal.Id,
            IdleExpiresAtUtc = DateTime.UtcNow.AddHours(1),
            AbsoluteExpiresAtUtc = DateTime.UtcNow.AddHours(8)
        };
        IssuedAccessToken token = app.Services.GetRequiredService<IJwtHelper>().GenerateAdminAccessToken(
            principal,
            session,
            [AdminPermissions.AdminManage]);
        using HttpClient client = app.GetTestClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/binary/admin/protected");
        request.Headers.Add("Cookie", $"AdminAccessToken={token.Token}");

        using HttpResponseMessage response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        await adminValidator.Received(1).ValidateAsync(
            Arg.Is<System.Security.Claims.ClaimsPrincipal>(value => value.IsAdminPrincipal()),
            token.Token,
            Arg.Any<CancellationToken>());
        await userValidator.DidNotReceive().ValidateAsync(
            Arg.Any<System.Security.Claims.ClaimsPrincipal>(),
            Arg.Any<CancellationToken>());
    }

    private static async Task<WebApplication> StartHostAsync(
        IUserSessionValidationService userValidator,
        IAdminSessionValidationService adminValidator)
    {
        var options = new WebApplicationOptions { EnvironmentName = Environments.Development };
        WebApplicationBuilder builder = WebApplication.CreateBuilder(options);
        builder.WebHost.UseTestServer();
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Jwt:SecretKey"] = "issue-1052-jwt-signing-key-with-at-least-thirty-two-bytes",
            ["Jwt:Issuer"] = "issue-1052-tests",
            ["Jwt:Audience"] = "issue-1052-tests",
            ["Jwt:AccessTokenExpiresMinutes"] = "15",
            ["AuthCookies:AllowInsecureTransportCookies"] = "true"
        });
        builder.Services.AddSingleton<AuthCookieService>();
        builder.Services.AddSingleton(userValidator);
        builder.Services.AddSingleton(adminValidator);
        builder.Services.AddJwtAuthentication(builder.Configuration);
        builder.Services.AddAuthorization();

        WebApplication app = builder.Build();
        app.UseAuthentication();
        app.UseAuthorization();
        app.MapGet("/protected", static () => "ok").RequireAuthorization();
        app.MapGet("/api/binary/admin/protected", static () => "ok").RequireAuthorization();
        await app.StartAsync();
        return app;
    }

    private static User OrdinaryAccount()
        => new()
        {
            Id = 42,
            IdentityKind = AnonymousIdentityRuntime.AnonymousAccountKind,
            AccountSubjectHash = new string('a', AccountSubjectHashRequirement.Sha256HexLength)
        };
}
