using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.V2.Contracts;

public sealed record CanonicalArticleV2(int ArticleId, long Revision, string Title, string Markdown, int? CategoryId,
    IReadOnlyList<int> TagIds, byte[]? CoverMediaSha256 = null);

public static class ArticleCanonicalHashesV2
{
    private static readonly UTF8Encoding Utf8 = new(false, true);

    public static byte[] ContentDigest(CanonicalArticleV2 article) => SHA256.HashData(ContentPayload(article));
    public static byte[] PolicyDigest(ArticleRightsPolicy policy, ReadOnlySpan<byte> contentDigest) =>
        SHA256.HashData(PolicyPayload(policy, contentDigest));

    public static byte[] ContentPayload(CanonicalArticleV2 article)
    {
        ArgumentNullException.ThrowIfNull(article);
        ArgumentNullException.ThrowIfNull(article.TagIds);
        var cover = article.CoverMediaSha256;
        if (article.ArticleId <= 0 || article.Revision <= 0 || article.CategoryId is <= 0 ||
            article.TagIds.Count > WireLimits.TaxonomyTagCount || article.TagIds.Any(static tag => tag <= 0) ||
            cover is { Length: not 32 } ||
            Utf8.GetByteCount(article.Title) is 0 or > WireLimits.TitleBytes || Utf8.GetByteCount(article.Markdown) > WireLimits.BodyBytes)
            throw new ProtocolException("Invalid native canonical article facts.");
        var version = cover is null ? 2 : 3;
        string[] lines =
        [
            "fsusblog.integrity.article-content.v" + version.ToString(CultureInfo.InvariantCulture),
            Integer("version", version),
            Integer("articleId", article.ArticleId),
            Integer("revision", article.Revision),
            Text("title", article.Title),
            Text("markdown", article.Markdown),
            article.CategoryId is int category ? Integer("categoryId", category) : "categoryId:n",
            "tagIds:i:" + string.Join(',', article.TagIds.Distinct().Order().Select(tag => tag.ToString(CultureInfo.InvariantCulture))),
        ];
        return Payload(cover is null ? lines : [.. lines, "coverMediaSha256:h:" + Convert.ToHexStringLower(cover)]);
    }

    public static byte[] PolicyPayload(ArticleRightsPolicy policy, ReadOnlySpan<byte> contentDigest)
    {
        ArgumentNullException.ThrowIfNull(policy);
        Wire.Validate(policy);
        if (!policy.Present || contentDigest.Length != 32)
            throw new ProtocolException("A canonical v2 policy requires a persisted policy and SHA-256 content digest.");
        return Payload(
            "fsusblog.integrity.article-policy.v2",
            "version:i:2",
            Integer("articleId", policy.Id),
            Integer("revision", policy.Revision),
            Flag("enabled", policy.Enabled),
            Text("licenseType", policy.LicenseType),
            Text("copyrightHolder", policy.CopyrightHolder),
            Integer("copyrightYear", policy.CopyrightYear),
            Text("rightsStatement", policy.RightsStatement),
            Text("attributionTemplate", policy.AttributionTemplate),
            Text("copyPolicy", policy.CopyPolicy),
            Integer("maxExcerptChars", policy.MaxExcerptChars),
            Flag("allowCodeCopy", policy.AllowCodeCopy),
            Flag("showPublicBadge", policy.ShowPublicBadge),
            Flag("proofBindingEnabled", policy.ProofBindingEnabled),
            "contentSha256:h:" + Convert.ToHexStringLower(contentDigest));
    }

    private static byte[] Payload(params string[] lines) => Utf8.GetBytes(string.Join('\n', lines) + '\n');
    private static string Integer(string name, long value) => name + ":i:" + value.ToString(CultureInfo.InvariantCulture);
    private static string Flag(string name, bool value) => name + (value ? ":b:1" : ":b:0");
    // Preserve stored UTF-8 bytes, including original line endings, normalization and trailing newlines.
    private static string Text(string name, string value) => name + ":s:" + Convert.ToBase64String(Utf8.GetBytes(value));
}
