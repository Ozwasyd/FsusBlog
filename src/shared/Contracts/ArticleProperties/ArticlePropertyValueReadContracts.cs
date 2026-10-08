namespace FsusBlog.Shared.Contracts.ArticleProperties;

/// <summary>Private current-article read projection; persisted evidence remains distinct from candidates.</summary>
public sealed record ArticlePropertyValueReadResponse(
    int ArticleId,
    long CurrentArticleRevisionId,
    long PropertyRevision,
    ArticlePropertyValuePersistedSnapshot? Current,
    IReadOnlyList<ArticlePropertyDefinitionReadDescriptor> Definitions,
    IReadOnlyList<ArticlePropertyValueReconciliationRead> Reconciliation);

/// <summary>Closed numeric statuses are generated from the sole Server reconciliation enum.</summary>
public sealed record ArticlePropertyValueReconciliationRead(
    Guid DefinitionId,
    byte Status,
    string ReasonCode);

/// <summary>
/// Labels are display projections. DefinitionId/schema revision/digest are identity.
/// Closed numeric policy/type tags are generated from the existing definition owner enums.
/// </summary>
public sealed record ArticlePropertyDefinitionReadDescriptor(
    int SchemaVersion,
    Guid DefinitionId,
    long? DefinitionOwnerUserId,
    string SiteScope,
    string MachineKey,
    IReadOnlyList<ArticlePropertyReadLocalizedName> DisplayNames,
    byte ValueType,
    byte Cardinality,
    bool Required,
    ArticlePropertyReadPresencePolicy Presence,
    ArticlePropertyReadDefaultValue? DefaultValue,
    ArticlePropertyReadConstraints Constraints,
    IReadOnlyList<ArticlePropertyReadOption> Options,
    ArticlePropertyReadReferencePolicy? ReferencePolicy,
    ArticlePropertyReadUrlPolicy? UrlPolicy,
    bool SearchEligible,
    bool Filterable,
    bool Sortable,
    byte DisplayPlacement,
    byte VisibilityScope,
    byte Status,
    long SchemaRevision,
    DateTime CreatedAtUtc,
    DateTime UpdatedAtUtc,
    string ContentDigest);

public sealed record ArticlePropertyReadLocalizedName(string Locale, string Value);

public sealed record ArticlePropertyReadOption(
    Guid OptionId,
    string Label,
    int Order,
    byte Status,
    IReadOnlyList<ArticlePropertyReadLocalizedName> LocalizedLabels);

public sealed record ArticlePropertyReadPresencePolicy(byte Missing, byte Null, byte Empty);

/// <summary>Default payload uses the same closed eight variants as actual article values.</summary>
public sealed record ArticlePropertyReadDefaultValue(byte Kind, ArticlePropertyTypedValue? Value);

public sealed record ArticlePropertyReadConstraints(
    int? MinLength,
    int? MaxLength,
    decimal? MinNumber,
    decimal? MaxNumber,
    DateTime? MinDateUtc,
    DateTime? MaxDateUtc,
    int? MinItems,
    int? MaxItems);

public sealed record ArticlePropertyReadReferencePolicy(
    byte Cardinality,
    byte Permission,
    bool AllowCrossSite,
    bool AllowDeleted,
    bool AllowArchived,
    bool AllowSelfReference,
    bool AllowCycles);

public sealed record ArticlePropertyReadUrlPolicy(
    IReadOnlyList<string> AllowedSchemes,
    bool AllowRelative,
    bool AllowAbsolute,
    int MaxLength,
    byte Normalization);

public static class ArticlePropertyValueReadWireContract
{
    public const int SchemaVersion = 1;
    public const int MaxPayloadBytes = 8 * 1024 * 1024;
    public const int MaxAggregateItems = 40_000;
}
