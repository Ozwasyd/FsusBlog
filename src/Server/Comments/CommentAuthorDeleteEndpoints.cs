using System.Buffers.Text;
using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Sessions;
using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Server.Comments;

internal static class CommentAuthorDeleteEndpoints
{
    internal static void Map(WebApplication app, string cookie, Func<HttpContext, int, CancellationToken, Task<byte[]>> frame)
    {
        app.MapPost(WireRoutes.CommentAuthorEligibility, async (HttpContext ctx, Store store, int articleId, CancellationToken ct) =>
        {
            if (articleId <= 0) throw new ProtocolException("Invalid comment article.");
            var ids = Wire.DecodeCommentAuthorEligibilityRequest(await frame(ctx,
                WireHeader.HeaderSize + sizeof(int) + WireLimits.CommentAuthorBatchSize * sizeof(long), ct));
            return await Run(ctx, store, async (db, tx, actor, _) =>
            {
                var eligible = await ReadEligible(db, tx, actor.Id, articleId, ids, ct);
                if (await CurrentSchema.HasCommentAuthorEditSchemaAsync(db, tx, ct))
                    ctx.Response.Headers[WireHeaders.CommentAuthorEditEnabled] = "1";
                return Wire.EncodeCommentAuthorEligibility(eligible);
            }, ct);
        }).RequireRateLimiting("command");

        app.MapPost(WireRoutes.CommentAuthorChallenge, async (HttpContext ctx, Store store, long id, CancellationToken ct) =>
        {
            var purpose = Wire.ReadCommentAuthorChallengePurpose(await frame(ctx, WireLimits.CommentAuthorProofFrameBytes, ct),
                allowAppeal: true, allowEdit: true);
            return await Run(ctx, store, async (db, tx, actor, digest) =>
                Wire.EncodeCommentAuthorChallenge(purpose switch
                {
                    "appeal" => await CommentAppeals.Issue(db, tx, actor, digest, id, ct),
                    "edit" => await CommentAuthorEdits.Issue(db, tx, actor, digest, id, ct),
                    _ => await Issue(db, tx, actor, digest, id, ct)
                }), ct);
        }).RequireRateLimiting("comment-author-challenge");

        app.MapGet(WireRoutes.CommentAuthorEditDetail, (HttpContext ctx, Store store, long id, CancellationToken ct) =>
            Run(ctx, store, async (db, tx, actor, _) =>
                Wire.EncodeCommentAuthorEditDetail(await CommentAuthorEdits.Detail(db, tx, actor.Id, id, ct)), ct))
            .RequireRateLimiting("command");

        app.MapPost(WireRoutes.CommentAuthorEdit, async (HttpContext ctx, Store store, long id, CancellationToken ct) =>
        {
            var request = Wire.DecodeCommentAuthorEditRequest(await frame(ctx, WireLimits.CommentAuthorEditFrameBytes, ct));
            return await Run(ctx, store, async (db, tx, actor, digest) =>
                Wire.EncodeCommentAuthorMutation(await CommentAuthorEdits.Apply(db, tx, actor, digest, id, request, ct)), ct);
        }).RequireRateLimiting("command");

        app.MapGet(WireRoutes.CommentAuthorAppeals, (HttpContext ctx, Store store, CancellationToken ct) =>
            Run(ctx, store, (db, tx, actor, _) => CommentAppeals.ReadOwned(db, tx, actor.Id, ctx.Request.Query, ct), ct))
            .RequireRateLimiting("command");

        app.MapPost(WireRoutes.CommentAuthorAppeal, async (HttpContext ctx, Store store, long id, CancellationToken ct) =>
        {
            var request = Wire.DecodeAuthorAppeal(await frame(ctx, Wire.CommentAppealFrameBytes, ct));
            return await Run(ctx, store, async (db, tx, actor, digest) =>
            {
                await CommentAppeals.Submit(db, tx, actor, digest, id, request, ct);
                return Wire.EncodeCommentAuthorMutation(new(true, "ok", 0, 0, null));
            }, ct);
        }).RequireRateLimiting("command");

        app.MapPost(WireRoutes.CommentAuthorDelete, async (HttpContext ctx, Store store, long id, CancellationToken ct) =>
        {
            var secret = Wire.ReadCommentAuthorDeleteRequest(await frame(ctx, WireLimits.CommentAuthorProofFrameBytes, ct));
            return await Run(ctx, store, async (db, tx, actor, digest) =>
                Wire.EncodeCommentAuthorMutation(await Delete(db, tx, actor, digest, id, secret, ct)), ct);
        }).RequireRateLimiting("command");

        Task<IResult> Run(HttpContext ctx, Store store,
            Func<NpgsqlConnection, NpgsqlTransaction, Identity, byte[], Task<byte[]>> action, CancellationToken ct)
        {
            var token = ctx.Request.Cookies[cookie];
            var expected = ctx.Request.Headers[WireHeaders.CurrentSession] is { Count: 1 } header ? header[0] : null;
            return store.WithSession<IResult>(token, false, async (db, tx, actor) =>
            {
                var digest = Store.TokenDigest(token)!;
                SiteSessions.RequireCurrent(actor.Id, digest, expected);
                if (!await CurrentSchema.HasCommentAuthorDeleteSchemaAsync(db, tx, ct)) throw Missing();
                return Results.Bytes(await action(db, tx, actor, digest), Aeds.ContentType);
            }, ct);
        }
    }

