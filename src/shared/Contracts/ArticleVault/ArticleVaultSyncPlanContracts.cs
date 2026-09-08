namespace FsusBlog.Shared.Contracts.ArticleVault;

/// <summary>Defines the only supported Article Vault sync-plan schemas.</summary>
public static class ArticleVaultPlanSchemas
{
    public const string Plan = "fsusblog.article-vault.sync-plan.v1";
    public const string ServerObservation = "fsusblog.article-vault.server-observation.v1";
    public const int Version = 1;
}

/// <summary>Selects which side of a three-way comparison may supply mutations.</summary>
public enum VaultSyncDirection
{
    Pull,
    Push,
    Sync
}

/// <summary>Describes a deterministic article-level planner decision.</summary>
public enum VaultSyncDecision
{
    NoOp,
    PullCreate,
    PullUpdate,
    PullDelete,
    PushCreate,
    PushUpdate,
    PushDelete,
    Blocked
}

/// <summary>Describes whether a sealed plan may be offered to a later executor.</summary>
public enum VaultSyncPlanStatus
{
    Ready,
    NoOp,
    Blocked,
    Cancelled
}

/// <summary>Defines the only cancellation boundary supported by the planner.</summary>
public enum VaultSyncCancelPolicy
{
    BeforeExecutionOnly
}

/// <summary>Captures an explicit, content-addressed server observation.</summary>
public sealed record ArticleVaultServerObservation(
    string Schema,
    int SchemaVersion,
    string SiteIdentity,
    string VaultIdentity,
    string DeviceIdentity,
    string PortableArticleIdentity,
    string? ServerArticleIdentity,
    VaultArticleCoordinate ServerCoordinate,
    string ContentSha256);

/// <summary>Declares a directed dependency between two articles in one atomic group.</summary>
public sealed record VaultPlanDependency(
    string PrerequisitePortableArticleIdentity,
    string DependentPortableArticleIdentity);

/// <summary>Declares exact article membership and dependency edges for one atomic group.</summary>
public sealed record VaultPlanGroupRequest(
    string GroupIdentity,
    IReadOnlyList<string> PortableArticleIdentities,
    IReadOnlyList<VaultPlanDependency> Dependencies);

/// <summary>Provides verified manifests and explicit observations to the single sync planner.</summary>
public sealed record ArticleVaultPlanRequest(
    ArticleVaultRootManifest RootManifest,
    IReadOnlyList<ArticleVaultArticleManifest> ArticleManifests,
    IReadOnlyList<ArticleVaultServerObservation> ServerObservations,
    IReadOnlyList<VaultPlanGroupRequest> Groups,
    VaultSyncDirection Direction,
    long CreatedAtUnixMs,
    long ExpiresAtUnixMs,
    bool CancellationRequested);

/// <summary>Supplies current time and caller policy to independent plan verification.</summary>
public sealed record ArticleVaultPlanVerificationContext(
    long NowUnixMs,
    VaultSyncDirection Direction,
    bool CancellationRequested);

/// <summary>Freezes the current manifest and server-authority preconditions for one article.</summary>
public sealed record VaultSyncPlanPreconditions(
    string ArticleManifestSha256,
    string ServerObservationSha256,
    long? ExpectedServerRevision,
    string? ExpectedPermissionSha256,
    string? ExpectedLifecycle);

/// <summary>Freezes one article's three coordinates and deterministic decision.</summary>
public sealed record VaultSyncPlanItem(
    string OperationIdentity,
    long Sequence,
    string GroupIdentity,
    string PortableArticleIdentity,
    string? ServerArticleIdentity,
    VaultArticleState DerivedState,
    VaultSyncDecision Decision,
    VaultArticleCoordinate Base,
    VaultArticleCoordinate Local,
    VaultArticleCoordinate Server,
    VaultSyncPlanPreconditions Preconditions,
    IReadOnlyList<string> DependsOnOperationIdentities);

/// <summary>Freezes the exact members, edges, and ordered items of an all-or-nothing group.</summary>
public sealed record VaultSyncPlanGroup(
    string GroupIdentity,
    bool AllOrNothing,
    IReadOnlyList<string> PortableArticleIdentities,
    IReadOnlyList<VaultPlanDependency> Dependencies,
    IReadOnlyList<VaultSyncPlanItem> Items);

/// <summary>Classifies a deterministic blocker without resolving it.</summary>
public sealed record VaultSyncPlanConflict(
    string GroupIdentity,
    string PortableArticleIdentity,
    string ReasonCode);

/// <summary>Represents an immutable, deterministic, content-addressed three-way sync plan.</summary>
public sealed record ArticleVaultSyncPlan(
    string Schema,
    int SchemaVersion,
    string SiteIdentity,
    string VaultIdentity,
    string DeviceIdentity,
    VaultSyncDirection Direction,
    long CreatedAtUnixMs,
    long ExpiresAtUnixMs,
    VaultSyncCancelPolicy CancelPolicy,
    bool CancellationRequested,
    VaultSyncPlanStatus Status,
    string RootManifestSha256,
    IReadOnlyList<VaultSyncPlanGroup> Groups,
    IReadOnlyList<VaultSyncPlanConflict> Conflicts,
    IReadOnlyList<string> OperationOrder,
    string IdempotencyKey,
    string PlanCandidateIdentity,
    string ResultCandidateIdentity,
    string ContentSha256);

/// <summary>Returns either one sealed plan or stable fail-closed input errors.</summary>
public sealed record ArticleVaultPlanBuildResult(
    ArticleVaultSyncPlan? Plan,
    IReadOnlyList<string> Errors)
{
    /// <summary>Gets whether the planner produced one valid sealed plan.</summary>
    public bool IsSuccess => Plan is not null && Errors.Count == 0;
}
