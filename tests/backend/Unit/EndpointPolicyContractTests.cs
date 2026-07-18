using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Authorization.Infrastructure;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;
namespace FsusBlog.Server.Tests.Unit;

public sealed class EndpointPolicyContractTests
{
    [Fact]
    [Trait("ShardAffinity", "EndpointContractApplication")]
    public async Task BinaryAuthPowChallenge_RequiresNoStoreResponse()
    {
        await using EndpointContractSnapshot app = EndpointContractApplication.CreateSnapshot();

        RouteEndpoint endpoint = EndpointContractApplication.Find(
            app,
            "/api/binary/auth/pow-challenge",
            HttpMethods.Get);
        Assert.NotNull(endpoint.Metadata.GetMetadata<IAllowAnonymous>());
        AssertRateLimit(endpoint, "fixed_ip");
        Assert.NotNull(endpoint.Metadata.GetMetadata<NoStoreResponseMetadata>());
    }

    [Fact]
    [Trait("ShardAffinity", "EndpointContractApplication")]
    public async Task CriticalEndpointMetadata_ComesFromFinalEndpointDataSource()
    {
        await using EndpointContractSnapshot app = EndpointContractApplication.CreateSnapshot();

        RouteEndpoint accountMe = EndpointContractApplication.Find(
            app,
            "/api/binary/auth/me",
            HttpMethods.Get);
        AssertClaim(accountMe, "identity_kind", AnonymousIdentityRuntime.AnonymousAccountKind);
        AssertAuthenticated(accountMe);

        RouteEndpoint articleTrash = EndpointContractApplication.Find(
            app,
            "/api/binary/admin/article/trash",
            HttpMethods.Delete);
        AssertAdminPermission(articleTrash, AdminPermissions.ArticleWrite);
        AssertRateLimit(articleTrash, "fixed_ip");
        AssertAdminSensitiveStepUp(articleTrash);
        AssertFilterOrder(articleTrash, typeof(RequiresPowFilter));

        RouteEndpoint recoveryVerify = EndpointContractApplication.Find(
            app,
            "/api/binary/auth/recovery-key/verify",
            HttpMethods.Post);
        Assert.NotNull(recoveryVerify.Metadata.GetMetadata<IAllowAnonymous>());
        AssertRateLimit(recoveryVerify, "fixed_ip");
        Assert.Equal(
            new RiskActionEndpointMetadata(RiskActionNames.RecoveryKeyVerify, "recovery-key.verify"),
            recoveryVerify.Metadata.GetMetadata<RiskActionEndpointMetadata>());
        Assert.NotNull(recoveryVerify.Metadata.GetMetadata<NoStoreResponseMetadata>());
        AssertFilterOrder(
            recoveryVerify,
            typeof(RequiresRiskControlFilter),
            typeof(RequiresPowFilter));

        RouteEndpoint commentCreate = EndpointContractApplication.Find(
            app,
            "/api/binary/comment",
            HttpMethods.Post);
        AssertAuthenticated(commentCreate);
        AssertClaim(commentCreate, "identity_kind", AnonymousIdentityRuntime.AnonymousAccountKind);
        AssertRateLimit(commentCreate, "fixed_ip");
        Assert.Equal(
            new RiskActionEndpointMetadata(RiskActionNames.CommentCreate, "comment.create"),
            commentCreate.Metadata.GetMetadata<RiskActionEndpointMetadata>());
        AssertFilterOrder(
            commentCreate,
            typeof(CommentRiskActionFilter),
            typeof(RequiresRiskControlFilter),
            typeof(RequiresPowFilter));

        RouteEndpoint commentDelete = EndpointContractApplication.Find(
            app,
            "/api/binary/comment/{id:long}",
            HttpMethods.Delete);
        AssertAuthenticated(commentDelete);
        AssertAdminSensitiveStepUp(commentDelete, adminPrincipalBranchOnly: true);
        AssertFilterOrder(commentDelete, typeof(RequiresPowFilter));

        RouteEndpoint deleteAccount = EndpointContractApplication.Find(
            app,
            "/api/binary/auth/delete-account",
            HttpMethods.Post);
        Assert.Equal(
            RestrictedAccountAction.DeleteOwnAccount,
            Assert.IsType<RestrictedAccountActionMetadata>(
                deleteAccount.Metadata.GetMetadata<RestrictedAccountActionMetadata>()).Action);
        Assert.NotNull(deleteAccount.Metadata.GetMetadata<NoStoreResponseMetadata>());
        AssertFilterOrder(deleteAccount, typeof(RequiresPowFilter));
    }

