namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

public enum AuthoringApprovalOperation
{
    Migration = 1,
    Deletion = 2
}

public enum AuthoringApprovalStatus
{
    Pending = 0,
    Approved = 1,
    Denied = 2,
    Claimed = 3,
    Completed = 4,
    Failed = 5,
    RecoveryRequired = 6,
    Revoked = 7,
    Expired = 8
}

/// <summary>Host-internal port; an ID locates a decision and never constitutes approval.</summary>
public interface IAuthoringExtensionApprovalAuthority
{
    ValueTask<AuthoringExtensionApprovalAuthority.ApprovedClaim> ClaimMigrationAsync(
        string decisionId, VerifiedAuthoringPackage oldPackage, VerifiedAuthoringPackage newPackage,
        AuthoringFencedStateMigration frozenPlan, AuthoringLifecycleReceipt expectedLifecycleReceipt,
        CancellationToken cancellationToken = default);

    ValueTask<AuthoringExtensionApprovalAuthority.ApprovedClaim> ClaimDeletionAsync(
        string decisionId, VerifiedAuthoringPackage package, AuthoringStateMeasurement measurement,
        AuthoringLifecycleReceipt expectedLifecycleReceipt, CancellationToken cancellationToken = default);

    ValueTask CompleteAsync(AuthoringExtensionApprovalAuthority.ApprovedClaim claim,
        AuthoringLifecycleReceipt result, CancellationToken cancellationToken = default);

    ValueTask SettleFailureAsync(AuthoringExtensionApprovalAuthority.ApprovedClaim claim,
        AuthoringApprovalStatus terminal, CancellationToken cancellationToken = default);
}

/// <summary>
/// Versioned host operation binding shared with lifecycle preflight. This value describes scope;
/// only its containing server-issued ApprovedClaim grants authority. StateUserId remains opaque.
/// Policy v1 requires a current SQL system.config permission for the configured site, authorizing
/// administration of the explicitly confirmed extension state scope, not ownership as that user.
/// </summary>
public sealed record AuthoringExtensionOperationContext(
    int ContractVersion,
    string ActorBindingSha256,
    string AuthorizationPolicy,
    string SiteId,
    string StateUserId,
    string? DocumentId,
    string SourceScopeSha256,
    string? DestinationScopeSha256,
    long LifecycleGeneration,
    string LifecycleReceiptSha256);

/// <summary>Server-prepared confirmation view. A consumer must display both scopes and retention.</summary>
public sealed record AuthoringExtensionApprovalPreview(
    int ContractVersion,
    AuthoringExtensionOperationContext OperationContext,
    string DecisionId,
    AuthoringApprovalOperation Operation,
    AuthoringApprovalStatus Status,
    AuthoringStateScope Scope,
    AuthoringStateScope? DestinationScope,
    long Records,
    long Bytes,
    string Retention,
    string Digest,
    AuthoringFencedStateMigration? FrozenPlan,
    AuthoringStateMeasurement? Measurement,
    AuthoringLifecycleReceipt ExpectedLifecycleReceipt,
    DateTimeOffset ExpiresAt);

internal sealed record AuthoringApprovalActor(
    long PrincipalId, string SessionId, string SiteId,
    string PrincipalVersion, string SessionVersion, string Permissions,
    long PrincipalValidationVersion, long SessionValidationVersion);

// Protected at rest by the application's Data Protection provider, including every status transition.
// No state snapshots or MFA tokens are persisted here; plan defaults remain protected.
internal sealed record AuthoringApprovalDecision(
    int ContractVersion,
    string DecisionId,
    AuthoringApprovalOperation Operation,
    AuthoringApprovalStatus Status,
    long Revision,
    AuthoringApprovalActor Actor,
    string OldPackageIdentity,
    string NewPackageIdentity,
    AuthoringStateScope Scope,
    AuthoringFencedStateMigration? FrozenPlan,
    AuthoringStateMeasurement? Measurement,
    long Records,
    long Bytes,
    string Retention,
    string Digest,
    AuthoringLifecycleReceipt ExpectedLifecycleReceipt,
    DateTimeOffset ExpiresAt,
    string? ResultReceiptSha256)
{
    // A different plan ID or actor cannot create a second approval for the same frozen effect.
    public string OperationSha256 => AuthoringExtensionStateContract.Digest(new
    {
        Kind = "authoring-approval-effect-v1", Operation, OldPackageIdentity, NewPackageIdentity, Scope,
        Destination = FrozenPlan?.To,
        SourceRevision = FrozenPlan?.ExpectedFromRevision ?? Measurement!.Revision,
        DestinationRevision = FrozenPlan?.ExpectedToRevision,
        SourceContent = FrozenPlan?.SourceContentSha256 ?? Measurement!.ContentSha256,
        ExpectedLifecycleReceipt
    });

    public AuthoringExtensionOperationContext OperationContext => new(
        1, AuthoringExtensionStateContract.Digest(Actor), "system-config-site-state-admin-v1",
        Actor.SiteId, Scope.UserId, Scope.DocumentId, AuthoringExtensionStateContract.ScopeId(Scope),
        FrozenPlan is null ? null : AuthoringExtensionStateContract.ScopeId(FrozenPlan.To),
        ExpectedLifecycleReceipt.Generation, ExpectedLifecycleReceipt.ReceiptSha256);
}
