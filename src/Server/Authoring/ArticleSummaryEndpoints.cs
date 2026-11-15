using System.Globalization;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Sessions;
using Microsoft.Extensions.Primitives;

namespace FsusBlog.V2.Server.Authoring;

internal static class ArticleSummaryEndpoints
{
    internal static void Map(WebApplication app, string cookie, Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame)
    {
        app.MapGet(WireRoutes.ArticleSummary, async (HttpContext context, Store store, int id, CancellationToken ct) =>
        {
            var token = context.Request.Cookies[cookie];
            var expected = SiteSessions.Requested(context);
            if (id <= 0 || !TryRevision(context.Request.Query["revision"], out var revision))
                throw new BusinessException(Rejection.Invalid, "An exact article revision is required.");
            var selected = revision;
            if (context.Request.Query.TryGetValue("sourceRevision", out var source) &&
                (!TryRevision(source, out selected) || selected >= revision))
                throw new BusinessException(Rejection.Invalid, "An earlier saved article revision is required.");
            var frame = await store.WithSession(token, true, async (db, tx, actor) =>
            {
                SiteSessions.RequireCurrent(actor.Id, Store.TokenDigest(token)!, expected);
                await RevisionHistoryStore.LockCurrent(db, tx, actor, id, revision, ct);
                await using var summary = Store.Sql(db, tx, """
                    select coalesce(author_summary,'') from public.article_revision where article_id=$1 and revision=$2
                    """, id, selected);
                if (await summary.ExecuteScalarAsync(ct) is not string text)
                    throw new BusinessException(Rejection.NotFound, "Article summary is unavailable.");
                if (selected != revision) SiteSessions.RequireCurrent(actor.Id, Store.TokenDigest(token)!, expected);
                return Wire.EncodeArticleSummary(new(id, selected, text));
            }, ct);
            return Results.Bytes(frame, Aeds.ContentType);
        }).RequireRateLimiting("command");

        app.MapPost(WireRoutes.ArticleSummarySave, async (HttpContext context, Store store, CancellationToken ct) =>
        {
            var input = Wire.DecodeArticleSummaryCommand(await readFrame(context, WireLimits.MaxArticleSummaryCommandFrameBytes, ct));
            if (context.Request.Headers.TryGetValue(WireHeaders.ClientMutationId, out var header) &&
                (header.Count != 1 || !Guid.TryParseExact(header[0], "D", out var id) || id != input.IdempotencyKey))
                throw new BusinessException(Rejection.Invalid, "Command key does not match its request header.");
            var token = context.Request.Cookies[cookie];
            var expected = SiteSessions.Requested(context);
            var frame = await store.WithSession(token, true, async (db, tx, actor) =>
            {
                SiteSessions.RequireCurrent(actor.Id, Store.TokenDigest(token)!, expected);
                var saved = await Store.SetSummary(db, tx, actor, input, ct);
                return Wire.EncodeDraft(new(saved.Id, saved.Revision, saved.Title, saved.Body, saved.PublishedRevision is not null));
            }, ct);
            return Results.Bytes(frame, Aeds.ContentType);
        }).RequireRateLimiting("command");
    }

    private static bool TryRevision(StringValues values, out long revision)
    {
        revision = 0;
        return values.Count == 1 && long.TryParse(values[0], NumberStyles.None, CultureInfo.InvariantCulture, out revision) &&
            revision > 0 && values[0] == revision.ToString(CultureInfo.InvariantCulture);
    }
}
