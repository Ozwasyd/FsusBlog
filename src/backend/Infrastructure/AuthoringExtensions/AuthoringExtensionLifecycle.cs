using System.Collections.Immutable;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

public enum AuthoringLifecycleState
{
    Installed = 0,
    Enabled = 1,
    Disabled = 2,
    Updating = 3,
    MigrationRequired = 4,
    Migrating = 5,
    RollbackRequired = 6,
    Failed = 7,
    Uninstalling = 8,
    Removed = 9,
    RetainedData = 10,
    PermissionPending = 11,
    Starting = 12,
    Running = 13,
    Degraded = 14,
    Crashed = 15
}

public enum AuthoringStateTransformKind
{
    RenameKey = 0,
    DeleteExtensionKey = 1,
    SetDefault = 2
}

public sealed record AuthoringStateScope(
    string ExtensionId,
    string ExtensionVersion,
    string SiteId,
    string UserId,
    string? DocumentId,
    int SchemaVersion);

public sealed record AuthoringStateTransform(
    AuthoringStateTransformKind Kind,
    string SourceKey,
    string? DestinationKey,
    ImmutableArray<byte> DefaultValue);

public sealed record AuthoringStateMigrationPlan(
    string PlanId,
    AuthoringStateScope From,
    AuthoringStateScope To,
    long MaximumRecords,
    long MaximumBytes,
    TimeSpan MaximumDuration,
    ImmutableArray<AuthoringStateTransform> Transforms,
    string BackupReference,
    string RollbackReference,
    string ContentSha256);

public sealed record AuthoringLifecycleResourceReport(
    int Contributions,
    int WorkerInstances,
    int ServiceProcesses,
    int RpcRequests,
    int Grants,
    int ScheduledJobs,
    int HostSurfaces)
{
    public bool IsEmpty => this == new AuthoringLifecycleResourceReport(0, 0, 0, 0, 0, 0, 0);
}

public sealed record AuthoringLifecycleReceipt(
    int SchemaVersion,
    long Sequence,
    string ExtensionId,
    string PackageSha256,
    string Version,
    int StateSchemaVersion,
    int DataSchemaVersion,
    AuthoringLifecycleState PreviousState,
    AuthoringLifecycleState State,
    long Generation,
    string ScopeDigest,
    string? FailureCode,
    string PreviousReceiptSha256,
    string ReceiptSha256);

public sealed record AuthoringDeleteDataApproval(
    string ExtensionId,
    string PackageSha256,
    AuthoringStateScope Scope,
    long ExpectedRecords,
    long ExpectedBytes,
    string ApprovalReceiptId);

public interface IAuthoringLifecycleResourceAuthority
{
    ValueTask ActivateAtomicallyAsync(
        VerifiedAuthoringPackage package,
        ImmutableArray<AuthoringExecutionTarget> targets,
        long generation,
        CancellationToken cancellationToken);

    ValueTask<AuthoringLifecycleResourceReport> RevokeAllAsync(
        string extensionId,
        long generation,
        CancellationToken cancellationToken);

    ValueTask<bool> RebindGenerationAsync(
        string extensionId,
        long expectedGeneration,
        long replacementGeneration,
        CancellationToken cancellationToken);
}

public interface IAuthoringLifecyclePreflight
{
    ValueTask<bool> VerifyAsync(
        VerifiedAuthoringPackage package,
        ImmutableArray<AuthoringExecutionTarget> targets,
        CancellationToken cancellationToken);
}

public interface IAuthoringLifecyclePermissionPreflight
{
    ValueTask<bool> HasRequiredPermissionsAsync(
        VerifiedAuthoringPackage package,
        ImmutableArray<AuthoringExecutionTarget> targets,
        CancellationToken cancellationToken);
}

public interface IAuthoringCapabilityGrantCatalog
{
    ValueTask<ImmutableArray<AuthoringCapabilityGrant>> FindActiveAsync(
        string extensionId,
        string contributionId,
        string runtimeIdentity,
        CancellationToken cancellationToken);

    ValueTask<ImmutableArray<AuthoringCapabilityGrant>> FindActiveExactAsync(
        string extensionId,
        string extensionVersion,
        string contributionId,
        string runtimeIdentity,
        AuthoringExecutionClass executionClass,
        string documentId,
        CancellationToken cancellationToken);

    ValueTask<int> RevokeExtensionAsync(
        string extensionId,
        CancellationToken cancellationToken);

    ValueTask<int> RevokeRuntimesAsync(
        string extensionId,
        ImmutableHashSet<string> runtimeIdentities,
        CancellationToken cancellationToken);
}

public interface IAuthoringExtensionStateStore
{
    ValueTask BackupAsync(AuthoringStateMigrationPlan plan, CancellationToken cancellationToken);

    ValueTask ApplyAsync(AuthoringStateMigrationPlan plan, CancellationToken cancellationToken);

    ValueTask RollbackAsync(AuthoringStateMigrationPlan plan, CancellationToken cancellationToken);

    ValueTask<(long Records, long Bytes)> MeasureAsync(AuthoringStateScope scope, CancellationToken cancellationToken);

    ValueTask DeleteAsync(AuthoringStateScope scope, CancellationToken cancellationToken);
}

public interface IAuthoringLifecycleReceiptStore
{
    ValueTask<AuthoringLifecycleReceipt?> GetLatestAsync(string extensionId, CancellationToken cancellationToken);

    ValueTask AppendAsync(AuthoringLifecycleReceipt receipt, CancellationToken cancellationToken);
}

