using System.Globalization;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Core.Communication;
using FsusBlog.V2.Server.Security;
using FsusBlog.V2.Server.Sessions;
using FsusBlogV2.Storage;

namespace FsusBlog.V2.Server.Communication;

internal static class InboxWriteEndpoints
{
    internal const string Setting = "FSUSBLOG_PRIVATE_INBOX_WRITES";

    internal static void Map(WebApplication app, string cookie, Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame,
        FsusBlog.V2.Server.Operations.SiteCapabilities capabilities)
    {
        var enabled = capabilities.PrivateInboxWrites;
        var fenceVisibleMessages = capabilities.AdminInboxActivityOrder;
        app.MapCommandGet(WireRoutes.InboxWriteAvailability, async (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            var packet = await store.WithSession(ctx.Request.Cookies[cookie], false,
                (_, _, _) => Task.FromResult(Wire.EncodeEmptySuccess()), ct);
            ctx.Response.Headers[WireHeaders.InboxWriteEnabled] = enabled ? "1" : "0";
            return Results.Bytes(packet, Aeds.ContentType);
        });
        if (!enabled) return;

        app.MapCommandPost(WireRoutes.InboxCreatePowChallenge,
            (HttpContext ctx, Store store, ScopedPow pow, CancellationToken ct) => Run(ctx, store, pow, null, issue: true, ct));
        app.MapCommandPost(WireRoutes.InboxReplyPowChallenge,
            (long id, HttpContext ctx, Store store, ScopedPow pow, CancellationToken ct) => Run(ctx, store, pow, id, issue: true, ct));
        app.MapCommandPost(WireRoutes.InboxList,
            (HttpContext ctx, Store store, ScopedPow pow, CancellationToken ct) => Run(ctx, store, pow, null, issue: false, ct));
        app.MapCommandPost(WireRoutes.InboxReply,
            (long id, HttpContext ctx, Store store, ScopedPow pow, CancellationToken ct) => Run(ctx, store, pow, id, issue: false, ct));

        Task<IResult> Run(HttpContext ctx, Store store, ScopedPow pow, long? conversation, bool issue, CancellationToken ct)
        {
            var scope = conversation.HasValue ? PowScope.InboxReply : PowScope.InboxCreate;
            return ScopedPow.Protect(ctx, async () =>
            {
                if (!ctx.Request.Headers.TryGetValue(WireHeaders.ClientMutationId, out var header) || header.Count != 1 ||
                    header[0] is not { Length: <= 128 } rawKey)
                    throw new BusinessException(Rejection.Invalid, "Invalid inbox command key.");
                var key = InboxRules.CommandId(rawKey);
                var bytes = await readFrame(ctx, InboxWire.MaxRequestFrameBytes, ct);
                var context = conversation.HasValue
                    ? string.Create(CultureInfo.InvariantCulture, $"{conversation.Value}:{key}") : key;
                var session = ctx.Request.Cookies[cookie];
                var source = ScopedPow.Source(ctx);

                return await store.WithSession(session, false, async (db, tx, actor) =>
                {
                    if (ctx.Request.Headers.TryGetValue(WireHeaders.CurrentSession, out var expected))
                        SiteSessions.RequireCurrent(actor.Id, Store.TokenDigest(session)!, expected.Count == 1 ? expected[0] : null);
                    var input = Read(bytes, conversation);
                    var inbox = new InboxStore(db, tx, actor.Id, fenceVisibleMessages);
                    if (issue)
                    {
                        if (conversation is long existing)
                            await inbox.AdmitReply(existing, input.ReadThrough, key, input.Body, ct);
                        return PowWire.EncodeChallenge(pow.Issue(scope, context, session!, source, ScopedPow.ReadClientNonce(ctx), bytes));
                    }
                    await pow.Consume(db, tx, scope, context, session!, source, bytes, ScopedPow.ReadProof(ctx), ct);
                    if (conversation is long id)
                    {
                        var replied = await inbox.ReplyAsync(id, input.ReadThrough, key, input.Body, ct);
                        return InboxWire.EncodeMessage(Project(replied.Message, replied.Replayed));
                    }
                    var created = await inbox.CreateAsync(key, input.Subject, input.Body, ct);
                    var detail = await inbox.GetAsync(created.Message.ConversationId, null, 50, ct) ??
                        throw new InvalidOperationException("Created conversation could not be materialized.");
                    return InboxWire.EncodeDetail(new(detail.Id, detail.Subject, (int)detail.Status,
                        (int)Math.Min(int.MaxValue, detail.UnreadCount), detail.LastMessageAt, detail.ReadSnapshot, detail.IsSystem,
                        detail.Status != ConversationStatus.Closed, detail.Messages.Select(m => Project(m, false)).ToArray(),
                        Replayed: created.Replayed), createResponse: true);
                }, ct);
            }, scope);
        }
    }

    private static (string Subject, string Body, long ReadThrough) Read(byte[] frame, long? conversation)
    {
        if (conversation is <= 0) throw new BusinessException(Rejection.Invalid, "Invalid conversation identity.");
        if (conversation.HasValue)
        {
            var (readThrough, message) = InboxWire.DecodeReply(frame);
            return ("", InboxRules.Body(message), readThrough);
        }
        var (subject, body) = InboxWire.DecodeCreate(frame);
        return (InboxRules.Subject(subject), InboxRules.Body(body), 0);
    }

    private static InboxMessageRecord Project(InboxMessage message, bool replayed)
        => new(message.Id, message.ConversationId, (int)message.Sender, message.SentAt, message.Body,
            message.Sender switch { InboxSender.Account => "你", InboxSender.Administrator => "管理员", _ => "系统" }, replayed);
}
