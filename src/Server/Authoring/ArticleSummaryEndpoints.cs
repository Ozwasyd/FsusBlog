using Microsoft.Extensions.Primitives;

namespace FsusBlog.V2.Server.Authoring;

internal static class ArticleSummaryEndpoints
{
    internal static void Map(WebApplication app, string cookie, Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame)
    {
        app.MapCommandGet(WireRoutes.ArticleSummary, async (HttpContext context, Store store, int id, CancellationToken ct) =>
        {
            var token = context.Request.Cookies[cookie];
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
            var input = Wire.DecodeArticleSummaryCommand(await readFrame(context, WireLimits.MaxArticleSummaryCommandFrameBytes, ct));
            ClientMutationHeader.Require(context, input.IdempotencyKey);
            var token = context.Request.Cookies[cookie];
            var expected = SiteSessions.Requested(context);
            var frame = await SiteSessions.WithCurrentAuthor(store, token, expected, async (db, tx, actor, _) =>
            {
                var saved = await Store.SetSummary(db, tx, actor, input, ct);
                return Wire.EncodeDraft(new(saved.Id, saved.Revision, saved.Title, saved.Body, saved.PublishedRevision is not null));
            }, ct);
            return ServerHttp.Frame(frame);
        });
    }

    private static bool TryRevision(StringValues values, out long revision)
    {
        revision = 0;
        return values.Count == 1 && long.TryParse(values[0], NumberStyles.None, CultureInfo.InvariantCulture, out revision) &&
            revision > 0 && values[0] == revision.ToString(CultureInfo.InvariantCulture);
    }
}
