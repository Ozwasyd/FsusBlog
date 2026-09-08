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
    RetainedData = 10
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
        CancellationToken cancellationToken);

    ValueTask<AuthoringLifecycleResourceReport> RevokeAllAsync(
        string extensionId,
        long generation,
        CancellationToken cancellationToken);
}

public interface IAuthoringLifecyclePreflight
{
    ValueTask<bool> VerifyAsync(
        VerifiedAuthoringPackage package,
        ImmutableArray<AuthoringExecutionTarget> targets,
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

public sealed class AuthoringExtensionLifecycleCoordinator(
    IAuthoringLifecycleResourceAuthority resources,
    IAuthoringLifecyclePreflight preflight,
    IAuthoringExtensionStateStore stateStore,
    IAuthoringLifecycleReceiptStore receiptStore)
{
    public async ValueTask<AuthoringLifecycleReceipt> EnableAsync(
        VerifiedAuthoringPackage package,
        ImmutableArray<AuthoringExecutionTarget> targets,
        CancellationToken cancellationToken = default)
    {
        ValidateTargets(package, targets);
        if (!await preflight.VerifyAsync(package, targets, cancellationToken))
        {
            throw new AuthoringExtensionContractException("Lifecycle preflight rejected package, grants, schemas, budgets, or readiness.");
        }

        AuthoringLifecycleReceipt? previous = await receiptStore.GetLatestAsync(package.Contract.Manifest.Id, cancellationToken);
        if (previous?.State is AuthoringLifecycleState.Uninstalling or AuthoringLifecycleState.Removed)
        {
            throw new AuthoringExtensionContractException("Removed extension cannot self-enable.");
        }

        await resources.ActivateAtomicallyAsync(package, targets, cancellationToken);
        return await RecordAsync(package, previous, AuthoringLifecycleState.Enabled, null, cancellationToken);
    }

    public async ValueTask<AuthoringLifecycleReceipt> DisableAsync(
        VerifiedAuthoringPackage package,
        CancellationToken cancellationToken = default)
    {
        AuthoringLifecycleReceipt? previous = await receiptStore.GetLatestAsync(package.Contract.Manifest.Id, cancellationToken);
        long generation = (previous?.Generation ?? 0) + 1;
        AuthoringLifecycleResourceReport remaining = await resources.RevokeAllAsync(
            package.Contract.Manifest.Id,
            generation,
            cancellationToken);
        if (!remaining.IsEmpty)
        {
            throw new AuthoringExtensionContractException("Disable left active extension authority or work.");
        }

        return await RecordAsync(package, previous, AuthoringLifecycleState.Disabled, null, cancellationToken);
    }

    public async ValueTask<AuthoringLifecycleReceipt> UpdateAsync(
        VerifiedAuthoringPackage oldPackage,
        VerifiedAuthoringPackage newPackage,
        ImmutableArray<AuthoringExecutionTarget> newTargets,
        AuthoringStateMigrationPlan plan,
        CancellationToken cancellationToken = default)
    {
        ValidateMigration(oldPackage, newPackage, plan);
        ValidateTargets(newPackage, newTargets);
        AuthoringLifecycleReceipt? previous = await receiptStore.GetLatestAsync(oldPackage.Contract.Manifest.Id, cancellationToken);
        await stateStore.BackupAsync(plan, cancellationToken);
        try
        {
            await stateStore.ApplyAsync(plan, cancellationToken);
            if (!await preflight.VerifyAsync(newPackage, newTargets, cancellationToken))
            {
                throw new AuthoringExtensionContractException("Updated package failed lifecycle preflight.");
            }

            AuthoringLifecycleResourceReport remaining = await resources.RevokeAllAsync(
                oldPackage.Contract.Manifest.Id,
                (previous?.Generation ?? 0) + 1,
                cancellationToken);
            if (!remaining.IsEmpty)
            {
                throw new AuthoringExtensionContractException("Update could not settle old extension work.");
            }

            await resources.ActivateAtomicallyAsync(newPackage, newTargets, cancellationToken);
            return await RecordAsync(newPackage, previous, AuthoringLifecycleState.Enabled, null, cancellationToken);
        }
        catch
        {
            await stateStore.RollbackAsync(plan, CancellationToken.None);
            await resources.ActivateAtomicallyAsync(oldPackage, [], CancellationToken.None);
            await RecordAsync(oldPackage, previous, AuthoringLifecycleState.RollbackRequired, "migration-or-activation-failed", CancellationToken.None);
            throw;
        }
    }

    public async ValueTask<AuthoringLifecycleReceipt> UninstallAsync(
        VerifiedAuthoringPackage package,
        AuthoringStateScope ownedState,
        CancellationToken cancellationToken = default)
    {
        ValidateOwnedScope(package, ownedState);
        AuthoringLifecycleReceipt? previous = await receiptStore.GetLatestAsync(package.Contract.Manifest.Id, cancellationToken);
        AuthoringLifecycleResourceReport remaining = await resources.RevokeAllAsync(
            package.Contract.Manifest.Id,
            (previous?.Generation ?? 0) + 1,
            cancellationToken);
        if (!remaining.IsEmpty)
        {
            throw new AuthoringExtensionContractException("Uninstall left active extension authority or work.");
        }

        return await RecordAsync(package, previous, AuthoringLifecycleState.RetainedData, null, cancellationToken);
    }

    public async ValueTask DeleteOwnedDataAsync(
        VerifiedAuthoringPackage package,
        AuthoringDeleteDataApproval approval,
        CancellationToken cancellationToken = default)
    {
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
    }

    public async ValueTask<bool> AcceptResultAsync(
        string extensionId,
        long generation,
        CancellationToken cancellationToken = default)
    {
        AuthoringLifecycleReceipt? receipt = await receiptStore.GetLatestAsync(extensionId, cancellationToken);
        return receipt?.State == AuthoringLifecycleState.Enabled && receipt.Generation == generation;
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
                !string.Equals(target.PackageSha256, package.Contract.Manifest.PackageSha256, StringComparison.Ordinal)) ||
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
            plan.From.SchemaVersion != oldPackage.Contract.Manifest.StateSchemaVersion ||
            plan.To.SchemaVersion != newPackage.Contract.Manifest.StateSchemaVersion ||
            plan.MaximumRecords is < 0 or > 1_000_000 ||
            plan.MaximumBytes is < 0 or > 536_870_912 ||
            plan.MaximumDuration <= TimeSpan.Zero || plan.MaximumDuration > TimeSpan.FromMinutes(5) ||
            plan.Transforms.IsDefault || plan.Transforms.Length > 1000 ||
            plan.Transforms.Any(static transform => !Enum.IsDefined(transform.Kind)) ||
            string.IsNullOrWhiteSpace(plan.BackupReference) ||
            string.IsNullOrWhiteSpace(plan.RollbackReference) ||
            plan.ContentSha256.Length != 64)
        {
            throw new AuthoringExtensionContractException("Migration plan is cross-scope, unbounded, executable, or not identity-bound.");
        }
    }

