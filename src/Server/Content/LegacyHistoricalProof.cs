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
    private const string RightsProofKind = "article-rights-proof";
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = false, AllowDuplicateProperties = false, UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };

    private sealed record ArchivedPublicKey(string KeyId, int Version, string Algorithm, string PublicKey,
        DateTimeOffset NotBeforeUtc, DateTimeOffset? NotAfterUtc, DateTimeOffset? RevokedAtUtc, DateTimeOffset? CompromisedAtUtc);
    private sealed record LogEntry([property: JsonIgnore] long Id, long Seq, string EntryType,
        [property: JsonNumberHandling(JsonNumberHandling.WriteAsString)] long ProofId, int ArticleId,
        [property: JsonNumberHandling(JsonNumberHandling.WriteAsString)] long ArticleRevisionId, int RevisionNo, string EntryPayloadHash, string PrevEntryHash, string EntryHash,
        DateTimeOffset CreatedAtUtc, string SigningKeyId, string Signature);

    private sealed record RightsClaims(string ArticleRightsSnapshotId, string PublishProofId, string RightsPolicyHash, string ContentCanonicalHash);
    private sealed record ArchivedSignature(JsonElement Source, long Id, ArchivedPublicKey Key, DateTimeOffset SignedAt,
        byte[] Payload, string Signature, RightsClaims? Rights);
    private sealed record ArchiveManifest(int ManifestVersion, string Kind, int ArticleId, int RevisionNo, string ArticleRevisionId,
        string ProofId, DateTimeOffset SignedAtUtc, byte[] SignedPayload, string Signature, ArchivedPublicKey Key, object Transparency,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] RightsClaims? Rights);

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

    internal byte[]? Verify(byte[] input, int articleId, int revisionNo, bool rights) =>
        ReadVerified(input, articleId, revisionNo, rights) is { } manifest ? JsonSerializer.SerializeToUtf8Bytes(manifest, Json) : null;

    internal bool CanLink(byte[] input, int articleId, int revisionNo, bool rights) =>
        ReadVerified(input, articleId, revisionNo, rights) is not null;

    private ArchiveManifest? ReadVerified(byte[] input, int articleId, int revisionNo, bool rights)
    {
        try
        {
            var evidence = ReadJson(input);
            var archive = evidence.GetProperty(rights ? "rightsProof" : "publishProof");
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

            var original = Number(evidence, "revisionId");
            if (original <= 0 || Number(evidence, "publicationId") <= 0) return null;
            var parentArchive = rights ? evidence.GetProperty("publishProof") : default;
            var parent = rights ? VerifyArchivedSignature(parentArchive, articleId, original, revisionNo, registry, null) : null;
            var proof = VerifyArchivedSignature(archive, articleId, original, revisionNo, registry, parent);
            var rows = evidence.GetProperty("entries");
            if (rows.GetArrayLength() is < 1 or > 6) return null;
            var chain = rows.EnumerateArray().Select(row => ReadEntry(ReadJson(row.GetBytesFromBase64())))
                .OrderBy(entry => entry.Seq).ToArray();
            var selected = ReadEntry(ReadJson(transparency.GetProperty("sourceRow").GetBytesFromBase64()));
            if (!MatchesEntry(chain, selected, proof, rights ? RightsProofKind : ProofKind, articleId, original, revisionNo))
                return null;
            if (parent is not null)
            {
                var parentTransparency = parentArchive.GetProperty("transparency");
                var parentEntry = ReadEntry(ReadJson(parentTransparency.GetProperty("sourceRow").GetBytesFromBase64()));
                if (parentEntry.Seq >= selected.Seq ||
                    !MatchesEntry(chain, parentEntry, parent, ProofKind, articleId, original, revisionNo))
                    return null;
            }

            var (root, head) = VerifyChain(chain, articleId);
            var anchor = ReadJson(checkpoint);
            var scope = Required(anchor, "scope_key");
            var signedCheckpointAt = Time(anchor, "created_at");
            var count = chain.Length;
            var manifest = new LegacyTransparencyCheckpoint(1, "release", scope, root, 1, count, count, count, head, signedCheckpointAt);
            if (scope.Length is < 1 or > 64 || Required(anchor, "checkpoint_kind") != "release" ||
                Required(anchor, "root_hash") != root || Required(anchor, "log_head_hash") != head ||
                Number(anchor, "from_seq") != 1 || Number(anchor, "to_seq") != count || Number(anchor, "log_head_seq") != count ||
                Number(anchor, "entry_count") != count || JsonSerializer.Deserialize<LegacyTransparencyCheckpoint>(Required(anchor, "manifest_json"), Json) != manifest)
                return null;
            var checkpointKey = registry[Required(anchor, "signing_key_id")];
            var checkpointSignature = Required(anchor, "signature");
            var (digest, checkpointPayload) = LegacyTransparencyPayload.CheckpointSigningPayload(manifest);
            if (Required(anchor, "manifest_hash") != digest || Required(anchor, "signing_algorithm") != checkpointKey.Algorithm ||
                !VerifySignature(checkpointKey, signedCheckpointAt, checkpointPayload, checkpointSignature))
                return null;

            var transparencyManifest = new { entrySeq = selected.Seq, chain, checkpoint = manifest,
                signedPayload = checkpointPayload, signature = checkpointSignature, key = checkpointKey };
            return new ArchiveManifest(1,
                rights ? "legacy-v1-article-rights-proof-archive" : "legacy-v1-publication-proof-archive", articleId, revisionNo,
                Decimal(original), Decimal(proof.Id), proof.SignedAt, proof.Payload, proof.Signature, proof.Key, transparencyManifest, proof.Rights);
        }
        catch (Exception error) when (error is InvalidOperationException or ArgumentException or FormatException or
            KeyNotFoundException or JsonException or CryptographicException)
        {
            return null;
        }
    }

    private ArchivedSignature VerifyArchivedSignature(JsonElement archive, int article, long revision, int number,
        IReadOnlyDictionary<string, ArchivedPublicKey> registry, ArchivedSignature? parent)
    {
        var source = ReadJson(archive.GetProperty("sourceRow").GetBytesFromBase64());
        var proofId = Number(source, "id");
        var signature = Required(source, "signature");
        var key = registry[Required(source, "signing_key_id")];
        var payload = archive.GetProperty("signedPayload").GetBytesFromBase64();
        var lines = Encoding.UTF8.GetString(payload).Split('\n');
        const string digestField = "digestSha256:h:";
        if (proofId <= 0 || Number(source, "article_id") != article || Number(source, "article_revision_id") != revision ||
            Number(source, "revision_no") != number || Required(source, "proof_status") is not ("ready" or "superseded") ||
            Number(source, "proof_version") != 1 || Number(source, "signature_payload_version") != 1 ||
            Number(source, "signing_key_version") != key.Version || Required(source, "signing_algorithm") != key.Algorithm ||
            lines.Length < 6 || !lines[4].StartsWith(digestField, StringComparison.Ordinal) || !IsHash(lines[4][digestField.Length..]))
            throw new FormatException();

        var digest = lines[4][digestField.Length..];
        var issued = parent?.SignedAt ?? Time(source, "published_at");
        var subject = FormattableString.Invariant($"article:{article}:revision:{revision}");
        var fields = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["articleId"] = Decimal(article), ["articleRevisionId"] = Decimal(revision), ["proofVersion"] = "1",
            ["revisionNo"] = Decimal(number), ["signaturePayloadVersion"] = "1"
        };
        RightsClaims? claims = null;
        if (parent is not null)
        {
            var snapshot = Number(source, "article_rights_snapshot_id");
            var policy = Required(source, "rights_policy_hash");
            var content = Required(source, "content_canonical_hash");
            if (snapshot <= 0 || Number(source, "publish_proof_id") != parent.Id || !IsHash(policy) || !IsHash(content) ||
                !string.Equals(Required(parent.Source, "canonical_hash").Replace("sha256:", "", StringComparison.OrdinalIgnoreCase),
                    content, StringComparison.OrdinalIgnoreCase))
                throw new FormatException();
            var record = FormattableString.Invariant($"""
                fsusblog.integrity.article-rights-proof-record.v1
                proofVersion:i:1
                signaturePayloadVersion:i:1
                articleId:i:{article}
                articleRevisionId:i:{revision}
                revisionNo:i:{number}
                articleRightsSnapshotId:i:{snapshot}
                publishProofId:i:{parent.Id}
                rightsPolicyHash:h:{policy}
                contentCanonicalHash:h:{content}
                issuedAt:t:{issued:yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'}
                proofStatus:s:ready

                """);
            if (Digest(Encoding.UTF8.GetBytes(record)) != digest) throw new FormatException();
            subject += ":rights:" + Decimal(snapshot);
            fields["articleRightsSnapshotId"] = Decimal(snapshot);
            fields["publishProofId"] = Decimal(parent.Id);
            claims = new(Decimal(snapshot), Decimal(parent.Id), "sha256:" + policy, "sha256:" + content);
        }
        var signed = SiteProofPayload.Canonicalize(parent is null ? ProofKind : RightsProofKind, subject, digest, issued, fields);
        if (!signed.AsSpan().SequenceEqual(payload) || !VerifySignature(key, issued, signed, signature)) throw new FormatException();
        return new(source, proofId, key, issued, payload, signature, claims);
    }

    private static bool MatchesEntry(LogEntry[] chain, LogEntry entry, ArchivedSignature proof, string kind, int article, long revision, int number) =>
        entry.EntryType == kind && chain.Contains(entry) && entry.Id == Number(proof.Source, "transparency_log_entry_id") &&
        entry.EntryHash == Required(proof.Source, "transparency_log_entry_hash") && entry.ProofId == proof.Id &&
        entry.ArticleId == article && entry.ArticleRevisionId == revision && entry.RevisionNo == number &&
        entry.SigningKeyId == proof.Key.KeyId && entry.Signature == proof.Signature;

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
        var published = new HashSet<(long RevisionId, int RevisionNo)>();
        var rights = new HashSet<(long RevisionId, int RevisionNo)>();
        foreach (var entry in chain)
        {
            if (entry.ArticleId != article || entry.Id <= 0 || entry.ProofId <= 0 || entry.ArticleRevisionId <= 0 || entry.RevisionNo <= 0 ||
                entry.Seq != leaves.Count + 1 || entry.PrevEntryHash != previous || !IsHash(entry.EntryPayloadHash) ||
                !ArticlePublicationProofPayloadV2.ValidKeyId(entry.SigningKeyId) ||
                entry.Signature.Length != 86 || entry.Signature.Any(ch => !char.IsAsciiLetterOrDigit(ch) && ch is not ('-' or '_')))
                throw new FormatException();
            var revision = (entry.ArticleRevisionId, entry.RevisionNo);
            if (entry.EntryType == ProofKind)
            {
                if (published.Count == 3 || !published.Add(revision)) throw new FormatException();
            }
            else
            {
                if (!published.Contains(revision) || !rights.Add(revision)) throw new FormatException();
            }

            var (hash, leaf) = LegacyTransparencyPayload.HashProofEntry(new(entry.Seq, entry.EntryType, entry.ProofId, entry.ArticleId,
                entry.ArticleRevisionId, entry.RevisionNo, entry.EntryPayloadHash, previous, entry.CreatedAtUtc, entry.SigningKeyId, entry.Signature));
            if (entry.EntryHash != hash) throw new FormatException();
            leaves.Add(leaf);
            previous = hash;
        }
        return (LegacyTransparencyPayload.MerkleRoot(leaves), previous);
    }

    private static LogEntry ReadEntry(JsonElement row)
    {
        var kind = Required(row, "entry_type");
        if (kind is not (ProofKind or RightsProofKind)) throw new FormatException();
        return new(Number(row, "id"), Number(row, "seq"), kind, Number(row, "proof_id"), row.GetProperty("article_id").GetInt32(),
            Number(row, "article_revision_id"), row.GetProperty("revision_no").GetInt32(),
            Required(row, "entry_payload_hash"), Required(row, "prev_entry_hash"), Required(row, "entry_hash"),
            Time(row, "created_at"), Required(row, "signing_key_id"), Required(row, "signature"));
    }

    private static JsonElement ReadJson(byte[] value)
    {
        using var document = JsonDocument.Parse(value, new JsonDocumentOptions { AllowDuplicateProperties = false, MaxDepth = 12 });
        return document.RootElement.Clone();
    }

    private static string Decimal(long value) => value.ToString(CultureInfo.InvariantCulture);
    private static long Number(JsonElement row, string field) => row.GetProperty(field).GetInt64();
    private static string Required(JsonElement row, string field) => row.GetProperty(field).GetString() ?? throw new FormatException();
    private static DateTimeOffset Time(JsonElement row, string field) => DateTimeOffset.ParseExact(Required(row, field),
        ["yyyy-MM-dd'T'HH:mm:ssK", "yyyy-MM-dd'T'HH:mm:ss.FFFFFFFK"], CultureInfo.InvariantCulture,
        DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal);
    private static string Digest(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));
    private static bool IsHash(string? text) => text is { Length: 64 } && text.All(char.IsAsciiHexDigitLower);
}
