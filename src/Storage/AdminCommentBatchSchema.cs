using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly SchemaFacts AdminCommentBatchShape = new(
        Columns: [
            "admin_comment_batch id:int8:a principal_id:uuid session_reference:bytea decision:int2 item_count:int4 decided_at:timestamptz",
            "admin_comment_batch_item batch_id:int8 moderation_id:int8",
            StepUpColumns("admin_comment_batch_step_up")
        ],
        Constraints: [
            "admin_comment_batch p id",
            "admin_comment_batch f principal_id public.admin_principal:id",
            "admin_comment_batch c session_reference octet_length(session_reference)=32",
            "admin_comment_batch c decision decision>=1ANDdecision<=2",
            "admin_comment_batch c item_count item_count>=2ANDitem_count<=20",
            "admin_comment_batch_item p batch_id,moderation_id",
            "admin_comment_batch_item u moderation_id",
            "admin_comment_batch_item f batch_id public.admin_comment_batch:id",
            "admin_comment_batch_item f moderation_id public.admin_comment_moderation:id",
            ..StepUpConstraints("admin_comment_batch_step_up", "action=6")
        ]);

    private static readonly RelationGroup AdminCommentBatchRelations = new(
        "Administrator comment batch storage is incomplete.",
        "public.admin_comment_batch", "public.admin_comment_batch_item", "public.admin_comment_batch_step_up");

    internal static Task<bool> HasAdminCommentBatchSchemaAsync(NpgsqlConnection connection, NpgsqlTransaction transaction,
        CancellationToken cancellationToken) =>
        AdminCommentBatchRelations.IsPresentAsync(connection, transaction, cancellationToken);
}
