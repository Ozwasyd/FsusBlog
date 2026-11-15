using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core.Integrity;
using Microsoft.AspNetCore.WebUtilities;

namespace FsusBlog.V2.Server.Content;

internal sealed class LegacyHistoricalProof(IConfigurationSection settings, string keyPin, string checkpointPin)
{
    private const string Algorithm = "ECDSA_P256_SHA256";
    private const string ProofKind = "publish-proof";
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = false, AllowDuplicateProperties = false, UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };

    private sealed record ArchivedPublicKey(string KeyId, int Version, string Algorithm, string PublicKey,
        DateTimeOffset NotBeforeUtc, DateTimeOffset? NotAfterUtc, DateTimeOffset? RevokedAtUtc, DateTimeOffset? CompromisedAtUtc);
    private sealed record LogEntry([property: JsonIgnore] long Id, long Seq, long ProofId, int ArticleId, long ArticleRevisionId, int RevisionNo,
        string EntryPayloadHash, string PrevEntryHash, string EntryHash, DateTimeOffset CreatedAtUtc, string SigningKeyId, string Signature)
    {
        public string EntryType => ProofKind;

        internal string Coordinates() => FormattableString.Invariant(
            $"proofId:i:{ProofId}\narticleId:i:{ArticleId}\narticleRevisionId:i:{ArticleRevisionId}\nrevisionNo:i:{RevisionNo}\n");
    }
    private sealed record Checkpoint(int ManifestVersion, string CheckpointKind, string ScopeKey, string RootHash,
        long FromSeq, long ToSeq, int EntryCount, long LogHeadSeq, string LogHeadHash, DateTimeOffset CreatedAtUtc);

    internal static LegacyHistoricalProof? ReadConfiguration(IConfiguration configuration)
    {
        var settings = configuration.GetSection("IntegrityProof:HistoricalV1");
        var keys = settings["KeysSha256"];
        var checkpoint = settings["CheckpointSha256"];
        if (keys is null && checkpoint is null) return null;
        if (!IsHash(keys) || !IsHash(checkpoint))
            throw new InvalidOperationException("Historical V1 proofs require independent SHA-256 pins for the reviewed keys and checkpoint.");
        return new(settings, keys!, checkpoint!);
    }

    internal byte[]? Verify(byte[] input, int articleId, int revisionNo)
    {
        try
        {
            var evidence = ReadJson(input);
            var archive = evidence.GetProperty("proof");
            var transparency = archive.GetProperty("transparency");
            var keys = archive.GetProperty("trustedKey").GetBytesFromBase64();
            var checkpoint = transparency.GetProperty("checkpoint").GetBytesFromBase64();
            if (Digest(keys) != keyPin || Digest(checkpoint) != checkpointPin) return null;
            var keyset = ReadJson(keys);
            var publicKeys = keyset.ValueKind == JsonValueKind.Array ? keyset.Deserialize<ArchivedPublicKey[]>(Json) :
                [keyset.Deserialize<ArchivedPublicKey>(Json)!];
            if (publicKeys is not { Length: >= 1 and <= 32 } || publicKeys.Any(key => string.IsNullOrWhiteSpace(key?.KeyId)))
                return null;
            var registry = publicKeys.ToDictionary(key => key.KeyId, StringComparer.Ordinal);

            var source = ReadJson(archive.GetProperty("sourceRow").GetBytesFromBase64());
            var original = Number(evidence, "revisionId");
            var publication = Number(evidence, "publicationId");
            var proofId = Number(source, "id");
            var signedAt = Time(source, "published_at");
            var signature = Required(source, "signature");
            var key = registry[Required(source, "signing_key_id")];
            var status = Required(source, "proof_status");
            var payload = archive.GetProperty("signedPayload").GetBytesFromBase64();
            var lines = Encoding.UTF8.GetString(payload).Split('\n');
            const string digestField = "digestSha256:h:";
            if (proofId <= 0 || original <= 0 || publication <= 0 || Number(source, "article_id") != articleId ||
                Number(source, "article_revision_id") != original || Number(source, "revision_no") != revisionNo ||
                status is not ("ready" or "superseded") || Number(source, "proof_version") != 1 ||
                Number(source, "signature_payload_version") != 1 || Number(source, "signing_key_version") != key.Version ||
                Required(source, "signing_algorithm") != key.Algorithm ||
                lines.Length < 6 || !lines[4].StartsWith(digestField, StringComparison.Ordinal) || !IsHash(lines[4][digestField.Length..]))
                return null;
            var signed = SiteProofPayload.Canonicalize(ProofKind, FormattableString.Invariant($"article:{articleId}:revision:{original}"),
                lines[4][digestField.Length..], signedAt, new Dictionary<string, string>(StringComparer.Ordinal)
                {
                    ["articleId"] = articleId.ToString(CultureInfo.InvariantCulture), ["articleRevisionId"] = original.ToString(CultureInfo.InvariantCulture),
                    ["proofVersion"] = "1", ["revisionNo"] = revisionNo.ToString(CultureInfo.InvariantCulture), ["signaturePayloadVersion"] = "1"
                });
            if (!signed.AsSpan().SequenceEqual(payload) || !VerifySignature(key, signedAt, signed, signature)) return null;

            var rows = evidence.GetProperty("entries");
            if (rows.GetArrayLength() is < 1 or > 3) return null;
            var chain = rows.EnumerateArray().Select(row => ReadEntry(ReadJson(row.GetBytesFromBase64())))
                .OrderBy(entry => entry.Seq).ToArray();
            var selected = ReadEntry(ReadJson(transparency.GetProperty("sourceRow").GetBytesFromBase64()));
            if (!chain.Contains(selected) || selected.Id != Number(source, "transparency_log_entry_id") ||
                selected.EntryHash != Required(source, "transparency_log_entry_hash") || selected.ProofId != proofId ||
                selected.ArticleId != articleId || selected.ArticleRevisionId != original || selected.RevisionNo != revisionNo ||
                selected.SigningKeyId != key.KeyId || selected.Signature != signature)
                return null;

            var (root, head) = VerifyChain(chain, articleId);
            var anchor = ReadJson(checkpoint);
            var scope = Required(anchor, "scope_key");
            var signedCheckpointAt = Time(anchor, "created_at");
            var count = chain.Length;
            var manifest = new Checkpoint(1, "release", scope, root, 1, count, count, count, head, signedCheckpointAt);
            if (scope.Length is < 1 or > 64 || Required(anchor, "checkpoint_kind") != "release" ||
                Required(anchor, "root_hash") != root || Required(anchor, "log_head_hash") != head ||
                Number(anchor, "from_seq") != 1 || Number(anchor, "to_seq") != count || Number(anchor, "log_head_seq") != count ||
                Number(anchor, "entry_count") != count || JsonSerializer.Deserialize<Checkpoint>(Required(anchor, "manifest_json"), Json) != manifest)
                return null;
            var checkpointKey = registry[Required(anchor, "signing_key_id")];
            var checkpointSignature = Required(anchor, "signature");
            var bound = count.ToString(CultureInfo.InvariantCulture);
            var checkpointPayload = SiteProofPayload.Canonicalize("merkle-checkpoint", $"checkpoint:release:{scope}",
                Required(anchor, "manifest_hash"), signedCheckpointAt, new Dictionary<string, string>(StringComparer.Ordinal)
                {
                    ["checkpointKind"] = "release", ["entryCount"] = bound, ["fromSeq"] = "1",
                    ["logHeadHash"] = head, ["logHeadSeq"] = bound, ["manifestVersion"] = "1",
                    ["rootHash"] = root, ["scopeKey"] = scope, ["toSeq"] = bound
                });
            if (Required(anchor, "signing_algorithm") != checkpointKey.Algorithm ||
                !VerifySignature(checkpointKey, signedCheckpointAt, checkpointPayload, checkpointSignature))
                return null;

            return JsonSerializer.SerializeToUtf8Bytes(new
            {
                manifestVersion = 1, kind = "legacy-v1-publication-proof-archive",
                articleId, revisionNo, articleRevisionId = original, proofId,
                signedAtUtc = signedAt, signedPayload = payload, signature, key,
                transparency = new { entrySeq = selected.Seq, chain, checkpoint = manifest,
                    signedPayload = checkpointPayload, signature = checkpointSignature, key = checkpointKey }
            }, Json);
        }
        catch (Exception error) when (error is InvalidOperationException or ArgumentException or FormatException or
            KeyNotFoundException or JsonException or CryptographicException)
        {
            return null;
        }
    }

    private bool VerifySignature(ArchivedPublicKey key, DateTimeOffset issued, byte[] payload, string signature)
    {
        if (key is not { Version: > 0, Algorithm: Algorithm, CompromisedAtUtc: null } ||
            !ArticlePublicationProofPayloadV2.ValidKeyId(key.KeyId) || key.NotBeforeUtc == default || issued < key.NotBeforeUtc ||
            issued > key.NotAfterUtc || issued >= key.RevokedAtUtc ||
            settings.GetSection("BlockedKeyIds")[key.KeyId] is { } blocked && !string.Equals(blocked, "false", StringComparison.OrdinalIgnoreCase))
            return false;
        var der = WebEncoders.Base64UrlDecode(key.PublicKey);
        var bytes = WebEncoders.Base64UrlDecode(signature);
        if (bytes.Length != 64 || WebEncoders.Base64UrlEncode(bytes) != signature || WebEncoders.Base64UrlEncode(der) != key.PublicKey)
            return false;
        using var verifier = ECDsa.Create();
        verifier.ImportSubjectPublicKeyInfo(der, out var read);
        return read == der.Length && verifier.ExportParameters(false).Curve.Oid.Value == "1.2.840.10045.3.1.7" &&
            verifier.VerifyData(payload, bytes, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
    }

    private static (string Root, string Head) VerifyChain(LogEntry[] chain, int article)
    {
        string previous = new('0', 64);
        var leaves = new List<string>(chain.Length);
        foreach (var entry in chain)
        {
            var coordinates = entry.Coordinates();
            if (entry.ArticleId != article || entry.Id <= 0 || entry.ProofId <= 0 || entry.ArticleRevisionId <= 0 || entry.RevisionNo <= 0 ||
                entry.Seq != leaves.Count + 1 || entry.PrevEntryHash != previous || !IsHash(entry.EntryPayloadHash) ||
                !ArticlePublicationProofPayloadV2.ValidKeyId(entry.SigningKeyId) ||
                entry.Signature.Length != 86 || entry.Signature.Any(ch => !char.IsAsciiLetterOrDigit(ch) && ch is not ('-' or '_')))
                throw new FormatException();
            var transcript = FormattableString.Invariant($"""
                fsusblog.integrity.transparency-log-entry.v1
                seq:i:{entry.Seq}
                {Field("entryType", ProofKind)}{coordinates}entryPayloadHash:h:{entry.EntryPayloadHash}
                prevEntryHash:h:{previous}
                createdAt:t:{entry.CreatedAtUtc:yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'}
                {Field("signingKeyId", entry.SigningKeyId)}{Field("signature", entry.Signature)}
                """);
            if (entry.EntryHash != Digest(Encoding.UTF8.GetBytes(transcript))) throw new FormatException();
            leaves.Add(Digest(Encoding.UTF8.GetBytes(FormattableString.Invariant(
                $"fsusblog.integrity.merkle-leaf.v1\nseq:i:{entry.Seq}\nlogEntryHash:h:{entry.EntryHash}\n{coordinates}"))));
            previous = entry.EntryHash;
        }
        while (leaves.Count > 1)
        {
            var parents = new List<string>((leaves.Count + 1) / 2);
            for (int i = 0; i < leaves.Count; i += 2)
                parents.Add(Digest(Encoding.UTF8.GetBytes($"fsusblog.integrity.merkle-node.v1\nleft:h:{leaves[i]}\nright:h:{leaves[Math.Min(i + 1, leaves.Count - 1)]}\n")));
            leaves = parents;
        }
        return (leaves[0], previous);
    }

    private static LogEntry ReadEntry(JsonElement row)
    {
        if (Required(row, "entry_type") != ProofKind) throw new FormatException();
        return new(Number(row, "id"), Number(row, "seq"), Number(row, "proof_id"), row.GetProperty("article_id").GetInt32(),
            Number(row, "article_revision_id"), row.GetProperty("revision_no").GetInt32(),
            Required(row, "entry_payload_hash"), Required(row, "prev_entry_hash"), Required(row, "entry_hash"),
            Time(row, "created_at"), Required(row, "signing_key_id"), Required(row, "signature"));
    }

    private static JsonElement ReadJson(byte[] value)
    {
        using var document = JsonDocument.Parse(value, new JsonDocumentOptions { AllowDuplicateProperties = false, MaxDepth = 12 });
        return document.RootElement.Clone();
    }

    private static long Number(JsonElement row, string field) => row.GetProperty(field).GetInt64();
    private static string Required(JsonElement row, string field) => row.GetProperty(field).GetString() ?? throw new FormatException();
    private static DateTimeOffset Time(JsonElement row, string field) => DateTimeOffset.ParseExact(Required(row, field),
        ["yyyy-MM-dd'T'HH:mm:ssK", "yyyy-MM-dd'T'HH:mm:ss.FFFFFFFK"], CultureInfo.InvariantCulture,
        DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal);
    private static string Field(string name, string text) => name + ":s:" + Convert.ToBase64String(Encoding.UTF8.GetBytes(text)) + "\n";
    private static string Digest(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));
    private static bool IsHash(string? text) => text is { Length: 64 } && text.All(char.IsAsciiHexDigitLower);
}
