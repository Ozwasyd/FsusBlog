namespace FsusBlog.Contracts.Articles;

/// <summary>Normalized current article rights; not a revision snapshot or a permission grant.</summary>
public sealed record ArticleRightsNormalizedModel(
    bool Enabled,
    string LicenseType,
    string? CopyrightHolder,
    int? CopyrightYear,
    string? RightsStatement,
    string? AttributionTemplate,
    string CopyPolicy,
    int MaxExcerptChars,
    bool AllowCodeCopy,
    bool ShowPublicBadge,
    bool ProofBindingEnabled);

/// <summary>Current article input normalization shared by writers, codecs, and offline projection.</summary>
/// <remarks>Normalization is not publication, taxonomy, or responsibility admission.</remarks>
public static class ArticleProductionNormalizers
{
    /// <summary>The current title normalization bound.</summary>
    public const int MaxTitleLength = 256;
    /// <summary>The current summary normalization bound.</summary>
    public const int MaxSummaryLength = 512;
    /// <summary>The current content normalization bound.</summary>
    public const int MaxContentLength = 200_000;
    /// <summary>The current cover URL normalization bound.</summary>
    public const int MaxCoverImageUrlLength = 512;
    /// <summary>The number of distinct tag ids retained by input normalization.</summary>
    public const int MaxTagIds = 32;

    /// <summary>Trims supplied text, resolves null to empty, and bounds its character length.</summary>
    /// <remarks>This is existing writer normalization, not a lossless migration-body transformation.</remarks>
    public static string NormalizeText(string? raw, int maxLength)
    {
        string value = raw?.Trim() ?? string.Empty;
        return value.Length > maxLength ? value[..maxLength] : value;
    }

    /// <summary>Retains at most the current tag limit in first-seen distinct order.</summary>
    /// <remarks>Non-positive ids are retained for later validation; taxonomy existence is not checked here.</remarks>
    public static List<int> NormalizeTagIds(IEnumerable<int>? tagIds)
    {
        // Production-preserving semantics: first-seen order, Distinct, keep non-positive IDs
        // (canonical hash sorts tags; invalid IDs fail later in write validation / hash inputs).
        if (tagIds is null)
        {
            return [];
        }

        var result = new List<int>(MaxTagIds);
        var seen = new HashSet<int>();
        foreach (int id in tagIds)
        {
            if (result.Count >= MaxTagIds)
            {
                break;
            }

            if (seen.Add(id))
            {
                result.Add(id);
            }
        }

        return result;
    }

    /// <summary>Resolves omitted rights to current defaults and normalizes writer input.</summary>
    /// <remarks>Negative excerpt limits throw; optional text is trimmed and bounded.</remarks>
    public static ArticleRightsNormalizedModel NormalizeArticleRights(ArticleRightsRequestCoreModel? request)
    {
        ArticleRightsRequestCoreModel value = request ?? DefaultArticleRights();
        if (value.MaxExcerptChars < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(value.MaxExcerptChars), value.MaxExcerptChars, "MaxExcerptChars cannot be negative.");
        }

        return new ArticleRightsNormalizedModel(
            Enabled: value.Enabled,
            LicenseType: NormalizeRightsToken(value.LicenseType, "all-rights-reserved", 48),
            CopyrightHolder: NormalizeOptionalRightsText(value.CopyrightHolder, 256),
            CopyrightYear: value.CopyrightYear,
            RightsStatement: NormalizeOptionalRightsText(value.RightsStatement, 4000),
            AttributionTemplate: NormalizeOptionalRightsText(value.AttributionTemplate, 4000),
            CopyPolicy: NormalizeRightsToken(value.CopyPolicy, "append-attribution", 48),
            MaxExcerptChars: value.MaxExcerptChars,
            AllowCodeCopy: value.AllowCodeCopy,
            ShowPublicBadge: value.ShowPublicBadge,
            ProofBindingEnabled: value.ProofBindingEnabled);
    }

    /// <summary>Normalizes bounded optional rights text, returning null when no text remains.</summary>
    public static string? NormalizeOptionalRightsText(string? value, int maxLength)
    {
        string normalized = NormalizeText(value, maxLength);
        return normalized.Length == 0 ? null : normalized;
    }

    /// <summary>Normalizes a bounded token and uses the explicit fallback only when it is empty.</summary>
    public static string NormalizeRightsToken(string? value, string fallback, int maxLength)
    {
        string? normalized = NormalizeText(value, maxLength);
        return string.IsNullOrWhiteSpace(normalized) ? fallback : normalized;
    }

    /// <summary>Preserves the existing wire-encoding normalization of rights input.</summary>
    /// <remarks>Unlike writer normalization, this does not trim text and clamps negative excerpt limits to zero.</remarks>
    public static ArticleRightsRequestCoreModel NormalizeWireArticleRights(ArticleRightsRequestCoreModel? rights)
    {
        if (!rights.HasValue)
        {
            return DefaultArticleRights();
        }

        ArticleRightsRequestCoreModel value = rights.Value;
        return value with
        {
            LicenseType = string.IsNullOrWhiteSpace(value.LicenseType) ? "all-rights-reserved" : value.LicenseType,
            CopyPolicy = string.IsNullOrWhiteSpace(value.CopyPolicy) ? "append-attribution" : value.CopyPolicy,
            MaxExcerptChars = value.MaxExcerptChars < 0 ? 0 : value.MaxExcerptChars
        };
    }

    private static ArticleRightsRequestCoreModel DefaultArticleRights()
        => new(
            Enabled: true,
            LicenseType: "all-rights-reserved",
            CopyrightHolder: null,
            CopyrightYear: null,
            RightsStatement: null,
            AttributionTemplate: null,
            CopyPolicy: "append-attribution",
            MaxExcerptChars: 300,
            AllowCodeCopy: true,
            ShowPublicBadge: true,
            ProofBindingEnabled: true);
}
