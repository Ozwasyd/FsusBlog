using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Core.Integrity;

public static class MerkleCheckpointKinds
{
    public const string Daily = "daily";
    public const string Release = "release";
}

public sealed record MerkleLeafInput(
    long Seq,
    string LogEntryHash,
    long? ProofId,
    int? ArticleId,
    long? ArticleRevisionId,
    int? RevisionNo);

public sealed record MerkleLeaf(
    long Seq,
    string LogEntryHash,
    long? ProofId,
    int? ArticleId,
    long? ArticleRevisionId,
    int? RevisionNo,
    string LeafHash);

public sealed record MerkleProofSibling(string Hash, bool IsLeftSibling);

public sealed record MerkleInclusionProof(
    long Seq,
    string LeafHash,
    IReadOnlyList<MerkleProofSibling> Siblings);

public sealed record MerkleCheckpointBuildResult(
    string RootHash,
    IReadOnlyList<MerkleLeaf> Leaves)
{
    public bool IsEmpty => Leaves.Count == 0;
}

public static class MerkleCheckpointBuilder
{
    public const string LeafDomainSeparator = "fsusblog.integrity.merkle-leaf.v1";
    public const string NodeDomainSeparator = "fsusblog.integrity.merkle-node.v1";
    public const string EmptyDomainSeparator = "fsusblog.integrity.merkle-empty.v1";

    public static MerkleCheckpointBuildResult Build(
        IEnumerable<MerkleLeafInput> leaves,
        bool preserveInputOrder = false)
    {
        ArgumentNullException.ThrowIfNull(leaves);

        MerkleLeaf[] canonicalLeaves = (preserveInputOrder ? leaves : leaves.OrderBy(static leaf => leaf.Seq))
            .Select(ToLeaf)
            .ToArray();
        string root = canonicalLeaves.Length == 0
            ? ComputeHashHex(Encoding.UTF8.GetBytes(string.Concat(EmptyDomainSeparator, "\n")))
            : BuildRoot(canonicalLeaves.Select(static leaf => leaf.LeafHash).ToArray());
        return new MerkleCheckpointBuildResult(root, canonicalLeaves);
    }

    public static MerkleInclusionProof BuildInclusionProof(MerkleCheckpointBuildResult checkpoint, long seq)
    {
        ArgumentNullException.ThrowIfNull(checkpoint);
        if (checkpoint.Leaves.Count == 0)
        {
            throw new InvalidOperationException("Empty checkpoint has no inclusion proofs.");
        }

        int index = checkpoint.Leaves.ToList().FindIndex(leaf => leaf.Seq == seq);
        if (index < 0)
        {
            throw new InvalidOperationException("Leaf was not found in checkpoint.");
        }

        var siblings = new List<MerkleProofSibling>();
        string[] level = checkpoint.Leaves.Select(static leaf => leaf.LeafHash).ToArray();
        int currentIndex = index;
        while (level.Length > 1)
        {
            int siblingIndex = currentIndex % 2 == 0 ? currentIndex + 1 : currentIndex - 1;
            if (siblingIndex >= level.Length)
            {
                siblingIndex = currentIndex;
            }

            siblings.Add(new MerkleProofSibling(level[siblingIndex], siblingIndex < currentIndex));
            level = BuildNextLevel(level);
            currentIndex /= 2;
        }

        return new MerkleInclusionProof(seq, checkpoint.Leaves[index].LeafHash, siblings);
    }

    private static MerkleLeaf ToLeaf(MerkleLeafInput input)
    {
        ValidateLeaf(input);
        string hash = ComputeHashHex(BuildLeafPayload(input));
        return new MerkleLeaf(
            input.Seq,
            input.LogEntryHash.ToLowerInvariant(),
            input.ProofId,
            input.ArticleId,
            input.ArticleRevisionId,
            input.RevisionNo,
            hash);
    }

    private static string BuildRoot(string[] leafHashes)
    {
        string[] level = leafHashes;
        while (level.Length > 1)
        {
            level = BuildNextLevel(level);
        }

        return level[0];
    }

    private static string[] BuildNextLevel(string[] level)
    {
        var next = new string[(level.Length + 1) / 2];
        for (int i = 0; i < level.Length; i += 2)
        {
            string left = level[i];
            string right = i + 1 < level.Length ? level[i + 1] : left;
            next[i / 2] = HashNode(left, right);
        }

        return next;
    }

    internal static string HashNode(string leftHash, string rightHash)
    {
        ValidateHash(leftHash, nameof(leftHash));
        ValidateHash(rightHash, nameof(rightHash));
        return ComputeHashHex(Encoding.UTF8.GetBytes(string.Concat(
            NodeDomainSeparator,
            "\nleft:h:",
            leftHash.ToLowerInvariant(),
            "\nright:h:",
            rightHash.ToLowerInvariant(),
            "\n")));
    }

    private static byte[] BuildLeafPayload(MerkleLeafInput input)
    {
        var builder = new StringBuilder(384);
        AppendLine(builder, LeafDomainSeparator);
        AppendLong(builder, "seq", input.Seq);
        AppendHash(builder, "logEntryHash", input.LogEntryHash);
        AppendNullableLong(builder, "proofId", input.ProofId);
        AppendNullableInt(builder, "articleId", input.ArticleId);
        AppendNullableLong(builder, "articleRevisionId", input.ArticleRevisionId);
        AppendNullableInt(builder, "revisionNo", input.RevisionNo);
        return Encoding.UTF8.GetBytes(builder.ToString());
    }

    private static void ValidateLeaf(MerkleLeafInput input)
    {
        if (input.Seq <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(input.Seq), input.Seq, "Merkle leaf seq must be positive.");
        }

        ValidateHash(input.LogEntryHash, nameof(input.LogEntryHash));
    }

    private static void ValidateHash(string value, string name)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(value);
        if (!TransparencyLogEntryCanonicalizer.IsSha256Hex(value))
        {
            throw new ArgumentException("Merkle hash must be SHA-256 hex.", name);
        }
    }

    private static void AppendLine(StringBuilder builder, string value)
        => builder.Append(value).Append('\n');

    private static void AppendLong(StringBuilder builder, string field, long value)
        => AppendLine(builder, $"{field}:i:{value.ToString(CultureInfo.InvariantCulture)}");

    private static void AppendNullableLong(StringBuilder builder, string field, long? value)
        => AppendLine(builder, value.HasValue ? $"{field}:i:{value.Value.ToString(CultureInfo.InvariantCulture)}" : $"{field}:n");

    private static void AppendNullableInt(StringBuilder builder, string field, int? value)
        => AppendLine(builder, value.HasValue ? $"{field}:i:{value.Value.ToString(CultureInfo.InvariantCulture)}" : $"{field}:n");

    private static void AppendHash(StringBuilder builder, string field, string value)
        => AppendLine(builder, $"{field}:h:{value.ToLowerInvariant()}");

    private static string ComputeHashHex(byte[] bytes)
        => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
}

public static class MerkleCheckpointVerifier
{
    public static bool VerifyInclusion(string rootHash, MerkleInclusionProof proof)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(rootHash);
        ArgumentNullException.ThrowIfNull(proof);

        string current = proof.LeafHash;
        foreach (MerkleProofSibling sibling in proof.Siblings)
        {
            current = sibling.IsLeftSibling
                ? MerkleCheckpointBuilder.HashNode(sibling.Hash, current)
                : MerkleCheckpointBuilder.HashNode(current, sibling.Hash);
        }

        return StringComparer.Ordinal.Equals(rootHash.ToLowerInvariant(), current);
    }
}
