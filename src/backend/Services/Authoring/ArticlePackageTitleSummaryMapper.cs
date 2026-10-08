using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Contracts.Articles;
using FsusBlog.Shared.Contracts.ArticlePackages;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>Content-free validation result; never a persisted-source or authorization receipt.</summary>
public readonly record struct ArticlePackageTitleSummaryMappingResult(bool IsValid, string? ReasonCode);

/// <summary>
/// Projects exact title/summary text from the existing canonical article input. Reads no stores,
/// creates no identities and emits no lifecycle, taxonomy, rights, responsibility or syntax facts.
/// </summary>
public static class ArticlePackageTitleSummaryMapper
{
    public const int SchemaVersion = 1;
    public const string MappingDigestDomain = "fsusblog.article-package.title-summary-candidate.v1";
    private static readonly UTF8Encoding s_utf8 = new(false, true);

    /// <summary>
    /// Requires complete revision coordinates, an explicit portable pair and the actual canonical
    /// hash. Source text is bounded and validated before canonical normalization; output text is raw.
    /// Caller-supplied coordinates and hashes do not establish observed storage or read permission.
    /// </summary>
    public static ArticlePackageTitleSummaryMappingResult TryMapCandidate(
        ArticleCanonicalInput? source,
        ArticlePackageTitleSummaryBinding? binding,
        out ArticlePackageTitleSummaryCandidate? candidate)
    {
        candidate = null;
        if (source is null || binding is null || source.Title is null
            || source.MarkdownContent is null || source.TagIds is null)
        {
            return Invalid("article_package_title_summary_input_invalid");
        }
        int tagCount = source.TagIds.Count;
        if (!WithinBudgets(source, tagCount))
        {
            return Invalid("article_package_title_summary_budget_exceeded");
        }
        if (source.ArticleId <= 0 || source.ArticleRevisionId is not > 0 || source.RevisionNo is not > 0
            || binding.SourceArticleId != source.ArticleId || binding.SourceRevisionId != source.ArticleRevisionId
            || binding.SourceRevisionNo != source.RevisionNo || !IsHash(binding.SourceCanonicalHash)
            || binding.PortableArticle.Kind != ArticlePackageIdentityKind.Article
            || !ArticlePackageIdentity.TryCreate(ArticlePackageIdentityKind.Article,
                binding.PortableArticle.Value, out ArticlePackageIdentity parsed).IsValid
            || parsed != binding.PortableArticle)
        {
            return Invalid("article_package_title_summary_binding_invalid");
        }
        if (source.PublishedAt is { Kind: not DateTimeKind.Utc }
            || source.ScheduledPublishAt is { Kind: not DateTimeKind.Utc })
        {
            return Invalid("article_package_title_summary_time_invalid");
        }
        try
        {
            RequireValidText(source.Title);
            RequireValidText(source.Summary);
            RequireValidText(source.PublicRouteKey);
            RequireValidText(source.CoverImageUrl);
            RequireValidText(source.MarkdownContent);
            // Own the bounded collection used by the canonical owner; never sort or rewrite source text.
            int[] tagIds = new int[tagCount];
            for (int index = 0; index < tagIds.Length; index++)
            {
                tagIds[index] = source.TagIds[index];
            }
            ArticleCanonicalInput ownedSource = source with
            {
                TagIds = tagIds
            };
            string sourceHash = ArticleCanonicalHashV1.ComputeHashHex(ownedSource);
            if (!string.Equals(sourceHash, binding.SourceCanonicalHash, StringComparison.Ordinal))
            {
                return Invalid("article_package_title_summary_source_mismatch");
            }
            string digest = ComputeMappingDigest(binding, source.Title, source.Summary);
            candidate = new ArticlePackageTitleSummaryCandidate(
                SchemaVersion, binding.SourceArticleId, binding.SourceRevisionId, binding.SourceRevisionNo,
                sourceHash, binding.PortableArticle, source.Title, source.Summary, digest);
            return new(true, null);
        }
        catch (ArgumentException)
        {
            return Invalid("article_package_title_summary_source_invalid");
        }
        catch (IndexOutOfRangeException)
        {
            return Invalid("article_package_title_summary_source_invalid");
        }
    }

