using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Tests.TestInfrastructure;
using System.Security.Claims;

namespace FsusBlog.Server.Tests.Unit;

// ──────────────────────────────────────────────────────────────────────────────
// ClaimsPrincipalExtensions
// ──────────────────────────────────────────────────────────────────────────────

public class ClaimsPrincipalExtensionsTests
{
    private static ClaimsPrincipal MakeUser(int? userId = null, string? name = null, string? sessionId = null, bool mfa = false)
    {
        var claims = new List<Claim>();
        if (userId.HasValue)
            claims.Add(new Claim(ClaimTypes.NameIdentifier, userId.Value.ToString()));
        if (name != null)
            claims.Add(new Claim(ClaimTypes.Name, name));
        if (sessionId != null)
            claims.Add(new Claim("sid", sessionId));
        if (mfa)
            claims.Add(new Claim("mfa", "1"));

        return new ClaimsPrincipal(new ClaimsIdentity(claims));
    }

    [Fact]
    public void GetUserId_WithValidClaim_ReturnsId()
    {
        var user = MakeUser(42);
        Assert.Equal(42, user.GetUserId());
    }

    [Fact]
    public void GetUserId_WithSubClaim_ReturnsZero()
    {
        var claims = new[] { new Claim("sub", "77") };
        var user = new ClaimsPrincipal(new ClaimsIdentity(claims));
        Assert.Equal(0, user.GetUserId());
    }

    [Fact]
    public void GetUserId_NullUser_ReturnsZero()
    {
        ClaimsPrincipal? user = null;
        Assert.Equal(0, user.GetUserId());
    }

    [Fact]
    public void GetUserId_NoClaim_ReturnsZero()
    {
        var user = new ClaimsPrincipal(new ClaimsIdentity([]));
        Assert.Equal(0, user.GetUserId());
    }

    [Fact]
    public void GetUserId_InvalidValueClaim_ReturnsZero()
    {
        var claims = new[] { new Claim(ClaimTypes.NameIdentifier, "not-a-number") };
        var user = new ClaimsPrincipal(new ClaimsIdentity(claims));
        Assert.Equal(0, user.GetUserId());
    }

    [Fact]
    public void GetUserId_WhitespaceClaim_ReturnsZero()
    {
        var claims = new[] { new Claim(ClaimTypes.NameIdentifier, "   ") };
        var user = new ClaimsPrincipal(new ClaimsIdentity(claims));
        Assert.Equal(0, user.GetUserId());
    }

    [Fact]
    public void GetInternalAccountId_WithValidClaim_ReturnsAccountId()
    {
        var user = MakeUser(42, name: "Alice");
        Assert.Equal("42", user.GetInternalAccountId());
    }

    [Fact]
    public void GetInternalAccountId_NullUser_ReturnsZeroString()
    {
        ClaimsPrincipal? user = null;
        Assert.Equal("0", user.GetInternalAccountId());
    }

    [Fact]
    public void GetInternalAccountId_NoClaim_ReturnsZeroString()
    {
        var user = new ClaimsPrincipal(new ClaimsIdentity([]));
        Assert.Equal("0", user.GetInternalAccountId());
    }

    [Fact]
    public void GetInternalAccountId_IgnoresDisplayNameClaims()
    {
        var claims = new[]
        {
            new Claim(ClaimTypes.Name, "Alice"),
            new Claim("preferred_username", "bob"),
        };
        var user = new ClaimsPrincipal(new ClaimsIdentity(claims));
        Assert.Equal("0", user.GetInternalAccountId());
    }

    [Fact]
    public void ClaimsPrincipalExtensions_DoesNotExposeMisleadingNameHelper()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Infrastructure/Helpers/ClaimsPrincipalExtensions.cs");

        Assert.Contains("GetInternalAccountId", source, StringComparison.Ordinal);
        Assert.DoesNotContain("GetUserName", source, StringComparison.Ordinal);
    }

    [Fact]
    public void GetSessionId_WithClaim_ReturnsIt()
    {
        var user = MakeUser(sessionId: "sess-abc");
        Assert.Equal("sess-abc", user.GetSessionId());
    }

    [Fact]
    public void GetSessionId_NullUser_ReturnsNull()
    {
        ClaimsPrincipal? user = null;
        Assert.Null(user.GetSessionId());
    }

    [Fact]
    public void IsMfaVerified_WithMfaClaim_ReturnsTrue()
    {
        var user = MakeUser(mfa: true);
        Assert.True(user.IsMfaVerified());
    }

    [Fact]
    public void IsMfaVerified_WithoutClaim_ReturnsFalse()
    {
        var user = MakeUser();
        Assert.False(user.IsMfaVerified());
    }

    [Fact]
    public void IsMfaVerified_NullUser_ReturnsFalse()
    {
        ClaimsPrincipal? user = null;
        Assert.False(user.IsMfaVerified());
    }
}
