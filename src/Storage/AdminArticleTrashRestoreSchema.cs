using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly SchemaFacts AdminArticleTrashRestoreShape = Tables(
        Table("admin_article_trash_restore principal_id:uuid command_id:uuid fingerprint:bytea article_id:int4 previous_revision:int8 revision:int8 happened_at:timestamptz=clock_timestamp",
            "p principal_id,command_id",
            "u article_id,revision",
            "f principal_id public.admin_principal:id",
            "f article_id,previous_revision public.article_revision:article_id,revision",
            "f article_id,revision public.article_revision:article_id,revision",
            "c fingerprint octet_length(fingerprint)=32",
            "c previous_revision,revision previous_revision=(revision-1)"),
        StepUpShape("admin_article_trash_step_up", "action=10"));

    private static readonly RelationGroup AdminArticleTrashRestoreRelations = new(
        "The administrator trash restore schema is incomplete.",
        "public.admin_article_trash_restore", "public.admin_article_trash_step_up");

    internal static Task<bool> HasAdminArticleTrashRestoreAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        AdminArticleTrashRestoreRelations.IsPresentAsync(db, tx, ct);
}
