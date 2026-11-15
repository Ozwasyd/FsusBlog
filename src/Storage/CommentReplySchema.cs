using System.Threading;
using System.Threading.Tasks;
using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly string[] CommentReplyColumns =
    [
        "comment_reply_notice article_id:int4 reply_id:int8 recipient_id:uuid conversation_id:int8 message_id:int8 moderation_version:int8 delivered_at:timestamptz"
    ];

    private static readonly string[] CommentReplyConstraints =
    [
        "comment_reply_notice p article_id,reply_id",
        "comment_reply_notice u conversation_id",
        "comment_reply_notice c moderation_version moderation_version>1",
        "comment_reply_notice f article_id,reply_id public.comment_account_owner:article_id,comment_id",
        "comment_reply_notice f recipient_id,conversation_id public.inbox_conversation:account_id,id",
        "comment_reply_notice f conversation_id,message_id public.inbox_message:conversation_id,id"
    ];

    internal static async Task<bool> HasCommentReplySchemaAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        await using var relation = new NpgsqlCommand("select pg_catalog.to_regclass('public.comment_reply_notice') is not null", db, tx);
        return await relation.ExecuteScalarAsync(ct) is true;
    }
}
