using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.DataProtection;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

/// <summary>
/// Real persistence owners with explicitly simulated host admission and startup. These tests
/// qualify coordinator wiring, not production consent, authenticated users or native runtimes.
/// </summary>
[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class AuthoringFencedLifecycleCoordinatorTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task Update_HandsAppliedFencedSnapshotToStartupAndPersistsRunningBeforeCompletion()
    {
        using Scenario s = await CreateAsync();
        s.Resources.OnStartup = async snapshot =>
        {
            Assert.Equal(s.To, snapshot.Scope);
            Assert.Equal(s.Next.PackageIdentity, snapshot.PackageIdentity);
            Assert.Equal(2, snapshot.Revision);
            Assert.Equal("new", Assert.Single(snapshot.Entries).Key);
            Assert.Equal((byte)7, snapshot.Entries[0].Value[0]);
            Assert.Equal(1, await s.PhaseAsync());
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(() =>
                s.RealState.ReadAsync(s.Next, s.To, default).AsTask());
            Assert.Equal(AuthoringLifecycleState.Starting, (await s.LatestAsync())!.State);
        };
        s.State.BeforeComplete = async () =>
        {
            AuthoringLifecycleReceipt running = (await s.LatestAsync())!;
            Assert.Equal(AuthoringLifecycleState.Running, running.State);
            Assert.Equal(8, running.Sequence);
            Assert.Equal(running.Sequence, running.Generation);
            Assert.Equal(running.Generation, s.Resources.Generation);
            Assert.Equal(1, await s.PhaseAsync());
        };

        AuthoringLifecycleReceipt result = await s.UpdateAsync();

        Assert.Equal(result, await s.LatestAsync());
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() =>
            s.Coordinator.AcceptResultAsync(result.ExtensionId, result.Generation).AsTask());
        Assert.Equal(3, await s.PhaseAsync());
        Assert.Equal("new", Assert.Single((await s.RealState.ReadAsync(s.Next, s.To, default)).Entries).Key);
        Assert.Equal(1, s.State.Backups);
        Assert.Equal(1, s.State.Applies);
        Assert.Equal(1, s.State.Completions);
        Assert.Equal(0, s.State.Rollbacks);
        Assert.Equal(1, s.Resources.TypedActivations);
        Assert.Equal(1, s.Resources.LegacyActivations);
        Assert.Equal(0, s.State.LegacyCalls);
        await s.AssertGrantRemainsRevokedAsync();
        using SqlSugarClient reopened = PostgresSqlSugarTestClient.Create(s.ConnectionString);
        var restarted = new AuthoringExtensionLifecycleCoordinator(s.Resources, s.Admission,
            new PostgresAuthoringExtensionStateStore(reopened), new PostgresAuthoringLifecycleReceiptStore(reopened), s.Grants);
        Assert.Equal(result, await restarted.RestoreFromReceiptAsync(s.Old.Contract.Manifest.Id));
        Assert.Equal(1, s.Resources.TypedActivations);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Update_MissingOriginalHostPortsRefusesBeforeDurableOrRuntimeChanges(bool missingAdmission)
    {
        using Scenario s = await CreateAsync();
        AuthoringLifecycleReceipt before = (await s.LatestAsync())!;
        var coordinator = new AuthoringExtensionLifecycleCoordinator(
            missingAdmission ? s.Resources : Substitute.For<IAuthoringLifecycleResourceAuthority>(),
            missingAdmission ? Substitute.For<IAuthoringLifecyclePreflight>() : s.Admission,
            s.State, s.Receipts, s.Grants);

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => coordinator.UpdateAsync(
            s.Old, s.Next, s.Targets, s.Plan).AsTask());

        Assert.Equal(before, await s.LatestAsync());
        Assert.Equal(0, s.State.Backups);
        Assert.Equal(0, s.Resources.TypedActivations);
        Assert.NotNull(await s.Grants.FindAsync(s.Grant.GrantId, default));
    }

    [Fact]
    public async Task LegacyArguments_CannotConvertHashCountsOrReceiptIdIntoFencedAuthority()
    {
        using Scenario s = await CreateAsync();
        AuthoringLifecycleReceipt before = (await s.LatestAsync())!;
        var legacyPlan = new AuthoringStateMigrationPlan(s.Plan.PlanId, s.From, s.To, 100, 1024,
            TimeSpan.FromSeconds(10), s.Plan.Transforms, s.Plan.BackupReference, s.Plan.RollbackReference, s.Plan.ContentSha256);
        var deletion = new AuthoringDeleteDataApproval(s.Old.Contract.Manifest.Id,
            s.Old.Contract.Manifest.PackageSha256, s.From, 1, 1, "caller-only-id");

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() =>
            s.Coordinator.UpdateAsync(s.Old, s.Next, s.Targets, legacyPlan).AsTask());
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() =>
            s.Coordinator.DeleteOwnedDataAsync(s.Old, deletion).AsTask());

        Assert.Equal(before, await s.LatestAsync());
        Assert.Equal(0, s.State.LegacyCalls);
        Assert.Equal(0, s.State.Backups);
        Assert.Equal(0, s.State.Deletions);
    }

    [Fact]
    public async Task Update_MissingActualDecisionRefusesWithoutTreatingPlanDigestAsApproval()
    {
        using Scenario s = await CreateAsync();
        s.Admission.DecisionCurrent = false;
        AuthoringLifecycleReceipt before = (await s.LatestAsync())!;

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => s.UpdateAsync().AsTask());

        Assert.Equal(before, await s.LatestAsync());
        Assert.Equal(0, s.State.Backups);
        Assert.NotNull(await s.Grants.FindAsync(s.Grant.GrantId, default));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RunningAppendFailure_ResolvesRealDurableHeadBeforeSelectingRollback(bool persisted)
    {
        using Scenario s = await CreateAsync();
        s.Receipts.FailRunning = persisted ? "after" : "before";

        Exception error = await Assert.ThrowsAsync<IOException>(() => s.UpdateAsync().AsTask());

        Assert.Same(s.Receipts.Failure, error);
        Assert.Equal(persisted ? 1 : 2, await s.PhaseAsync());
        Assert.Equal(persisted ? 0 : 1, s.State.Rollbacks);
        Assert.Equal(0, s.State.Completions);
        Assert.Equal(persisted ? AuthoringLifecycleState.Failed : AuthoringLifecycleState.RollbackRequired,
            (await s.LatestAsync())!.State);
        Assert.False(s.Resources.Active);
        Assert.Equal(1, s.Resources.LegacyActivations);
        await s.AssertGrantRemainsRevokedAsync();
        if (!persisted)
        {
            Assert.Equal("old", Assert.Single((await s.RealState.ReadAsync(s.Old, s.From, default)).Entries).Key);
            Assert.Empty((await s.RealState.ReadAsync(s.Next, s.To, default)).Entries);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CompleteFailure_NeverRollsBackUnderAcceptedRunningOrResurrectsGrants(bool committed)
    {
        using Scenario s = await CreateAsync();
        s.State.FailComplete = committed ? "after" : "before";

        Exception error = await Assert.ThrowsAsync<IOException>(() => s.UpdateAsync().AsTask());

        Assert.Same(s.State.Failure, error);
        Assert.Equal(committed ? 3 : 1, await s.PhaseAsync());
        Assert.Equal(0, s.State.Rollbacks);
        Assert.Equal(AuthoringLifecycleState.Failed, (await s.LatestAsync())!.State);
        Assert.False(s.Resources.Active);
        await s.AssertGrantRemainsRevokedAsync();
        if (!committed)
        {
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(() =>
                s.RealState.ReadAsync(s.Next, s.To, default).AsTask());
        }
        using SqlSugarClient reopened = PostgresSqlSugarTestClient.Create(s.ConnectionString);
        var restarted = new AuthoringExtensionLifecycleCoordinator(s.Resources, s.Admission,
            new PostgresAuthoringExtensionStateStore(reopened), new PostgresAuthoringLifecycleReceiptStore(reopened), s.Grants);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() =>
            restarted.UpdateAsync(s.Old, s.Next, s.Targets, s.Plan).AsTask());
        Assert.Equal(committed ? 3 : 1, await s.PhaseAsync());
        Assert.Equal(1, s.Resources.TypedActivations);
        Assert.Equal(AuthoringLifecycleState.Failed,
            (await restarted.RestoreFromReceiptAsync(s.Old.Contract.Manifest.Id))!.State);
    }

    [Fact]
    public async Task UnknownHeadAfterRunningAppend_PreservesFenceAndOriginalFailure()
    {
        using Scenario s = await CreateAsync();
        s.Receipts.FailRunning = "unobservable";

        Exception error = await Assert.ThrowsAsync<IOException>(() => s.UpdateAsync().AsTask());

        Assert.Same(s.Receipts.Failure, error);
        Assert.Equal(1, await s.PhaseAsync());
        Assert.Equal(0, s.State.Rollbacks);
        Assert.Equal(0, s.State.Completions);
        Assert.Equal(AuthoringLifecycleState.Running, (await s.RealReceipts.GetLatestAsync(s.Old.Contract.Manifest.Id, default))!.State);
        Assert.False(s.Resources.Active);
        await s.AssertGrantRemainsRevokedAsync();
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task FailedContainmentOrRollback_PreservesAppliedFenceAndFirstFailure(bool containment)
    {
        using Scenario s = await CreateAsync();
        var primary = new IOException("synthetic-startup-failure");
        s.Resources.OnStartup = _ =>
        {
            s.Resources.RefuseCleanup = containment;
            throw primary;
        };
        s.State.FailRollback = !containment;

        Exception error = await Assert.ThrowsAsync<IOException>(() => s.UpdateAsync().AsTask());

        Assert.Same(primary, error);
        Assert.Equal(1, await s.PhaseAsync());
        Assert.Equal(containment ? 0 : 1, s.State.Rollbacks);
        Assert.Equal(AuthoringLifecycleState.RollbackRequired, (await s.LatestAsync())!.State);
        Assert.Equal(1, s.Resources.LegacyActivations);
        await s.AssertGrantRemainsRevokedAsync();
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RevokedAdmission_DoesNotRestoreOldRuntimeOrCapability(bool afterRunning)
    {
        using Scenario s = await CreateAsync();
        if (afterRunning)
        {
            s.Receipts.AfterRunning = () => s.Admission.DecisionCurrent = false;
        }
        else
        {
            s.State.AfterApply = () => s.Admission.DecisionCurrent = false;
        }

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => s.UpdateAsync().AsTask());

        Assert.Equal(afterRunning ? 1 : 2, await s.PhaseAsync());
        Assert.Equal(afterRunning ? AuthoringLifecycleState.Failed : AuthoringLifecycleState.RollbackRequired,
            (await s.LatestAsync())!.State);
        Assert.False(s.Resources.Active);
        Assert.Equal(1, s.Resources.LegacyActivations);
        await s.AssertGrantRemainsRevokedAsync();
    }

    [Theory]
    [InlineData("digest")]
    [InlineData("source-revision")]
    [InlineData("target-revision")]
    public async Task ExactPlanDigestAndRevisions_AreNotReplacedByLegacyCoordinates(string drift)
    {
        using Scenario s = await CreateAsync();
        if (drift == "digest")
        {
            s.UsePlan(s.Plan with
            {
                ContentSha256 = new string('0', 64)
            });
        }
        else if (drift == "source-revision")
        {
            await s.RealState.WriteAsync(s.Old, s.From, 1, new("old", [8]), default);
        }
        else
        {
            await s.RealState.WriteAsync(s.Next, s.To, 0, new("existing", [9]), default);
        }

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => s.UpdateAsync().AsTask());

        Assert.Equal(0, s.State.Applies);
        Assert.Equal(0, s.State.Completions);
        Assert.Equal(0, s.Resources.TypedActivations);
        Assert.Equal(0, s.State.LegacyCalls);
    }

    [Fact]
    public async Task MutableCallerDefaults_AreFrozenBeforeTheFirstHostAwait()
    {
        using Scenario s = await CreateAsync();
        byte[] callerBytes = [8];
        ImmutableArray<byte> alias = System.Runtime.InteropServices.ImmutableCollectionsMarshal.AsImmutableArray(callerBytes);
        AuthoringFencedStateMigration plan = s.Plan with
        {
            Transforms = [new(AuthoringStateTransformKind.SetDefault, "added", null, alias)]
        };
        s.UsePlan(plan with
        {
            ContentSha256 = AuthoringExtensionStateContract.ComputeContentSha256(plan)
        });
        s.Admission.AfterAcquire = () => callerBytes[0] = 99;

        await s.UpdateAsync();

        AuthoringStateSnapshot result = await s.RealState.ReadAsync(s.Next, s.To, default);
        Assert.Equal((byte)8, Assert.Single(result.Entries, entry => entry.Key == "added").Value[0]);
        Assert.Equal((byte)8, Assert.Single(s.Resources.Applied!.Entries, entry => entry.Key == "added").Value[0]);
    }

    [Fact]
    public async Task CancellationAfterApply_RollsBackWithCleanupTokenAndKeepsGrantsRevoked()
    {
        using Scenario s = await CreateAsync();
        using var caller = new CancellationTokenSource();
        s.State.AfterApply = caller.Cancel;

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => s.UpdateAsync(caller.Token).AsTask());

        Assert.Equal(2, await s.PhaseAsync());
        Assert.Equal(1, s.State.Rollbacks);
        Assert.False(s.State.RollbackTokenCancelled);
        Assert.False(s.Resources.Active);
        await s.AssertGrantRemainsRevokedAsync();
    }

    [Fact]
    public async Task Delete_UsesExactMeasurementAndPurgesOnlyItsOwnRetainedBackups()
    {
        using Scenario s = await CreateAsync();
        await s.RealState.BackupAsync(s.Old, s.Next, s.Plan, default);
        await s.RealState.ApplyAsync(s.Old, s.Next, s.Plan, default);
        await s.RealState.RollbackAsync(s.Old, s.Next, s.Plan, default);
        AuthoringStateScope other = s.From with
        {
            DocumentId = "synthetic-other-document"
        };
        await s.RealState.InitializeAsync(s.Old, other, default);
        await s.RealState.WriteAsync(s.Old, other, 0, new("other", [10]), default);
        await s.RetainAsync();
        AuthoringFencedStateDeletion approval = await s.ApproveDeletionForTestAsync();
        Assert.Equal(2, approval.Expected.Records);

        await s.Coordinator.DeleteOwnedDataAsync(s.Old, approval);

        Assert.Empty((await s.RealState.ReadAsync(s.Old, s.From, default)).Entries);
        Assert.Equal(0, (await s.RealState.MeasureAsync(s.Old, s.From, default)).Records);
        Assert.Single((await s.RealState.ReadAsync(s.Old, other, default)).Entries);
        Assert.Equal(AuthoringLifecycleState.Removed, (await s.LatestAsync())!.State);
        Assert.Equal(1, s.State.Deletions);
        Assert.Equal(0, s.State.LegacyCalls);
        await s.AssertGrantRemainsRevokedAsync();
    }

    [Fact]
    public async Task Delete_MissingOriginalAdmissionPortCannotAcceptCallerId()
    {
        using Scenario s = await CreateAsync();
        await s.RetainAsync();
        var caller = new AuthoringFencedStateDeletion(await s.RealState.MeasureAsync(s.Old, s.From, default), "caller-only-id");
        var coordinator = new AuthoringExtensionLifecycleCoordinator(s.Resources,
            Substitute.For<IAuthoringLifecyclePreflight>(), s.State, s.Receipts, s.Grants);

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() =>
            coordinator.DeleteOwnedDataAsync(s.Old, caller).AsTask());

        Assert.Single((await s.RealState.ReadAsync(s.Old, s.From, default)).Entries);
        Assert.Equal(AuthoringLifecycleState.RetainedData, (await s.LatestAsync())!.State);
        Assert.Equal(0, s.State.Deletions);
    }

    [Fact]
    public async Task Delete_CallerReceiptIdWithoutOriginalDecisionCannotAuthorizeIt()
    {
        using Scenario s = await CreateAsync();
        await s.RetainAsync();
        var caller = new AuthoringFencedStateDeletion(await s.RealState.MeasureAsync(s.Old, s.From, default), "caller-only-id");

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() =>
            s.Coordinator.DeleteOwnedDataAsync(s.Old, caller).AsTask());

        Assert.Single((await s.RealState.ReadAsync(s.Old, s.From, default)).Entries);
        Assert.Equal(AuthoringLifecycleState.RetainedData, (await s.LatestAsync())!.State);
        Assert.Equal(0, s.State.Deletions);
    }

    [Fact]
    public async Task Delete_SameCountsWithChangedContentOrRevisionDoesNotMatchApproval()
    {
        using Scenario s = await CreateAsync();
        await s.RetainAsync();
        AuthoringFencedStateDeletion approval = await s.ApproveDeletionForTestAsync();
        await s.RealState.WriteAsync(s.Old, s.From, approval.Expected.Revision, new("old", [8]), default);
        AuthoringStateMeasurement changed = await s.RealState.MeasureAsync(s.Old, s.From, default);
        Assert.Equal(approval.Expected.Records, changed.Records);
        Assert.Equal(approval.Expected.Bytes, changed.Bytes);

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() =>
            s.Coordinator.DeleteOwnedDataAsync(s.Old, approval).AsTask());

        Assert.Equal(0, s.State.Deletions);
        Assert.Equal(AuthoringLifecycleState.RetainedData, (await s.LatestAsync())!.State);
    }

    [Fact]
    public async Task Delete_RemovedAppendFailureDoesNotResurrectPurgedDataOrClaimSuccess()
    {
        using Scenario s = await CreateAsync();
        await s.RetainAsync();
        AuthoringFencedStateDeletion approval = await s.ApproveDeletionForTestAsync();
        s.Receipts.FailRemoved = true;

        await Assert.ThrowsAsync<IOException>(() => s.Coordinator.DeleteOwnedDataAsync(s.Old, approval).AsTask());

        Assert.Empty((await s.RealState.ReadAsync(s.Old, s.From, default)).Entries);
        Assert.Equal(AuthoringLifecycleState.RetainedData, (await s.LatestAsync())!.State);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() =>
            s.Coordinator.DeleteOwnedDataAsync(s.Old, approval).AsTask());
        Assert.Equal(1, s.State.Deletions);
        await s.AssertGrantRemainsRevokedAsync();
    }

    private async Task<Scenario> CreateAsync()
    {
        string connection = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        var s = new Scenario(connection);
        await s.Db.Ado.ExecuteCommandAsync(AuthoringExtensionStateStorageSchema.CreateTablesSql);
        // This is the unchanged receipt leaf's test-only table contract, never runtime DDL.
        await s.Db.Ado.ExecuteCommandAsync("""
            CREATE TABLE authoring_lifecycle_receipt (
                schema_version INTEGER NOT NULL, sequence BIGINT NOT NULL,
                extension_id VARCHAR(256) COLLATE "C" NOT NULL, package_sha256 VARCHAR(64) NOT NULL,
                version VARCHAR(256) NOT NULL, state_schema_version INTEGER NOT NULL,
                data_schema_version INTEGER NOT NULL, previous_state INTEGER NOT NULL,
                state INTEGER NOT NULL, generation BIGINT NOT NULL, scope_digest VARCHAR(64) NOT NULL,
                failure_code VARCHAR(128), previous_receipt_sha256 VARCHAR(64) NOT NULL,
                receipt_sha256 VARCHAR(64) NOT NULL, PRIMARY KEY (extension_id, sequence)
            );
            """);
        await s.RealState.InitializeAsync(s.Old, s.From, default);
        await s.RealState.InitializeAsync(s.Next, s.To, default);
        await s.RealState.WriteAsync(s.Old, s.From, 0, new("old", [7]), default);
        s.UsePlan(AuthoringStateProcessWorker.Plan(await s.RealState.ReadAsync(s.Old, s.From, default), s.To));
        await s.Grants.StoreAsync(s.Grant, default);
        await s.Coordinator.EnableAsync(s.Old, Scenario.TargetsFor(s.Old));
        return s;
    }

    private sealed class Scenario : IDisposable
    {
        internal string ConnectionString
        {
            get; set;
        }
        internal SqlSugarClient Db
        {
            get; set;
        }
        internal VerifiedAuthoringPackage Old { get; set; } = AuthoringStateProcessWorker.Package("1.0.0", 1);
        internal VerifiedAuthoringPackage Next { get; set; } = AuthoringStateProcessWorker.Package("2.0.0", 2);
        internal AuthoringStateScope From => AuthoringStateProcessWorker.Scope(Old);
        internal AuthoringStateScope To => AuthoringStateProcessWorker.Scope(Next);
        internal ImmutableArray<AuthoringExecutionTarget> Targets => TargetsFor(Next);
        internal PostgresAuthoringExtensionStateStore RealState
        {
            get; set;
        }
        internal PostgresAuthoringLifecycleReceiptStore RealReceipts
        {
            get; set;
        }
        internal LocalAuthoringCapabilityGrantStore Grants
        {
            get; set;
        }
        internal TrackingState State
        {
            get; set;
        }
        internal TrackingReceipts Receipts
        {
            get; set;
        }
        internal HostResources Resources { get; set; } = new();
        internal SimulatedAdmission Admission
        {
            get; set;
        }
        internal AuthoringExtensionLifecycleCoordinator Coordinator
        {
            get; set;
        }
        internal AuthoringCapabilityGrant Grant
        {
            get; set;
        }
        internal AuthoringFencedStateMigration Plan { get; set; } = null!;
        private readonly string _grantRoot = Path.Combine(Path.GetTempPath(), "fenced-lifecycle-" + Guid.NewGuid().ToString("N"));

        internal Scenario(string connection)
        {
            ConnectionString = connection;
            Db = PostgresSqlSugarTestClient.Create(connection);
            RealState = new(Db);
            RealReceipts = new(Db);
            State = new(RealState);
            Receipts = new(RealReceipts);
            Admission = new(this);
            Grants = new(_grantRoot, new EphemeralDataProtectionProvider(), TimeProvider.System);
            Coordinator = new(Resources, Admission, State, Receipts, Grants);
            AuthoringExecutionTarget target = TargetsFor(Old)[0];
            DateTimeOffset now = DateTimeOffset.UtcNow;
            var grant = new AuthoringCapabilityGrant(string.Empty, target.RuntimeIdentity,
                target.ExtensionId, target.ExtensionVersion, target.ContributionId, target.ExecutionClass,
                AuthoringCapability.DocumentRangeRead, "synthetic-document", "synthetic-site", "synthetic-test",
                null, null, now.AddMinutes(-1), now.AddMinutes(10), "synthetic-existing-decision", "synthetic-request", string.Empty);
            string digest = AuthoringCapabilityGrantAuthority.ComputeGrantDigest(grant);
            Grant = grant with
            {
                GrantId = digest,
                GrantDigest = digest
            };
        }

        internal void UsePlan(AuthoringFencedStateMigration plan)
        {
            Plan = plan;
            Admission.ExpectedPlan = AuthoringExtensionStateContract.Encode(plan);
        }

        internal ValueTask<AuthoringLifecycleReceipt> UpdateAsync(CancellationToken token = default) =>
            Coordinator.UpdateAsync(Old, Next, Targets, Plan, token);
        internal ValueTask<AuthoringLifecycleReceipt?> LatestAsync() => RealReceipts.GetLatestAsync(Old.Contract.Manifest.Id, default);
        internal async Task<int> PhaseAsync() => await Db.Ado.GetIntAsync("SELECT phase FROM authoring_extension_state_migration;");
        internal ValueTask<AuthoringLifecycleReceipt> RetainAsync() => Coordinator.UninstallAsync(Old, From);
        internal async ValueTask<AuthoringFencedStateDeletion> ApproveDeletionForTestAsync()
        {
            var approval = new AuthoringFencedStateDeletion(await RealState.MeasureAsync(Old, From, default), "synthetic-separate-decision");
            Admission.Deletion = approval;
            return approval;
        }
        internal async Task AssertGrantRemainsRevokedAsync()
        {
            Assert.Null(await Grants.FindAsync(Grant.GrantId, default));
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => Grants.StoreAsync(Grant, default).AsTask());
        }
        internal static ImmutableArray<AuthoringExecutionTarget> TargetsFor(VerifiedAuthoringPackage package) =>
            [.. package.Contract.Manifest.Contributions.Select(contribution => new AuthoringExecutionTarget(
                AuthoringExecutionResolutionStatus.Ready, contribution.ExecutionClass, package.Contract.Manifest.Id,
                package.Contract.Manifest.Version, package.Contract.Manifest.PackageSha256, contribution.Id,
                contribution.Kind, contribution.Entrypoint.PathOrAdapterId, null,
                Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes("synthetic-runtime:" + package.PackageIdentity + contribution.Id))), null))];
        public void Dispose()
        {
            Db.Dispose();
            if (Directory.Exists(_grantRoot))
            {
                Directory.Delete(_grantRoot, recursive: true);
            }
        }
    }

    private sealed class SimulatedAdmission(Scenario scenario) : IAuthoringFencedLifecyclePreflight
    {
        internal byte[] ExpectedPlan { get; set; } = [];
        internal bool DecisionCurrent { get; set; } = true;
        internal AuthoringFencedStateDeletion? Deletion
        {
            get; set;
        }
        internal Action? AfterAcquire
        {
            get; set;
        }
        private bool _held;
        public ValueTask<IAuthoringFencedLifecycleAdmissionScope> AcquireMigrationAsync(VerifiedAuthoringPackage oldPackage,
            VerifiedAuthoringPackage newPackage, ImmutableArray<AuthoringExecutionTarget> targets,
            AuthoringFencedStateMigration plan, AuthoringLifecycleReceipt previous, CancellationToken cancellationToken)
        {
            if (!AuthoringExtensionStateContract.Encode(plan).AsSpan().SequenceEqual(ExpectedPlan) ||
                oldPackage != scenario.Old || newPackage != scenario.Next || !targets.SequenceEqual(scenario.Targets))
            {
                throw new AuthoringExtensionContractException("synthetic-exact-inputs-required");
            }
            return Acquire(cancellationToken);
        }
        public ValueTask<IAuthoringFencedLifecycleAdmissionScope> AcquireDeletionAsync(VerifiedAuthoringPackage package,
            AuthoringFencedStateDeletion approval, AuthoringLifecycleReceipt previous, CancellationToken cancellationToken)
        {
            if (package != scenario.Old || approval != Deletion)
            {
                throw new AuthoringExtensionContractException("synthetic-original-decision-missing");
            }
            return Acquire(cancellationToken);
        }
        private ValueTask<IAuthoringFencedLifecycleAdmissionScope> Acquire(CancellationToken token)
        {
            token.ThrowIfCancellationRequested();
            if (_held || !DecisionCurrent)
            {
                throw new AuthoringExtensionContractException("synthetic-admission-denied");
            }
            _held = true;
            AfterAcquire?.Invoke();
            return ValueTask.FromResult<IAuthoringFencedLifecycleAdmissionScope>(new Scope(this));
        }
        public ValueTask<bool> VerifyAsync(VerifiedAuthoringPackage package, ImmutableArray<AuthoringExecutionTarget> targets, CancellationToken token) => ValueTask.FromResult(DecisionCurrent);
        public ValueTask<bool> HasRequiredPermissionsAsync(VerifiedAuthoringPackage package, ImmutableArray<AuthoringExecutionTarget> targets, CancellationToken token) => ValueTask.FromResult(DecisionCurrent);
        private sealed class Scope(SimulatedAdmission owner) : IAuthoringFencedLifecycleAdmissionScope
        {
            public ValueTask VerifyCurrentAsync(CancellationToken cancellationToken)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (!owner._held || !owner.DecisionCurrent)
                {
                    throw new AuthoringExtensionContractException("synthetic-admission-revoked");
                }
                return ValueTask.CompletedTask;
            }
            public void Dispose() => owner._held = false;
        }
    }

    private sealed class HostResources : IAuthoringFencedLifecycleResourceAuthority
    {
        internal bool Active
        {
            get; set;
        }
        internal long Generation
        {
            get; set;
        }
        internal int LegacyActivations
        {
            get; set;
        }
        internal int TypedActivations
        {
            get; set;
        }
        internal bool RefuseCleanup
        {
            get; set;
        }
        internal AuthoringStateSnapshot? Applied
        {
            get; set;
        }
        internal Func<AuthoringStateSnapshot, Task>? OnStartup
        {
            get; set;
        }
        public ValueTask ActivateAtomicallyAsync(VerifiedAuthoringPackage package, ImmutableArray<AuthoringExecutionTarget> targets, long generation, CancellationToken token)
        {
            LegacyActivations++;
            Active = true;
            Generation = generation;
            return ValueTask.CompletedTask;
        }
        public async ValueTask ActivateAtomicallyAsync(VerifiedAuthoringPackage package, ImmutableArray<AuthoringExecutionTarget> targets,
            AuthoringStateSnapshot snapshot, long generation, CancellationToken token)
        {
            TypedActivations++;
            Applied = snapshot;
            Active = true;
            Generation = generation;
            if (OnStartup is not null)
            {
                await OnStartup(snapshot);
            }
        }
        public ValueTask<AuthoringLifecycleResourceReport> RevokeAllAsync(string extensionId, long generation, CancellationToken token)
        {
            if (!RefuseCleanup)
            {
                Active = false;
            }
            return ValueTask.FromResult(new AuthoringLifecycleResourceReport(0, RefuseCleanup ? 1 : 0, 0, 0, 0, 0, 0));
        }
        public ValueTask<bool> RebindGenerationAsync(string extensionId, long expected, long replacement, CancellationToken token)
        {
            if (!Active || Generation != expected)
            {
                return ValueTask.FromResult(false);
            }
            Generation = replacement;
            return ValueTask.FromResult(true);
        }
    }

    private sealed class TrackingReceipts(IAuthoringLifecycleReceiptStore inner) : IAuthoringLifecycleReceiptStore
    {
        internal IOException Failure { get; set; } = new("synthetic-running-receipt-failure");
        internal string? FailRunning
        {
            get; set;
        }
        internal bool FailRemoved
        {
            get; set;
        }
        internal Action? AfterRunning
        {
            get; set;
        }
        private bool _unobservable;
        public ValueTask<AuthoringLifecycleReceipt?> GetLatestAsync(string extensionId, CancellationToken token)
        {
            if (_unobservable)
            {
                throw new IOException("synthetic-head-unobservable");
            }
            return inner.GetLatestAsync(extensionId, token);
        }
        public async ValueTask AppendAsync(AuthoringLifecycleReceipt receipt, CancellationToken token)
        {
            if (receipt.State == AuthoringLifecycleState.Removed && FailRemoved)
            {
                throw Failure;
            }
            if (receipt.State == AuthoringLifecycleState.Running && receipt.Version == "2.0.0" && FailRunning == "before")
            {
                throw Failure;
            }
            await inner.AppendAsync(receipt, token);
            if (receipt.State == AuthoringLifecycleState.Running && receipt.Version == "2.0.0")
            {
                AfterRunning?.Invoke();
                if (FailRunning is not null)
                {
                    _unobservable = FailRunning == "unobservable";
                    throw Failure;
                }
            }
        }
    }

    private sealed class TrackingState(IAuthoringFencedExtensionStateStore inner) : IAuthoringFencedExtensionStateStore
    {
        internal IOException Failure { get; set; } = new("synthetic-state-settlement-failure");
        internal int Backups
        {
            get; set;
        }
        internal int Applies
        {
            get; set;
        }
        internal int Rollbacks
        {
            get; set;
        }
        internal int Completions
        {
            get; set;
        }
        internal int Deletions
        {
            get; set;
        }
        internal int LegacyCalls
        {
            get; set;
        }
        internal bool RollbackTokenCancelled
        {
            get; set;
        }
        internal string? FailComplete
        {
            get; set;
        }
        internal bool FailRollback
        {
            get; set;
        }
        internal Action? AfterApply
        {
            get; set;
        }
        internal Func<Task>? BeforeComplete
        {
            get; set;
        }
        public async ValueTask BackupAsync(VerifiedAuthoringPackage oldPackage, VerifiedAuthoringPackage newPackage, AuthoringFencedStateMigration plan, CancellationToken token)
        {
            Backups++;
            await inner.BackupAsync(oldPackage, newPackage, plan, token);
        }
        public async ValueTask<AuthoringStateSnapshot> ApplyAsync(VerifiedAuthoringPackage oldPackage, VerifiedAuthoringPackage newPackage, AuthoringFencedStateMigration plan, CancellationToken token)
        {
            Applies++;
            AuthoringStateSnapshot snapshot = await inner.ApplyAsync(oldPackage, newPackage, plan, token);
            AfterApply?.Invoke();
            return snapshot;
        }
        public async ValueTask RollbackAsync(VerifiedAuthoringPackage oldPackage, VerifiedAuthoringPackage newPackage, AuthoringFencedStateMigration plan, CancellationToken token)
        {
            Rollbacks++;
            RollbackTokenCancelled = token.IsCancellationRequested;
            if (FailRollback)
            {
                throw Failure;
            }
            await inner.RollbackAsync(oldPackage, newPackage, plan, token);
        }
        public async ValueTask CompleteAsync(VerifiedAuthoringPackage oldPackage, VerifiedAuthoringPackage newPackage, AuthoringFencedStateMigration plan, CancellationToken token)
        {
            Completions++;
            if (BeforeComplete is not null)
            {
                await BeforeComplete();
            }
            if (FailComplete == "before")
            {
                throw Failure;
            }
            await inner.CompleteAsync(oldPackage, newPackage, plan, token);
            if (FailComplete == "after")
            {
                throw Failure;
            }
        }
        public ValueTask InitializeAsync(VerifiedAuthoringPackage package, AuthoringStateScope scope, CancellationToken token) => inner.InitializeAsync(package, scope, token);
        public ValueTask<AuthoringStateSnapshot> ReadAsync(VerifiedAuthoringPackage package, AuthoringStateScope scope, CancellationToken token) => inner.ReadAsync(package, scope, token);
        public ValueTask WriteAsync(VerifiedAuthoringPackage package, AuthoringStateScope scope, long revision, AuthoringStateEntry entry, CancellationToken token) => inner.WriteAsync(package, scope, revision, entry, token);
        public ValueTask<AuthoringStateMeasurement> MeasureAsync(VerifiedAuthoringPackage package, AuthoringStateScope scope, CancellationToken token) => inner.MeasureAsync(package, scope, token);
        public ValueTask DeleteAsync(VerifiedAuthoringPackage package, AuthoringFencedStateDeletion approval, CancellationToken token)
        {
            Deletions++;
            return inner.DeleteAsync(package, approval, token);
        }
        public ValueTask BackupAsync(AuthoringStateMigrationPlan plan, CancellationToken token) => Legacy();
        public ValueTask ApplyAsync(AuthoringStateMigrationPlan plan, CancellationToken token) => Legacy();
        public ValueTask RollbackAsync(AuthoringStateMigrationPlan plan, CancellationToken token) => Legacy();
        public ValueTask<(long Records, long Bytes)> MeasureAsync(AuthoringStateScope scope, CancellationToken token)
        {
            LegacyCalls++;
            throw new InvalidOperationException("legacy-method-must-not-run");
        }
        public ValueTask DeleteAsync(AuthoringStateScope scope, CancellationToken token) => Legacy();
        private ValueTask Legacy()
        {
            LegacyCalls++;
            throw new InvalidOperationException("legacy-method-must-not-run");
        }
    }
}
