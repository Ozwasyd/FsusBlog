using System.Collections.Immutable;

using Microsoft.AspNetCore.Http;

using Npgsql;

using static FsusBlog.Server.Infrastructure.AuthoringExtensions.AuthoringExtensionStateContract;

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
        AuthoringFencedStateMigration frozenPlan, ImmutableArray<AuthoringExecutionTarget> orderedOldTargets,
        ImmutableArray<AuthoringExecutionTarget> orderedNewTargets, AuthoringLifecycleReceipt expectedLifecycleReceipt,
        CancellationToken cancellationToken = default);

    ValueTask<AuthoringExtensionApprovalAuthority.ApprovedClaim> ClaimDeletionAsync(
        string decisionId, VerifiedAuthoringPackage package, AuthoringStateMeasurement measurement,
        AuthoringLifecycleReceipt expectedLifecycleReceipt, CancellationToken cancellationToken = default);

    ValueTask CompleteAsync(AuthoringExtensionApprovalAuthority.ApprovedClaim claim,
        AuthoringExtensionApprovalExecutionResult executionResult,
        AuthoringLifecycleReceipt result, CancellationToken cancellationToken = default);

    ValueTask SettleFailureAsync(AuthoringExtensionApprovalAuthority.ApprovedClaim claim,
        AuthoringApprovalStatus terminal, CancellationToken cancellationToken = default);
}

/// <summary>
/// Versioned host operation binding shared with lifecycle preflight. This value describes scope;
/// only its containing server-issued ApprovedClaim grants authority. StateUserId remains opaque.
/// SQL system.config proves an admin permission, not opaque user/document authority. The canonical
/// scope owner must explicitly authorize the exact scope and hold that permission through commit.
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
    string LifecycleReceiptSha256,
    string ScopeAuthorizationSha256);

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
    DateTimeOffset ExpiresAt,
    ImmutableArray<AuthoringExecutionTarget> OrderedOldTargets,
    ImmutableArray<AuthoringExecutionTarget> OrderedNewTargets);

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
    string? ResultReceiptSha256,
    ImmutableArray<AuthoringExecutionTarget> OrderedOldTargets,
    ImmutableArray<AuthoringExecutionTarget> OrderedNewTargets,
    string OldPackageSha256,
    string NewPackageSha256,
    string? ExecutionResultSha256,
    string ScopeAuthorizationSha256,
    string OldPackageVersion,
    string NewPackageVersion,
    int OldStateSchemaVersion,
    int NewStateSchemaVersion,
    int OldDataSchemaVersion,
    int NewDataSchemaVersion)
{
    // A different plan ID, actor or lifecycle head cannot recreate the same frozen effect.
    // The complete lifecycle receipt remains bound separately by Digest and OperationContext.
    public string OperationSha256 => AuthoringExtensionStateContract.Digest(new
    {
        Kind = "authoring-approval-effect-v1",
        Operation,
        OldPackageIdentity,
        NewPackageIdentity,
        Scope,
        Destination = FrozenPlan?.To,
        SourceRevision = FrozenPlan?.ExpectedFromRevision ?? Measurement!.Revision,
        DestinationRevision = FrozenPlan?.ExpectedToRevision,
        SourceContent = FrozenPlan?.SourceContentSha256 ?? Measurement!.ContentSha256
    });

    public AuthoringExtensionOperationContext OperationContext => new(
        2, AuthoringExtensionStateContract.Digest(Actor), "canonical-state-scope-authority-required-v1",
        Actor.SiteId, Scope.UserId, Scope.DocumentId, AuthoringExtensionStateContract.ScopeId(Scope),
        FrozenPlan is null ? null : AuthoringExtensionStateContract.ScopeId(FrozenPlan.To),
        ExpectedLifecycleReceipt.Generation, ExpectedLifecycleReceipt.ReceiptSha256, ScopeAuthorizationSha256);
}

/// <summary>
/// Original scope-owner read custody, not a new admin-to-user mapping or client credential.
/// The approval owner pins actor rows and acquires original state custody before requesting
/// this lease. VerifyCurrentAsync uses its held owner connection and never reacquires state keys.
/// Missing implementation always refuses. The owner must bind the authenticated actor to exact
/// original scopes, include revocation/version facts in AuthorizationSha256, and hold exclusion
/// against authority drift through disposal. The approval producer supplies no permissive adapter.
/// </summary>
public interface IAuthoringExtensionApprovalScopeAuthority
{
    ValueTask<IAuthoringExtensionApprovalScope> AcquireAsync(HttpContext context,
        AuthoringApprovalOperation operation, AuthoringStateScope scope, AuthoringStateScope? destinationScope,
        CancellationToken cancellationToken);

