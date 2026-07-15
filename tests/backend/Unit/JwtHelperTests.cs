using Microsoft.Extensions.Options;
using Microsoft.Extensions.Configuration;
using Microsoft.IdentityModel.Tokens;
using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Tests.Fixtures;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>
/// Unit tests for JwtHelper — token generation and refresh-token randomness.
/// No HTTP or DB deps needed; constructs the helper directly via IOptions.
/// </summary>
[Collection(nameof(EnvironmentVariableCollection))]
public sealed class JwtHelperTests
{
    private const string StableAccountSubjectHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    private static JwtHelper CreateHelper(
        string secretKey = TestSecrets.JwtSigningKey,
        string issuer = "test-issuer",
        string audience = "test-audience",
        int expiresMinutes = 15)
    {
        var settings = new JwtSettings
        {
            KeyVersion = "test-v1",
            SecretKey = secretKey,
            Issuer = issuer,
            Audience = audience,
            AccessTokenExpiresMinutes = expiresMinutes
        };
        return new JwtHelper(Options.Create(settings));
    }

    private static User TestUser(int id = 1, string role = "admin")
        => new()
        {
            Id = id,
            IdentityKind = AnonymousIdentityRuntime.AnonymousAccountKind,
            AccountSubjectHash = StableAccountSubjectHash
        };

    // ─── GenerateAccessToken ──────────────────────────────────────────────

    [Fact]
    public void GenerateAccessToken_ReturnsNonEmptyString()
    {
        var helper = CreateHelper();
        string token = helper.GenerateAccessToken(TestUser());
        Assert.False(string.IsNullOrWhiteSpace(token));
    }

    [Fact]
    public void GenerateAccessToken_ProducesValidJwtWithThreeParts()
    {
        var helper = CreateHelper();
        string token = helper.GenerateAccessToken(TestUser());
        // A JWT is always three base64url segments separated by dots
        Assert.Equal(3, token.Split('.').Length);
    }

    [Fact]
    public void GenerateAccessToken_BindsCurrentKeyVersionAsKid()
    {
        string token = CreateHelper().GenerateAccessToken(TestUser());

        var jwt = new JwtSecurityTokenHandler().ReadJwtToken(token);

        Assert.Equal("test-v1", jwt.Header.Kid);
        Assert.Equal(SecurityAlgorithms.HmacSha256, jwt.Header.Alg);
    }

    [Fact]
    public void GenerateAccessToken_ContainsUserIdClaim()
    {
        var helper = CreateHelper();
        string token = helper.GenerateAccessToken(TestUser(id: 42));

        var claims = ParseClaims(token);
        // JwtSecurityTokenHandler serialises ClaimTypes.NameIdentifier as the short JWT name "nameid"
        var sub = claims.FirstOrDefault(c => c.Type == ClaimTypes.NameIdentifier || c.Type == "nameid");
        Assert.NotNull(sub);
        Assert.Equal("42", sub.Value);
    }

    [Fact]
    public void GenerateAccessToken_OmitsRoleAndUsernameClaimsForUserTokens()
    {
        using var _ = SetAnonymousIdentityMode(null);
        var helper = CreateHelper();
        string token = helper.GenerateAccessToken(TestUser(role: "admin"));

        var claims = ParseClaims(token);
        Assert.DoesNotContain(claims, IsRoleClaim);
        Assert.DoesNotContain(claims, IsUserNameClaim);
    }

    [Fact]
    public void GenerateAccessToken_AnonymousIdentityMode_DoesNotCarryLegacyAdminRole()
    {
        using var _ = SetAnonymousIdentityMode("1");
        var helper = CreateHelper();
        var user = TestUser(role: "admin");
        user.IdentityKind = AnonymousIdentityRuntime.AnonymousAccountKind;

        string token = helper.GenerateAccessToken(user);

        var claims = ParseClaims(token);
        Assert.DoesNotContain(claims, IsRoleClaim);
        Assert.Contains(claims, claim => claim.Type == "identity_kind" && claim.Value == AnonymousIdentityRuntime.AnonymousAccountKind);
    }

