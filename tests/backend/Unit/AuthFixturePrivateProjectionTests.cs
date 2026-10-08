using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Services.Fixtures;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AuthFixturePrivateProjectionTests
{
    private static readonly JsonSerializerOptions s_json = new(JsonSerializerDefaults.Web);
    internal static readonly DateTimeOffset s_now = new(2026, 10, 2, 0, 0, 0, TimeSpan.Zero);

    internal static AuthFixturePrivatePayload Payload()
    {
        var identity = new AuthFixturePrivateIdentity("run", "ns", "auth-basic", new string('a', 40),
            "sha256:" + new string('b', 64), "sha256:" + new string('c', 64),
            "sha256:" + new string('d', 64), "sha256:" + new string('e', 64), new string('f', 64));
        var credentials = new AdminSessionTokens("unit-only-not-runtime-token", s_now.AddMinutes(5), "owned-session", s_now.AddHours(8).UtcDateTime);
        var fact = new AuthFixtureEntityObservation("admin", "7", true, "auth.admin.full-permission", "admin-full-permission",
            "admin.full-permission", AuthFixtureSeeder.OwnedAdminHandle("ns", "run", "admin.full-permission"),
            new Dictionary<string, object?>
            {
                ["adminSessionVersion"] = 1L,
                ["adminPrincipalVersion"] = 1L,
                ["adminSessionIdleExpiresAtUtc"] = s_now.AddHours(8),
                ["adminSessionAbsoluteExpiresAtUtc"] = s_now.AddHours(12)
            });
        return new(identity, fact, credentials, s_now.AddMinutes(5));
    }

    [Theory]
    [InlineData("run")]
    [InlineData("namespace")]
    [InlineData("profile")]
    [InlineData("source")]
    [InlineData("fingerprint")]
    [InlineData("generation")]
    [InlineData("catalog")]
    [InlineData("variant")]
    [InlineData("plan")]
    public void DataProtectionCarrier_RejectsCrossIdentityReplay(string field)
    {
        var provider = new EphemeralDataProtectionProvider();
        AuthFixturePrivatePayload value = Payload();
        string opaque = provider.CreateProtector(AuthFixtureSeeder.PrivatePurpose).Protect(JsonSerializer.Serialize(value, s_json));
        var request = new AuthFixturePrivateVerificationRequest(value.Identity, opaque, value.PublicFact);
        Assert.Equal(value.Identity, AuthFixtureSeeder.OpenPrivateCarrier(provider, request, s_now).Identity);
        AuthFixturePrivateIdentity wrong = field switch
        {
            "run" => value.Identity with { RunId = "foreign" },
            "namespace" => value.Identity with { Namespace = "foreign" },
            "profile" => value.Identity with { ProfileId = "foreign" },
            "source" => value.Identity with { SourceCommit = new string('0', 40) },
            "fingerprint" => value.Identity with { SourceFingerprint = "foreign" },
            "generation" => value.Identity with { ServiceGeneration = "foreign" },
            "catalog" => value.Identity with { CatalogDigest = "foreign" },
            "variant" => value.Identity with { VariantPlanDigest = "foreign" },
            _ => value.Identity with { PlanDigest = "foreign" }
        };
        Assert.Throws<InvalidOperationException>(() => AuthFixtureSeeder.OpenPrivateCarrier(provider, request with { Identity = wrong }, s_now));
        Assert.Throws<InvalidOperationException>(() => AuthFixtureSeeder.OpenPrivateCarrier(provider, request, value.NotAfter));
        Assert.Throws<InvalidOperationException>(() => AuthFixtureSeeder.OpenPrivateCarrier(new EphemeralDataProtectionProvider(), request, s_now));
        Assert.Throws<InvalidOperationException>(() => AuthFixtureSeeder.OpenPrivateCarrier(provider,
            request with
            {
                Opaque = provider.CreateProtector("foreign-purpose").Protect(JsonSerializer.Serialize(value, s_json))
            }, s_now));
        Assert.Throws<InvalidOperationException>(() => AuthFixtureSeeder.OpenPrivateCarrier(provider,
            request with
            {
                PublicFact = value.PublicFact with
                {
                    Id = "8"
                }
            }, s_now));
    }

    [Theory]
    [InlineData("principal")]
    [InlineData("session")]
    [InlineData("hash")]
    [InlineData("disabled")]
    [InlineData("revoked")]
    [InlineData("session-version")]
    [InlineData("principal-version")]
    [InlineData("idle-expiry")]
    [InlineData("absolute-expiry")]
    public void IndependentAuthority_RejectsDurableDrift(string field)
    {
        AuthFixturePrivatePayload payload = Payload();
        var principal = new AdminSessionProjectionPrincipalUpdate(7, AdminSessionProjectionPrincipalStatus.Active, 1, 1);
        var session = new AdminSessionProjectionSessionUpdate("owned-session", 7,
            SHA256.HashData(Encoding.UTF8.GetBytes(payload.Credentials.AccessToken)), null,
            s_now.AddHours(8), s_now.AddHours(12), 1, 1, principal);
        AuthFixtureSeeder.RequirePrivateAuthority(payload, session, principal);
        AdminSessionProjectionSessionUpdate changed = field switch
        {
            "principal" => session with { PrincipalId = 8 },
            "session" => session with { SessionId = "foreign" },
            "hash" => session with { AccessTokenHash = new byte[32] },
            "revoked" => session with { RevokedAtUtc = s_now },
            "session-version" => session with { Version = 2 },
            "idle-expiry" => session with { IdleExpiresAtUtc = s_now },
            "absolute-expiry" => session with { AbsoluteExpiresAtUtc = s_now },
            _ => session
        };
        AdminSessionProjectionPrincipalUpdate changedPrincipal = field switch
        {
            "disabled" => principal with { Status = AdminSessionProjectionPrincipalStatus.Disabled },
            "principal-version" => principal with { Version = 2 },
            _ => principal
        };
        Assert.Throws<InvalidOperationException>(() => AuthFixtureSeeder.RequirePrivateAuthority(payload, changed, changedPrincipal));
    }

    [Theory]
    [InlineData("key")]
    [InlineData("issuer")]
    [InlineData("audience")]
    [InlineData("expired")]
    [InlineData("signature")]
    [InlineData("principal")]
    [InlineData("session")]
    [InlineData("permission")]
    [InlineData("step-up")]
    public async Task PrivateVerifier_UsesRegisteredProductionJwtOwnerAndRejectsInvalidClaims(string drift)
    {
        var clock = new VerificationClock(s_now);
        var services = new ServiceCollection();
        services.AddLogging();
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Jwt:KeyVersion"] = "test-v1",
            ["Jwt:SecretKey"] = TestSecrets.JwtSigningKey,
            ["Jwt:Issuer"] = "fixture-test-issuer",
            ["Jwt:Audience"] = "fixture-test-audience",
            ["Jwt:AccessTokenExpiresMinutes"] = "15"
        }).Build();
        services.AddSingleton<IConfiguration>(config);
        services.AddJwtAuthentication(config, clock);
        using var provider = services.BuildServiceProvider();
        JwtBearerOptions options = provider.GetRequiredService<IOptionsMonitor<JwtBearerOptions>>()
            .Get(JwtBearerDefaults.AuthenticationScheme);
        var principal = new AdminPrincipal { Id = 7, Handle = "fxauth-owned", Status = AdminPrincipalStatus.Active };
        var session = new AdminSession
        {
            SessionId = "owned-session",
            AdminPrincipalId = 7,
            IdleExpiresAtUtc = s_now.AddHours(8).UtcDateTime,
            AbsoluteExpiresAtUtc = s_now.AddHours(12).UtcDateTime
        };
        var authorityPrincipal = new AdminSessionProjectionPrincipalUpdate(7, AdminSessionProjectionPrincipalStatus.Active, 1, 1);
        var authority = new AdminSessionProjectionSessionUpdate(session.SessionId, 7, new byte[32], null,
            s_now.AddHours(8), s_now.AddHours(12), 1, 1, authorityPrincipal);
        string[] permissions = [.. AdminPermissions.All.Order(StringComparer.Ordinal)];
        var token = provider.GetRequiredService<IJwtHelper>().GenerateAdminAccessToken(principal, session, permissions);
        AuthFixturePrivatePayload payload = Payload() with
        {
            Credentials = new(token.Token, token.ExpiresAtUtc, session.SessionId, session.IdleExpiresAtUtc)
        };
        await AuthFixtureSeeder.RequirePrivateJwtAsync(options, payload, authority, permissions);
        if (drift == "expired")
            clock.Current = token.ExpiresAtUtc;
        else if (drift == "signature")
        {
            string[] parts = token.Token.Split('.');
            parts[2] = (parts[2][0] == 'A' ? "B" : "A") + parts[2][1..];
            payload = payload with
            {
                Credentials = payload.Credentials with
                {
                    AccessToken = string.Join('.', parts)
                }
            };
        }
        else
        {
            var settings = new JwtSettings
            {
                KeyVersion = "test-v1",
                SecretKey = drift == "key" ? TestSecrets.SecondaryJwtSigningKey : TestSecrets.JwtSigningKey,
                Issuer = drift == "issuer" ? "foreign" : "fixture-test-issuer",
                Audience = drift == "audience" ? "foreign" : "fixture-test-audience",
                AccessTokenExpiresMinutes = 15
            };
            if (drift == "principal")
                principal.Id = 8;
            if (drift == "session")
                session.SessionId = "foreign";
            session.StepUpVerified = drift == "step-up";
            token = new JwtHelper(Options.Create(settings), timeProvider: clock).GenerateAdminAccessToken(principal, session,
                drift == "permission" ? [] : permissions);
            payload = payload with
            {
                Credentials = payload.Credentials with
                {
                    AccessToken = token.Token
                }
            };
        }
        await Assert.ThrowsAsync<InvalidOperationException>(() => AuthFixtureSeeder.RequirePrivateJwtAsync(options, payload, authority, permissions));
    }

    private sealed class VerificationClock(DateTimeOffset initial) : TimeProvider
    {
        public DateTimeOffset Current { get; set; } = initial;
        public override DateTimeOffset GetUtcNow() => Current;
    }
}
