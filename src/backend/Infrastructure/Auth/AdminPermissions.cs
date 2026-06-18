namespace FsusBlog.Server.Infrastructure.Auth;

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
        SystemConfig,
        AdminManage
    ];
}

public static class AdminAuthorizationEndpointExtensions
{
    public static RouteHandlerBuilder RequireAdminPermission(this RouteHandlerBuilder builder, string permission)
        => builder.RequireAuthorization(policy => policy
            .RequireAuthenticatedUser()
            .RequireClaim("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind)
            .RequireClaim(AdminPermissions.PermissionClaimType, permission));

    public static RouteGroupBuilder RequireAdminPermission(this RouteGroupBuilder builder, string permission)
        => builder.RequireAuthorization(policy => policy
            .RequireAuthenticatedUser()
            .RequireClaim("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind)
            .RequireClaim(AdminPermissions.PermissionClaimType, permission));
}
