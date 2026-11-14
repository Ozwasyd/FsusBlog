using System.Globalization;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Core.Communication;
using FsusBlog.V2.Server.Security;

namespace FsusBlog.V2.Server.Administration;

internal static class AdminInboxEndpoints
{
    internal const string ReplySetting = "FSUSBLOG_ADMIN_INBOX_REPLIES";
    internal const string StatusSetting = "FSUSBLOG_ADMIN_INBOX_STATUS";
    internal const string NoticeSetting = "FSUSBLOG_ADMIN_INBOX_NOTICE";

    internal static void Map(WebApplication app, AdminPasskeyStore store, string session,
        Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame)
    {
        var replies = app.Configuration.GetValue(ReplySetting, false);
        var status = app.Configuration.GetValue(StatusSetting, false);
        var notice = app.Configuration.GetValue(NoticeSetting, false);
        app.MapGet(WireRoutes.AdminInboxQueue, async (HttpContext ctx, CancellationToken ct) =>
        {
            var filter = Query(ctx.Request.Query, "status", 7) switch
            {
                null => -1, "open" => 0, "pending" => 1, "closed" => 2,
                _ => throw new BusinessException(Rejection.Invalid, "Invalid administrator inbox filter.")
            };
            var page = await store.ReadInbox(ctx.Request.Cookies[session], filter, Query(ctx.Request.Query, "cursor", 64), ct);
            if (notice) ctx.Response.Headers[WireHeaders.AdminInboxNoticeEnabled] = "1";
            return Results.Bytes(Wire.EncodeAdminInboxPage(page), Aeds.ContentType);
        }).RequireRateLimiting("command");

        app.MapGet(WireRoutes.AdminInboxThread, async (long id, HttpContext ctx, CancellationToken ct) =>
        {
            if (id <= 0) throw new BusinessException(Rejection.NotFound, "Administrator inbox conversation not found.");
            var thread = await store.ReadInboxThread(ctx.Request.Cookies[session], id, Query(ctx.Request.Query, "before", 64), ct);
            if (replies) ctx.Response.Headers[WireHeaders.AdminInboxReplyEnabled] = "1";
            if (status) ctx.Response.Headers[WireHeaders.AdminInboxVersion] = thread.Version;
            return Results.Bytes(Wire.EncodeAdminInboxThread(thread), Aeds.ContentType);
        }).RequireRateLimiting("command");

        if (replies)
        {
            app.MapPost(WireRoutes.AdminInboxReplyPow, (long id, HttpContext ctx, ScopedPow pow, CancellationToken ct) =>
                Reply(id, ctx, pow, true, ct)).RequireRateLimiting("command");
            app.MapPost(WireRoutes.AdminInboxReply, (long id, HttpContext ctx, ScopedPow pow, CancellationToken ct) =>
                Reply(id, ctx, pow, false, ct)).RequireRateLimiting("command");
        }
        if (status)
        {
            app.MapPost(WireRoutes.AdminInboxStatusPow, (long id, HttpContext ctx, ScopedPow pow, CancellationToken ct) =>
                ChangeStatus(id, ctx, pow, true, ct)).RequireRateLimiting("command");
            app.MapPost(WireRoutes.AdminInboxStatus, (long id, HttpContext ctx, ScopedPow pow, CancellationToken ct) =>
                ChangeStatus(id, ctx, pow, false, ct)).RequireRateLimiting("command");
        }
        if (notice)
        {
            app.MapPost(WireRoutes.AdminInboxSendNoticePow, (HttpContext ctx, ScopedPow pow, CancellationToken ct) =>
                SendNotice(ctx, pow, true, ct)).RequireRateLimiting("command");
            app.MapPost(WireRoutes.AdminInboxSendNotice, (HttpContext ctx, ScopedPow pow, CancellationToken ct) =>
                SendNotice(ctx, pow, false, ct)).RequireRateLimiting("command");
        }

        Task<IResult> Reply(long id, HttpContext ctx, ScopedPow pow, bool issue, CancellationToken ct) =>
            ScopedPow.Protect(ctx, async () =>
            {
                if (id <= 0) throw new BusinessException(Rejection.NotFound, "Administrator inbox conversation not found.");
                if (!ctx.Request.Headers.TryGetValue(WireHeaders.ClientMutationId, out var header) || header.Count != 1 ||
                    header[0] is not { Length: <= 128 } value)
                    throw new BusinessException(Rejection.Invalid, "Invalid inbox command key.");
                var key = InboxRules.CommandId(value);
                var frame = await readFrame(ctx, InboxWire.MaxRequestFrameBytes, ct);
                var body = InboxRules.Body(InboxWire.DecodeAdminReply(frame));
                var context = string.Create(CultureInfo.InvariantCulture, $"{id}:{key}");
                return await store.ReplyInbox(ctx.Request.Cookies[session], id, key, body, frame, pow, context, ctx, issue, ct);
            }, PowScope.AdminInboxReply);

        Task<IResult> ChangeStatus(long id, HttpContext ctx, ScopedPow pow, bool issue, CancellationToken ct) =>
            ScopedPow.Protect(ctx, async () =>
            {
                if (id <= 0) throw new BusinessException(Rejection.NotFound, "Administrator inbox conversation not found.");
                if (!ctx.Request.Headers.TryGetValue(WireHeaders.AdminInboxVersion, out var header) || header.Count != 1 ||
                    header[0] is not { Length: > 0 and <= 10 } version ||
                    !uint.TryParse(version, NumberStyles.None, CultureInfo.InvariantCulture, out var xid) || xid == 0 ||
                    version != xid.ToString(CultureInfo.InvariantCulture))
                    throw new BusinessException(Rejection.Invalid, "Invalid administrator inbox version.");
                var frame = await readFrame(ctx, InboxWire.MaxAdminStatusFrameBytes, ct);
                var (target, reason) = InboxWire.DecodeAdminStatus(frame);
                return await store.ChangeInboxStatus(ctx.Request.Cookies[session], id, version, (ConversationStatus)target,
                    reason, frame, pow, ctx, issue, ct);
            }, PowScope.AdminInboxStatus);

        Task<IResult> SendNotice(HttpContext ctx, ScopedPow pow, bool issue, CancellationToken ct) =>
            ScopedPow.Protect(ctx, async () =>
            {
                if (!ctx.Request.Headers.TryGetValue(WireHeaders.SourceEventId, out var header) || header.Count != 1 ||
                    header[0] is not { Length: > 0 and <= 19 } value ||
                    !long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var eventId) || eventId <= 0)
                    throw new BusinessException(Rejection.Invalid, "Set a positive source event ID.");
                var frame = await readFrame(ctx, Wire.MaxAdminInboxNoticeFrameBytes, ct);
                return await store.SendInboxNotice(ctx.Request.Cookies[session], eventId, Wire.DecodeAdminInboxNotice(frame),
                    frame, pow, ctx, issue, ct);
            }, PowScope.AdminInboxNotice);
    }

    private static string? Query(IQueryCollection query, string key, int max)
    {
        if (!query.TryGetValue(key, out var values)) return null;
        return values.Count == 1 && values[0] is { Length: > 0 } value && value.Length <= max ? value :
            throw new BusinessException(Rejection.Invalid, "Invalid administrator inbox query.");
    }
}