    [Fact]
    public void GenerateAccessToken_UsesPersistedSubjectAcrossAccountIdsAndHandleChanges()
    {
        var helper = CreateHelper();
        var first = TestUser(id: 42);
        first.IdentityKind = AnonymousIdentityRuntime.AnonymousAccountKind;
        first.PasskeyUserHandle = StablePasskeyUserHandle;
        first.AccountSubjectHash = StableAccountSubjectHash;
        var second = TestUser(id: 314);
        second.IdentityKind = AnonymousIdentityRuntime.AnonymousAccountKind;
        second.PasskeyUserHandle = StablePasskeyUserHandle;
        second.AccountSubjectHash = StableAccountSubjectHash;

        string firstToken = helper.GenerateAccessToken(first);
        string secondToken = helper.GenerateAccessToken(second);

        var firstClaims = ParseClaims(firstToken).ToArray();
        var secondClaims = ParseClaims(secondToken).ToArray();
        string firstSubject = Assert.Single(firstClaims, claim => claim.Type == AnonymousIdentityRuntime.AccountSubjectHashClaim).Value;
        string secondSubject = Assert.Single(secondClaims, claim => claim.Type == AnonymousIdentityRuntime.AccountSubjectHashClaim).Value;
        Assert.Equal(firstSubject, secondSubject);
        Assert.Matches("^[0-9a-f]{64}$", firstSubject);
        Assert.NotEqual(HashIdentity("42"), firstSubject);
        Assert.NotEqual(HashIdentity("314"), secondSubject);
        Assert.Equal(StableAccountSubjectHash, firstSubject);
    }

    [Fact]
    public void GenerateAccessToken_IncludesAccountSubjectHashClaim()
    {
        var helper = CreateHelper();
        var user = TestUser(id: 42);
        user.PasskeyUserHandle = "Anon_Subject";
        user.IdentityKind = AnonymousIdentityRuntime.AnonymousAccountKind;
        user.AccountSubjectHash = new string('b', AccountSubjectHashRequirement.Sha256HexLength);

        string token = helper.GenerateAccessToken(user);

        var claims = ParseClaims(token);
        Assert.Contains(claims, claim =>
            claim.Type == AccountSubjectHasher.ClaimType &&
            claim.Value == user.AccountSubjectHash);
    }

