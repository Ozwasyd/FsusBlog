using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly SchemaFacts PropertySnapshotShape = Tables(
        Table("article_property_snapshot article_id:int4 schema_revision:int8 value_revision:int8 digest:text field_digests:_text",
            "p article_id,schema_revision,value_revision",
            "f article_id public.article:id",
            "c schema_revision schema_revision>=0",
            "c value_revision value_revision>=0",
            "c digest char_length(digest)=64",
            "c field_digests cardinality(field_digests)<=1000"),
        Table("article_property_snapshot_field article_id:int4 schema_revision:int8 value_revision:int8 ordinal:int4 definition_id:uuid machine_key:text definition_revision:int8 definition_digest:text shape:jsonb data:jsonb references_ids:_int4",
            "p article_id,schema_revision,value_revision,ordinal",
            "u article_id,schema_revision,value_revision,machine_key",
            "f article_id,schema_revision,value_revision public.article_property_snapshot:article_id,schema_revision,value_revision",
            "c ordinal ordinal>0",
            "c definition_revision definition_revision>0",
            "c definition_digest char_length(definition_digest)=64",
            "c references_ids cardinality(references_ids)<=32"),
        Table("article_revision_property_snapshot article_id:int4 revision:int8 schema_revision:int8 value_revision:int8",
            "p article_id,revision",
            "f article_id,revision public.article_revision:article_id,revision",
            "f article_id,schema_revision,value_revision public.article_property_snapshot:article_id,schema_revision,value_revision"));

    private const string PropertySnapshotRelation = "public.article_revision_property_snapshot";

    private static readonly TableProbe PropertySnapshotTable = new(PropertySnapshotRelation, "Invalid saved property snapshot relation.");

    internal static Task<bool> HasPropertySnapshotsAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        PropertySnapshotTable.IsPresentAsync(db, tx, ct);
}
