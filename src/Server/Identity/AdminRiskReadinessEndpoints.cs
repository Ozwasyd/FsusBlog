using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server.Comments;
using FsusBlogV2.Storage;

namespace FsusBlog.V2.Server.Administration;

internal static class AdminRiskReadinessEndpoints
{
    internal static void Map(WebApplication app, AdminPasskeyStore store, string session, string rateLimit,
        InstalledCommentRoutes commentRoutes, bool trustLoopbackProxy)
    {
        app.MapGet(WireRoutes.AdminRiskReadiness, async (HttpContext ctx, CancellationToken ct) =>
        {
            var result = await store.RiskReadiness(ctx.Request.Cookies[session], commentRoutes, trustLoopbackProxy, ct);
            ctx.Response.Headers[WireHeaders.AdminPermissionSession] = result.PermissionSession;
            return Results.Bytes(Wire.EncodeAdminRiskReadiness(result.Controls), Aeds.ContentType);
        }).RequireRateLimiting(rateLimit);
    }
}

internal sealed partial class AdminPasskeyStore
{
    internal Task<(AdminRiskReadiness Controls, string PermissionSession)> RiskReadiness(string? token,
        InstalledCommentRoutes commentRoutes, bool trustLoopbackProxy, CancellationToken ct) =>
        WithLiveAdmin(token, CurrentSchema.SystemConfigPermission, async (db, tx, admin) =>
        {
            var replyMode = 0;
            if (commentRoutes.SignedInReply)
                replyMode = await CurrentSchema.HasCommentReplySchemaAsync(db, tx, ct) ? 2 : 1;

            var controls = new AdminRiskReadiness(
                PublicReadMode: 1, // Public comment queries always map with the fixed query limiter.
                RootWriteMode: commentRoutes.RootSubmission ? 1 : 0,
                ReplyWriteMode: replyMode,
                ForwardingMode: trustLoopbackProxy ? 1 : 0,
                DynamicRisk: 0, // No policy evaluator is installed.
                StrongAnonymous: 0); // No anonymous credential or proof runtime is installed.
            return (controls, PermissionBinding(admin.Digest));
        }, ct);
}
