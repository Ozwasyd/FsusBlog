using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Core.Authoring;
using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Server.Authoring;

internal sealed partial class PropertyStore
{
    private const string SnapshotDigest = """
        encode(sha256(convert_to(jsonb_build_array('article-property-snapshot/v1',
            h.article_id,h.owner_id,h.schema_revision,h.value_revision,h.field_digests)::text,'UTF8')),'hex')
        """;

    private const string SnapshotFieldDigest = """
        encode(sha256(convert_to(jsonb_build_array(f.definition_id,f.machine_key,f.definition_revision,
            f.definition_digest,f.shape,f.data,f.references_ids)::text,'UTF8')),'hex')
        """;

    internal static async Task CaptureSnapshot(NpgsqlConnection db, NpgsqlTransaction tx, Guid owner,
        int article, long revision, CancellationToken ct)
    {
        if (!await CurrentSchema.HasPropertySnapshotsAsync(db, tx, ct)) return;

        // The article is already write-locked. Read the property schema, values and definitions using
        // one statement snapshot, without reversing the property writer's scope -> article lock order.
        await using var capture = Store.Sql(db, tx, $"""
            with coordinates as materialized (
                select $1::integer article_id,$3::uuid owner_id,
                    coalesce((select revision from public.property_schema where owner_id=$3),0) schema_revision,
                    coalesce((select revision from public.property_article where article_id=$1 and owner_id=$3),0) value_revision
            ), existing as (
                select c.* from coordinates c join public.article_property_snapshot s
                    using (article_id,schema_revision,value_revision)
            ), new_coordinates as (
                select * from coordinates where not exists(select from existing)
            ), fields as materialized (
                select n.article_id,n.schema_revision,n.value_revision,
                    row_number() over(order by d.machine_key collate "C")::integer ordinal,
                    v.definition_id,d.machine_key,d.revision definition_revision,d.digest definition_digest,
                    d.shape,v.data,v.references_ids
                from new_coordinates n
                join public.property_value v on v.article_id=n.article_id and v.owner_id=n.owner_id
                join public.property_definition d on d.owner_id=v.owner_id and d.id=v.definition_id
            ), sealed as (
                select n.*,array(select {SnapshotFieldDigest} from fields f order by ordinal) field_digests
                from new_coordinates n
            ), inserted as (
                insert into public.article_property_snapshot(article_id,schema_revision,value_revision,digest,field_digests)
                select h.article_id,h.schema_revision,h.value_revision,{SnapshotDigest},h.field_digests from sealed h
                returning article_id,schema_revision,value_revision
            ), copied as (
                insert into public.article_property_snapshot_field(article_id,schema_revision,value_revision,
                    ordinal,definition_id,machine_key,definition_revision,definition_digest,shape,data,references_ids)
                select * from fields
            )
            insert into public.article_revision_property_snapshot(article_id,revision,schema_revision,value_revision)
            select article_id,$2,schema_revision,value_revision from inserted
            union all
            select article_id,$2,schema_revision,value_revision from existing
            """, article, revision, owner);
        if (await capture.ExecuteNonQueryAsync(ct) != 1)
            throw new InvalidOperationException("The article property snapshot was not attached.");
    }

    internal static async Task CopySnapshot(NpgsqlConnection db, NpgsqlTransaction tx, int article,
        long source, long revision, CancellationToken ct)
    {
        if (!await CurrentSchema.HasPropertySnapshotsAsync(db, tx, ct)) return;
        await using var copy = Store.Sql(db, tx, """
            insert into public.article_revision_property_snapshot(article_id,revision,schema_revision,value_revision)
            select article_id,$3,schema_revision,value_revision from public.article_revision_property_snapshot
            where article_id=$1 and revision=$2
            """, article, source, revision);
        await copy.ExecuteNonQueryAsync(ct);
    }

