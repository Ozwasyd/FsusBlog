using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly SchemaFacts CommentReplyShape = Table(
        "comment_reply_notice article_id:int4 reply_id:int8 recipient_id:uuid conversation_id:int8 message_id:int8 moderation_version:int8 delivered_at:timestamptz",
        "p article_id,reply_id",
        "u conversation_id",
        "c moderation_version moderation_version>1",
        "f article_id,reply_id public.comment_account_owner:article_id,comment_id",
        "f recipient_id,conversation_id public.inbox_conversation:account_id,id",
        "f conversation_id,message_id public.inbox_message:conversation_id,id");

    private const string CommentReplyRelation = "public.comment_reply_notice";

    internal static Task<bool> HasCommentReplySchemaAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        HasRelationAsync(db, tx, CommentReplyRelation, ct);
}
