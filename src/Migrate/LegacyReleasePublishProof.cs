using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using FsusBlog.V2.Core.Integrity;
using Npgsql;

internal static partial class Migration
{
    private const string LegacyProofInput = "FSUSBLOG_LEGACY_V1_PROOF";
    private const string LegacyProofKeyInput = "FSUSBLOG_LEGACY_V1_PROOF_KEY";
    private const string LegacyProofAlgorithm = "ECDSA_P256_SHA256";

    private sealed record LegacyVerifiedPublishProof(int ArticleId, long RevisionId, int Revision, string Hash, byte[] Payload);
    private sealed record LegacyPublishProofKey(string KeyId, int Version, string Algorithm, string PublicKey,
        DateTimeOffset NotBeforeUtc, DateTimeOffset? NotAfterUtc, DateTimeOffset? RevokedAtUtc, DateTimeOffset? CompromisedAtUtc);

    private static async Task<(string Publish, string Rights)> ReadLegacyReleasePublishProofAsync(NpgsqlConnection db, NpgsqlTransaction tx,
        ImportPlan plan, bool rollback, CancellationToken ct)
    {
        try
        {
            var external = await ReadLegacyProofFileAsync(LegacyProofInput, ct);
            var keyBytes = await ReadLegacyProofFileAsync(LegacyProofKeyInput, ct);
            var observed = plan.PublishProofs;
            if (external is null && keyBytes is null && observed is null) return ("{}", "{}");
            if (!rollback || keyBytes is null || (observed is null) == (external is null) ||
                observed is not null && Convert.ToHexStringLower(SHA256.HashData(keyBytes)) != observed.KeysSha256)
                throw new FormatException();

            var keys = ReadLegacyPublishProofKeys(keyBytes);
            var records = observed is null ? [external!] : observed.Rows.Select(Encoding.UTF8.GetBytes).ToArray();
            var archived = new Dictionary<long, object>();
            var entries = observed is null ? null : VerifyLegacyTransparency(observed, keys);
            foreach (var rowBytes in records)
            {
                var proof = VerifyLegacyPublishProof(rowBytes, keys);
                await using var query = new NpgsqlCommand($"""
                    SELECT p.source_publication_id FROM {ImportSchema}.shadow_publication p
                    JOIN {ImportSchema}.shadow_article_rights_snapshot r ON r.id=p.source_rights_snapshot_id
                    WHERE p.article_id=$1 AND p.source_revision_id=$2 AND p.revision=$3 AND r.content_canonical_hash=$4
                    """, db, tx);
                query.Parameters.AddWithValue(proof.ArticleId);
                query.Parameters.AddWithValue(proof.RevisionId);
                query.Parameters.AddWithValue(proof.Revision);
                query.Parameters.AddWithValue("sha256:" + proof.Hash);
                if (await query.ExecuteScalarAsync(ct) is not long publicationId || !archived.TryAdd(publicationId,
                    new LegacyArchivedProof(rowBytes, keyBytes, proof.Payload, entries?.GetValueOrDefault((LegacyPublishProofKind, proof.RevisionId)))))
                    throw new FormatException();
            }
            string rights = "{}";
            if (observed?.RightsProof is { } rawRights)
            {
                var proof = ParseLegacyTransparencyRecord(rawRights);
                var parent = LegacyRightsProofParent(observed.Rows, proof);
                var signed = VerifyLegacyRightsProof(proof, parent, keys);
                var transparency = entries![(LegacyRightsProofKind, LegacyJsonInt(proof, "article_revision_id"))];
                var publicationId = await BindLegacyReleaseRightsProofAsync(db, tx, proof, parent, ct);
                rights = JsonSerializer.Serialize(new Dictionary<long, LegacyArchivedProof>
                {
                    [publicationId] = new(Encoding.UTF8.GetBytes(rawRights), keyBytes, signed, transparency)
                }, OwnerMapJson);
            }
            return (JsonSerializer.Serialize(archived, OwnerMapJson), rights);
        }
        catch (Exception error) when (IsLegacyPublishProofError(error))
        {
            throw new InvalidOperationException("Legacy V1 publish proof, reviewed key or release binding could not be verified.", error);
        }
    }

    private static Dictionary<string, LegacyPublishProofKey> ReadLegacyPublishProofKeys(byte[] bytes)
    {
        using var document = JsonDocument.Parse(bytes);
        var root = document.RootElement;
        var keys = root.ValueKind == JsonValueKind.Array ? root.Deserialize<LegacyPublishProofKey[]>(OwnerMapJson) :
            [root.Deserialize<LegacyPublishProofKey>(OwnerMapJson)!];
        return keys is { Length: >= 1 and <= 32 } && keys.All(key => !string.IsNullOrWhiteSpace(key?.KeyId)) ?
            keys.ToDictionary(key => key.KeyId, StringComparer.Ordinal) : throw new FormatException();
    }

