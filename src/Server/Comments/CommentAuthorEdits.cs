using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Server.Comments;

internal static class CommentAuthorEdits
{
    private sealed record Target(int Article, long Publication, long Version, short ModerationStatus, string Body);

    internal static async Task<CommentAuthorEditDetail> Detail(NpgsqlConnection db, NpgsqlTransaction tx, Guid owner, long id,
        CancellationToken ct, bool pendingOnly = false)
    {
        var target = await Find(db, tx, owner, id, locking: false, ct);
        if (pendingOnly && target.ModerationStatus != 0) throw Missing();
        await RequireEditable(db, tx, target, ct);
        return new(target.Article, target.Publication, target.Version, target.Body);
    }

    internal static async Task<CommentAuthorChallenge> Issue(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor,
        byte[] session, long id, CancellationToken ct)
    {
        var target = await Find(db, tx, actor.Id, id, locking: true, ct);
        await RequireEditable(db, tx, target, ct);
        var (proof, digest) = CommentAuthorProof.Issue();
        await using var issue = Store.Sql(db, tx, """
            insert into public.comment_author_edit_challenge
                (digest,article_id,comment_id,user_id,session_digest,generation,comment_version,publication_id,expires_at)
            values($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()+interval '5 minutes')
            on conflict (article_id,comment_id,session_digest) do update set digest=excluded.digest,
                generation=excluded.generation,comment_version=excluded.comment_version,
                publication_id=excluded.publication_id,expires_at=excluded.expires_at
            returning expires_at
            """, digest, target.Article, id, actor.Id, session, actor.Generation, target.Version, target.Publication);
        var expires = (DateTime)(await issue.ExecuteScalarAsync(ct))!;
        await using var prune = Store.Sql(db, tx, """
            delete from public.comment_author_edit_challenge where digest in (
                select digest from public.comment_author_edit_challenge where expires_at<=clock_timestamp()
                order by expires_at limit 64 for update skip locked)
            """);
        await prune.ExecuteNonQueryAsync(ct);
        return new(true, proof, expires, null, target.Version);
    }

    internal static async Task<CommentAuthorMutation> Apply(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor,
        byte[] session, long id, CommentAuthorEditRequest request, CancellationToken ct)
    {
        var body = CommentWriteStore.Normalize(request.Content);
        var digest = CommentAuthorProof.Digest(request.Challenge) ?? throw Missing();
        var target = await Find(db, tx, actor.Id, id, locking: true, ct);
        await using (var challenge = Store.Sql(db, tx, """
            delete from public.comment_author_edit_challenge
            where digest=$1 and article_id=$2 and comment_id=$3 and user_id=$4 and session_digest=$5
                and generation=$6 and expires_at>clock_timestamp()
            returning comment_version,publication_id
            """, digest, target.Article, id, actor.Id, session, actor.Generation))
        await using (var row = await challenge.ExecuteReaderAsync(ct))
        {
            if (!await row.ReadAsync(ct)) throw Missing();
            if (row.GetInt64(0) != request.ExpectedVersion || target.Version != request.ExpectedVersion ||
                row.GetInt64(1) != target.Publication) throw Stale();
        }
        await RequireEditable(db, tx, target, ct);
        if (string.Equals(body, target.Body, StringComparison.Ordinal))
            throw new BusinessException(Rejection.Invalid, "The edited comment matches its current text.");

        await using var update = Store.Sql(db, tx, """
            with changed as (
                update public.comment c set body=$4,edited_at=clock_timestamp(),moderation_status=0,
                    moderation_version=c.moderation_version+1
                where c.article_id=$1 and c.id=$2 and c.moderation_version=$3 and c.moderation_status=$8 and not c.deleted
                    and c.created_at+$7*interval '1 minute'>=clock_timestamp()
                    and not exists(select 1 from public.comment_blocked_region b where b.article_id=$1 and b.comment_id=$2)
                returning article_id,id,moderation_version,body,edited_at
            ), revision as (
                insert into public.comment_author_edited
                    (article_id,comment_id,user_id,comment_version,previous_version,previous_status,moderation_status,
                     previous_body,body,previous_body_digest,body_digest,happened_at)
                select article_id,id,$5,moderation_version,$3,$8,0,$6,body,pg_catalog.sha256(convert_to($6,'UTF8')),
                    pg_catalog.sha256(convert_to(body,'UTF8')),edited_at from changed
                returning article_id,comment_id,comment_version
            ), outbox as (
                insert into public.comment_author_edit_outbox(article_id,comment_id,comment_version,event_type)
                select article_id,comment_id,comment_version,'CommentEdited' from revision returning comment_id
            )
            select changed.moderation_version,changed.edited_at from changed join outbox on outbox.comment_id=changed.id
            """, target.Article, id, target.Version, body, actor.Id, target.Body, WireLimits.CommentAuthorEditWindowMinutes,
            target.ModerationStatus);
        await using var result = await update.ExecuteReaderAsync(ct);
        if (!await result.ReadAsync(ct)) throw Stale();
        return new(true, "ok", result.GetInt64(0), 0, result.GetDateTime(1));
    }

    private static async Task<Target> Find(NpgsqlConnection db, NpgsqlTransaction tx, Guid owner, long id, bool locking,
        CancellationToken ct)
    {
        if (id <= 0 || !await CurrentSchema.HasCommentAuthorEditSchemaAsync(db, tx, ct)) throw Missing();
        await using var query = Store.Sql(db, tx, """
            select c.article_id,p.publication_id,c.moderation_version,c.moderation_status,c.body
            from public.comment_account_owner o join public.comment c on c.article_id=o.article_id and c.id=o.comment_id
            join public.article a on a.id=c.article_id and not a.deleted
            join public.article_publication p on p.article_id=a.id and p.revision=a.published_revision
                and p.published_at<=statement_timestamp()
            join public.article_publication_rights snapshot on snapshot.article_id=a.id and snapshot.revision=p.revision
                and snapshot.publication_id=p.publication_id
            join public.article_revision_rights rights on rights.article_id=a.id and rights.revision=snapshot.revision
            where o.user_id=$1 and c.id=$2 and c.author_mode=3 and not c.deleted
                and c.created_at+$3*interval '1 minute'>=clock_timestamp()
                and not exists(select 1 from public.comment_blocked_region b where b.article_id=c.article_id and b.comment_id=c.id)
            """ + (locking ? " for update of c for share of a,p,snapshot,rights" : ""), owner, id, WireLimits.CommentAuthorEditWindowMinutes);
        await using var row = await query.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct)) throw Missing();
        return new(row.GetInt32(0), row.GetInt64(1), row.GetInt64(2), row.GetInt16(3), row.GetString(4));
    }

    private static async Task RequireEditable(NpgsqlConnection db, NpgsqlTransaction tx, Target target, CancellationToken ct)
    {
        if (target.ModerationStatus == 1 ||
            target.ModerationStatus == 0 && await CurrentSchema.SupportsPendingCommentAuthorEditAsync(db, tx, ct)) return;
        throw Missing();
    }

    private static BusinessException Missing() => new(Rejection.NotFound, "comment_management_not_found");
    private static BusinessException Stale() => new(Rejection.Conflict, "comment_version_conflict");
}
