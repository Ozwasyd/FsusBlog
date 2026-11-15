using System.Buffers.Binary;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.V2.Contracts;

public sealed record PublicationCheckpointV2(string Origin, string ScopeKey, long FromSequence, long ToSequence, int EntryCount,
    byte[] RootSha256, long HeadSequence, byte[] HeadEntrySha256, string KeyId, int KeyVersion, byte[] KeySha256, DateTimeOffset AttestedAt)
{
    public const int MaxLeaves = 4096;
    public const int MaxPrefixEntries = 16384;
    public const string Domain = "fsusblog.integrity.native-publication-release-checkpoint.v2";

    public byte[] Payload()
    {
        if (Origin.Length > 256 || !Uri.TryCreate(Origin, UriKind.Absolute, out var site) || site.Scheme != Uri.UriSchemeHttps ||
            site.GetLeftPart(UriPartial.Authority) != Origin || site.UserInfo.Length != 0 || !ValidScope(ScopeKey) ||
            FromSequence <= 0 || FromSequence > ToSequence || ToSequence > HeadSequence ||
            EntryCount is < 1 or > MaxLeaves || ToSequence - FromSequence != EntryCount - 1 ||
            HeadSequence - FromSequence >= MaxPrefixEntries ||
            RootSha256.Length != 32 || HeadEntrySha256.Length != 32 || KeySha256.Length != 32 ||
            KeyVersion <= 0 || !ArticlePublicationProofPayloadV2.ValidKeyId(KeyId))
            throw new ArgumentException("Invalid native release checkpoint facts.");

        return Encoding.UTF8.GetBytes(string.Join('\n', Domain, "checkpointVersion:i:2", Text("kind", "release"),
            Text("algorithm", ArticlePublicationProofPayloadV2.Algorithm), Text("origin", Origin), Text("scopeKey", ScopeKey),
            Integer("fromSequence", FromSequence), Integer("toSequence", ToSequence), Integer("entryCount", EntryCount),
            Hash("rootSha256", RootSha256), Integer("headSequence", HeadSequence), Hash("headEntrySha256", HeadEntrySha256),
            Text("keyId", KeyId), Integer("keyVersion", KeyVersion), Hash("keySha256", KeySha256),
            "attestedAt:t:" + ArticlePublicationProofPayloadV2.Time(AttestedAt), ""));
    }

    public static bool ValidScope(string value) => value.Length is >= 1 and <= 64 &&
        char.IsAsciiLetterOrDigit(value[0]) && value.All(character => char.IsAsciiLetterOrDigit(character) || character is '-' or '_' or '.');

    private static string Integer(string field, long value) => field + ":i:" + value.ToString(CultureInfo.InvariantCulture);
    private static string Hash(string field, byte[] value) => field + ":h:" + Convert.ToHexStringLower(value);
    private static string Text(string field, string value) => field + ":s:" + Convert.ToBase64String(Encoding.UTF8.GetBytes(value));
}

public sealed record PublicationCheckpointWitness(long Sequence, byte[] LeafSha256, IReadOnlyList<byte[]> Siblings);

public static class PublicationCheckpointTreeV2
{
    public static (byte[] RootSha256, PublicationCheckpointWitness? Inclusion) Build(
        long fromSequence, IReadOnlyList<byte[]> entryHashes, long? inclusionSequence)
    {
        if (fromSequence <= 0 || entryHashes.Count is < 1 or > PublicationCheckpointV2.MaxLeaves ||
            fromSequence > long.MaxValue - (entryHashes.Count - 1) ||
            (inclusionSequence.HasValue && (inclusionSequence.Value < fromSequence ||
                inclusionSequence.Value - fromSequence >= entryHashes.Count)))
            throw new ArgumentException("Invalid native checkpoint range or inclusion sequence.");

        var level = new byte[entryHashes.Count][];
        for (var index = 0; index < level.Length; index++)
            level[index] = Leaf(fromSequence + index, entryHashes[index]);
        var position = inclusionSequence.HasValue ? (int)(inclusionSequence.Value - fromSequence) : -1;
        var leaf = position >= 0 ? level[position] : null;
        var siblings = new List<byte[]>();
        while (level.Length > 1)
        {
            if (position >= 0)
            {
                siblings.Add(level[Math.Min(position ^ 1, level.Length - 1)]);
                position /= 2;
            }
            var parents = new byte[(level.Length + 1) / 2][];
            for (var index = 0; index < level.Length; index += 2)
                parents[index / 2] = Node(level[index], level[Math.Min(index + 1, level.Length - 1)]);
            level = parents;
        }
        return (level[0], leaf is null ? null : new(inclusionSequence!.Value, leaf, siblings));
    }

    private static byte[] Leaf(long sequence, ReadOnlySpan<byte> value)
    {
        if (value.Length != 32) throw new ArgumentException("Invalid checkpoint entry digest.");
        var domain = "fsusblog.integrity.native-publication-checkpoint-leaf.v2\0"u8;
        Span<byte> input = stackalloc byte[domain.Length + 8 + 32];
        domain.CopyTo(input);
        BinaryPrimitives.WriteInt64BigEndian(input.Slice(domain.Length, 8), sequence);
        value.CopyTo(input[(domain.Length + 8)..]);
        return SHA256.HashData(input);
    }

    private static byte[] Node(ReadOnlySpan<byte> left, ReadOnlySpan<byte> right)
    {
        var domain = "fsusblog.integrity.native-publication-checkpoint-node.v2\0"u8;
        Span<byte> input = stackalloc byte[domain.Length + 64];
        domain.CopyTo(input);
        left.CopyTo(input.Slice(domain.Length, 32));
        right.CopyTo(input[(domain.Length + 32)..]);
        return SHA256.HashData(input);
    }
}
