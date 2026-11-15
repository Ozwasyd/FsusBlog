using System;
using System.Threading;
using System.Threading.Tasks;
using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private const string LegacyCommentAuthorEditStatus = "previous_status=1";
    private const string PendingCommentAuthorEditStatus = "previous_status>=0ANDprevious_status<=1";

    private static readonly string[] CommentAuthorEditColumns =
    [
        "comment_author_edit_challenge digest:bytea article_id:int4 comment_id:int8 user_id:uuid session_digest:bytea generation:int8 comment_version:int8 publication_id:int8 expires_at:timestamptz",
        "comment_author_edited article_id:int4 comment_id:int8 user_id:uuid comment_version:int8 previous_version:int8 previous_status:int2 moderation_status:int2 previous_body:text body:text previous_body_digest:bytea body_digest:bytea happened_at:timestamptz",
        "comment_author_edit_outbox article_id:int4 comment_id:int8 comment_version:int8 event_type:text"
    ];

    private static readonly string[] CommentAuthorEditConstraints =
    [
        "comment_author_edit_challenge p digest",
        "comment_author_edit_challenge c digest octet_length(digest)=32",
        "comment_author_edit_challenge c session_digest octet_length(session_digest)=32",
        "comment_author_edit_challenge c generation generation>0",
        "comment_author_edit_challenge c comment_version comment_version>0",
        "comment_author_edit_challenge c publication_id publication_id>0",
        "comment_author_edit_challenge u article_id,comment_id,session_digest",
        "comment_author_edit_challenge f article_id,comment_id,user_id public.comment_account_owner:article_id,comment_id,user_id",
        "comment_author_edited p article_id,comment_id,comment_version",
        "comment_author_edited f article_id,comment_id,user_id public.comment_account_owner:article_id,comment_id,user_id",
        "comment_author_edited c previous_version previous_version>0",
        "comment_author_edited c moderation_status moderation_status=0",
        "comment_author_edited c previous_body octet_length(previous_body)<=12288",
        "comment_author_edited c body octet_length(body)>=1ANDoctet_length(body)<=4096",
        "comment_author_edited c previous_body_digest octet_length(previous_body_digest)=32",
        "comment_author_edited c body_digest octet_length(body_digest)=32",
        "comment_author_edited c comment_version,previous_version comment_version=(previous_version+1)",
        "comment_author_edit_outbox p article_id,comment_id,comment_version",
        "comment_author_edit_outbox c event_type event_type='CommentEdited'::text",
        "comment_author_edit_outbox f article_id,comment_id,comment_version public.comment_author_edited:article_id,comment_id,comment_version"
    ];

    internal static Task<bool> HasCommentAuthorEditSchemaAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        HasCompleteRelationsAsync(db, tx, ct, "Comment author edit storage is incomplete.",
            "public.comment_author_edit_challenge", "public.comment_author_edited", "public.comment_author_edit_outbox");

    internal static async Task<bool> SupportsPendingCommentAuthorEditAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        await ReadCommentAuthorEditStatusAsync(db, tx, ct) == PendingCommentAuthorEditStatus;

    private static async Task<string[]> ReadCommentAuthorEditConstraintsAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        var status = await ReadCommentAuthorEditStatusAsync(db, tx, ct);
        if (status is not (LegacyCommentAuthorEditStatus or PendingCommentAuthorEditStatus))
            throw new InvalidOperationException("FsusBlog V2 constraint shape mismatch. Comment author edit previous status is invalid.");
        return [.. CommentAuthorEditConstraints, "comment_author_edited c previous_status " + status];
    }

    private static async Task<string?> ReadCommentAuthorEditStatusAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        await using var command = new NpgsqlCommand("""
            select pg_catalog.regexp_replace(pg_catalog.pg_get_expr(k.conbin,k.conrelid,true),'[[:space:]]','','g')
            from pg_catalog.pg_constraint k
            where k.conrelid=pg_catalog.to_regclass('public.comment_author_edited') and k.contype='c'
                and k.conname='comment_author_edited_previous_status_check' and k.convalidated and k.conislocal
                and not k.condeferrable and not k.connoinherit and coalesce(pg_catalog.to_jsonb(k)->>'conenforced','true')='true'
            """, db, tx);
        return await command.ExecuteScalarAsync(ct) as string;
    }
}
