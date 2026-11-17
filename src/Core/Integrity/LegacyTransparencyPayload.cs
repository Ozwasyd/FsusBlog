using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.V2.Core.Integrity;

public readonly record struct LegacyTransparencyProofEntry(long Seq, string EntryType, long ProofId, long ArticleId,
    long ArticleRevisionId, long RevisionNo, string EntryPayloadHash, string PreviousHash, DateTimeOffset CreatedAtUtc,
    string SigningKeyId, string Signature);

public sealed record LegacyTransparencyCheckpoint(int ManifestVersion, string CheckpointKind, string ScopeKey, string RootHash,
    long FromSeq, long ToSeq, int EntryCount, long LogHeadSeq, string LogHeadHash, DateTimeOffset CreatedAtUtc);

public sealed record LegacyTransparencySibling(string Hash, bool IsLeftSibling);

// Cryptographic encoding of frozen V1 data. Scope, membership, and key policy belong to the caller.
public static class LegacyTransparencyPayload
{
    // Release custody supports one rollback article, up to two publications per other article,
    // and rights proofs only for the three rollback article revisions.
    public const int ReleaseArticleLimit = 32;
    public const int ReleasePublicationLimit = 2 * ReleaseArticleLimit + 1;
    public const int ReleaseEntryLimit = ReleasePublicationLimit + 3;

    internal static string RightsProofRecord(long article, long revisionId, long revision, long snapshot, long parentId,
        string policyHash, string contentHash, DateTimeOffset issued) =>
        FormattableString.Invariant($"""
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

    public static (string Entry, string Leaf) HashProofEntry(LegacyTransparencyProofEntry entry)
    {
        var coordinates = FormattableString.Invariant(
            $"proofId:i:{entry.ProofId}\narticleId:i:{entry.ArticleId}\narticleRevisionId:i:{entry.ArticleRevisionId}\nrevisionNo:i:{entry.RevisionNo}\n");
        var transcript = FormattableString.Invariant($"""
            fsusblog.integrity.transparency-log-entry.v1
            seq:i:{entry.Seq}
            {Field("entryType", entry.EntryType)}{coordinates}entryPayloadHash:h:{entry.EntryPayloadHash.ToLowerInvariant()}
            prevEntryHash:h:{entry.PreviousHash.ToLowerInvariant()}
            createdAt:t:{entry.CreatedAtUtc.UtcDateTime:yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'}
            {Field("signingKeyId", entry.SigningKeyId)}{Field("signature", entry.Signature)}
            """);
        var hash = Digest(transcript);
        return (hash, Digest(FormattableString.Invariant(
            $"fsusblog.integrity.merkle-leaf.v1\nseq:i:{entry.Seq}\nlogEntryHash:h:{hash}\n{coordinates}")));
    }

    public static string MerkleRoot(IReadOnlyList<string> leaves)
    {
        if (leaves.Count == 0) return Digest("fsusblog.integrity.merkle-empty.v1\n");
        while (leaves.Count > 1) leaves = Parents(leaves);
        return leaves[0];
    }

    public static LegacyTransparencySibling[] MerkleInclusion(IReadOnlyList<string> leaves, int index)
    {
        if ((uint)index >= (uint)leaves.Count) throw new ArgumentOutOfRangeException(nameof(index));
        var siblings = new List<LegacyTransparencySibling>();
        while (leaves.Count > 1)
        {
            var other = index ^ 1;
            if (other >= leaves.Count) other = index;
            siblings.Add(new(leaves[other], other < index));
            leaves = Parents(leaves);
            index /= 2;
        }
        return siblings.ToArray();
    }

    private static string[] Parents(IReadOnlyList<string> leaves)
    {
        var parents = new string[(leaves.Count + 1) / 2];
        for (int i = 0; i < leaves.Count; i += 2)
            parents[i / 2] = Digest($"fsusblog.integrity.merkle-node.v1\nleft:h:{leaves[i]}\nright:h:{leaves[Math.Min(i + 1, leaves.Count - 1)]}\n");
        return parents;
    }

    public static (string Digest, byte[] Payload) CheckpointSigningPayload(LegacyTransparencyCheckpoint manifest)
    {
        var root = manifest.RootHash.Trim().ToLowerInvariant();
        var head = manifest.LogHeadHash.Trim().ToLowerInvariant();
        var transcript = FormattableString.Invariant($"""
            fsusblog.integrity.merkle-checkpoint-manifest.v1
            manifestVersion:i:{manifest.ManifestVersion}
            {ManifestField("checkpointKind", manifest.CheckpointKind)}{ManifestField("scopeKey", manifest.ScopeKey)}rootHash:h:{root}
            fromSeq:i:{manifest.FromSeq}
            toSeq:i:{manifest.ToSeq}
            entryCount:i:{manifest.EntryCount}
            logHeadSeq:i:{manifest.LogHeadSeq}
            logHeadHash:h:{head}
            createdAt:t:{manifest.CreatedAtUtc.UtcDateTime:yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'}

            """);
        var digest = Digest(transcript);
        var fields = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["checkpointKind"] = manifest.CheckpointKind, ["entryCount"] = Decimal(manifest.EntryCount), ["fromSeq"] = Decimal(manifest.FromSeq),
            ["logHeadHash"] = manifest.LogHeadHash, ["logHeadSeq"] = Decimal(manifest.LogHeadSeq), ["manifestVersion"] = Decimal(manifest.ManifestVersion),
            ["rootHash"] = manifest.RootHash, ["scopeKey"] = manifest.ScopeKey, ["toSeq"] = Decimal(manifest.ToSeq)
        };
        return (digest, SiteProofPayload.Canonicalize("merkle-checkpoint", $"checkpoint:{manifest.CheckpointKind}:{manifest.ScopeKey}",
            digest, manifest.CreatedAtUtc, fields));
    }

    private static string Decimal(long value) => value.ToString(CultureInfo.InvariantCulture);
    private static string Field(string name, string text) =>
        name + ":s:" + Convert.ToBase64String(Encoding.UTF8.GetBytes(text.Trim().Normalize(NormalizationForm.FormC))) + "\n";
    private static string ManifestField(string name, string text) =>
        Field(name, text.Trim().Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n'));
    private static string Digest(string transcript) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(transcript)));
}
