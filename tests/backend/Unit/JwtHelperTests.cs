using Microsoft.Extensions.Options;
using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>
/// Unit tests for JwtHelper — token generation and refresh-token randomness.
/// No HTTP or DB deps needed; constructs the helper directly via IOptions.
/// </summary>
public sealed class JwtHelperTests
{
    private static JwtHelper CreateHelper(
        string secretKey = "SuperSecretTestKeyThatIs32Chars!!",
        string issuer = "test-issuer",
        string audience = "test-audience",
        int expiresMinutes = 15)
    {
        var settings = new JwtSettings
        {
            SecretKey = secretKey,
            Issuer = issuer,
            Audience = audience,
            AccessTokenExpiresMinutes = expiresMinutes
        };
        return new JwtHelper(Options.Create(settings));
    }

    private static User TestUser(int id = 1, string username = "alice", string role = "admin")
        => new() { Id = id, Username = username, Role = role };

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
    public void GenerateAccessToken_ContainsRoleClaim()
    {
        using var _ = SetAnonymousIdentityMode(null);
        var helper = CreateHelper();
        string token = helper.GenerateAccessToken(TestUser(role: "admin"));

        var claims = ParseClaims(token);
        // JwtSecurityTokenHandler serialises ClaimTypes.Role as the short JWT name "role"
        var role = claims.FirstOrDefault(c => c.Type == ClaimTypes.Role || c.Type == "role");
        Assert.NotNull(role);
        Assert.Equal("admin", role.Value);
    }

    [Fact]
    public void GenerateAccessToken_AnonymousIdentityMode_DoesNotGrantAdminFromSysUserRole()
    {
        using var _ = SetAnonymousIdentityMode("1");
        var helper = CreateHelper();
        var user = TestUser(role: "admin");
        user.IdentityKind = AnonymousIdentityRuntime.AnonymousAccountKind;

        string token = helper.GenerateAccessToken(user);

        var claims = ParseClaims(token);
        var role = claims.FirstOrDefault(c => c.Type == ClaimTypes.Role || c.Type == "role");
        Assert.NotNull(role);
        Assert.Equal(AnonymousIdentityRuntime.AuthenticatedRole, role.Value);
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

    [Fact]
    public void GenerateAccessToken_RespectsExpiresMinutes()
    {
        var helper = CreateHelper(expiresMinutes: 5);
        string token = helper.GenerateAccessToken(TestUser());

        var jwt = new JwtSecurityTokenHandler().ReadJwtToken(token);
        var diff = jwt.ValidTo - jwt.ValidFrom;
        // Allow ±10 seconds tolerance for execution time
        Assert.InRange(diff.TotalMinutes, 4.8, 5.2);
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

    // ─── helpers ──────────────────────────────────────────────────────────

    private static IEnumerable<Claim> ParseClaims(string token)
    {
        var jwt = new JwtSecurityTokenHandler().ReadJwtToken(token);
        return jwt.Claims;
    }

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
}
