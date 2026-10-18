using System.Buffers;
using System.Collections.Immutable;

using FsusBlog.Core.Cache;
using FsusBlog.Server.Infrastructure.AuthoringExtensions;
using FsusBlog.Shared.Contracts.AuthoringExtensions;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Unregistered host transport adapter around the original issuer. Verified package/plan inputs
/// remain host facts. This adapter supplies no scope, native, state or snapshot-acceptance custody.
/// Execution claims and results deliberately have no client transport entry point.
/// </summary>
public sealed class AuthoringExtensionApprovalTransport(AuthoringExtensionApprovalAuthority authority)
{
    public async ValueTask<AuthoringExtensionApprovalPreviewResponse> ReadAsync(
        AuthoringExtensionApprovalDecisionRequest request, CancellationToken cancellationToken = default)
    {
        Validate(request);
        return Project(await authority.ReadAsync(request.DecisionId, cancellationToken));
    }

    public async ValueTask<AuthoringExtensionApprovalPreviewResponse> DenyAsync(
        AuthoringExtensionApprovalDecisionRequest request, CancellationToken cancellationToken = default)
    {
        Validate(request);
        return Project(await authority.DenyAsync(request.DecisionId, cancellationToken));
    }

    public async ValueTask<AuthoringExtensionApprovalPreviewResponse> RevokeAsync(
        AuthoringExtensionApprovalDecisionRequest request, CancellationToken cancellationToken = default)
    {
        Validate(request);
        return Project(await authority.RevokeAsync(request.DecisionId, cancellationToken));
    }

    public async ValueTask<AuthoringExtensionApprovalPreviewResponse> PrepareMigrationAsync(
        VerifiedAuthoringPackage oldPackage, VerifiedAuthoringPackage newPackage, AuthoringFencedStateMigration plan,
        ImmutableArray<AuthoringExecutionTarget> orderedOldTargets, ImmutableArray<AuthoringExecutionTarget> orderedNewTargets,
        AuthoringLifecycleReceipt expectedLifecycleReceipt, CancellationToken cancellationToken = default)
        => Project(await authority.PrepareMigrationAsync(oldPackage, newPackage, plan, orderedOldTargets,
            orderedNewTargets, expectedLifecycleReceipt, cancellationToken));

    public async ValueTask<AuthoringExtensionApprovalPreviewResponse> PrepareDeletionAsync(
        VerifiedAuthoringPackage package, AuthoringStateScope scope, AuthoringLifecycleReceipt expectedLifecycleReceipt,
        CancellationToken cancellationToken = default)
        => Project(await authority.PrepareDeletionAsync(package, scope, expectedLifecycleReceipt, cancellationToken));

    public async ValueTask<AuthoringExtensionApprovalPreviewResponse> ConfirmMigrationAsync(
        AuthoringExtensionApprovalConfirmationRequest request, VerifiedAuthoringPackage oldPackage,
        VerifiedAuthoringPackage newPackage, AuthoringFencedStateMigration plan,
        ImmutableArray<AuthoringExecutionTarget> orderedOldTargets, ImmutableArray<AuthoringExecutionTarget> orderedNewTargets,
        AuthoringLifecycleReceipt expectedLifecycleReceipt, CancellationToken cancellationToken = default)
    {
        Validate(request);
        return Project(await authority.ConfirmMigrationAsync(request.DecisionId, oldPackage, newPackage, plan,
            orderedOldTargets, orderedNewTargets, expectedLifecycleReceipt, request.DisplayedDigest,
            request.StepUpProof, cancellationToken));
    }

    public async ValueTask<AuthoringExtensionApprovalPreviewResponse> ConfirmDeletionAsync(
        AuthoringExtensionApprovalConfirmationRequest request, VerifiedAuthoringPackage package,
        AuthoringStateMeasurement measurement, AuthoringLifecycleReceipt expectedLifecycleReceipt,
        CancellationToken cancellationToken = default)
    {
        Validate(request);
        return Project(await authority.ConfirmDeletionAsync(request.DecisionId, package, measurement,
            expectedLifecycleReceipt, request.DisplayedDigest, request.StepUpProof, cancellationToken));
    }

