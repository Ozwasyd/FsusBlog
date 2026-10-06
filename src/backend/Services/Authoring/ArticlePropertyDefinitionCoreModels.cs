using System.Collections.Frozen;
using System.Collections.ObjectModel;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// The only closed value-type registry accepted by the article property definition
/// authority.  Values and projections are owned by the follow-up authorities; this
/// registry only describes their immutable shape.
/// </summary>
public enum ArticlePropertyValueType : short
{
    Text = 0,
    Number = 1,
    Boolean = 2,
    Date = 3,
    SingleSelect = 4,
    MultiSelect = 5,
    ArticleReference = 6,
    Url = 7
}

public enum ArticlePropertyDefinitionStatus : short
{
    Active = 0,
    Deprecated = 1,
    Deleted = 2
}

public enum ArticlePropertyCardinality : short
{
    Single = 0,
    Multiple = 1
}

public enum ArticlePropertyVisibilityScope : short
{
    AuthorOnly = 0,
    SiteEditors = 1,
    SiteReaders = 2
}

public enum ArticlePropertyDisplayPlacement : short
{
    Hidden = 0,
    Metadata = 1,
    Sidebar = 2
}

public enum ArticlePropertyOptionStatus : short
{
    Active = 0,
    Deprecated = 1,
    Deleted = 2
}

public enum ArticlePropertyMissingBehavior : short
{
    PreserveMissing = 0,
    ApplyDefault = 1
}

public enum ArticlePropertyNullBehavior : short
{
    AllowNull = 0,
    RejectNull = 1
}

public enum ArticlePropertyEmptyBehavior : short
{
    PreserveEmpty = 0,
    TreatAsNull = 1,
    RejectEmpty = 2
}

public enum ArticlePropertyDefaultKind : short
{
    None = 0,
    Null = 1,
    Scalar = 2,
    OptionIds = 3,
    ArticleIds = 4
}

public enum ArticlePropertyReferencePermission : short
{
    SourceActorMustReadTarget = 0,
    SiteEditorMayReference = 1
}

public enum ArticlePropertyUrlNormalization : short
{
    LowerSchemeHost = 0,
    PreservePathCase = 1
}

public sealed record ArticlePropertyOperatorDescriptor(
    string OperatorId,
    IReadOnlySet<ArticlePropertyValueType> ValueTypes,
    ArticlePropertyCardinality Cardinality,
    bool AcceptsValue,
    string Owner,
    string Consumer);

public readonly record struct ArticlePropertyDefinitionOwner(long? UserId, string SiteScope)
{
    public static ArticlePropertyDefinitionOwner User(long userId, string siteScope)
        => new(userId, siteScope);

    public static ArticlePropertyDefinitionOwner Site(string siteScope)
        => new(null, siteScope);
}

public sealed record ArticlePropertyDefinitionActor
{
    private readonly IReadOnlySet<string> _permissions;

    public ArticlePropertyDefinitionActor(long adminPrincipalId, IEnumerable<string> permissions)
    {
        ArgumentNullException.ThrowIfNull(permissions);
        AdminPrincipalId = adminPrincipalId;
        _permissions = permissions.ToFrozenSet(StringComparer.Ordinal);
        ArticlePropertyDefinitionContract.ValidateActor(this);
    }

    public long AdminPrincipalId
    {
        get;
    }

    public IReadOnlySet<string> Permissions => _permissions;
}

public sealed record ArticlePropertyLocalizedName(string Locale, string Value);

public sealed record ArticlePropertyOption(
    Guid OptionId,
    string Label,
    int Order,
    ArticlePropertyOptionStatus Status,
    IReadOnlyList<ArticlePropertyLocalizedName>? LocalizedLabels = null)
{
    public IReadOnlyList<ArticlePropertyLocalizedName> LocalizedLabels
    {
        get; init;
    } =
        Array.AsReadOnly((LocalizedLabels ?? []).ToArray());
}

