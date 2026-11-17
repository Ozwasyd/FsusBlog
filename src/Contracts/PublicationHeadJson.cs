using System.Globalization;
using System.Buffers.Text;
using System.Text.Json.Serialization;

namespace FsusBlog.V2.Contracts;

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