    [Fact]
    [Trait("ShardAffinity", "EndpointContractApplication")]
    public async Task PublicReadMetadata_DeclaresRateRiskAndRuntimeFilter()
    {
        await using EndpointContractSnapshot app = EndpointContractApplication.CreateSnapshot();

        RouteEndpoint related = EndpointContractApplication.Find(
            app,
            "/api/binary/article/{articleId:int}/related.aeds",
            HttpMethods.Get);
        Assert.NotNull(related.Metadata.GetMetadata<IAllowAnonymous>());
        AssertRateLimit(related, "public_read");
        Assert.Equal(
            new RiskActionEndpointMetadata(RiskActionNames.PublicRead, "article.related"),
            related.Metadata.GetMetadata<RiskActionEndpointMetadata>());
        AssertFilterOrder(related, typeof(RiskAwarePublicReadFilter));

        RouteEndpoint article = EndpointContractApplication.Find(
            app,
            "/api/binary/article/{id}.aeds",
            HttpMethods.Get);
        Assert.NotNull(article.Metadata.GetMetadata<IAllowAnonymous>());
        AssertRateLimit(article, "public_read");
        Assert.Equal(
            new RiskActionEndpointMetadata(RiskActionNames.PublicRead, "article.detail"),
            article.Metadata.GetMetadata<RiskActionEndpointMetadata>());
        AssertFilterOrder(article, typeof(RiskAwarePublicReadFilter));
    }

    [Fact]
    [Trait("ShardAffinity", "EndpointContractApplication")]
    public async Task CommentModerationEndpoints_RequireCommentModeratePermission()
    {
        await using EndpointContractSnapshot app = EndpointContractApplication.CreateSnapshot();

        RouteEndpoint queue = EndpointContractApplication.Find(
            app,
            "/api/binary/author/comments/moderation",
            HttpMethods.Get);
        AssertAdminPermission(queue, AdminPermissions.CommentModerate);
        AssertRateLimit(queue, "fixed_ip");
        Assert.Null(queue.Metadata.GetMetadata<AdminSensitiveStepUpMetadata>());

        foreach ((string route, string method) in new[]
        {
            ("/api/binary/author/comments/moderation/bulk", HttpMethods.Post),
            ("/api/binary/author/comments/{commentId:long}/moderation", HttpMethods.Post)
        })
        {
            RouteEndpoint mutation = EndpointContractApplication.Find(app, route, method);
            AssertAdminPermission(mutation, AdminPermissions.CommentModerate);
            AssertRateLimit(mutation, "fixed_ip");
            AssertAdminSensitiveStepUp(mutation);
        }

        RouteEndpoint riskPolicy = EndpointContractApplication.Find(
            app,
            "/api/binary/admin/security/risk-control/options",
            HttpMethods.Put);
        AssertAdminPermission(riskPolicy, AdminPermissions.SystemConfig);
        AssertRateLimit(riskPolicy, "fixed_ip");
        AssertAdminSensitiveStepUp(riskPolicy);
    }

