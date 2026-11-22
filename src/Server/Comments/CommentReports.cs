using System.Buffers.Binary;
using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Sessions;
using FsusBlogV2.Storage;
using Npgsql;
using NpgsqlTypes;

namespace FsusBlog.V2.Server.Comments;

internal static class CommentReports
{
    internal static void Map(WebApplication app, string cookie, Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame)
    {
        app.MapGet(WireRoutes.CommentReportAvailability, (HttpContext ctx, Store store, CancellationToken ct) =>
            Run(ctx, store, (_, _, _) => Task.FromResult(Wire.EncodeEmptySuccess()), ct)).RequireRateLimiting("query");

        app.MapPost(WireRoutes.CommentReport, async (HttpContext ctx, Store store, int articleId, long id, CancellationToken ct) =>
        {
            var request = Wire.DecodeCommentReportRequest(await readFrame(ctx, WireLimits.CommentReportFrameBytes, ct));
            return await Run(ctx, store, async (db, tx, reporter) =>
                Wire.EncodeCommentReportResult(await Submit(db, tx, reporter, articleId, id, request, ct)), ct);
        }).RequireRateLimiting("command");

        Task<IResult> Run(HttpContext ctx, Store store,
            Func<NpgsqlConnection, NpgsqlTransaction, Guid, Task<byte[]>> action, CancellationToken ct)
        {
            var token = ctx.Request.Cookies[cookie];
            var expected = SiteSessions.Requested(ctx);
            return store.WithSession<IResult>(token, false, async (db, tx, actor) =>
            {
                SiteSessions.RequireCurrent(actor.Id, Store.TokenDigest(token)!, expected);
                if (!await CurrentSchema.HasCommentReportSchemaAsync(db, tx, ct)) throw Missing();
                return Results.Bytes(await action(db, tx, actor.Id), Aeds.ContentType);
            }, ct);
        }
    }

    internal static async Task<CommentReportResult> Submit(NpgsqlConnection db, NpgsqlTransaction tx, Guid reporter,
        int article, long comment, CommentReportRequest request, CancellationToken ct)
    {
        if (article <= 0 || comment <= 0) throw Missing();
        long publication;
        await using (var visible = Store.Sql(db, tx, """
            select p.publication_id
            from public.comment c
            join public.article a on a.id=c.article_id and not a.deleted
            join public.article_publication p on p.article_id=a.id and p.revision=a.published_revision
                and p.published_at<=statement_timestamp()
            join public.article_publication_rights r on r.article_id=a.id and r.revision=p.revision and r.publication_id=p.publication_id
            where c.article_id=$1 and c.id=$2 and c.moderation_status=1 and not c.deleted
                and not exists(select 1 from public.comment_blocked_region b where b.article_id=c.article_id and b.comment_id=c.id)
            for share of c,a,p,r
            """, article, comment))
        {
            if (await visible.ExecuteScalarAsync(ct) is not long current) throw Missing();
            publication = current;
        }

        for (var attempt = 0; attempt < 4; attempt++)
        {
            var id = BinaryPrimitives.ReadInt64LittleEndian(RandomNumberGenerator.GetBytes(sizeof(long))) & Wire.MaxCommentReportId;
            if (id == 0) continue;
            await using (var insert = Store.Sql(db, tx, """
                insert into public.comment_report(id,article_id,comment_id,reporter_id,publication_id,reason_code,detail,created_at)
                values($1,$2,$3,$4,$5,$6,$7,statement_timestamp()) on conflict do nothing returning id
                """, id, article, comment, reporter, publication, request.ReasonCode,
                SqlCommands.Optional(NpgsqlDbType.Text, request.Detail)))
            {
                if (await insert.ExecuteScalarAsync(ct) is long added) return new(true, "ok", added, false);
            }

            // A conflicting transaction may commit after INSERT's statement snapshot.
            await using var receipt = Store.Sql(db, tx, """
                select id from public.comment_report where article_id=$1 and comment_id=$2 and reporter_id=$3
                """, article, comment, reporter);
            if (await receipt.ExecuteScalarAsync(ct) is long existing) return new(true, "comment_report_duplicate", existing, true);
        }
        throw new PublicUnavailableException();
    }

    private static BusinessException Missing() => new(Rejection.NotFound, "This comment cannot be reported.");
}
