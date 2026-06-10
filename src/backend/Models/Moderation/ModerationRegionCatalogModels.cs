namespace FsusBlog.Server.Models.Moderation;

public static class ModerationRegionGroups
{
    public const string Global = "GLOBAL";
    public const string GreaterChina = "GREATER_CHINA";
    public const string Europe = "EU";
    public const string EuropeNonEu = "EUROPE_NON_EU";
    public const string NorthAmerica = "NORTH_AMERICA";
    public const string Apac = "APAC";
    public const string Sea = "SEA";
    public const string Commonwealth = "COMMONWEALTH";
    public const string Custom = "CUSTOM";
}

public sealed record ModerationRegionDefinition(
    string RegionCode,
    string DisplayName,
    string? ParentRegion,
    string? PrimaryGroup,
    string? PolicyTemplate,
    bool Enabled,
    bool Builtin,
    string? Description);

public sealed record ModerationRegionGroupDefinition(
    string GroupCode,
    string DisplayName,
    string? PolicyTemplate,
    bool Builtin,
    bool Enabled,
    IReadOnlyList<string> Regions,
    string? Description);

public sealed record ModerationPolicyTemplateRule(
    string Category,
    string SubmitAction,
    string DisplayAction);

public sealed record ModerationPolicyTemplateDefinition(
    string TemplateId,
    string Version,
    string Scope,
    string? Region,
    string? RegionGroup,
    string Source,
    string ReviewedBy,
    DateTime? ReviewedAtUtc,
    bool Builtin,
    bool Enabled,
    bool NotLegalAdvice,
    string Description,
    string Checksum,
    IReadOnlyList<ModerationPolicyTemplateRule> Rules);

public sealed record ModerationRegionCatalogSnapshot(
    string SnapshotId,
    string Version,
    string Checksum,
    DateTime CreatedAtUtc,
    IReadOnlyList<ModerationRegionDefinition> Regions,
    IReadOnlyList<ModerationRegionGroupDefinition> RegionGroups,
    IReadOnlyList<ModerationPolicyTemplateDefinition> PolicyTemplates,
    string? LastError);

public sealed record ModerationEffectivePolicyStep(
    string Step,
    string SourceId,
    string SourceType,
    IReadOnlyList<ModerationPolicyTemplateRule> Rules);

public sealed record ModerationEffectivePolicyRule(
    string Category,
    string SubmitAction,
    string DisplayAction,
    string SourceId,
    string SourceType);

public sealed record ModerationEffectivePolicyPreview(
    string Region,
    string DisplayName,
    IReadOnlyList<string> RegionGroups,
    IReadOnlyList<ModerationEffectivePolicyStep> Inheritance,
    IReadOnlyList<ModerationEffectivePolicyRule> Rules,
    string Checksum,
    IReadOnlyList<string> Warnings);
