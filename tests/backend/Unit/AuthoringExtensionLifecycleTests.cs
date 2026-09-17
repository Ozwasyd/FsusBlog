using System.Collections.Immutable;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;

namespace FsusBlog.Server.Tests;

public sealed class AuthoringExtensionLifecycleTests
{
    [Fact]
    public async Task EnableAsync_CompletePreflight_ActivatesAllContributionsAtomically()
    {
        LifecycleFixture fixture = CreateFixture();

        AuthoringLifecycleReceipt receipt = await fixture.Coordinator.EnableAsync(
            fixture.Package,
            fixture.Targets);

        Assert.Equal(AuthoringLifecycleState.Running, receipt.State);
        Assert.Equal(1, fixture.Resources.ActivationCount);
        Assert.Equal(fixture.Targets.Length, fixture.Resources.LastTargetCount);
    }

    [Fact]
    public async Task EnableAsync_PartialTargetSet_FailsBeforeRegistration()
    {
        LifecycleFixture fixture = CreateFixture();

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Coordinator.EnableAsync(fixture.Package, []));

        Assert.Equal(0, fixture.Resources.ActivationCount);
    }

    [Fact]
    public async Task DisableAsync_RemainingRuntimeGrantJobOrSurface_FailsClosed()
    {
        var resources = new ResourceAuthority
        {
            RevokeReport = new AuthoringLifecycleResourceReport(0, 1, 0, 0, 1, 1, 1)
        };
        LifecycleFixture fixture = CreateFixture(resources: resources);

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Coordinator.DisableAsync(fixture.Package));
    }

    [Fact]
    public async Task DisableAsync_RevokesEverythingAndInvalidatesLateGeneration()
    {
        LifecycleFixture fixture = CreateFixture();
        AuthoringLifecycleReceipt enabled = await fixture.Coordinator.EnableAsync(fixture.Package, fixture.Targets);
        AuthoringLifecycleReceipt disabled = await fixture.Coordinator.DisableAsync(fixture.Package);

        Assert.Equal(AuthoringLifecycleState.Disabled, disabled.State);
        Assert.False(await fixture.Coordinator.AcceptResultAsync(fixture.Package.Contract.Manifest.Id, enabled.Generation));
        Assert.True(fixture.Resources.RevocationCount > 0);
    }

    [Fact]
    public async Task UpdateAsync_MigrationFailure_RollsBackStateAndOldPackage()
    {
        var state = new StateStore { FailMigration = true };
        LifecycleFixture fixture = CreateFixture(stateStore: state);
        await fixture.Coordinator.EnableAsync(fixture.Package, fixture.Targets);
        VerifiedAuthoringPackage next = CreatePackage("2.0.0", stateSchemaVersion: 2);
        ImmutableArray<AuthoringExecutionTarget> nextTargets = CreateTargets(next);
        AuthoringStateMigrationPlan plan = CreatePlan(fixture.Package, next);

        await Assert.ThrowsAsync<InvalidOperationException>(async () =>
            await fixture.Coordinator.UpdateAsync(fixture.Package, next, nextTargets, plan));

        Assert.True(state.BackupCalled);
        Assert.True(state.RollbackCalled);
        Assert.Equal(fixture.Package, fixture.Resources.LastActivatedPackage);
        Assert.Contains(
            fixture.Receipts.All,
            receipt => receipt.State == AuthoringLifecycleState.RollbackRequired);
        Assert.Equal(AuthoringLifecycleState.Running, fixture.Receipts.Latest?.State);
    }

    [Fact]
    public async Task UpdateAsync_CrossPluginOrUnboundedMigration_FailsBeforeBackup()
    {
        LifecycleFixture fixture = CreateFixture();
        VerifiedAuthoringPackage next = CreatePackage("2.0.0", stateSchemaVersion: 2);
        AuthoringStateMigrationPlan plan = CreatePlan(fixture.Package, next) with
        {
            To = CreatePlan(fixture.Package, next).To with
            {
                ExtensionId = "other.plugin"
            }
        };

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Coordinator.UpdateAsync(fixture.Package, next, CreateTargets(next), plan));

        Assert.False(fixture.State.BackupCalled);
    }

    [Fact]
    public async Task UninstallAsync_RetainsDataAndRevokesAuthority()
    {
        LifecycleFixture fixture = CreateFixture();
        AuthoringStateScope scope = CreateScope(fixture.Package);

        AuthoringLifecycleReceipt receipt = await fixture.Coordinator.UninstallAsync(fixture.Package, scope);

        Assert.Equal(AuthoringLifecycleState.RetainedData, receipt.State);
        Assert.False(fixture.State.DeleteCalled);
        Assert.Equal(1, fixture.Resources.RevocationCount);
    }

    [Fact]
    public async Task DeleteOwnedDataAsync_RequiresSeparateExactApprovalAndMeasuredScope()
    {
        LifecycleFixture fixture = CreateFixture();
        AuthoringStateScope scope = CreateScope(fixture.Package);
        await fixture.Coordinator.UninstallAsync(fixture.Package, scope);
        fixture.State.Measurement = (3, 128);
        var approval = new AuthoringDeleteDataApproval(
            fixture.Package.Contract.Manifest.Id,
            fixture.Package.Contract.Manifest.PackageSha256,
            scope,
            3,
            128,
            "delete-approval-1");

        await fixture.Coordinator.DeleteOwnedDataAsync(fixture.Package, approval);

        Assert.True(fixture.State.DeleteCalled);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Coordinator.DeleteOwnedDataAsync(
                fixture.Package,
                approval with
                {
                    ExpectedRecords = 4
                }));
    }

    [Fact]
    public async Task DeleteOwnedDataAsync_CannotDeleteCoreOrOtherPluginScope()
    {
        LifecycleFixture fixture = CreateFixture();
        AuthoringStateScope other = CreateScope(fixture.Package) with
        {
            ExtensionId = "other.plugin"
        };
        var approval = new AuthoringDeleteDataApproval(
            fixture.Package.Contract.Manifest.Id,
            fixture.Package.Contract.Manifest.PackageSha256,
            other,
            0,
            0,
            "delete-approval-1");

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Coordinator.DeleteOwnedDataAsync(fixture.Package, approval));
        Assert.False(fixture.State.DeleteCalled);
    }

    [Fact]
    public async Task RestoreFromReceiptAsync_UsesReceiptAuthorityOnly()
    {
        LifecycleFixture fixture = CreateFixture();
        AuthoringLifecycleReceipt enabled = await fixture.Coordinator.EnableAsync(fixture.Package, fixture.Targets);

        AuthoringLifecycleReceipt? restored = await fixture.Coordinator.RestoreFromReceiptAsync(
            fixture.Package.Contract.Manifest.Id);

        Assert.Equal(enabled, restored);
        Assert.Equal(0, fixture.State.DirectoryScanCount);
    }

    [Fact]
    public async Task RuntimeResources_RevokeTrackedWorkerServiceAndEveryHostAuthority()
    {
        VerifiedAuthoringPackage package = CreatePackage("1.0.0", 1);
        ImmutableArray<AuthoringExecutionTarget> targets = CreateTargets(package);
        var host = new HostResources();
        var resources = new AuthoringExtensionLifecycleResources(host);
        await resources.ActivateAtomicallyAsync(package, targets, 1, CancellationToken.None);
        var worker = new TrackedWorker();
        var service = new TrackedService();
        await resources.TrackWorkerAsync(package.Contract.Manifest.Id, 1, worker);
        await resources.TrackServiceAsync(package.Contract.Manifest.Id, 1, service);

        AuthoringLifecycleResourceReport report = await resources.RevokeAllAsync(
            package.Contract.Manifest.Id,
            2,
            CancellationToken.None);

        Assert.True(report.IsEmpty);
        Assert.True(worker.Terminated);
        Assert.True(worker.Disposed);
        Assert.True(service.Terminated);
        Assert.True(service.Disposed);
        Assert.Equal(1, host.RevocationCount);
    }

    [Fact]
    public async Task RuntimeResources_RollbackUsesOnlyExactRecordedTargetMapping()
    {
        VerifiedAuthoringPackage package = CreatePackage("1.0.0", 1);
        ImmutableArray<AuthoringExecutionTarget> targets = CreateTargets(package);
        var host = new HostResources();
        var resources = new AuthoringExtensionLifecycleResources(host);
        await resources.ActivateAtomicallyAsync(package, targets, 1, CancellationToken.None);
        Assert.True((await resources.RevokeAllAsync(package.Contract.Manifest.Id, 2, CancellationToken.None)).IsEmpty);

        await resources.ActivateAtomicallyAsync(package, [], 3, CancellationToken.None);

        Assert.Equal(2, host.ActivationCount);
        Assert.Equal(targets.Length, host.LastTargetCount);
        VerifiedAuthoringPackage unknown = CreatePackage("1.1.0", 1);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await new AuthoringExtensionLifecycleResources(new HostResources()).ActivateAtomicallyAsync(
                unknown,
                [],
                1,
                CancellationToken.None));
    }

    [Fact]
    public async Task RuntimeResources_OlderGenerationCannotRevokeNewGeneration()
    {
        VerifiedAuthoringPackage package = CreatePackage("1.0.0", 1);
        ImmutableArray<AuthoringExecutionTarget> targets = CreateTargets(package);
        var host = new HostResources();
        var resources = new AuthoringExtensionLifecycleResources(host);
        await resources.ActivateAtomicallyAsync(package, targets, 5, CancellationToken.None);

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await resources.RevokeAllAsync(package.Contract.Manifest.Id, 4, CancellationToken.None));

        Assert.Equal(0, host.RevocationCount);
        Assert.True((await resources.RevokeAllAsync(
            package.Contract.Manifest.Id,
            5,
            CancellationToken.None)).IsEmpty);
        Assert.Equal(1, host.RevocationCount);
    }

    [Fact]
    public async Task RuntimeResources_StaleGenerationCannotTrackWorker()
    {
        VerifiedAuthoringPackage package = CreatePackage("1.0.0", 1);
        var resources = new AuthoringExtensionLifecycleResources(new HostResources());
        await resources.ActivateAtomicallyAsync(package, CreateTargets(package), 2, CancellationToken.None);
        var worker = new TrackedWorker();

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await resources.TrackWorkerAsync(package.Contract.Manifest.Id, 1, worker));

        Assert.True(worker.Terminated);
        Assert.True(worker.Disposed);
        Assert.True((await resources.RevokeAllAsync(
            package.Contract.Manifest.Id,
            2,
            CancellationToken.None)).IsEmpty);
    }

    [Fact]
    public async Task RuntimeResources_ReleaseRacingRevokeDisposesExactlyOnce()
    {
        VerifiedAuthoringPackage package = CreatePackage("1.0.0", 1);
        ImmutableArray<AuthoringExecutionTarget> targets = CreateTargets(package);
        var resources = new AuthoringExtensionLifecycleResources(new HostResources());
        await resources.ActivateAtomicallyAsync(package, targets, 1, CancellationToken.None);
        var worker = new BlockingTrackedWorker();
        await resources.TrackWorkerAsync(package.Contract.Manifest.Id, 1, worker);

        Task<AuthoringLifecycleResourceReport> revoke = resources.RevokeAllAsync(
            package.Contract.Manifest.Id,
            1,
            CancellationToken.None).AsTask();
        await worker.TerminationStarted.Task;
        await resources.ReleaseWorkerAsync(package.Contract.Manifest.Id, 1, worker);
        worker.AllowTermination.SetResult();

        Assert.True((await revoke).IsEmpty);
        Assert.Equal(1, worker.DisposeCount);
    }

    [Fact]
    public async Task RuntimeResources_TerminationFailureRemainsReportedAfterDisposal()
    {
        VerifiedAuthoringPackage package = CreatePackage("1.0.0", 1);
        var resources = new AuthoringExtensionLifecycleResources(new HostResources());
        await resources.ActivateAtomicallyAsync(package, CreateTargets(package), 1, CancellationToken.None);
        var worker = new FailingTerminationWorker();
        await resources.TrackWorkerAsync(package.Contract.Manifest.Id, 1, worker);

        AuthoringLifecycleResourceReport report = await resources.RevokeAllAsync(
            package.Contract.Manifest.Id,
            1,
            CancellationToken.None);

        Assert.Equal(1, report.WorkerInstances);
        Assert.True(worker.Disposed);
    }

    [Fact]
    public async Task EnableAsync_RunningReceiptFailureRevokesActivatedGeneration()
    {
        var receipts = new ReceiptStore
        {
            FailAppend = static receipt => receipt.State == AuthoringLifecycleState.Running
        };
        LifecycleFixture fixture = CreateFixture(receiptStore: receipts);

        await Assert.ThrowsAsync<IOException>(async () =>
            await fixture.Coordinator.EnableAsync(fixture.Package, fixture.Targets));

        Assert.Equal(1, fixture.Resources.RevocationCount);
        Assert.Equal(fixture.Resources.LastActivationGeneration, fixture.Resources.LastRevocationGeneration);
        Assert.Equal(AuthoringLifecycleState.Crashed, fixture.Receipts.Latest?.State);
    }

    [Fact]
    public async Task UpdateAsync_RunningReceiptFailureCleansNewResourcesBeforeStateRollback()
    {
        List<string> trace = [];
        var resources = new ResourceAuthority { Trace = trace };
        var state = new StateStore { Trace = trace };
        var receipts = new ReceiptStore();
        LifecycleFixture fixture = CreateFixture(resources, state, receipts);
        await fixture.Coordinator.EnableAsync(fixture.Package, fixture.Targets);
        trace.Clear();
        receipts.FailAppend = static receipt =>
            receipt.State == AuthoringLifecycleState.Running && receipt.Version == "2.0.0";
        VerifiedAuthoringPackage next = CreatePackage("2.0.0", 2);

        await Assert.ThrowsAsync<IOException>(async () =>
            await fixture.Coordinator.UpdateAsync(
                fixture.Package,
                next,
                CreateTargets(next),
                CreatePlan(fixture.Package, next)));

        int newActivation = trace.FindIndex(static item => item.StartsWith("activate:2.0.0:", StringComparison.Ordinal));
        int newRevocation = trace.FindIndex(newActivation + 1, static item => item.StartsWith("revoke:", StringComparison.Ordinal));
        int rollback = trace.IndexOf("rollback");
        int oldReactivation = trace.FindIndex(static item => item.StartsWith("activate:1.0.0:", StringComparison.Ordinal));
        Assert.True(newActivation >= 0);
        Assert.True(newRevocation > newActivation);
        Assert.True(rollback > newRevocation);
        Assert.True(oldReactivation > rollback);
        Assert.Equal(AuthoringLifecycleState.Running, receipts.Latest?.State);
    }

    [Fact]
    public async Task RuntimeHealth_ReceiptFailureRestoresPriorResourceGeneration()
    {
        var resources = new ResourceAuthority();
        var receipts = new ReceiptStore();
        LifecycleFixture fixture = CreateFixture(resources: resources, receiptStore: receipts);
        AuthoringLifecycleReceipt running = await fixture.Coordinator.EnableAsync(fixture.Package, fixture.Targets);
        receipts.FailAppend = static receipt => receipt.State == AuthoringLifecycleState.Degraded;

        await Assert.ThrowsAsync<IOException>(async () =>
            await fixture.Coordinator.MarkDegradedAsync(
                fixture.Package,
                running.Generation,
                "health-probe-failed"));

        Assert.Equal(running.Generation, resources.ActiveGeneration);
        Assert.Equal(running, receipts.Latest);
    }

    [Fact]
    public async Task RuntimeHealth_RebindsTrackingReleaseAndDisableToCurrentGeneration()
    {
        VerifiedAuthoringPackage package = CreatePackage("1.0.0", 1);
        ImmutableArray<AuthoringExecutionTarget> targets = CreateTargets(package);
        var host = new HostResources();
        var resources = new AuthoringExtensionLifecycleResources(host);
        var receipts = new ReceiptStore();
        var coordinator = new AuthoringExtensionLifecycleCoordinator(
            resources,
            new Preflight(true),
            new StateStore(),
            receipts,
            new AuthoringCapabilityGrantCatalogStub());
        AuthoringLifecycleReceipt running = await coordinator.EnableAsync(package, targets);
        AuthoringLifecycleReceipt degraded = await coordinator.MarkDegradedAsync(
            package,
            running.Generation,
            "health-probe-failed");
        var worker = new TrackedWorker();
        await resources.TrackWorkerAsync(package.Contract.Manifest.Id, degraded.Generation, worker);

        AuthoringLifecycleReceipt recovered = await coordinator.MarkRecoveredAsync(
            package,
            degraded.Generation);
        await resources.ReleaseWorkerAsync(package.Contract.Manifest.Id, degraded.Generation, worker);
        var service = new TrackedService();
        await resources.TrackServiceAsync(package.Contract.Manifest.Id, recovered.Generation, service);
        AuthoringLifecycleReceipt disabled = await coordinator.DisableAsync(package);

        Assert.Equal(degraded.Generation + 1, recovered.Generation);
        Assert.True(worker.Disposed);
        Assert.True(service.Terminated);
        Assert.True(service.Disposed);
        Assert.Equal(AuthoringLifecycleState.Disabled, disabled.State);
        Assert.Equal(1, host.RevocationCount);
    }

    private static LifecycleFixture CreateFixture(
        ResourceAuthority? resources = null,
        StateStore? stateStore = null,
        ReceiptStore? receiptStore = null)
    {
        VerifiedAuthoringPackage package = CreatePackage("1.0.0", 1);
        resources ??= new ResourceAuthority();
        stateStore ??= new StateStore();
        ReceiptStore receipts = receiptStore ?? new ReceiptStore();
        var coordinator = new AuthoringExtensionLifecycleCoordinator(
            resources,
            new Preflight(true),
            stateStore,
            receipts,
            new AuthoringCapabilityGrantCatalogStub());
        return new LifecycleFixture(
            package,
            CreateTargets(package),
            coordinator,
            resources,
            stateStore,
            receipts);
    }

    private static VerifiedAuthoringPackage CreatePackage(string version, int stateSchemaVersion)
    {
        AuthoringExtensionManifest manifest = AuthoringExtensionContractsTests.CreateManifest() with
        {
            Version = version,
            StateSchemaVersion = stateSchemaVersion
        };
        VerifiedAuthoringExtensionContract contract = AuthoringExtensionContractValidator.Verify(manifest);
        DateTimeOffset now = DateTimeOffset.UtcNow;
        return new VerifiedAuthoringPackage(
            contract,
            new AuthoringPackageArtifact([], [], "acme", "key-1", "source/1", "provenance/1"),
            new AuthoringPackageArchiveContents([], []),
            new AuthoringPackageTrustDecision(
                AuthoringPackageTrustStatus.Trusted,
                "acme",
                "key-1",
                now,
                now.AddMinutes(5)),
            new string(version.StartsWith('1') ? 'a' : 'b', 64));
    }

    private static ImmutableArray<AuthoringExecutionTarget> CreateTargets(VerifiedAuthoringPackage package)
    {
        AuthoringContributionDeclaration contribution = package.Contract.Manifest.Contributions[0];
        return
        [
            new AuthoringExecutionTarget(
                AuthoringExecutionResolutionStatus.Ready,
                contribution.ExecutionClass,
                package.Contract.Manifest.Id,
                package.Contract.Manifest.Version,
                package.Contract.Manifest.PackageSha256,
                contribution.Id,
                contribution.Kind,
                contribution.Entrypoint.PathOrAdapterId,
                null,
                new string('c', 64),
                null)
        ];
    }

    private static AuthoringStateMigrationPlan CreatePlan(
        VerifiedAuthoringPackage oldPackage,
        VerifiedAuthoringPackage newPackage) => new(
            "migration-1",
            CreateScope(oldPackage),
            CreateScope(newPackage),
            100,
            1024,
            TimeSpan.FromSeconds(5),
            [new AuthoringStateTransform(AuthoringStateTransformKind.RenameKey, "old", "new", [])],
            "backup/1",
            "rollback/1",
            new string('d', 64));

    private static AuthoringStateScope CreateScope(VerifiedAuthoringPackage package) => new(
        package.Contract.Manifest.Id,
        package.Contract.Manifest.Version,
        "site-1",
        "user-1",
        "document-1",
        package.Contract.Manifest.StateSchemaVersion);

    private sealed record LifecycleFixture(
        VerifiedAuthoringPackage Package,
        ImmutableArray<AuthoringExecutionTarget> Targets,
        AuthoringExtensionLifecycleCoordinator Coordinator,
        ResourceAuthority Resources,
        StateStore State,
        ReceiptStore Receipts);

    private sealed class ResourceAuthority : IAuthoringLifecycleResourceAuthority
    {
        public AuthoringLifecycleResourceReport RevokeReport { get; init; } = new(0, 0, 0, 0, 0, 0, 0);

        public int ActivationCount
        {
            get; private set;
        }

        public int LastTargetCount
        {
            get; private set;
        }

        public int RevocationCount
        {
            get; private set;
        }

        public long ActiveGeneration
        {
            get; private set;
        }

        public long LastActivationGeneration
        {
            get; private set;
        }

        public long LastRevocationGeneration
        {
            get; private set;
        }

        public List<string>? Trace
        {
            get; init;
        }

        public VerifiedAuthoringPackage? LastActivatedPackage
        {
            get; private set;
        }

        public ValueTask ActivateAtomicallyAsync(
            VerifiedAuthoringPackage package,
            ImmutableArray<AuthoringExecutionTarget> targets,
            long generation,
            CancellationToken cancellationToken)
        {
            ActivationCount++;
            LastTargetCount = targets.Length;
            LastActivatedPackage = package;
            ActiveGeneration = generation;
            LastActivationGeneration = generation;
            Trace?.Add($"activate:{package.Contract.Manifest.Version}:{generation}");
            return ValueTask.CompletedTask;
        }

        public ValueTask<AuthoringLifecycleResourceReport> RevokeAllAsync(
            string extensionId,
            long generation,
            CancellationToken cancellationToken)
        {
            RevocationCount++;
            LastRevocationGeneration = generation;
            Trace?.Add($"revoke:{generation}");
            if (RevokeReport.IsEmpty)
            {
                ActiveGeneration = 0;
            }
            return ValueTask.FromResult(RevokeReport);
        }

        public ValueTask<bool> RebindGenerationAsync(
            string extensionId,
            long expectedGeneration,
            long replacementGeneration,
            CancellationToken cancellationToken)
        {
            if (ActiveGeneration == 0)
            {
                return ValueTask.FromResult(false);
            }

            if (ActiveGeneration != expectedGeneration)
            {
                throw new AuthoringExtensionContractException("test generation is stale");
            }

            ActiveGeneration = replacementGeneration;
            Trace?.Add($"rebind:{expectedGeneration}:{replacementGeneration}");
            return ValueTask.FromResult(true);
        }
    }

    private sealed class HostResources : IAuthoringLifecycleHostResourceAuthority
    {
        public int ActivationCount
        {
            get; private set;
        }

        public int LastTargetCount
        {
            get; private set;
        }

        public int RevocationCount
        {
            get; private set;
        }

        public ValueTask ActivateAtomicallyAsync(
            VerifiedAuthoringPackage package,
            ImmutableArray<AuthoringExecutionTarget> targets,
            CancellationToken cancellationToken)
        {
            ActivationCount++;
            LastTargetCount = targets.Length;
            return ValueTask.CompletedTask;
        }

        public ValueTask<AuthoringLifecycleHostResourceReport> RevokeAllAsync(
            string extensionId,
            CancellationToken cancellationToken)
        {
            RevocationCount++;
            return ValueTask.FromResult(new AuthoringLifecycleHostResourceReport(0, 0, 0, 0, 0));
        }
    }

    private sealed class TrackedWorker : IAuthoringWorkerSandboxInstance
    {
        public AuthoringWorkerCapabilityReport CapabilityReport => new(
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            [],
            [],
            true,
            new string('a', 64));

        public bool Terminated
        {
            get; private set;
        }

        public bool Disposed
        {
            get; private set;
        }

        public ValueTask<AuthoringWorkerResponse> ExecuteAsync(
            AuthoringWorkerRequest request,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask TerminateAsync(string reason, CancellationToken cancellationToken)
        {
            Terminated = true;
            return ValueTask.CompletedTask;
        }

        public ValueTask DisposeAsync()
        {
            Disposed = true;
            return ValueTask.CompletedTask;
        }
    }

    private sealed class BlockingTrackedWorker : IAuthoringWorkerSandboxInstance
    {
        public TaskCompletionSource TerminationStarted
        {
            get;
        } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public TaskCompletionSource AllowTermination
        {
            get;
        } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public int DisposeCount
        {
            get; private set;
        }

        public AuthoringWorkerCapabilityReport CapabilityReport => throw new NotSupportedException();

        public ValueTask<AuthoringWorkerResponse> ExecuteAsync(
            AuthoringWorkerRequest request,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public async ValueTask TerminateAsync(string reason, CancellationToken cancellationToken)
        {
            TerminationStarted.TrySetResult();
            await AllowTermination.Task;
        }

        public ValueTask DisposeAsync()
        {
            DisposeCount++;
            return ValueTask.CompletedTask;
        }
    }

    private sealed class FailingTerminationWorker : IAuthoringWorkerSandboxInstance
    {
        public AuthoringWorkerCapabilityReport CapabilityReport => throw new NotSupportedException();

        public bool Disposed
        {
            get; private set;
        }

        public ValueTask<AuthoringWorkerResponse> ExecuteAsync(
            AuthoringWorkerRequest request,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask TerminateAsync(string reason, CancellationToken cancellationToken) =>
            ValueTask.FromException(new IOException("termination failed"));

        public ValueTask DisposeAsync()
        {
            Disposed = true;
            return ValueTask.CompletedTask;
        }
    }

    private sealed class TrackedService : IAuthoringServiceProcess
    {
        public AuthoringProcessOwnershipReport Ownership => new(
            AuthoringProcessOwnershipMechanism.PosixProcessGroup,
            true,
            true,
            new string('b', 64));

        public bool Terminated
        {
            get; private set;
        }

        public bool Disposed
        {
            get; private set;
        }

        public ValueTask<AuthoringServiceHealthReport> GetHealthAsync(CancellationToken cancellationToken) =>
            throw new NotSupportedException();

        public ValueTask<AuthoringServiceResponse> ExecuteAsync(
            AuthoringServiceRequest request,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask TerminateTreeAsync(string reason, CancellationToken cancellationToken)
        {
            Terminated = true;
            return ValueTask.CompletedTask;
        }

        public ValueTask DisposeAsync()
        {
            Disposed = true;
            return ValueTask.CompletedTask;
        }
    }

    private sealed class Preflight(bool accepted) : IAuthoringLifecyclePreflight
    {
        public ValueTask<bool> VerifyAsync(
            VerifiedAuthoringPackage package,
            ImmutableArray<AuthoringExecutionTarget> targets,
            CancellationToken cancellationToken) => ValueTask.FromResult(accepted);
    }

    private sealed class StateStore : IAuthoringExtensionStateStore
    {
        public bool FailMigration
        {
            get; init;
        }

        public bool BackupCalled
        {
            get; private set;
        }

        public bool RollbackCalled
        {
            get; private set;
        }

        public bool DeleteCalled
        {
            get; private set;
        }

        public int DirectoryScanCount
        {
            get; private set;
        }

        public (long Records, long Bytes) Measurement
        {
            get; set;
        }

        public List<string>? Trace
        {
            get; init;
        }

        public ValueTask BackupAsync(AuthoringStateMigrationPlan plan, CancellationToken cancellationToken)
        {
            BackupCalled = true;
            Trace?.Add("backup");
            return ValueTask.CompletedTask;
        }

        public ValueTask ApplyAsync(AuthoringStateMigrationPlan plan, CancellationToken cancellationToken)
        {
            Trace?.Add("apply");
            if (FailMigration)
            {
                throw new InvalidOperationException("migration failed");
            }

            return ValueTask.CompletedTask;
        }

        public ValueTask RollbackAsync(AuthoringStateMigrationPlan plan, CancellationToken cancellationToken)
        {
            RollbackCalled = true;
            Trace?.Add("rollback");
            return ValueTask.CompletedTask;
        }

        public ValueTask<(long Records, long Bytes)> MeasureAsync(
            AuthoringStateScope scope,
            CancellationToken cancellationToken) => ValueTask.FromResult(Measurement);

        public ValueTask DeleteAsync(AuthoringStateScope scope, CancellationToken cancellationToken)
        {
            DeleteCalled = true;
            return ValueTask.CompletedTask;
        }
    }

    private sealed class ReceiptStore : IAuthoringLifecycleReceiptStore
    {
        public List<AuthoringLifecycleReceipt> All { get; } = [];

        public AuthoringLifecycleReceipt? Latest
        {
            get; private set;
        }

        public Func<AuthoringLifecycleReceipt, bool>? FailAppend
        {
            get; set;
        }

        public ValueTask<AuthoringLifecycleReceipt?> GetLatestAsync(
            string extensionId,
            CancellationToken cancellationToken) => ValueTask.FromResult(Latest);

        public ValueTask AppendAsync(AuthoringLifecycleReceipt receipt, CancellationToken cancellationToken)
        {
            if (FailAppend?.Invoke(receipt) == true)
            {
                throw new IOException("receipt persistence failed");
            }

            if (Latest is not null && receipt.Sequence != Latest.Sequence + 1)
            {
                throw new AuthoringExtensionContractException("Lifecycle receipt sequence is not append-only.");
            }

            Latest = receipt;
            All.Add(receipt);
            return ValueTask.CompletedTask;
        }
    }
}
