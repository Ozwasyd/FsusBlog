using System.Globalization;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Core.Communication;
using FsusBlog.V2.Server.Communication;
using FsusBlog.V2.Server.Operations;
using FsusBlog.V2.Server.Security;
using FsusBlogV2.Storage;

namespace FsusBlog.V2.Server.Administration;

internal static class AdminInboxEndpoints
{
    internal const string ReplySetting = "FSUSBLOG_ADMIN_INBOX_REPLIES";
    internal const string StatusSetting = "FSUSBLOG_ADMIN_INBOX_STATUS";
    internal const string NoticeSetting = "FSUSBLOG_ADMIN_INBOX_NOTICE";
    internal const string SharedReadSetting = "FSUSBLOG_ADMIN_INBOX_SHARED_READ";
    internal const string LiveSetting = "FSUSBLOG_ADMIN_INBOX_LIVE";
    internal const string LivePolicy = "admin-inbox-live";
    internal sealed class LiveSocket;

    internal static void Map(WebApplication app, AdminSessionGate gate, string session,
        Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame, SiteCapabilities capabilities)
    {
        var store = new AdminInboxStore(gate);
        var replies = capabilities.AdminInboxReplies;
        var status = capabilities.AdminInboxStatus;
        var notice = capabilities.AdminInboxNotice;
        var sharedRead = capabilities.AdminInboxSharedRead;
        var live = capabilities.AdminInboxLive;
        var activityOrder = capabilities.AdminInboxActivityOrder;
        var activityStore = activityOrder ? new AdminInboxActivityStore(gate) : null;
        var replyStore = replies ? new AdminInboxReplyStore(gate) : null;
        var statusStore = status ? new AdminInboxStatusStore(gate) : null;
        var noticeStore = notice ? new AdminInboxNoticeStore(gate) : null;
        var readStore = sharedRead ? new AdminInboxReadStore(gate) : null;

        app.MapGet(WireRoutes.AdminInboxQueue, async (HttpContext ctx, CancellationToken ct) =>
        {
            var shared = Shared(ctx);
            var filter = Query(ctx.Request.Query, "status", 7) switch
            {
                null => -1, "open" => 0, "pending" => 1, "closed" => 2,
                "unread" when shared => 3, "system" when shared => 4,
                _ => throw new BusinessException(Rejection.Invalid, "Invalid administrator inbox filter.")
            };
            var activity = Query(ctx.Request.Query, "order", 8) switch
            {
                null => false,
                "activity" when activityOrder => true,
                "activity" => throw new BusinessException(Rejection.NotFound, "Administrator inbox activity order is unavailable."),
                _ => throw new BusinessException(Rejection.Invalid, "Invalid administrator inbox order.")
            };
            var admin = ctx.Request.Cookies[session];
            var cursor = Query(ctx.Request.Query, "cursor", activity ? AdminInboxActivityCursor.EncodedLength : 64);
            var page = activity ? await activityStore!.ReadInboxByActivity(admin, filter, cursor, shared, ct) :
                await store.ReadInbox(admin, filter, cursor, ct, shared);
            if (notice) ctx.Response.Headers[WireHeaders.AdminInboxNoticeEnabled] = "1";
            if (sharedRead) ctx.Response.Headers[WireHeaders.AdminInboxSharedRead] = "1";
            if (activityOrder) ctx.Response.Headers[WireHeaders.AdminInboxActivityOrder] = "1";
            if (live && (filter <= 2 || filter == 4) && cursor is null && !activity) ctx.Response.Headers[WireHeaders.AdminInboxLive] = "1";
            return Results.Bytes(Wire.EncodeAdminInboxPage(page, shared), Aeds.ContentType);
        }).RequireRateLimiting("command");

        app.MapGet(WireRoutes.AdminInboxThread, async (long id, HttpContext ctx, CancellationToken ct) =>
        {
            if (id <= 0) throw new BusinessException(Rejection.NotFound, "Administrator inbox conversation not found.");
            var shared = Shared(ctx);
            var thread = await store.ReadInboxThread(ctx.Request.Cookies[session], id, Query(ctx.Request.Query, "before", 64), ct, shared);
            if (replies) ctx.Response.Headers[WireHeaders.AdminInboxReplyEnabled] = "1";
            if (live && !thread.Conversation.System) ctx.Response.Headers[WireHeaders.AdminInboxLive] = "1";
            if (status) ctx.Response.Headers[WireHeaders.AdminInboxVersion] = thread.Version;
            if (thread.ReadSnapshot is not null) ctx.Response.Headers[WireHeaders.AdminInboxReadSnapshot] = thread.ReadSnapshot;
            return Results.Bytes(Wire.EncodeAdminInboxThread(thread, shared), Aeds.ContentType);
        }).RequireRateLimiting("command");

        if (live)
        {
            app.MapMethods(WireRoutes.AdminInboxQueueWake, [HttpMethods.Get, HttpMethods.Connect],
                (HttpContext ctx, InboxWake wake, InstanceLease lease) =>
                {
                    var token = ctx.Request.Cookies[session];
                    return InboxStreamEndpoints.Open(ctx, wake, lease, ct =>
                    {
                        var filter = Query(ctx.Request.Query, "status", 7) switch
                        {
                            null when !ctx.Request.QueryString.HasValue => -1,
                            "open" => 0, "pending" => 1, "closed" => 2,
                            "system" when ctx.Request.Query.Count == 2 && Shared(ctx) => 4,
                            _ => throw new BusinessException(Rejection.Invalid, "Invalid live administrator inbox filter.")
                        };
                        if (filter != 4 && ctx.Request.Query.Count > 1)
                            throw new BusinessException(Rejection.Invalid, "Unexpected live administrator inbox query.");
                        return store.InboxQueuePosition(token, filter, status, ct);
                    }, allowQuery: true);
                }).WithMetadata(new LiveSocket()).RequireRateLimiting(LivePolicy);
            app.MapMethods(WireRoutes.AdminInboxWake, [HttpMethods.Get, HttpMethods.Connect],
                (long id, HttpContext ctx, InboxWake wake, InstanceLease lease) =>
                {
                    var token = ctx.Request.Cookies[session];
                    return InboxStreamEndpoints.Open(ctx, wake, lease, ct => store.InboxThreadPosition(token, id, status, ct));
                }).WithMetadata(new LiveSocket()).RequireRateLimiting(LivePolicy);
        }

        if (replyStore is not null)
        {
            app.MapPost(WireRoutes.AdminInboxReplyPow, (long id, HttpContext ctx, ScopedPow pow, CancellationToken ct) =>
                Reply(id, ctx, pow, true, ct)).RequireRateLimiting("command");
            app.MapPost(WireRoutes.AdminInboxReply, (long id, HttpContext ctx, ScopedPow pow, CancellationToken ct) =>
                Reply(id, ctx, pow, false, ct)).RequireRateLimiting("command");
        }
        if (statusStore is not null)
        {
            app.MapPost(WireRoutes.AdminInboxStatusPow, (long id, HttpContext ctx, ScopedPow pow, CancellationToken ct) =>
                ChangeStatus(id, ctx, pow, true, ct)).RequireRateLimiting("command");
            app.MapPost(WireRoutes.AdminInboxStatus, (long id, HttpContext ctx, ScopedPow pow, CancellationToken ct) =>
                ChangeStatus(id, ctx, pow, false, ct)).RequireRateLimiting("command");
        }
        if (noticeStore is not null)
        {
            app.MapPost(WireRoutes.AdminInboxSendNoticePow, (HttpContext ctx, ScopedPow pow, CancellationToken ct) =>
                SendNotice(ctx, pow, true, ct)).RequireRateLimiting("command");
            app.MapPost(WireRoutes.AdminInboxSendNotice, (HttpContext ctx, ScopedPow pow, CancellationToken ct) =>
                SendNotice(ctx, pow, false, ct)).RequireRateLimiting("command");
        }
        if (readStore is not null)
        {
            app.MapPost(WireRoutes.AdminInboxAcknowledge, async (long id, HttpContext ctx, CancellationToken ct) =>
            {
                if (id <= 0) throw new BusinessException(Rejection.NotFound, "Administrator inbox conversation not found.");
                if (!ctx.Request.Headers.TryGetValue(WireHeaders.AdminInboxReadSnapshot, out var header) || header.Count != 1 ||
                    header[0] is not { Length: 64 } snapshot)
                    throw new BusinessException(Rejection.Invalid, "An administrator read snapshot is required.");
                var through = InboxWire.DecodeRead(await readFrame(ctx, Aeds.HeaderSize + sizeof(long), ct));
                var unread = await readStore.AcknowledgeInboxRead(ctx.Request.Cookies[session], id, through, snapshot, ct);
                ctx.Response.Headers[WireHeaders.AdminInboxUnread] = unread.ToString(CultureInfo.InvariantCulture);
                return Results.Bytes(Wire.EncodeEmptySuccess(), Aeds.ContentType);
            }).RequireRateLimiting("command");
        }

        bool Shared(HttpContext ctx) => Query(ctx.Request.Query, "shared", 1) switch
        {
            null => false,
            "1" when sharedRead => true,
            "1" => throw new BusinessException(Rejection.NotFound, "The shared administrator inbox is unavailable."),
            _ => throw new BusinessException(Rejection.Invalid, "Invalid administrator inbox projection.")
        };

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
                return await replyStore!.ReplyInbox(ctx.Request.Cookies[session], id, key, body, frame, pow, context, ctx, issue,
                    activityOrder, ct);
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
                return await statusStore!.ChangeInboxStatus(ctx.Request.Cookies[session], id, version, (ConversationStatus)target,
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
                return await noticeStore!.SendInboxNotice(ctx.Request.Cookies[session], eventId, Wire.DecodeAdminInboxNotice(frame),
                    frame, pow, ctx, issue, activityOrder, ct);
            }, PowScope.AdminInboxNotice);
    }

    private static string? Query(IQueryCollection query, string key, int max)
    {
        if (!query.TryGetValue(key, out var values)) return null;
        return values.Count == 1 && values[0] is { Length: > 0 } value && value.Length <= max ? value :
            throw new BusinessException(Rejection.Invalid, "Invalid administrator inbox query.");
    }
}
