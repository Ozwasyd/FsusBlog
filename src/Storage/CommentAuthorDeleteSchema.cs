using System.Threading;
using System.Threading.Tasks;
using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly SchemaFacts CommentAuthorDeleteShape = new(
        Columns: [
            "comment_account_owner article_id:int4 comment_id:int8 user_id:uuid",
            "comment_author_delete_challenge digest:bytea article_id:int4 comment_id:int8 user_id:uuid session_digest:bytea generation:int8 comment_version:int8 expires_at:timestamptz",
            "comment_author_deleted article_id:int4 comment_id:int8 user_id:uuid comment_version:int8 moderation_status:int2 body_digest:bytea happened_at:timestamptz",
            "comment_author_delete_outbox article_id:int4 comment_id:int8 event_type:text"
        ],
        Constraints: [
            "comment_account_owner p article_id,comment_id",
            "comment_account_owner u comment_id",
            "comment_account_owner u article_id,comment_id,user_id",
            "comment_account_owner f user_id public.blog_user:id",
            "comment_account_owner f article_id,comment_id public.comment:article_id,id",
            "comment_author_delete_challenge p digest",
            "comment_author_delete_challenge c digest octet_length(digest)=32",
            "comment_author_delete_challenge c session_digest octet_length(session_digest)=32",
            "comment_author_delete_challenge c generation generation>0",
            "comment_author_delete_challenge c comment_version comment_version>0",
            "comment_author_delete_challenge u article_id,comment_id,session_digest",
            "comment_author_delete_challenge f article_id,comment_id,user_id public.comment_account_owner:article_id,comment_id,user_id",
            "comment_author_deleted p article_id,comment_id",
            "comment_author_deleted c comment_version comment_version>1",
            "comment_author_deleted c moderation_status moderation_status>=0ANDmoderation_status<=3",
            "comment_author_deleted c body_digest octet_length(body_digest)=32",
            "comment_author_deleted f article_id,comment_id,user_id public.comment_account_owner:article_id,comment_id,user_id",
            "comment_author_delete_outbox p article_id,comment_id",
            "comment_author_delete_outbox c event_type event_type='CommentDeleted'::text",
            "comment_author_delete_outbox f article_id,comment_id public.comment_author_deleted:article_id,comment_id"
        ]);

    private static readonly string[] CommentAuthorDeleteRelations =
        ["public.comment_account_owner", "public.comment_author_delete_challenge", "public.comment_author_deleted", "public.comment_author_delete_outbox"];

    internal static Task<bool> HasCommentAuthorDeleteSchemaAsync(NpgsqlConnection connection, NpgsqlTransaction transaction, CancellationToken ct) =>
        HasCompleteRelationsAsync(connection, transaction, ct, "Comment author deletion storage is incomplete.",
            CommentAuthorDeleteRelations);

    private static bool HasCommentAuthorDeleteSchema(CatalogPresenceSnapshot catalog) =>
        catalog.HasCompleteRelations("Comment author deletion storage is incomplete.", CommentAuthorDeleteRelations);
}