    internal async Task<PropertyEditorWorkspace> ReadSnapshot(int article, long source, int offset, CancellationToken ct)
    {
        if (!await CurrentSchema.HasPropertySnapshotsAsync(db, tx, ct)) throw SnapshotUnavailable();

        await using var query = Store.Sql(db, tx, $"""
            with snapshot as (
                select s.*,$3::uuid owner_id
                from public.article_revision_property_snapshot r
                join public.article_property_snapshot s using (article_id,schema_revision,value_revision)
                where r.article_id=$1 and r.revision=$2
            )
            select h.schema_revision,h.value_revision,h.digest={SnapshotDigest},
                cardinality(h.field_digests),f.ordinal,
                f.definition_id,f.machine_key,f.definition_revision,f.definition_digest,f.shape::text,f.data::text,
                f.references_ids,h.field_digests[f.ordinal]={SnapshotFieldDigest}
            from snapshot h
            left join lateral (
                select * from public.article_property_snapshot_field
                where (article_id,schema_revision,value_revision)=(h.article_id,h.schema_revision,h.value_revision)
                    and ordinal>$4
                order by ordinal limit $5
            ) f on true
            order by f.ordinal
            """, article, source, ownerId, offset, WireLimits.PropertyPageSize + 1);

        long schemaRevision;
        long valueRevision;
        var fields = new List<(PropertyDefinition Definition, PropertyValue Value)>();
        await using (var rows = await query.ExecuteReaderAsync(ct))
        {
            if (!await rows.ReadAsync(ct)) throw SnapshotUnavailable();
            schemaRevision = rows.GetInt64(0);
            valueRevision = rows.GetInt64(1);
            int fieldCount = rows.GetInt32(3);
            if (!rows.GetBoolean(2)) throw SnapshotInvalid();
            if (offset > fieldCount)
                throw new BusinessException(Rejection.Invalid, "Unknown saved property cursor.");
            string previous = "";
            do
            {
                if (rows.IsDBNull(4)) break;
                if (rows.GetInt32(4) != offset + fields.Count + 1 || rows.IsDBNull(12) || !rows.GetBoolean(12))
                    throw SnapshotInvalid();
                var definition = Parse<PropertyDefinition>(rows.GetString(9));
                var value = Parse<PropertyValue>(rows.GetString(10));
                if (definition.Id != rows.GetGuid(5) || definition.Scope != Scope ||
                    definition.MachineKey != rows.GetString(6) || StringComparer.Ordinal.Compare(previous, definition.MachineKey) >= 0 ||
                    definition.Revision != rows.GetInt64(7) || definition.Revision > schemaRevision ||
                    definition.Digest != rows.GetString(8) || !ReferenceIds(value).SequenceEqual(rows.GetFieldValue<int[]>(11)))
                    throw SnapshotInvalid();
                fields.Add((definition, value));
                previous = definition.MachineKey;
            } while (await rows.ReadAsync(ct));
            if (fields.Count != Math.Min(fieldCount - offset, WireLimits.PropertyPageSize + 1)) throw SnapshotInvalid();
        }

        // Resolve only the visibility of frozen reference IDs. History never reads live property values or definitions.
        var page = fields.Take(WireLimits.PropertyPageSize).ToArray();
        var visible = await ReadReferences(page.SelectMany(field => ReferenceIds(field.Value)).Distinct().Order().ToArray(),
            ct, lockTargets: false);
        return new(article, source, schemaRevision, valueRevision,
            fields.Count > WireLimits.PropertyPageSize ? page[^1].Definition.MachineKey : "",
            page.Select(field => EditorField(field.Definition, VisibleValue(field.Value, visible))).ToArray());
    }

    private static BusinessException SnapshotUnavailable() =>
        new(Rejection.NotFound, "Property snapshot is unavailable for this saved revision.");

    private static InvalidOperationException SnapshotInvalid() =>
        new("The saved property snapshot failed its integrity check.");
}
