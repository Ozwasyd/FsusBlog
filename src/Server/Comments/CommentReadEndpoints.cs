namespace FsusBlog.V2.Server.Comments;

internal readonly record struct InstalledCommentRoutes(bool RootSubmission, bool SignedInReply, bool RootPowPolicy);

internal static class CommentReadEndpoints
{
    internal static InstalledCommentRoutes Map(WebApplication app, Publications publications, string cookie,
        bool rootPowPolicy, FsusBlog.V2.Server.Operations.SiteCapabilities capabilities)
    {
        CommentReports.Map(app, cookie);
        app.MapQueryGet(WireRoutes.CommentRoots, (HttpContext ctx, CommentReadStore store, int articleId, CancellationToken ct) =>
            ReadWithWriteHeader(ctx, publications, articleId, Cursor(ctx),
                cursor => store.RootsWithWriteStatus(articleId, cursor, Limit(ctx, 10, 50), capabilities.PublicCommentSubmissions, ct),
                () => CommentReadWire.Roots([], null)));

        app.MapQueryGet(WireRoutes.CommentChildren, (HttpContext ctx, CommentReadStore store, int articleId, long parentId, CancellationToken ct) =>
            Read(publications, articleId, Cursor(ctx), cursor => store.Children(articleId, parentId, cursor, Limit(ctx, 20, 100), ct),
                () => CommentReadWire.Children(parentId, 0, [], null)));

        app.MapQueryGet(WireRoutes.CommentContext, (HttpContext ctx, CommentReadStore store, int articleId, long commentId, int? window, CancellationToken ct) =>
            ReadWithWriteHeader(ctx, publications, articleId, null,
                _ => store.ContextWithWriteStatus(articleId, commentId, Math.Clamp(window ?? 6, 2, 20), capabilities.PublicCommentSubmissions, ct),
                () => CommentReadWire.Context(null, [], [])));

        app.MapQueryGet(WireRoutes.CommentThread, (HttpContext ctx, CommentReadStore store, int articleId, long rootId, CancellationToken ct) =>
            Read(publications, articleId, Cursor(ctx), cursor => store.Thread(articleId, rootId, cursor, Limit(ctx, 20, 100), ct),
                () => CommentReadWire.Thread(rootId, [], null)));

        if (capabilities.PublicCommentSubmissions)
        {
            var replies = capabilities.SignedInCommentReplies;
            MapSubmissions(app, cookie, replies, rootPowPolicy);
            app.MapCommandGet(WireRoutes.PublicCommentEligibility, async (HttpContext ctx, int articleId, Store store, CancellationToken ct) =>
            {
                if (!long.TryParse(ctx.Request.Query["publication"].FirstOrDefault(), NumberStyles.None,
                    CultureInfo.InvariantCulture, out var publication) || publication <= 0)
                    throw new BusinessException(Rejection.Invalid, "A valid publication is required.");
                var result = await store.WithSession(ctx.Request.Cookies[cookie], false,
                    async (db, tx, actor) =>
                    {
                        var eligibility = await CommentWriteStore.Eligibility(db, tx, actor, articleId, publication, ct);
                        if (replies && await FsusBlogV2.Storage.CurrentSchema.HasCommentReplySchemaAsync(db, tx, ct))
                            ctx.Response.Headers[WireHeaders.CommentReplyEnabled] = "1";
                        return eligibility;
                    }, ct);
                return ServerHttp.Frame(Wire.EncodePublicCommentEligibility(result));
            });
            return new(RootSubmission: true, SignedInReply: replies, RootPowPolicy: rootPowPolicy);
        }
        return new(RootSubmission: false, SignedInReply: false, RootPowPolicy: false);
    }

    private static void MapSubmissions(WebApplication app, string cookie, bool replies, bool rootPowPolicy)
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
                    var frame = await ServerHttp.ReadFrame(ctx, isReply ? WireLimits.PublicCommentReplyFrameBytes : WireLimits.PublicCommentFrameBytes, ct);
                    var (input, parent) = ReadSubmission(frame, isReply);
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

    private static (PublicCommentSubmission Input, long? Parent) ReadSubmission(byte[] frame, bool isReply)
    {
        if (!isReply) return (Wire.DecodePublicCommentSubmission(frame), null);
        var reply = Wire.DecodePublicCommentReply(frame);
        return (new(reply.ArticleId, reply.Publication, reply.IdempotencyKey, reply.ExplicitPublic, reply.DisplayName, reply.Body), reply.ParentId);
    }

    private static async Task<IResult> Read(Publications publications, int article, long? cursor, Func<long?, Task<byte[]>> fetch, Func<byte[]> hidden)
    {
        var snapshot = publications.Snapshot ?? throw new PublicUnavailableException();
        var bytes = snapshot.Article(article) is not null ? await fetch(cursor) : hidden();
        if (!ReferenceEquals(snapshot, publications.Snapshot)) throw new PublicUnavailableException();
        return ServerHttp.Frame(bytes);
    }

