namespace FsusBlog.V2.Server.Comments;

internal static class CommentSubmissionEndpoints
{
    internal static void Map(WebApplication app, string cookie, Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame,
        bool replies, bool rootPowPolicy)
    {
        MapRoute(WireRoutes.PublicCommentPowChallenge, isReply: false, issue: true);
        MapRoute(WireRoutes.SubmitPublicComment, isReply: false, issue: false);
        if (replies)
        {
            MapRoute(WireRoutes.PublicCommentReplyPow, isReply: true, issue: true);
            MapRoute(WireRoutes.SubmitPublicCommentReply, isReply: true, issue: false);
        }

        void MapRoute(string route, bool isReply, bool issue)
        {
            var scope = isReply ? PowScope.PublicCommentReply : PowScope.PublicCommentSubmit;
            app.MapCommandPost(route, (HttpContext ctx, Store store, ScopedPow pow, CancellationToken ct) =>
                ScopedPow.Protect(ctx, async () =>
                {
                    var frame = await readFrame(ctx, isReply ? WireLimits.PublicCommentReplyFrameBytes : WireLimits.PublicCommentFrameBytes, ct);
                    var (input, parent) = Read(frame, isReply);
                    if (!ClientMutationHeader.Matches(ctx, input.IdempotencyKey, required: true))
                        throw new BusinessException(Rejection.Invalid, isReply ? "Invalid public comment reply." : ClientMutationHeader.Mismatch);
                    var session = ctx.Request.Cookies[cookie];
                    var source = ScopedPow.Source(ctx);
                    var expected = isReply ? SiteSessions.Requested(ctx) : null;
                    var context = isReply ? string.Create(CultureInfo.InvariantCulture, $"{input.ArticleId}:{parent}") : "";
                    var rootNonce = issue && !isReply ? ScopedPow.ReadClientNonce(ctx) : null;
                    return await store.WithSession(session, false, async (db, tx, actor) =>
                    {
                        if (isReply) SiteSessions.RequireCurrent(actor.Id, Store.TokenDigest(session)!, expected);
                        if (issue) await CommentWriteStore.AdmitChallenge(db, tx, actor, input, ct, parent);
                        var proof = issue ? null : ScopedPow.ReadProof(ctx);
                        var policy = !isReply && rootPowPolicy ? await RootCommentPowPolicy.Read(db, tx, ct) : null;
                        if (issue)
                            return PowWire.EncodeChallenge(pow.Issue(scope, context, session!, source,
                                rootNonce ?? ScopedPow.ReadClientNonce(ctx), frame, policy));
                        await pow.Consume(db, tx, scope, context, session!, source, frame, proof!, ct, policy);
                        return Wire.EncodePublicCommentSubmissionResult(await CommentWriteStore.Submit(db, tx, actor, input, ct, parent));
                    }, ct);
                }, scope));
        }
    }

    private static (PublicCommentSubmission Input, long? Parent) Read(byte[] frame, bool isReply)
    {
        if (!isReply) return (Wire.DecodePublicCommentSubmission(frame), null);
        var reply = Wire.DecodePublicCommentReply(frame);
        return (new(reply.ArticleId, reply.Publication, reply.IdempotencyKey, reply.ExplicitPublic, reply.DisplayName, reply.Body), reply.ParentId);
    }
}
