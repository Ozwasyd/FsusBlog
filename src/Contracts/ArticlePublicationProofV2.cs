using System.Globalization;
using System.Text;

namespace FsusBlog.V2.Contracts;

public sealed record ArticlePublicationProofV2(string Origin, int ArticleId, long Revision, long PublicationId, int PublicationNo,
    DateTimeOffset PublishedAt, long RightsSnapshotId, long OutboxId, byte[] ContentSha256, byte[] PolicySha256,
    string KeyId, int KeyVersion, byte[] KeySha256, DateTimeOffset IssuedAt, int CanonicalVersion = 2);

public static class ArticlePublicationProofPayloadV2
{
    public const string Domain = "fsusblog.integrity.native-publication-rights-proof.v2";
    public const string Algorithm = "ECDSA_P256_SHA256";

    public static byte[] Build(ArticlePublicationProofV2 value)
    {
        ArgumentNullException.ThrowIfNull(value);
        if (value.Origin.Length > 256 || !Uri.TryCreate(value.Origin, UriKind.Absolute, out var site) ||
            site.Scheme != Uri.UriSchemeHttps || site.GetLeftPart(UriPartial.Authority) != value.Origin || site.UserInfo.Length != 0 ||
            value.ArticleId <= 0 || value.Revision <= 0 || value.PublicationId <= 0 || value.PublicationNo <= 0 ||
            value.RightsSnapshotId <= 0 || value.OutboxId <= 0 || value.KeyVersion <= 0 ||
            value.CanonicalVersion is not (2 or 3) ||
            value.ContentSha256.Length != 32 || value.PolicySha256.Length != 32 || value.KeySha256.Length != 32 ||
            !ValidKeyId(value.KeyId) || value.IssuedAt < value.PublishedAt)
            throw new ArgumentException("Invalid native publication proof facts.", nameof(value));
        return Encoding.UTF8.GetBytes(string.Join('\n',
            Domain, "proofVersion:i:2", Integer("canonicalVersion", value.CanonicalVersion), "algorithm:s:" + Base64(Algorithm),
            "origin:s:" + Base64(value.Origin), Integer("articleId", value.ArticleId), Integer("revision", value.Revision),
            Integer("publicationId", value.PublicationId), Integer("publicationNo", value.PublicationNo),
            "publishedAt:t:" + Time(value.PublishedAt), Integer("rightsSnapshotId", value.RightsSnapshotId),
            Integer("outboxId", value.OutboxId), "contentSha256:h:" + Convert.ToHexStringLower(value.ContentSha256),
            "policySha256:h:" + Convert.ToHexStringLower(value.PolicySha256), "keyId:s:" + Base64(value.KeyId),
            Integer("keyVersion", value.KeyVersion), "keySha256:h:" + Convert.ToHexStringLower(value.KeySha256),
            "issuedAt:t:" + Time(value.IssuedAt), ""));
    }

    public static bool ValidKeyId(string id) => id.Length is >= 1 and <= 128 &&
        id.All(character => char.IsAsciiLetterOrDigit(character) || character is '-' or '_' or '.');

    public static string Time(DateTimeOffset value)
    {
        if (value.UtcTicks % 10 != 0 || value == DateTimeOffset.MinValue || value == DateTimeOffset.MaxValue)
            throw new ArgumentException("A native proof timestamp must retain exact PostgreSQL microseconds.", nameof(value));
        return value.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff'Z'", CultureInfo.InvariantCulture);
    }

    private static string Base64(string value) => Convert.ToBase64String(Encoding.UTF8.GetBytes(value));
    private static string Integer(string field, long value) => field + ":i:" + value.ToString(CultureInfo.InvariantCulture);
}
