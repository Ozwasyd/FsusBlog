using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.V2.Contracts;

public sealed record CanonicalArticleV1(int ArticleId, long? ArticleRevisionId, int? RevisionNo,
    string? PublicRouteKey, string Title, string? Summary, string? CoverImageUrl, int CategoryId,
    IReadOnlyList<int> TagIds, int Status, DateTimeOffset? PublishedAt, DateTimeOffset? ScheduledPublishAt,
    string MarkdownContent);

public sealed record CanonicalArticleRightsV1(int ArticleId, long ArticleRevisionId, int RevisionNo,
    string LicenseType, string? CopyrightHolder, int? CopyrightYear, string? RightsStatement,
    string? AttributionTemplate, string CopyPolicy, int MaxExcerptChars, bool AllowCodeCopy,
    bool ShowPublicBadge, string? CanonicalUrl, string ContentCanonicalHash);

// The frozen v1 payloads bind supplied facts. Storage provenance and publication readiness are caller concerns.
public static class ArticleCanonicalHashesV1
{
    private const string Sha256Prefix = "sha256:";
    private static readonly UTF8Encoding Utf8 = new(false, true);

    public static string ContentDigest(CanonicalArticleV1 article) => Digest(ContentPayload(article));
    public static string PolicyDigest(CanonicalArticleRightsV1 rights) => Digest(PolicyPayload(rights));

    public static byte[] ContentPayload(CanonicalArticleV1 article)
    {
        ArgumentNullException.ThrowIfNull(article);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(article.ArticleId);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(article.CategoryId);
        if (article.ArticleRevisionId is long sourceRevision)
            ArgumentOutOfRangeException.ThrowIfNegativeOrZero(sourceRevision, nameof(article.ArticleRevisionId));
        if (article.RevisionNo is int revision)
            ArgumentOutOfRangeException.ThrowIfNegativeOrZero(revision, nameof(article.RevisionNo));
        ArgumentNullException.ThrowIfNull(article.Title);
        ArgumentNullException.ThrowIfNull(article.MarkdownContent);
        ArgumentNullException.ThrowIfNull(article.TagIds);
        if (article.TagIds.Any(static id => id <= 0))
            throw new ArgumentOutOfRangeException(nameof(article.TagIds), "Tag IDs must be positive.");

        return Payload(
            "fsusblog.integrity.article-canonical.v1",
            "hashVersion:i:1",
            Integer("articleId", article.ArticleId),
            Integer("articleRevisionId", article.ArticleRevisionId),
            Integer("revisionNo", article.RevisionNo),
            String("publicRouteKey", article.PublicRouteKey),
            String("title", article.Title),
            String("summary", article.Summary),
            String("coverImageUrl", article.CoverImageUrl),
            Integer("categoryId", article.CategoryId),
            "tagIds:i:" + string.Join(',', article.TagIds.Distinct().Order().Select(static id => id.ToString(CultureInfo.InvariantCulture))),
            Integer("status", article.Status),
            Time("publishedAt", article.PublishedAt),
            Time("scheduledPublishAt", article.ScheduledPublishAt),
            String("markdown", article.MarkdownContent));
    }

    public static byte[] PolicyPayload(CanonicalArticleRightsV1 rights)
    {
        ArgumentNullException.ThrowIfNull(rights);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(rights.ArticleId);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(rights.ArticleRevisionId);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(rights.RevisionNo);
        ArgumentOutOfRangeException.ThrowIfNegative(rights.MaxExcerptChars);
        ArgumentException.ThrowIfNullOrWhiteSpace(rights.LicenseType);
        ArgumentException.ThrowIfNullOrWhiteSpace(rights.CopyPolicy);
        ArgumentException.ThrowIfNullOrWhiteSpace(rights.ContentCanonicalHash);
        var digest = rights.ContentCanonicalHash.Trim();
        if (digest.StartsWith(Sha256Prefix, StringComparison.OrdinalIgnoreCase))
            digest = digest[Sha256Prefix.Length..];
        if (digest.Length != 64 || !digest.All(Uri.IsHexDigit))
            throw new ArgumentException("Content SHA-256 must contain 64 hexadecimal digits.", nameof(rights.ContentCanonicalHash));

        return Payload(
            "fsusblog.rights.article-policy.v1",
            "hashVersion:i:1",
            Integer("articleId", rights.ArticleId),
            Integer("articleRevisionId", rights.ArticleRevisionId),
            Integer("revisionNo", rights.RevisionNo),
            String("licenseType", rights.LicenseType),
            String("copyrightHolder", rights.CopyrightHolder),
            Integer("copyrightYear", rights.CopyrightYear),
            String("rightsStatement", rights.RightsStatement),
            String("attributionTemplate", rights.AttributionTemplate),
            String("copyPolicy", rights.CopyPolicy),
            Integer("maxExcerptChars", rights.MaxExcerptChars),
            Boolean("allowCodeCopy", rights.AllowCodeCopy),
            Boolean("showPublicBadge", rights.ShowPublicBadge),
            String("canonicalUrl", rights.CanonicalUrl),
            "contentCanonicalHash:h:" + Sha256Prefix + digest.ToLowerInvariant());
    }

    private static byte[] Payload(params string[] lines) => Utf8.GetBytes(string.Join('\n', lines) + '\n');
    private static string Digest(byte[] payload) => Sha256Prefix + Convert.ToHexStringLower(SHA256.HashData(payload));
    private static string Integer(string field, long? value) => value is long number
        ? field + ":i:" + number.ToString(CultureInfo.InvariantCulture) : field + ":n";
    private static string Boolean(string field, bool value) => field + (value ? ":b:1" : ":b:0");
    private static string String(string field, string? value) => value is null ? field + ":n" : field + ":s:" +
        Convert.ToBase64String(Utf8.GetBytes(value.Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace('\r', '\n').Normalize(NormalizationForm.FormC)));
    private static string Time(string field, DateTimeOffset? value) => value is DateTimeOffset time
        ? field + ":t:" + time.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'", CultureInfo.InvariantCulture)
        : field + ":n";
}