    private static async Task<List<long>> ReadEligible(NpgsqlConnection db, NpgsqlTransaction tx, Guid owner, int article,
        long[] candidates, CancellationToken ct)
    {
        await using var query = Store.Sql(db, tx, """
            select c.id from public.comment_account_owner o join public.comment c on c.article_id=o.article_id and c.id=o.comment_id
            join public.article a on a.id=c.article_id and not a.deleted
            join public.article_publication p on p.article_id=a.id and p.revision=a.published_revision and p.published_at<=statement_timestamp()
            where o.user_id=$1 and c.article_id=$2 and c.id=any($3) and not c.deleted and c.moderation_status=1 and c.author_mode=3
                and not exists(select 1 from public.comment_blocked_region blocked where blocked.article_id=c.article_id and blocked.comment_id=c.id)
            order by c.id
            """, owner, article, candidates);
        var ids = new List<long>();
        await using var row = await query.ExecuteReaderAsync(ct);
        while (await row.ReadAsync(ct)) ids.Add(row.GetInt64(0));
        return ids;
    }

    private static async Task<CommentAuthorChallenge> Issue(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor,
        byte[] session, long id, CancellationToken ct)
    {
        var target = await LockOwned(db, tx, actor.Id, id, ct);
        var secret = RandomNumberGenerator.GetBytes(32);
        var proof = Base64Url.EncodeToString(secret);
        var digest = SHA256.HashData(secret);
        CryptographicOperations.ZeroMemory(secret);
        await using var issue = Store.Sql(db, tx, """
            insert into public.comment_author_delete_challenge(digest,article_id,comment_id,user_id,session_digest,generation,comment_version,expires_at)
            values($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+interval '5 minutes')
            on conflict (article_id,comment_id,session_digest) do update
            set digest=excluded.digest,generation=excluded.generation,comment_version=excluded.comment_version,expires_at=excluded.expires_at
            returning expires_at
            """, digest, target.Article, id, actor.Id, session, actor.Generation, target.Version);
        var expires = (DateTime)(await issue.ExecuteScalarAsync(ct))!;
        await Prune(db, tx, ct);
        return new(true, proof, expires, null, target.Version);
    }

    private static async Task<CommentAuthorMutation> Delete(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor,
        byte[] session, long id, string proof, CancellationToken ct)
    {
        var secret = new byte[32];
        if (!Base64Url.TryDecodeFromChars(proof, secret, out var written) || written != secret.Length || Base64Url.EncodeToString(secret) != proof)
            throw Missing();
        var digest = SHA256.HashData(secret);
        CryptographicOperations.ZeroMemory(secret);
        var target = await LockOwned(db, tx, actor.Id, id, ct);
        await using (var challenge = Store.Sql(db, tx, """
            delete from public.comment_author_delete_challenge
            where digest=$1 and article_id=$2 and comment_id=$3 and user_id=$4 and session_digest=$5 and generation=$6 and expires_at>clock_timestamp()
            returning comment_version
            """, digest, target.Article, id, actor.Id, session, actor.Generation))
        {
            if (await challenge.ExecuteScalarAsync(ct) is not long version) throw Missing();
            if (version != target.Version) throw Stale();
        }

        await using var apply = Store.Sql(db, tx, """
            with changed as (
                update public.comment set deleted=true,moderation_version=moderation_version+1
                where article_id=$1 and id=$2 and moderation_version=$3 and not deleted
                returning article_id,id,moderation_version,moderation_status,edited_at,pg_catalog.sha256(convert_to(body,'UTF8')) as body_digest
            ), revision as (
                insert into public.comment_author_deleted(article_id,comment_id,user_id,comment_version,moderation_status,body_digest,happened_at)
                select article_id,id,$4,moderation_version,moderation_status,body_digest,statement_timestamp() from changed
                returning article_id,comment_id
            ), outbox as (
                insert into public.comment_author_delete_outbox(article_id,comment_id,event_type)
                select article_id,comment_id,'CommentDeleted' from revision returning comment_id
            )
            select c.moderation_version,c.moderation_status,c.edited_at from changed c join outbox x on x.comment_id=c.id
            """, target.Article, id, target.Version, actor.Id);
        await using var result = await apply.ExecuteReaderAsync(ct);
        if (!await result.ReadAsync(ct)) throw Stale();
        return new(true, "ok", result.GetInt64(0), result.GetInt16(1), result.IsDBNull(2) ? null : result.GetDateTime(2));
    }

    private static async Task<(int Article, long Version)> LockOwned(NpgsqlConnection db, NpgsqlTransaction tx, Guid owner, long id,
        CancellationToken ct)
    {
        if (id <= 0) throw Missing();
        await using var query = Store.Sql(db, tx, """
            select c.article_id,c.moderation_version from public.comment_account_owner o
            join public.comment c on c.article_id=o.article_id and c.id=o.comment_id
            where o.user_id=$1 and c.id=$2 and not c.deleted and c.author_mode=3 for update of c
            """, owner, id);
        await using var row = await query.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct)) throw Missing();
        return (row.GetInt32(0), row.GetInt64(1));
    }

    private static async Task Prune(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        await using var cleanup = Store.Sql(db, tx, """
            delete from public.comment_author_delete_challenge where digest in (
                select digest from public.comment_author_delete_challenge where expires_at<=clock_timestamp()
                order by expires_at limit 64 for update skip locked
            )
            """);
        await cleanup.ExecuteNonQueryAsync(ct);
    }

    private static BusinessException Missing() => new(Rejection.NotFound, "comment_management_not_found");
    private static BusinessException Stale() => new(Rejection.Conflict, "comment_version_conflict");
}
