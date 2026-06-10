namespace FsusBlog.Server.Models.Moderation;

public static class ModerationDictionaryActions
{
    public const string Allow = "allow";
    public const string ManualReview = "manual_review";
    public const string ManualReviewNoPublicDisplay = "manual_review_no_public_display";
    public const string RejectSubmit = "reject_submit";
    public const string GeoBlock = "geo_block";
}

public static class ModerationEvidencePolicies
{
    public const string ShowFull = "show_full";
    public const string ShowCategoryOnly = "show_category_only";
    public const string Redact = "redact";
}

public sealed record ModerationDictionaryTerm(
    string Value,
    IReadOnlyList<string> Aliases,
    string Category,
    string Severity,
    string Reason,
    string EvidencePolicy);

public sealed record ModerationDictionaryDefinition(
    string DictionaryId,
    string Version,
    string Scope,
    string? Region,
    string Category,
    string MatchMode,
    string Normalization,
    string SeverityDefault,
    string Source,
    string ReviewedBy,
    DateTime UpdatedAtUtc,
    string Checksum,
    IReadOnlyList<ModerationDictionaryTerm> Terms);

public sealed record ModerationRegionPolicyRule(
    string Category,
    string SubmitAction,
    string DisplayAction);

public sealed record ModerationRegionPolicyDefinition(
    string Region,
    string Version,
    IReadOnlyList<string> Inherits,
    IReadOnlyList<string> DictionaryIds,
    IReadOnlyList<ModerationRegionPolicyRule> Rules,
    string Checksum,
    DateTime LoadedAtUtc);

public sealed record ModerationDictionarySnapshot(
    string SnapshotId,
    string Version,
    IReadOnlyDictionary<string, ModerationDictionaryDefinition> Dictionaries,
    IReadOnlyDictionary<string, ModerationRegionPolicyDefinition> RegionPolicies,
    string Checksum,
    DateTime CreatedAtUtc)
{
    public static ModerationDictionarySnapshot Empty { get; } = new(
        "moderation-dictionary-empty",
        "empty",
        new Dictionary<string, ModerationDictionaryDefinition>(StringComparer.Ordinal),
        new Dictionary<string, ModerationRegionPolicyDefinition>(StringComparer.Ordinal),
        string.Empty,
        DateTime.UnixEpoch);
}

public sealed record ModerationDictionaryMatch(
    string DictionaryId,
    string Category,
    string Severity,
    string Reason,
    string EvidencePolicy,
    string? Evidence,
    string MatchedRegion);

public sealed record ModerationPolicyAction(
    string SubmitAction,
    string DisplayAction);

public sealed record ModerationDictionaryRuntimeSnapshot(
    string SnapshotId,
    string Version,
    string Checksum,
    DateTime CreatedAtUtc,
    IReadOnlyList<ModerationDictionaryRuntimeItem> Dictionaries,
    IReadOnlyList<ModerationRegionPolicyRuntimeItem> RegionPolicies,
    string? LastError);

public sealed record ModerationDictionaryRuntimeItem(
    string DictionaryId,
    string Version,
    string Scope,
    string? Region,
    string Category,
    string Source,
    string ReviewedBy,
    DateTime UpdatedAtUtc,
    string Checksum,
    int TermCount);

public sealed record ModerationRegionPolicyRuntimeItem(
    string Region,
    string Version,
    IReadOnlyList<string> Inherits,
    IReadOnlyList<string> DictionaryIds,
    string Checksum,
    int RuleCount);
