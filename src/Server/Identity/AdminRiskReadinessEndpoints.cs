using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server.Comments;

namespace FsusBlog.V2.Server.Administration;

internal static class AdminRiskReadinessEndpoints
{
    internal static void Map(WebApplication app, Uri adminOrigin, AdminOperationsStore operations,
        AdminCommentRiskStore? commentRisk, string session, string rateLimit, InstalledCommentRoutes commentRoutes,
        bool trustLoopbackProxy, Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame)
    {
        app.MapGet(WireRoutes.AdminRiskReadiness, async (HttpContext ctx, CancellationToken ct) =>
        {
            var result = await operations.RiskReadiness(ctx.Request.Cookies[session], commentRoutes, trustLoopbackProxy, ct);
            ctx.Response.Headers[WireHeaders.AdminPermissionSession] = result.PermissionSession;
            if (commentRoutes.RootPowPolicy) ctx.Response.Headers[WireHeaders.AdminRootCommentPowPolicy] = "1";
            return Results.Bytes(Wire.EncodeAdminRiskReadiness(result.Controls), Aeds.ContentType);
        }).RequireRateLimiting(rateLimit);

        if (!commentRoutes.RootPowPolicy || commentRisk is null) return;
        var actions = new AdminActionRoutes(app, adminOrigin.GetLeftPart(UriPartial.Authority), session, readFrame);
        app.MapGet(WireRoutes.AdminRootCommentPowPolicy, async (HttpContext ctx, CancellationToken ct) =>
            State(ctx, await commentRisk.ReadRootCommentPowPolicy(ctx.Request.Cookies[session], ct))).RequireRateLimiting(rateLimit);
        app.MapPost(WireRoutes.AdminRootCommentPowBegin, async (HttpContext ctx, CancellationToken ct) =>
        {
            var intent = await ReadIntent(ctx, ct);
            return Frame(await commentRisk.BeginRootCommentPowStepUp(ctx.Request.Cookies[session], intent, ct));
        }).RequireRateLimiting(rateLimit);
        actions.Complete(WireRoutes.AdminRootCommentPowComplete, rateLimit, commentRisk.CompleteRootCommentPowStepUp);
        app.MapPost(WireRoutes.AdminRootCommentPowApply, async (HttpContext ctx, CancellationToken ct) =>
        {
            var intent = await ReadIntent(ctx, ct);
            var proof = AdminActionRoutes.Proof(ctx);
            return State(ctx, await commentRisk.ApplyRootCommentPowPolicy(ctx.Request.Cookies[session], intent, proof, ct));
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