public sealed record ArticlePropertyPresencePolicy(
    ArticlePropertyMissingBehavior Missing,
    ArticlePropertyNullBehavior Null,
    ArticlePropertyEmptyBehavior Empty);

public sealed record ArticlePropertyDefaultValue(
    ArticlePropertyDefaultKind Kind,
    string? Scalar = null,
    IReadOnlyList<Guid>? OptionIds = null,
    IReadOnlyList<long>? ArticleIds = null)
{
    public IReadOnlyList<Guid> OptionIds
    {
        get; init;
    } =
        Array.AsReadOnly((OptionIds ?? []).ToArray());

    public IReadOnlyList<long> ArticleIds
    {
        get; init;
    } =
        Array.AsReadOnly((ArticleIds ?? []).ToArray());
}

public sealed record ArticlePropertyConstraints(
    int? MinLength = null,
    int? MaxLength = null,
    decimal? MinNumber = null,
    decimal? MaxNumber = null,
    DateTime? MinDateUtc = null,
    DateTime? MaxDateUtc = null,
    int? MinItems = null,
    int? MaxItems = null);

public sealed record ArticlePropertyReferencePolicy(
    ArticlePropertyCardinality Cardinality,
    ArticlePropertyReferencePermission Permission,
    bool AllowCrossSite,
    bool AllowDeleted,
    bool AllowArchived,
    bool AllowSelfReference,
    bool AllowCycles);

public sealed record ArticlePropertyUrlPolicy(
    IReadOnlyList<string> AllowedSchemes,
    bool AllowRelative,
    bool AllowAbsolute,
    int MaxLength,
    ArticlePropertyUrlNormalization Normalization)
{
    public IReadOnlyList<string> AllowedSchemes
    {
        get; init;
    } =
        Array.AsReadOnly((AllowedSchemes ?? []).ToArray());
}

public sealed record ArticlePropertyDefinition(
    int SchemaVersion,
    Guid DefinitionId,
    ArticlePropertyDefinitionOwner Owner,
    string MachineKey,
    IReadOnlyList<ArticlePropertyLocalizedName> DisplayNames,
    ArticlePropertyValueType ValueType,
    ArticlePropertyCardinality Cardinality,
    bool Required,
    ArticlePropertyPresencePolicy Presence,
    ArticlePropertyDefaultValue? DefaultValue,
    ArticlePropertyConstraints Constraints,
    IReadOnlyList<ArticlePropertyOption> Options,
    ArticlePropertyReferencePolicy? ReferencePolicy,
    ArticlePropertyUrlPolicy? UrlPolicy,
    bool SearchEligible,
    bool Filterable,
    bool Sortable,
    ArticlePropertyDisplayPlacement DisplayPlacement,
    ArticlePropertyVisibilityScope VisibilityScope,
    ArticlePropertyDefinitionStatus Status,
    long SchemaRevision,
    DateTime CreatedAtUtc,
    DateTime UpdatedAtUtc,
    string ContentDigest)
{
    public IReadOnlyList<ArticlePropertyLocalizedName> DisplayNames
    {
        get; init;
    } =
        Array.AsReadOnly((DisplayNames ?? []).ToArray());

    public IReadOnlyList<ArticlePropertyOption> Options
    {
        get; init;
    } =
        Array.AsReadOnly((Options ?? []).ToArray());

    public ArticlePropertyLocalizedName PrimaryDisplayName
        => DisplayNames.FirstOrDefault(static name => string.Equals(name.Locale, "en", StringComparison.OrdinalIgnoreCase))
            ?? DisplayNames.FirstOrDefault()
            ?? throw new ArticlePropertyDefinitionValidationException("article_property_display_name_missing");
}

public sealed record ArticlePropertyDefinitionPageCursor(string MachineKey, Guid DefinitionId);

