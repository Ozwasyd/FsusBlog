using System.Collections.Immutable;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;
using FsusBlog.Server.Tests.TestInfrastructure;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests;

/// <summary>Refusal before any host or database access; no simulated approval issuer.</summary>
public sealed class AuthoringFencedLifecycleBoundaryTests
{
    [Fact]
    public async Task LegacyUpdate_WithRealFencedStore_RefusesBeforeRevocationOrReceiptPublication()
    {
        Fixture f = Create();
        VerifiedAuthoringPackage next = AuthoringStateProcessWorker.Package("2.0.0", 2);
        var plan = new AuthoringStateMigrationPlan("synthetic-plan", AuthoringStateProcessWorker.Scope(f.Package),
            AuthoringStateProcessWorker.Scope(next), 100, 1024, TimeSpan.FromSeconds(5),
            [new(AuthoringStateTransformKind.RenameKey, "old", "new", [])],
            "synthetic-backup", "synthetic-rollback", new string('d', 64));

        AuthoringExtensionContractException failure = await Assert.ThrowsAsync<AuthoringExtensionContractException>(() =>
            f.Coordinator.UpdateAsync(f.Package, next, Targets(next), plan).AsTask());

        Assert.Equal("fenced_lifecycle_migration_authority_unavailable", failure.Message);
        f.AssertUntouched();
    }

    [Fact]
    public async Task LegacyDeletion_WithCallerReceiptId_RefusesBeforeMeasurementOrDeletion()
    {
        Fixture f = Create(AuthoringLifecycleState.RetainedData);
        var approval = new AuthoringDeleteDataApproval(f.Package.Contract.Manifest.Id,
            f.Package.Contract.Manifest.PackageSha256, AuthoringStateProcessWorker.Scope(f.Package),
            1, 1, "caller-receipt-id-is-not-approval");

        AuthoringExtensionContractException failure = await Assert.ThrowsAsync<AuthoringExtensionContractException>(() =>
            f.Coordinator.DeleteOwnedDataAsync(f.Package, approval).AsTask());

        Assert.Equal("fenced_lifecycle_deletion_authority_unavailable", failure.Message);
        f.AssertUntouched();
    }

    [Theory]
    [InlineData(7)]
    [InlineData(8)]
    public async Task ReceiptOnlyResult_WithMatchingOrStaleGeneration_CannotProveFencedSettlement(long generation)
    {
        Fixture f = Create();

        AuthoringExtensionContractException failure = await Assert.ThrowsAsync<AuthoringExtensionContractException>(() =>
            f.Coordinator.AcceptResultAsync(f.Package.Contract.Manifest.Id, generation).AsTask());

        Assert.Equal("fenced_lifecycle_result_authority_unavailable", failure.Message);
        f.AssertUntouched();
    }

    private static Fixture Create(AuthoringLifecycleState state = AuthoringLifecycleState.Running)
    {
        VerifiedAuthoringPackage package = AuthoringStateProcessWorker.Package("1.0.0", 1);
        var db = Substitute.For<ISqlSugarClient>();
        var resources = Substitute.For<IAuthoringLifecycleResourceAuthority>();
        var preflight = Substitute.For<IAuthoringLifecyclePreflight>();
        var receipts = Substitute.For<IAuthoringLifecycleReceiptStore>();
        var grants = Substitute.For<IAuthoringCapabilityGrantCatalog>();
        var receipt = new AuthoringLifecycleReceipt(1, 7, package.Contract.Manifest.Id,
            package.Contract.Manifest.PackageSha256, package.Contract.Manifest.Version,
            package.Contract.Manifest.StateSchemaVersion, package.Contract.Manifest.DataSchemaVersion,
            AuthoringLifecycleState.Starting, state, 7, package.PackageIdentity, null,
            new string('0', 64), string.Empty);
        receipt = receipt with
        {
            ReceiptSha256 = AuthoringExtensionLifecycleCoordinator.ComputeReceiptSha256(receipt)
        };
        receipts.GetLatestAsync(package.Contract.Manifest.Id, Arg.Any<CancellationToken>()).Returns(receipt);
        preflight.VerifyAsync(package, Arg.Any<ImmutableArray<AuthoringExecutionTarget>>(), Arg.Any<CancellationToken>()).Returns(true);
        receipts.ClearReceivedCalls();
        preflight.ClearReceivedCalls();
        return new(package, new(resources, preflight, new PostgresAuthoringExtensionStateStore(db), receipts, grants),
            db, resources, preflight, receipts, grants);
    }

    private static ImmutableArray<AuthoringExecutionTarget> Targets(VerifiedAuthoringPackage package) =>
        [.. package.Contract.Manifest.Contributions.Select(contribution => new AuthoringExecutionTarget(
            AuthoringExecutionResolutionStatus.Ready, contribution.ExecutionClass, package.Contract.Manifest.Id,
            package.Contract.Manifest.Version, package.Contract.Manifest.PackageSha256, contribution.Id,
            contribution.Kind, contribution.Entrypoint.PathOrAdapterId, null, new string('e', 64), null))];

    private sealed record Fixture(
        VerifiedAuthoringPackage Package,
        AuthoringExtensionLifecycleCoordinator Coordinator,
        ISqlSugarClient Db,
        IAuthoringLifecycleResourceAuthority Resources,
        IAuthoringLifecyclePreflight Preflight,
        IAuthoringLifecycleReceiptStore Receipts,
        IAuthoringCapabilityGrantCatalog Grants)
    {
        internal void AssertUntouched()
        {
            Assert.Empty(Db.ReceivedCalls());
            Assert.Empty(Resources.ReceivedCalls());
            Assert.Empty(Preflight.ReceivedCalls());
            Assert.Empty(Receipts.ReceivedCalls());
            Assert.Empty(Grants.ReceivedCalls());
        }
    }
}
