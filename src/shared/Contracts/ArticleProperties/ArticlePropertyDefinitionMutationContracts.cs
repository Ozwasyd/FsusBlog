namespace FsusBlog.Shared.Contracts.ArticleProperties;

/// <summary>Bounded transport projection; authorization and persisted facts belong to the original definition store.</summary>
public sealed record ArticlePropertyDefinitionSettings(
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
    byte VisibilityScope);

/// <summary>Bounded transport projection; authorization and persisted facts belong to the original definition store.</summary>
public sealed record ArticlePropertyDefinitionCreateRequest(
    Guid RequestId,
    long? DefinitionOwnerUserId,
    string SiteScope,
    Guid DefinitionId,
    long ExpectedOwnerRevision,
    string MachineKey,
    IReadOnlyList<ArticlePropertyReadLocalizedName> DisplayNames,
    ArticlePropertyDefinitionSettings Settings);

/// <summary>Bounded transport projection; authorization and persisted facts belong to the original definition store.</summary>
public sealed record ArticlePropertyDefinitionUpdateRequest(
    Guid RequestId,
    long? DefinitionOwnerUserId,
    string SiteScope,
    Guid DefinitionId,
    long ExpectedOwnerRevision,
    long ExpectedSchemaRevision,
    ArticlePropertyDefinitionSettings Settings);

/// <summary>Bounded transport projection; authorization and persisted facts belong to the original definition store.</summary>
public sealed record ArticlePropertyDefinitionRenameRequest(
    Guid RequestId,
    long? DefinitionOwnerUserId,
    string SiteScope,
    Guid DefinitionId,
    long ExpectedOwnerRevision,
    long ExpectedSchemaRevision,
    IReadOnlyList<ArticlePropertyReadLocalizedName> DisplayNames);

/// <summary>Bounded transport projection; authorization and persisted facts belong to the original definition store.</summary>
public sealed record ArticlePropertyDefinitionDeprecateRequest(
    Guid RequestId,
    long? DefinitionOwnerUserId,
    string SiteScope,
    Guid DefinitionId,
    long ExpectedOwnerRevision,
    long ExpectedSchemaRevision);

/// <summary>Bounded transport projection; authorization and persisted facts belong to the original definition store.</summary>
public sealed record ArticlePropertyDefinitionDeleteRequest(
    Guid RequestId,
    long? DefinitionOwnerUserId,
    string SiteScope,
    Guid DefinitionId,
    long ExpectedOwnerRevision,
    long ExpectedSchemaRevision);

/// <summary>Bounded transport projection; authorization and persisted facts belong to the original definition store.</summary>
public sealed record ArticlePropertyDefinitionMutationObligation(
    string Kind,
    long? AffectedValueCount,
    bool RequiresReconciliation,
    string ReasonCode);

/// <summary>Bounded transport projection; authorization and persisted facts belong to the original definition store.</summary>
public sealed record ArticlePropertyDefinitionMutationReceipt(
    Guid ReceiptId,
    Guid RequestId,
    long ActorAdminPrincipalId,
    long? DefinitionOwnerUserId,
    string SiteScope,
    string CommandKind,
    string CommandDigest,
    Guid DefinitionId,
    long PreviousOwnerRevision,
    long OwnerRevision,
    long PreviousSchemaRevision,
    long SchemaRevision,
    byte Status,
    string BeforeDefinitionDigest,
    string AfterDefinitionDigest,
    string ConstraintDigest,
    string OptionsDigest,
    string PolicyDigest,
    string FlagsDigest,
    IReadOnlyList<ArticlePropertyDefinitionMutationObligation> Obligations,
    Guid AuditReference,
    string AuditDigest,
    string ContentDigest,
    DateTime OccurredAtUtc,
    bool IsIdempotentReplay);
