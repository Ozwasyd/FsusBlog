using System.Collections.Immutable;
using System.Data.Common;

using Xunit;

using FsusBlog.Contracts.Migration;

namespace FsusBlog.Migration.Tests;

// These invoke the production compiled-binding predicate only. Synthetic
// descriptors cannot create either private producer cap or qualify a native DAG.
public sealed class OfflineMigrationOwnedPlanningAuthorityReaderTests
{
    private static readonly string s_digest = new('a', 64);

    [Fact]
    public void DeclaredClosureResolvesEveryProviderOnEveryOrderedStepWithoutNativeWork()
    {
        OfflineMigrationDag dag = Dag();
        var registry = new RecordingRegistry();
        OfflineMigrationOwnedPlanningAuthorityReader.ValidateDeclaredDagOwners(dag, registry, CancellationToken.None);
        Assert.Equal(6, registry.Resolved.Count);
        Assert.Equal(new[] { "entry", "entry", "entry", "finish", "finish", "finish" },
            registry.Resolved.Select(value => value.Step));
        Assert.Equal(Enum.GetValues<CurrentSchemaProviderKind>(), registry.Resolved.Take(3).Select(value => value.Provider));
        Assert.Equal(0, registry.NativeCalls);
    }

    [Theory]
    [InlineData(CurrentSchemaProviderKind.PostgreSql)]
    [InlineData(CurrentSchemaProviderKind.MySql)]
    [InlineData(CurrentSchemaProviderKind.Sqlite)]
    public void MissingProviderCannotBecomeACompleteCompiledRoute(CurrentSchemaProviderKind omitted)
    {
        OfflineMigrationDag dag = Dag();
        dag = dag with
        {
            Steps = dag.Steps.SetItem(0, dag.Steps[0] with
            {
                Operations = dag.Steps[0].Operations.Where(value => value.Provider != omitted).ToImmutableArray()
            })
        };
        var registry = new RecordingRegistry();
        Assert.Throws<InvalidOperationException>(() =>
            OfflineMigrationOwnedPlanningAuthorityReader.ValidateDeclaredDagOwners(dag, registry, CancellationToken.None));
        Assert.Empty(registry.Resolved);
        Assert.Equal(0, registry.NativeCalls);
    }

    [Theory]
    [InlineData(CurrentSchemaProviderKind.PostgreSql)]
    [InlineData(CurrentSchemaProviderKind.MySql)]
    [InlineData(CurrentSchemaProviderKind.Sqlite)]
    public void ActualDescriptorIdentityCannotDriftFromTheDeclaredProvider(CurrentSchemaProviderKind changed)
    {
        var registry = new RecordingRegistry { Changed = changed };
        InvalidOperationException failure = Assert.Throws<InvalidOperationException>(() =>
            OfflineMigrationOwnedPlanningAuthorityReader.ValidateDeclaredDagOwners(Dag(), registry, CancellationToken.None));
        Assert.Equal("offline_plan_compiled_operation_owner_changed", failure.Message);
        Assert.Equal(0, registry.NativeCalls);
    }

    [Fact]
    public void MissingActualOwnerPreservesItsRefusalBeforeNativeWork()
    {
        var registry = new RecordingRegistry { Missing = CurrentSchemaProviderKind.MySql };
        InvalidOperationException failure = Assert.Throws<InvalidOperationException>(() =>
            OfflineMigrationOwnedPlanningAuthorityReader.ValidateDeclaredDagOwners(Dag(), registry, CancellationToken.None));
        Assert.Equal("fixture_actual_operation_unavailable", failure.Message);
        Assert.Equal(0, registry.NativeCalls);
    }