    /// <summary>
    /// Ordered approval acquisition. Validate the exact original held scope IDs and verify state
    /// through its owner connection, never through a new provenance-connection state SELECT.
    /// A missing implementation refuses; the legacy standalone acquisition is not an adapter.
    /// The scope provider does not own or dispose stateCustody.
    /// </summary>
    ValueTask<IAuthoringExtensionApprovalScope> AcquireWithStateCustodyAsync(HttpContext context,
        AuthoringApprovalOperation operation, AuthoringStateScope scope, AuthoringStateScope? destinationScope,
        IAuthoringExtensionStateObservation stateCustody, CancellationToken cancellationToken)
    {
        throw new AuthoringExtensionContractException("approval_ordered_scope_authority_unavailable");
    }

}

public interface IAuthoringExtensionApprovalScope : IAsyncDisposable
{
    string AuthorizationSha256
    {
        get;
    }
    ValueTask VerifyCurrentAsync(CancellationToken cancellationToken);
}

/// <summary>
/// Actual post-effect data, never an approval or native-readiness credential. Receipt ScopeDigest
/// commits this record's ContentSha256, not only the pre-effect approval digest. This host record
/// is not an AEDS frame and must not expose snapshot bytes through diagnostics or receipts.
/// </summary>
public sealed record AuthoringExtensionApprovalExecutionResult(
    int ContractVersion,
    string DecisionId,
    string OperationSha256,
    string ApprovalDigest,
    AuthoringApprovalOperation Operation,
    string PackageIdentity,
    string PackageSha256,
    string Version,
    int StateSchemaVersion,
    int DataSchemaVersion,
    string? FrozenPlanSha256,
    AuthoringStateSnapshot? AppliedSnapshot,
    AuthoringStateMeasurement? DeletionResult,
    ImmutableArray<AuthoringExecutionTarget> OrderedOldTargets,
    ImmutableArray<AuthoringExecutionTarget> OrderedNewTargets,
    long LifecycleGeneration,
    string ContentSha256);

/// <summary>
/// Read custody over the canonical owner's actual published generation, snapshot acceptance and
/// settled state facts. Implementations must hold original state exclusion and, for migration,
/// native/resource lifetimes through
/// disposal. A Running receipt or synthetic target roster cannot implement this authority.
/// Acquires original state custody after the supplied final transaction pins actor rows and
/// before provenance/decision/receipt locks. Original state observations may own a dedicated held transaction;
/// this does not enlist it or confer cross-store effect atomicity. Providers never commit/dispose
/// the supplied transaction. No custody held before actor pinning may be imported out of order;
/// verification only uses held owner connections and never reacquires state/receipt keys.
/// No implementation or production registration is supplied by the approval producer.
/// </summary>
public interface IAuthoringExtensionApprovalExecutionResultSource
{
    ValueTask<IAuthoringExtensionApprovalExecutionResultScope> AcquireAsync(
        NpgsqlConnection connection, NpgsqlTransaction transaction,
        AuthoringExtensionApprovalAuthority.ApprovedClaim claim, long generation,
        CancellationToken cancellationToken);
}

public interface IAuthoringExtensionApprovalExecutionResultScope : IAsyncDisposable
{
    IAuthoringExtensionStateObservation StateCustody
    {
        get;
    }
    AuthoringExtensionApprovalExecutionResult Result
    {
        get;
    }
    AuthoringStateSnapshot? SettledSourceSnapshot
    {
        get;
    }
    AuthoringStateSnapshot? SettledDestinationSnapshot
    {
        get;
    }
    AuthoringStateMeasurement? DeletedMeasurement
    {
        get;
    }
    ValueTask VerifyCurrentAsync(CancellationToken cancellationToken);
}

