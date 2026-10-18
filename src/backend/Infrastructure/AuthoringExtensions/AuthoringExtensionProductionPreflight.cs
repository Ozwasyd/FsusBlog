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
    AuthoringProductionRuntimeProviders providers) : IAuthoringLifecyclePreflight, IAuthoringLifecyclePermissionPreflight
{
    private readonly IAuthoringInstalledPackageReadScopeAuthority _installedPackages =
        new ActiveAuthoringInstalledPackageAuthority(packages.Store);

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
        if (receipt is not null)
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
        blockers.Add("production_approval_contract_unavailable");
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
        foreach (AuthoringContributionDeclaration declaration in manifest.Contributions)
        {
            AuthoringExecutionTarget expected = await packages.ExecutionResolver.ResolveAsync(
                package, declaration.Id, platform, cancellationToken: cancellationToken).ConfigureAwait(false);
            Require(expected.Status == AuthoringExecutionResolutionStatus.Ready
                && targets.SingleOrDefault(target => target.ContributionId == declaration.Id) == expected,
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