/// <summary>
/// Original host admission, not a wire approval issuer. Acquisition must authenticate the
/// actual user decision and current actor against the exact arguments and serialize competing
/// lifecycle commands until disposal. No production producer is supplied by this contract.
/// </summary>
public interface IAuthoringFencedLifecyclePreflight : IAuthoringLifecyclePreflight, IAuthoringLifecyclePermissionPreflight
{
    ValueTask<IAuthoringFencedLifecycleAdmissionScope> AcquireMigrationAsync(
        VerifiedAuthoringPackage oldPackage,
        VerifiedAuthoringPackage newPackage,
        ImmutableArray<AuthoringExecutionTarget> targets,
        AuthoringFencedStateMigration plan,
        AuthoringLifecycleReceipt previous,
        CancellationToken cancellationToken);

    ValueTask<IAuthoringFencedLifecycleAdmissionScope> AcquireDeletionAsync(
        VerifiedAuthoringPackage package,
        AuthoringFencedStateDeletion approval,
        AuthoringLifecycleReceipt previous,
        CancellationToken cancellationToken);
}

/// <summary>
/// A host-owned, non-thread-affine lifetime. Current actor/decision/package/runtime facts
/// must be revalidated by the original owners; an ID or boolean supplied by a caller is not
/// this scope. Dispose only releases exclusion and must not throw. Missing owners refuse.
/// </summary>
public interface IAuthoringFencedLifecycleAdmissionScope : IDisposable
{
    ValueTask VerifyCurrentAsync(CancellationToken cancellationToken);
}

/// <summary>
/// Host startup consumes the exact applied, still-fenced snapshot. This port has no default
/// adapter: the legacy resource authority cannot silently discard state or select latest.
/// </summary>
public interface IAuthoringFencedLifecycleResourceAuthority : IAuthoringLifecycleResourceAuthority
{
    ValueTask ActivateAtomicallyAsync(
        VerifiedAuthoringPackage package,
        ImmutableArray<AuthoringExecutionTarget> targets,
        AuthoringStateSnapshot snapshot,
        long generation,
        CancellationToken cancellationToken);
}

