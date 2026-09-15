namespace FsusBlog.Shared.Contracts.ArticleRelations;

/// <summary>Names the one closed, versioned article-relation contract family.</summary>
public static class ArticleRelationSchemas
{
    public const int Version = 1;
    public const int KindCatalogVersion = 1;
    public const int ResolutionCatalogVersion = 1;
    public const int VisibilityCatalogVersion = 1;
    public const int LifecycleCatalogVersion = 1;
    public const string Contract = "fsusblog.article-relation-contract.v1";
    public const string Relation = "fsusblog.article-relation.v1";
    public const string RelationSet = "fsusblog.article-relation-set.v1";
    public const string MentionCandidate = "fsusblog.article-relation-unlinked-mention.v1";
    public const string LifecycleEvent = "fsusblog.article-relation-lifecycle-event.v1";
    public const string Receipt = "fsusblog.article-relation-receipt.v1";
    public const string IgnoreDecisionReference = "fsusblog.article-relation-ignore-decision-reference.v1";
    public const string CanonicalSerialization = "length-prefixed-utf8-v1";
    public const string PublicQueryPolicy = "current-public-publication-only";
}

/// <summary>Closed relation kinds. Adding a kind requires a catalog and contract version change.</summary>
public enum ArticleRelationKind : byte
{
    Outgoing = 1,
    Backlink = 2,
    Broken = 3,
    VisibilityRisk = 4,
    UnlinkedMention = 5
}

/// <summary>Each relation kind has exactly one semantic owner.</summary>
public enum ArticleRelationOwner : byte
{
    SourceRevisionAuthority = 1,
    RelationIndexAuthority = 2,
    ResolutionAuthority = 3,
    VisibilityPolicyAuthority = 4,
    MentionMatcherAuthority = 5
}

[Flags]
public enum ArticleRelationEligibility : byte
{
    None = 0,
    AuthoringQuery = 1,
    PublicQuery = 2,
    PublicationEvidence = 4
}

/// <summary>Closed resolution states; unknown numeric values are invalid rather than private.</summary>
public enum ArticleRelationResolutionStatus : byte
{
    Resolved = 1,
    MissingTarget = 2,
    MissingAnchor = 3,
    Deleted = 4,
    Archived = 5,
    Unauthorized = 6,
    Private = 7,
    Draft = 8,
    Stale = 9,
    Ambiguous = 10,
    Unsupported = 11
}

/// <summary>Distinguishes draft, current and immutable published revision coordinates.</summary>
public enum ArticleRelationRevisionKind : byte
{
    Draft = 1,
    Current = 2,
    Published = 3
}

/// <summary>Lifecycle facts are explicit; no boolean visible flag is part of this contract.</summary>
public enum ArticleRelationLifecycleState : byte
{
    Draft = 1,
    Scheduled = 2,
    Published = 3,
    Archived = 4,
    Deleted = 5
}

/// <summary>Permission facts retain denied and unknown as distinct fail-closed values.</summary>
public enum ArticleRelationPermissionState : byte
{
    Allowed = 1,
    Denied = 2,
    Unknown = 3
}

/// <summary>Query/publication context is explicit and actor-bound.</summary>
public enum ArticleRelationQueryScope : byte
{
    Authoring = 1,
    CurrentPublicPublication = 2,
    PublicationEvidence = 3
}

public enum ArticleRelationPublicContext : byte
{
    AuthoringActor = 1,
    AnonymousPublic = 2,
    PublicationBuild = 3
}

public enum ArticleRelationTargetKind : byte
{
    Article = 1,
    Heading = 2,
    Block = 3
}

/// <summary>Lifecycle events have one explicit owner and deterministic obligations.</summary>
public enum ArticleRelationLifecycleEventKind : byte
{
    Create = 1,
    Edit = 2,
    Publish = 3,
    Schedule = 4,
    Archive = 5,
    Delete = 6,
    Restore = 7,
    Rollback = 8,
    Import = 9,
    Migration = 10,
    SlugTitleHeadingRename = 11
}

public enum ArticleRelationLifecycleOwner : byte
{
    SourceRevisionAuthority = 1,
    PublicationLifecycleAuthority = 2,
    ArticleIdentityAuthority = 3,
    ImportMigrationAuthority = 4
}

