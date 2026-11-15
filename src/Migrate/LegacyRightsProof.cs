using System.Text;
using System.Text.Json;
using FsusBlog.V2.Core.Integrity;
using Npgsql;

internal static partial class Migration
{
    private const string LegacyRightsProofTable = "article_rights_proof";
    private const string LegacyRightsProofKind = "article-rights-proof";
    private const string LegacyRightsProofEvent = "rights-proof-updated";
    private static readonly LegacyOutboxDefinition LegacyRightsProofShape = OutboxDefinition(LegacyRightsProofTable, """
        id/bigint proof_version/integer signature_payload_version/integer article_id/integer article_revision_id/bigint
        revision_no/integer article_rights_snapshot_id/bigint publish_proof_id/bigint? idempotency_key/varchar(160)
        rights_policy_hash/varchar(96) content_canonical_hash/varchar(96) proof_status/varchar(24)
        signing_key_id/varchar(128)? signing_key_version/integer? signing_algorithm/varchar(32)? signature/varchar(256)?
        failure_code/varchar(64)? failure_detail/varchar(512)? transparency_log_entry_id/bigint?
        transparency_log_entry_hash/varchar(64)? created_at/timestamp updated_at/timestamp
        """, ["idempotency_key"]);

    private static LegacyProjection LegacyRightsProofProjection(string row) => new(LegacyRightsProofTable, 1, Digest(row));