    [Fact]
    [Trait("ShardAffinity", "EndpointContractApplication")]
    public async Task RestrictedAccountActions_AreExplicitAndDoNotBypassMessages()
    {
        await using EndpointContractSnapshot app = EndpointContractApplication.CreateSnapshot();

        var expected = new Dictionary<(string Route, string Method), RestrictedAccountAction>
        {
            [("/api/binary/auth/logout", HttpMethods.Post)] = RestrictedAccountAction.Logout,
            [("/api/binary/auth/delete-account", HttpMethods.Post)] = RestrictedAccountAction.DeleteOwnAccount,
            [("/api/binary/auth/sessions/{id}/revoke", HttpMethods.Post)] = RestrictedAccountAction.RevokeOwnSession,
            [("/api/binary/auth/sessions/revoke-others", HttpMethods.Post)] = RestrictedAccountAction.RevokeOtherSessions
        };

        foreach (KeyValuePair<(string Route, string Method), RestrictedAccountAction> entry in expected)
        {
            RouteEndpoint endpoint = EndpointContractApplication.Find(
                app,
                entry.Key.Route,
                entry.Key.Method);
            Assert.Equal(
                entry.Value,
                Assert.IsType<RestrictedAccountActionMetadata>(
                    endpoint.Metadata.GetMetadata<RestrictedAccountActionMetadata>()).Action);
        }

        RouteEndpoint[] messageWrites = ((IEndpointRouteBuilder)app).DataSources
            .SelectMany(static source => source.Endpoints)
            .OfType<RouteEndpoint>()
            .Where(static endpoint => (endpoint.RoutePattern.RawText ?? string.Empty)
                .TrimStart('/')
                .StartsWith("api/binary/messages", StringComparison.Ordinal))
            .Where(static endpoint => endpoint.Metadata.GetMetadata<IHttpMethodMetadata>()?.HttpMethods
                .Any(static method => method is "POST" or "PUT" or "PATCH" or "DELETE") == true)
            .ToArray();
        Assert.NotEmpty(messageWrites);
        Assert.All(messageWrites, endpoint =>
            Assert.Null(endpoint.Metadata.GetMetadata<RestrictedAccountActionMetadata>()));
    }

    [Fact]
    [Trait("ShardAffinity", "EndpointContractApplication")]
    public async Task AdminControlPlaneEndpoints_DoNotUseBareAdminRole()
    {
        await using EndpointContractSnapshot app = EndpointContractApplication.CreateSnapshot();

        RouteEndpoint[] adminEndpoints = ((IEndpointRouteBuilder)app).DataSources
            .SelectMany(static source => source.Endpoints)
            .OfType<RouteEndpoint>()
            .Where(static endpoint => (endpoint.RoutePattern.RawText ?? string.Empty)
                .Contains("/admin/", StringComparison.Ordinal))
            .ToArray();

        Assert.NotEmpty(adminEndpoints);
        Assert.All(adminEndpoints, endpoint =>
        {
            AuthorizationPolicy[] policies = endpoint.Metadata.GetOrderedMetadata<AuthorizationPolicy>().ToArray();
            Assert.DoesNotContain(
                policies.SelectMany(static policy => policy.Requirements),
                static requirement => requirement is RolesAuthorizationRequirement);
        });
    }

    [Fact]
    [Trait("ShardAffinity", "EndpointContractApplication")]
    public async Task BinaryArticleAdminRoutes_AreUnderAdminPrefix()
    {
        await using EndpointContractSnapshot app = EndpointContractApplication.CreateSnapshot();

        var expected = new (string Route, string Method)[]
        {
            ("/api/binary/admin/article", HttpMethods.Get),
            ("/api/binary/admin/article/{id:int}", HttpMethods.Get),
            ("/api/binary/admin/article", HttpMethods.Post),
            ("/api/binary/admin/article/{id:int}", HttpMethods.Put),
            ("/api/binary/admin/article/trash", HttpMethods.Delete)
        };

        Assert.All(expected, item =>
        {
            RouteEndpoint endpoint = EndpointContractApplication.Find(app, item.Route, item.Method);
            AssertAdminPermission(endpoint, AdminPermissions.ArticleWrite);
        });

        RouteEndpoint[] legacyWrites = ((IEndpointRouteBuilder)app).DataSources
            .SelectMany(static source => source.Endpoints)
            .OfType<RouteEndpoint>()
            .Where(static endpoint => (endpoint.RoutePattern.RawText ?? string.Empty).TrimStart('/') is
                "api/binary/article" or "api/binary/article/{id:int}")
            .Where(static endpoint => endpoint.Metadata.GetMetadata<IHttpMethodMetadata>()?.HttpMethods
                .Any(static method => method is "POST" or "PUT" or "DELETE") == true)
            .ToArray();
        Assert.Empty(legacyWrites);
    }

