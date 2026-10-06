using System.Collections.Immutable;
using System.Data.Common;

using FsusBlog.Contracts.Migration;

using Xunit;

namespace FsusBlog.Migration.Tests;

public sealed class OfflineMigrationOwnedPlanningAuthorityReaderTests
{
    private const string Digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    [Theory]
    [InlineData(OfflineMigrationExecutionMode.Transaction)]
    [InlineData(OfflineMigrationExecutionMode.CheckpointedBatch)]
    public void DeclaredProviderMetadataCannotAdmitMissingMySqlAtomicOwner(OfflineMigrationExecutionMode mode)
    {
        OfflineMigrationDag dag = CreateDag(mode);
        var registry = new FixtureRegistry();
        InvalidOperationException failure = Assert.Throws<InvalidOperationException>(() =>
            OfflineMigrationOwnedPlanningAuthorityReader.ValidateDeclaredDagOwners(dag, registry, default));
        Assert.Equal("offline_apply_mysql_atomic_operation_owner_missing", failure.Message);
        Assert.Contains(CurrentSchemaProviderKind.MySql, registry.AtomicChecks);
        Assert.All(dag.Steps[0].Operations, identity => Assert.Equal(mode, identity.Mode));
    }

    [Fact]
    public void PureGateChecksEveryResolvedOwnerWithoutSemanticExecution()
    {
        // This fixture tests only the pure contract call sequence; it supplies no
        // real InnoDB effects, native provider, backup, registry or apply qualification.
        OfflineMigrationDag dag = CreateDag(OfflineMigrationExecutionMode.Transaction);
        var registry = new FixtureRegistry(permitFixtureAtomicContract: true);
        OfflineMigrationOwnedPlanningAuthorityReader.ValidateDeclaredDagOwners(dag, registry, default);
        Assert.Equal(dag.Steps[0].Operations.Select(identity => identity.Provider), registry.AtomicChecks);
        Assert.Equal(3, registry.Resolutions);
    }

    [Fact]
    public void ChangedIdentityRefusesBeforeOwnerAtomicContract()
    {
        OfflineMigrationDag dag = CreateDag(OfflineMigrationExecutionMode.Transaction);
        var registry = new FixtureRegistry(changeIdentity: true);
        InvalidOperationException failure = Assert.Throws<InvalidOperationException>(() =>
            OfflineMigrationOwnedPlanningAuthorityReader.ValidateDeclaredDagOwners(dag, registry, default));
        Assert.Equal("offline_plan_compiled_operation_owner_changed", failure.Message);
        Assert.Empty(registry.AtomicChecks);
    }

    [Fact]
    public void CancellationRefusesBeforeRegistryResolution()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        var registry = new FixtureRegistry();
        Assert.Throws<OperationCanceledException>(() =>
            OfflineMigrationOwnedPlanningAuthorityReader.ValidateDeclaredDagOwners(
                CreateDag(OfflineMigrationExecutionMode.Transaction), registry, cancellation.Token));
        Assert.Equal(0, registry.Resolutions);
        Assert.Empty(registry.AtomicChecks);
    }

    private static OfflineMigrationDag CreateDag(OfflineMigrationExecutionMode mode)
    {
        ImmutableArray<OfflineMigrationProviderOperation> identities = Enum.GetValues<CurrentSchemaProviderKind>()
            .Select(provider => new OfflineMigrationProviderOperation(provider,
                "fixture-only:" + provider, Digest, Digest, mode)).ToImmutableArray();
        var resume = new OfflineMigrationResumePolicy("fixture-only.v1",
            mode == OfflineMigrationExecutionMode.Transaction ? 0 : 1, "fixture-watermark", "fixture-replay");
        return new("fixture-only-dag", "1",
            [new("fixture-step", "fixture-source", "fixture-target", [], "fixture-idempotency", false, resume, identities)]);
    }

    private sealed class FixtureRegistry(bool permitFixtureAtomicContract = false,
        bool changeIdentity = false) : IOfflineMigrationApplyOperationRegistry
    {
        internal int Resolutions
        {
            get; private set;
        }
        internal List<CurrentSchemaProviderKind> AtomicChecks { get; } = [];

        public OfflineMigrationApplyOperation Resolve(OfflineMigrationStep step, OfflineMigrationProviderOperation identity)
        {
            Resolutions++;
            return new FixtureOperation(changeIdentity ? identity with
            {
                OperationReference = "fixture-changed"
            } : identity,
                permitFixtureAtomicContract, AtomicChecks);
        }
    }

    private sealed class FixtureOperation(OfflineMigrationProviderOperation identity,
        bool permitFixtureAtomicContract, List<CurrentSchemaProviderKind> atomicChecks) : OfflineMigrationApplyOperation
    {
        internal override OfflineMigrationProviderOperation Identity => identity;

        internal override void RequireAtomicNativeExecution()
        {
            atomicChecks.Add(identity.Provider);
            if (!permitFixtureAtomicContract)
            {
                base.RequireAtomicNativeExecution();
            }
        }

        internal override Task<OfflineMigrationPredicateObservation> ObserveAsync(string predicateReference,
            DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
            => throw new NotSupportedException("fixture_native_observation_forbidden");

        internal override Task<OfflineMigrationApplyUnit> ExecuteAsync(OfflineMigrationStep step,
            OfflineMigrationApplyJournalEntry? previousUnit, DbConnection connection, DbTransaction transaction,
            CancellationToken cancellationToken)
            => throw new NotSupportedException("fixture_native_execution_forbidden");
    }
}