/// <summary>The sole approval/result codec. It reuses original plan, snapshot and target types.</summary>
public static class AuthoringExtensionApprovalContract
{
    public static ImmutableArray<AuthoringExecutionTarget> FreezeTargets(
        VerifiedAuthoringPackage package, ImmutableArray<AuthoringExecutionTarget> orderedTargets)
    {
        Require(!orderedTargets.IsDefaultOrEmpty && orderedTargets.Length == package.Contract.Manifest.Contributions.Length,
            "approval_target_roster_incomplete");
        ImmutableArray<AuthoringExecutionTarget> frozen = [.. orderedTargets];
        Require(frozen.Select(static target => target.ContributionId).Distinct(StringComparer.Ordinal).Count() == frozen.Length,
            "approval_target_roster_duplicate");
        foreach (AuthoringExecutionTarget target in frozen)
        {
            AuthoringContributionDeclaration? declaration = package.Contract.Manifest.Contributions.SingleOrDefault(
                item => item.Id == target.ContributionId);
            Require(declaration is not null && target.Status == AuthoringExecutionResolutionStatus.Ready &&
                target.BlockedReason is null && target.ExtensionId == package.Contract.Manifest.Id &&
                target.ExtensionVersion == package.Contract.Manifest.Version &&
                target.PackageSha256 == package.Contract.Manifest.PackageSha256 &&
                target.ContributionKind == declaration.Kind && target.ExecutionClass == declaration.ExecutionClass &&
                target.EntrypointIdentity == declaration.Entrypoint.PathOrAdapterId && IsDigest(target.RuntimeIdentity) &&
                (target.ExecutionClass == AuthoringExecutionClass.TrustedHostAdapter
                    ? target.TrustedAdapterId == declaration.Entrypoint.PathOrAdapterId && IsDigest(target.TrustedAdapterIdentity)
                    : target.TrustedAdapterId is null && target.TrustedAdapterIdentity is null),
                "approval_target_roster_identity_mismatch");
        }
        // Do not sort: the exact approved order is part of the operation contract.
        return frozen;
    }

    public static AuthoringExtensionApprovalExecutionResult MigrationResult(
        AuthoringExtensionApprovalAuthority.ApprovedClaim claim, AuthoringStateSnapshot actualAppliedSnapshot,
        ImmutableArray<AuthoringExecutionTarget> orderedOldTargets,
        ImmutableArray<AuthoringExecutionTarget> orderedNewTargets, long runningGeneration)
    {
        AuthoringStateSnapshot actual = DecodeSnapshot(Encode(actualAppliedSnapshot));
        var result = new AuthoringExtensionApprovalExecutionResult(1, claim.DecisionId, claim.OperationSha256,
            claim.Digest, AuthoringApprovalOperation.Migration, claim.ResultPackageIdentity, claim.ResultPackageSha256,
            claim.ResultVersion, claim.ResultStateSchemaVersion, claim.ResultDataSchemaVersion,
            claim.FrozenPlan?.ContentSha256, actual, null, [.. orderedOldTargets], [.. orderedNewTargets],
            runningGeneration, string.Empty);
        result = result with
        {
            ContentSha256 = ComputeContentSha256(result)
        };
        return FreezeResult(claim, result);
    }

    public static AuthoringExtensionApprovalExecutionResult DeletionResult(
        AuthoringExtensionApprovalAuthority.ApprovedClaim claim, AuthoringStateMeasurement actualDeletedMeasurement,
        long removedGeneration)
    {
        var result = new AuthoringExtensionApprovalExecutionResult(1, claim.DecisionId, claim.OperationSha256,
            claim.Digest, AuthoringApprovalOperation.Deletion, claim.ResultPackageIdentity, claim.ResultPackageSha256,
            claim.ResultVersion, claim.ResultStateSchemaVersion, claim.ResultDataSchemaVersion,
            null, null, actualDeletedMeasurement, [], [], removedGeneration, string.Empty);
        result = result with
        {
            ContentSha256 = ComputeContentSha256(result)
        };
        return FreezeResult(claim, result);
    }

