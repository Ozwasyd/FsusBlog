using Microsoft.Extensions.Primitives;

namespace FsusBlog.V2.Server.Authoring;

internal static class AuthorArticleEndpoints
{
    internal static void Map(WebApplication app, string authorCookie, Publications publications)
    {
        app.MapCommandGet(WireRoutes.DraftRecoveryScope, (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            var token = ctx.Request.Cookies[authorCookie];
            var expected = SiteSessions.Requested(ctx);
            return store.WithSession(token, true, async (db, tx, actor) =>
            {
                SiteSessions.IfCurrent(actor.Id, token, expected);
                var site = await CurrentSchema.ReadRecoverySiteIdAsync(db, tx, ct);
                return ServerHttp.Frame(Wire.EncodeDraftRecoveryScope(new(site, actor.Id)));
            }, ct);
        });

        app.MapCommandGet(WireRoutes.ArticleSummary, async (HttpContext context, Store store, int id, CancellationToken ct) =>
        {
            var token = context.Request.Cookies[authorCookie];
            var expected = SiteSessions.Requested(context);
            if (id <= 0 || !TryRevision(context.Request.Query["revision"], out var revision))
                throw new BusinessException(Rejection.Invalid, "An exact article revision is required.");
            var selected = revision;
            if (context.Request.Query.TryGetValue("sourceRevision", out var source) &&
                (!TryRevision(source, out selected) || selected >= revision))
                throw new BusinessException(Rejection.Invalid, "An earlier saved article revision is required.");
            var frame = await SiteSessions.WithCurrentAuthor(store, token, expected, async (db, tx, actor, digest) =>
            {
                await RevisionHistoryStore.LockCurrent(db, tx, actor, id, revision, ct);
                if (await SqlCommands.Scalar(db, tx, ct, """
                    select coalesce(author_summary,'') from public.article_revision where article_id=$1 and revision=$2
                    """, id, selected) is not string text)
                    throw new BusinessException(Rejection.NotFound, "Article summary is unavailable.");
                if (selected != revision) SiteSessions.RequireCurrent(actor.Id, digest, expected);
                return Wire.EncodeArticleSummary(new(id, selected, text));
            }, ct);
            return ServerHttp.Frame(frame);
        });

        app.MapCommandPost(WireRoutes.ArticleSummarySave, async (HttpContext context, Store store, CancellationToken ct) =>
        {
            var input = Wire.DecodeArticleSummaryCommand(await ServerHttp.ReadFrame(context, WireLimits.MaxArticleSummaryCommandFrameBytes, ct));
            ClientMutationHeader.Require(context, input.IdempotencyKey);
            var token = context.Request.Cookies[authorCookie];
            var expected = SiteSessions.Requested(context);
            var frame = await SiteSessions.WithCurrentAuthor(store, token, expected, async (db, tx, actor, _) =>
            {
                var saved = await Store.SetSummary(db, tx, actor, input, ct);
                return Wire.EncodeDraft(new(saved.Id, saved.Revision, saved.Title, saved.Body, saved.PublishedRevision is not null));
            }, ct);
            return ServerHttp.Frame(frame);
        });

        app.MapCommandGet(WireRoutes.Draft, (HttpContext ctx, Store store, int id, CancellationToken ct) =>
        {
            var token = ctx.Request.Cookies[authorCookie];
            var expected = SiteSessions.Requested(ctx);
            return store.WithSession(token, true, async (db, tx, actor) =>
            {
                SiteSessions.IfCurrent(actor.Id, token, expected);
                return ServerHttp.DraftResponse(await Store.Find(db, tx, actor, id, false, ct));
            }, ct);
        });

        MapMutation(app, authorCookie, publications, WireRoutes.Save, ArticleAction.Save);
        MapMutation(app, authorCookie, publications, WireRoutes.Publish, ArticleAction.Publish);
        MapMutation(app, authorCookie, publications, WireRoutes.Retract, ArticleAction.Retract);
        MapMutation(app, authorCookie, publications, WireRoutes.Delete, ArticleAction.Delete);
        MapMutation(app, authorCookie, publications, WireRoutes.Restore, ArticleAction.Restore);
    }

    private static bool TryRevision(StringValues values, out long revision)
    {
        revision = 0;
        return values.Count == 1 && long.TryParse(values[0], NumberStyles.None, CultureInfo.InvariantCulture, out revision) &&
            revision > 0 && values[0] == revision.ToString(CultureInfo.InvariantCulture);
    }

