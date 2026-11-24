using System.Buffers.Text;
using System.Text.Json.Serialization;

namespace FsusBlog.V2.Contracts;

public static class PublicationTransparencyV2
{
    public static byte[] ReceiptDigest(ReadOnlySpan<byte> transcript, ReadOnlySpan<byte> signature)
    {
        if (transcript.IsEmpty || signature.Length != 64) throw new ArgumentException("Invalid signed publication receipt.");
        var domain = "fsusblog.integrity.native-transparency-receipt.v2\0"u8;
        Span<byte> input = stackalloc byte[domain.Length + 32 + 64];
        domain.CopyTo(input);
        SHA256.HashData(transcript, input.Slice(domain.Length, 32));
        signature.CopyTo(input[(domain.Length + 32)..]);
        return SHA256.HashData(input);
    }

    public static byte[] EntryDigest(long sequence, ReadOnlySpan<byte> previous, ReadOnlySpan<byte> receipt)
    {
        if (sequence <= 0 || previous.Length != 32 || receipt.Length != 32)
            throw new ArgumentException("Invalid publication transparency entry.");
        var domain = "fsusblog.integrity.native-transparency-entry.v2\0"u8;
        Span<byte> input = stackalloc byte[domain.Length + 8 + 32 + 32];
        domain.CopyTo(input);
        BinaryPrimitives.WriteInt64BigEndian(input.Slice(domain.Length, 8), sequence);
        previous.CopyTo(input.Slice(domain.Length + 8, 32));
        receipt.CopyTo(input[(domain.Length + 40)..]);
        return SHA256.HashData(input);
    }
}

public sealed record PublicationTransparencyHeadV2(string Origin, long Sequence, byte[] EntrySha256, string KeyId,
    int KeyVersion, byte[] KeySha256, DateTimeOffset AttestedAt)
{
    public const string Domain = "fsusblog.integrity.native-publication-log-head.v2";

    public byte[] Payload()
    {
        if (Origin.Length > 256 || !Uri.TryCreate(Origin, UriKind.Absolute, out var site) ||
            site.Scheme != Uri.UriSchemeHttps || site.GetLeftPart(UriPartial.Authority) != Origin || site.UserInfo.Length != 0 ||
            Sequence <= 0 || EntrySha256.Length != 32 || KeySha256.Length != 32 || KeyVersion <= 0 ||
            !ArticlePublicationProofPayloadV2.ValidKeyId(KeyId))
            throw new ArgumentException("Invalid native publication log head.");

        return Encoding.UTF8.GetBytes(string.Join('\n', Domain, "headVersion:i:2",
            "algorithm:s:" + Base64(ArticlePublicationProofPayloadV2.Algorithm),
            "origin:s:" + Base64(Origin), "sequence:i:" + Sequence.ToString(CultureInfo.InvariantCulture),
            "entrySha256:h:" + Convert.ToHexStringLower(EntrySha256), "keyId:s:" + Base64(KeyId),
            "keyVersion:i:" + KeyVersion.ToString(CultureInfo.InvariantCulture), "keySha256:h:" + Convert.ToHexStringLower(KeySha256),
            "attestedAt:t:" + ArticlePublicationProofPayloadV2.Time(AttestedAt), ""));
    }

    private static string Base64(string value) => Convert.ToBase64String(Encoding.UTF8.GetBytes(value));
}

public sealed record PublicationHeadJson(
    [property: JsonPropertyName("headVersion")] int HeadVersion,
    [property: JsonPropertyName("kind")] string Kind,
    [property: JsonPropertyName("algorithm")] string Algorithm,
    [property: JsonPropertyName("origin")] string Origin,
    [property: JsonPropertyName("sequence")] string Sequence,
    [property: JsonPropertyName("entrySha256")] string EntrySha256,
    [property: JsonPropertyName("keyId")] string KeyId,
    [property: JsonPropertyName("keyVersion")] int KeyVersion,
    [property: JsonPropertyName("keySha256")] string KeySha256,
    [property: JsonPropertyName("attestedAtUtc")] string AttestedAtUtc,
    [property: JsonPropertyName("signature")] string Signature)
{
    public static PublicationHeadJson Project(PublicationTransparencyHeadV2 claim, byte[] signature) => new(
        2, "native-publication-log-head", ArticlePublicationProofPayloadV2.Algorithm,
        claim.Origin, claim.Sequence.ToString(CultureInfo.InvariantCulture),
        Convert.ToHexStringLower(claim.EntrySha256), claim.KeyId, claim.KeyVersion,
        Convert.ToHexStringLower(claim.KeySha256), ArticlePublicationProofPayloadV2.Time(claim.AttestedAt),
        Base64Url.EncodeToString(signature ?? throw new ArgumentNullException(nameof(signature))));
}
