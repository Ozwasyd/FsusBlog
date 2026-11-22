using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly SchemaFacts AdminCommentBatchShape = Tables(
        Table("admin_comment_batch id:int8:a principal_id:uuid session_reference:bytea decision:int2 item_count:int4 decided_at:timestamptz",
            "p id",
            "f principal_id public.admin_principal:id",
            "c session_reference octet_length(session_reference)=32",
            "c decision decision>=1ANDdecision<=2",
            "c item_count item_count>=2ANDitem_count<=20"),
        Table("admin_comment_batch_item batch_id:int8 moderation_id:int8",
            "p batch_id,moderation_id",
            "u moderation_id",
            "f batch_id public.admin_comment_batch:id",
            "f moderation_id public.admin_comment_moderation:id"),
        StepUpShape("admin_comment_batch_step_up", "action=6"));

    private static readonly RelationGroup AdminCommentBatchRelations = new(
        "Administrator comment batch storage is incomplete.",
        "public.admin_comment_batch", "public.admin_comment_batch_item", "public.admin_comment_batch_step_up");

    internal static Task<bool> HasAdminCommentBatchSchemaAsync(NpgsqlConnection connection, NpgsqlTransaction transaction,
        CancellationToken cancellationToken) =>
        AdminCommentBatchRelations.IsPresentAsync(connection, transaction, cancellationToken);
}
