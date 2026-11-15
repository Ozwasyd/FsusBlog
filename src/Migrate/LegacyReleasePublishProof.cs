using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using FsusBlog.V2.Core.Integrity;
using Npgsql;

internal static partial class Migration
{
    private const string LegacyProofInput = "FSUSBLOG_LEGACY_V1_PROOF";
    private const string LegacyProofKeyInput = "FSUSBLOG_LEGACY_V1_PROOF_KEY";
    private const string LegacyProofAlgorithm = "ECDSA_P256_SHA256";

    private sealed record LegacyReleasePublishProof(long PublicationId, string Evidence);
    private sealed record LegacyPublishProofKey(string KeyId, int Version, string Algorithm, string PublicKey,
        DateTimeOffset NotBeforeUtc, DateTimeOffset? NotAfterUtc, DateTimeOffset? RevokedAtUtc, DateTimeOffset? CompromisedAtUtc);

    private static async Task<LegacyReleasePublishProof?> ReadLegacyReleasePublishProofAsync(NpgsqlConnection db,
        NpgsqlTransaction tx, bool rollback, CancellationToken ct)
    {
        try
        {
            var rowBytes = await ReadLegacyProofFileAsync(LegacyProofInput, ct);
            var keyBytes = await ReadLegacyProofFileAsync(LegacyProofKeyInput, ct);
            if (rowBytes is null && keyBytes is null) return null;
            if (!rollback || rowBytes is null || keyBytes is null) throw new FormatException();

            using var row = JsonDocument.Parse(rowBytes, new JsonDocumentOptions { AllowDuplicateProperties = false });
            var proof = row.RootElement;
            var key = JsonSerializer.Deserialize<LegacyPublishProofKey>(keyBytes, OwnerMapJson) ?? throw new FormatException();
            var article = proof.GetProperty("article_id").GetInt32();
            var revisionId = proof.GetProperty("article_revision_id").GetInt64();
            var revisionNo = proof.GetProperty("revision_no").GetInt32();
            if (!DateTimeOffset.TryParseExact(RequiredProofText(proof, "published_at"), LegacyRightsTimestampFormats,
                CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var issued) ||
                proof.GetProperty("id").GetInt64() <= 0 || article <= 0 || revisionId <= 0 || revisionNo <= 0 ||
                proof.GetProperty("proof_version").GetInt32() != 1 || proof.GetProperty("signature_payload_version").GetInt32() != 1 ||
                RequiredProofText(proof, "proof_status") is not ("ready" or "superseded") ||
                string.IsNullOrWhiteSpace(key.KeyId) || key.KeyId != RequiredProofText(proof, "signing_key_id") ||
                key.Version <= 0 || key.Version != proof.GetProperty("signing_key_version").GetInt32() ||
                key.Algorithm != LegacyProofAlgorithm || key.Algorithm != RequiredProofText(proof, "signing_algorithm") ||
                key.NotBeforeUtc == default || issued < key.NotBeforeUtc || issued > key.NotAfterUtc ||
                issued >= key.RevokedAtUtc || key.CompromisedAtUtc.HasValue)
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
            var der = ReadCanonicalBase64Url(key.PublicKey, 32, 256);
            var signature = ReadCanonicalBase64Url(RequiredProofText(proof, "signature"), 86, 86);
            using var verifier = ECDsa.Create();
            verifier.ImportSubjectPublicKeyInfo(der, out var read);
            if (read != der.Length || verifier.ExportParameters(false).Curve.Oid.Value != "1.2.840.10045.3.1.7" ||
                !verifier.VerifyData(payload, signature, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation))
                throw new FormatException();

            await using var query = new NpgsqlCommand($"""
                SELECT p.source_publication_id FROM {ImportSchema}.shadow_publication p
                JOIN {ImportSchema}.shadow_article_rights_snapshot r ON r.id=p.source_rights_snapshot_id
                WHERE p.article_id=$1 AND p.source_revision_id=$2 AND p.revision=$3 AND r.content_canonical_hash=$4
                """, db, tx);
            query.Parameters.AddWithValue(article);
            query.Parameters.AddWithValue(revisionId);
            query.Parameters.AddWithValue(revisionNo);
            query.Parameters.AddWithValue("sha256:" + canonical);
            if (await query.ExecuteScalarAsync(ct) is not long publicationId) throw new FormatException();
            return new(publicationId, JsonSerializer.Serialize(new { sourceRow = rowBytes, trustedKey = keyBytes, signedPayload = payload }));
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or FormatException or
            JsonException or KeyNotFoundException or CryptographicException or ArgumentException or InvalidOperationException)
        {
            throw new InvalidOperationException("Legacy V1 publish proof, reviewed key or release binding could not be verified.", error);
        }
    }

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
