using System.Globalization;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Security;
using FsusBlog.V2.Server.Sessions;

namespace FsusBlog.V2.Server.Comments;

internal static class CommentReplyEndpoints
{
    internal static void Map(WebApplication app, string cookie, Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame)
    {
        app.MapPost(WireRoutes.PublicCommentReplyPow, (HttpContext ctx, Store store, ScopedPow pow, CancellationToken ct) =>
            Run(ctx, store, pow, issue: true, ct)).RequireRateLimiting("command");
        app.MapPost(WireRoutes.SubmitPublicCommentReply, (HttpContext ctx, Store store, ScopedPow pow, CancellationToken ct) =>
            Run(ctx, store, pow, issue: false, ct)).RequireRateLimiting("command");

        Task<IResult> Run(HttpContext ctx, Store store, ScopedPow pow, bool issue, CancellationToken ct)
        {
            const PowScope scope = PowScope.PublicCommentReply;
            return ScopedPow.Protect(ctx, async () =>
            {
                var frame = await readFrame(ctx, WireLimits.PublicCommentReplyFrameBytes, ct);
                var reply = Wire.DecodePublicCommentReply(frame);
                if (!ctx.Request.Headers.TryGetValue(WireHeaders.ClientMutationId, out var key) ||
                    key.Count != 1 || !Guid.TryParseExact(key[0], "D", out var parsed) || parsed != reply.IdempotencyKey)
                    throw new BusinessException(Rejection.Invalid, "Invalid public comment reply.");
                var session = ctx.Request.Cookies[cookie];
                var source = ScopedPow.Source(ctx);
                var expected = SiteSessions.Requested(ctx);
                var context = string.Create(CultureInfo.InvariantCulture, $"{reply.ArticleId}:{reply.ParentId}");
                var input = new PublicCommentSubmission(reply.ArticleId, reply.Publication, reply.IdempotencyKey,
                    reply.ExplicitPublic, reply.DisplayName, reply.Body);
                return await store.WithSession(session, false, async (db, tx, actor) =>
                {
                    SiteSessions.RequireCurrent(actor.Id, Store.TokenDigest(session)!, expected);
                    if (issue)
                    {
                        await CommentWriteStore.AdmitChallenge(db, tx, actor, input, ct, reply.ParentId);
                        return PowWire.EncodeChallenge(pow.Issue(scope, context, session!, source, ScopedPow.ReadClientNonce(ctx), frame));
                    }
                    await pow.Consume(db, tx, scope, context, session!, source, frame, ScopedPow.ReadProof(ctx), ct);
                    var receipt = await CommentWriteStore.Submit(db, tx, actor, input, ct, reply.ParentId);
                    return Wire.EncodePublicCommentSubmissionResult(receipt);
                }, ct);
            }, scope);
        }
    }
}
