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

    internal static void Map(WebApplication app, AdminSessionGate gate, string session, SiteCapabilities capabilities)
    {
        var store = new AdminInboxStore(gate);
        var (replies, status, notice, sharedRead, live, activityOrder) = (capabilities.AdminInboxReplies, capabilities.AdminInboxStatus,
            capabilities.AdminInboxNotice, capabilities.AdminInboxSharedRead, capabilities.AdminInboxLive, capabilities.AdminInboxActivityOrder);
        var activityStore = activityOrder ? new AdminInboxActivityStore(gate) : null;
        var replyStore = replies ? new AdminInboxReplyStore(gate) : null;
        var statusStore = status ? new AdminInboxStatusStore(gate) : null;
        var noticeStore = notice ? new AdminInboxNoticeStore(gate) : null;
        var readStore = sharedRead ? new AdminInboxReadStore(gate) : null;

        app.MapCommandGet(WireRoutes.AdminInboxQueue, async (HttpContext ctx, CancellationToken ct) =>
        {
            var shared = Shared(ctx);
            var filter = Query(ctx.Request.Query, "status", 7) switch
            {
                null => -1, "open" => 0, "pending" => 1, "closed" => 2, "unread" when shared => 3, "system" when shared => 4,
                _ => throw new BusinessException(Rejection.Invalid, "Invalid administrator inbox filter.")
            };
            var activity = Query(ctx.Request.Query, "order", 8) switch
            {
                null => false, "activity" when activityOrder => true,
                "activity" => throw new BusinessException(Rejection.NotFound, "Administrator inbox activity order is unavailable."),
                _ => throw new BusinessException(Rejection.Invalid, "Invalid administrator inbox order.")
            };
            var cursor = Query(ctx.Request.Query, "cursor", activity ? AdminInboxActivityCursor.EncodedLength : 64);
            var page = activity
                ? await activityStore!.ReadInboxByActivity(ctx.Request.Cookies[session], filter, cursor, shared, ct)
                : await store.ReadInbox(ctx.Request.Cookies[session], filter, cursor, ct, shared);
            if (notice) ctx.Response.Headers[WireHeaders.AdminInboxNoticeEnabled] = "1";
            if (sharedRead) ctx.Response.Headers[WireHeaders.AdminInboxSharedRead] = "1";
            if (activityOrder) ctx.Response.Headers[WireHeaders.AdminInboxActivityOrder] = "1";
            if (live && (filter <= 2 || filter == 4) && cursor is null && !activity) ctx.Response.Headers[WireHeaders.AdminInboxLive] = "1";
            return ServerHttp.Frame(Wire.EncodeAdminInboxPage(page, shared));
        });

        app.MapCommandGet(WireRoutes.AdminInboxThread, async (long id, HttpContext ctx, CancellationToken ct) =>
        {
            RequireId(id);
            var shared = Shared(ctx);
            var thread = await store.ReadInboxThread(ctx.Request.Cookies[session], id, Query(ctx.Request.Query, "before", 64), ct, shared);
            if (replies) ctx.Response.Headers[WireHeaders.AdminInboxReplyEnabled] = "1";
            if (live && !thread.Conversation.System) ctx.Response.Headers[WireHeaders.AdminInboxLive] = "1";
            if (status) ctx.Response.Headers[WireHeaders.AdminInboxVersion] = thread.Version;
            if (thread.ReadSnapshot is not null) ctx.Response.Headers[WireHeaders.AdminInboxReadSnapshot] = thread.ReadSnapshot;
            return ServerHttp.Frame(Wire.EncodeAdminInboxThread(thread, shared));
        });

        if (live)
        {
            app.MapMethods(WireRoutes.AdminInboxQueueWake, [HttpMethods.Get, HttpMethods.Connect],
                (HttpContext ctx, InboxWake wake, InstanceLease lease) =>
                InboxStreamEndpoints.Open(ctx, wake, lease, ct =>
                {
                    var filter = Query(ctx.Request.Query, "status", 7) switch
                    {
                        null when !ctx.Request.QueryString.HasValue => -1, "open" => 0, "pending" => 1, "closed" => 2,
                        "system" when ctx.Request.Query.Count == 2 && Shared(ctx) => 4,
                        _ => throw new BusinessException(Rejection.Invalid, "Invalid live administrator inbox filter.")
                    };
                    if (filter != 4 && ctx.Request.Query.Count > 1)
                        throw new BusinessException(Rejection.Invalid, "Unexpected live administrator inbox query.");
                    return store.InboxQueuePosition(ctx.Request.Cookies[session], filter, status, ct);
                }, allowQuery: true)).WithMetadata(new LiveSocket()).RequireRateLimiting(LivePolicy);
            app.MapMethods(WireRoutes.AdminInboxWake, [HttpMethods.Get, HttpMethods.Connect],
                (long id, HttpContext ctx, InboxWake wake, InstanceLease lease) =>
                InboxStreamEndpoints.Open(ctx, wake, lease, ct => store.InboxThreadPosition(ctx.Request.Cookies[session], id, status, ct)))
                .WithMetadata(new LiveSocket()).RequireRateLimiting(LivePolicy);
        }

        if (replyStore is not null) MapIdPowPair(WireRoutes.AdminInboxReplyPow, WireRoutes.AdminInboxReply, PowScope.AdminInboxReply,
            async (id, ctx, pow, issue, ct) =>
            {
                var key = InboxRules.CommandId(RequireHeader(ctx, WireHeaders.ClientMutationId, 1, 128, "Invalid inbox command key."));
                var frame = await ServerHttp.ReadFrame(ctx, InboxWire.MaxRequestFrameBytes, ct);
                return await replyStore.ReplyInbox(ctx.Request.Cookies[session], id, key, InboxRules.Body(InboxWire.DecodeAdminReply(frame)),
                    frame, pow, string.Create(CultureInfo.InvariantCulture, $"{id}:{key}"), ctx, issue, activityOrder, ct);
            });
        if (statusStore is not null) MapIdPowPair(WireRoutes.AdminInboxStatusPow, WireRoutes.AdminInboxStatus, PowScope.AdminInboxStatus,
            async (id, ctx, pow, issue, ct) =>
            {
                var version = RequireHeader(ctx, WireHeaders.AdminInboxVersion, 1, 10, "Invalid administrator inbox version.");
                if (!uint.TryParse(version, NumberStyles.None, CultureInfo.InvariantCulture, out var xid) || xid == 0 ||
                    version != xid.ToString(CultureInfo.InvariantCulture))
                    throw new BusinessException(Rejection.Invalid, "Invalid administrator inbox version.");
                var frame = await ServerHttp.ReadFrame(ctx, InboxWire.MaxAdminStatusFrameBytes, ct);
                var (target, reason) = InboxWire.DecodeAdminStatus(frame);
                return await statusStore.ChangeInboxStatus(ctx.Request.Cookies[session], id, version, (ConversationStatus)target,
                    reason, frame, pow, ctx, issue, ct);
            });
        if (noticeStore is not null)
        {
            Task<IResult> Notice(HttpContext ctx, ScopedPow pow, bool issue, CancellationToken ct) =>
                ScopedPow.Protect(ctx, async () =>
                {
                    var raw = RequireHeader(ctx, WireHeaders.SourceEventId, 1, 19, "Set a positive source event ID.");
                    if (!long.TryParse(raw, NumberStyles.None, CultureInfo.InvariantCulture, out var eventId) || eventId <= 0)
                        throw new BusinessException(Rejection.Invalid, "Set a positive source event ID.");
                    var frame = await ServerHttp.ReadFrame(ctx, Wire.MaxAdminInboxNoticeFrameBytes, ct);
                    return await noticeStore.SendInboxNotice(ctx.Request.Cookies[session], eventId, Wire.DecodeAdminInboxNotice(frame),
                        frame, pow, ctx, issue, activityOrder, ct);
                }, PowScope.AdminInboxNotice);
            app.MapCommandPost(WireRoutes.AdminInboxSendNoticePow, (HttpContext ctx, ScopedPow pow, CancellationToken ct) => Notice(ctx, pow, true, ct));
            app.MapCommandPost(WireRoutes.AdminInboxSendNotice, (HttpContext ctx, ScopedPow pow, CancellationToken ct) => Notice(ctx, pow, false, ct));
        }
        if (readStore is not null)
            app.MapCommandPost(WireRoutes.AdminInboxAcknowledge, async (long id, HttpContext ctx, CancellationToken ct) =>
            {
                RequireId(id);
                var snapshot = RequireHeader(ctx, WireHeaders.AdminInboxReadSnapshot, 64, 64, "An administrator read snapshot is required.");
                var through = InboxWire.DecodeRead(await ServerHttp.ReadFrame(ctx, Aeds.HeaderSize + sizeof(long), ct));
                var unread = await readStore.AcknowledgeInboxRead(ctx.Request.Cookies[session], id, through, snapshot, ct);
                ctx.Response.Headers[WireHeaders.AdminInboxUnread] = unread.ToString(CultureInfo.InvariantCulture);
                return ServerHttp.EmptyFrame();
            });

        void MapIdPowPair(string powRoute, string executeRoute, PowScope scope,
            Func<long, HttpContext, ScopedPow, bool, CancellationToken, Task<byte[]>> run)
        {
            Task<IResult> Call(long id, HttpContext ctx, ScopedPow pow, bool issue, CancellationToken ct) =>
                ScopedPow.Protect(ctx, () => { RequireId(id); return run(id, ctx, pow, issue, ct); }, scope);
            app.MapCommandPost(powRoute, (long id, HttpContext ctx, ScopedPow pow, CancellationToken ct) => Call(id, ctx, pow, true, ct));
            app.MapCommandPost(executeRoute, (long id, HttpContext ctx, ScopedPow pow, CancellationToken ct) => Call(id, ctx, pow, false, ct));
        }

        bool Shared(HttpContext ctx) => Query(ctx.Request.Query, "shared", 1) switch
        {
            null => false, "1" when sharedRead => true,
            "1" => throw new BusinessException(Rejection.NotFound, "The shared administrator inbox is unavailable."),
            _ => throw new BusinessException(Rejection.Invalid, "Invalid administrator inbox projection.")
        };
    }

    private static void RequireId(long id) { if (id <= 0) throw AdminInboxStore.ConversationNotFound(); }

    private static string RequireHeader(HttpContext ctx, string name, int min, int max, string error) =>
        ctx.Request.Headers.TryGetValue(name, out var header) && header.Count == 1 && header[0] is { } v && v.Length >= min && v.Length <= max
            ? v : throw new BusinessException(Rejection.Invalid, error);

    private static string? Query(IQueryCollection query, string key, int max) =>
        !query.TryGetValue(key, out var values) ? null :
        values.Count == 1 && values[0] is { Length: > 0 } value && value.Length <= max ? value :
        throw new BusinessException(Rejection.Invalid, "Invalid administrator inbox query.");
}