    private static void MapMutation(WebApplication app, string authorCookie, Publications publications, string path, ArticleAction action)
    {
        app.MapCommandPost(path, async (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            var frame = await ServerHttp.ReadFrame(ctx, action == ArticleAction.Save ? WireLimits.MaxArticleBodyEditsCommandFrameBytes :
                WireLimits.MaxCommandFrameBytes, ct);
            var type = action == ArticleAction.Save && frame.Length >= WireHeader.HeaderSize
                ? (FrameType)BinaryPrimitives.ReadUInt16LittleEndian(frame.AsSpan(WireHeader.TypeOffset)) : FrameType.ArticleCommand;
            var insertion = type == FrameType.ArticleBodyInsertionCommand ? Wire.DecodeArticleBodyInsertionCommand(frame) : null;
            var insertions = type == FrameType.ArticleBodyInsertionsCommand ? Wire.DecodeArticleBodyInsertionsCommand(frame) : null;
            var bodyEdits = type == FrameType.ArticleBodyEditsCommand ? Wire.DecodeArticleBodyEditsCommand(frame) : null;
            var input = (bodyEdits, insertions, insertion) switch
            {
                ({ } edited, _, _) => new ArticleCommand(edited.Id, edited.ExpectedRevision, edited.IdempotencyKey, edited.Title, edited.Body),
                (_, { } many, _) => new ArticleCommand(many.Id, many.ExpectedRevision, many.IdempotencyKey, many.Title, many.Body),
                (_, _, { } one) => new ArticleCommand(one.Id, one.ExpectedRevision, one.IdempotencyKey, one.Title, one.Body),
                _ => Wire.DecodeArticleCommand(frame),
            };
            if (!ClientMutationHeader.Matches(ctx, input.IdempotencyKey))
                return ServerHttp.Error(ctx, 400, ClientMutationHeader.Mismatch);
            var edit = Publishing.Validate(action, new(input.Id, input.ExpectedRevision, input.IdempotencyKey, input.Title, input.Body));
            var result = await publications.Command(store, ctx.Request.Cookies[authorCookie], action, edit, ct,
                SiteSessions.Requested(ctx), insertion, insertions, bodyEdits);
            return action == ArticleAction.Delete
                ? ServerHttp.EmptyFrame()
                : ServerHttp.DraftResponse(result.Article);
        });
    }
}

internal sealed class DraftMutationRoutes(WebApplication app, string cookie)
{
    internal void MapSchedule()
    {
        Get(WireRoutes.DraftSchedule, ArticleScheduleStore.Read, Wire.EncodeArticleSchedule);
        Post(WireRoutes.DraftScheduleCommand, WireLimits.MaxArticleScheduleFrameBytes, Wire.DecodeArticleScheduleCommand,
            input => input.IdempotencyKey, Store.Schedule, value => ServerHttp.Frame(Wire.EncodeArticleSchedule(value)));
    }

    internal void MapRights()
    {
        Get(WireRoutes.DraftRights, async (db, tx, actor, id, revision, ct) =>
        {
            await RevisionHistoryStore.LockCurrent(db, tx, actor, id, revision, ct);
            return await PublicationRightsStore.Read(db, tx, id, revision, ct);
        }, Wire.EncodeArticleRightsPolicy);
        Post(WireRoutes.DraftRightsCommand, WireLimits.MaxArticleRightsFrameBytes, Wire.DecodeArticleRightsCommand,
            input => input.IdempotencyKey, Store.SetRights, value => ServerHttp.Frame(Wire.EncodeArticleRightsPolicy(value)));
    }

    internal void MapRollback() =>
        Post(WireRoutes.DraftRollback, WireLimits.MaxDraftRollbackFrameBytes, Wire.DecodeDraftRollback,
            input => input.IdempotencyKey, Store.RollbackDraft, ServerHttp.DraftResponse);

    private void Get<T>(string route,
        Func<NpgsqlConnection, NpgsqlTransaction, Identity, int, long, CancellationToken, Task<T>> read, Func<T, byte[]> encode) =>
        app.MapCommandGet(route, (HttpContext ctx, Store store, int id, CancellationToken ct) =>
        {
            var revision = DraftRevisionQuery.Read(ctx, id);
            return store.WithSession(ctx.Request.Cookies[cookie], true, async (db, tx, actor) =>
                ServerHttp.Frame(encode(await read(db, tx, actor, id, revision, ct))), ct);
        });

