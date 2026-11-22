using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server.Comments;
using static FsusBlog.V2.Server.Administration.AdminActionRoutes;

namespace FsusBlog.V2.Server.Administration;

internal static class AdminRiskReadinessEndpoints
{
    internal static void Map(AdminActionRoutes actions, AdminOperationsStore operations, AdminCommentRiskStore? commentRisk,
        InstalledCommentRoutes commentRoutes, bool trustLoopbackProxy)
    {
        actions.App.MapGet(WireRoutes.AdminRiskReadiness, async (HttpContext ctx, CancellationToken ct) =>
        {
            var result = await operations.RiskReadiness(actions.Session(ctx), commentRoutes, trustLoopbackProxy, ct);
            ctx.Response.Headers[WireHeaders.AdminPermissionSession] = result.PermissionSession;
            if (commentRoutes.RootPowPolicy) ctx.Response.Headers[WireHeaders.AdminRootCommentPowPolicy] = "1";
            return Results.Bytes(Wire.EncodeAdminRiskReadiness(result.Controls), Aeds.ContentType);
        }).RequireRateLimiting(actions.PasskeyLimit);

        if (!commentRoutes.RootPowPolicy || commentRisk is null) return;
        actions.App.MapGet(WireRoutes.AdminRootCommentPowPolicy, async (HttpContext ctx, CancellationToken ct) =>
            State(ctx, await commentRisk.ReadRootCommentPowPolicy(actions.Session(ctx), ct))).RequireRateLimiting(actions.PasskeyLimit);
        actions.App.MapPost(WireRoutes.AdminRootCommentPowBegin, async (HttpContext ctx, CancellationToken ct) =>
        {
            var intent = await ReadIntent(ctx, ct);
            return Frame(await commentRisk.BeginRootCommentPowStepUp(actions.Session(ctx), intent, ct));
        }).RequireRateLimiting(actions.PasskeyLimit);
        actions.Complete(WireRoutes.AdminRootCommentPowComplete, commentRisk.CompleteRootCommentPowStepUp);
        actions.App.MapCommandPost(WireRoutes.AdminRootCommentPowApply, async (HttpContext ctx, CancellationToken ct) =>
        {
            var intent = await ReadIntent(ctx, ct);
            var proof = Proof(ctx);
            return State(ctx, await commentRisk.ApplyRootCommentPowPolicy(actions.Session(ctx), intent, proof, ct));
        });

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
}
