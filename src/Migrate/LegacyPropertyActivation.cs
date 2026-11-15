using System.Globalization;
using System.Text.Json;
using FsusBlog.V2.Core.Authoring;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private static bool IsLegacyPropertyDefinitionRelation(BackupRelation row) =>
        row.Name is "property_schema" or "property_definition";

    private static async Task<bool> ActivateLegacyPropertyDefinitionsAsync(NpgsqlConnection db, NpgsqlTransaction tx,
        LegacyPropertyReview review, ImportBackup backup, List<PropertyDefinition> definitions, CancellationToken ct)
    {
        await ExecuteAsync(db, tx, "SET LOCAL search_path=pg_catalog", ct);
        await SetBackupRepresentationAsync(db, tx, ct);
        await CurrentSchema.VerifyCatalogAsync(db, tx, ct);
        await CurrentSchema.VerifyAdminIdentityMarkerAsync(db, tx, ct);
        await using var gate = new NpgsqlCommand("""
            SELECT inet_server_addr() IS NULL AND current_setting('listen_addresses')=''
                AND current_setting('session_replication_role')='origin' AND NOT pg_is_in_recovery()
                AND to_regnamespace('fsus_legacy_candidate') IS NULL
                AND (SELECT version FROM public.v2_schema WHERE singleton)=$1
                AND EXISTS (SELECT FROM public.blog_user WHERE id=$2 AND enabled AND can_author)
            """, db, tx);
        gate.Parameters.AddWithValue(CurrentSchema.Version);
        gate.Parameters.AddWithValue(review.TargetOwner);
        if (await gate.ExecuteScalarAsync(ct) is not true || await CurrentSchema.ReadRecoverySiteIdAsync(db, tx, ct) != review.TargetSite)
            throw new InvalidOperationException("The reviewed runtime site or property author does not match.");

        var (current, media) = await ReadBackupSiteAsync(db, tx, ct);
        var before = backup.Site.Relations;
        if (backup.Site.PostgreSqlMajor != db.PostgreSqlVersion.Major.ToString(CultureInfo.InvariantCulture) ||
            media.Count != 0 || before.Count(IsLegacyPropertyDefinitionRelation) != 2 ||
            before.Any(row => IsLegacyPropertyDefinitionRelation(row) && row.Rows != 0) ||
            !before.Where(row => !IsLegacyPropertyDefinitionRelation(row))
                .SequenceEqual(current.Where(row => !IsLegacyPropertyDefinitionRelation(row))))
            throw new InvalidOperationException("The property destination differs from the reviewed rollback baseline.");

        var pristine = current.SequenceEqual(before);
        if (pristine)
        {
            await using var schema = new NpgsqlCommand("INSERT INTO public.property_schema(owner_id,revision) VALUES($1,$2)", db, tx);
            schema.Parameters.AddWithValue(review.TargetOwner);
            schema.Parameters.AddWithValue(review.SourceRevision);
            await schema.ExecuteNonQueryAsync(ct);
            await using var insert = new NpgsqlCommand("""
                INSERT INTO public.property_definition
                SELECT * FROM json_populate_recordset(NULL::public.property_definition,$1::json)
                """, db, tx);
            insert.Parameters.AddWithValue(JsonSerializer.Serialize(definitions.Select(definition => new
            {
                owner_id = review.TargetOwner,
                id = definition.Id,
                machine_key = definition.MachineKey,
                revision = definition.Revision,
                digest = definition.Digest,
                shape = JsonSerializer.SerializeToElement(definition, PropertyStorageJson.Options)
            })));
            await insert.ExecuteNonQueryAsync(ct);
        }
        await using var read = new NpgsqlCommand("""
            SELECT d.owner_id,s.revision,d.id,d.machine_key,d.revision,d.digest,d.shape::text
            FROM public.property_definition d JOIN public.property_schema s USING(owner_id)
            WHERE (SELECT count(*) FROM public.property_schema)=1
              AND (SELECT sum(octet_length(shape::text)) FROM public.property_definition)<=$2
            ORDER BY d.id LIMIT $1
            """, db, tx);
        read.Parameters.AddWithValue(definitions.Count + 1);
        read.Parameters.AddWithValue(PropertyStorageJson.SchemaByteBudget);
        await using var rows = await read.ExecuteReaderAsync(ct);
        foreach (var definition in definitions.OrderBy(item => item.Id))
        {
            if (!await rows.ReadAsync(ct) || rows.GetGuid(0) != review.TargetOwner || rows.GetInt64(1) != review.SourceRevision ||
                rows.GetGuid(2) != definition.Id || rows.GetString(3) != definition.MachineKey || rows.GetInt64(4) != definition.Revision ||
                rows.GetString(5) != definition.Digest || JsonSerializer.Deserialize<PropertyDefinition>(
                    rows.GetString(6), PropertyStorageJson.Options)?.Digest != definition.Digest)
                throw new InvalidOperationException("The persisted property definitions do not match the approved conversion.");
        }
        if (await rows.ReadAsync(ct))
            throw new InvalidOperationException("The persisted property definitions include unexpected rows.");
        return pristine;
    }
}
