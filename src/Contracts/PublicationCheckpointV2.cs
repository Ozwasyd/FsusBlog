using System.Buffers.Binary;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.V2.Contracts;

public sealed record PublicationCheckpointV2(string Origin, string ScopeKey, long FromSequence, long ToSequence, int EntryCount,
    byte[] RootSha256, long HeadSequence, byte[] HeadEntrySha256, string KeyId, int KeyVersion, byte[] KeySha256, DateTimeOffset AttestedAt,
    PublicationCheckpointKind Kind = PublicationCheckpointKind.Release)
{
    public const int MaxLeaves = 4096;
    public const int MaxPrefixEntries = 16384;
    public const string Domain = "fsusblog.integrity.native-publication-release-checkpoint.v2";
    public const string DailyDomain = "fsusblog.integrity.native-publication-daily-checkpoint.v2";

    public byte[] Payload()
    {
        if (Origin.Length > 256 || !Uri.TryCreate(Origin, UriKind.Absolute, out var site) || site.Scheme != Uri.UriSchemeHttps ||
            site.GetLeftPart(UriPartial.Authority) != Origin || site.UserInfo.Length != 0 || !ValidRange() ||
            RootSha256.Length != 32 || HeadEntrySha256.Length != 32 || KeySha256.Length != 32 ||
            KeyVersion <= 0 || !ArticlePublicationProofPayloadV2.ValidKeyId(KeyId))
            throw new ArgumentException("Invalid native checkpoint facts.");

        var kind = Kind == PublicationCheckpointKind.Daily ? "daily" : "release";
        return Encoding.UTF8.GetBytes(string.Join('\n', Kind == PublicationCheckpointKind.Daily ? DailyDomain : Domain,
            "checkpointVersion:i:2", Text("kind", kind),
            Text("algorithm", ArticlePublicationProofPayloadV2.Algorithm), Text("origin", Origin), Text("scopeKey", ScopeKey),
            Integer("fromSequence", FromSequence), Integer("toSequence", ToSequence), Integer("entryCount", EntryCount),
            Hash("rootSha256", RootSha256), Integer("headSequence", HeadSequence), Hash("headEntrySha256", HeadEntrySha256),
            Text("keyId", KeyId), Integer("keyVersion", KeyVersion), Hash("keySha256", KeySha256),
            "attestedAt:t:" + ArticlePublicationProofPayloadV2.Time(AttestedAt), ""));
    }

    private bool ValidRange()
    {
        if (HeadSequence <= 0 || EntryCount is < 0 or > MaxLeaves) return false;
        var nonempty = EntryCount > 0 && FromSequence > 0 && FromSequence <= ToSequence && ToSequence <= HeadSequence;
        return Kind switch
        {
            PublicationCheckpointKind.Release => ValidScope(ScopeKey) && nonempty &&
                ToSequence - FromSequence == EntryCount - 1 && HeadSequence - FromSequence < MaxPrefixEntries,
            PublicationCheckpointKind.Daily => TryDay(ScopeKey, out _) && HeadSequence <= MaxPrefixEntries &&
                (EntryCount == 0
                    ? FromSequence == 0 && ToSequence == 0 && RootSha256.AsSpan().SequenceEqual(PublicationCheckpointTreeV2.EmptyDailyRoot())
                    : nonempty && (EntryCount == 1 ? FromSequence == ToSequence : ToSequence - FromSequence >= EntryCount - 1)),
            _ => false,
        };
    }

    public static bool ValidScope(string value) => value.Length is >= 1 and <= 64 &&
        char.IsAsciiLetterOrDigit(value[0]) && value.All(character => char.IsAsciiLetterOrDigit(character) || character is '-' or '_' or '.');

    public static bool TryDay(string value, out DateOnly day) =>
        DateOnly.TryParseExact(value, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out day) &&
        day != DateOnly.MaxValue && value == day.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    private static string Integer(string field, long value) => field + ":i:" + value.ToString(CultureInfo.InvariantCulture);
    private static string Hash(string field, byte[] value) => field + ":h:" + Convert.ToHexStringLower(value);
    private static string Text(string field, string value) => field + ":s:" + Convert.ToBase64String(Encoding.UTF8.GetBytes(value));
}

