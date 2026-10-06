using System.Security.Claims;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Shared.Contracts.AuthoringCanvas;

using Microsoft.AspNetCore.Http;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class AuthoringCanvasEndpointOwnerTests
{
    [Fact]
    public void Owner_UsesIsolatedInt64AdminIdentityRatherThanAnonymousAccountClaim()
    {
        var context = new DefaultHttpContext
        {
            User = Principal(
                new Claim("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind),
                new Claim("admin_id", "2147483648"),
                new Claim("admin_sid", "actual-admin-session"),
                new Claim(ClaimTypes.NameIdentifier, "42"))
        };

        AuthoringCanvasOwner owner = AuthoringCanvasEndpoints.Owner(context);

        Assert.Equal(2147483648L, owner.AdminPrincipalId);
        Assert.Equal("primary-site", owner.SiteScope);
    }

    [Theory]
    [InlineData("anonymous", "61", "session")]
    [InlineData("admin_principal", "0", "session")]
    [InlineData("admin_principal", "-1", "session")]
    [InlineData("admin_principal", "not-a-number", "session")]
    [InlineData("admin_principal", "61", "")]
    [InlineData("admin_principal", "61", " ")]
    public void Owner_RejectsForeignIdentityInvalidAdminAndMissingSession(
        string identityKind, string adminId, string sessionId)
    {
        var context = new DefaultHttpContext
        {
            User = Principal(
                new Claim("identity_kind", identityKind),
                new Claim("admin_id", adminId),
                new Claim("admin_sid", sessionId),
                new Claim(ClaimTypes.NameIdentifier, "42"))
        };

        Assert.Throws<AuthoringCanvasAccessDeniedException>(() => AuthoringCanvasEndpoints.Owner(context));
    }

    private static ClaimsPrincipal Principal(params Claim[] claims)
        => new(new ClaimsIdentity(claims, "owner-boundary-test"));
}
