using System.Data.Common;
using System.Text;

internal static partial class Migration
{
    private const string LegacyTransparencyTable = "integrity_transparency_log";
    private const string LegacyCheckpointTable = "integrity_merkle_checkpoint";
    private const string LegacyCheckpointDigest = "FSUSBLOG_LEGACY_V1_CHECKPOINT_SHA256";

    private static readonly LegacyOutboxDefinition LegacyTransparencyShape = OutboxDefinition(LegacyTransparencyTable, """
        id/bigint seq/bigint entry_type/varchar(32) proof_id/bigint? article_id/integer? article_revision_id/bigint?
        revision_no/integer? entry_payload_hash/varchar(64) prev_entry_hash/varchar(64) entry_hash/varchar(64)
        created_at/timestamp signing_key_id/varchar(128)? signature/varchar(256)?
        """, ["seq"]);
    private static readonly LegacyOutboxDefinition LegacyCheckpointShape = OutboxDefinition(LegacyCheckpointTable, """
        id/bigint checkpoint_kind/varchar(24) scope_key/varchar(64) from_seq/bigint to_seq/bigint entry_count/integer
        root_hash/varchar(64) log_head_seq/bigint log_head_hash/varchar(64) manifest_hash/varchar(64) manifest_json/text
        signing_key_id/varchar(128) signing_algorithm/varchar(32) signature/varchar(256) created_at/timestamp
        """, ["checkpoint_kind", "scope_key"]);

    private sealed record LegacyTransparencySet(string[] Rows, string Checkpoint)
    {
        internal LegacyProjection[] Projections() =>
        [
            new(LegacyTransparencyTable, Rows.Length, DigestMediaDocument(Rows)),
            new(LegacyCheckpointTable, 1, Digest(Checkpoint))
        ];
    }

    private static async Task<LegacyTransparencySet?> ReadLegacyTransparencySourceAsync(LegacySource source,
        DbTransaction tx, LegacyTable[] catalog, int rights, CancellationToken ct)
    {
        var log = await ReadTransparencyRowsAsync(LegacyTransparencyShape, "seq", 3 + rights);
        if (log.Length == 0) return null;
        var checkpoints = await ReadTransparencyRowsAsync(LegacyCheckpointShape, "id", 1);
        if (checkpoints is not [var checkpoint] || Digest(checkpoint) !=
            Environment.GetEnvironmentVariable(LegacyCheckpointDigest))
            throw new FormatException();
        return new(log, checkpoint);

        async Task<string[]> ReadTransparencyRowsAsync(LegacyOutboxDefinition definition, string order, int limit)
        {
            if (catalog.FirstOrDefault(table => table.Name == definition.Source) is not { Kind: "r" } relation ||
                !relation.Columns.ToHashSet().SetEquals(definition.Fields) ||
                !await HasLegacyJournalCatalogAsync(tx, source.Schema, relation.Name, definition.Table, ct))
                return [];
            var table = source.Table(relation);
            await using var query = CreateLegacyCommand(tx, $"""
                SELECT CASE WHEN src.tableoid=to_regclass(@relation) AND octet_length(row_to_json(src)::text) <= 8192
                    THEN row_to_json(src)::text END
                FROM {table} src ORDER BY src.{order} LIMIT {limit + 1}
                """);
            var relationName = query.CreateParameter();
            relationName.ParameterName = "relation";
            relationName.Value = table;
            query.Parameters.Add(relationName);
            await using var reader = await query.ExecuteReaderAsync(ct);
            var rows = new List<string>(limit);
            while (await reader.ReadAsync(ct))
            {
                if (rows.Count == limit || reader.IsDBNull(0)) throw new FormatException();
                rows.Add(reader.GetString(0));
            }
            return rows.ToArray();
        }
    }

    private static bool ValidLegacyTransparencySet(LegacyTransparencySet? transparency, LegacyProjection[] projections, int rights)
    {
        if (transparency is null) return rights == 0 && projections.Length == 0;
        return transparency.Rows is { Length: >= 1 } && transparency.Rows.Length <= 3 + rights && transparency.Rows.All(ValidLegacyTransparencyRow) &&
            ValidLegacyTransparencyRow(transparency.Checkpoint) && projections.SequenceEqual(transparency.Projections());
    }

    private static bool ValidLegacyTransparencyRow(string? row) =>
        row is not null && Encoding.UTF8.GetByteCount(row) is >= 1 and <= 8192;
}