[Flags]
public enum ArticleRelationLifecycleChanges : byte
{
    None = 0,
    Slug = 1,
    Title = 2,
    HeadingIdentity = 4
}

[Flags]
public enum ArticleRelationLifecycleObligations : byte
{
    None = 0,
    Rebuild = 1,
    Invalidate = 2,
    Reresolve = 4
}

public enum ArticleRelationReceiptKind : byte
{
    Index = 1,
    Query = 2,
    IgnoreDecision = 3,
    Prepublish = 4,
    Inspector = 5
}

public enum ArticleRelationMentionMatchRule : byte
{
    ExactTitle = 1,
    ExactAlias = 2,
    UnicodeNormalizedAlias = 3
}

public enum ArticleRelationMentionMatchReason : byte
{
    ExactText = 1,
    RegisteredAlias = 2,
    CaseOrUnicodeNormalization = 3
}

public enum ArticleRelationMentionConfidence : byte
{
    Certain = 1,
    High = 2,
    Medium = 3
}

public enum ArticleRelationMentionAmbiguity : byte
{
    Unique = 1,
    Ambiguous = 2
}

/// <summary>Version coordinates make old relation/index/query/evidence artifacts invalid after drift.</summary>
public sealed record ArticleRelationContractCoordinate(
    int ContractVersion,
    int KindCatalogVersion,
    int ResolutionCatalogVersion,
    int VisibilityCatalogVersion,
    int LifecycleCatalogVersion);

/// <summary>Source actor and site context; the actor is never inferred from a target or display field.</summary>
public sealed record ArticleRelationActorContext(
    string ActorIdentity,
    string SiteIdentity,
    string PermissionContextDigest);

/// <summary>Stable source coordinate and its machine-readable revision/lifecycle facts.</summary>
public sealed record ArticleRelationSourceFacts(
    string ArticleIdentity,
    string RevisionIdentity,
    long RevisionNumber,
    ArticleRelationRevisionKind RevisionKind,
    ArticleRelationLifecycleState Lifecycle,
    ArticleRelationPermissionState Permission,
    ArticleRelationActorContext SourceActor,
    string ContentDigest);

/// <summary>Stable article/heading/block target identity; route, URL, slug and title are absent.</summary>
public sealed record ArticleRelationTargetIdentity(
    string ArticleIdentity,
    ArticleRelationTargetKind Kind,
    string? HeadingIdentity,
    string? BlockAnchorIdentity);

/// <summary>Target rights/lifecycle facts are carried separately from source and query actor facts.</summary>
public sealed record ArticleRelationTargetFacts(
    ArticleRelationTargetIdentity? TargetIdentity,
    string? RevisionIdentity,
    long? RevisionNumber,
    ArticleRelationRevisionKind? RevisionKind,
    ArticleRelationLifecycleState? Lifecycle,
    ArticleRelationPermissionState Permission);

/// <summary>Separates source actor, query actor/public context and the permission policy snapshot.</summary>
public sealed record ArticleRelationVisibilityFacts(
    ArticleRelationActorContext SourceActor,
    ArticleRelationActorContext QueryActor,
    ArticleRelationQueryScope QueryScope,
    ArticleRelationPublicContext PublicContext,
    string PermissionPolicyDigest);

/// <summary>UTF-16 half-open source range plus the exact link/matched text supplied by the producer.</summary>
public sealed record ArticleRelationSourceRange(
    int Start,
    int End,
    string MatchedText);

/// <summary>First/last occurrence and duplicate count are part of the relation fact, not an index side table.</summary>
public sealed record ArticleRelationOccurrence(
    string LinkText,
    ArticleRelationSourceRange First,
    ArticleRelationSourceRange Last,
    int Count);

/// <summary>One canonical relation record. It is a contract only; no parser, index writer or query is here.</summary>
public sealed record ArticleRelationRecord(
    string Schema,
    int SchemaVersion,
    string RelationIdentity,
    int IndexVersion,
    ArticleRelationKind Kind,
    ArticleRelationSourceFacts Source,
    ArticleRelationOccurrence Occurrence,
    ArticleRelationTargetFacts Target,
    ArticleRelationVisibilityFacts Visibility,
    ArticleRelationResolutionStatus Resolution,
    ArticleRelationContractCoordinate Coordinate,
    string RecordDigest);