    [Fact]
    public void IndependentSourceEntriesCannotBeCombinedIntoOneRoute()
    {
        OfflineMigrationDag dag = Dag();
        dag = dag with
        {
            Steps = dag.Steps.SetItem(1, dag.Steps[1] with
            {
                Dependencies = []
            })
        };
        var registry = new RecordingRegistry();
        InvalidOperationException failure = Assert.Throws<InvalidOperationException>(() =>
            OfflineMigrationOwnedPlanningAuthorityReader.ValidateDeclaredDagOwners(dag, registry, CancellationToken.None));
        Assert.Equal("offline_plan_compiled_single_entry_required", failure.Message);
        Assert.Empty(registry.Resolved);
        Assert.Equal(0, registry.NativeCalls);
    }

    [Fact]
    public void CancellationBeforeBindingDoesNotResolveOrObserveAnyOwner()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        var registry = new RecordingRegistry();
        Assert.ThrowsAny<OperationCanceledException>(() =>
            OfflineMigrationOwnedPlanningAuthorityReader.ValidateDeclaredDagOwners(Dag(), registry, cancellation.Token));
        Assert.Empty(registry.Resolved);
        Assert.Equal(0, registry.NativeCalls);
    }

    [Fact]
    public void CancellationDuringBindingStopsBeforeFurtherProviderOrNativeWork()
    {
        using var cancellation = new CancellationTokenSource();
        var registry = new RecordingRegistry { AfterResolve = cancellation.Cancel };
        Assert.ThrowsAny<OperationCanceledException>(() =>
            OfflineMigrationOwnedPlanningAuthorityReader.ValidateDeclaredDagOwners(Dag(), registry, cancellation.Token));
        Assert.Single(registry.Resolved);
        Assert.Equal(0, registry.NativeCalls);
    }

    private static OfflineMigrationDag Dag()
    {
        OfflineMigrationStep Step(string id, ImmutableArray<string> dependencies)
            => new(id, "source", "target", dependencies, "idempotent", false,
                new("v1", 0, "transaction", "target"),
                Enum.GetValues<CurrentSchemaProviderKind>().Select(provider => new OfflineMigrationProviderOperation(
                    provider, id + "/" + provider, s_digest, s_digest, OfflineMigrationExecutionMode.Transaction)).ToImmutableArray());
        return new("compiled-fixture", "v1", [Step("entry", []), Step("finish", ["entry"])]);
    }

    private sealed class RecordingRegistry : IOfflineMigrationApplyOperationRegistry
    {
        internal CurrentSchemaProviderKind? Changed
        {
            get; init;
        }
        internal CurrentSchemaProviderKind? Missing
        {
            get; init;
        }
        internal Action? AfterResolve
        {
            get; init;
        }
        internal List<(string Step, CurrentSchemaProviderKind Provider)> Resolved { get; } = [];
        internal int NativeCalls
        {
            get; private set;
        }

        public OfflineMigrationApplyOperation Resolve(OfflineMigrationStep step, OfflineMigrationProviderOperation identity)
        {
            Resolved.Add((step.StepId, identity.Provider));
            if (identity.Provider == Missing)
            {
                throw new InvalidOperationException("fixture_actual_operation_unavailable");
            }
            AfterResolve?.Invoke();
            return new Descriptor(this, identity.Provider == Changed
                ? identity with
                {
                    OperationSourceDigest = new string('b', 64)
                } : identity);
        }

        private sealed class Descriptor(RecordingRegistry registry, OfflineMigrationProviderOperation identity)
            : OfflineMigrationApplyOperation
        {
            internal override OfflineMigrationProviderOperation Identity => identity;

            internal override Task<OfflineMigrationPredicateObservation> ObserveAsync(string predicateReference,
                DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
            {
                registry.NativeCalls++;
                throw new InvalidOperationException("fixture_native_work_forbidden");
            }

            internal override Task<OfflineMigrationApplyUnit> ExecuteAsync(OfflineMigrationStep step,
                OfflineMigrationApplyJournalEntry? previousUnit, DbConnection connection,
                DbTransaction transaction, CancellationToken cancellationToken)
            {
                registry.NativeCalls++;
                throw new InvalidOperationException("fixture_native_work_forbidden");
            }
        }
    }
}
