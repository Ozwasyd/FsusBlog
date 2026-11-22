using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly SchemaFacts AdminTagMetadataShape = Tables(
        Table("taxonomy_epoch singleton:bool revision:int8",
            "p singleton",
            "c singleton singleton",
            "c revision revision>=0"),
        MetadataCommand("tag"));

    private static readonly SchemaFacts AdminCategoryMetadataShape = MetadataCommand("category");

    private static SchemaFacts MetadataCommand(string taxonomy) => Table(
        $"admin_{taxonomy}_metadata_command principal_id:uuid request_id:uuid {taxonomy}_id:int4 revision:int8 old_name:text old_description:text name:text description:text changed:bool fingerprint:bytea session_reference:bytea happened_at:timestamptz",
        "p principal_id,request_id",
        "f principal_id public.admin_principal:id",
        $"f {taxonomy}_id public.{taxonomy}:id",
        "c revision revision>=0",
        "c fingerprint octet_length(fingerprint)=32",
        "c session_reference octet_length(session_reference)=32");

    private static readonly RelationGroup AdminTagMetadataRelations = new(
        "The administrator tag metadata schema is incomplete.",
        "public.taxonomy_epoch", "public.admin_tag_metadata_command");
    private static readonly RelationGroup AdminCategoryMetadataRelations = new(
        "The administrator category metadata schema is incomplete.",
        "public.admin_category_metadata_command");

    internal static Task<bool> HasAdminTagMetadataAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        AdminTagMetadataRelations.IsPresentAsync(db, tx, ct);


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
