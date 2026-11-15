using System.Data;
using System.Data.Common;
using System.Security.Cryptography;

internal static partial class Migration
{
    // These are the definition authority and its audit relations at LegacyReference.
    private static readonly HashSet<string> LegacyPropertyDefinitions = new(StringComparer.Ordinal)
    {
        "article_property_definition_owner", "article_property_definition", "article_property_definition_display_name",
        "article_property_definition_option", "article_property_definition_option_label", "article_property_definition_receipt",
        "article_property_definition_obligation", "article_property_definition_idempotency", "article_property_definition_history",
        "article_property_definition_command"
    };

    private static async Task<LegacyPropertyRelation[]> ReadLegacyPropertyInventoryAsync(LegacySource source, DbTransaction transaction,
        LegacyTable[] catalog, CancellationToken ct)
    {
        var relations = new List<LegacyPropertyRelation>();
        foreach (var table in catalog.Where(table => table.Name.StartsWith("article_property_", StringComparison.OrdinalIgnoreCase)))
        {
            var recognized = LegacyPropertyDefinitions.Contains(table.Name);
            if (!source.IsSnapshotTable(table.Kind))
            {
                relations.Add(new(table.Name, recognized, null, null, "unverifiable-relation"));
                continue;
            }

            var rows = await CountAsync("FROM " + source.Table(table), transaction, ct);
            var primitiveColumns = table.Columns.All(column => IsLegacyPropertyPrimitive(column.Type));
            var digest = recognized && primitiveColumns
                ? await FingerprintLegacyPropertyRelationAsync(source, transaction, table, rows, ct) : null;
            relations.Add(new(table.Name, recognized, rows, digest, rows == 0 ? "empty" :
                !primitiveColumns ? "unverifiable-shape" : "requires-review"));
        }
        return relations.ToArray();
    }

    private static bool IsLegacyPropertyPrimitive(string type) => type is "bigint" or "integer" or "smallint" or "uuid"
        or "boolean" or "numeric" or "text" or "bytea" or "timestamp without time zone" ||
        type.StartsWith("character varying(", StringComparison.Ordinal) && type.EndsWith(')');

    private static async Task<string> FingerprintLegacyPropertyRelationAsync(LegacySource source, DbTransaction transaction,
        LegacyTable table, long rows, CancellationToken ct)
    {
        using var digest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        AppendLegacyValue(digest, "fsusblog.legacy-property-relation.v1");
        AppendLegacyValue(digest, LegacyReference);
        AppendLegacyValue(digest, source.Schema);
        AppendLegacyValue(digest, table.Name);
        AppendLegacyValue(digest, table.Kind);
        AppendLegacyValue(digest, table.Columns.Count);
        foreach (var column in table.Columns)
        {
            AppendLegacyValue(digest, column.Name);
            AppendLegacyValue(digest, column.Type);
        }
        AppendLegacyValue(digest, rows);

        // The fixed PostgreSQL snapshot emits hashes only. Order by bytea to keep duplicates and avoid collation-dependent ordering.
        await using (var representation = CreateLegacyCommand(transaction, "SET LOCAL bytea_output = 'hex'; SET LOCAL DateStyle = 'ISO, YMD'"))
            await representation.ExecuteNonQueryAsync(ct);
        await using var command = CreateLegacyCommand(transaction, $"""
            SELECT pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(r)::text, 'UTF8')) AS digest
            FROM {source.Table(table)} AS r ORDER BY digest
            """);
        await using var reader = await command.ExecuteReaderAsync(CommandBehavior.SequentialAccess, ct);
        long seen = 0;
        while (await reader.ReadAsync(ct))
        {
            digest.AppendData(reader.GetFieldValue<byte[]>(0));
            seen++;
        }
        if (seen != rows) throw new InvalidOperationException("The legacy property relation count changed within its source snapshot.");
        return Convert.ToHexStringLower(digest.GetHashAndReset());
    }

    private sealed record LegacyPropertyRelation(string Relation, bool RecordedInFrozenDefinitionAuthority, long? Rows,
        string? PostgreSqlSha256, string Disposition);
}