    private static async Task<IResult> ReadWithWriteHeader(HttpContext ctx, Publications publications, int article, long? cursor,
        Func<long?, Task<(byte[] Frame, bool WriteEnabled)>> fetch, Func<byte[]> hidden)
    {
        var snapshot = publications.Snapshot ?? throw new PublicUnavailableException();
        var result = snapshot.Article(article) is not null ? await fetch(cursor) : (Frame: hidden(), WriteEnabled: false);
        if (!ReferenceEquals(snapshot, publications.Snapshot)) throw new PublicUnavailableException();
        if (result.WriteEnabled) ctx.Response.Headers[WireHeaders.PublicCommentWriteEnabled] = "1";
        return ServerHttp.Frame(result.Frame);
    }

    private static long? Cursor(HttpContext ctx)
    {
        if (!ctx.Request.Query.TryGetValue("cursor", out var values)) return null;
        if (values.Count == 1)
        {
            if (string.IsNullOrWhiteSpace(values[0])) return null;
            if (values[0] is { Length: <= 24 } value &&
                long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var cursor) && cursor > 0)
                return cursor;
        }
        throw new BusinessException(Rejection.Invalid, "Invalid comment cursor.");
    }

    private static int Limit(HttpContext ctx, int fallback, int max) =>
        int.TryParse(ctx.Request.Query["limit"].FirstOrDefault(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var count)
            ? Math.Clamp(count, 5, max)
            : fallback;
}

internal static class CommentReports
{
    internal static void Map(WebApplication app, string cookie)
    {
        app.MapQueryGet(WireRoutes.CommentReportAvailability, (HttpContext ctx, Store store, CancellationToken ct) =>
            Run(ctx, store, (_, _, _) => Task.FromResult(Wire.EncodeEmptySuccess()), ct));

        app.MapCommandPost(WireRoutes.CommentReport, async (HttpContext ctx, Store store, int articleId, long id, CancellationToken ct) =>
        {
            var request = Wire.DecodeCommentReportRequest(await ServerHttp.ReadFrame(ctx, WireLimits.CommentReportFrameBytes, ct));
            return await Run(ctx, store, async (db, tx, reporter) =>
                Wire.EncodeCommentReportResult(await Submit(db, tx, reporter, articleId, id, request, ct)), ct);
        });

        Task<IResult> Run(HttpContext ctx, Store store,
            Func<NpgsqlConnection, NpgsqlTransaction, Guid, Task<byte[]>> action, CancellationToken ct)
        {
            var token = ctx.Request.Cookies[cookie];
            var expected = SiteSessions.Requested(ctx);
            return store.WithSession<IResult>(token, false, async (db, tx, actor) =>
            {
                SiteSessions.RequireCurrent(actor.Id, Store.TokenDigest(token)!, expected);
                if (!await CurrentSchema.HasCommentReportSchemaAsync(db, tx, ct)) throw Missing();
                return ServerHttp.Frame(await action(db, tx, actor.Id));
            }, ct);
        }
    }

    internal static async Task<CommentReportResult> Submit(NpgsqlConnection db, NpgsqlTransaction tx, Guid reporter,
        int article, long comment, CommentReportRequest request, CancellationToken ct)
    {
        if (article <= 0 || comment <= 0) throw Missing();
        if (await SqlCommands.Scalar(db, tx, ct, """
            select p.publication_id
            from public.comment c
            join public.article a on a.id=c.article_id and not a.deleted
            join public.article_publication p on p.article_id=a.id and p.revision=a.published_revision
                and p.published_at<=statement_timestamp()
            join public.article_publication_rights r on r.article_id=a.id and r.revision=p.revision and r.publication_id=p.publication_id
            where c.article_id=$1 and c.id=$2 and c.moderation_status=1 and not c.deleted
                and not exists(select 1 from public.comment_blocked_region b where b.article_id=c.article_id and b.comment_id=c.id)
            for share of c,a,p,r
            """, article, comment) is not long publication) throw Missing();

        for (var attempt = 0; attempt < 4; attempt++)
        {
            var id = BinaryPrimitives.ReadInt64LittleEndian(RandomNumberGenerator.GetBytes(sizeof(long))) & Wire.MaxCommentReportId;
            if (id == 0) continue;
            if (await SqlCommands.Scalar(db, tx, ct, """
                insert into public.comment_report(id,article_id,comment_id,reporter_id,publication_id,reason_code,detail,created_at)
                values($1,$2,$3,$4,$5,$6,$7,statement_timestamp()) on conflict do nothing returning id
                """, id, article, comment, reporter, publication, request.ReasonCode,
                SqlCommands.Optional(NpgsqlDbType.Text, request.Detail)) is long added) return new(true, "ok", added, false);

            // A conflicting transaction may commit after INSERT's statement snapshot.
            if (await SqlCommands.Scalar(db, tx, ct, """
                select id from public.comment_report where article_id=$1 and comment_id=$2 and reporter_id=$3
                """, article, comment, reporter) is long existing) return new(true, "comment_report_duplicate", existing, true);
        }
        throw new PublicUnavailableException();
    }

    private static BusinessException Missing() => new(Rejection.NotFound, "This comment cannot be reported.");
}