/// <summary>Immutable batch shape used to validate duplicate and orphan relation records.</summary>
public sealed record ArticleRelationSet(
    string Schema,
    int SchemaVersion,
    ArticleRelationSourceFacts Source,
    IReadOnlyList<ArticleRelationRecord> Relations,
    string SetDigest);

/// <summary>Reference to an externally owned ignore decision; this contract does not implement the command.</summary>
public sealed record ArticleRelationIgnoreDecisionReference(
    string Schema,
    int SchemaVersion,
    string DecisionIdentity,
    long DecisionRevision,
    string DecisionDigest);

/// <summary>Unlinked mentions remain explainable candidates and are never authoritative relation truth.</summary>
public sealed record ArticleRelationUnlinkedMentionCandidate(
    string Schema,
    int SchemaVersion,
    string CandidateIdentity,
    ArticleRelationSourceFacts Source,
    ArticleRelationVisibilityFacts Visibility,
    ArticleRelationSourceRange MatchedRange,
    IReadOnlyList<ArticleRelationTargetIdentity> CandidateTargets,
    ArticleRelationMentionMatchRule MatchRule,
    ArticleRelationMentionMatchReason MatchReason,
    ArticleRelationMentionConfidence Confidence,
    ArticleRelationMentionAmbiguity Ambiguity,
    ArticleRelationIgnoreDecisionReference? IgnoreDecision,
    bool IsAuthoritative,
    ArticleRelationContractCoordinate Coordinate,
    string CandidateDigest);

/// <summary>Lifecycle change input and the obligations it imposes on downstream relation authorities.</summary>
public sealed record ArticleRelationLifecycleEvent(
    string Schema,
    int SchemaVersion,
    string EventIdentity,
    ArticleRelationLifecycleEventKind Kind,
    ArticleRelationLifecycleOwner Owner,
    string ArticleIdentity,
    string? RevisionIdentity,
    long EventRevision,
    ArticleRelationLifecycleChanges Changes,
    ArticleRelationLifecycleObligations Obligations,
    ArticleRelationContractCoordinate Coordinate,
    string EventDigest);

/// <summary>Receipt context binds all upstream toolchain and policy authorities without carrying content.</summary>
public sealed record ArticleRelationReceiptContext(
    string SourceArticleIdentity,
    string SourceRevisionIdentity,
    long SourceRevisionNumber,
    ArticleRelationRevisionKind SourceRevisionKind,
    ArticleRelationActorContext SourceActor,
    ArticleRelationActorContext QueryActor,
    ArticleRelationQueryScope QueryScope,
    string WorktreeIdentity,
    string BuildIdentity,
    string ParserContract,
    string RendererContract,
    int ArticleSchemaVersion,
    int PermissionPolicyVersion,
    ArticleRelationContractCoordinate Coordinate,
    string ContentDigest);

/// <summary>Portable evidence receipt for index/query/ignore/prepublish/inspector consumers.</summary>
public sealed record ArticleRelationReceipt(
    string Schema,
    int SchemaVersion,
    string ReceiptIdentity,
    ArticleRelationReceiptKind Kind,
    ArticleRelationReceiptContext Context,
    IReadOnlyList<string> RelationDigests,
    IReadOnlyList<string> CandidateDigests,
    int RelationCount,
    int CandidateCount,
    string ReceiptDigest);

public sealed record ArticleRelationKindDefinition(
    ArticleRelationKind Kind,
    string Key,
    ArticleRelationOwner Owner,
    ArticleRelationEligibility Eligibility,
    string SourceFacts,
    string TargetFacts,
    bool RequiresStableTarget,
    string ProofTestId);

/// <summary>Non-throwing validation result used by every relation contract boundary.</summary>
public readonly record struct ArticleRelationValidationResult(bool IsValid, string? ReasonCode)
{
    public static ArticleRelationValidationResult Valid() => new(true, null);

    public static ArticleRelationValidationResult Invalid(string reasonCode) => new(false, reasonCode);
}
