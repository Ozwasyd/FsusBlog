using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Tests.Fixtures;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;

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
        int expiresMinutes = 15,
        TimeProvider? timeProvider = null)
    {
        var settings = new JwtSettings
        {
            KeyVersion = "test-v1",
            SecretKey = secretKey,
            Issuer = issuer,
            Audience = audience,
            AccessTokenExpiresMinutes = expiresMinutes
        };
        return new JwtHelper(Options.Create(settings), configuration: null, timeProvider: timeProvider);
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
        string token = helper.GenerateAccessToken(TestUser(), null, CurrentContext());
        Assert.False(string.IsNullOrWhiteSpace(token));
    }

    [Fact]
    public void GenerateAccessToken_UsesInjectedBusinessWallClockWithoutHostUtcNow()
    {
        TestTemporalContext temporal = TestTemporalContext.CreateCanonical();
        var helper = CreateHelper(expiresMinutes: 15, timeProvider: temporal.BusinessClock);

        IssuedAccessToken first = helper.GenerateAccessToken(TestUser(), null, CurrentContext());
        var firstJwt = new JwtSecurityTokenHandler().ReadJwtToken(first.Token);
        DateTimeOffset firstIssued = new(
            DateTime.SpecifyKind(firstJwt.Payload.IssuedAt, DateTimeKind.Utc));
        Assert.Equal(
            DateTimeOffset.FromUnixTimeSeconds(temporal.BusinessEpochUtc.ToUnixTimeSeconds()),
            firstIssued);

        temporal.Advance(TimeSpan.FromHours(2));
        IssuedAccessToken second = helper.GenerateAccessToken(TestUser(), null, CurrentContext());
        var secondJwt = new JwtSecurityTokenHandler().ReadJwtToken(second.Token);
        DateTimeOffset secondIssued = new(
            DateTime.SpecifyKind(secondJwt.Payload.IssuedAt, DateTimeKind.Utc));
        Assert.Equal(firstIssued.AddHours(2), secondIssued);
        Assert.Equal(first.ExpiresAtUtc.AddHours(2), second.ExpiresAtUtc);
    }

    [Fact]
    public void GenerateAccessToken_ProducesValidJwtWithThreeParts()
    {
        var helper = CreateHelper();
        string token = helper.GenerateAccessToken(TestUser(), null, CurrentContext());
        // A JWT is always three base64url segments separated by dots
        Assert.Equal(3, token.Split('.').Length);
    }

    [Fact]
    public void GenerateAccessToken_BindsCurrentKeyVersionAsKid()
    {
        string token = CreateHelper().GenerateAccessToken(TestUser(), null, CurrentContext());

        var jwt = new JwtSecurityTokenHandler().ReadJwtToken(token);

        Assert.Equal("test-v1", jwt.Header.Kid);
        Assert.Equal(SecurityAlgorithms.HmacSha256, jwt.Header.Alg);
    }

    [Fact]
    public void GenerateAccessToken_ContainsUserIdClaim()
    {
        var helper = CreateHelper();
        string token = helper.GenerateAccessToken(TestUser(id: 42), null, CurrentContext());

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
        string token = helper.GenerateAccessToken(TestUser(role: "admin"), null, CurrentContext());

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

        string token = helper.GenerateAccessToken(user, null, CurrentContext());

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

        string firstToken = helper.GenerateAccessToken(first, null, CurrentContext());
        string secondToken = helper.GenerateAccessToken(second, null, CurrentContext());

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

        string token = helper.GenerateAccessToken(user, null, CurrentContext());

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
            () => helper.GenerateAccessToken(user, null, CurrentContext()));

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
        string token = helper.GenerateAccessToken(TestUser(), sessionId: "sess-abc-123", authenticationContext: CurrentContext());

        var claims = ParseClaims(token);
        var sid = claims.FirstOrDefault(c => c.Type == "sid");
        Assert.NotNull(sid);
        Assert.Equal("sess-abc-123", sid.Value);
    }

    [Fact]
    public void GenerateAccessToken_WithoutSessionId_OmitsSessionClaim()
    {
        var helper = CreateHelper();
        string token = helper.GenerateAccessToken(TestUser(), sessionId: null, authenticationContext: CurrentContext());

        var claims = ParseClaims(token);
        Assert.DoesNotContain(claims, c => c.Type == "sid");
    }

    [Fact]
    public void GenerateAccessToken_WithEmptySessionId_OmitsSessionClaim()
    {
        var helper = CreateHelper();
        string token = helper.GenerateAccessToken(TestUser(), sessionId: "", authenticationContext: CurrentContext());

        var claims = ParseClaims(token);
        Assert.DoesNotContain(claims, c => c.Type == "sid");
    }

    [Fact]
    public void GenerateAccessToken_CurrentMfaContext_SetsMfaClaim1()
    {
        var helper = CreateHelper();
        string token = helper.GenerateAccessToken(TestUser(), null, CurrentContext() with { Strength = UserSessionAuthenticationStrengths.Mfa });

        var claims = ParseClaims(token);
        var mfa = claims.FirstOrDefault(c => c.Type == "mfa");
        Assert.NotNull(mfa);
        Assert.Equal("1", mfa.Value);
    }

    [Fact]
    public void GenerateAccessToken_FormerUnverifiedContextCannotIssueAToken()
    {
        var helper = CreateHelper();
        var context = new UserSessionAuthenticationContext(
            "other", "legacy_unverified", DateTime.UtcNow, CredentialRowId: null);

        Assert.False(UserSessionAuthenticationContract.IsCoarseMfa(context.Method, context.Strength, context.CredentialRowId));
        Assert.Throws<InvalidOperationException>(() => helper.GenerateAccessToken(TestUser(), null, context));
    }

    [Fact]
    public void GenerateAccessToken_StructuredAuthenticationContext_PreservesSafeProvenanceOnly()
    {
        var helper = CreateHelper();
        DateTime authenticatedAtUtc = new(2026, 7, 20, 1, 2, 3, DateTimeKind.Utc);
        string token = helper.GenerateAccessToken(
            TestUser(),
            "session-auth-context",
            new UserSessionAuthenticationContext(
                UserSessionAuthenticationMethods.Passkey,
                UserSessionAuthenticationStrengths.WebAuthnUv,
                authenticatedAtUtc,
                CredentialRowId: 812,
                UserSessionDurationPolicies.BrowserSession));

        IEnumerable<Claim> claims = ParseClaims(token);
        Assert.Contains(claims, claim => claim.Type == "auth_method" && claim.Value == "passkey");
        Assert.Contains(claims, claim => claim.Type == "auth_strength" && claim.Value == "webauthn_uv");
        Assert.Contains(claims, claim => claim.Type == CurrentAuthSessionClaims.AuthenticatedAt &&
            claim.Value == new DateTimeOffset(authenticatedAtUtc).ToUnixTimeSeconds().ToString(System.Globalization.CultureInfo.InvariantCulture));
        Assert.Contains(claims, claim => claim.Type == CurrentAuthSessionClaims.DurationPolicy &&
            claim.Value == UserSessionDurationPolicies.BrowserSession);
        Assert.Contains(claims, claim => claim.Type == CurrentAuthSessionClaims.SessionMode && claim.Value == "normal");
        Assert.Contains(claims, claim => claim.Type == "mfa" && claim.Value == "1");
        Assert.DoesNotContain(claims, claim => claim.Type.Contains("credential", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void GenerateAccessToken_RestrictedSessionCarriesExplicitModeClaim()
    {
        var helper = CreateHelper();
        UserSessionAuthenticationContext context = CurrentContext() with
        {
            SessionMode = UserSessionMode.Restricted
        };

        string token = helper.GenerateAccessToken(TestUser(), "restricted-session", context);

        Assert.Contains(
            ParseClaims(token),
            claim => claim.Type == UserSessionModes.ClaimType && claim.Value == "restricted");
    }

    [Fact]
    public void GenerateAccessToken_UsesConfiguredIssuerAndAudience()
    {
        var helper = CreateHelper(issuer: "my-issuer", audience: "my-audience");
        string token = helper.GenerateAccessToken(TestUser(), null, CurrentContext());

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
        IssuedAccessToken issuedToken = helper.GenerateAccessToken(TestUser(), null, CurrentContext());

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
            KeyVersion = "test-v1",
            SecretKey = TestSecrets.JwtSigningKey,
            Issuer = "reloadable-expiry-test",
            Audience = "reloadable-expiry-test",
            AccessTokenExpiresMinutes = 15
        }), configuration);

        IssuedAccessToken beforeRollback = helper.GenerateAccessToken(TestUser(), null, CurrentContext());
        configuration["Jwt:AccessTokenExpiresMinutes"] = "15";
        IssuedAccessToken afterRollback = helper.GenerateAccessToken(TestUser(), null, CurrentContext());

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
            AdminPrincipalId = principal.Id,
            StepUpVerified = true
        };

        string token = helper.GenerateAdminAccessToken(
            principal,
            session,
            [AdminPermissions.AdminManage, AdminPermissions.SystemConfig, AdminPermissions.AdminManage]);

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

    [Theory]
    [InlineData("test-v1", true)]
    [InlineData(null, false)]
    [InlineData("", false)]
    [InlineData("test-v0", false)]
    [InlineData("unknown", false)]
    [InlineData(" test-v1", false)]
    [InlineData("test-v1 ", false)]
    [InlineData("TEST-v1", false)]
    [Trait("Category", "SecurityStateMachine")]
    public void CurrentSigningKey_RequiresExactCurrentKid(string? kid, bool expected)
    {
        SymmetricSecurityKey key = CurrentJwtSigningKey.CreateKey("test-v1", TestSecrets.JwtSigningKey);
        var token = new JwtSecurityToken();
        if (kid is not null)
        {
            token.Header["kid"] = kid;
        }

        Assert.Equal(expected, CurrentJwtSigningKey.HasExactCurrentKeyId(key, token, "test-v1"));
    }

    [Fact]
    [Trait("Category", "SecurityStateMachine")]
    public void CurrentSigningKey_RejectsAnOldValidationKeyEvenWithCurrentKid()
    {
        SymmetricSecurityKey oldKey = CurrentJwtSigningKey.CreateKey("test-v0", TestSecrets.SecondaryJwtSigningKey);
        var token = new JwtSecurityToken();
        token.Header["kid"] = "test-v1";

        Assert.False(CurrentJwtSigningKey.HasExactCurrentKeyId(oldKey, token, "test-v1"));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("user")]
    [InlineData("admin_principal")]
    [InlineData(" anonymous_account ")]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Negative, InvariantId = "jwt-issuer-rejects-noncurrent-account-identity")]
    public void GenerateAccessToken_RejectsMissingLegacyAdminOrPaddedIdentity(string? identityKind)
    {
        User user = TestUser();
        user.IdentityKind = identityKind!;

        Assert.Throws<InvalidOperationException>(() => CreateHelper().GenerateAccessToken(user, "session", CurrentContext()));
    }

    [Theory]
    [InlineData("other", "mfa", 812)]
    [InlineData("passkey", "legacy_verified", 812)]
    [InlineData("passkey", "legacy_unverified", 812)]
    [InlineData("passkey", "webauthn_uv", null)]
    [InlineData("passkey", "webauthn_uv", 0)]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Negative, InvariantId = "jwt-issuer-rejects-invalid-current-context-and-missing-credential")]
    public void GenerateAccessToken_RejectsNonCurrentContextAndMissingCredential(string method, string strength, int? credential)
    {
        UserSessionAuthenticationContext context = CurrentContext() with
        {
            Method = method,
            Strength = strength,
            CredentialRowId = credential
        };

        Assert.Throws<InvalidOperationException>(() => CreateHelper().GenerateAccessToken(TestUser(), "session", context));
    }

    [Fact]
    public void GenerateAccessToken_RejectsAbsentContextAndIssuerHasNoBooleanOverloads()
    {
        Assert.Throws<InvalidOperationException>(() => CreateHelper().GenerateAccessToken(TestUser(), "session", default));
        Assert.DoesNotContain(typeof(IJwtHelper).GetMethods(), method =>
            method.GetParameters().Any(parameter => parameter.ParameterType == typeof(bool)));
    }

    // ─── helpers ──────────────────────────────────────────────────────────

    private static UserSessionAuthenticationContext CurrentContext()
        => new(
            UserSessionAuthenticationMethods.Passkey,
            UserSessionAuthenticationStrengths.WebAuthnUv,
            DateTime.UtcNow,
            CredentialRowId: 812,
            UserSessionDurationPolicies.BrowserSession);

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
        => new EnvironmentVariableScope("FSUSBLOG_ANONYMOUS_IDENTITY_MODE", value);

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