    private static byte[] VerifyLegacyRightsProof(JsonElement proof, JsonElement parent,
        Dictionary<string, LegacyPublishProofKey> keys)
    {
        var article = LegacyJsonInt(proof, "article_id");
        var revisionId = LegacyJsonInt(proof, "article_revision_id");
        var revision = LegacyJsonInt(proof, "revision_no");
        var snapshot = LegacyJsonInt(proof, "article_rights_snapshot_id");
        var parentId = LegacyJsonInt(proof, "publish_proof_id");
        var subject = FormattableString.Invariant($"article:{article}:revision:{revisionId}:rights:{snapshot}");
        var policyHash = ReadLegacyProofHash(proof, "rights_policy_hash");
        var contentHash = ReadLegacyProofHash(proof, "content_canonical_hash");
        var key = keys[RequiredProofText(proof, "signing_key_id")];
        var issued = LegacyLogTime(parent, "published_at");
        if (article is <= 0 or > int.MaxValue || revisionId <= 0 || revision != 3 || snapshot <= 0 ||
            LegacyJsonInt(proof, "id") <= 0 || LegacyJsonInt(proof, "proof_version") != 1 ||
            LegacyJsonInt(proof, "signature_payload_version") != 1 ||
            RequiredProofText(proof, "idempotency_key") != FormattableString.Invariant($"article:{article}:revision:{revisionId}:rights:1") ||
            RequiredProofText(proof, "proof_status") != "ready" || RequiredProofText(parent, "proof_status") != "ready" ||
            parentId != LegacyJsonInt(parent, "id") || article != LegacyJsonInt(parent, "article_id") ||
            revisionId != LegacyJsonInt(parent, "article_revision_id") || revision != LegacyJsonInt(parent, "revision_no") ||
            contentHash != ReadLegacyProofHash(parent, "canonical_hash") ||
            policyHash != RequiredProofText(proof, "rights_policy_hash") || contentHash != RequiredProofText(proof, "content_canonical_hash") ||
            key.Version != LegacyJsonInt(proof, "signing_key_version") || key.Algorithm != RequiredProofText(proof, "signing_algorithm") ||
            proof.GetProperty("failure_code").ValueKind != JsonValueKind.Null || proof.GetProperty("failure_detail").ValueKind != JsonValueKind.Null ||
            LegacyLogTime(proof, "created_at") < issued || LegacyLogTime(proof, "updated_at") < LegacyLogTime(proof, "created_at"))
            throw new FormatException();

        var record = FormattableString.Invariant($"""
            fsusblog.integrity.article-rights-proof-record.v1
            proofVersion:i:1
            signaturePayloadVersion:i:1
            articleId:i:{article}
            articleRevisionId:i:{revisionId}
            revisionNo:i:{revision}
            articleRightsSnapshotId:i:{snapshot}
            publishProofId:i:{parentId}
            rightsPolicyHash:h:{policyHash}
            contentCanonicalHash:h:{contentHash}
            issuedAt:t:{issued:yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'}
            proofStatus:s:ready

            """);
        var fields = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["articleId"] = FormattableString.Invariant($"{article}"),
            ["articleRevisionId"] = FormattableString.Invariant($"{revisionId}"),
            ["articleRightsSnapshotId"] = FormattableString.Invariant($"{snapshot}"),
            ["proofVersion"] = "1",
            ["publishProofId"] = FormattableString.Invariant($"{parentId}"),
            ["revisionNo"] = "3",
            ["signaturePayloadVersion"] = "1"
        };
        var payload = SiteProofPayload.Canonicalize(LegacyRightsProofKind, subject, Digest(record), issued, fields);
        VerifyLegacyProofSignature(key, issued, RequiredProofText(proof, "signature"), payload);
        return payload;
    }

    private static string LegacyRightsLogPayloadHash(JsonElement proof)
    {
        var fields = FormattableString.Invariant($"""
            fsusblog.integrity.article-rights-proof-log-payload.v1
            proofId:i:{LegacyJsonInt(proof, "id")}
            proofVersion:i:1
            signaturePayloadVersion:i:1
            articleId:i:{LegacyJsonInt(proof, "article_id")}
            articleRevisionId:i:{LegacyJsonInt(proof, "article_revision_id")}
            revisionNo:i:{LegacyJsonInt(proof, "revision_no")}
            articleRightsSnapshotId:i:{LegacyJsonInt(proof, "article_rights_snapshot_id")}
            publishProofId:i:{LegacyJsonInt(proof, "publish_proof_id")}

            """);
        foreach (var (name, column) in new (string, string)[]
        {
            ("idempotencyKey", "idempotency_key"), ("rightsPolicyHash", "rights_policy_hash"),
            ("contentCanonicalHash", "content_canonical_hash"), ("proofStatus", "proof_status"),
            ("signingKeyId", "signing_key_id"), ("signingAlgorithm", "signing_algorithm"), ("signature", "signature")
        })
            fields += LegacyLogString(name, RequiredProofText(proof, column));
        return Digest("fsusblog.integrity.transparency-log-payload.v1\n" +
            LegacyLogString("entryType", LegacyRightsProofKind) + LegacyLogString("payload", fields));
    }

    private static async Task<string> ReadLegacyRightsProofSourceAsync(LegacySource source, NpgsqlTransaction tx, LegacyTable[] catalog,
        Dictionary<string, LegacyTable> tables, string publishProof, CancellationToken ct)
    {
        if (catalog.FirstOrDefault(table => table.Name == LegacyRightsProofTable) is not { Kind: "r" } relation ||
            !relation.Columns.ToHashSet().SetEquals(LegacyRightsProofShape.Fields) ||
            !await HasLegacyJournalCatalogAsync(tx, source.Schema, relation.Name, LegacyRightsProofShape.Table, ct))
            throw new FormatException();
        var table = source.Table(relation);
        var events = catalog.Single(row => row.Name == LegacyOutboxSource);
        await using var query = new NpgsqlCommand($"""
            SELECT CASE WHEN proof.tableoid=to_regclass($1) AND octet_length(row_to_json(proof)::text)<=8192
                AND EXISTS (SELECT FROM {source.Table(tables[Article])} article
                    JOIN {source.Table(tables[Publication])} p ON p.id=article.current_publication_id
                    JOIN {source.Table(tables[RightsSnapshot])} s ON s.id=p.rights_snapshot_id
                    JOIN {source.Table(events)} e ON e.article_publication_id=p.id AND e.event_type='{LegacyRightsProofEvent}'
                    WHERE article.id=proof.article_id AND article.published_at=$2 AND p.article_id=article.id
                        AND p.revision_no=proof.revision_no AND p.article_revision_id=proof.article_revision_id
                        AND s.id=proof.article_rights_snapshot_id AND s.proof_binding_enabled
                        AND s.policy_hash='sha256:' || proof.rights_policy_hash
                        AND s.content_canonical_hash='sha256:' || proof.content_canonical_hash
                        AND proof.created_at>=p.published_at AND proof.updated_at<=e.created_at)
                THEN row_to_json(proof)::text END
            FROM {table} proof ORDER BY proof.id LIMIT 2
            """, tx.Connection, tx) { CommandTimeout = LegacyCommandTimeout };
        query.Parameters.AddWithValue(table);
        query.Parameters.AddWithValue(LegacyLogTime(ParseLegacyTransparencyRecord(publishProof), "published_at").DateTime);
        await using var reader = await query.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct) || reader.IsDBNull(0)) throw new FormatException();
        var result = reader.GetString(0);
        if (await reader.ReadAsync(ct)) throw new FormatException();
        return result;
    }

    private static JsonElement LegacyRightsProofParent(IEnumerable<string> publishRows, JsonElement rights) =>
        publishRows.Select(ParseLegacyTransparencyRecord).Single(row => LegacyJsonInt(row, "id") == LegacyJsonInt(rights, "publish_proof_id"));

    private static void VerifyLegacyRightsLogClock(LegacyArchivedTransparency log, DateTime eventAt)
    {
        if (LegacyLogTime(ParseLegacyTransparencyRecord(Encoding.UTF8.GetString(log.SourceRow)), "created_at").DateTime < eventAt)
            throw new FormatException();
    }

    private static async Task<long> BindLegacyReleaseRightsProofAsync(NpgsqlConnection db, NpgsqlTransaction tx, JsonElement proof,
        JsonElement parent, CancellationToken ct)
    {
        await using var query = new NpgsqlCommand($"""
            SELECT p.source_publication_id FROM {ImportSchema}.shadow_article a
            JOIN {ImportSchema}.shadow_publication p ON p.source_publication_id=a.current_publication_id AND p.article_id=a.id
            JOIN {ImportSchema}.shadow_article_rights_snapshot s ON s.id=p.source_rights_snapshot_id
            JOIN {ImportSchema}.{LegacyOutboxParent.Table.Name} e
                ON e.article_publication_id=p.source_publication_id AND e.event_type='{LegacyRightsProofEvent}'
            WHERE a.id=$1 AND p.source_revision_id=$2 AND s.id=$3 AND s.proof_binding_enabled=1 AND
                s.policy_hash=$4 AND s.content_canonical_hash=$5 AND a.published_at::timestamp=$6 AND
                $7>=p.published_at::timestamp AND $8<=e.created_at::timestamp
            """, db, tx);
        query.Parameters.AddWithValue(LegacyJsonInt(proof, "article_id"));
        query.Parameters.AddWithValue(LegacyJsonInt(proof, "article_revision_id"));
        query.Parameters.AddWithValue(LegacyJsonInt(proof, "article_rights_snapshot_id"));
        query.Parameters.AddWithValue("sha256:" + RequiredProofText(proof, "rights_policy_hash"));
        query.Parameters.AddWithValue("sha256:" + RequiredProofText(proof, "content_canonical_hash"));
        query.Parameters.AddWithValue(LegacyLogTime(parent, "published_at").DateTime);
        query.Parameters.AddWithValue(LegacyLogTime(proof, "created_at").DateTime);
        query.Parameters.AddWithValue(LegacyLogTime(proof, "updated_at").DateTime);
        return await query.ExecuteScalarAsync(ct) is long publicationId ? publicationId : throw new FormatException();
    }
}
