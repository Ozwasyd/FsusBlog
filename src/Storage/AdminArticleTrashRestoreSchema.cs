using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly SchemaFacts AdminArticleTrashRestoreShape = new(
        Columns: [
            "admin_article_trash_restore principal_id:uuid command_id:uuid fingerprint:bytea article_id:int4 previous_revision:int8 revision:int8 happened_at:timestamptz=clock_timestamp",
            StepUpColumns("admin_article_trash_step_up")
        ],
        Constraints: [
            "admin_article_trash_restore p principal_id,command_id",
            "admin_article_trash_restore u article_id,revision",
            "admin_article_trash_restore f principal_id public.admin_principal:id",
            "admin_article_trash_restore f article_id,previous_revision public.article_revision:article_id,revision",
            "admin_article_trash_restore f article_id,revision public.article_revision:article_id,revision",
            "admin_article_trash_restore c fingerprint octet_length(fingerprint)=32",
            "admin_article_trash_restore c previous_revision,revision previous_revision=(revision-1)",
            ..StepUpConstraints("admin_article_trash_step_up", "action=10")
        ]);

    private static readonly string[] AdminArticleTrashRestoreRelations =
        ["public.admin_article_trash_restore", "public.admin_article_trash_step_up"];

    internal static Task<bool> HasAdminArticleTrashRestoreAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        HasCompleteRelationsAsync(db, tx, ct, "The administrator trash restore schema is incomplete.",
            AdminArticleTrashRestoreRelations);

    private static bool HasAdminArticleTrashRestore(CatalogPresenceSnapshot catalog) =>
        catalog.HasCompleteRelations("The administrator trash restore schema is incomplete.", AdminArticleTrashRestoreRelations);
}