    private static void Validate(AuthoringExtensionApprovalDecisionRequest request)
        => PodBinaryCodec.WriteAuthoringExtensionApprovalDecisionRequest(request, new ArrayBufferWriter<byte>());

    private static void Validate(AuthoringExtensionApprovalConfirmationRequest request)
        => PodBinaryCodec.WriteAuthoringExtensionApprovalConfirmationRequest(request, new ArrayBufferWriter<byte>());

    private static AuthoringExtensionApprovalPreviewResponse Project(AuthoringExtensionApprovalPreview preview)
    {
        AuthoringFencedStateMigration? plan = preview.FrozenPlan;
        AuthoringStateMeasurement? measurement = preview.Measurement;
        AuthoringExtensionOperationContext context = preview.OperationContext;
        AuthoringLifecycleReceipt receipt = preview.ExpectedLifecycleReceipt;
        var result = new AuthoringExtensionApprovalPreviewResponse(preview.ContractVersion,
            new(context.ContractVersion, context.ActorBindingSha256, context.AuthorizationPolicy, context.SiteId,
                context.StateUserId, context.DocumentId, context.SourceScopeSha256, context.DestinationScopeSha256,
                context.LifecycleGeneration, context.LifecycleReceiptSha256, context.ScopeAuthorizationSha256),
            preview.DecisionId, (byte)preview.Operation, (byte)preview.Status, Scope(preview.Scope),
            preview.DestinationScope is null ? null : Scope(preview.DestinationScope), preview.Records, preview.Bytes,
            preview.Retention, preview.Digest, plan is null ? null : new(plan.ContractVersion, plan.PlanId,
                plan.ExpectedFromRevision, plan.ExpectedToRevision, plan.SourceContentSha256, plan.MaximumRecords,
                plan.MaximumBytes, plan.MaximumDuration.Ticks, plan.Transforms.Length, plan.BackupReference,
                plan.RollbackReference, plan.ContentSha256),
            measurement is null ? null : new(Scope(measurement.Scope), measurement.Revision, measurement.Records,
                measurement.Bytes, measurement.ContentSha256),
            new(receipt.SchemaVersion, receipt.Sequence, receipt.ExtensionId, receipt.PackageSha256, receipt.Version,
                receipt.StateSchemaVersion, receipt.DataSchemaVersion, (byte)receipt.PreviousState, (byte)receipt.State,
                receipt.Generation, receipt.ScopeDigest, receipt.FailureCode, receipt.PreviousReceiptSha256, receipt.ReceiptSha256),
            preview.ExpiresAt.UtcDateTime, Array.AsReadOnly(preview.OrderedOldTargets.Select(Target).ToArray()),
            Array.AsReadOnly(preview.OrderedNewTargets.Select(Target).ToArray()));
        // The one original generated writer owns bounds and shape; no internal JSON bytes cross this boundary.
        PodBinaryCodec.WriteAuthoringExtensionApprovalPreviewResponse(result, new ArrayBufferWriter<byte>());
        return result;
    }

    private static AuthoringApprovalScopeView Scope(AuthoringStateScope value)
        => new(value.ExtensionId, value.ExtensionVersion, value.SiteId, value.UserId, value.DocumentId, value.SchemaVersion);

    private static AuthoringApprovalExecutionTargetView Target(AuthoringExecutionTarget value)
        => new((byte)value.Status, (byte)value.ExecutionClass, value.ExtensionId, value.ExtensionVersion,
            value.PackageSha256, value.ContributionId, (byte)value.ContributionKind, value.EntrypointIdentity,
            value.TrustedAdapterId, value.RuntimeIdentity, value.BlockedReason, value.TrustedAdapterIdentity);
}
