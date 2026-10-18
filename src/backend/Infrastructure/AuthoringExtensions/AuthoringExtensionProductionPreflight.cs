using System.Collections.Immutable;
using System.Security.Cryptography;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

/// <summary>Read-only observations; these values confer no activation or runtime authority.</summary>
public sealed record AuthoringProductionPreflightObservation(
    string PackageIdentity,
    long StateRevision,
    string StateContentSha256,
    string? LifecycleReceiptSha256,
    ImmutableArray<string> Blockers);

/// <summary>
/// Reads the original package, resolver, fenced state, receipt and grant owners.
/// Enable inspects launch providers, not live incarnations. Starting and common
/// publication remain with the original coordinator. No boolean supplied
/// by a caller or diagnostic observation can substitute for those capabilities.
/// </summary>
public sealed class AuthoringExtensionProductionPreflight(
    LocalAuthoringPackageRuntime packages,
    IAuthoringCapabilityGrantCatalog grants,
    IAuthoringFencedExtensionStateStore stateStore,
    IAuthoringLifecycleReceiptStore receipts,
    TimeProvider timeProvider,
    AuthoringHostPlatform platform,
    AuthoringStateScope scope,
    string purpose,
    AuthoringProductionRuntimeProviders providers,
    AuthoringExtensionApprovalAuthority? approvalAuthority = null,
    AuthoringExtensionApprovalAuthority.ApprovedClaim? approvedClaim = null)
    : IAuthoringLifecyclePreflight, IAuthoringLifecyclePermissionPreflight
{
    private readonly IAuthoringInstalledPackageReadScopeAuthority _installedPackages =
        new ActiveAuthoringInstalledPackageAuthority(packages.Store);

    /// <summary>The sole issuer's context; an independently supplied context is never accepted.</summary>
    public AuthoringExtensionOperationContext? OperationContext => approvedClaim?.OperationContext;

    public async ValueTask<bool> VerifyAsync(
        VerifiedAuthoringPackage package,
        ImmutableArray<AuthoringExecutionTarget> targets,
        CancellationToken cancellationToken)
    {
        _ = await InspectAsync(package, targets, cancellationToken).ConfigureAwait(false);
        // Inspection is not an issuer. Existing grants do not authenticate the
        // actor/site/document operation context required by the approval owner.
        return false;
    }

    public async ValueTask<bool> HasRequiredPermissionsAsync(
        VerifiedAuthoringPackage package,
        ImmutableArray<AuthoringExecutionTarget> targets,
        CancellationToken cancellationToken)
    {
        using var operation = BoundOperation(cancellationToken);
        cancellationToken = operation.Token;
        using IAuthoringInstalledPackageReadScope held = await AcquirePackageScopeAsync(
            package, targets, cancellationToken).ConfigureAwait(false);
        return await HasGrantsAsync(held.ActivePackage, targets, cancellationToken).ConfigureAwait(false);
    }

    public async ValueTask<AuthoringProductionPreflightObservation> InspectAsync(
        VerifiedAuthoringPackage package,
        ImmutableArray<AuthoringExecutionTarget> targets,
        CancellationToken cancellationToken = default)
    {
        using var operation = BoundOperation(cancellationToken);
        cancellationToken = operation.Token;
        using IAuthoringInstalledPackageReadScope held = await AcquirePackageScopeAsync(
            package, targets, cancellationToken).ConfigureAwait(false);
        VerifiedAuthoringPackage active = held.ActivePackage;
        AuthoringExtensionStateContract.ValidateOwner(active, scope);
        AuthoringStateSnapshot state = await stateStore.ReadAsync(active, scope, cancellationToken).ConfigureAwait(false);
        Require(state.Scope == scope && state.PackageIdentity == active.PackageIdentity,
            "production_state_owner_drift");
        AuthoringStateSnapshot canonical = AuthoringExtensionStateContract.Snapshot(
            scope, active.PackageIdentity, state.Revision, state.Entries);
        Require(state.ContractVersion == canonical.ContractVersion && state.ContentSha256 == canonical.ContentSha256,
            "production_state_content_drift");
        AuthoringStateMeasurement measured = await stateStore.MeasureAsync(active, scope, cancellationToken).ConfigureAwait(false);
        Require(measured.Scope == scope && measured.Revision == state.Revision
            && measured.Records >= state.Entries.Length && measured.Bytes >= 0
            && measured.Bytes <= active.Contract.Manifest.Limits.MaximumStateBytes,
            "production_state_budget_or_revision_drift");
        AuthoringLifecycleReceipt? receipt = await receipts.GetLatestAsync(
            active.Contract.Manifest.Id, cancellationToken).ConfigureAwait(false);
        if (approvedClaim is not null)
        {
            // Before effects/Starting, the exact original head is still required.
            // Its ScopeDigest belongs to the issuer, not a consumer-side codec.
            Require(receipt == approvedClaim.ExpectedLifecycleReceipt, "production_approval_lifecycle_head_drift");
        }
        else if (receipt is not null)
        {
            Require(receipt.SchemaVersion == 1 && receipt.Generation > 0 && receipt.Sequence == receipt.Generation
                && receipt.ExtensionId == active.Contract.Manifest.Id
                && receipt.PackageSha256 == active.Contract.Manifest.PackageSha256
                && receipt.Version == active.Contract.Manifest.Version
                && receipt.StateSchemaVersion == active.Contract.Manifest.StateSchemaVersion
                && receipt.DataSchemaVersion == active.Contract.Manifest.DataSchemaVersion
                && receipt.ScopeDigest == active.PackageIdentity
                && receipt.ReceiptSha256 == AuthoringExtensionLifecycleCoordinator.ComputeReceiptSha256(receipt)
                && receipt.State is AuthoringLifecycleState.Installed or AuthoringLifecycleState.Disabled
                    or AuthoringLifecycleState.PermissionPending or AuthoringLifecycleState.Enabled
                    or AuthoringLifecycleState.Starting or AuthoringLifecycleState.Running,
                "production_lifecycle_receipt_drift");
        }
        var blockers = ImmutableArray.CreateBuilder<string>();
        if (!await HasGrantsAsync(active, targets, cancellationToken).ConfigureAwait(false))
        {
            blockers.Add("production_required_grant_missing");
        }
        if (receipt is null)
        {
            blockers.Add("production_lifecycle_receipt_missing");
        }
        if (approvedClaim is null)
        {
            blockers.Add("production_approval_claim_missing");
        }
        else
        {
            // This claim approves a state operation. Its original contract does
            // not bind a runtime grant purpose, enable consent or publication.
            blockers.Add("production_grant_operation_binding_unavailable");
            blockers.Add("production_approval_qualification_pending");
        }
        blockers.Add("production_starting_publication_ports_unavailable");
        blockers.Add("production_launch_capability_admission_unavailable");
        foreach (AuthoringExecutionTarget target in targets)
        {
            if (target.ExecutionClass == AuthoringExecutionClass.IsolatedWorkerWasm && providers.Worker is null)
            {
                blockers.Add("production_worker_launch_provider_missing");
            }
            if (target.ExecutionClass == AuthoringExecutionClass.OutOfProcessService && providers.Service is null)
            {
                blockers.Add("production_service_launch_provider_missing");
            }
        }
        cancellationToken.ThrowIfCancellationRequested();
        return new(active.PackageIdentity, state.Revision, state.ContentSha256,
            receipt?.ReceiptSha256, blockers.ToImmutable());
    }

    internal async ValueTask<IAuthoringInstalledPackageReadScope> AcquirePackageScopeAsync(
        VerifiedAuthoringPackage package,
        ImmutableArray<AuthoringExecutionTarget> targets,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(package);
        using var acquisition = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        acquisition.CancelAfter(TimeSpan.FromSeconds(5));
        cancellationToken = acquisition.Token;
        cancellationToken.ThrowIfCancellationRequested();
        await VerifyApprovedOperationAsync(package, cancellationToken).ConfigureAwait(false);
        if (approvedClaim?.Operation == AuthoringApprovalOperation.Migration)
        {
            Require(targets.SequenceEqual(approvedClaim.OrderedNewTargets), "production_approval_ordered_target_drift");
        }
        Require(OperatingSystem.IsLinux() && platform == AuthoringHostPlatform.ServerLinux,
            "production_platform_unsupported");
        AuthoringExtensionManifest manifest = package.Contract.Manifest;
        VerifiedAuthoringExtensionContract contract = AuthoringExtensionContractValidator.Verify(manifest, platform);
        Require(contract.ContractIdentity == package.Contract.ContractIdentity
            && contract.RegistryIdentity == package.Contract.RegistryIdentity,
            "production_manifest_identity_drift");
        Require(!targets.IsDefaultOrEmpty && targets.Length == manifest.Contributions.Length
            && targets.Select(static target => target.ContributionId).Distinct(StringComparer.Ordinal).Count() == targets.Length,
            "production_target_set_incomplete");
        AuthoringExtensionStateContract.ValidateScope(scope);
        Require(scope.ExtensionId == manifest.Id && scope.ExtensionVersion == manifest.Version
            && scope.SchemaVersion == manifest.StateSchemaVersion && scope.DocumentId is not null
            && !string.IsNullOrWhiteSpace(purpose) && purpose.Length <= 256
            && purpose == purpose.Trim() && !purpose.Any(char.IsControl)
            && !purpose.Equals("all", StringComparison.OrdinalIgnoreCase), "production_host_scope_invalid");

        // The resolver reenters the store. Resolve before taking the original
        // store's exclusion lifetime; reacquiring it while held would deadlock.
        for (int index = 0; index < manifest.Contributions.Length; index++)
        {
            AuthoringContributionDeclaration declaration = manifest.Contributions[index];
            AuthoringExecutionTarget expected = await packages.ExecutionResolver.ResolveAsync(
                package, declaration.Id, platform, cancellationToken: cancellationToken).ConfigureAwait(false);
            Require(expected.Status == AuthoringExecutionResolutionStatus.Ready
                && targets[index] == expected,
                "production_target_exact_mapping_required");
            Require(declaration.ExecutionClass is AuthoringExecutionClass.IsolatedWorkerWasm
                or AuthoringExecutionClass.OutOfProcessService, "production_runtime_readiness_unsupported");
        }

        IAuthoringInstalledPackageReadScope held = await _installedPackages.AcquireActiveReadScopeAsync(
            package, cancellationToken).ConfigureAwait(false);
        try
        {
            ActiveAuthoringInstalledPackageAuthority.RequireExactActivePackage(held.ActivePackage, package);
            Require(held is IAuthoringInstalledPackageAsyncReadScope, "production_async_package_scope_required");
            VerifiedAuthoringPackage active = held.ActivePackage;
            DateTimeOffset now = timeProvider.GetUtcNow();
            Require(active.Trust.Status == AuthoringPackageTrustStatus.Trusted
                && package.Trust.Status == AuthoringPackageTrustStatus.Trusted
                && active.Trust.EvaluatedAt <= now && active.Trust.ValidUntil > now
                && active.Contract.ContractIdentity == contract.ContractIdentity
                && AuthoringPackageVerifier.ComputePackageDigest(package.Contents.Entries) == manifest.PackageSha256
                && AuthoringPackageVerifier.ComputeContentDigest(package.Contents.Entries) == manifest.ContentSha256
                && package.Artifact.CanonicalArchive.AsSpan().SequenceEqual(active.Artifact.CanonicalArchive.AsSpan())
                && package.Artifact.Signature.AsSpan().SequenceEqual(active.Artifact.Signature.AsSpan())
                && Convert.ToHexStringLower(SHA256.HashData(package.Artifact.CanonicalArchive.AsSpan()))
                    == active.Artifact.ArchiveSha256, "production_package_or_trust_drift");
            cancellationToken.ThrowIfCancellationRequested();
            return held;
        }
        catch (Exception failure)
        {
            AuthoringTerminalReadScopes.Release(failure, held);
            throw;
        }
    }

    private async ValueTask VerifyApprovedOperationAsync(
        VerifiedAuthoringPackage package, CancellationToken cancellationToken)
    {
        if (approvedClaim is null)
        {
            Require(approvalAuthority is null, "production_approval_claim_missing");
            return;
        }
        Require(approvalAuthority is not null, "production_approval_read_owner_missing");
        Require(approvedClaim.ExpiresAt > timeProvider.GetUtcNow(), "production_approval_claim_expired");
        Require(approvedClaim.ResultPackageIdentity == package.PackageIdentity,
            "production_approval_result_package_drift");
        if (approvedClaim.FrozenPlan is { } plan)
        {
            Require(plan.MaximumBytes <= package.Contract.Manifest.Limits.MaximumStateBytes
                && plan.MaximumDuration <= package.Contract.Manifest.Limits.WallClock,
                "production_approval_plan_budget_exceeded");
        }
        AuthoringStateScope boundScope = ScopeFor(approvedClaim);
        Require(boundScope == scope, "production_approval_scope_drift");
        // ReadAsync is the original concrete issuer's authenticated SQL read:
        // real actor/session/permissions/xmin and the protected journal are checked.
        // It is a point-in-time observation, not a held publication capability.
        AuthoringExtensionApprovalPreview current = await approvalAuthority!.ReadAsync(
            approvedClaim.DecisionId, cancellationToken).ConfigureAwait(false);
        Require(current.Status == AuthoringApprovalStatus.Claimed
            && current.DecisionId == approvedClaim.DecisionId && current.Digest == approvedClaim.Digest
            && current.Operation == approvedClaim.Operation && current.Scope == approvedClaim.Scope
            && current.ExpiresAt == approvedClaim.ExpiresAt
            && current.OperationContext == approvedClaim.OperationContext
            && current.ExpectedLifecycleReceipt == approvedClaim.ExpectedLifecycleReceipt
            && current.OrderedOldTargets.SequenceEqual(approvedClaim.OrderedOldTargets)
            && current.OrderedNewTargets.SequenceEqual(approvedClaim.OrderedNewTargets),
            "production_approval_claim_not_current");
    }

    internal static AuthoringStateScope ScopeFor(AuthoringExtensionApprovalAuthority.ApprovedClaim claim)
    {
        ArgumentNullException.ThrowIfNull(claim);
        return claim.Operation switch
        {
            AuthoringApprovalOperation.Migration when claim.FrozenPlan is not null => claim.FrozenPlan.To,
            AuthoringApprovalOperation.Deletion when claim.FencedDeletion is not null => claim.Scope,
            _ => throw new AuthoringExtensionContractException("production_approval_operation_unsupported")
        };
    }

    internal AuthoringStateSnapshot FreezeAppliedSnapshot(AuthoringStateSnapshot snapshot)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        AuthoringStateSnapshot canonical = AuthoringExtensionStateContract.Snapshot(
            snapshot.Scope, snapshot.PackageIdentity, snapshot.Revision, snapshot.Entries);
        Require(snapshot.ContractVersion == canonical.ContractVersion && snapshot.ContentSha256 == canonical.ContentSha256,
            "production_applied_snapshot_tampered");
        return canonical;
    }

    internal async ValueTask<IAuthoringInstalledPackageReadScope> AcquirePreparationScopeAsync(
        VerifiedAuthoringPackage package,
        ImmutableArray<AuthoringExecutionTarget> targets,
        AuthoringStateSnapshot applied,
        long generation,
        CancellationToken cancellationToken)
    {
        Require(approvedClaim is not null && approvedClaim.Operation == AuthoringApprovalOperation.Migration
            && approvedClaim.FrozenPlan is not null, "production_migration_claim_required");
        IAuthoringInstalledPackageReadScope held = await AcquirePackageScopeAsync(package, targets, cancellationToken).ConfigureAwait(false);
        try
        {
            AuthoringFencedStateMigration plan = approvedClaim!.FrozenPlan!;
            Require(applied.Scope == plan.To && applied.Scope == scope && applied.PackageIdentity == package.PackageIdentity
                && plan.ExpectedToRevision <= long.MaxValue - 2 && applied.Revision == plan.ExpectedToRevision + 2
                && AuthoringExtensionStateContract.ValueBytes(applied) <= package.Contract.Manifest.Limits.MaximumStateBytes,
                "production_applied_snapshot_binding_drift");
            AuthoringLifecycleReceipt? starting = await receipts.GetLatestAsync(package.Contract.Manifest.Id, cancellationToken).ConfigureAwait(false);
            Require(starting is not null && starting.State == AuthoringLifecycleState.Starting
                && starting.SchemaVersion == 1 && starting.Sequence == starting.Generation && starting.FailureCode is null
                && starting.PackageSha256 == package.Contract.Manifest.PackageSha256
                && starting.Version == package.Contract.Manifest.Version
                && starting.StateSchemaVersion == package.Contract.Manifest.StateSchemaVersion
                && starting.DataSchemaVersion == package.Contract.Manifest.DataSchemaVersion
                && starting.ScopeDigest == approvedClaim.Digest
                && starting.ReceiptSha256 == AuthoringExtensionLifecycleCoordinator.ComputeReceiptSha256(starting)
                && starting.Generation > approvedClaim.ExpectedLifecycleReceipt.Generation
                && starting.Generation < long.MaxValue && generation == starting.Generation + 1,
                "production_starting_generation_not_current");
            Require(await HasGrantsAsync(held.ActivePackage, targets, cancellationToken).ConfigureAwait(false),
                "production_required_grant_missing");
            return held;
        }
        catch (Exception failure)
        {
            AuthoringTerminalReadScopes.Release(failure, held);
            throw;
        }
    }

    internal void RequireQualifiedEffects()
    {
        // The successor issuer requires original scope and execution-result
        // custody. Those real dependencies and independent qualification remain
        // absent here. No caller flag or test adapter can enable native effects.
        throw new AuthoringExtensionContractException("production_approval_qualification_pending");
    }

    internal async ValueTask<IAuthoringExtensionStateObservation> AcquireAppliedStateObservationAsync(
        VerifiedAuthoringPackage oldPackage, VerifiedAuthoringPackage newPackage,
        AuthoringFencedStateMigration plan, AuthoringStateSnapshot actualApplied,
        CancellationToken cancellationToken)
    {
        Require(stateStore is IAuthoringExtensionStateObservationStore, "production_state_observation_owner_missing");
        AuthoringExtensionStateContract.ValidatePlan(oldPackage, newPackage, plan);
        AuthoringStateSnapshot applied = FreezeAppliedSnapshot(actualApplied);
        IAuthoringExtensionStateObservation held = await ((IAuthoringExtensionStateObservationStore)stateStore)
            .ObserveFencedAsync(oldPackage, newPackage, plan, AuthoringStateMigrationPhase.Applied, cancellationToken).ConfigureAwait(false);
        try
        {
            // This verifies on the original held connection. Never replace it
            // with ordinary Read/Measure or a second observation acquisition.
            await held.VerifyCurrentAsync(cancellationToken).ConfigureAwait(false);
            AuthoringStateObservation observed = held.State;
            ImmutableArray<string> expectedScopes = [.. new[] { plan.From, plan.To }
                .Select(AuthoringExtensionStateContract.ScopeId).Order(StringComparer.Ordinal)];
            Require(held.AcquiredScopeIds.SequenceEqual(expectedScopes)
                && observed.Phase == AuthoringStateMigrationPhase.Applied
                && observed.From.Fence == plan.ContentSha256 && observed.To?.Fence == plan.ContentSha256
                && observed.From.Snapshot.Scope == plan.From
                && observed.From.Snapshot.PackageIdentity == oldPackage.PackageIdentity
                && observed.From.Snapshot.Revision == checked(plan.ExpectedFromRevision + 1)
                && observed.To is not null
                && applied.Scope == plan.To && applied.PackageIdentity == newPackage.PackageIdentity
                && applied.Revision == checked(plan.ExpectedToRevision + 2)
                && AuthoringExtensionStateContract.Encode(observed.To.Snapshot).AsSpan()
                    .SequenceEqual(AuthoringExtensionStateContract.Encode(applied)),
                "production_applied_state_observation_drift");
            return held;
        }
        catch
        {
            await held.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    internal AuthoringExtensionApprovalExecutionResult FreezeExecutionResult(AuthoringStateSnapshot applied,
        ImmutableArray<AuthoringExecutionTarget> targets, long runningGeneration)
    {
        Require(approvedClaim?.Operation == AuthoringApprovalOperation.Migration,
            "production_migration_claim_required");
        // The original codec describes actual data, not runtime acceptance or a
        // held execution-result authority. Never use this record as that proof.
        return AuthoringExtensionApprovalContract.MigrationResult(approvedClaim!, applied,
            approvedClaim!.OrderedOldTargets, targets, runningGeneration);
    }

    internal async ValueTask<IAuthoringExtensionStateObservation> AcquireSettledStateObservationAsync(
        VerifiedAuthoringPackage oldPackage, VerifiedAuthoringPackage newPackage,
        AuthoringFencedStateMigration originalPlan, AuthoringStateMigrationPhase terminalPhase,
        CancellationToken cancellationToken)
    {
        Require(stateStore is IAuthoringExtensionStateObservationStore, "production_state_observation_owner_missing");
        // Only the original read-only recovery port validates the actual
        // settlement journal. Never repeat Complete/Apply or backfill a digest.
        IAuthoringExtensionStateObservation held = await ((IAuthoringExtensionStateObservationStore)stateStore)
            .ObserveSettledMigrationAsync(oldPackage, newPackage, originalPlan, terminalPhase, cancellationToken).ConfigureAwait(false);
        try
        {
            await held.VerifyCurrentAsync(cancellationToken).ConfigureAwait(false);
            AuthoringStateObservation observed = held.State;
            ImmutableArray<string> exactScopes = [.. new[] { originalPlan.From, originalPlan.To }
                .Select(AuthoringExtensionStateContract.ScopeId).Order(StringComparer.Ordinal)];
            Require(held.AcquiredScopeIds.SequenceEqual(exactScopes) && observed.Phase == terminalPhase
                && observed.From.Fence is null && observed.To?.Fence is null && observed.To is not null
                && observed.From.Snapshot.Scope == originalPlan.From && observed.To.Snapshot.Scope == originalPlan.To
                && observed.From.Snapshot.PackageIdentity == oldPackage.PackageIdentity
                && observed.To.Snapshot.PackageIdentity == newPackage.PackageIdentity,
                "production_settled_state_observation_drift");
            return held;
        }
        catch
        {
            await held.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    internal ValueTask<AuthoringLifecycleReceipt?> ReadLatestReceiptAsync(string extensionId, CancellationToken cancellationToken)
        => receipts.GetLatestAsync(extensionId, cancellationToken);

    internal ValueTask VerifyClaimCurrentAsync(VerifiedAuthoringPackage package, CancellationToken cancellationToken)
        => VerifyApprovedOperationAsync(package, cancellationToken);

    internal async ValueTask VerifyCurrentGrantsAsync(VerifiedAuthoringPackage package,
        ImmutableArray<AuthoringExecutionTarget> targets, CancellationToken cancellationToken)
        => Require(await HasGrantsAsync(package, targets, cancellationToken).ConfigureAwait(false),
            "production_required_grant_missing");

    internal bool IsPackageTrustCurrent(VerifiedAuthoringPackage package)
        => package.Trust.Status == AuthoringPackageTrustStatus.Trusted && package.Trust.ValidUntil > timeProvider.GetUtcNow();

    internal string RequireClaimDigest()
        => approvedClaim?.Digest ?? throw new AuthoringExtensionContractException("production_migration_claim_required");

    internal string RequireOperationSha256()
        => approvedClaim?.OperationSha256 ?? throw new AuthoringExtensionContractException("production_migration_claim_required");

    internal async ValueTask<ImmutableArray<string>> FindBoundGrantIdsAsync(
        VerifiedAuthoringPackage package, AuthoringExecutionTarget target, CancellationToken cancellationToken)
    {
        ImmutableArray<AuthoringCapabilityGrant> found = await grants.FindActiveExactAsync(target.ExtensionId,
            target.ExtensionVersion, target.ContributionId, target.RuntimeIdentity, target.ExecutionClass,
            scope.DocumentId!, cancellationToken).ConfigureAwait(false);
        Require(!found.IsDefault, "production_grant_catalog_unavailable");
        AuthoringContributionDeclaration declaration = package.Contract.Manifest.Contributions.Single(item => item.Id == target.ContributionId);
        DateTimeOffset now = timeProvider.GetUtcNow();
        return [.. found.Where(grant => declaration.Capabilities.Contains(grant.Capability)
                && grant.ExtensionId == target.ExtensionId && grant.ExtensionVersion == target.ExtensionVersion
                && grant.ContributionId == target.ContributionId && grant.RuntimeIdentity == target.RuntimeIdentity
                && grant.ExecutionClass == target.ExecutionClass && grant.DocumentId == scope.DocumentId
                && grant.SiteIdentity == scope.SiteId && grant.Purpose == purpose && grant.IssuedAt <= now
                && grant.ExpiresAt > now && !string.IsNullOrWhiteSpace(grant.ApprovalReceiptId)
                && grant.GrantId == grant.GrantDigest
                && grant.GrantDigest == AuthoringCapabilityGrantAuthority.ComputeGrantDigest(grant))
            .Select(static grant => grant.GrantId).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal)];
    }

    private async ValueTask<bool> HasGrantsAsync(
        VerifiedAuthoringPackage package,
        ImmutableArray<AuthoringExecutionTarget> targets,
        CancellationToken cancellationToken)
    {
        foreach (AuthoringExecutionTarget target in targets)
        {
            AuthoringContributionDeclaration declaration = package.Contract.Manifest.Contributions.Single(
                candidate => candidate.Id == target.ContributionId);
            ImmutableArray<AuthoringCapabilityGrant> found = await grants.FindActiveExactAsync(
                target.ExtensionId, target.ExtensionVersion, target.ContributionId, target.RuntimeIdentity,
                target.ExecutionClass, scope.DocumentId!, cancellationToken).ConfigureAwait(false);
            if (found.IsDefault)
            {
                return false;
            }
            DateTimeOffset now = timeProvider.GetUtcNow();
            foreach (AuthoringCapability capability in declaration.Capabilities)
            {
                if (!found.Any(grant => grant.ExtensionId == target.ExtensionId
                    && grant.ExtensionVersion == target.ExtensionVersion && grant.ContributionId == target.ContributionId
                    && grant.RuntimeIdentity == target.RuntimeIdentity && grant.ExecutionClass == target.ExecutionClass
                    && grant.DocumentId == scope.DocumentId && grant.SiteIdentity == scope.SiteId
                    && grant.Purpose == purpose && grant.Capability == capability
                    && grant.IssuedAt <= now && grant.ExpiresAt > now
                    && !string.IsNullOrWhiteSpace(grant.ApprovalReceiptId)
                    && grant.GrantId == grant.GrantDigest
                    && grant.GrantDigest == AuthoringCapabilityGrantAuthority.ComputeGrantDigest(grant)))
                {
                    return false;
                }
            }
        }
        return true;
    }

    internal static void Require(bool condition, string reason)
    {
        if (!condition)
        {
            throw new AuthoringExtensionContractException(reason);
        }
    }

    internal static CancellationTokenSource BoundOperation(CancellationToken cancellationToken)
    {
        var operation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        operation.CancelAfter(TimeSpan.FromSeconds(5));
        return operation;
    }
}
