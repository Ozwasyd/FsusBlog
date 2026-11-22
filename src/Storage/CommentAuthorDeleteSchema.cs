using System.Threading;
using System.Threading.Tasks;
using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly SchemaFacts CommentAuthorDeleteShape = Tables(
        Table("comment_account_owner article_id:int4 comment_id:int8 user_id:uuid",
            "p article_id,comment_id",
            "u comment_id",
            "u article_id,comment_id,user_id",
            "f user_id public.blog_user:id",
            "f article_id,comment_id public.comment:article_id,id"),
        Table("comment_author_delete_challenge digest:bytea article_id:int4 comment_id:int8 user_id:uuid session_digest:bytea generation:int8 comment_version:int8 expires_at:timestamptz",
            "p digest",
            "c digest octet_length(digest)=32",
            "c session_digest octet_length(session_digest)=32",
            "c generation generation>0",
            "c comment_version comment_version>0",
            "u article_id,comment_id,session_digest",
            "f article_id,comment_id,user_id public.comment_account_owner:article_id,comment_id,user_id"),
        Table("comment_author_deleted article_id:int4 comment_id:int8 user_id:uuid comment_version:int8 moderation_status:int2 body_digest:bytea happened_at:timestamptz",
            "p article_id,comment_id",
            "c comment_version comment_version>1",
            "c moderation_status moderation_status>=0ANDmoderation_status<=3",
            "c body_digest octet_length(body_digest)=32",
            "f article_id,comment_id,user_id public.comment_account_owner:article_id,comment_id,user_id"),
        Table("comment_author_delete_outbox article_id:int4 comment_id:int8 event_type:text",
            "p article_id,comment_id",
            "c event_type event_type='CommentDeleted'::text",
            "f article_id,comment_id public.comment_author_deleted:article_id,comment_id"));

    private static readonly RelationGroup CommentAuthorDeleteRelations = new(
        "Comment author deletion storage is incomplete.",
        "public.comment_account_owner", "public.comment_author_delete_challenge", "public.comment_author_deleted", "public.comment_author_delete_outbox");

    internal static Task<bool> HasCommentAuthorDeleteSchemaAsync(NpgsqlConnection connection, NpgsqlTransaction transaction, CancellationToken ct) =>
        CommentAuthorDeleteRelations.IsPresentAsync(connection, transaction, ct);
}
