using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly string[] PropertySnapshotColumns =
    [
        "article_property_snapshot article_id:int4 schema_revision:int8 value_revision:int8 digest:text field_digests:_text",
        "article_property_snapshot_field article_id:int4 schema_revision:int8 value_revision:int8 ordinal:int4 definition_id:uuid machine_key:text definition_revision:int8 definition_digest:text shape:jsonb data:jsonb references_ids:_int4",
        "article_revision_property_snapshot article_id:int4 revision:int8 schema_revision:int8 value_revision:int8"
    ];

    private static readonly string[] PropertySnapshotConstraints =
    [
        "article_property_snapshot p article_id,schema_revision,value_revision",
        "article_property_snapshot f article_id public.article:id",
        "article_property_snapshot c schema_revision schema_revision>=0",
        "article_property_snapshot c value_revision value_revision>=0",
        "article_property_snapshot c digest char_length(digest)=64",
        "article_property_snapshot c field_digests cardinality(field_digests)<=1000",
        "article_property_snapshot_field p article_id,schema_revision,value_revision,ordinal",
        "article_property_snapshot_field u article_id,schema_revision,value_revision,machine_key",
        "article_property_snapshot_field f article_id,schema_revision,value_revision public.article_property_snapshot:article_id,schema_revision,value_revision",
        "article_property_snapshot_field c ordinal ordinal>0",
        "article_property_snapshot_field c definition_revision definition_revision>0",
        "article_property_snapshot_field c definition_digest char_length(definition_digest)=64",
        "article_property_snapshot_field c references_ids cardinality(references_ids)<=32",
        "article_revision_property_snapshot p article_id,revision",
        "article_revision_property_snapshot f article_id,revision public.article_revision:article_id,revision",
        "article_revision_property_snapshot f article_id,schema_revision,value_revision public.article_property_snapshot:article_id,schema_revision,value_revision"
    ];

    private const string PropertySnapshotRelation = "public.article_revision_property_snapshot";

    internal static async Task<bool> HasPropertySnapshotsAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        await using var query = new NpgsqlCommand(
            "select relkind::text from pg_catalog.pg_class where oid=pg_catalog.to_regclass('public.article_revision_property_snapshot')",
            db, tx);
        return await query.ExecuteScalarAsync(ct) switch
        {
            null => false,
            "r" => true,
            _ => throw new InvalidOperationException("Invalid saved property snapshot relation.")
        };
    }

    private static bool HasPropertySnapshots(CatalogPresenceSnapshot catalog) =>
        catalog.GetRelationKind(PropertySnapshotRelation) switch
        {
            null => false,
            'r' => true,
            _ => throw new InvalidOperationException("Invalid saved property snapshot relation.")
        };
}
