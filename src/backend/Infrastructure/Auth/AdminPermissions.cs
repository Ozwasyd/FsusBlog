namespace FsusBlog.Server.Infrastructure.Auth;

/// <summary>Defines the canonical claim type and permission values accepted by administrator authorization policies.</summary>
public static class AdminPermissions
{
    public const string PermissionClaimType = "admin_permission";

    public const string ArticleWrite = "article.write";
    public const string ArticlePublish = "article.publish";
    public const string CommentModerate = "comment.moderate";
    public const string AnonymousCommentConfigure = "anonymous.comment.configure";
    public const string AnonymousNullifierBlock = "anonymous.nullifier.block";
    public const string AnonymousCredentialRevoke = "anonymous.credential.revoke";
    public const string AuditRead = "audit.read";
    public const string AuditInvestigate = "audit.investigate";
    public const string SystemConfig = "system.config";
    public const string AdminManage = "admin.manage";

    public static readonly string[] All =
    [
        ArticleWrite,
        ArticlePublish,
        CommentModerate,
        AnonymousCommentConfigure,
        AnonymousNullifierBlock,
        AnonymousCredentialRevoke,
        AuditRead,
        AuditInvestigate,
        SystemConfig,
        AdminManage
    ];
}

/// <summary>Applies administrator identity and permission claims to Minimal API endpoints and route groups.</summary>
public static class AdminAuthorizationEndpointExtensions
{
    /// <summary>Requires an authenticated administrator token containing the specified permission on one endpoint.</summary>
    public static RouteHandlerBuilder RequireAdminPermission(this RouteHandlerBuilder builder, string permission)
        => builder.RequireAuthorization(policy => policy
            .RequireAuthenticatedUser()
            .RequireClaim("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind)
            .RequireClaim("admin_id")
            .RequireClaim(AdminPermissions.PermissionClaimType, permission));

    /// <summary>Requires an authenticated administrator token containing the specified permission across a route group.</summary>
    public static RouteGroupBuilder RequireAdminPermission(this RouteGroupBuilder builder, string permission)
        => builder.RequireAuthorization(policy => policy
            .RequireAuthenticatedUser()
            .RequireClaim("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind)
            .RequireClaim("admin_id")
            .RequireClaim(AdminPermissions.PermissionClaimType, permission));
}
