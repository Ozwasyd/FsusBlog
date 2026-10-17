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

    [Theory]
    [InlineData("digest")]
    [InlineData("identity")]
    [InlineData("schema")]
    [InlineData("generation")]
    [InlineData("sequence")]
    [InlineData("state")]
    public async Task StoredReceipt_TamperCannotAuthorizeRestoreOrLateResult(string field)
    {
        LifecycleFixture fixture = CreateFixture();
        AuthoringLifecycleReceipt receipt = await fixture.Coordinator.EnableAsync(fixture.Package, fixture.Targets);
        AuthoringLifecycleReceipt changed = field switch
        {
            "digest" => receipt with { ReceiptSha256 = new string('0', 64) },
            "identity" => receipt with { ExtensionId = "other.plugin" },
            "schema" => receipt with { SchemaVersion = 2 },
            "generation" => receipt with { Generation = 0 },
            "sequence" => receipt with { Sequence = 0 },
            "state" => receipt with { State = (AuthoringLifecycleState)999 },
            _ => throw new ArgumentOutOfRangeException(nameof(field))
        };
        if (field != "digest")
        {
            changed = changed with
            {
                ReceiptSha256 = AuthoringExtensionLifecycleCoordinator.ComputeReceiptSha256(changed)
            };
        }
        fixture.Receipts.ReplaceStoredReceipt(changed);

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Coordinator.RestoreFromReceiptAsync(fixture.Package.Contract.Manifest.Id));
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Coordinator.AcceptResultAsync(fixture.Package.Contract.Manifest.Id, receipt.Generation));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ShutdownAsync_TamperedReceiptStillRevokesOwnedResourcesWithoutPublishingAuthority(bool uninstall)
    {
        VerifiedAuthoringPackage package = CreatePackage("1.0.0", 1);
        var host = new HostResources();
        var resources = new AuthoringExtensionLifecycleResources(host);
        var receipts = new ReceiptStore();
        var state = new StateStore();
        var grants = new ShutdownGrantCatalog();
        var coordinator = new AuthoringExtensionLifecycleCoordinator(
            resources, new Preflight(true), state, receipts, grants);
        AuthoringLifecycleReceipt receipt = await coordinator.EnableAsync(package, CreateTargets(package));
        var worker = new TrackedWorker();
        var service = new TrackedService();
        await resources.TrackWorkerAsync(package.Contract.Manifest.Id, receipt.Generation, worker);
        await resources.TrackServiceAsync(package.Contract.Manifest.Id, receipt.Generation, service);
        receipts.ReplaceStoredReceipt(receipt with
        {
            Generation = long.MaxValue,
            ReceiptSha256 = new string('0', 64)
        });
        int receiptCount = receipts.All.Count;

        AuthoringExtensionContractException failure = await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
        {
            if (uninstall)
            {
                await coordinator.UninstallAsync(package, CreateScope(package));
            }
            else
            {
                await coordinator.DisableAsync(package);
            }
        });

        Assert.Contains("Stored lifecycle receipt", failure.Message, StringComparison.Ordinal);
        Assert.True(worker.Terminated);
        Assert.True(worker.Disposed);
        Assert.True(service.Terminated);
        Assert.True(service.Disposed);
        Assert.Equal(1, host.RevocationCount);
        Assert.Equal(1, grants.RevocationCount);
        Assert.Equal(receiptCount, receipts.All.Count);
        Assert.False(state.DeleteCalled);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await resources.ActivateAtomicallyAsync(package, CreateTargets(package), receipt.Generation + 1, CancellationToken.None));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ShutdownAsync_CleanupFailurePreservesReceiptRefusalAndAttemptsGrantRevocation(bool grantFailure)
    {
        VerifiedAuthoringPackage package = CreatePackage("1.0.0", 1);
        var host = new HostResources();
        var resources = new AuthoringExtensionLifecycleResources(host);
        var receipts = new ReceiptStore();
        var grants = new ShutdownGrantCatalog { FailRevocation = grantFailure };
        var coordinator = new AuthoringExtensionLifecycleCoordinator(
            resources, new Preflight(true), new StateStore(), receipts, grants);
        AuthoringLifecycleReceipt receipt = await coordinator.EnableAsync(package, CreateTargets(package));
        var worker = new FailingTerminationWorker();
        var service = new TrackedService();
        await resources.TrackWorkerAsync(package.Contract.Manifest.Id, receipt.Generation, worker);
        await resources.TrackServiceAsync(package.Contract.Manifest.Id, receipt.Generation, service);
        receipts.ReplaceStoredReceipt(receipt with
        {
            ReceiptSha256 = new string('0', 64)
        });
        int receiptCount = receipts.All.Count;

        AuthoringExtensionContractException failure = await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await coordinator.DisableAsync(package));

        Assert.Contains("Stored lifecycle receipt", failure.Message, StringComparison.Ordinal);
        Assert.Equal("cleanup-incomplete", failure.Data["AuthoringResourceCleanup"]);
        Assert.Equal(grantFailure ? "cleanup-failed" : null, failure.Data["AuthoringGrantCleanup"]);
        Assert.True(worker.Disposed);
        Assert.True(service.Terminated);
        Assert.True(service.Disposed);
        Assert.Equal(1, host.RevocationCount);
        Assert.Equal(1, grants.RevocationCount);
        Assert.Equal(receiptCount, receipts.All.Count);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ShutdownAsync_GrantRecoveryRetriesOnlyTheRetainedOwnedPackage(bool uninstall)
    {
        VerifiedAuthoringPackage package = CreatePackage("1.0.0", 1);
        ImmutableArray<AuthoringExecutionTarget> targets = CreateTargets(package);
        AuthoringContributionDeclaration contribution = package.Contract.Manifest.Contributions[0];
        DateTimeOffset now = DateTimeOffset.UtcNow;
        var grant = new AuthoringCapabilityGrant(
            "grant-recovery-1", targets[0].RuntimeIdentity!, package.Contract.Manifest.Id,
            package.Contract.Manifest.Version, contribution.Id, contribution.ExecutionClass,
            AuthoringCapability.DocumentRangeRead, "document-1", "site-1", "read-range", null, null,
            now, now.AddMinutes(1), "approval-1", "request-1", new string('a', 64));
        var grants = new RecoveringShutdownGrantCatalog(grant);
        var host = new HostResources();
        var resources = new AuthoringExtensionLifecycleResources(host);
        var receipts = new ReceiptStore();
        var state = new StateStore();
        var coordinator = new AuthoringExtensionLifecycleCoordinator(
            resources, new Preflight(true), state, receipts, grants);
        AuthoringLifecycleReceipt receipt = await coordinator.EnableAsync(package, targets);
        var worker = new TrackedWorker();
        var service = new TrackedService();
        await resources.TrackWorkerAsync(package.Contract.Manifest.Id, receipt.Generation, worker);
        await resources.TrackServiceAsync(package.Contract.Manifest.Id, receipt.Generation, service);
        receipts.ReplaceStoredReceipt(receipt with
        {
            ReceiptSha256 = new string('0', 64)
        });
        int receiptCount = receipts.All.Count;

        async Task<AuthoringExtensionContractException> ShutdownAsync() =>
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            {
                if (uninstall)
                {
                    await coordinator.UninstallAsync(package, CreateScope(package));
                }
                else
                {
                    await coordinator.DisableAsync(package);
                }
            });

        AuthoringExtensionContractException first = await ShutdownAsync();
        Assert.Contains("Stored lifecycle receipt", first.Message, StringComparison.Ordinal);
        Assert.Equal("cleanup-failed", first.Data["AuthoringGrantCleanup"]);
        Assert.True(worker.Terminated);
        Assert.True(worker.Disposed);
        Assert.True(service.Terminated);
        Assert.True(service.Disposed);
        Assert.Single(await grants.FindActiveAsync(grant.ExtensionId, grant.ContributionId, grant.RuntimeIdentity, CancellationToken.None));

        VerifiedAuthoringPackage otherPackage = CreatePackage("2.0.0", 1);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await coordinator.DisableAsync(otherPackage));
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await resources.ActivateAtomicallyAsync(otherPackage, CreateTargets(otherPackage), receipt.Generation + 1, CancellationToken.None));
        Assert.Equal(1, grants.RevocationCount);
        Assert.Equal(1, host.RevocationCount);
        Assert.True((await resources.RevokeAllAsync(package.Contract.Manifest.Id, receipt.Generation, CancellationToken.None)).IsEmpty);

        AuthoringExtensionContractException second = await ShutdownAsync();
        Assert.Contains("Stored lifecycle receipt", second.Message, StringComparison.Ordinal);
        Assert.Null(second.Data["AuthoringGrantCleanup"]);
        Assert.Equal(2, grants.RevocationCount);
        Assert.Empty(await grants.FindActiveAsync(grant.ExtensionId, grant.ContributionId, grant.RuntimeIdentity, CancellationToken.None));
        Assert.Equal(3, host.RevocationCount);
        Assert.Equal(receiptCount, receipts.All.Count);
        Assert.False(state.DeleteCalled);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await coordinator.AcceptResultAsync(package.Contract.Manifest.Id, receipt.Generation + 1));
    }

    [Fact]
    public async Task ShutdownAsync_MissingCanonicalResourceOwnerDoesNotInventRevocationAuthority()
    {
        var grants = new ShutdownGrantCatalog();
        LifecycleFixture fixture = CreateFixture();
        var coordinator = new AuthoringExtensionLifecycleCoordinator(
            fixture.Resources, new Preflight(true), fixture.State, fixture.Receipts, grants);
        AuthoringLifecycleReceipt receipt = await coordinator.EnableAsync(fixture.Package, fixture.Targets);
        fixture.Receipts.ReplaceStoredReceipt(receipt with
        {
            ReceiptSha256 = new string('0', 64)
        });
        int receiptCount = fixture.Receipts.All.Count;

        AuthoringExtensionContractException failure = await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await coordinator.DisableAsync(fixture.Package));

        Assert.Equal("canonical-owned-resources-unavailable", failure.Data["AuthoringResourceCleanup"]);
        Assert.Equal(0, fixture.Resources.RevocationCount);
        Assert.Equal(0, grants.RevocationCount);
        Assert.Equal(receiptCount, fixture.Receipts.All.Count);
    }

    [Theory]
    [InlineData(false, false, false)]
    [InlineData(false, true, false)]
    [InlineData(true, false, false)]
    [InlineData(true, true, false)]
    [InlineData(false, false, true)]
    [InlineData(true, false, true)]
    public async Task ShutdownAsync_OlderPackageCannotRevokeNewerRuntimeOrGrants(bool tampered, bool uninstall, bool identityOnly)
    {
        VerifiedAuthoringPackage oldPackage = CreatePackage("1.0.0", 1);
        VerifiedAuthoringPackage newPackage = CreatePackage("2.0.0", 1);
        newPackage = newPackage with
        {
            Contract = AuthoringExtensionContractValidator.Verify(newPackage.Contract.Manifest with
            {
                PackageSha256 = new string('e', 64),
                ContentSha256 = new string('f', 64)
            })
        };
        if (identityOnly)
        {
            oldPackage = newPackage with
            {
                PackageIdentity = new string('c', 64)
            };
        }
        var host = new HostResources();
        var resources = new AuthoringExtensionLifecycleResources(host);
        var receipts = new ReceiptStore();
        var grants = new ShutdownGrantCatalog();
        var state = new StateStore();
        var coordinator = new AuthoringExtensionLifecycleCoordinator(
            resources, new Preflight(true), state, receipts, grants);
        AuthoringLifecycleReceipt receipt = await coordinator.EnableAsync(newPackage, CreateTargets(newPackage));
        var worker = new TrackedWorker();
        var service = new TrackedService();
        await resources.TrackWorkerAsync(newPackage.Contract.Manifest.Id, receipt.Generation, worker);
        await resources.TrackServiceAsync(newPackage.Contract.Manifest.Id, receipt.Generation, service);
        if (tampered)
        {
            receipts.ReplaceStoredReceipt(receipt with
            {
                ReceiptSha256 = new string('0', 64)
            });
        }
        int receiptCount = receipts.All.Count;

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
        {
            if (uninstall)
            {
                await coordinator.UninstallAsync(oldPackage, CreateScope(oldPackage));
            }
            else
            {
                await coordinator.DisableAsync(oldPackage);
            }
        });

        Assert.False(worker.Terminated);
        Assert.False(worker.Disposed);
        Assert.False(service.Terminated);
        Assert.False(service.Disposed);
        Assert.Equal(0, host.RevocationCount);
        Assert.Equal(0, grants.RevocationCount);
        Assert.Equal(receiptCount, receipts.All.Count);
        Assert.False(state.DeleteCalled);
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

        public void ReplaceStoredReceipt(AuthoringLifecycleReceipt receipt) => Latest = receipt;

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

    private sealed class ShutdownGrantCatalog : IAuthoringCapabilityGrantCatalog
    {
        public int RevocationCount
        {
            get; private set;
        }

        public bool FailRevocation
        {
            get; init;
        }

        public ValueTask<ImmutableArray<AuthoringCapabilityGrant>> FindActiveAsync(
            string extensionId, string contributionId, string runtimeIdentity, CancellationToken cancellationToken) =>
            ValueTask.FromResult(ImmutableArray<AuthoringCapabilityGrant>.Empty);

        public ValueTask<ImmutableArray<AuthoringCapabilityGrant>> FindActiveExactAsync(
            string extensionId, string extensionVersion, string contributionId, string runtimeIdentity,
            AuthoringExecutionClass executionClass, string documentId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(ImmutableArray<AuthoringCapabilityGrant>.Empty);

        public ValueTask<int> RevokeExtensionAsync(string extensionId, CancellationToken cancellationToken)
        {
            RevocationCount++;
            if (FailRevocation)
            {
                throw new IOException("grant revocation failed");
            }
            return ValueTask.FromResult(0);
        }

        public ValueTask<int> RevokeRuntimesAsync(
            string extensionId, ImmutableHashSet<string> runtimeIdentities, CancellationToken cancellationToken) =>
            ValueTask.FromResult(0);
    }

    private sealed class RecoveringShutdownGrantCatalog(AuthoringCapabilityGrant grant) : IAuthoringCapabilityGrantCatalog
    {
        private readonly AuthoringCapabilityGrantCatalogStub _catalog = new([grant]);

        public int RevocationCount
        {
            get; private set;
        }

        public ValueTask<ImmutableArray<AuthoringCapabilityGrant>> FindActiveAsync(
            string extensionId, string contributionId, string runtimeIdentity, CancellationToken cancellationToken) =>
            _catalog.FindActiveAsync(extensionId, contributionId, runtimeIdentity, cancellationToken);

        public ValueTask<ImmutableArray<AuthoringCapabilityGrant>> FindActiveExactAsync(
            string extensionId, string extensionVersion, string contributionId, string runtimeIdentity,
            AuthoringExecutionClass executionClass, string documentId, CancellationToken cancellationToken) =>
            _catalog.FindActiveExactAsync(extensionId, extensionVersion, contributionId, runtimeIdentity,
                executionClass, documentId, cancellationToken);

        public ValueTask<int> RevokeExtensionAsync(string extensionId, CancellationToken cancellationToken)
        {
            RevocationCount++;
            if (RevocationCount == 1)
            {
                throw new IOException("grant store temporarily unavailable");
            }
            return _catalog.RevokeExtensionAsync(extensionId, cancellationToken);
        }

        public ValueTask<int> RevokeRuntimesAsync(
            string extensionId, ImmutableHashSet<string> runtimeIdentities, CancellationToken cancellationToken) =>
            _catalog.RevokeRuntimesAsync(extensionId, runtimeIdentities, cancellationToken);
    }
}