    /// <summary>Reprojects the supplied source and compares every field, including actual raw text.</summary>
    public static ArticlePackageTitleSummaryMappingResult ValidateCandidate(
        ArticleCanonicalInput? source,
        ArticlePackageTitleSummaryBinding? binding,
        ArticlePackageTitleSummaryCandidate? candidate)
    {
        ArticlePackageTitleSummaryMappingResult result = TryMapCandidate(source, binding, out var expected);
        if (!result.IsValid)
        {
            return result;
        }
        if (candidate is null || expected is null || candidate.SchemaVersion != expected.SchemaVersion
            || candidate.SourceArticleId != expected.SourceArticleId || candidate.SourceRevisionId != expected.SourceRevisionId
            || candidate.SourceRevisionNo != expected.SourceRevisionNo || candidate.PortableArticle != expected.PortableArticle
            || !string.Equals(candidate.SourceCanonicalHash, expected.SourceCanonicalHash, StringComparison.Ordinal)
            || !string.Equals(candidate.Title, expected.Title, StringComparison.Ordinal)
            || !string.Equals(candidate.Summary, expected.Summary, StringComparison.Ordinal)
            || !string.Equals(candidate.MappingDigest, expected.MappingDigest, StringComparison.Ordinal))
        {
            return Invalid("article_package_title_summary_candidate_mismatch");
        }
        return new(true, null);
    }

    private static bool WithinBudgets(ArticleCanonicalInput source, int tagCount)
    {
        long textLength = (long)source.Title.Length + (source.Summary?.Length ?? 0)
            + (source.PublicRouteKey?.Length ?? 0) + (source.CoverImageUrl?.Length ?? 0) + source.MarkdownContent.Length;
        return textLength <= ArticlePackageTitleSummaryLimits.MaxCanonicalTextCodeUnits
            && tagCount is >= 0 and <= ArticlePackageTitleSummaryLimits.MaxTagIds;
    }

    private static bool IsHash(string? hash)
        => hash is { Length: 64 } && hash.All(static character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static void RequireValidText(string? value)
    {
        if (value is not null)
        {
            _ = s_utf8.GetByteCount(value);
        }
    }

    private static string ComputeMappingDigest(ArticlePackageTitleSummaryBinding binding, string title, string? summary)
    {
        using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        AppendText(hash, MappingDigestDomain);
        AppendInt32(hash, SchemaVersion);
        AppendInt32(hash, binding.SourceArticleId);
        Span<byte> revisionBytes = stackalloc byte[sizeof(long)];
        BinaryPrimitives.WriteInt64LittleEndian(revisionBytes, binding.SourceRevisionId);
        hash.AppendData(revisionBytes);
        AppendInt32(hash, binding.SourceRevisionNo);
        AppendText(hash, binding.SourceCanonicalHash);
        AppendText(hash, binding.PortableArticle.Value);
        AppendText(hash, title);
        AppendText(hash, summary);
        return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
    }

    private static void AppendInt32(IncrementalHash hash, int value)
    {
        Span<byte> bytes = stackalloc byte[sizeof(int)];
        BinaryPrimitives.WriteInt32LittleEndian(bytes, value);
        hash.AppendData(bytes);
    }

    private static void AppendText(IncrementalHash hash, string? value)
    {
        if (value is null)
        {
            AppendInt32(hash, -1);
            return;
        }
        byte[] bytes = s_utf8.GetBytes(value);
        AppendInt32(hash, bytes.Length);
        hash.AppendData(bytes);
    }

    private static ArticlePackageTitleSummaryMappingResult Invalid(string reason)
        => new(false, reason);
}