    /// <summary>Checks actual original-owner data. Passing this check alone grants no runtime authority.</summary>
    public static void ValidateSettledMigration(AuthoringExtensionApprovalAuthority.ApprovedClaim claim, AuthoringStateSnapshot applied,
        AuthoringStateSnapshot? observedSource, AuthoringStateSnapshot? observedTarget, CancellationToken token)
    {
        Require(observedSource is not null && observedTarget is not null, "approval_settled_state_observation_missing");
        AuthoringStateSnapshot source = DecodeSnapshot(Encode(observedSource!));
        AuthoringStateSnapshot target = DecodeSnapshot(Encode(observedTarget!));
        AuthoringFencedStateMigration plan = claim.FrozenPlan!;
        Require(source.Scope == plan.From && source.PackageIdentity == claim.OldPackage.PackageIdentity &&
            target.Scope == plan.To && target.PackageIdentity == claim.NewPackage.PackageIdentity &&
            source.Revision == checked(plan.ExpectedFromRevision + 2) && target.Revision == checked(applied.Revision + 1),
            "approval_state_not_settled_at_exact_revisions");
        AuthoringStateSnapshot original = Snapshot(plan.From, claim.OldPackage.PackageIdentity, plan.ExpectedFromRevision, source.Entries);
        Require(original.ContentSha256 == plan.SourceContentSha256 &&
            Snapshot(plan.To, claim.NewPackage.PackageIdentity, applied.Revision, Transform(original, plan, token)).ContentSha256 == applied.ContentSha256 &&
            Snapshot(plan.To, claim.NewPackage.PackageIdentity, target.Revision, applied.Entries).ContentSha256 == target.ContentSha256,
            "approval_applied_or_settled_snapshot_drift");
    }

    public static string ComputeContentSha256(AuthoringExtensionApprovalExecutionResult result) =>
        Digest(new
        {
            Kind = "authoring-approval-execution-result-v1",
            Result = result with
            {
                ContentSha256 = string.Empty
            }
        });

    public static AuthoringExtensionApprovalExecutionResult FreezeResult(
        AuthoringExtensionApprovalAuthority.ApprovedClaim claim, AuthoringExtensionApprovalExecutionResult result)
    {
        Require(result.ContractVersion == 1 && result.DecisionId == claim.DecisionId &&
            result.OperationSha256 == claim.OperationSha256 && result.ApprovalDigest == claim.Digest &&
            result.Operation == claim.Operation && result.PackageIdentity == claim.ResultPackageIdentity &&
            result.PackageSha256 == claim.ResultPackageSha256 && result.Version == claim.ResultVersion &&
            result.StateSchemaVersion == claim.ResultStateSchemaVersion && result.DataSchemaVersion == claim.ResultDataSchemaVersion &&
            result.LifecycleGeneration > claim.ExpectedLifecycleReceipt.Generation &&
            !result.OrderedOldTargets.IsDefault && !result.OrderedNewTargets.IsDefault &&
            result.OrderedOldTargets.SequenceEqual(claim.OrderedOldTargets) &&
            result.OrderedNewTargets.SequenceEqual(claim.OrderedNewTargets), "approval_execution_binding_mismatch");
        AuthoringStateSnapshot? snapshot = null;
        if (claim.Operation == AuthoringApprovalOperation.Migration)
        {
            AuthoringFencedStateMigration plan = claim.FrozenPlan!;
            Require(result.AppliedSnapshot is not null && result.DeletionResult is null &&
                result.FrozenPlanSha256 == plan.ContentSha256, "approval_applied_snapshot_missing");
            snapshot = DecodeSnapshot(Encode(result.AppliedSnapshot!));
            Require(snapshot.Scope == plan.To && snapshot.PackageIdentity == claim.ResultPackageIdentity &&
                snapshot.Revision == checked(plan.ExpectedToRevision + 2), "approval_applied_snapshot_identity_mismatch");
        }
        else
        {
            AuthoringStateMeasurement before = claim.FencedDeletion!.Expected;
            AuthoringStateMeasurement? deleted = result.DeletionResult;
            Require(result.AppliedSnapshot is null && result.FrozenPlanSha256 is null && deleted is not null &&
                deleted.Scope == before.Scope && deleted.Revision == checked(before.Revision + 1) &&
                deleted.Records == 0 && deleted.Bytes == 0 && IsDigest(deleted.ContentSha256),
                "approval_deleted_measurement_invalid");
        }
        AuthoringExtensionApprovalExecutionResult frozen = result with
        {
            AppliedSnapshot = snapshot,
            OrderedOldTargets = [.. result.OrderedOldTargets],
            OrderedNewTargets = [.. result.OrderedNewTargets]
        };
        Require(IsDigest(result.ContentSha256) && ComputeContentSha256(frozen) == result.ContentSha256,
            "approval_execution_digest_mismatch");
        return frozen;
    }
}
