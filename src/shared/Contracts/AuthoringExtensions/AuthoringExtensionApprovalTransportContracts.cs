namespace FsusBlog.Shared.Contracts.AuthoringExtensions;

/// <summary>Locates an original decision; neither this record nor its wire frame grants approval.</summary>
public sealed record AuthoringExtensionApprovalDecisionRequest(int ContractVersion, string DecisionId);

/// <summary>Explicit displayed-digest confirmation. Verified packages and frozen facts remain host inputs.</summary>
public sealed record AuthoringExtensionApprovalConfirmationRequest(
    int ContractVersion, string DecisionId, string DisplayedDigest, string StepUpProof);

/// <summary>Display coordinates from the original issuer; opaque user/document IDs grant no scope access.</summary>
public sealed record AuthoringApprovalScopeView(
    string ExtensionId, string ExtensionVersion, string SiteId, string UserId, string? DocumentId, int SchemaVersion);

/// <summary>Original versioned host authorization bindings projected for private display, never a caller credential.</summary>
public sealed record AuthoringApprovalOperationContextView(
    int ContractVersion, string ActorBindingSha256, string AuthorizationPolicy, string SiteId,
    string StateUserId, string? DocumentId, string SourceScopeSha256, string? DestinationScopeSha256,
    long LifecycleGeneration, string LifecycleReceiptSha256, string ScopeAuthorizationSha256);

/// <summary>Display summary of the original full frozen plan digest; contains no state/default bytes.</summary>
public sealed record AuthoringApprovalPlanSummary(
    int ContractVersion, string PlanId, long ExpectedFromRevision, long ExpectedToRevision,
    string SourceContentSha256, long MaximumRecords, long MaximumBytes, long MaximumDurationTicks,
    int TransformCount, string BackupReference, string RollbackReference, string ContentSha256);

/// <summary>Original exact deletion measurement, without state payload or a deletion authorization flag.</summary>
public sealed record AuthoringApprovalMeasurementView(
    AuthoringApprovalScopeView Scope, long Revision, long Records, long Bytes, string ContentSha256);

/// <summary>Original durable lifecycle fields; package SHA-256 remains the manifest payload identity.</summary>
public sealed record AuthoringApprovalLifecycleReceiptView(
    int SchemaVersion, long Sequence, string ExtensionId, string PackageSha256, string Version,
    int StateSchemaVersion, int DataSchemaVersion, byte PreviousState, byte State, long Generation,
    string ScopeDigest, string? FailureCode, string PreviousReceiptSha256, string ReceiptSha256);

/// <summary>Original ordered target descriptor for display; it is not native generation or acceptance custody.</summary>
public sealed record AuthoringApprovalExecutionTargetView(
    byte Status, byte ExecutionClass, string ExtensionId, string ExtensionVersion, string PackageSha256,
    string ContributionId, byte ContributionKind, string EntrypointIdentity, string? TrustedAdapterId,
    string RuntimeIdentity, string? BlockedReason, string? TrustedAdapterIdentity);

/// <summary>
/// Private display projection of the original issuer's preview v2. A snapshot, execution result,
/// ApprovedClaim, permission assertion or native-readiness credential is never a transport record.
/// </summary>
public sealed record AuthoringExtensionApprovalPreviewResponse(
    int ContractVersion, AuthoringApprovalOperationContextView OperationContext, string DecisionId,
    byte Operation, byte Status, AuthoringApprovalScopeView Scope, AuthoringApprovalScopeView? DestinationScope,
    long Records, long Bytes, string Retention, string Digest, AuthoringApprovalPlanSummary? FrozenPlan,
    AuthoringApprovalMeasurementView? Measurement, AuthoringApprovalLifecycleReceiptView ExpectedLifecycleReceipt,
    DateTime ExpiresAtUtc, IReadOnlyList<AuthoringApprovalExecutionTargetView> OrderedOldTargets,
    IReadOnlyList<AuthoringApprovalExecutionTargetView> OrderedNewTargets);
