using System.Globalization;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Core.Communication;
using FsusBlog.V2.Server.Sessions;
using FsusBlogV2.Storage;

namespace FsusBlog.V2.Server.Communication;

internal static class InboxEndpoints
{
    internal static void Map(WebApplication app, string cookie, Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame,
        FsusBlog.V2.Server.Operations.SiteCapabilities capabilities)
    {
        app.MapCommandGet(WireRoutes.InboxList, (HttpContext ctx, Store store, CancellationToken ct) =>
            Account(ctx, store, cookie, async inbox =>
            {
                var size = QueryInt(ctx, "size") ?? 20;
                var encoded = Query(ctx, "cursor", 32);
                var cursor = string.IsNullOrWhiteSpace(encoded) ? (Contracts.InboxCursor?)null : InboxWire.DecodeCursor(encoded);
                var position = cursor is { } c
                    ? new Core.Communication.InboxCursor(c.SnapshotMessageId, c.LastMessageAt, c.ConversationId)
                    : (Core.Communication.InboxCursor?)null;
                var page = await inbox.ListAsync(position, (int)Math.Clamp(size <= 0 ? 20 : size, 1, 50), Query(ctx, "filter", 32), ct);
                var items = page.Conversations.Select(c => new InboxListRecord(c.Id, c.Subject, (int)c.Status, Count(c.UnreadCount),
                    c.LastMessageAt, c.UpdatedAt, c.IsSystem, c.Status != ConversationStatus.Closed,
                    new InboxPreviewRecord((int)c.LastSender, c.LastMessageAt, c.Preview, Name(c.LastSender)))).ToArray();
                var next = page.Next is { } n ? InboxWire.EncodeCursor(new(n.SnapshotMessageId, n.LastMessageAt, n.ConversationId)) : null;
                return new Response(InboxWire.EncodeList(items, Count(page.Total), next), Cursor: cursor is null ? page.ReplayPosition : null);
            }, ct));

        app.MapCommandGet(WireRoutes.InboxDetail, (long id, HttpContext ctx, Store store, CancellationToken ct) =>
            Account(ctx, store, cookie, async inbox =>
            {
                var before = QueryInt(ctx, "beforeMessageId");
                var after = QueryInt(ctx, "afterMessageId");
                if (before <= 0 || after <= 0 || (before.HasValue && after.HasValue))
                    throw Invalid("Invalid message cursor.");
                var detail = after is long last
                    ? await inbox.DeltaAsync(id, last, 50, ct)
                    : await inbox.GetAsync(id, before, 50, ct);
                if (detail is null) throw new BusinessException(Rejection.NotFound, "Conversation not found.");
                return new Response(InboxWire.EncodeDetail(new(detail.Id, detail.Subject, (int)detail.Status, Count(detail.UnreadCount),
                    detail.LastMessageAt, detail.ReadSnapshot, detail.IsSystem, detail.Status != ConversationStatus.Closed,
                    detail.Messages.Select(m => new InboxMessageRecord(m.Id, m.ConversationId, (int)m.Sender, m.SentAt,
                        m.Body, Name(m.Sender))).ToArray(), detail.Previous)));
            }, ct));

        app.MapCommandPost(WireRoutes.InboxRead, (long id, HttpContext ctx, Store store, CancellationToken ct) =>
            Account(ctx, store, cookie, async inbox =>
            {
                var readThrough = InboxWire.DecodeRead(await readFrame(ctx, Aeds.HeaderSize + sizeof(long), ct));
                await inbox.MarkReadAsync(id, readThrough, ct);
                return new Response(Wire.EncodeEmptySuccess());
            }, ct));

        app.MapCommandGet(WireRoutes.InboxReplay, (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            var encoded = Query(ctx, "after", WireLimits.InboxReplayCursorChars);
            var limit = QueryInt(ctx, "limit") ?? 100;
            if (limit is < 1 or > WireLimits.InboxReplayMaxEvents) throw Invalid("Invalid notification page size.");
            return Account(ctx, store, cookie, async inbox =>
            {
                long after = 0;
                if (encoded is not null && !InboxReplayCursor.TryDecode(ctx.Request.Cookies[cookie]!, encoded, out after))
                    throw new BusinessException(Rejection.Conflict, "The notification cursor has expired. Reload the inbox.");
                var page = await inbox.ReplayAsync(after, (int)limit, ct);
                var events = page.Events.Select(e => new InboxReplayRecord(e.Sequence, (int)e.Kind, e.ConversationId,
                    e.MessageId, e.OccurredAt)).ToArray();
                // A fresh inbox snapshot, not the rejected cursor, supplies the baseline after loss.
                var packet = InboxReplayWire.Encode(page.RequiresResync ? 0 : page.Next, page.HasMore, page.RequiresResync, events);
                return new Response(packet, page.RequiresResync ? null : page.Next);
            }, ct);
        });
        InboxWriteEndpoints.Map(app, cookie, readFrame, capabilities);
    }

    private readonly record struct Response(byte[] Frame, long? Cursor = null);

    private static async Task<IResult> Account(HttpContext ctx, Store store, string cookie, Func<InboxStore, Task<Response>> operation,
        CancellationToken cancellationToken)
    {
        var token = ctx.Request.Cookies[cookie];
        var (response, expiresAt) = await store.WithSession(token, false, async (connection, transaction, actor) =>
        {
            if (ctx.Request.Headers.TryGetValue(WireHeaders.CurrentSession, out var expected))
                SiteSessions.RequireCurrent(actor.Id, Store.TokenDigest(token)!, expected.Count == 1 ? expected[0] : null);
            var frame = await operation(new InboxStore(connection, transaction, actor.Id));
            return (frame, actor.ExpiresAt);
        }, cancellationToken);
        ctx.Response.Headers[WireHeaders.AccessExpiresAtUtc] = expiresAt.UtcDateTime.ToString("O", CultureInfo.InvariantCulture);
        if (response.Cursor is long next)
            ctx.Response.Headers[WireHeaders.InboxReplayCursor] = InboxReplayCursor.Encode(token!, next);
        return ServerHttp.Frame(response.Frame);
    }

    private static string? Query(HttpContext ctx, string field, int maximum)
    {
        if (!ctx.Request.Query.TryGetValue(field, out var input)) return null;
        return input.Count == 1 && input[0] is { } text && text.Length <= maximum ? text : throw Invalid("Invalid query parameter.");
    }

    private static long? QueryInt(HttpContext ctx, string field)
    {
        var text = Query(ctx, field, 20);
        return text is null ? null : long.TryParse(text, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var value)
            ? value : throw Invalid("Invalid numeric query parameter.");
    }

    private static string Name(InboxSender sender) => sender switch
    {
        InboxSender.Account => "你",
        InboxSender.Administrator => "管理员",
        InboxSender.System => "系统",
        _ => throw new InvalidOperationException("Unsupported inbox sender.")
    };

    private static int Count(long value) => (int)Math.Min(int.MaxValue, value);
    private static BusinessException Invalid(string message) => new(Rejection.Invalid, message);
}
