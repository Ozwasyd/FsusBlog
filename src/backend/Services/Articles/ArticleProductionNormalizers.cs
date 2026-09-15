using System.Text.Json;
using System.Text.RegularExpressions;

using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Infrastructure.Helpers;

namespace FsusBlog.Server.Services.Articles;

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

public static class ArticleProductionNormalizers
{
    public const int MaxTitleLength = 256;
    public const int MaxSummaryLength = 512;
    public const int MaxContentLength = 200_000;
    public const int MaxCoverImageUrlLength = 512;
    public const int MaxTagIds = 32;

    public static string NormalizeText(string? raw, int maxLength)
    {
        string value = TextHelpers.TrimOrEmpty(raw);
        return value.Length > maxLength ? value[..maxLength] : value;
    }

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

    public static ArticleRightsNormalizedModel NormalizeArticleRights(ArticleRightsRequestCoreModel? request)
    {
        if (request is null)
        {
            return new ArticleRightsNormalizedModel(
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

        ArticleRightsRequestCoreModel value = request.Value;
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

    public static string? NormalizeOptionalRightsText(string? value, int maxLength)
    {
        string normalized = NormalizeText(value, maxLength);
        return normalized.Length == 0 ? null : normalized;
    }

    public static string NormalizeRightsToken(string? value, string fallback, int maxLength)
    {
        string? normalized = NormalizeText(value, maxLength);
        return string.IsNullOrWhiteSpace(normalized) ? fallback : normalized;
    }
}
