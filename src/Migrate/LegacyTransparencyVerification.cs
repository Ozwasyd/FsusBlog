using System.Globalization;
using System.Text;
using System.Text.Json;
using FsusBlog.V2.Core.Integrity;

internal static partial class Migration
{
    private const string LegacyPublishProofKind = "publish-proof";
    private sealed record LegacyArchivedTransparency(byte[] SourceRow, byte[] Checkpoint);
    private static Dictionary<(string Kind, long Revision), LegacyArchivedTransparency> VerifyLegacyTransparency(LegacyPublishProofSet set,
        Dictionary<string, LegacyPublishProofKey> keys)
    {
        var records = set.Rows.Select(ParseLegacyTransparencyRecord).ToDictionary(row => (LegacyPublishProofKind, LegacyJsonInt(row, "id")));
        foreach (var rights in set.RightsRows())
        {
            var record = ParseLegacyTransparencyRecord(rights);
            records.Add((LegacyRightsProofKind, LegacyJsonInt(record, "id")), record);
        }
        var entries = new Dictionary<(string Kind, long Revision), LegacyArchivedTransparency>();
        var transparency = set.Transparency;
        string previous = new('0', 64);
        var leaves = new List<string>();
        var checkpoint = transparency is null ? null : Encoding.UTF8.GetBytes(transparency.Checkpoint);
        foreach (var raw in transparency?.Rows ?? [])
        {
            var row = ParseLegacyTransparencyRecord(raw);
            var seq = LegacyJsonInt(row, "seq");
            var id = LegacyJsonInt(row, "id");
            var proofId = LegacyJsonInt(row, "proof_id");
            var revisionId = LegacyJsonInt(row, "article_revision_id");
            var kind = RequiredProofText(row, "entry_type");
            var proof = records[(kind, proofId)];
            var keyId = RequiredProofText(row, "signing_key_id");
            var signature = RequiredProofText(row, "signature");
            var hash = RequiredProofText(row, "entry_hash");
            var payloadHash = RequiredProofText(row, "entry_payload_hash");
            if (id <= 0 || seq != leaves.Count + 1 ||
                kind == LegacyRightsProofKind && !entries.ContainsKey((LegacyPublishProofKind, revisionId)) ||
                proof.GetProperty("transparency_log_entry_id").GetInt64() != id || RequiredProofText(proof, "transparency_log_entry_hash") != hash ||
                LegacyJsonInt(row, "article_id") != LegacyJsonInt(proof, "article_id") || revisionId != LegacyJsonInt(proof, "article_revision_id") ||
                LegacyJsonInt(row, "revision_no") != LegacyJsonInt(proof, "revision_no") || keyId != RequiredProofText(proof, "signing_key_id") ||
                signature != RequiredProofText(proof, "signature") || payloadHash != (kind == LegacyPublishProofKind ? LegacyPublishLogPayloadHash(proof) : LegacyRightsLogPayloadHash(proof)) ||
                previous != RequiredProofText(row, "prev_entry_hash"))
                throw new FormatException();

            var (entryHash, leaf) = LegacyTransparencyPayload.HashProofEntry(new(
                seq, kind, proofId, LegacyJsonInt(row, "article_id"), revisionId, LegacyJsonInt(row, "revision_no"),
                payloadHash, previous, LegacyLogTime(row, "created_at"), keyId, signature));
            if (hash != entryHash ||
                !entries.TryAdd((kind, revisionId), new(Encoding.UTF8.GetBytes(raw), checkpoint!)))
                throw new FormatException();

            leaves.Add(leaf);
            previous = hash;
        }

        foreach (var ((kind, _), proof) in records)
        {
            bool linked = entries.ContainsKey((kind, LegacyJsonInt(proof, "article_revision_id")));
            if ((kind == LegacyRightsProofKind || set.Rows.Length > 3) && !linked ||
                (proof.GetProperty("transparency_log_entry_id").ValueKind != JsonValueKind.Null) != linked ||
                (proof.GetProperty("transparency_log_entry_hash").ValueKind != JsonValueKind.Null) != linked)
                throw new FormatException();
        }
        if (transparency is not null)
        {
            if (leaves.Count == 0) throw new FormatException();
            VerifyLegacyCheckpoint(ParseLegacyTransparencyRecord(transparency.Checkpoint), leaves, previous, keys);
        }
        return entries;
    }