    [Fact]
    public void GenerateAccessToken_MissingPhysicalSubjectFailsClosed()
    {
        var helper = CreateHelper();
        var user = TestUser(id: 42);
        user.AccountSubjectHash = null;

        InvalidOperationException error = Assert.Throws<InvalidOperationException>(
            () => helper.GenerateAccessToken(user));

        Assert.Contains("access-token-issuance", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void GenerateAdminAccessToken_UsesAdminPrincipalAndPermissionClaimsWithoutLegacyRole()
    {
        var helper = CreateHelper();
        string token = helper.GenerateAdminAccessToken(
            new AdminPrincipal
            {
                Id = 7,
                Handle = "root",
                Permissions = string.Join(',', AdminPermissions.AdminManage, AdminPermissions.SystemConfig)
            },
            new AdminSession
            {
                SessionId = "admin-session-1",
                AdminPrincipalId = 7,
                IdleExpiresAtUtc = DateTime.UtcNow.AddHours(1),
                AbsoluteExpiresAtUtc = DateTime.UtcNow.AddHours(8)
            },
            [AdminPermissions.AdminManage, AdminPermissions.SystemConfig]);

        var claims = ParseClaims(token).ToArray();
        Assert.Equal("test-v1", new JwtSecurityTokenHandler().ReadJwtToken(token).Header.Kid);
        Assert.DoesNotContain(claims, IsRoleClaim);
        Assert.Contains(claims, claim => claim.Type == "identity_kind" && claim.Value == AnonymousIdentityRuntime.AdminPrincipalKind);
        Assert.Contains(claims, claim => claim.Type == "admin_id" && claim.Value == "7");
        Assert.Contains(claims, claim => claim.Type == "admin_sid" && claim.Value == "admin-session-1");
        Assert.Contains(claims, claim => claim.Type == AdminPermissions.PermissionClaimType && claim.Value == AdminPermissions.AdminManage);
        Assert.Contains(claims, claim => claim.Type == AdminPermissions.PermissionClaimType && claim.Value == AdminPermissions.SystemConfig);
    }

    [Fact]
    public void GenerateAccessToken_WithSessionId_IncludesSessionClaim()
    {
        var helper = CreateHelper();
        string token = helper.GenerateAccessToken(TestUser(), sessionId: "sess-abc-123");

        var claims = ParseClaims(token);
        var sid = claims.FirstOrDefault(c => c.Type == "sid");
        Assert.NotNull(sid);
        Assert.Equal("sess-abc-123", sid.Value);
    }

    [Fact]
    public void GenerateAccessToken_WithoutSessionId_OmitsSessionClaim()
    {
        var helper = CreateHelper();
        string token = helper.GenerateAccessToken(TestUser(), sessionId: null);

        var claims = ParseClaims(token);
        Assert.DoesNotContain(claims, c => c.Type == "sid");
    }

    [Fact]
    public void GenerateAccessToken_WithEmptySessionId_OmitsSessionClaim()
    {
        var helper = CreateHelper();
        string token = helper.GenerateAccessToken(TestUser(), sessionId: "");

        var claims = ParseClaims(token);
        Assert.DoesNotContain(claims, c => c.Type == "sid");
    }

    [Fact]
    public void GenerateAccessToken_MfaVerifiedTrue_SetsMfaClaim1()
    {
        var helper = CreateHelper();
        string token = helper.GenerateAccessToken(TestUser(), mfaVerified: true);

        var claims = ParseClaims(token);
        var mfa = claims.FirstOrDefault(c => c.Type == "mfa");
        Assert.NotNull(mfa);
        Assert.Equal("1", mfa.Value);
    }

    [Fact]
    public void GenerateAccessToken_MfaVerifiedFalse_SetsMfaClaim0()
    {
        var helper = CreateHelper();
        string token = helper.GenerateAccessToken(TestUser(), mfaVerified: false);

        var claims = ParseClaims(token);
        var mfa = claims.FirstOrDefault(c => c.Type == "mfa");
        Assert.NotNull(mfa);
        Assert.Equal("0", mfa.Value);
    }

    [Fact]
    public void GenerateAccessToken_UsesConfiguredIssuerAndAudience()
    {
        var helper = CreateHelper(issuer: "my-issuer", audience: "my-audience");
        string token = helper.GenerateAccessToken(TestUser());

        var jwt = new JwtSecurityTokenHandler().ReadJwtToken(token);
        Assert.Equal("my-issuer", jwt.Issuer);
        Assert.Contains("my-audience", jwt.Audiences);
    }

    [Theory]
    [InlineData(1)]
    [InlineData(15)]
    [InlineData(60)]
    [Trait("Category", "SecurityStateMachine")]
    public void GenerateAccessToken_ReturnedExpiryMatchesJwtAndConfiguredMinutes(int expiresMinutes)
    {
        var helper = CreateHelper(expiresMinutes: expiresMinutes);
        IssuedAccessToken issuedToken = helper.GenerateAccessToken(TestUser());

        var jwt = new JwtSecurityTokenHandler().ReadJwtToken(issuedToken.Token);
        var diff = jwt.ValidTo - jwt.ValidFrom;
        Assert.Equal(issuedToken.ExpiresAtUtc, new DateTimeOffset(DateTime.SpecifyKind(jwt.ValidTo, DateTimeKind.Utc)));
        Assert.Equal((double)expiresMinutes, diff.TotalMinutes);
    }

    [Fact]
    [Trait("Category", "SecurityStateMachine")]
    public void GenerateAccessToken_ReloadableExpiryChangeAppliesToNextIssueWithoutRestart()
    {
        var configuration = new ConfigurationManager();
        configuration["Jwt:AccessTokenExpiresMinutes"] = "60";
        var helper = new JwtHelper(Options.Create(new JwtSettings
        {
            SecretKey = TestSecrets.JwtSigningKey,
            Issuer = "reloadable-expiry-test",
            Audience = "reloadable-expiry-test",
            AccessTokenExpiresMinutes = 15
        }), configuration);

        IssuedAccessToken beforeRollback = helper.GenerateAccessToken(TestUser());
        configuration["Jwt:AccessTokenExpiresMinutes"] = "15";
        IssuedAccessToken afterRollback = helper.GenerateAccessToken(TestUser());

        Assert.Equal(60d, ReadLifetimeMinutes(beforeRollback));
        Assert.Equal(15d, ReadLifetimeMinutes(afterRollback));
    }

    [Fact]
    public void GenerateAdminAccessToken_OmitsRoleClaimAndCarriesAdminPrincipalClaims()
    {
        var helper = CreateHelper();
        var principal = new AdminPrincipal
        {
            Id = 42,
            Handle = "root-admin",
            Permissions = string.Join('\n', [AdminPermissions.AdminManage, AdminPermissions.SystemConfig])
        };
        var session = new AdminSession
        {
            SessionId = "admin-session-1",
            AdminPrincipalId = principal.Id
        };

        string token = helper.GenerateAdminAccessToken(
            principal,
            session,
            [AdminPermissions.AdminManage, AdminPermissions.SystemConfig, AdminPermissions.AdminManage],
            stepUpVerified: true);

        var claims = ParseClaims(token).ToArray();
        Assert.DoesNotContain(claims, IsRoleClaim);
        Assert.Contains(claims, claim => claim.Type == "identity_kind" && claim.Value == AnonymousIdentityRuntime.AdminPrincipalKind);
        Assert.Contains(claims, claim => claim.Type == "admin_id" && claim.Value == "42");
        Assert.Contains(claims, claim => claim.Type == "admin_sid" && claim.Value == "admin-session-1");
        Assert.Contains(claims, claim => claim.Type == "admin_step_up" && claim.Value == "1");
        Assert.Contains(claims, claim => claim.Type == AdminPermissions.PermissionClaimType && claim.Value == AdminPermissions.AdminManage);
        Assert.Contains(claims, claim => claim.Type == AdminPermissions.PermissionClaimType && claim.Value == AdminPermissions.SystemConfig);
        Assert.Equal(
            1,
            claims.Count(claim => claim.Type == AdminPermissions.PermissionClaimType && claim.Value == AdminPermissions.AdminManage));
    }

    // ─── GenerateRefreshToken ─────────────────────────────────────────────

    [Fact]
    public void GenerateRefreshToken_ReturnsNonEmptyString()
    {
        string token = CreateHelper().GenerateRefreshToken();
        Assert.False(string.IsNullOrWhiteSpace(token));
    }

    [Fact]
    public void GenerateRefreshToken_ContainsNoUrlUnsafeChars()
    {
        string token = CreateHelper().GenerateRefreshToken();
        Assert.DoesNotContain('+', token);
        Assert.DoesNotContain('/', token);
        Assert.DoesNotContain('=', token);
    }

    [Fact]
    public void GenerateRefreshToken_ProducesDifferentValueEachCall()
    {
        var helper = CreateHelper();
        var tokens = new HashSet<string>(
            Enumerable.Range(0, 20).Select(_ => helper.GenerateRefreshToken()));
        // With 32 bytes of CSPRNG entropy, collision probability is astronomically low
        Assert.Equal(20, tokens.Count);
    }

    [Fact]
    public void GenerateRefreshToken_IsBase64UrlSafe()
    {
        string token = CreateHelper().GenerateRefreshToken();
        Assert.Equal(43, token.Length);
        Assert.Matches("^[A-Za-z0-9_-]*$", token);
    }

    [Fact]
    [Trait("Category", "SecurityStateMachine")]
    public void SigningKeyRing_ResolvesOnlyCurrentOrActiveMatchingKid()
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        var settings = new JwtSettings
        {
            KeyVersion = "v2-2026-07",
            SecretKey = TestSecrets.JwtSigningKey,
            RotationWindowDays = 30,
            PreviousKeys =
            [
                new JwtPreviousKeySettings
                {
                    Version = "v1-2026-01",
                    Key = TestSecrets.SecondaryJwtSigningKey,
                    AcceptUntilUtc = now.AddDays(7)
                }
            ]
        };

        Assert.Equal("v2-2026-07", Assert.Single(JwtSigningKeyRing.ResolveValidationKeys(settings, "v2-2026-07", now)).KeyId);
        Assert.Equal("v1-2026-01", Assert.Single(JwtSigningKeyRing.ResolveValidationKeys(settings, "v1-2026-01", now)).KeyId);
        Assert.Empty(JwtSigningKeyRing.ResolveValidationKeys(settings, "unknown", now));
        Assert.Empty(JwtSigningKeyRing.ResolveValidationKeys(settings, "v1-2026-01", now.AddDays(8)));
        Assert.Empty(JwtSigningKeyRing.ResolveValidationKeys(settings, null, now));
    }

    [Fact]
    [Trait("Category", "SecurityStateMachine")]
    public void SigningKeyRing_AllowsMissingKidOnlyInsideExplicitLegacyWindow()
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        var settings = new JwtSettings
        {
            KeyVersion = "v2-2026-07",
            SecretKey = TestSecrets.JwtSigningKey,
            RotationWindowDays = 30,
            LegacyNoKidAcceptUntilUtc = now.AddHours(1),
            PreviousKeys =
            [
                new JwtPreviousKeySettings
                {
                    Version = "v1-2026-01",
                    Key = TestSecrets.SecondaryJwtSigningKey,
                    AcceptUntilUtc = now.AddDays(7)
                }
            ]
        };

        Assert.Equal(2, JwtSigningKeyRing.ResolveValidationKeys(settings, null, now).Count);
        Assert.Empty(JwtSigningKeyRing.ResolveValidationKeys(settings, null, now.AddHours(2)));
    }

