using System;
using System.Threading;
using System.Threading.Tasks;
using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly SchemaFacts AdminTagMetadataShape = new(
        Columns: [
            "taxonomy_epoch singleton:bool revision:int8",
            "admin_tag_metadata_command principal_id:uuid request_id:uuid tag_id:int4 revision:int8 old_name:text old_description:text name:text description:text changed:bool fingerprint:bytea session_reference:bytea happened_at:timestamptz"
        ],
        Constraints: [
            "taxonomy_epoch p singleton",
            "taxonomy_epoch c singleton singleton",
            "taxonomy_epoch c revision revision>=0",
            "admin_tag_metadata_command p principal_id,request_id",
            "admin_tag_metadata_command f principal_id public.admin_principal:id",
            "admin_tag_metadata_command f tag_id public.tag:id",
            "admin_tag_metadata_command c revision revision>=0",
            "admin_tag_metadata_command c fingerprint octet_length(fingerprint)=32",
            "admin_tag_metadata_command c session_reference octet_length(session_reference)=32"
        ]);

    private static readonly SchemaFacts AdminCategoryMetadataShape = new(
        Columns: [
            "admin_category_metadata_command principal_id:uuid request_id:uuid category_id:int4 revision:int8 old_name:text old_description:text name:text description:text changed:bool fingerprint:bytea session_reference:bytea happened_at:timestamptz"
        ],
        Constraints: [
            "admin_category_metadata_command p principal_id,request_id",
            "admin_category_metadata_command f principal_id public.admin_principal:id",
            "admin_category_metadata_command f category_id public.category:id",
            "admin_category_metadata_command c revision revision>=0",
            "admin_category_metadata_command c fingerprint octet_length(fingerprint)=32",
            "admin_category_metadata_command c session_reference octet_length(session_reference)=32"
        ]);

    private static readonly string[] AdminTagMetadataRelations =
        ["public.taxonomy_epoch", "public.admin_tag_metadata_command"];
    private static readonly string[] AdminCategoryMetadataRelations =
        ["public.admin_category_metadata_command"];

    internal static Task<bool> HasAdminTagMetadataAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        HasCompleteRelationsAsync(db, tx, ct, "The administrator tag metadata schema is incomplete.",
            AdminTagMetadataRelations);

    private static bool HasAdminTagMetadata(CatalogPresenceSnapshot catalog) =>
        catalog.HasCompleteRelations("The administrator tag metadata schema is incomplete.", AdminTagMetadataRelations);

    private static bool HasAdminCategoryMetadata(CatalogPresenceSnapshot catalog) =>
        catalog.HasCompleteRelations("The administrator category metadata schema is incomplete.", AdminCategoryMetadataRelations);

    private static CatalogInvariant TaxonomyEpoch(bool category)
    {
        var categoryHistory = category ? "union all select revision from public.admin_category_metadata_command where changed" : "";
        return new($"""
            select revision>=coalesce((select max(revision) from (
                select revision from public.admin_tag_metadata_command where changed
                {categoryHistory}
            ) as history),0) from public.taxonomy_epoch where singleton
            """,
            "The taxonomy epoch and durable command history do not agree.");
    }
}