public sealed record ArticlePropertyDefinitionPage(
    IReadOnlyList<ArticlePropertyDefinition> Items,
    ArticlePropertyDefinitionPageCursor? NextCursor,
    long OwnerRevision);

public sealed record ArticlePropertyDefinitionObligation(
    string Kind,
    long? AffectedValueCount,
    bool RequiresReconciliation,
    string ReasonCode);

public sealed record ArticlePropertyDefinitionImpact(
    long? AffectedValueCount,
    IReadOnlyList<ArticlePropertyDefinitionObligation> Obligations)
{
    public IReadOnlyList<ArticlePropertyDefinitionObligation> Obligations
    {
        get; init;
    } =
        Array.AsReadOnly((Obligations ?? []).ToArray());
}

public sealed record ArticlePropertyDefinitionWriteReceipt(
    Guid ReceiptId,
    Guid RequestId,
    long ActorAdminPrincipalId,
    ArticlePropertyDefinitionOwner Owner,
    string CommandKind,
    string CommandDigest,
    Guid DefinitionId,
    long PreviousOwnerRevision,
    long OwnerRevision,
    long PreviousSchemaRevision,
    long SchemaRevision,
    ArticlePropertyDefinitionStatus Status,
    string BeforeDefinitionDigest,
    string AfterDefinitionDigest,
    string ConstraintDigest,
    string OptionsDigest,
    string PolicyDigest,
    string FlagsDigest,
    IReadOnlyList<ArticlePropertyDefinitionObligation> Obligations,
    Guid AuditReference,
    string AuditDigest,
    string ContentDigest,
    DateTime OccurredAtUtc,
    bool IsIdempotentReplay = false)
{
    public IReadOnlyList<ArticlePropertyDefinitionObligation> Obligations
    {
        get; init;
    } =
        Array.AsReadOnly((Obligations ?? []).ToArray());
}

public sealed record ArticlePropertyDefinitionAuditLink(
    Guid AuditReference,
    string EventInfo,
    string Action,
    string? TargetId,
    string Outcome,
    bool IsHighValue);

public sealed record ArticlePropertyDefinitionIdempotencyRecord(
    long ActorAdminPrincipalId,
    Guid RequestId,
    string CommandDigest,
    Guid ReceiptId);

public sealed record ArticlePropertyDefinitionVerificationSnapshot(
    ArticlePropertyDefinition Definition,
    IReadOnlyList<ArticlePropertyDefinitionWriteReceipt> Receipts,
    IReadOnlyList<ArticlePropertyDefinitionIdempotencyRecord> IdempotencyRecords,
    IReadOnlyList<ArticlePropertyDefinitionAuditLink> AuditLinks,
    bool ReceiptLimitExceeded,
    ArticlePropertyDefinitionReplaySnapshot? Replay = null);

/// <summary>
/// Complete owner command history and its real audit rows. These public digests
/// describe the history; only verification of the existing audit MAC chain can
/// authenticate it. Missing or truncated history cannot establish replay validity.
/// </summary>
public sealed record ArticlePropertyDefinitionReplaySnapshot(
    int HistoryVersion,
    ArticlePropertyDefinitionOwner Owner,
    long OwnerRevision,
    string GenesisDigest,
    string HeadDigest,
    IReadOnlyList<ArticlePropertyDefinition> Definitions,
    IReadOnlyList<ArticlePropertyDefinitionJournalEntry> Entries,
    IReadOnlyList<ArticlePropertyDefinitionIdempotencyRecord> IdempotencyRecords,
    IReadOnlyList<FsusBlog.Server.Entities.AuditLog> AuditRecords,
    bool HistoryLimitExceeded,
    bool AuditLimitExceeded,
    bool ResourceLimitExceeded = false);

public sealed record ArticlePropertyDefinitionVerificationViolation(string Code, string Detail);

public sealed record ArticlePropertyDefinitionVerificationResult(
    bool Valid,
    IReadOnlyList<ArticlePropertyDefinitionVerificationViolation> Violations);
