using System.Collections.Immutable;

namespace FsusBlog.Shared.Contracts.ArticleVault;

/// <summary>Names the conflict-only contract; the original sync-plan V1 is unchanged.</summary>
public static class ArticleVaultConflictSchemas
{
    public const string Evidence = "fsusblog.article-vault.conflict-evidence.v1";
    public const string Registry = "fsusblog.article-vault.conflict-registry.v1";
    public const int Version = 1;
}

/// <summary>Enumerates the exact twelve conflict classifications owned by the Vault protocol.</summary>
public enum VaultConflictType
{
    SourceDisjoint = 1,
    SourceOverlap,
    MetadataDisjoint,
    MetadataOverlap,
    RenameVsEdit,
    DeleteVsEdit,
    CreateCreate,
    LifecycleConflict,
    PermissionConflict,
    SchemaConflict,
    DependencyConflict,
    GitMarkerPresent
}

/// <summary>Classifies eligibility without executing a merge or choosing a winner.</summary>
public enum VaultConflictDisposition
{
    Automatic = 1,
    Manual,
    Rejected
}

/// <summary>Names only future per-item actions; no global or generic winner action exists.</summary>
public enum VaultConflictAction
{
    PrepareSourceCandidate = 1,
    PrepareMetadataCandidate,
    ProposeSourceReplacement,
    ProposeMetadataReplacement,
    RequestRefactorPlan,
    RequestDeletionPlan,
    RefreshEvidence,
    CancelOperation
}

/// <summary>Identifies the authority that an action must preserve.</summary>
public enum VaultConflictAuthorityBoundary
{
    VerifiedSourceCandidate = 1,
    VerifiedMetadataCandidate,
    PortableIdentity,
    CanonicalDeletion,
    ServerLifecycle,
    ServerPermission,
    Schema,
    Dependency,
    GitFactsOnly
}

/// <summary>Names independently observed evidence, never a caller asserted verification flag.</summary>
public enum VaultConflictFactKind
{
    SourceChanges = 1,
    MetadataChanges,
    IdentityProjection,
    Deletion,
    Creation,
    Lifecycle,
    Permission,
    Schema,
    Dependency,
    GitMarkers
}

/// <summary>Defines the stable editable metadata fields; server authority fields are excluded.</summary>
public enum VaultConflictMetadataField
{
    Title = 1,
    Summary,
    Slug,
    Taxonomy,
    Properties
}

/// <summary>Freezes exact disposition, owner, evidence, actions, authority and proof-test identity.</summary>
public sealed record VaultConflictRegistryEntry(
    VaultConflictType Type,
    VaultConflictDisposition Disposition,
    string Owner,
    VaultConflictFactKind RequiredFact,
    ImmutableArray<VaultConflictAction> AllowedActions,
    VaultConflictAuthorityBoundary AuthorityBoundary,
    string ProofTestIdentity);

/// <summary>Freezes a half-open base-byte change range and parser-owned semantic node identity.</summary>
public sealed record VaultConflictSourceChange(long Start, long End, string SemanticNodeIdentity);

/// <summary>References current source diagnostics from the sole merge/parser owner; contains no source text.</summary>
public sealed record VaultConflictSourceFacts(
    string ParserIdentity,
    int ParserVersion,
    string ParserSha256,
    string AlgorithmSha256,
    ImmutableArray<VaultConflictSourceChange> LocalChanges,
    ImmutableArray<VaultConflictSourceChange> ServerChanges);

/// <summary>Binds one stable field/entity to its base, local and server value digests.</summary>
public sealed record VaultConflictMetadataChange(
    VaultConflictMetadataField Field,
    string? EntityIdentity,
    string BaseValueSha256,
    string LocalValueSha256,
    string ServerValueSha256);

/// <summary>References the current closed field schema and exact three-way field changes.</summary>
public sealed record VaultConflictMetadataFacts(
    string FieldRegistrySha256,
    ImmutableArray<VaultConflictMetadataChange> Changes);

/// <summary>Records only non-authoritative path projections; the portable identity stays in the binding.</summary>
public sealed record VaultConflictRenameFacts(
    VaultPathProjection Base,
    VaultPathProjection Local,
    VaultPathProjection Server);

/// <summary>References read-only Git diagnostics, never commands, remote URLs or credentials.</summary>
public sealed record VaultConflictGitFacts(
    string WorktreeIdentity,
    string HeadFactsSha256,
    string IndexFactsSha256,
    ImmutableArray<VaultConflictSourceChange> MarkerRanges);

/// <summary>Binds a specific authority fact to all three exact coordinate digests.</summary>
public sealed record VaultConflictAuthorityFact(
    VaultConflictFactKind Kind,
    string BaseCoordinateSha256,
    string LocalCoordinateSha256,
    string ServerCoordinateSha256,
    VaultConflictRenameFacts? Rename,
    VaultConflictGitFacts? Git);

/// <summary>Captures facts supplied by an independent current source/metadata/authority reader.</summary>
public sealed record VaultConflictObservation(
    VaultConflictType Type,
    VaultConflictSourceFacts? Source,
    VaultConflictMetadataFacts? Metadata,
    VaultConflictAuthorityFact? Authority);

/// <summary>Retains a specific typed item and its permitted actions even under a generic UI status.</summary>
public sealed record VaultConflictItem(
    VaultConflictType Type,
    VaultConflictDisposition Disposition,
    ImmutableArray<VaultConflictAction> AllowedActions,
    VaultConflictObservation Observation);

/// <summary>Binds conflict evidence to one exact original plan item and all three coordinates.</summary>
public sealed record VaultConflictBinding(
    string SiteIdentity,
    string VaultIdentity,
    string DeviceIdentity,
    string PortableArticleIdentity,
    string? ServerArticleIdentity,
    string PlanCandidateIdentity,
    string PlanSha256,
    string GroupIdentity,
    string OperationIdentity,
    string ArticleManifestSha256,
    string ServerObservationSha256,
    VaultArticleCoordinates Coordinates);

/// <summary>Contains classifications only; it cannot carry a writer command or resolution decision.</summary>
public sealed record ArticleVaultConflictEvidence(
    string Schema,
    int SchemaVersion,
    string RegistrySha256,
    VaultConflictBinding Binding,
    ImmutableArray<VaultConflictItem> Items,
    string ContentSha256);
