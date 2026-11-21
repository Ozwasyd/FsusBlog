using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static string[] GetAdminArticleRollbackColumns(bool draft, bool archive, bool trash) =>
    [
        "article_revision_responsibility id:int8:a article_id:int4 revision:int8 responsible_party:text basis:text reference:text recorded_by:text recorded_at:timestamptz=clock_timestamp source_snapshot_id:int8?",
        "article_publication_responsibility publication_id:int8 article_id:int4 revision:int8 snapshot_id:int8",
        "admin_article_rollback principal_id:uuid command_id:uuid fingerprint:bytea article_id:int4 previous_revision:int8 source_revision:int8 revision:int8 source_publication_id:int8 previous_publication_id:int8 publication_id:int8 publication_no:int4 published_at:timestamptz rights_snapshot_id:int8 responsibility_snapshot_id:int8 reason:text"
            + (draft ? " destination:int4=2" : "") + (archive ? " from_archive:bool=false" : "")
            + (trash ? " from_trash:bool=false" : ""),
        StepUpColumns("admin_article_rollback_step_up")
    ];

    private static string[] GetAdminArticleRollbackConstraints(bool draft, bool archive, bool trash) =>
    [
        "article_revision_responsibility p id",
        "article_revision_responsibility u article_id,revision",
        "article_revision_responsibility u article_id,id",
        "article_revision_responsibility u article_id,revision,id",
        "article_revision_responsibility f article_id,revision public.article_revision:article_id,revision",
        "article_revision_responsibility f article_id,source_snapshot_id public.article_revision_responsibility:article_id,id",
        "article_revision_responsibility c id id>0",
        "article_revision_responsibility c responsible_party octet_length(responsible_party)>=1ANDoctet_length(responsible_party)<=256",
        "article_revision_responsibility c basis octet_length(basis)>=1ANDoctet_length(basis)<=4000",
        "article_revision_responsibility c reference octet_length(reference)>=1ANDoctet_length(reference)<=1000",
        "article_revision_responsibility c recorded_by octet_length(recorded_by)>=1ANDoctet_length(recorded_by)<=255",
        "article_revision_responsibility c source_snapshot_id,id source_snapshot_idISDISTINCTFROMid",
        "article_publication_responsibility p publication_id",
        "article_publication_responsibility u article_id,revision",
        "article_publication_responsibility c publication_id publication_id>0",
        "article_publication_responsibility f article_id,revision,snapshot_id public.article_revision_responsibility:article_id,revision,id",
        "admin_article_rollback p principal_id,command_id",
        "admin_article_rollback u article_id,revision",
        "admin_article_rollback u publication_id",
        "admin_article_rollback f principal_id public.admin_principal:id",
        "admin_article_rollback f article_id,previous_revision public.article_revision:article_id,revision",
        "admin_article_rollback f article_id,source_revision public.article_revision:article_id,revision",
        "admin_article_rollback f article_id,revision public.article_revision:article_id,revision",
        "admin_article_rollback f rights_snapshot_id public.article_publication_rights:id",
        "admin_article_rollback f responsibility_snapshot_id public.article_revision_responsibility:id",
        "admin_article_rollback c fingerprint octet_length(fingerprint)=32",
        "admin_article_rollback c source_publication_id source_publication_id>0",
        "admin_article_rollback c previous_publication_id previous_publication_id>0",
        "admin_article_rollback c publication_id publication_id>0",
        "admin_article_rollback c publication_no publication_no>0",
        "admin_article_rollback c reason char_length(reason)>=8ANDchar_length(reason)<=500",
        "admin_article_rollback c previous_revision,revision,source_revision previous_revision=(revision-1)ANDsource_revision<previous_revision",
        ..(archive ? new[] {
            "admin_article_rollback c destination destination=ANY(ARRAY[0,2,3])",
            "admin_article_rollback c from_archive,destination NOTfrom_archiveORdestination=2"
        } : draft ? ["admin_article_rollback c destination destination=ANY(ARRAY[0,2])"] : []),
        ..(trash ? new[] {
            "admin_article_rollback c from_trash,destination NOTfrom_trashORdestination=2",
            "admin_article_rollback c from_trash,from_archive NOTfrom_trashORNOTfrom_archive"
        } : []),
        ..StepUpConstraints("admin_article_rollback_step_up", trash ? "action=ANY(ARRAY[3,7,8,11])" :
            archive ? "action=ANY(ARRAY[3,7,8])" : draft ? "action=ANY(ARRAY[3,7])" : "action=3")
    ];

    private const string AdminArticleRollbackRelation = "public.admin_article_rollback";
    private static readonly string[] AdminArticleRollbackRelations =
    [
        "public.article_revision_responsibility",
        "public.article_publication_responsibility",
        AdminArticleRollbackRelation,
        "public.admin_article_rollback_step_up"
    ];

    internal static async Task<bool> HasAdminArticleRollbackSchemaAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        await using var command = new NpgsqlCommand("""
            select num_nonnulls(pg_catalog.to_regclass('public.article_revision_responsibility'),
                pg_catalog.to_regclass('public.article_publication_responsibility'),
                pg_catalog.to_regclass('public.admin_article_rollback'),
                pg_catalog.to_regclass('public.admin_article_rollback_step_up')) + (
                    select count(*)::integer
                    from pg_catalog.pg_attribute
                    where attrelid=pg_catalog.to_regclass('public.article_publication_history')
                      and attname in ('admin_actor_id','admin_command_id') and attnum>0 and not attisdropped)
            """, db, tx);
        return Complete(await command.ExecuteScalarAsync(ct), 6,
            "The administrator article rollback schema is partially installed.");
    }

    private static bool HasAdminArticleRollbackSchema(CatalogPresenceSnapshot catalog)
    {
        var found = catalog.CountRelations(AdminArticleRollbackRelations)
            + (catalog.HasColumn(PublicationHistoryRelation, "admin_actor_id") ? 1 : 0)
            + (catalog.HasColumn(PublicationHistoryRelation, "admin_command_id") ? 1 : 0);
        return Complete(found, 6, "The administrator article rollback schema is partially installed.");
    }

    internal static async Task<bool> HasAdminArticleDraftRollbackSchemaAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
        => await HasRollbackColumn(db, tx, "destination", ct);

    private static bool HasAdminArticleDraftRollbackSchema(CatalogPresenceSnapshot catalog) =>
        catalog.HasColumn(AdminArticleRollbackRelation, "destination");

    internal static async Task<bool> HasAdminArticleArchiveSchemaAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
        => await HasRollbackColumn(db, tx, "from_archive", ct);

    private static bool HasAdminArticleArchiveSchema(CatalogPresenceSnapshot catalog) =>
        catalog.HasColumn(AdminArticleRollbackRelation, "from_archive");

    internal static Task<bool> HasAdminArticleTrashPublicationSchemaAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        HasRollbackColumn(db, tx, "from_trash", ct);

    private static bool HasAdminArticleTrashPublicationSchema(CatalogPresenceSnapshot catalog) =>
        catalog.HasColumn(AdminArticleRollbackRelation, "from_trash");

    private static async Task<bool> HasRollbackColumn(NpgsqlConnection db, NpgsqlTransaction tx, string column, CancellationToken ct)
    {
        await using var command = new NpgsqlCommand("""
            select exists (
                select from pg_catalog.pg_attribute
                where attrelid=pg_catalog.to_regclass('public.admin_article_rollback')
                  and attname=$1 and attnum>0 and not attisdropped
            )
            """, db, tx);
        command.Parameters.AddWithValue(column);
        return await command.ExecuteScalarAsync(ct) is true;
    }
}
