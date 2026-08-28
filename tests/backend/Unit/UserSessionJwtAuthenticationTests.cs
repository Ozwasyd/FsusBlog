using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Security.Claims;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Governance;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.IdentityModel.Tokens;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "SecurityStateMachine")]
public sealed class UserSessionJwtAuthenticationTests
{
    [Fact]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Negative, InvariantId = "session-revocation-enforcement")]
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
        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/binary/notification-stream/protected");
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
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Positive)]
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

    [Fact]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Positive)]
    public async Task ProtectedEndpoint_AcceptsPreviousKidInsideRotationWindow()
    {
        var userValidator = Substitute.For<IUserSessionValidationService>();
        userValidator.ValidateAsync(Arg.Any<ClaimsPrincipal>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(UserSessionValidationResult.Valid));
        var adminValidator = Substitute.For<IAdminSessionValidationService>();
        string acceptUntil = DateTimeOffset.UtcNow.AddDays(7).ToString("O");
        await using WebApplication app = await StartHostAsync(userValidator, adminValidator, new Dictionary<string, string?>
        {
            ["Jwt:KeyVersion"] = "v2-2026-07",
            ["Jwt:SecretKey"] = TestSecrets.JwtSigningKey,
            ["Jwt:PreviousKeys:0:Version"] = "v1-2026-01",
            ["Jwt:PreviousKeys:0:Key"] = TestSecrets.SecondaryJwtSigningKey,
            ["Jwt:PreviousKeys:0:AcceptUntilUtc"] = acceptUntil
        });
        string token = CreateOrdinaryToken(TestSecrets.SecondaryJwtSigningKey, "v1-2026-01");
        using HttpClient client = app.GetTestClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, "/protected");
        request.Headers.Add("Cookie", $"AccessToken={token}");

        using HttpResponseMessage response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        await userValidator.Received(1).ValidateAsync(
            Arg.Is<ClaimsPrincipal>(principal => principal.FindFirst("sid")!.Value == "rotation-session"),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Boundary)]
    public async Task ProtectedEndpoint_RejectsUnknownKidWithoutTryingEveryKey()
    {
        var userValidator = Substitute.For<IUserSessionValidationService>();
        userValidator.ValidateAsync(Arg.Any<ClaimsPrincipal>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(UserSessionValidationResult.Valid));
        var adminValidator = Substitute.For<IAdminSessionValidationService>();
        await using WebApplication app = await StartHostAsync(userValidator, adminValidator, new Dictionary<string, string?>
        {
            ["Jwt:KeyVersion"] = "v2-2026-07",
            ["Jwt:SecretKey"] = TestSecrets.JwtSigningKey,
            ["Jwt:PreviousKeys:0:Version"] = "v1-2026-01",
            ["Jwt:PreviousKeys:0:Key"] = TestSecrets.SecondaryJwtSigningKey,
            ["Jwt:PreviousKeys:0:AcceptUntilUtc"] = DateTimeOffset.UtcNow.AddDays(7).ToString("O")
        });
        string token = CreateOrdinaryToken(TestSecrets.SecondaryJwtSigningKey, "unknown-kid");
        using HttpClient client = app.GetTestClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, "/protected");
        request.Headers.Add("Cookie", $"AccessToken={token}");

        using HttpResponseMessage response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        await userValidator.DidNotReceive().ValidateAsync(Arg.Any<ClaimsPrincipal>(), Arg.Any<CancellationToken>());
    }

    [Theory]
    [InlineData("expired")]
    [InlineData("wrong-signing-key")]
    [InlineData("tampered")]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Negative, InvariantId = "auth-session-fail-closed")]
    public async Task ProtectedEndpoint_RejectsInvalidAccessTokenBeforeSessionValidation(string scenario)
    {
        var userValidator = Substitute.For<IUserSessionValidationService>();
        userValidator.ValidateAsync(Arg.Any<ClaimsPrincipal>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(UserSessionValidationResult.Valid));
        var adminValidator = Substitute.For<IAdminSessionValidationService>();
        await using WebApplication app = await StartHostAsync(userValidator, adminValidator, new Dictionary<string, string?>
        {
            ["Jwt:KeyVersion"] = "test-v1",
            ["Jwt:SecretKey"] = TestSecrets.JwtSigningKey
        });
        DateTime now = DateTime.UtcNow;
        string token = scenario switch
        {
            "expired" => CreateOrdinaryToken(
                TestSecrets.JwtSigningKey,
                "test-v1",
                notBefore: now.AddMinutes(-10),
                expires: now.AddMinutes(-1)),
            "wrong-signing-key" => CreateOrdinaryToken(
                TestSecrets.SecondaryJwtSigningKey,
                "test-v1"),
            "tampered" => TamperSignature(CreateOrdinaryToken(
                TestSecrets.JwtSigningKey,
                "test-v1")),
            _ => throw new ArgumentOutOfRangeException(nameof(scenario), scenario, null)
        };
        using HttpClient client = app.GetTestClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, "/protected");
        request.Headers.Add("Cookie", $"AccessToken={token}");

        using HttpResponseMessage response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        await userValidator.DidNotReceive().ValidateAsync(
            Arg.Any<ClaimsPrincipal>(),
            Arg.Any<CancellationToken>());
        await adminValidator.DidNotReceive().ValidateAsync(
            Arg.Any<ClaimsPrincipal>(),
            Arg.Any<string>(),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Migration, InvariantId = "jwt-kid-migration-window")]
    public async Task ProtectedEndpoint_AcceptsLegacyNoKidOnlyInsideExplicitMigrationWindow()
    {
        var userValidator = Substitute.For<IUserSessionValidationService>();
        userValidator.ValidateAsync(Arg.Any<ClaimsPrincipal>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(UserSessionValidationResult.Valid));
        var adminValidator = Substitute.For<IAdminSessionValidationService>();
        await using WebApplication app = await StartHostAsync(userValidator, adminValidator, new Dictionary<string, string?>
        {
            ["Jwt:KeyVersion"] = "v2-2026-07",
            ["Jwt:SecretKey"] = TestSecrets.JwtSigningKey,
            ["Jwt:LegacyNoKidAcceptUntilUtc"] = DateTimeOffset.UtcNow.AddHours(1).ToString("O")
        });
        string token = CreateOrdinaryToken(TestSecrets.JwtSigningKey, keyVersion: null);
        using HttpClient client = app.GetTestClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, "/protected");
        request.Headers.Add("Cookie", $"AccessToken={token}");

        using HttpResponseMessage response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    private static async Task<WebApplication> StartHostAsync(
        IUserSessionValidationService userValidator,
        IAdminSessionValidationService adminValidator,
        IReadOnlyDictionary<string, string?>? jwtOverrides = null)
    {
        var options = new WebApplicationOptions { EnvironmentName = Environments.Development };
        WebApplicationBuilder builder = WebApplication.CreateBuilder(options);
        builder.WebHost.UseTestServer();
        var configuration = new Dictionary<string, string?>
        {
            ["Jwt:KeyVersion"] = "test-v1",
            ["Jwt:SecretKey"] = "issue-1052-jwt-signing-key-with-at-least-thirty-two-bytes",
            ["Jwt:Issuer"] = "issue-1052-tests",
            ["Jwt:Audience"] = "issue-1052-tests",
            ["Jwt:AccessTokenExpiresMinutes"] = "15",
            ["Jwt:RotationWindowDays"] = "30",
            ["AuthCookies:AllowInsecureTransportCookies"] = "true"
        };
        if (jwtOverrides is not null)
        {
            foreach ((string key, string? value) in jwtOverrides)
            {
                configuration[key] = value;
            }
        }
        builder.Configuration.AddInMemoryCollection(configuration);
        builder.Services.AddSingleton<AuthCookieService>();
        builder.Services.AddSingleton(userValidator);
        builder.Services.AddSingleton(adminValidator);
        builder.Services.AddJwtAuthentication(builder.Configuration);
        builder.Services.AddAuthorization();

        WebApplication app = builder.Build();
        app.UseAuthentication();
        app.UseAuthorization();
        app.MapGet("/protected", static () => "ok").RequireAuthorization();
        app.MapGet("/api/binary/notification-stream/protected", static () => "ok").RequireAuthorization();
        app.MapGet("/api/binary/admin/protected", static () => "ok").RequireAuthorization();
        await app.StartAsync();
        return app;
    }

    private static string CreateOrdinaryToken(
        string secret,
        string? keyVersion,
        DateTime? notBefore = null,
        DateTime? expires = null)
    {
        DateTime now = DateTime.UtcNow;
        var signingKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(secret))
        {
            KeyId = keyVersion
        };
        var descriptor = new SecurityTokenDescriptor
        {
            Subject = new ClaimsIdentity(
            [
                new Claim(ClaimTypes.NameIdentifier, "42"),
                new Claim("identity_kind", AnonymousIdentityRuntime.AnonymousAccountKind),
                new Claim(AccountSubjectHasher.ClaimType, new string('a', AccountSubjectHashRequirement.Sha256HexLength)),
                new Claim("sid", "rotation-session")
            ]),
            IssuedAt = notBefore ?? now,
            NotBefore = notBefore ?? now.AddMinutes(-1),
            Expires = expires ?? now.AddMinutes(10),
            Issuer = "issue-1052-tests",
            Audience = "issue-1052-tests",
            SigningCredentials = new SigningCredentials(signingKey, SecurityAlgorithms.HmacSha256Signature)
        };
        var handler = new JwtSecurityTokenHandler();
        return handler.WriteToken(handler.CreateToken(descriptor));
    }

    private static string TamperSignature(string token)
    {
        string[] segments = token.Split('.');
        Assert.Equal(3, segments.Length);
        char[] signature = segments[2].ToCharArray();
        int index = signature.Length / 2;
        signature[index] = signature[index] == 'A' ? 'B' : 'A';
        segments[2] = new string(signature);
        return string.Join('.', segments);
    }

    private static User OrdinaryAccount()
        => new()
        {
            Id = 42,
            IdentityKind = AnonymousIdentityRuntime.AnonymousAccountKind,
            AccountSubjectHash = new string('a', AccountSubjectHashRequirement.Sha256HexLength)
        };
}
