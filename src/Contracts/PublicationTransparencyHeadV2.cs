namespace FsusBlog.V2.Contracts;

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