public enum PublicationCheckpointKind { Release, Daily }

public sealed record PublicationCheckpointEntry(long Sequence, byte[] EntrySha256);
public sealed record PublicationCheckpointWitness(PublicationCheckpointEntry Entry, int Position, byte[] LeafSha256,
    IReadOnlyList<byte[]> Siblings)
{
    public long Sequence => Entry.Sequence;
}

public static class PublicationCheckpointTreeV2
{
    public static (byte[] RootSha256, PublicationCheckpointWitness? Inclusion) Build(
        long fromSequence, IReadOnlyList<byte[]> entryHashes, long? inclusionSequence)
    {
        if (fromSequence <= 0 || entryHashes.Count is < 1 or > PublicationCheckpointV2.MaxLeaves ||
            fromSequence > long.MaxValue - (entryHashes.Count - 1))
            throw new ArgumentException("Invalid native checkpoint range.");
        return Build(entryHashes.Select((hash, index) => new PublicationCheckpointEntry(fromSequence + index, hash)).ToArray(), inclusionSequence);
    }

    public static (byte[] RootSha256, PublicationCheckpointWitness? Inclusion) Build(
        IReadOnlyList<PublicationCheckpointEntry> entries, long? inclusionSequence)
    {
        if (entries.Count is < 1 or > PublicationCheckpointV2.MaxLeaves)
            throw new ArgumentException("Invalid native checkpoint range.");
        var level = new byte[entries.Count][];
        long previous = 0;
        var selection = -1;
        for (var index = 0; index < entries.Count; index++)
        {
            var entry = entries[index];
            if (entry.Sequence <= previous) throw new ArgumentException("Native checkpoint entries must be in increasing sequence order.");
            level[index] = Leaf(entry.Sequence, entry.EntrySha256);
            if (entry.Sequence == inclusionSequence) selection = index;
            previous = entry.Sequence;
        }
        if (inclusionSequence.HasValue && selection < 0)
            throw new ArgumentException("The inclusion sequence is outside the native checkpoint's selected entries.");
        var position = selection;
        var leaf = selection >= 0 ? level[selection] : null;
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
        return (level[0], leaf is null ? null : new(entries[selection], selection, leaf, siblings));
    }

    public static bool VerifyDailyInclusion(PublicationCheckpointV2 checkpoint, PublicationCheckpointEntry entry,
        int position, IReadOnlyList<byte[]> siblings)
    {
        var width = checkpoint.EntryCount;
        var sequence = entry.Sequence;
        var from = checkpoint.FromSequence;
        var to = checkpoint.ToSequence;
        if (checkpoint.Kind != PublicationCheckpointKind.Daily || width is < 1 or > PublicationCheckpointV2.MaxLeaves ||
            from < 1 || to > checkpoint.HeadSequence || sequence < from || sequence > to || position < 0 || position >= width ||
            (position == 0) != (sequence == from) || (position == width - 1) != (sequence == to) ||
            sequence - from < position || to - sequence < width - 1 - position || entry.EntrySha256.Length != 32 ||
            sequence == checkpoint.HeadSequence && !entry.EntrySha256.AsSpan().SequenceEqual(checkpoint.HeadEntrySha256))
            return false;

        var current = Leaf(sequence, entry.EntrySha256);
        var level = 0;
        while (width > 1)
        {
            if (level >= siblings.Count) return false;
            var sibling = siblings[level++];
            if (sibling.Length != 32 || ((position ^ 1) >= width && !sibling.AsSpan().SequenceEqual(current))) return false;
            current = position % 2 == 0 ? Node(current, sibling) : Node(sibling, current);
            position /= 2;
            width = (width + 1) / 2;
        }
        return level == siblings.Count && current.AsSpan().SequenceEqual(checkpoint.RootSha256);
    }

    public static byte[] EmptyDailyRoot() => SHA256.HashData("fsusblog.integrity.native-publication-daily-empty.v2\0"u8);

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
