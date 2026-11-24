using System.Globalization;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Comments;
using static FsusBlog.V2.Server.Administration.AdminActionRoutes;

namespace FsusBlog.V2.Server.Administration;

internal static class AdminModerationEndpoints
{
    internal static void Map(AdminActionRoutes actions, AdminModerationStore store, bool fenceVisibleMessages)
    {
        actions.Post(WireRoutes.AdminModerationClaim, WireLimits.AdminModerationClaimRequestFrameBytes, async (cookie, frame, ct) =>
            Wire.EncodeAdminModerationClaim(await store.AcquireCommentClaim(cookie, Wire.DecodeAdminModerationClaimRequest(frame), ct)))
            .RequireRateLimiting(CommandEndpoints.Policy);
        actions.Post(WireRoutes.AdminModerationRenew, WireLimits.AdminModerationClaimFrameBytes, async (cookie, frame, ct) =>
            Wire.EncodeAdminModerationClaim(await store.RenewCommentClaim(cookie, Wire.DecodeAdminModerationClaim(frame), ct)))
            .RequireRateLimiting(CommandEndpoints.Policy);
        actions.Post(WireRoutes.AdminModerationRelease, WireLimits.AdminModerationClaimFrameBytes, async (cookie, frame, ct) =>
        {
            await store.ReleaseCommentClaim(cookie, Wire.DecodeAdminModerationClaim(frame), ct);
            return Wire.EncodeEmptySuccess();
        }).RequireRateLimiting(CommandEndpoints.Policy);
        actions.Post(WireRoutes.AdminModerationStepUpBegin, WireLimits.AdminModerationDecisionFrameBytes, (cookie, frame, ct) =>
            store.BeginModerationDecisionStepUp(cookie, Wire.DecodeAdminModerationDecision(frame), ct)).RequireRateLimiting(actions.PasskeyLimit);
        actions.Execute(WireRoutes.AdminModerationDecision, async (ctx, ct) =>
        {
            var frame = await actions.Read(ctx, WireLimits.AdminModerationDecisionFrameBytes, ct);
            await store.DecideComment(actions.Session(ctx), Proof(ctx), Wire.DecodeAdminModerationDecision(frame), ct, fenceVisibleMessages);
            return ServerHttp.EmptyFrame();
        });
    }
}

internal static class AdminModerationBatchEndpoints
{
    internal const string Setting = "FSUSBLOG_ADMIN_COMMENT_BATCH";

    internal static void Map(WebApplication app, string origin, AdminModerationBatchStore store, string session, string passkeyLimit,
        Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame, bool fenceVisibleMessages)
    {
        app.MapCommandPost(WireRoutes.AdminModerationBatchClaim, (HttpContext ctx, CancellationToken ct) => Run(ctx, origin, async () =>
        {
            var targets = Wire.DecodeAdminModerationBatchTargets(await readFrame(ctx, WireLimits.AdminModerationBatchTargetsFrameBytes, ct));
            return Wire.EncodeAdminModerationBatchClaims(await store.AcquireModerationBatch(ctx.Request.Cookies[session], targets, ct));
        }));
        app.MapPost(WireRoutes.AdminModerationBatchStepUpBegin, (HttpContext ctx, CancellationToken ct) => Run(ctx, origin, async () =>
            await store.BeginModerationBatchStepUp(ctx.Request.Cookies[session], await readFrame(ctx, WireLimits.AdminModerationBatchDecisionFrameBytes, ct), ct)))
            .RequireRateLimiting(passkeyLimit);
        app.MapPost(WireRoutes.AdminModerationBatchStepUpComplete, (HttpContext ctx, CancellationToken ct) => Run(ctx, origin, async () =>
            await store.CompleteModerationBatchStepUp(ctx.Request.Cookies[session],
                PasskeyWire.ReadLogin(await readFrame(ctx, WireLimits.MaxPasskeyFrameBytes, ct), discoverable: false), ct)))
            .RequireRateLimiting(passkeyLimit);
        app.MapCommandPost(WireRoutes.AdminModerationBatchDecision, (HttpContext ctx, CancellationToken ct) => Run(ctx, origin, async () =>
        {
            var frame = await readFrame(ctx, WireLimits.AdminModerationBatchDecisionFrameBytes, ct);
            return Wire.EncodeAdminModerationBatchReceipt(
                await store.DecideModerationBatch(ctx.Request.Cookies[session], Proof(ctx), frame, fenceVisibleMessages, ct));
        }));
    }

