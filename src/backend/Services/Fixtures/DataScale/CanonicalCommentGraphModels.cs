namespace FsusBlog.Server.Services.Fixtures.DataScale;

/// <summary>
/// Required production authorities. A reference records provenance, not proof that
/// the referenced capability was executed or accepted.
/// </summary>
public enum CommentScaleAuthority
{
    Thread,
    ActorPrivacy,
    Region,
    ModerationTimeline,
    Revision,
    Outbox,
    Nullifier,
    ManagementCapability,
    ReplyNotification,
    NativeIdentity
}

/// <summary>Provider-neutral graph obligations; these declarations contain no rows.</summary>
public enum CommentScaleRelation
{
    ArticleTarget,
    CurrentRevision,
    ThreadCoordinates,
    RegionCompliance,
    ModerationTimeline,
    CreatedOutbox,
    VisibilityOutbox,
    AuditCoordinates,
    NullifierReservationAndConsumption,
    ManagementCommitment,
    ReplyNotification
}

/// <summary>Identifies the credential evidence class without storing credential material.</summary>
public enum CommentScaleCredentialValidity
{
    PublicAuthenticated,
    VerifiedTestCredential,
    ScaleSyntheticTestOnly
}

/// <summary>Names the planned thread coverage without supplying computed coordinates.</summary>
public enum CommentScaleThreadShape
{
    ZeroCommentArticle,
    WideRoots,
    DeepChain,
    MixedReplyTargets,
    DeletedRootWithVisibleDescendants,
    MaxDepthBoundary,
    ChildLimitBoundary
}

/// <summary>Content-addressed source handoff from a canonical production owner.</summary>
public sealed record CommentScaleAuthorityReference(
    CommentScaleAuthority Authority,
    string SourceCommit,
    string ContractDigest);

/// <summary>Reference to an existing artifact; no content or time is synthesized here.</summary>
public sealed record CommentScaleArtifactReference(
    string Schema,
    string ContentDigest);

/// <summary>
/// Required relations for a scenario. Applicability must later be resolved by the
/// corresponding production authority, including reply recipients and crypto validity.
/// </summary>
public sealed record CommentScaleGraphRequirements(
    IReadOnlyList<CommentScaleRelation> Relations,
    IReadOnlyList<CommentScaleAuthorityReference> Authorities);
