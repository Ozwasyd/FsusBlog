using System.Data.Common;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Serialization;
using Npgsql;

internal static partial class Migration
{
    private const string LegacyPublishProofTable = "article_publish_proof";
    private static readonly LegacyOutboxDefinition LegacyPublishProofShape = OutboxDefinition(LegacyPublishProofTable, """
        id/bigint proof_version/integer signature_payload_version/integer article_id/integer article_revision_id/bigint
        revision_no/integer idempotency_key/varchar(128) canonical_hash/varchar(71) aot_hash/varchar(71)
        article_detail_aeds_hash/varchar(71) public_hot_read_hash/varchar(71) asset_manifest_hash/varchar(71) feed_hash/varchar(71)
        published_at/timestamp proof_status/varchar(24) signing_key_id/varchar(128)? signing_key_version/integer?
        signing_algorithm/varchar(32)? signature/varchar(256)? failure_code/varchar(64)? failure_detail/varchar(512)?
        created_at/timestamp updated_at/timestamp superseded_at/timestamp? transparency_log_entry_id/bigint?
        transparency_log_entry_hash/varchar(64)?
        """, ["idempotency_key"]);

    private sealed record LegacyPublishProofSet(string[] Rows, string KeysSha256,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] LegacyTransparencySet? Transparency = null)
    {
        internal LegacyProjection Project() => new(LegacyPublishProofTable, Rows.Length, DigestMediaDocument(Rows));
    }

    private static async Task<LegacyPublishProofSet?> ReadLegacyPublishProofSourceAsync(LegacySource source,
        DbTransaction transaction, LegacyTable[] catalog, Dictionary<string, LegacyTable> tables, CancellationToken ct)
    {
        if (transaction is not NpgsqlTransaction tx ||
            catalog.FirstOrDefault(table => table.Name == LegacyPublishProofTable) is not { Kind: "r" } relation ||
            !relation.Columns.ToHashSet().SetEquals(LegacyPublishProofShape.Fields) ||
            !await HasLegacyJournalCatalogAsync(tx, source.Schema, relation.Name, LegacyPublishProofShape.Table, ct))
            return null;

        try
        {
            var table = source.Table(relation);
            var publications = source.Table(tables[Publication]);
            var rights = source.Table(tables[RightsSnapshot]);
            await using var query = new NpgsqlCommand($"""
                SELECT CASE WHEN p.tableoid=to_regclass($1)
                    AND octet_length(row_to_json(p)::text)<=8192
                    AND EXISTS (SELECT FROM {publications} release JOIN {rights} claim ON claim.id=release.rights_snapshot_id
                        WHERE release.article_id=p.article_id AND release.article_revision_id=p.article_revision_id
                            AND release.revision_no=p.revision_no AND claim.content_canonical_hash=
                                'sha256:' || regexp_replace(lower(trim(p.canonical_hash)),'^sha256:',''))
                    THEN row_to_json(p)::text END
                FROM {table} p ORDER BY p.id LIMIT 4
                """, tx.Connection, tx) { CommandTimeout = LegacyCommandTimeout };
            query.Parameters.AddWithValue(table);
            await using var reader = await query.ExecuteReaderAsync(ct);
            if (!await reader.ReadAsync(ct)) return null;
            var keys = await ReadLegacyProofFileAsync(LegacyProofKeyInput, ct) ?? throw new FormatException();
            var trusted = ReadLegacyPublishProofKeys(keys);
            var rows = new List<string>(3);
            var revisions = new HashSet<long>();
            do
            {
                if (rows.Count == 3 || reader.IsDBNull(0)) throw new FormatException();
                var row = reader.GetString(0);
                if (!revisions.Add(VerifyLegacyPublishProof(Encoding.UTF8.GetBytes(row), trusted).RevisionId)) throw new FormatException();
                rows.Add(row);
            } while (await reader.ReadAsync(ct));
            await reader.DisposeAsync();
            var transparency = await ReadLegacyTransparencySourceAsync(source, tx, catalog, ct);
            var set = new LegacyPublishProofSet(rows.ToArray(), Convert.ToHexStringLower(SHA256.HashData(keys)), transparency);
            VerifyLegacyTransparency(set, trusted);
            return set;
        }
        catch (Exception error) when (IsLegacyPublishProofError(error))
        {
            throw new InvalidOperationException("Legacy PostgreSQL publish proofs contain unsupported or unverified rows or keys.", error);
        }
    }

    private static void ValidateLegacyPublishProofPlan(ImportPlan plan)
    {
        var projection = plan.SourceProjections?.Where(row => row.Table == LegacyPublishProofTable).ToArray() ?? [];
        var logs = plan.SourceProjections?.Where(row => row.Table is LegacyTransparencyTable or LegacyCheckpointTable).ToArray() ?? [];
        if (plan.PublishProofs is null && projection.Length == 0 && logs.Length == 0) return;
        if (plan.PublishProofs is not { Rows.Length: >= 1 and <= 3 } proof || !IsSha256(proof.KeysSha256) ||
            plan.Provider != "postgres" || plan.Version != ImportPlanWithRollbackOutboxVersion || plan.Media is not null ||
            proof.Rows.Any(row => !ValidLegacyTransparencyRow(row)) || !ValidLegacyTransparencySet(proof.Transparency, logs) ||
            projection is not [var measurement] || measurement != proof.Project())
            throw new InvalidOperationException("The legacy import plan contains an invalid publish proof record set.");
    }
}