    private static string LegacyPublishLogPayloadHash(JsonElement proof)
    {
        var fixedFields = FormattableString.Invariant($"""
            fsusblog.integrity.publish-proof-log-payload.v1
            proofId:i:{LegacyJsonInt(proof, "id")}
            proofVersion:i:{LegacyJsonInt(proof, "proof_version")}
            signaturePayloadVersion:i:{LegacyJsonInt(proof, "signature_payload_version")}
            articleId:i:{LegacyJsonInt(proof, "article_id")}
            articleRevisionId:i:{LegacyJsonInt(proof, "article_revision_id")}
            revisionNo:i:{LegacyJsonInt(proof, "revision_no")}

            """);
        var values = new StringBuilder(fixedFields);
        foreach (var (name, column) in new (string, string)[]
        {
            ("idempotencyKey", "idempotency_key"), ("canonicalHash", "canonical_hash"), ("aotHash", "aot_hash"),
            ("articleDetailAedsHash", "article_detail_aeds_hash"), ("publicHotReadHash", "public_hot_read_hash"),
            ("assetManifestHash", "asset_manifest_hash"), ("feedHash", "feed_hash")
        })
            values.Append(LegacyLogString(name, RequiredProofText(proof, column)));
        values.Append(FormattableString.Invariant($"publishedAt:t:{LegacyLogTime(proof, "published_at"):yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'}\n"));
        values.Append(LegacyLogString("proofStatus", "ready"));
        values.Append(LegacyLogString("signingKeyId", RequiredProofText(proof, "signing_key_id")));
        values.Append(LegacyLogString("signingAlgorithm", RequiredProofText(proof, "signing_algorithm")));
        values.Append(LegacyLogString("signature", RequiredProofText(proof, "signature")));
        return Digest("fsusblog.integrity.transparency-log-payload.v1\n" +
            LegacyLogString("entryType", LegacyPublishProofKind) + LegacyLogString("payload", values.ToString()));
    }

    private static void VerifyLegacyCheckpoint(JsonElement row, List<string> leaves, string head,
        Dictionary<string, LegacyPublishProofKey> keys)
    {
        var scope = RequiredProofText(row, "scope_key");
        var created = LegacyLogTime(row, "created_at");
        var root = LegacyTransparencyPayload.MerkleRoot(leaves);
        var count = leaves.Count;
        var manifest = new LegacyTransparencyCheckpoint(1, "release", scope, root, 1, count, count, count, head, created);
        if (LegacyJsonInt(row, "id") <= 0 || scope.Length == 0 || scope.Trim() != scope || RequiredProofText(row, "checkpoint_kind") != "release" ||
            root != RequiredProofText(row, "root_hash") || head != RequiredProofText(row, "log_head_hash") ||
            LegacyJsonInt(row, "from_seq") != 1 || LegacyJsonInt(row, "to_seq") != count || LegacyJsonInt(row, "entry_count") != count ||
            LegacyJsonInt(row, "log_head_seq") != count ||
            JsonSerializer.Deserialize<LegacyTransparencyCheckpoint>(RequiredProofText(row, "manifest_json"), OwnerMapJson) != manifest)
            throw new FormatException();

        var (digest, payload) = LegacyTransparencyPayload.CheckpointSigningPayload(manifest);
        var key = keys[RequiredProofText(row, "signing_key_id")];
        if (RequiredProofText(row, "manifest_hash") != digest || RequiredProofText(row, "signing_algorithm") != key.Algorithm) throw new FormatException();
        VerifyLegacyProofSignature(key, created, RequiredProofText(row, "signature"), payload);
    }

    private static JsonElement ParseLegacyTransparencyRecord(string row)
    {
        using var document = JsonDocument.Parse(row, new JsonDocumentOptions { AllowDuplicateProperties = false });
        return document.RootElement.Clone();
    }

    private static string LegacyLogString(string name, string value) =>
        name + ":s:" + Convert.ToBase64String(Encoding.UTF8.GetBytes(value.Trim().Normalize(NormalizationForm.FormC))) + "\n";

    private static long LegacyJsonInt(JsonElement row, string name) => row.GetProperty(name).GetInt64();
    private static DateTimeOffset LegacyLogTime(JsonElement row, string name)
    {
        if (DateTimeOffset.TryParseExact(RequiredProofText(row, name), LegacyRightsTimestampFormats,
                CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var utc))
            return utc;
        throw new FormatException();
    }
}
