using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server.Comments;
using FsusBlog.V2.Server.Security;
using FsusBlogV2.Storage;

namespace FsusBlog.V2.Server.Administration;

internal static class AdminRiskReadinessEndpoints
{
    internal static void Map(WebApplication app, Uri adminOrigin, AdminPasskeyStore store, string session, string rateLimit,
        InstalledCommentRoutes commentRoutes, bool trustLoopbackProxy,
        Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame)
    {
        app.MapGet(WireRoutes.AdminRiskReadiness, async (HttpContext ctx, CancellationToken ct) =>
        {
            var result = await store.RiskReadiness(ctx.Request.Cookies[session], commentRoutes, trustLoopbackProxy, ct);
            ctx.Response.Headers[WireHeaders.AdminPermissionSession] = result.PermissionSession;
            if (commentRoutes.RootPowPolicy) ctx.Response.Headers[WireHeaders.AdminRootCommentPowPolicy] = "1";
            return Results.Bytes(Wire.EncodeAdminRiskReadiness(result.Controls), Aeds.ContentType);
        }).RequireRateLimiting(rateLimit);

        if (!commentRoutes.RootPowPolicy) return;
        var actions = new AdminActionRoutes(app, adminOrigin.GetLeftPart(UriPartial.Authority), session, readFrame);
        app.MapGet(WireRoutes.AdminRootCommentPowPolicy, async (HttpContext ctx, CancellationToken ct) =>
            State(ctx, await store.ReadRootCommentPowPolicy(ctx.Request.Cookies[session], ct))).RequireRateLimiting(rateLimit);
        app.MapPost(WireRoutes.AdminRootCommentPowBegin, async (HttpContext ctx, CancellationToken ct) =>
        {
            var intent = await ReadIntent(ctx, ct);
            return Frame(await store.BeginRootCommentPowStepUp(ctx.Request.Cookies[session], intent, ct));
        }).RequireRateLimiting(rateLimit);
        actions.Complete(WireRoutes.AdminRootCommentPowComplete, rateLimit, store.CompleteRootCommentPowStepUp);
        app.MapPost(WireRoutes.AdminRootCommentPowApply, async (HttpContext ctx, CancellationToken ct) =>
        {
            var intent = await ReadIntent(ctx, ct);
            var proof = AdminActionRoutes.Proof(ctx);
            return State(ctx, await store.ApplyRootCommentPowPolicy(ctx.Request.Cookies[session], intent, proof, ct));
        }).RequireRateLimiting("command");

        async Task<AdminRootCommentPowCommand> ReadIntent(HttpContext ctx, CancellationToken ct)
        {
            return Wire.DecodeAdminRootCommentPowCommand(await actions.Read(ctx, WireLimits.AdminRootCommentPowCommandFrameBytes, ct));
        }
    }

    private static IResult State(HttpContext ctx, (AdminRootCommentPowPolicy State, string PermissionSession) result)
    {
        ctx.Response.Headers[WireHeaders.AdminPermissionSession] = result.PermissionSession;
        return Frame(Wire.EncodeAdminRootCommentPowPolicy(result.State));
    }

    private static IResult Frame(byte[] body) => Results.Bytes(body, Aeds.ContentType);
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

            if (commentRoutes.RootPowPolicy) await RootCommentPowPolicy.Read(db, tx, ct);
            var controls = new AdminRiskReadiness(
                PublicReadMode: 1, // Public comment queries always map with the fixed query limiter.
                RootWriteMode: commentRoutes.RootSubmission ? 1 : 0,
                ReplyWriteMode: replyMode,
                ForwardingMode: trustLoopbackProxy ? 1 : 0,
                DynamicRisk: 0, // Root comment proof configuration does not implement general risk scoring.
                StrongAnonymous: 0); // No anonymous credential or proof runtime is installed.
            return (controls, PermissionBinding(admin.Digest));
        }, ct);
}
