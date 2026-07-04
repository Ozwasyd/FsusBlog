using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Core.Integrity;

public sealed record ArticleCanonicalInput(
    int ArticleId,
    long? ArticleRevisionId,
    int? RevisionNo,
    string? PublicRouteKey,
    string Title,
    string? Summary,
    string? CoverImageUrl,
    int CategoryId,
    IReadOnlyList<int> TagIds,
    int Status,
    DateTime? PublishedAt,
    DateTime? ScheduledPublishAt,
    string MarkdownContent);

public static class ArticleCanonicalHashV1
{
    public const int HashVersion = 1;
    public const string DomainSeparator = "fsusblog.integrity.article-canonical.v1";
    public const string HashAlgorithm = "sha256";

    public static byte[] BuildPayloadBytes(ArticleCanonicalInput input)
    {
        ValidateInput(input);

        var builder = new StringBuilder(512 + input.MarkdownContent.Length);
        AppendRawLine(builder, DomainSeparator);
        AppendIntLine(builder, "hashVersion", HashVersion);
        AppendIntLine(builder, "articleId", input.ArticleId);
        AppendNullableLongLine(builder, "articleRevisionId", input.ArticleRevisionId);
        AppendNullableIntLine(builder, "revisionNo", input.RevisionNo);
        AppendStringLine(builder, "publicRouteKey", input.PublicRouteKey);
        AppendStringLine(builder, "title", input.Title);
        AppendStringLine(builder, "summary", input.Summary);
        AppendStringLine(builder, "coverImageUrl", input.CoverImageUrl);
        AppendIntLine(builder, "categoryId", input.CategoryId);
        AppendRawLine(builder, $"tagIds:i:{BuildCanonicalTagIds(input.TagIds)}");
        AppendIntLine(builder, "status", input.Status);
        AppendNullableDateTimeLine(builder, "publishedAt", input.PublishedAt);
        AppendNullableDateTimeLine(builder, "scheduledPublishAt", input.ScheduledPublishAt);
        AppendStringLine(builder, "markdown", input.MarkdownContent);

        return Encoding.UTF8.GetBytes(builder.ToString());
    }

    public static string BuildPayloadUtf8(ArticleCanonicalInput input)
        => Encoding.UTF8.GetString(BuildPayloadBytes(input));

    public static string ComputeHashHex(ArticleCanonicalInput input)
    {
        byte[] payload = BuildPayloadBytes(input);
        byte[] hash = SHA256.HashData(payload);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    private static void ValidateInput(ArticleCanonicalInput input)
    {
        ArgumentNullException.ThrowIfNull(input);
        ArgumentNullException.ThrowIfNull(input.Title);
        ArgumentNullException.ThrowIfNull(input.MarkdownContent);
        ArgumentNullException.ThrowIfNull(input.TagIds);

        if (input.ArticleId <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(input.ArticleId), input.ArticleId, "ArticleId must be positive.");
        }

        if (input.ArticleRevisionId is <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(input.ArticleRevisionId), input.ArticleRevisionId, "ArticleRevisionId must be positive when present.");
        }

        if (input.RevisionNo is <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(input.RevisionNo), input.RevisionNo, "RevisionNo must be positive when present.");
        }

        if (input.CategoryId <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(input.CategoryId), input.CategoryId, "CategoryId must be positive.");
        }
    }

    private static void AppendRawLine(StringBuilder builder, string value)
        => builder.Append(value).Append('\n');

    private static void AppendIntLine(StringBuilder builder, string field, int value)
        => AppendRawLine(builder, $"{field}:i:{value.ToString(CultureInfo.InvariantCulture)}");

    private static void AppendNullableIntLine(StringBuilder builder, string field, int? value)
    {
        if (value.HasValue)
        {
            AppendIntLine(builder, field, value.Value);
            return;
        }

        AppendRawLine(builder, $"{field}:n");
    }

    private static void AppendNullableLongLine(StringBuilder builder, string field, long? value)
    {
        if (value.HasValue)
        {
            AppendRawLine(builder, $"{field}:i:{value.Value.ToString(CultureInfo.InvariantCulture)}");
            return;
        }

        AppendRawLine(builder, $"{field}:n");
    }

    private static void AppendNullableDateTimeLine(StringBuilder builder, string field, DateTime? value)
    {
        if (!value.HasValue)
        {
            AppendRawLine(builder, $"{field}:n");
            return;
        }

        AppendRawLine(builder, $"{field}:t:{CanonicalUtc(value.Value)}");
    }

    private static void AppendStringLine(StringBuilder builder, string field, string? value)
    {
        if (value is null)
        {
            AppendRawLine(builder, $"{field}:n");
            return;
        }

        string normalized = NormalizeText(value);
        string encoded = Convert.ToBase64String(Encoding.UTF8.GetBytes(normalized));
        AppendRawLine(builder, $"{field}:s:{encoded}");
    }

    private static string NormalizeText(string value)
        => NormalizeLineEndings(value).Normalize(NormalizationForm.FormC);

    private static string NormalizeLineEndings(string value)
        => value.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n');

    private static string CanonicalUtc(DateTime value)
    {
        DateTime utc = value.Kind == DateTimeKind.Unspecified
            ? DateTime.SpecifyKind(value, DateTimeKind.Utc)
            : value.ToUniversalTime();
        return utc.ToString("yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'", CultureInfo.InvariantCulture);
    }

    private static string BuildCanonicalTagIds(IReadOnlyList<int> tagIds)
    {
        int[] normalized = [.. tagIds.Distinct().Order()];
        foreach (int tagId in normalized)
        {
            if (tagId <= 0)
            {
                throw new ArgumentOutOfRangeException(nameof(tagIds), tagId, "TagIds must be positive.");
            }
        }

        return string.Join(',', normalized);
    }
}