    // ─── helpers ──────────────────────────────────────────────────────────

    private static IEnumerable<Claim> ParseClaims(string token)
    {
        var jwt = new JwtSecurityTokenHandler().ReadJwtToken(token);
        return jwt.Claims;
    }

    private static double ReadLifetimeMinutes(IssuedAccessToken issuedToken)
    {
        var jwt = new JwtSecurityTokenHandler().ReadJwtToken(issuedToken.Token);
        return (jwt.ValidTo - jwt.ValidFrom).TotalMinutes;
    }

    private static bool IsRoleClaim(Claim claim)
        => claim.Type == ClaimTypes.Role || claim.Type == "role";

    private static bool IsUserNameClaim(Claim claim)
        => claim.Type == ClaimTypes.Name || claim.Type == "unique_name" || claim.Type == "name";

    private static string HashIdentity(string value)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    private static IDisposable SetAnonymousIdentityMode(string? value)
        => new EnvironmentVariableScope(AnonymousIdentityRuntime.ModeEnvironmentVariable, value);

    private sealed class EnvironmentVariableScope : IDisposable
    {
        private readonly string _name;
        private readonly string? _previousValue;

        public EnvironmentVariableScope(string name, string? value)
        {
            _name = name;
            _previousValue = Environment.GetEnvironmentVariable(name);
            Environment.SetEnvironmentVariable(name, value);
        }

        public void Dispose()
            => Environment.SetEnvironmentVariable(_name, _previousValue);
    }

    private const string StablePasskeyUserHandle = "stable-account-handle";
}