    private static async Task<IResult> Run(HttpContext ctx, string origin, Func<Task<byte[]>> apply)
    {
        RequireOrigin(ctx, origin);
        try { return Frame(await apply()); }
        catch (ModerationBatchConflictException error)
        {
            const int status = StatusCodes.Status409Conflict;
            var details = $"moderation_batch_conflicts:{error.Positions.ToString("x5", CultureInfo.InvariantCulture)}";
            return new AedsError(status, Wire.EncodeError(status, "Selected comments or their claims changed.", details, traceId: ctx.TraceIdentifier));
        }
        catch (ProofRequiredException) { return ProofRequired(ctx); }
    }
}

internal static class AdminCommentAppeals
{
    internal static void Map(AdminActionRoutes actions, AdminCommentAppealStore store, bool fenceVisibleMessages)
    {
        actions.App.MapCommandGet(WireRoutes.AdminCommentAppeals, async (HttpContext ctx, CancellationToken ct) =>
            Frame(await store.ReadAppeals(actions.Session(ctx), ctx.Request.Query, ct)));
        actions.App.MapPost(WireRoutes.AdminAppealStepUpBegin, async (long id, HttpContext ctx, CancellationToken ct) =>
            Frame(await store.BeginAppealStepUp(actions.Session(ctx), id, await actions.Read(ctx, Wire.CommentAppealFrameBytes, ct), ct)))
            .RequireRateLimiting(actions.PasskeyLimit);
        actions.Complete(WireRoutes.AdminAppealStepUpComplete, store.CompleteAppealStepUp);
        actions.App.MapCommandPost(WireRoutes.AdminAppealDecision, async (long id, HttpContext ctx, CancellationToken ct) =>
        {
            var frame = await actions.Read(ctx, Wire.CommentAppealFrameBytes, ct);
            try { return Frame(await store.DecideAppeal(actions.Session(ctx), id, frame, Proof(ctx), ct, fenceVisibleMessages)); }
            catch (ProofRequiredException) { return ProofRequired(ctx); }
        });
    }
}

internal static class AdminCommentRevisions
{
    internal static void Map(WebApplication app, AdminCommentHistoryStore store, string session)
    {
        app.MapCommandGet(WireRoutes.AdminCommentRevisions, async (long id, HttpContext context, CancellationToken ct) =>
        {
            context.Response.Headers.CacheControl = "no-store";
            var result = await store.CommentRevisions(context.Request.Cookies[session], id, context.Request.Query, Position, ct);
            if (result.Next is long version)
            {
                var scope = result.Article == 0 ? "" : FormattableString.Invariant($"&articleId={result.Article}");
                context.Response.Headers.Link = FormattableString.Invariant($"</api/binary/author/comments/{id}/revisions?before={version}{scope}>; rel=\"next\"");
            }
            return Frame(result.Frame);
        });
        app.MapCommandGet(WireRoutes.AdminCommentTimeline, async (long id, HttpContext context, CancellationToken ct) =>
        {
            context.Response.Headers.CacheControl = "no-store";
            return Frame(await store.CommentTimeline(context.Request.Cookies[session], id, context.Request.Query, ct));
        });
    }

