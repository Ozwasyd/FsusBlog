using FsusBlog.Contracts.Migration;
using FsusBlog.Contracts.Schema;

namespace FsusBlog.Migration;

// Process-owned composition, not a plan/JSON import or a registry of caller SQL.
// The original producer capabilities retain their own construction/revalidation
// authority. This adapter only closes their actual compiled operation bindings.
internal sealed class OfflineMigrationOwnedPlanningAuthorityReader : IOfflineMigrationPlanningAuthorityReader
{
    private readonly OwnedCurrentSchemaTarget _target;
    private readonly OwnedRetainedMigrationTool _tool;
    private readonly IOfflineMigrationApplyOperationRegistry _operations;
    private readonly OfflineMigrationDag _dag;
    private readonly TimeSpan _maximumBackupAge;

    internal OfflineMigrationOwnedPlanningAuthorityReader(OwnedCurrentSchemaTarget target,
        OwnedRetainedMigrationTool tool, IOfflineMigrationApplyOperationRegistry operations,
        OfflineMigrationDag dag, TimeSpan maximumBackupAge)
    {
        ArgumentNullException.ThrowIfNull(target);
        ArgumentNullException.ThrowIfNull(tool);
        ArgumentNullException.ThrowIfNull(operations);
        ArgumentNullException.ThrowIfNull(dag);
        if (maximumBackupAge <= TimeSpan.Zero)
        {
            throw new InvalidOperationException("offline_backup_age_policy_invalid");
        }
        _target = target;
        _tool = tool;
        _operations = operations;
        _dag = dag;
        _maximumBackupAge = maximumBackupAge;
    }

    public async Task<OfflineMigrationPlanningAuthority> ReadAsync(
        CurrentSchemaProviderKind provider, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!Enum.IsDefined(provider))
        {
            throw new InvalidOperationException("offline_plan_provider_invalid");
        }
        // Resolve is the original pure compiled-descriptor boundary. Incomplete
        // provider sets refuse before producer, credential, backup or native work;
        // an implemented PostgreSQL descriptor cannot stand in for the other two.
        ValidateDeclaredDagOwners(_dag, _operations, cancellationToken);
        CurrentSchemaVerifierIdentity tool = await _tool.RevalidateAsync(cancellationToken).ConfigureAwait(false);
        await _target.RevalidateRetainedArtifactAsync(cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        CurrentSchemaIdentity identity = _target.Target;
        var target = new CurrentSchemaTargetIdentity(identity.ModelVersion, identity.ExtractorVersion,
            identity.GeneratorVersion, identity.SourceDigest, identity.ContentDigest);
        OfflineMigrationPlanValidation.ValidateTargetAndTool(target, tool);
        // Producer revalidation may take time. Re-check the same declared closure,
        // never replace it with newly discovered steps or a deserialized plan DAG.
        ValidateDeclaredDagOwners(_dag, _operations, cancellationToken);
        return new(target, tool, _dag, _maximumBackupAge);
    }

    internal static void ValidateDeclaredDagOwners(OfflineMigrationDag dag,
        IOfflineMigrationApplyOperationRegistry operations, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(dag);
        ArgumentNullException.ThrowIfNull(operations);
        cancellationToken.ThrowIfCancellationRequested();
        OfflineMigrationStep[] roots = dag.Steps.IsDefault
            ? [] : dag.Steps.Where(step => step.Dependencies.IsDefaultOrEmpty).ToArray();
        if (roots.Length != 1)
        {
            throw new InvalidOperationException("offline_plan_compiled_single_entry_required");
        }
        // Reuse the original DAG/provider validation and ordering. The native
        // source fingerprint still selects/requires its exact entry in the builder;
        // this compiled route cannot authorize a different observed source shape.
        foreach (OfflineMigrationStep step in OfflineMigrationPlanValidation.OrderSteps(dag, roots[0].StepId))
        {
            foreach (OfflineMigrationProviderOperation identity in step.Operations)
            {
                cancellationToken.ThrowIfCancellationRequested();
                OfflineMigrationApplyOperation operation = operations.Resolve(step, identity);
                if (operation is null || operation.Identity != identity)
                {
                    throw new InvalidOperationException("offline_plan_compiled_operation_owner_changed");
                }
                // Each concrete provider owner must satisfy the existing Core
                // execution contract before target/tool, backup or native work.
                // Metadata alone cannot make MySQL implicit-commit DDL atomic.
                operation.RequireAtomicNativeExecution();
            }
        }
        cancellationToken.ThrowIfCancellationRequested();
    }
}