    private static void ValidateOwnedScope(VerifiedAuthoringPackage package, AuthoringStateScope scope)
    {
        if (!string.Equals(scope.ExtensionId, package.Contract.Manifest.Id, StringComparison.Ordinal) ||
            string.IsNullOrWhiteSpace(scope.SiteId) ||
            string.IsNullOrWhiteSpace(scope.UserId) ||
            scope.SchemaVersion != package.Contract.Manifest.StateSchemaVersion)
        {
            throw new AuthoringExtensionContractException("State scope is not owned by the exact extension/site/user/document identity.");
        }
    }

    private async ValueTask<AuthoringLifecycleReceipt> RecordAsync(
        VerifiedAuthoringPackage package,
        AuthoringLifecycleReceipt? previous,
        AuthoringLifecycleState state,
        string? failureCode,
        CancellationToken cancellationToken)
    {
        long sequence = (previous?.Sequence ?? 0) + 1;
        long generation = (previous?.Generation ?? 0) + 1;
        string material = string.Join('\n',
            sequence,
            package.Contract.Manifest.Id,
            package.Contract.Manifest.PackageSha256,
            package.Contract.Manifest.Version,
            state,
            generation,
            failureCode ?? string.Empty);
        string digest = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(material)));
        var receipt = new AuthoringLifecycleReceipt(
            sequence,
            package.Contract.Manifest.Id,
            package.Contract.Manifest.PackageSha256,
            package.Contract.Manifest.Version,
            package.Contract.Manifest.StateSchemaVersion,
            package.Contract.Manifest.DataSchemaVersion,
            previous?.State ?? AuthoringLifecycleState.Installed,
            state,
            generation,
            package.PackageIdentity,
            failureCode,
            digest);
        await receiptStore.AppendAsync(receipt, cancellationToken);
        return receipt;
    }
}