    private delegate T Decode<T>(ReadOnlySpan<byte> frame);

    private void Post<T, TResult>(string route, int maximumBytes, Decode<T> decode, Func<T, Guid> key,
        Func<NpgsqlConnection, NpgsqlTransaction, Identity, T, CancellationToken, Task<TResult>> apply, Func<TResult, IResult> respond) =>
        app.MapCommandPost(route, async (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            var input = decode(await ServerHttp.ReadFrame(ctx, maximumBytes, ct));
            ClientMutationHeader.Require(ctx, key(input));
            return await store.WithSession(ctx.Request.Cookies[cookie], true, async (db, tx, actor) =>
                respond(await apply(db, tx, actor, input, ct)), ct);
        });
}

internal readonly record struct OwnedArticleHead(long Revision, long? PublishedRevision);

internal static class OwnedArticleRead
{
    internal static async Task<OwnedArticleHead?> TryLock(NpgsqlConnection db, NpgsqlTransaction tx, Guid owner, int article, CancellationToken ct)
    {
        var head = await SqlCommands.QueryOneValue(db, tx, ct,
            "select revision,published_revision from public.article where id=$1 and owner_id=$2 and not deleted for share",
            row => new OwnedArticleHead(row.GetInt64(0), row.IsDBNull(1) ? null : row.GetInt64(1)), article, owner);
        return head is { } found && !await ArchivedArticleAuthority.IsLockedArchived(db, tx, article, ct) ? found : null;
    }
}

internal static class ArchivedArticleAuthority
{
    internal const string Reason = "administrator-rollback-archived";

    internal const string Available = $"""
        (select h.kind='retract' and h.reason='{Reason}'
         from public.article_publication_history h
         where h.article_id=a.id order by h.event_no desc limit 1) is not true
        """;

    internal static async Task<bool> IsLockedArchived(NpgsqlConnection db, NpgsqlTransaction tx, int article, CancellationToken ct) =>
        await SqlCommands.Scalar(db, tx, ct, $"select not ({Available}) from (values ($1::integer)) a(id)", article) is true;

    internal static async Task<bool> AnyLockedArchived(NpgsqlConnection db, NpgsqlTransaction tx, int[] articles, CancellationToken ct) =>
        await SqlCommands.Scalar(db, tx, ct, $"select exists(select from unnest($1::integer[]) a(id) where not ({Available}))", articles) is true;

    internal static async Task RequireLockedAvailability(NpgsqlConnection db, NpgsqlTransaction tx, int article, CancellationToken ct)
    {
        if (await IsLockedArchived(db, tx, article, ct)) throw new BusinessException(Rejection.NotFound, "Article not found.");
    }
}

internal static class ArticleInventorySql
{
    internal const string CurrentState = """
        case when a.deleted then 5 when s.due_at is not null then 2 when a.published_revision is not null then 3
             when (select h.kind='retract' and h.reason='administrator-rollback-draft'
                   from public.article_publication_history h
                   where h.article_id=a.id order by h.event_no desc limit 1) then 1
             when a.publication_count>0 then 4 else 1 end
        """;

    internal static string CurrentSchedule(int generationParameter, bool crossAuthor = false)
    {
        var generation = "$" + generationParameter.ToString(CultureInfo.InvariantCulture);
        if (crossAuthor) generation = $"coalesce((select p.generation from public.admin_principal p where p.id=a.owner_id and p.enabled),{generation})";
        return $"""
            left join public.article_schedule s on s.article_id=a.id and s.revision=a.revision
                and s.actor_id=a.owner_id and s.generation={generation} and not a.deleted
            """;
    }

    internal static string KeywordPredicate(int keywordParameter, int? includeSummaryParameter = null)
    {
        var keyword = "$" + keywordParameter.ToString(CultureInfo.InvariantCulture);
        var includeSummary = includeSummaryParameter is { } index ? "$" + index.ToString(CultureInfo.InvariantCulture) + " and " : "";
        return $"({keyword}='' or strpos(lower(a.title),lower({keyword}))>0 or " +
            $"({includeSummary}strpos(lower(coalesce((select r.author_summary from public.article_revision r " +
            $"where r.article_id=a.id and r.revision=a.revision),left(a.body,200))),lower({keyword}))>0))";
    }
}
