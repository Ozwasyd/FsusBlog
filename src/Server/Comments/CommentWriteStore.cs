using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Server.Comments;

internal static class CommentWriteStore
{
    internal static async Task<PublicCommentEligibility> Eligibility(NpgsqlConnection db, NpgsqlTransaction tx,
        Identity actor, int articleId, long publication, CancellationToken ct)
    {
        var name = await SqlCommands.Scalar(db, tx, ct, """
            select h.display_name
            from public.article a
            join public.article_publication p on p.article_id=a.id and p.revision=a.published_revision
            join public.comment_public_write w on w.article_id=a.id
            join public.comment_public_handle h on h.user_id=$3
            where a.id=$1 and not a.deleted and p.publication_id=$2 and p.published_at<=statement_timestamp()
            for share of a,p,w,h
            """, articleId, publication, actor.Id) as string ??
            throw new BusinessException(Rejection.Forbidden, "Public comment submission is unavailable for this publication.");
        return new(articleId, publication, name);
    }

    internal static async Task<PublicCommentSubmissionResult> Submit(NpgsqlConnection db, NpgsqlTransaction tx,
        Identity actor, PublicCommentSubmission input, CancellationToken ct, long? parent = null)
    {
        input = input with { Body = Normalize(input.Body) };
        var hash = Fingerprint(input, parent);
        await Store.LockCommand(db, tx, actor.Id, input.IdempotencyKey, ct);
        await using (var replay = Store.Sql(db, tx, """
            select c.fingerprint,c.article_id,c.comment_id,p.moderation_status
            from public.comment_submit_command c
            join public.comment p on p.article_id=c.article_id and p.id=c.comment_id
            where c.user_id=$1 and c.command_id=$2
            """, actor.Id, input.IdempotencyKey))
        await using (var row = await replay.ExecuteReaderAsync(ct))
        {
            if (await row.ReadAsync(ct))
            {
                if (!CryptographicOperations.FixedTimeEquals(hash, row.GetFieldValue<byte[]>(0)))
                    throw new BusinessException(Rejection.Conflict, "The comment key was used for a different submission.");
                return new(row.GetInt32(1), row.GetInt64(2), row.GetInt16(3), true);
            }
        }

        var eligible = await Eligibility(db, tx, actor, input.ArticleId, input.Publication, ct);
        if (!string.Equals(eligible.DisplayName, input.DisplayName, StringComparison.Ordinal))
            throw new BusinessException(Rejection.Conflict, "The public display name changed. Reload and confirm it before sending.");

        var target = parent is long predecessor ? await CommentReplies.LockParent(db, tx, input.ArticleId, predecessor, ct) : null;
        await using var insert = parent is null ? Store.Sql(db, tx, """
                with identity as (select nextval(pg_get_serial_sequence('public.comment','id')) as id),
                new_comment as (
                    insert into public.comment(article_id,id,root_id,depth,moderation_status,deleted,body,author_mode,
                        display_name,display_language,created_at)
                    select $1,id,id,0,0,false,$2,3,$3,'zh-CN',statement_timestamp() from identity returning id
                )
                insert into public.comment_submit_command(user_id,command_id,fingerprint,article_id,comment_id)
                select $4,$5,$6,$1,id from new_comment returning comment_id
                """, input.ArticleId, input.Body, eligible.DisplayName, actor.Id, input.IdempotencyKey, hash)
            : Store.Sql(db, tx, """
                with new_comment as (
                    insert into public.comment(article_id,root_id,parent_id,parent_depth,reply_to_id,depth,
                        moderation_status,deleted,body,author_mode,display_name,display_language,created_at)
                    values ($1,$7,$8,$9,$8,$9+1,0,false,$2,3,$3,'zh-CN',statement_timestamp())
                    returning id
                )
                insert into public.comment_submit_command(user_id,command_id,fingerprint,article_id,comment_id)
                select $4,$5,$6,$1,id from new_comment returning comment_id
                """, input.ArticleId, input.Body, eligible.DisplayName, actor.Id, input.IdempotencyKey, hash,
                target!.Root, parent.Value, target.Depth);
        var id = (long)(await insert.ExecuteScalarAsync(ct))!;
        if (await CurrentSchema.HasCommentAuthorDeleteSchemaAsync(db, tx, ct))
        {
            await SqlCommands.Execute(db, tx, ct, """
                insert into public.comment_account_owner(article_id,comment_id,user_id) values($1,$2,$3)
                """, input.ArticleId, id, actor.Id);
        }
        return new(input.ArticleId, id, 0, false);
    }

    internal static async Task AdmitChallenge(NpgsqlConnection db, NpgsqlTransaction tx,
        Identity actor, PublicCommentSubmission input, CancellationToken ct, long? parent = null)
    {
        // A response lost after commit can obtain a fresh proof for the original mutation,
        // even if publication is closed before the client receives its durable receipt.
        var normalized = input with { Body = Normalize(input.Body) };
        if (await SqlCommands.Scalar(db, tx, ct, """
            select fingerprint from public.comment_submit_command where user_id=$1 and command_id=$2
            """, actor.Id, input.IdempotencyKey) is byte[] fingerprint)
        {
            if (!CryptographicOperations.FixedTimeEquals(fingerprint, Fingerprint(normalized, parent)))
                throw new BusinessException(Rejection.Conflict, "The comment key was used for a different submission.");
            return;
        }
        var eligible = await Eligibility(db, tx, actor, input.ArticleId, input.Publication, ct);
        if (!string.Equals(eligible.DisplayName, input.DisplayName, StringComparison.Ordinal))
            throw new BusinessException(Rejection.Conflict, "The public display name changed. Reload and confirm it before sending.");
        if (parent is long predecessor) await CommentReplies.LockParent(db, tx, input.ArticleId, predecessor, ct);
    }

    private static byte[] Fingerprint(PublicCommentSubmission input, long? parent) =>
        SHA256.HashData(parent is long predecessor ? Wire.EncodePublicCommentReply(new(input.ArticleId, input.Publication,
            predecessor, input.DisplayName, input.Body, input.IdempotencyKey, input.ExplicitPublic)) : Wire.EncodePublicCommentSubmission(input));

    internal static string Normalize(string raw)
    {
        var text = raw.Trim().ReplaceLineEndings("\n");
        if (text.Length is 0 or > 1000 || Encoding.UTF8.GetByteCount(text) > WireLimits.PublicCommentBodyBytes ||
            text.Any(ch => char.IsControl(ch) && ch is not ('\r' or '\n' or '\t')))
            throw new BusinessException(Rejection.Invalid, "Public comment text exceeds its allowed length or contains control characters.");
        return text;
    }
}