    private static void AssertAuthenticated(RouteEndpoint endpoint)
    {
        AuthorizationPolicy[] policies = endpoint.Metadata.GetOrderedMetadata<AuthorizationPolicy>().ToArray();
        if (policies.SelectMany(static policy => policy.Requirements)
            .Any(static requirement => requirement is DenyAnonymousAuthorizationRequirement))
        {
            return;
        }

        Assert.NotEmpty(endpoint.Metadata.GetOrderedMetadata<IAuthorizeData>());
    }

    private static void AssertAdminPermission(RouteEndpoint endpoint, string permission)
    {
        AssertAuthenticated(endpoint);
        AssertClaim(endpoint, "identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind);
        AssertClaim(endpoint, "admin_id", expectedValue: null);
        AssertClaim(endpoint, AdminPermissions.PermissionClaimType, permission);
    }

    private static void AssertClaim(RouteEndpoint endpoint, string claimType, string? expectedValue)
    {
        ClaimsAuthorizationRequirement[] requirements = Policies(endpoint)
            .SelectMany(static policy => policy.Requirements)
            .OfType<ClaimsAuthorizationRequirement>()
            .Where(requirement => string.Equals(requirement.ClaimType, claimType, StringComparison.Ordinal))
            .ToArray();
        ClaimsAuthorizationRequirement requirement = Assert.Single(requirements);
        if (expectedValue is not null)
        {
            Assert.Contains(expectedValue, requirement.AllowedValues ?? []);
        }
    }

    private static void AssertRateLimit(RouteEndpoint endpoint, string policyName)
        => Assert.Equal(
            policyName,
            Assert.IsType<EnableRateLimitingAttribute>(
                endpoint.Metadata.GetMetadata<EnableRateLimitingAttribute>()).PolicyName);

    private static void AssertAdminSensitiveStepUp(
        RouteEndpoint endpoint,
        bool adminPrincipalBranchOnly = false)
    {
        AdminSensitiveStepUpMetadata metadata = Assert.IsType<AdminSensitiveStepUpMetadata>(
            endpoint.Metadata.GetMetadata<AdminSensitiveStepUpMetadata>());
        Assert.Equal(AdminSensitiveStepUpMetadata.DefaultAction, metadata.Action);
        Assert.Equal(AdminSensitiveStepUpMetadata.DefaultProofHeader, metadata.ProofHeader);
        Assert.Equal(adminPrincipalBranchOnly, metadata.AdminPrincipalBranchOnly);
    }

    private static void AssertFilterOrder(RouteEndpoint endpoint, params Type[] expected)
        => Assert.Equal(
            expected,
            endpoint.Metadata.GetOrderedMetadata<EndpointFilterBoundaryMetadata>()
                .Select(static metadata => metadata.FilterType)
                .ToArray());

    private static IReadOnlyList<AuthorizationPolicy> Policies(RouteEndpoint endpoint)
    {
        AuthorizationPolicy[] policies = endpoint.Metadata.GetOrderedMetadata<AuthorizationPolicy>().ToArray();
        Assert.NotEmpty(policies);
        return policies;
    }
}