    internal static (long Before, int Article) Position(IQueryCollection query)
    {
        var hasBefore = query.TryGetValue("before", out var before);
        var hasArticle = query.TryGetValue("articleId", out var article);
        long version = long.MaxValue;
        int scope = 0;
        if (query.Count != (hasBefore ? 1 : 0) + (hasArticle ? 1 : 0) ||
            hasBefore && (before.Count != 1 || !long.TryParse(before[0], NumberStyles.None, CultureInfo.InvariantCulture, out version) || version <= 1) ||
            hasArticle && (article.Count != 1 || !int.TryParse(article[0], NumberStyles.None, CultureInfo.InvariantCulture, out scope) || scope <= 0))
            throw new BusinessException(Rejection.Invalid, "Invalid comment revision position.");
        return (version, scope);
    }
}

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
            return Frame(Wire.EncodeAdminRiskReadiness(result.Controls));
        }).RequireRateLimiting(actions.PasskeyLimit);

        if (!commentRoutes.RootPowPolicy || commentRisk is null) return;
        actions.App.MapGet(WireRoutes.AdminRootCommentPowPolicy, async (HttpContext ctx, CancellationToken ct) =>
            State(ctx, await commentRisk.ReadRootCommentPowPolicy(actions.Session(ctx), ct))).RequireRateLimiting(actions.PasskeyLimit);
        actions.Begin(WireRoutes.AdminRootCommentPowBegin, ReadIntent, commentRisk.BeginRootCommentPowStepUp);
        actions.Complete(WireRoutes.AdminRootCommentPowComplete, commentRisk.CompleteRootCommentPowStepUp);
        actions.App.MapCommandPost(WireRoutes.AdminRootCommentPowApply, async (HttpContext ctx, CancellationToken ct) =>
            State(ctx, await commentRisk.ApplyRootCommentPowPolicy(actions.Session(ctx), await ReadIntent(ctx, ct), Proof(ctx), ct)));

        async Task<AdminRootCommentPowCommand> ReadIntent(HttpContext ctx, CancellationToken ct) =>
            Wire.DecodeAdminRootCommentPowCommand(await actions.Read(ctx, WireLimits.AdminRootCommentPowCommandFrameBytes, ct));
    }

    private static IResult State(HttpContext ctx, (AdminRootCommentPowPolicy State, string PermissionSession) result)
    {
        ctx.Response.Headers[WireHeaders.AdminPermissionSession] = result.PermissionSession;
        return Frame(Wire.EncodeAdminRootCommentPowPolicy(result.State));
    }
}

internal static class AdminReaderGovernanceEndpoints
{
    internal static void Map(AdminActionRoutes actions, AdminReaderGovernanceStore store)
    {
        actions.App.MapCommandGet(WireRoutes.AdminReaderAccounts, async (HttpContext ctx, CancellationToken ct) =>
        {
            ctx.Response.Headers.CacheControl = "no-store";
            var result = await store.ListReaders(actions.Session(ctx), ctx.Request.Query, ct);
            ctx.Response.Headers[WireHeaders.AdminPermissionSession] = result.PermissionSession;
            return Frame(Wire.EncodeAdminReaderAccountPage(result.Page));
        });
        actions.StepUpWithPermission(WireRoutes.AdminReaderStatusStepUpBegin, WireRoutes.AdminReaderStatusStepUpComplete,
            WireRoutes.AdminReaderStatusExecute, WireLimits.AdminReaderStatusCommandFrameBytes,
            Wire.DecodeAdminReaderStatusCommand, c => c.IdempotencyKey,
            store.BeginStatusStepUp, store.CompleteStatusStepUp, store.ExecuteStatusChange, Wire.EncodeAdminReaderStatusReceipt);
    }
}

internal static class AdminHandleEndpoints
{
    internal static void Map(AdminActionRoutes actions, AdminHandleStore store) =>
        actions.StepUpWithPermission(WireRoutes.AdminHandleStepUpBegin, WireRoutes.AdminHandleStepUpComplete,
            WireRoutes.AdminHandleExecute, WireLimits.AdminHandleCommandFrameBytes,
            Wire.DecodeAdminHandleCommand, c => c.IdempotencyKey,
            store.BeginRenameStepUp, store.CompleteRenameStepUp, store.ExecuteRename, Wire.EncodeAdminHandleReceipt);
}
