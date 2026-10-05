namespace FsusBlog.Contracts.Articles;

/// <summary>Current rights input shared with the binary codec; no legacy identity or storage behavior.</summary>
public readonly record struct ArticleRightsRequestCoreModel(
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