public sealed class AuthoringExtensionLifecycleCoordinator(
    IAuthoringLifecycleResourceAuthority resources,
    IAuthoringLifecyclePreflight preflight,
    IAuthoringExtensionStateStore stateStore,
    IAuthoringLifecycleReceiptStore receiptStore,
    IAuthoringCapabilityGrantCatalog grants)
{
    public async ValueTask<AuthoringLifecycleReceipt> EnableAsync(
        VerifiedAuthoringPackage package,
        ImmutableArray<AuthoringExecutionTarget> targets,
        CancellationToken cancellationToken = default)
    {
        ValidateTargets(package, targets);
        AuthoringLifecycleReceipt? previous = await receiptStore.GetLatestAsync(package.Contract.Manifest.Id, cancellationToken);
        if (previous?.State is AuthoringLifecycleState.Uninstalling or AuthoringLifecycleState.Removed)
        {
            throw new AuthoringExtensionContractException("Removed extension cannot self-enable.");
        }

        if (preflight is IAuthoringLifecyclePermissionPreflight permissionPreflight &&
            !await permissionPreflight.HasRequiredPermissionsAsync(package, targets, cancellationToken))
        {
            return await RecordAsync(
                package,
                previous,
                AuthoringLifecycleState.PermissionPending,
                "required-permission-pending",
                cancellationToken);
        }

        if (!await preflight.VerifyAsync(package, targets, cancellationToken))
        {
            throw new AuthoringExtensionContractException("Lifecycle preflight rejected package, grants, schemas, budgets, or readiness.");
        }

        AuthoringLifecycleReceipt enabled = await RecordAsync(
            package,
            previous,
            AuthoringLifecycleState.Enabled,
            null,
            cancellationToken);
        AuthoringLifecycleReceipt starting = await RecordAsync(
            package,
            enabled,
            AuthoringLifecycleState.Starting,
            null,
            cancellationToken);
        long runningGeneration = starting.Generation + 1;
        bool resourcesActivated = false;
        try
        {
            await resources.ActivateAtomicallyAsync(
                package,
                targets,
                runningGeneration,
                cancellationToken);
            resourcesActivated = true;
            return await RecordAsync(package, starting, AuthoringLifecycleState.Running, null, cancellationToken);
        }
        catch
        {
            string failureCode = "activation-failed";
            if (resourcesActivated)
            {
                AuthoringLifecycleResourceReport remaining = await resources.RevokeAllAsync(
                    package.Contract.Manifest.Id,
                    runningGeneration,
                    CancellationToken.None);
                if (!remaining.IsEmpty)
                {
                    failureCode = "activation-cleanup-incomplete";
                }
            }

            await RecordAsync(
                package,
                starting,
                AuthoringLifecycleState.Crashed,
                failureCode,
                CancellationToken.None);
            throw;
        }
    }

    public async ValueTask<AuthoringLifecycleReceipt> DisableAsync(
        VerifiedAuthoringPackage package,
        CancellationToken cancellationToken = default)
    {
        AuthoringLifecycleReceipt? previous = await receiptStore.GetLatestAsync(package.Contract.Manifest.Id, cancellationToken);
        AuthoringLifecycleResourceReport remaining = await resources.RevokeAllAsync(
            package.Contract.Manifest.Id,
            previous?.Generation ?? 0,
            cancellationToken);
        if (!remaining.IsEmpty)
        {
            await RecordAsync(
                package,
                previous,
                AuthoringLifecycleState.Failed,
                "disable-resource-revocation-incomplete",
                CancellationToken.None);
            throw new AuthoringExtensionContractException("Disable left active extension authority or work.");
        }

        await grants.RevokeExtensionAsync(package.Contract.Manifest.Id, cancellationToken);
        return await RecordAsync(package, previous, AuthoringLifecycleState.Disabled, null, cancellationToken);
    }

    public async ValueTask<AuthoringLifecycleReceipt> UpdateAsync(
        VerifiedAuthoringPackage oldPackage,
        VerifiedAuthoringPackage newPackage,
        ImmutableArray<AuthoringExecutionTarget> newTargets,
        AuthoringStateMigrationPlan plan,
        CancellationToken cancellationToken = default)
    {
        if (stateStore is IAuthoringFencedExtensionStateStore)
        {
            throw new AuthoringExtensionContractException("fenced_lifecycle_requires_typed_migration");
        }
        ValidateMigration(oldPackage, newPackage, plan);
        ValidateTargets(newPackage, newTargets);
        AuthoringLifecycleReceipt? previous = await receiptStore.GetLatestAsync(oldPackage.Contract.Manifest.Id, cancellationToken);
        AuthoringLifecycleReceipt updating = await RecordAsync(
            oldPackage,
            previous,
            AuthoringLifecycleState.Updating,
            null,
            cancellationToken);
        AuthoringLifecycleReceipt cursor = updating;
        await stateStore.BackupAsync(plan, cancellationToken);
        bool oldResourcesRevoked = false;
        bool newResourcesActivated = false;
        long newRunningGeneration = 0;
        bool oldRuntimeWasAvailable = previous?.State is AuthoringLifecycleState.Running or
            AuthoringLifecycleState.Degraded;
        try
        {
            if (oldPackage.Contract.Manifest.StateSchemaVersion != newPackage.Contract.Manifest.StateSchemaVersion)
            {
                cursor = await RecordAsync(
                    newPackage,
                    cursor,
                    AuthoringLifecycleState.MigrationRequired,
                    null,
                    cancellationToken);
            }

            cursor = await RecordAsync(
                newPackage,
                cursor,
                AuthoringLifecycleState.Migrating,
                null,
                cancellationToken);
            await stateStore.ApplyAsync(plan, cancellationToken);
            if (!await preflight.VerifyAsync(newPackage, newTargets, cancellationToken))
            {
                throw new AuthoringExtensionContractException("Updated package failed lifecycle preflight.");
            }

            AuthoringLifecycleResourceReport remaining = await resources.RevokeAllAsync(
                oldPackage.Contract.Manifest.Id,
                previous?.Generation ?? 0,
                cancellationToken);
            if (!remaining.IsEmpty)
            {
                throw new AuthoringExtensionContractException("Update could not settle old extension work.");
            }
            oldResourcesRevoked = true;

            AuthoringLifecycleReceipt starting = await RecordAsync(
                newPackage,
                cursor,
                AuthoringLifecycleState.Starting,
                null,
                cancellationToken);
            cursor = starting;
            newRunningGeneration = starting.Generation + 1;
            await resources.ActivateAtomicallyAsync(
                newPackage,
                newTargets,
                newRunningGeneration,
                cancellationToken);
            newResourcesActivated = true;
            return await RecordAsync(
                newPackage,
                starting,
                AuthoringLifecycleState.Running,
                null,
                cancellationToken);
        }
        catch
        {
            bool newResourcesSettled = !newResourcesActivated;
            if (newResourcesActivated)
            {
                AuthoringLifecycleResourceReport newRemaining = await resources.RevokeAllAsync(
                    newPackage.Contract.Manifest.Id,
                    newRunningGeneration,
                    CancellationToken.None);
                newResourcesSettled = newRemaining.IsEmpty;
            }

            await stateStore.RollbackAsync(plan, CancellationToken.None);
            AuthoringLifecycleReceipt rollback = await RecordAsync(
                oldPackage,
                cursor,
                AuthoringLifecycleState.RollbackRequired,
                newResourcesSettled
                    ? "migration-or-activation-failed"
                    : "new-resource-cleanup-incomplete",
                CancellationToken.None);
            if (oldRuntimeWasAvailable && newResourcesSettled)
            {
                if (!oldResourcesRevoked)
                {
                    AuthoringLifecycleResourceReport oldRemaining = await resources.RevokeAllAsync(
                        oldPackage.Contract.Manifest.Id,
                        previous!.Generation,
                        CancellationToken.None);
                    oldResourcesRevoked = oldRemaining.IsEmpty;
                }

                if (oldResourcesRevoked)
                {
                    long restoredGeneration = rollback.Generation + 1;
                    await resources.ActivateAtomicallyAsync(
                        oldPackage,
                        [],
                        restoredGeneration,
                        CancellationToken.None);
                    try
                    {
                        await RecordAsync(
                            oldPackage,
                            rollback,
                            AuthoringLifecycleState.Running,
                            null,
                            CancellationToken.None);
                    }
                    catch
                    {
                        await resources.RevokeAllAsync(
                            oldPackage.Contract.Manifest.Id,
                            restoredGeneration,
                            CancellationToken.None);
                        throw;
                    }
                }
            }
            throw;
        }
    }

    /// <summary>
    /// Wires the existing fenced state/receipt owners under an explicit original host admission.
    /// No default approval, startup adapter, runtime restoration or cross-store transaction exists.
    /// A durable Running receipt precedes completion; uncertainty retains recovery authority.
    /// </summary>
    public async ValueTask<AuthoringLifecycleReceipt> UpdateAsync(
        VerifiedAuthoringPackage oldPackage,
        VerifiedAuthoringPackage newPackage,
        ImmutableArray<AuthoringExecutionTarget> newTargets,
        AuthoringFencedStateMigration plan,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (stateStore is not IAuthoringFencedExtensionStateStore fenced ||
            preflight is not IAuthoringFencedLifecyclePreflight admission ||
            resources is not IAuthoringFencedLifecycleResourceAuthority startup)
        {
            throw new AuthoringExtensionContractException("fenced_lifecycle_host_authority_unavailable");
        }
        plan = AuthoringExtensionStateContract.FreezePlan(oldPackage, newPackage, plan);
        ValidateTargets(newPackage, newTargets);
        ImmutableArray<AuthoringExecutionTarget> targets = [.. newTargets];
        AuthoringLifecycleReceipt previous = RequireFencedReceipt(oldPackage,
            await receiptStore.GetLatestAsync(oldPackage.Contract.Manifest.Id, cancellationToken));
        if (!IsTransitionAllowed(previous.State, AuthoringLifecycleState.Updating))
        {
            throw new AuthoringExtensionContractException("fenced_lifecycle_recovery_required");
        }
        using IAuthoringFencedLifecycleAdmissionScope scope = await admission.AcquireMigrationAsync(
            oldPackage, newPackage, targets, plan, previous, cancellationToken)
            ?? throw new AuthoringExtensionContractException("fenced_lifecycle_admission_missing");
        await scope.VerifyCurrentAsync(cancellationToken);
        await RequireCurrentReceiptAsync(previous, cancellationToken);

        AuthoringLifecycleReceipt cursor = previous;
        AuthoringLifecycleReceipt? pending = null;
        AuthoringLifecycleReceipt? runningAttempt = null;
        bool backupAttempted = false;
        bool activationAttempted = false;
        bool runningAccepted = false;
        long startupGeneration = 0;
        try
        {
            await RecordNextAsync(oldPackage, AuthoringLifecycleState.Updating);
            AuthoringLifecycleResourceReport remaining = await resources.RevokeAllAsync(
                oldPackage.Contract.Manifest.Id, previous.Generation, cancellationToken);
            if (!remaining.IsEmpty)
            {
                throw new AuthoringExtensionContractException("fenced_lifecycle_old_resources_unsettled");
            }
            await grants.RevokeExtensionAsync(oldPackage.Contract.Manifest.Id, cancellationToken);
            await scope.VerifyCurrentAsync(cancellationToken);
            backupAttempted = true;
            await fenced.BackupAsync(oldPackage, newPackage, plan, cancellationToken);
            if (plan.From.SchemaVersion != plan.To.SchemaVersion)
            {
                await RecordNextAsync(newPackage, AuthoringLifecycleState.MigrationRequired);
            }
            await RecordNextAsync(newPackage, AuthoringLifecycleState.Migrating);
            await scope.VerifyCurrentAsync(cancellationToken);
            AuthoringStateSnapshot applied = await fenced.ApplyAsync(oldPackage, newPackage, plan, cancellationToken);
            AuthoringStateSnapshot snapshot = AuthoringExtensionStateContract.DecodeSnapshot(
                AuthoringExtensionStateContract.Encode(applied));
            if (snapshot.Scope != plan.To || snapshot.PackageIdentity != newPackage.PackageIdentity ||
                snapshot.Revision != checked(plan.ExpectedToRevision + 2))
            {
                throw new AuthoringExtensionContractException("fenced_lifecycle_applied_snapshot_mismatch");
            }
            await scope.VerifyCurrentAsync(cancellationToken);
            if (!await admission.HasRequiredPermissionsAsync(newPackage, targets, cancellationToken) ||
                !await admission.VerifyAsync(newPackage, targets, cancellationToken))
            {
                throw new AuthoringExtensionContractException("fenced_lifecycle_startup_preflight_rejected");
            }
            await RecordNextAsync(newPackage, AuthoringLifecycleState.Starting);
            startupGeneration = checked(cursor.Generation + 1);
            activationAttempted = true;
            await startup.ActivateAtomicallyAsync(newPackage, targets, snapshot, startupGeneration, cancellationToken);
            await scope.VerifyCurrentAsync(cancellationToken);
            runningAttempt = CreateReceipt(newPackage, cursor, AuthoringLifecycleState.Running, null);
            pending = runningAttempt;
            cursor = await RecordAsync(runningAttempt, cancellationToken);
            runningAccepted = true;
            await RequireCurrentReceiptAsync(cursor, cancellationToken);
            await scope.VerifyCurrentAsync(cancellationToken);
            await fenced.CompleteAsync(oldPackage, newPackage, plan, cancellationToken);
            return cursor;
        }
        catch (Exception failure)
        {
            bool headKnown = false;
            try
            {
                AuthoringLifecycleReceipt? latest = await receiptStore.GetLatestAsync(
                    oldPackage.Contract.Manifest.Id, CancellationToken.None);
                if (latest is not null && (latest == pending || latest == cursor))
                {
                    cursor = latest;
                    headKnown = true;
                    runningAccepted |= latest == runningAttempt;
                }
            }
            catch
            {
                NoteFencedCleanup(failure, "AuthoringFencedReceiptObservationFailed");
            }
            if (!headKnown)
            {
                NoteFencedCleanup(failure, "AuthoringFencedReceiptHeadUnconfirmed");
            }
            bool settled = true;
            try
            {
                AuthoringLifecycleResourceReport remaining = await resources.RevokeAllAsync(
                    oldPackage.Contract.Manifest.Id,
                    activationAttempted ? startupGeneration : previous.Generation,
                    CancellationToken.None);
                settled = remaining.IsEmpty;
                if (!settled)
                {
                    NoteFencedCleanup(failure, "AuthoringFencedResourcesUnsettled");
                }
            }
            catch
            {
                settled = false;
                NoteFencedCleanup(failure, "AuthoringFencedResourceCleanupFailed");
            }
            try
            {
                await grants.RevokeExtensionAsync(oldPackage.Contract.Manifest.Id, CancellationToken.None);
            }
            catch
            {
                settled = false;
                NoteFencedCleanup(failure, "AuthoringFencedGrantCleanupFailed");
            }
            // A persisted/uncertain Running append cannot authorize rolling state back underneath it.
            // Failed containment or an unobserved head retains the fence for explicit recovery.
            if (backupAttempted && !runningAccepted && headKnown && settled)
            {
                try
                {
                    await fenced.RollbackAsync(oldPackage, newPackage, plan, CancellationToken.None);
                }
                catch
                {
                    NoteFencedCleanup(failure, "AuthoringFencedRollbackFailed");
                }
            }
            if (headKnown)
            {
                try
                {
                    await RecordAsync(runningAccepted ? newPackage : oldPackage, cursor,
                        runningAccepted || !backupAttempted ? AuthoringLifecycleState.Failed : AuthoringLifecycleState.RollbackRequired,
                        "fenced-lifecycle-recovery-required", CancellationToken.None);
                }
                catch
                {
                    NoteFencedCleanup(failure, "AuthoringFencedFailureReceiptRejected");
                }
            }
            throw;
        }

        async ValueTask RecordNextAsync(VerifiedAuthoringPackage package, AuthoringLifecycleState state)
        {
            pending = CreateReceipt(package, cursor, state, null);
            cursor = await RecordAsync(pending, cancellationToken);
        }
    }

    /// <summary>
    /// Deletes only the exact current-plus-backup measurement accepted by the original host
    /// approval owner. ApprovalReceiptId is data, never sufficient approval on its own.
    /// </summary>
    public async ValueTask DeleteOwnedDataAsync(
        VerifiedAuthoringPackage package,
        AuthoringFencedStateDeletion approval,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (stateStore is not IAuthoringFencedExtensionStateStore fenced ||
            preflight is not IAuthoringFencedLifecyclePreflight admission)
        {
            throw new AuthoringExtensionContractException("fenced_lifecycle_host_authority_unavailable");
        }
        ArgumentNullException.ThrowIfNull(approval);
        ArgumentNullException.ThrowIfNull(approval.Expected);
        AuthoringExtensionStateContract.ValidateOwner(package, approval.Expected.Scope);
        if (!AuthoringExtensionStateContract.IsField(approval.ApprovalReceiptId, 256) ||
            approval.Expected.Revision < 0 || approval.Expected.Records < 0 || approval.Expected.Bytes < 0 ||
            !AuthoringExtensionStateContract.IsDigest(approval.Expected.ContentSha256))
        {
            throw new AuthoringExtensionContractException("fenced_lifecycle_deletion_invalid");
        }
        AuthoringLifecycleReceipt previous = RequireFencedReceipt(package,
            await receiptStore.GetLatestAsync(package.Contract.Manifest.Id, cancellationToken));
        if (previous.State != AuthoringLifecycleState.RetainedData)
        {
            throw new AuthoringExtensionContractException("fenced_lifecycle_retained_data_required");
        }
        using IAuthoringFencedLifecycleAdmissionScope scope = await admission.AcquireDeletionAsync(
            package, approval, previous, cancellationToken)
            ?? throw new AuthoringExtensionContractException("fenced_lifecycle_admission_missing");
        await scope.VerifyCurrentAsync(cancellationToken);
        await RequireCurrentReceiptAsync(previous, cancellationToken);
        AuthoringStateMeasurement current = await fenced.MeasureAsync(package, approval.Expected.Scope, cancellationToken);
        if (current != approval.Expected)
        {
            throw new AuthoringExtensionContractException("fenced_lifecycle_deletion_measurement_changed");
        }
        await scope.VerifyCurrentAsync(cancellationToken);
        await fenced.DeleteAsync(package, approval, cancellationToken);
        await RecordAsync(package, previous, AuthoringLifecycleState.Removed, null, cancellationToken);
    }

    private static AuthoringLifecycleReceipt RequireFencedReceipt(
        VerifiedAuthoringPackage package, AuthoringLifecycleReceipt? receipt)
    {
        if (receipt is null || receipt.ExtensionId != package.Contract.Manifest.Id ||
            receipt.Version != package.Contract.Manifest.Version ||
            receipt.PackageSha256 != package.Contract.Manifest.PackageSha256 ||
            receipt.ScopeDigest != package.PackageIdentity ||
            receipt.StateSchemaVersion != package.Contract.Manifest.StateSchemaVersion ||
            receipt.DataSchemaVersion != package.Contract.Manifest.DataSchemaVersion ||
            receipt.SchemaVersion != 1 || receipt.Sequence < 1 || receipt.Generation != receipt.Sequence ||
            receipt.ReceiptSha256 != ComputeReceiptSha256(receipt))
        {
            throw new AuthoringExtensionContractException("fenced_lifecycle_receipt_identity_mismatch");
        }
        return receipt;
    }

    private async ValueTask RequireCurrentReceiptAsync(AuthoringLifecycleReceipt expected, CancellationToken cancellationToken)
    {
        if (await receiptStore.GetLatestAsync(expected.ExtensionId, cancellationToken) != expected)
        {
            throw new AuthoringExtensionContractException("fenced_lifecycle_receipt_head_changed");
        }
    }

    private static void NoteFencedCleanup(Exception failure, string code)
    {
        try
        {
            // Only fixed diagnostic identifiers are retained, never state or provider exception payloads.
            failure.Data[code] = true;
        }
        catch
        {
            // Cleanup diagnostics cannot replace the original operation failure.
        }
    }

    public async ValueTask<AuthoringLifecycleReceipt> UninstallAsync(
        VerifiedAuthoringPackage package,
        AuthoringStateScope ownedState,
        CancellationToken cancellationToken = default)
    {
        ValidateOwnedScope(package, ownedState);
        AuthoringLifecycleReceipt? previous = await receiptStore.GetLatestAsync(package.Contract.Manifest.Id, cancellationToken);
        AuthoringLifecycleReceipt uninstalling = await RecordAsync(
            package,
            previous,
            AuthoringLifecycleState.Uninstalling,
            null,
            cancellationToken);
        AuthoringLifecycleResourceReport remaining = await resources.RevokeAllAsync(
            package.Contract.Manifest.Id,
            previous?.Generation ?? 0,
            cancellationToken);
        if (!remaining.IsEmpty)
        {
            await RecordAsync(
                package,
                uninstalling,
                AuthoringLifecycleState.Failed,
                "uninstall-resource-revocation-incomplete",
                CancellationToken.None);
            throw new AuthoringExtensionContractException("Uninstall left active extension authority or work.");
        }

        await grants.RevokeExtensionAsync(package.Contract.Manifest.Id, cancellationToken);
        return await RecordAsync(
            package,
            uninstalling,
            AuthoringLifecycleState.RetainedData,
            null,
            cancellationToken);
    }

    public async ValueTask DeleteOwnedDataAsync(
        VerifiedAuthoringPackage package,
        AuthoringDeleteDataApproval approval,
        CancellationToken cancellationToken = default)
    {
        if (stateStore is IAuthoringFencedExtensionStateStore)
        {
            throw new AuthoringExtensionContractException("fenced_lifecycle_requires_typed_deletion");
        }
        ValidateOwnedScope(package, approval.Scope);
        AuthoringLifecycleReceipt? receipt = await receiptStore.GetLatestAsync(package.Contract.Manifest.Id, cancellationToken);
        if (receipt?.State != AuthoringLifecycleState.RetainedData ||
            !string.Equals(approval.ExtensionId, package.Contract.Manifest.Id, StringComparison.Ordinal) ||
            !string.Equals(approval.PackageSha256, package.Contract.Manifest.PackageSha256, StringComparison.Ordinal) ||
            string.IsNullOrWhiteSpace(approval.ApprovalReceiptId))
        {
            throw new AuthoringExtensionContractException("Extension data deletion requires a separate exact retained-data approval.");
        }

        (long records, long bytes) = await stateStore.MeasureAsync(approval.Scope, cancellationToken);
        if (records != approval.ExpectedRecords || bytes != approval.ExpectedBytes)
        {
            throw new AuthoringExtensionContractException("Extension data deletion scope changed after approval.");
        }

        await stateStore.DeleteAsync(approval.Scope, cancellationToken);
        await RecordAsync(
            package,
            receipt,
            AuthoringLifecycleState.Removed,
            null,
            cancellationToken);
    }

    public async ValueTask<AuthoringLifecycleReceipt> MarkDegradedAsync(
        VerifiedAuthoringPackage package,
        long expectedGeneration,
        string failureCode,
        CancellationToken cancellationToken = default) =>
        await RecordRuntimeHealthAsync(
            package,
            expectedGeneration,
            AuthoringLifecycleState.Degraded,
            failureCode,
            cancellationToken);

    public async ValueTask<AuthoringLifecycleReceipt> MarkCrashedAsync(
        VerifiedAuthoringPackage package,
        long expectedGeneration,
        string failureCode,
        CancellationToken cancellationToken = default) =>
        await RecordRuntimeHealthAsync(
            package,
            expectedGeneration,
            AuthoringLifecycleState.Crashed,
            failureCode,
            cancellationToken);

    public async ValueTask<AuthoringLifecycleReceipt> MarkRecoveredAsync(
        VerifiedAuthoringPackage package,
        long expectedGeneration,
        CancellationToken cancellationToken = default) =>
        await RecordRuntimeHealthAsync(
            package,
            expectedGeneration,
            AuthoringLifecycleState.Running,
            null,
            cancellationToken);

    public async ValueTask<bool> AcceptResultAsync(
        string extensionId,
        long generation,
        CancellationToken cancellationToken = default)
    {
        if (stateStore is IAuthoringFencedExtensionStateStore)
        {
            // A receipt alone cannot prove fenced settlement or current runtime/approval facts.
            throw new AuthoringExtensionContractException("fenced_lifecycle_result_authority_unavailable");
        }
        AuthoringLifecycleReceipt? receipt = await receiptStore.GetLatestAsync(extensionId, cancellationToken);
        return receipt?.State == AuthoringLifecycleState.Running && receipt.Generation == generation;
    }

    public ValueTask<AuthoringLifecycleReceipt?> RestoreFromReceiptAsync(
        string extensionId,
        CancellationToken cancellationToken = default) =>
        receiptStore.GetLatestAsync(extensionId, cancellationToken);

    private static void ValidateTargets(
        VerifiedAuthoringPackage package,
        ImmutableArray<AuthoringExecutionTarget> targets)
    {
        if (targets.IsDefault ||
            targets.Length != package.Contract.Manifest.Contributions.Length ||
            targets.Any(target => target.Status != AuthoringExecutionResolutionStatus.Ready ||
                !string.Equals(target.ExtensionId, package.Contract.Manifest.Id, StringComparison.Ordinal) ||
                !string.Equals(target.ExtensionVersion, package.Contract.Manifest.Version, StringComparison.Ordinal) ||
                !string.Equals(target.PackageSha256, package.Contract.Manifest.PackageSha256, StringComparison.Ordinal) ||
                !package.Contract.Manifest.Contributions.Any(contribution =>
                    string.Equals(contribution.Id, target.ContributionId, StringComparison.Ordinal) &&
                    contribution.ExecutionClass == target.ExecutionClass)) ||
            targets.Select(static target => target.ContributionId).Distinct(StringComparer.Ordinal).Count() != targets.Length)
        {
            throw new AuthoringExtensionContractException("Lifecycle targets are partial, duplicated, blocked, or identity-drifted.");
        }
    }

    private static void ValidateMigration(
        VerifiedAuthoringPackage oldPackage,
        VerifiedAuthoringPackage newPackage,
        AuthoringStateMigrationPlan plan)
    {
        if (!string.Equals(oldPackage.Contract.Manifest.Id, newPackage.Contract.Manifest.Id, StringComparison.Ordinal) ||
            !string.Equals(plan.From.ExtensionId, oldPackage.Contract.Manifest.Id, StringComparison.Ordinal) ||
            !string.Equals(plan.To.ExtensionId, newPackage.Contract.Manifest.Id, StringComparison.Ordinal) ||
            !string.Equals(plan.From.ExtensionVersion, oldPackage.Contract.Manifest.Version, StringComparison.Ordinal) ||
            !string.Equals(plan.To.ExtensionVersion, newPackage.Contract.Manifest.Version, StringComparison.Ordinal) ||
            !string.Equals(plan.From.SiteId, plan.To.SiteId, StringComparison.Ordinal) ||
            !string.Equals(plan.From.UserId, plan.To.UserId, StringComparison.Ordinal) ||
            !string.Equals(plan.From.DocumentId, plan.To.DocumentId, StringComparison.Ordinal) ||
            plan.From.SchemaVersion != oldPackage.Contract.Manifest.StateSchemaVersion ||
            plan.To.SchemaVersion != newPackage.Contract.Manifest.StateSchemaVersion ||
            !IsBoundedField(plan.PlanId, 256) ||
            plan.MaximumRecords is < 0 or > 1_000_000 ||
            plan.MaximumBytes is < 0 or > 536_870_912 ||
            plan.MaximumDuration <= TimeSpan.Zero || plan.MaximumDuration > TimeSpan.FromMinutes(5) ||
            plan.Transforms.IsDefault || plan.Transforms.Length > 1000 ||
            plan.Transforms.Any(static transform => !Enum.IsDefined(transform.Kind)) ||
            !IsBoundedField(plan.BackupReference, 256) ||
            !IsBoundedField(plan.RollbackReference, 256) ||
            !IsSha256(plan.ContentSha256))
        {
            throw new AuthoringExtensionContractException("Migration plan is cross-scope, unbounded, executable, or not identity-bound.");
        }
    }

    private static void ValidateOwnedScope(VerifiedAuthoringPackage package, AuthoringStateScope scope)
    {
        if (!string.Equals(scope.ExtensionId, package.Contract.Manifest.Id, StringComparison.Ordinal) ||
            !string.Equals(scope.ExtensionVersion, package.Contract.Manifest.Version, StringComparison.Ordinal) ||
            !IsBoundedField(scope.SiteId, 256) ||
            !IsBoundedField(scope.UserId, 256) ||
            (scope.DocumentId is not null && !IsBoundedField(scope.DocumentId, 256)) ||
            scope.SchemaVersion != package.Contract.Manifest.StateSchemaVersion)
        {
            throw new AuthoringExtensionContractException("State scope is not owned by the exact extension/site/user/document identity.");
        }
    }

    private static bool IsBoundedField(string? value, int maximumLength) =>
        !string.IsNullOrWhiteSpace(value) &&
        value.Length <= maximumLength &&
        value == value.Trim() &&
        !value.ContainsAny(['\0', '\r', '\n']);

    private static bool IsSha256(string? value) =>
        value?.Length == 64 && value.All(static character =>
            character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private ValueTask<AuthoringLifecycleReceipt> RecordAsync(
        VerifiedAuthoringPackage package,
        AuthoringLifecycleReceipt? previous,
        AuthoringLifecycleState state,
        string? failureCode,
        CancellationToken cancellationToken) =>
        RecordAsync(CreateReceipt(package, previous, state, failureCode), cancellationToken);

    private async ValueTask<AuthoringLifecycleReceipt> RecordAsync(
        AuthoringLifecycleReceipt receipt, CancellationToken cancellationToken)
    {
        await receiptStore.AppendAsync(receipt, cancellationToken);
        return receipt;
    }

    private static AuthoringLifecycleReceipt CreateReceipt(
        VerifiedAuthoringPackage package,
        AuthoringLifecycleReceipt? previous,
        AuthoringLifecycleState state,
        string? failureCode)
    {
        AuthoringLifecycleState previousState = previous?.State ?? AuthoringLifecycleState.Installed;
        ValidateTransition(previousState, state);
        long sequence = (previous?.Sequence ?? 0) + 1;
        long generation = (previous?.Generation ?? 0) + 1;
        string previousReceiptSha256 = previous?.ReceiptSha256 ?? new string('0', 64);
        var receipt = new AuthoringLifecycleReceipt(
            1,
            sequence,
            package.Contract.Manifest.Id,
            package.Contract.Manifest.PackageSha256,
            package.Contract.Manifest.Version,
            package.Contract.Manifest.StateSchemaVersion,
            package.Contract.Manifest.DataSchemaVersion,
            previousState,
            state,
            generation,
            package.PackageIdentity,
            failureCode,
            previousReceiptSha256,
            string.Empty);
        receipt = receipt with
        {
            ReceiptSha256 = ComputeReceiptSha256(receipt)
        };
        return receipt;
    }

    private async ValueTask<AuthoringLifecycleReceipt> RecordRuntimeHealthAsync(
        VerifiedAuthoringPackage package,
        long expectedGeneration,
        AuthoringLifecycleState state,
        string? failureCode,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(package);
        AuthoringLifecycleReceipt? previous = await receiptStore.GetLatestAsync(
            package.Contract.Manifest.Id,
            cancellationToken);
        if (previous is null || previous.Generation != expectedGeneration ||
            !string.Equals(previous.PackageSha256, package.Contract.Manifest.PackageSha256, StringComparison.Ordinal) ||
            failureCode is not null &&
                (string.IsNullOrWhiteSpace(failureCode) || failureCode.Length > 128))
        {
            throw new AuthoringExtensionContractException("Runtime health transition is stale, broad, or identity-drifted.");
        }

        long replacementGeneration = previous.Generation + 1;
        bool rebound = await resources.RebindGenerationAsync(
            package.Contract.Manifest.Id,
            previous.Generation,
            replacementGeneration,
            cancellationToken);
        try
        {
            return await RecordAsync(package, previous, state, failureCode, cancellationToken);
        }
        catch
        {
            if (rebound)
            {
                await resources.RebindGenerationAsync(
                    package.Contract.Manifest.Id,
                    replacementGeneration,
                    previous.Generation,
                    CancellationToken.None);
            }
            throw;
        }
    }

    private static void ValidateTransition(
        AuthoringLifecycleState previous,
        AuthoringLifecycleState next)
    {
        bool valid = IsTransitionAllowed(previous, next);
        if (!valid)
        {
            throw new AuthoringExtensionContractException(
                $"Lifecycle transition {previous} -> {next} is not registered.");
        }
    }

    internal static bool IsTransitionAllowed(
        AuthoringLifecycleState previous,
        AuthoringLifecycleState next) =>
        (previous, next) switch
        {
            (AuthoringLifecycleState.Installed, AuthoringLifecycleState.PermissionPending or
                AuthoringLifecycleState.Enabled or AuthoringLifecycleState.Disabled or
                AuthoringLifecycleState.Updating or AuthoringLifecycleState.Uninstalling) => true,
            (AuthoringLifecycleState.PermissionPending, AuthoringLifecycleState.PermissionPending or
                AuthoringLifecycleState.Enabled or AuthoringLifecycleState.Disabled or
                AuthoringLifecycleState.Uninstalling) => true,
            (AuthoringLifecycleState.Enabled, AuthoringLifecycleState.Starting or
                AuthoringLifecycleState.Disabled or AuthoringLifecycleState.Uninstalling) => true,
            (AuthoringLifecycleState.Starting, AuthoringLifecycleState.Running or
                AuthoringLifecycleState.Crashed or AuthoringLifecycleState.RollbackRequired) => true,
            (AuthoringLifecycleState.Running, AuthoringLifecycleState.Disabled or
                AuthoringLifecycleState.Updating or AuthoringLifecycleState.Uninstalling or
                AuthoringLifecycleState.Degraded or AuthoringLifecycleState.Crashed or
                AuthoringLifecycleState.Failed) => true,
            (AuthoringLifecycleState.Degraded, AuthoringLifecycleState.Running or
                AuthoringLifecycleState.Disabled or AuthoringLifecycleState.Updating or
                AuthoringLifecycleState.Uninstalling or AuthoringLifecycleState.Crashed or
                AuthoringLifecycleState.Failed) => true,
            (AuthoringLifecycleState.Crashed, AuthoringLifecycleState.Enabled or
                AuthoringLifecycleState.Disabled or AuthoringLifecycleState.Updating or
                AuthoringLifecycleState.Uninstalling) => true,
            (AuthoringLifecycleState.Disabled, AuthoringLifecycleState.Enabled or
                AuthoringLifecycleState.Updating or AuthoringLifecycleState.Uninstalling) => true,
            (AuthoringLifecycleState.Updating, AuthoringLifecycleState.MigrationRequired or
                AuthoringLifecycleState.Migrating or AuthoringLifecycleState.PermissionPending or
                AuthoringLifecycleState.Starting or AuthoringLifecycleState.RollbackRequired or
                AuthoringLifecycleState.Failed) => true,
            (AuthoringLifecycleState.MigrationRequired, AuthoringLifecycleState.Migrating or
                AuthoringLifecycleState.RollbackRequired) => true,
            (AuthoringLifecycleState.Migrating, AuthoringLifecycleState.PermissionPending or
                AuthoringLifecycleState.Starting or AuthoringLifecycleState.RollbackRequired) => true,
            (AuthoringLifecycleState.RollbackRequired, AuthoringLifecycleState.Disabled or
                AuthoringLifecycleState.Enabled or AuthoringLifecycleState.Running or
                AuthoringLifecycleState.Uninstalling) => true,
            (AuthoringLifecycleState.Failed, AuthoringLifecycleState.Disabled or
                AuthoringLifecycleState.Enabled or AuthoringLifecycleState.Uninstalling) => true,
            (AuthoringLifecycleState.Uninstalling, AuthoringLifecycleState.RetainedData or
                AuthoringLifecycleState.Removed or AuthoringLifecycleState.Failed) => true,
            (AuthoringLifecycleState.RetainedData, AuthoringLifecycleState.Removed) => true,
            _ => false
        };

    public static string ComputeReceiptSha256(AuthoringLifecycleReceipt receipt)
    {
        ArgumentNullException.ThrowIfNull(receipt);
        string material = string.Join('\n',
            receipt.SchemaVersion,
            receipt.Sequence,
            receipt.ExtensionId,
            receipt.PackageSha256,
            receipt.Version,
            receipt.StateSchemaVersion,
            receipt.DataSchemaVersion,
            receipt.PreviousState,
            receipt.State,
            receipt.Generation,
            receipt.ScopeDigest,
            receipt.FailureCode ?? string.Empty,
            receipt.PreviousReceiptSha256);
        return Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(
            System.Text.Encoding.UTF8.GetBytes(material)));
    }
}