    private static LegacyVerifiedPublishProof VerifyLegacyPublishProof(byte[] rowBytes,
        Dictionary<string, LegacyPublishProofKey> keys)
    {
        using var row = JsonDocument.Parse(rowBytes, new JsonDocumentOptions { AllowDuplicateProperties = false });
        var proof = row.RootElement;
        var key = keys[RequiredProofText(proof, "signing_key_id")];
        var article = proof.GetProperty("article_id").GetInt32();
        var revisionId = proof.GetProperty("article_revision_id").GetInt64();
        var revisionNo = proof.GetProperty("revision_no").GetInt32();
        if (!DateTimeOffset.TryParseExact(RequiredProofText(proof, "published_at"), LegacyRightsTimestampFormats,
            CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var issued) ||
            proof.GetProperty("id").GetInt64() <= 0 || article <= 0 || revisionId <= 0 || revisionNo <= 0 ||
            proof.GetProperty("proof_version").GetInt32() != 1 || proof.GetProperty("signature_payload_version").GetInt32() != 1 ||
            RequiredProofText(proof, "proof_status") is not ("ready" or "superseded") ||
            key.Version != proof.GetProperty("signing_key_version").GetInt32() ||
            key.Algorithm != RequiredProofText(proof, "signing_algorithm"))
            throw new FormatException();
        var fields = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["articleId"] = article.ToString(CultureInfo.InvariantCulture),
            ["articleRevisionId"] = revisionId.ToString(CultureInfo.InvariantCulture),
            ["proofVersion"] = "1",
            ["revisionNo"] = revisionNo.ToString(CultureInfo.InvariantCulture),
            ["signaturePayloadVersion"] = "1"
        };
        var canonical = ReadLegacyProofHash(proof, "canonical_hash");
        var record = FormattableString.Invariant($"""
            fsusblog.integrity.publish-proof-record.v1
            proofVersion:i:1
            signaturePayloadVersion:i:1
            articleId:i:{article}
            articleRevisionId:i:{revisionId}
            revisionNo:i:{revisionNo}
            canonicalHash:h:{canonical}
            aotHash:h:{ReadLegacyProofHash(proof, "aot_hash")}
            articleDetailAedsHash:h:{ReadLegacyProofHash(proof, "article_detail_aeds_hash")}
            publicHotReadHash:h:{ReadLegacyProofHash(proof, "public_hot_read_hash")}
            assetManifestHash:h:{ReadLegacyProofHash(proof, "asset_manifest_hash")}
            feedHash:h:{ReadLegacyProofHash(proof, "feed_hash")}
            publishedAt:t:{issued:yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'}
            proofStatus:s:ready

            """);
        var payload = SiteProofPayload.Canonicalize("publish-proof", FormattableString.Invariant($"article:{article}:revision:{revisionId}"),
            Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(record))), issued, fields);
        VerifyLegacyProofSignature(key, issued, RequiredProofText(proof, "signature"), payload);
        return new(article, revisionId, revisionNo, canonical, payload);
    }

    private sealed record LegacyArchivedProof(byte[] SourceRow, byte[] TrustedKey, byte[] SignedPayload,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] LegacyArchivedTransparency? Transparency);

    private static void VerifyLegacyProofSignature(LegacyPublishProofKey key, DateTimeOffset issued, string signatureText,
        byte[] payload)
    {
        if (key.Version <= 0 || key.Algorithm != LegacyProofAlgorithm || key.NotBeforeUtc == default ||
            issued < key.NotBeforeUtc || issued > key.NotAfterUtc || issued >= key.RevokedAtUtc || key.CompromisedAtUtc.HasValue)
            throw new FormatException();
        var der = ReadCanonicalBase64Url(key.PublicKey, 32, 256);
        var signature = ReadCanonicalBase64Url(signatureText, 86, 86);
        using var verifier = ECDsa.Create();
        verifier.ImportSubjectPublicKeyInfo(der, out var read);
        if (read != der.Length || verifier.ExportParameters(false).Curve.Oid.Value != "1.2.840.10045.3.1.7" ||
            !verifier.VerifyData(payload, signature, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation))
            throw new FormatException();
    }

    private static bool IsLegacyPublishProofError(Exception error) => error is
        IOException or UnauthorizedAccessException or FormatException or JsonException or KeyNotFoundException or
        CryptographicException or ArgumentException or InvalidOperationException;

    private static async Task<byte[]?> ReadLegacyProofFileAsync(string variable, CancellationToken ct)
    {
        var path = Environment.GetEnvironmentVariable(variable);
        var digest = Environment.GetEnvironmentVariable(variable + "_SHA256");
        if (path is null && digest is null) return null;
        if (path is null || !IsSha256(digest)) throw new FormatException();
        await using var file = OpenLegacyMediaReviewFile(path);
        if (file.Length is < 1 or > 8192) throw new FormatException();
        var bytes = new byte[(int)file.Length];
        await file.ReadExactlyAsync(bytes, ct);
        if (file.ReadByte() != -1 || Convert.ToHexStringLower(SHA256.HashData(bytes)) != digest) throw new FormatException();
        return bytes;
    }

    private static string RequiredProofText(JsonElement proof, string name) =>
        proof.GetProperty(name).GetString() ?? throw new FormatException();

    private static string ReadLegacyProofHash(JsonElement proof, string name)
    {
        var value = RequiredProofText(proof, name).Trim();
        if (value.StartsWith("sha256:", StringComparison.OrdinalIgnoreCase)) value = value["sha256:".Length..];
        if (value.Length != 64 || !value.All(char.IsAsciiHexDigit)) throw new FormatException();
        return value.ToLowerInvariant();
    }
}
