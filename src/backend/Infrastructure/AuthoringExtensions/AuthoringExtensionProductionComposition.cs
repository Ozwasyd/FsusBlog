using System.Collections.Immutable;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Services.Authoring;

using Npgsql;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

/// <summary>Original launch providers only; their existence does not attest startup, Track or readiness.</summary>
public sealed class AuthoringProductionRuntimeProviders
{
    internal AuthoringProductionRuntimeProviders(
        LinuxBubblewrapAuthoringWorkerRuntime? worker,
        LinuxBubblewrapAuthoringServiceRuntime? service)
    {
        Worker = worker;
        Service = service;
    }

    public IAuthoringWorkerSandboxRuntime? Worker
    {
        get;
    }

    public IAuthoringServiceProcessRuntime? Service
    {
        get;
    }
}

/// <summary>
/// Explicit host composition for development. This does not register a production
/// route, initialize state, mint consent, or manufacture lifecycle generations.
/// The original coordinator owns every receipt and Resources owns every Track call.
/// </summary>
public sealed class AuthoringExtensionProductionComposition : IAuthoringFencedLifecycleResourceAuthorityV1,
    IAuthoringExtensionApprovalExecutionResultSource
{
    private readonly Lock _generationLock = new();
    private readonly Dictionary<string, PreparedGeneration> _generations = new(StringComparer.Ordinal);
    private readonly IAuthoringCapabilityGrantCatalog _grants;
    public AuthoringExtensionProductionComposition(
        LocalAuthoringPackageRuntime packages,
        IAuthoringCapabilityGrantCatalog grants,
        IAuthoringFencedExtensionStateStore stateStore,
        IAuthoringLifecycleReceiptStore receipts,
        TimeProvider timeProvider,
        AuthoringHostPlatform platform,
        AuthoringStateScope scope,
        string purpose,
        AuthoringCoreAuthorityRegistry coreAuthorities,
        ImmutableHashSet<string> coreOrUserShortcuts,
        IAuthorSavedViewQueryValidator queryValidator,
        LinuxBubblewrapWorkerOptions? workerOptions = null,
        LinuxBubblewrapServiceOptions? serviceOptions = null,
        AuthoringExtensionApprovalAuthority? approvalAuthority = null,
        AuthoringExtensionApprovalAuthority.ApprovedClaim? approvedClaim = null)
    {
        ArgumentNullException.ThrowIfNull(packages);
        ArgumentNullException.ThrowIfNull(grants);
        ArgumentNullException.ThrowIfNull(stateStore);
        ArgumentNullException.ThrowIfNull(receipts);
        ArgumentNullException.ThrowIfNull(timeProvider);
        _grants = grants;
        LinuxBubblewrapAuthoringWorkerRuntime? worker = null;
        LinuxBubblewrapAuthoringServiceRuntime? service = null;
        if (OperatingSystem.IsLinux() && platform == AuthoringHostPlatform.ServerLinux)
        {
            worker = workerOptions is null ? null : new LinuxBubblewrapAuthoringWorkerRuntime(workerOptions);
            service = serviceOptions is null ? null : new LinuxBubblewrapAuthoringServiceRuntime(serviceOptions);
        }
        Providers = new(worker, service);
        ApprovalClaim = approvedClaim;
        Approvals = approvalAuthority;
        Preflight = new(packages, grants, stateStore, receipts, timeProvider, platform, scope, purpose, Providers,
            approvalAuthority, approvedClaim);
        HostResources = new(Preflight, grants, coreAuthorities, coreOrUserShortcuts, queryValidator);
        Coordinator = new(this, Preflight, stateStore, receipts, grants);
    }

    public AuthoringExtensionProductionPreflight Preflight
    {
        get;
    }

    public AuthoringExtensionApprovalAuthority.ApprovedClaim? ApprovalClaim
    {
        get;
    }

    public IAuthoringExtensionApprovalAuthority? Approvals
    {
        get;
    }

    public AuthoringExtensionOperationContext? OperationContext => ApprovalClaim?.OperationContext;

    public AuthoringProductionRuntimeProviders Providers
    {
        get;
    }

    public AuthoringExtensionHostResourceAuthority HostResources
    {
        get;
    }

    public IAuthoringFencedLifecycleResourceAuthorityV1 Resources => this;

    public IAuthoringExtensionApprovalExecutionResultSource ExecutionResults => this;

    public async ValueTask<IAuthoringExtensionApprovalExecutionResultScope> AcquireAsync(
        NpgsqlConnection connection, NpgsqlTransaction transaction,
        AuthoringExtensionApprovalAuthority.ApprovedClaim claim, long generation,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(connection);
        ArgumentNullException.ThrowIfNull(transaction);
        ArgumentNullException.ThrowIfNull(claim);
        cancellationToken.ThrowIfCancellationRequested();
        RequireOwnedApprovalTransaction(connection, transaction, claim);
        PreparedGeneration? prepared;
        lock (_generationLock)
        {
            _generations.TryGetValue(claim.Scope.ExtensionId, out prepared);
            AuthoringExtensionProductionPreflight.Require(prepared is not null && prepared.Generation == generation,
                "production_execution_generation_custody_unavailable");
        }
        return await prepared!.AcquireExecutionResultScopeAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
    }

    private void RequireOwnedApprovalTransaction(NpgsqlConnection connection, NpgsqlTransaction transaction,
        AuthoringExtensionApprovalAuthority.ApprovedClaim claim)
    {
        // The original approval owner supplies its already actor-pinned final
        // transaction. Pair identity alone does not establish actor custody.
        // Never create, commit, dispose or replace the supplied transaction.
        AuthoringExtensionProductionPreflight.Require(ReferenceEquals(transaction.Connection, connection)
            && connection.State == System.Data.ConnectionState.Open, "production_approval_transaction_not_owned");
        AuthoringExtensionProductionPreflight.Require(ReferenceEquals(ApprovalClaim, claim),
            "production_execution_claim_not_owned");
    }

    internal ValueTask<IAuthoringExtensionStateObservation> AcquireSettledStateCustodyAsync(
        NpgsqlConnection connection, NpgsqlTransaction transaction, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(connection);
        ArgumentNullException.ThrowIfNull(transaction);
        cancellationToken.ThrowIfCancellationRequested();
        AuthoringExtensionApprovalAuthority.ApprovedClaim claim = ApprovalClaim
            ?? throw new AuthoringExtensionContractException("production_migration_claim_required");
        RequireOwnedApprovalTransaction(connection, transaction, claim);
        AuthoringExtensionProductionPreflight.Require(claim.Operation == AuthoringApprovalOperation.Migration
            && claim.FrozenPlan is not null, "production_migration_claim_required");
        // Return the original observation itself. The canonical result scope
        // must expose this identical object for ordered provenance borrowing;
        // no copied observation or second state key/SELECT supplies custody.
        return Preflight.AcquireSettledStateObservationAsync(claim.OldPackage, claim.NewPackage,
            claim.FrozenPlan!, AuthoringStateMigrationPhase.Completed, cancellationToken);
    }

    public AuthoringExtensionLifecycleCoordinator Coordinator
    {
        get;
    }

    public async ValueTask<IAuthoringPreparedLifecycleGenerationV1> PrepareAsync(
        VerifiedAuthoringPackage package,
        ImmutableArray<AuthoringExecutionTarget> orderedTargets,
        AuthoringStateSnapshot appliedSnapshot,
        long runningGeneration,
        CancellationToken cancellationToken)
    {
        using var operation = AuthoringExtensionProductionPreflight.BoundOperation(cancellationToken);
        cancellationToken = operation.Token;
        // Freeze the actual Apply return before yielding. No ordinary state read
        // is attempted while its original migration fence remains held.
        AuthoringStateSnapshot snapshot = Preflight.FreezeAppliedSnapshot(appliedSnapshot);
        IAuthoringInstalledPackageReadScope? held = await Preflight.AcquirePreparationScopeAsync(
            package, orderedTargets, snapshot, runningGeneration, cancellationToken).ConfigureAwait(false);
        AuthoringExtensionHostResourceAuthority.StagedRegistrations? stage = null;
        PreparedGeneration? prepared = null;
        try
        {
            // Unqualified original scope/result custody cannot start a process or receive state.
            // There is no caller-supplied flag to skip this qualification boundary.
            // A real Applied observation proves the supplied Apply bytes while
            // its original state keys remain held. This read-only preflight is
            // not the later settled-state/native lifetime required by Complete.
            await using (IAuthoringExtensionStateObservation observed = await Preflight.AcquireAppliedStateObservationAsync(
                ApprovalClaim!.OldPackage, package, ApprovalClaim.FrozenPlan!, snapshot, cancellationToken).ConfigureAwait(false))
            {
                await observed.VerifyCurrentAsync(cancellationToken).ConfigureAwait(false);
                Preflight.RequireQualifiedEffects();
            }
            stage = HostResources.StageHeldPackage(held, orderedTargets);
            held = null;
            lock (_generationLock)
            {
                AuthoringExtensionProductionPreflight.Require(!_generations.ContainsKey(package.Contract.Manifest.Id),
                    "production_generation_custody_already_retained");
                prepared = new(this, stage, orderedTargets, snapshot, runningGeneration);
                // Retain custody before the first launch await, including a
                // failed Prepare that cannot return a handle to its caller.
                _generations.Add(package.Contract.Manifest.Id, prepared);
            }
            await prepared.StartAsync(cancellationToken).ConfigureAwait(false);
            await prepared.VerifyCurrentAsync(cancellationToken).ConfigureAwait(false);
            return prepared;
        }
        catch (Exception failure)
        {
            if (prepared is not null)
            {
                try
                {
                    using var cleanup = new CancellationTokenSource(TimeSpan.FromSeconds(30));
                    _ = await prepared.AbortAsync(cleanup.Token).ConfigureAwait(false);
                }
                catch (Exception cleanupFailure)
                {
                    failure.Data["AuthoringPreparationCleanupFailure"] = cleanupFailure;
                }
            }
            else if (stage is not null)
            {
                try
                {
                    using var cleanup = new CancellationTokenSource(TimeSpan.FromSeconds(30));
                    _ = await stage.RevokeAllAsync(stage.Package.Contract.Manifest.Id, cleanup.Token).ConfigureAwait(false);
                }
                catch (Exception cleanupFailure)
                {
                    failure.Data["AuthoringPreparationCleanupFailure"] = cleanupFailure;
                }
                finally
                {
                    stage.ReleasePackageScope();
                }
            }
            throw;
        }
        finally
        {
            held?.Dispose();
        }
    }

    public ValueTask ActivateAtomicallyAsync(VerifiedAuthoringPackage package,
        ImmutableArray<AuthoringExecutionTarget> targets, long generation, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        throw new AuthoringExtensionContractException("production_prepared_generation_required");
    }

    public async ValueTask<AuthoringLifecycleResourceReport> RevokeAllAsync(
        string extensionId, long generation, CancellationToken cancellationToken)
    {
        PreparedGeneration? prepared;
        lock (_generationLock)
        {
            _generations.TryGetValue(extensionId, out prepared);
            AuthoringExtensionProductionPreflight.Require(generation > 0
                && (prepared is null || generation >= prepared.Generation), "production_revoke_generation_stale");
        }
        if (prepared is null)
        {
            _ = await HostResources.RevokeAllAsync(extensionId, cancellationToken).ConfigureAwait(false);
            throw new AuthoringExtensionContractException("production_generation_custody_unavailable");
        }
        return await prepared.AbortAsync(cancellationToken).ConfigureAwait(false);
    }

    public ValueTask<bool> RebindGenerationAsync(string extensionId, long expectedGeneration,
        long replacementGeneration, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        // A new generation needs fresh snapshot acceptance and publication; a
        // scalar rebind cannot manufacture either from an existing native lease.
        throw new AuthoringExtensionContractException("production_prepared_generation_rebind_unsupported");
    }

    private void ReleaseSettled(PreparedGeneration generation)
    {
        lock (_generationLock)
        {
            if (_generations.TryGetValue(generation.Package.Contract.Manifest.Id, out PreparedGeneration? current)
                && ReferenceEquals(current, generation))
            {
                _generations.Remove(generation.Package.Contract.Manifest.Id);
            }
        }
    }

    private sealed class PreparedGeneration : IAuthoringPreparedLifecycleGenerationV1
    {
        private readonly AuthoringExtensionProductionComposition _owner;
        private readonly AuthoringExtensionHostResourceAuthority.StagedRegistrations _stage;
        private readonly AuthoringExtensionLifecycleResources _nativeResources;
        private readonly ImmutableArray<AuthoringExecutionTarget> _targets;
        private readonly AuthoringStateSnapshot _snapshot;
        private readonly AuthoringExtensionApprovalExecutionResult _executionResult;
        private readonly SemaphoreSlim _gate = new(1, 1);
        private readonly List<WorkerCustody> _workers = [];
        private readonly List<ServiceCustody> _services = [];
        private bool _startupCustodyUnknown;
        private bool _aborting;
        private bool _aborted;
        private bool _everPublished;
        private AuthoringLifecycleReceipt? _starting;

        internal PreparedGeneration(AuthoringExtensionProductionComposition owner,
            AuthoringExtensionHostResourceAuthority.StagedRegistrations stage,
            ImmutableArray<AuthoringExecutionTarget> targets, AuthoringStateSnapshot snapshot, long generation)
        {
            _owner = owner;
            _stage = stage;
            _targets = [.. targets];
            _snapshot = snapshot;
            Generation = generation;
            _executionResult = owner.Preflight.FreezeExecutionResult(snapshot, _targets, generation);
            _nativeResources = new(stage, stage.Filters);
        }

        internal VerifiedAuthoringPackage Package => _stage.Package;
        internal long Generation
        {
            get;
        }

        internal async ValueTask<IAuthoringExtensionApprovalExecutionResultScope> AcquireExecutionResultScopeAsync(
            NpgsqlConnection connection, NpgsqlTransaction transaction, CancellationToken cancellationToken)
        {
            await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                AuthoringExtensionProductionPreflight.Require(!_aborting && !_aborted
                    && _everPublished && _stage.Published && !_startupCustodyUnknown,
                    "production_execution_generation_custody_unavailable");
                VerifyNativeOwners();
                // This is the final actor-pinned transaction path. Do not call
                // VerifyCoreAsync: its unjoined diagnostics read issuer/receipt
                // owners independently. No state scope acquired before actor
                // pinning, copied snapshot or result record can be imported here.
                await VerifyNativeSnapshotsAsync(cancellationToken).ConfigureAwait(false);
                await using IAuthoringExtensionStateObservation stateCustody = await _owner.AcquireSettledStateCustodyAsync(
                    connection, transaction, cancellationToken).ConfigureAwait(false);
                await stateCustody.VerifyCurrentAsync(cancellationToken).ConfigureAwait(false);
                // The original old-generation settlement lifetime is still
                // required alongside that same original settled-state scope.
                // Native acceptance alone cannot manufacture the result scope.
                throw new AuthoringExtensionContractException("production_joined_settlement_custody_unavailable");
            }
            finally
            {
                _gate.Release();
            }
        }

        internal async ValueTask StartAsync(CancellationToken cancellationToken)
        {
            // Abort cannot settle an empty generation while its first native
            // launch is still entering custody. Use the same gate as all later
            // verification, publication and cleanup across every startup await.
            await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                await StartCoreAsync(cancellationToken).ConfigureAwait(false);
            }
            finally
            {
                _gate.Release();
            }
        }

        private async ValueTask StartCoreAsync(CancellationToken cancellationToken)
        {
            if (!OperatingSystem.IsLinux())
            {
                throw new AuthoringExtensionContractException("production_platform_unsupported");
            }
            _starting = await _owner.Preflight.ReadLatestReceiptAsync(Package.Contract.Manifest.Id, cancellationToken).ConfigureAwait(false);
            RequireStarting(_starting);
            await _nativeResources.ActivateAtomicallyAsync(Package, _targets, Generation, cancellationToken).ConfigureAwait(false);
            foreach (AuthoringExecutionTarget target in _targets)
            {
                AuthoringPackageEntry entry = Package.Contents.Entries.Single(item => item.Path == target.EntrypointIdentity);
                AuthoringResourceLimits limits = Package.Contract.Manifest.Limits;
                string hostApi = Digest(string.Join(':', "authoring-host-api", Package.Contract.Manifest.HostApi.Minimum,
                    Package.Contract.Manifest.HostApi.Maximum));
                // Schema identity describes the existing v1 state contract. It
                // does not substitute snapshot content for a schema digest.
                string schema = Digest("authoring-state-contract/v1:" + Package.Contract.Manifest.StateSchemaVersion
                    .ToString(CultureInfo.InvariantCulture));
                string policy = _owner.Preflight.RequireClaimDigest();
                if (target.ExecutionClass == AuthoringExecutionClass.IsolatedWorkerWasm)
                {
                    AuthoringExtensionProductionPreflight.Require(_owner.Providers.Worker is not null
                        && limits.MemoryBytes >= 65_536, "production_worker_launch_provider_missing");
                    string instance = Digest(string.Join('\n', "authoring-prepared-worker/v1", target.RuntimeIdentity,
                        Package.PackageIdentity, Generation.ToString(CultureInfo.InvariantCulture), _snapshot.ContentSha256,
                        policy, Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32))));
                    var descriptor = new AuthoringWorkerLaunchDescriptor(target.RuntimeIdentity, instance,
                        target.ExtensionId, target.ExtensionVersion, target.PackageSha256, Package.Contract.Manifest.ContentSha256,
                        target.ContributionId, entry.ContentSha256, hostApi, schema, policy, [.. entry.Content],
                        limits.MemoryBytes, limits.MaximumRequestBytes, limits.MaximumResponseBytes);
                    _startupCustodyUnknown = true;
                    IAuthoringWorkerSandboxInstance worker = await _owner.Providers.Worker!.StartAsync(descriptor, cancellationToken).ConfigureAwait(false);
                    var custody = new WorkerCustody(worker, descriptor);
                    _workers.Add(custody);
                    _startupCustodyUnknown = false;
                    AuthoringExtensionProductionPreflight.Require(AuthoringRuntimeIncarnationLease.TryObserveWorker(
                        worker, descriptor, out AuthoringRuntimeIncarnationLease? lease), "production_native_worker_lease_missing");
                    custody.Lease = lease;
                    await _nativeResources.TrackWorkerAsync(target.ExtensionId, Generation, worker, cancellationToken).ConfigureAwait(false);
                    custody.Tracked = true;
                    custody.Acceptance = await worker.AcceptStateSnapshotAsync(Package, target, _snapshot,
                        Generation, _owner.Preflight.RequireOperationSha256(), cancellationToken).ConfigureAwait(false);
                }
                else if (target.ExecutionClass == AuthoringExecutionClass.OutOfProcessService)
                {
                    AuthoringExtensionProductionPreflight.Require(_owner.Providers.Service is not null,
                        "production_service_launch_provider_missing");
                    ImmutableArray<string> ids = await _owner.Preflight.FindBoundGrantIdsAsync(Package, target, cancellationToken).ConfigureAwait(false);
                    var descriptor = new AuthoringServiceLaunchDescriptor(target.RuntimeIdentity, target.ExtensionId,
                        target.ExtensionVersion, target.PackageSha256, Package.Contract.Manifest.ContentSha256,
                        target.ContributionId, entry.ContentSha256, [.. entry.Content], ids, Digest(string.Join('\n', ids)),
                        "authoring-service-transport/v1", limits.MemoryBytes, limits.MaximumRequestBytes,
                        limits.MaximumResponseBytes, limits.WallClock);
                    _startupCustodyUnknown = true;
                    IAuthoringServiceProcess service = await _owner.Providers.Service!.StartAsync(descriptor, cancellationToken).ConfigureAwait(false);
                    var custody = new ServiceCustody(service, descriptor);
                    _services.Add(custody);
                    _startupCustodyUnknown = false;
                    AuthoringExtensionProductionPreflight.Require(AuthoringRuntimeIncarnationLease.TryObserveService(
                        service, descriptor, out AuthoringRuntimeIncarnationLease? lease), "production_native_service_lease_missing");
                    custody.Lease = lease;
                    await _nativeResources.TrackServiceAsync(target.ExtensionId, Generation, service, cancellationToken).ConfigureAwait(false);
                    custody.Tracked = true;
                    custody.Acceptance = await service.AcceptStateSnapshotAsync(Package, target, _snapshot,
                        Generation, _owner.Preflight.RequireOperationSha256(), cancellationToken).ConfigureAwait(false);
                }
                else
                {
                    throw new AuthoringExtensionContractException("production_runtime_readiness_unsupported");
                }
            }
        }

        public async ValueTask VerifyCurrentAsync(CancellationToken cancellationToken)
        {
            await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                await VerifyCoreAsync(null, cancellationToken).ConfigureAwait(false);
            }
            finally
            {
                _gate.Release();
            }
        }

        private async ValueTask VerifyCoreAsync(AuthoringLifecycleReceipt? running, CancellationToken cancellationToken)
        {
            AuthoringExtensionProductionPreflight.Require(!_aborting && !_aborted && !_startupCustodyUnknown
                && _workers.Count + _services.Count == _targets.Length, "production_prepared_custody_not_current");
            // Before publication the stage holds the original exclusion scope.
            // Later observations must reacquire it instead of trusting an old record.
            using IAuthoringInstalledPackageReadScope? currentPackage = _stage.PackageScopeRetained ? null
                : await _owner.Preflight.AcquirePackageScopeAsync(Package, _targets, cancellationToken).ConfigureAwait(false);
            VerifyNativeOwners();
            await _owner.Preflight.VerifyClaimCurrentAsync(Package, cancellationToken).ConfigureAwait(false);
            await _owner.Preflight.VerifyCurrentGrantsAsync(Package, _targets, cancellationToken).ConfigureAwait(false);
            AuthoringExtensionProductionPreflight.Require(_owner.Preflight.IsPackageTrustCurrent(Package), "production_package_trust_expired");
            AuthoringLifecycleReceipt? latest = await _owner.Preflight.ReadLatestReceiptAsync(Package.Contract.Manifest.Id, cancellationToken).ConfigureAwait(false);
            if (running is null)
            {
                RequireStarting(latest);
                AuthoringExtensionProductionPreflight.Require(latest == _starting, "production_starting_receipt_drift");
            }
            else
            {
                AuthoringExtensionProductionPreflight.Require(latest == running && _starting is not null
                    && running.State == AuthoringLifecycleState.Running && running.Generation == Generation
                    && running.SchemaVersion == 1 && running.Sequence == running.Generation
                    && running.Sequence == _starting.Sequence + 1 && running.PreviousState == AuthoringLifecycleState.Starting
                    && running.PreviousReceiptSha256 == _starting.ReceiptSha256
                    && running.ExtensionId == Package.Contract.Manifest.Id && running.Version == Package.Contract.Manifest.Version
                    && running.PackageSha256 == Package.Contract.Manifest.PackageSha256
                    && running.StateSchemaVersion == Package.Contract.Manifest.StateSchemaVersion
                    && running.DataSchemaVersion == Package.Contract.Manifest.DataSchemaVersion
                    && running.ScopeDigest == _executionResult.ContentSha256 && running.FailureCode is null
                    && running.ReceiptSha256 == AuthoringExtensionLifecycleCoordinator.ComputeReceiptSha256(running),
                    "production_running_receipt_not_exact");
            }
            foreach (ServiceCustody service in _services)
            {
                AuthoringExecutionTarget target = _targets.Single(item => item.ContributionId == service.Descriptor.ContributionId);
                ImmutableArray<string> grantIds = await _owner.Preflight.FindBoundGrantIdsAsync(Package, target, cancellationToken).ConfigureAwait(false);
                AuthoringExtensionProductionPreflight.Require(grantIds.SequenceEqual(service.Descriptor.OpaqueGrantIds),
                    "production_service_grant_set_drift");
                AuthoringServiceHealthReport health = await service.Owner.GetHealthAsync(cancellationToken).ConfigureAwait(false);
                AuthoringExtensionProductionPreflight.Require(health.ProtocolHandshakeComplete
                    && health.RuntimeIdentity == service.Descriptor.RuntimeIdentity
                    && health.ExecutableSha256 == service.Descriptor.ExecutableSha256
                    && health.TransportSchemaReference == service.Descriptor.TransportSchemaReference,
                    "production_service_readiness_drift");
            }
            VerifyNativeOwners();
            await VerifyNativeSnapshotsAsync(cancellationToken).ConfigureAwait(false);
        }

        private async ValueTask VerifyNativeSnapshotsAsync(CancellationToken cancellationToken)
        {
            if (!OperatingSystem.IsLinux())
            {
                throw new AuthoringExtensionContractException("production_platform_unsupported");
            }
            AuthoringExtensionProductionPreflight.Require(_workers.Count + _services.Count == _targets.Length,
                "production_native_snapshot_custody_incomplete");
            string operation = _owner.Preflight.RequireOperationSha256();
            foreach (WorkerCustody worker in _workers)
            {
                AuthoringExtensionProductionPreflight.Require(worker.Acceptance is not null,
                    "production_worker_snapshot_acceptance_missing");
                AuthoringExecutionTarget target = _targets.Single(item => item.ContributionId == worker.Descriptor.ContributionId);
                await worker.Acceptance!.VerifyCurrentAsync(worker.Owner, Package, target, _snapshot,
                    Generation, operation, cancellationToken).ConfigureAwait(false);
            }
            foreach (ServiceCustody service in _services)
            {
                AuthoringExtensionProductionPreflight.Require(service.Acceptance is not null,
                    "production_service_snapshot_acceptance_missing");
                AuthoringExecutionTarget target = _targets.Single(item => item.ContributionId == service.Descriptor.ContributionId);
                await service.Acceptance!.VerifyCurrentAsync(service.Owner, Package, target, _snapshot,
                    Generation, operation, cancellationToken).ConfigureAwait(false);
            }
            VerifyNativeOwners();
        }

        private void RequireStarting(AuthoringLifecycleReceipt? starting)
        {
            AuthoringExtensionProductionPreflight.Require(starting is not null
                && starting.State == AuthoringLifecycleState.Starting && starting.Generation < long.MaxValue
                && starting.SchemaVersion == 1 && starting.Sequence == starting.Generation && starting.FailureCode is null
                && starting.Generation + 1 == Generation
                && starting.ExtensionId == Package.Contract.Manifest.Id && starting.Version == Package.Contract.Manifest.Version
                && starting.PackageSha256 == Package.Contract.Manifest.PackageSha256
                && starting.StateSchemaVersion == Package.Contract.Manifest.StateSchemaVersion
                && starting.DataSchemaVersion == Package.Contract.Manifest.DataSchemaVersion
                && starting.ScopeDigest == _owner.Preflight.RequireClaimDigest()
                && starting.ReceiptSha256 == AuthoringExtensionLifecycleCoordinator.ComputeReceiptSha256(starting),
                "production_starting_generation_not_current");
        }

        private void VerifyNativeOwners()
        {
            if (!OperatingSystem.IsLinux())
            {
                throw new AuthoringExtensionContractException("production_platform_unsupported");
            }
            foreach (WorkerCustody worker in _workers)
            {
                AuthoringExtensionProductionPreflight.Require(worker.Tracked && worker.Lease is not null && worker.Lease.IsCurrentOwner(worker.Owner)
                    && ReferenceEquals(worker.Descriptor, worker.Lease.GetWorkerDescriptor(worker.Owner)),
                    "production_tracked_worker_not_current");
            }
            foreach (ServiceCustody service in _services)
            {
                AuthoringExtensionProductionPreflight.Require(service.Tracked && service.Lease is not null && service.Lease.IsCurrentOwner(service.Owner)
                    && ReferenceEquals(service.Descriptor, service.Lease.GetServiceDescriptor(service.Owner)),
                    "production_tracked_service_not_current");
            }
        }

        public async ValueTask PublishAsync(AuthoringLifecycleReceipt exactRunningReceipt, CancellationToken cancellationToken)
        {
            await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                await VerifyCoreAsync(exactRunningReceipt, cancellationToken).ConfigureAwait(false);
                _owner.Preflight.RequireQualifiedEffects();
                await _owner.HostResources.PublishStagedAsync(_stage, Generation,
                    token => VerifyCoreAsync(exactRunningReceipt, token), VerifyNativeOwners, cancellationToken).ConfigureAwait(false);
                _everPublished = true;
                _stage.ReleasePackageScope();
            }
            finally
            {
                _gate.Release();
            }
        }

        public async ValueTask<AuthoringLifecycleResourceReport> AbortAsync(CancellationToken cancellationToken)
        {
            await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                if (_aborted)
                {
                    await RevokeAndVerifyGrantsAsync(cancellationToken).ConfigureAwait(false);
                    return new(0, 0, 0, 0, 0, 0, 0);
                }
                _aborting = true;
                await _owner.HostResources.UnpublishAsync(_stage, cancellationToken).ConfigureAwait(false);
                // Acceptance holds the original transport exclusion. Release it
                // before Resources terminates/disposes the actual native owners.
                // A failed release retains its reference and prevents settlement.
                if (OperatingSystem.IsLinux())
                {
                    foreach (WorkerCustody worker in _workers)
                    {
                        if (worker.Acceptance is not null)
                        {
                            await worker.Acceptance.DisposeAsync().ConfigureAwait(false);
                            worker.Acceptance = null;
                        }
                    }
                    foreach (ServiceCustody service in _services)
                    {
                        if (service.Acceptance is not null)
                        {
                            await service.Acceptance.DisposeAsync().ConfigureAwait(false);
                            service.Acceptance = null;
                        }
                    }
                }
                AuthoringLifecycleResourceReport remaining = await _nativeResources.RevokeAllAsync(
                    Package.Contract.Manifest.Id, Generation, cancellationToken).ConfigureAwait(false);
                foreach (WorkerCustody worker in _workers.Where(static item => !item.Tracked))
                {
                    await worker.Owner.TerminateAsync("preparation-aborted", cancellationToken).ConfigureAwait(false);
                    await worker.Owner.DisposeAsync().ConfigureAwait(false);
                }
                foreach (ServiceCustody service in _services.Where(static item => !item.Tracked))
                {
                    await service.Owner.TerminateTreeAsync("preparation-aborted", cancellationToken).ConfigureAwait(false);
                    await service.Owner.DisposeAsync().ConfigureAwait(false);
                }
                await RevokeAndVerifyGrantsAsync(cancellationToken).ConfigureAwait(false);
                AuthoringExtensionProductionPreflight.Require(!_startupCustodyUnknown,
                    "production_native_start_custody_unobservable");
                if (OperatingSystem.IsLinux())
                {
                    foreach (WorkerCustody worker in _workers)
                    {
                        AuthoringExtensionProductionPreflight.Require(worker.Lease is not null && !worker.Lease.CustodyRetained,
                            "production_native_custody_remains");
                    }
                    foreach (ServiceCustody service in _services)
                    {
                        AuthoringExtensionProductionPreflight.Require(service.Lease is not null && !service.Lease.CustodyRetained,
                            "production_native_custody_remains");
                    }
                }
                AuthoringExtensionProductionPreflight.Require(!_everPublished, "production_remaining_resource_ports_unavailable");
                if (remaining.IsEmpty)
                {
                    _aborted = true;
                    _stage.ReleasePackageScope();
                    _owner.ReleaseSettled(this);
                }
                return remaining;
            }
            finally
            {
                _gate.Release();
            }
        }

        public async ValueTask DisposeAsync()
        {
            using var cleanup = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            AuthoringLifecycleResourceReport remaining = await AbortAsync(cleanup.Token).ConfigureAwait(false);
            AuthoringExtensionProductionPreflight.Require(remaining.IsEmpty, "production_prepared_disposal_incomplete");
        }

        private async ValueTask RevokeAndVerifyGrantsAsync(CancellationToken cancellationToken)
        {
            _ = await _owner._grants.RevokeRuntimesAsync(Package.Contract.Manifest.Id,
                _targets.Select(static target => target.RuntimeIdentity).ToImmutableHashSet(StringComparer.Ordinal), cancellationToken).ConfigureAwait(false);
            foreach (AuthoringExecutionTarget target in _targets)
            {
                ImmutableArray<AuthoringCapabilityGrant> remaining = await _owner._grants.FindActiveAsync(target.ExtensionId,
                    target.ContributionId, target.RuntimeIdentity, cancellationToken).ConfigureAwait(false);
                AuthoringExtensionProductionPreflight.Require(!remaining.IsDefault && remaining.IsEmpty,
                    "production_prepared_grants_remain");
            }
        }

        private static string Digest(string value) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

        private sealed class WorkerCustody(IAuthoringWorkerSandboxInstance owner, AuthoringWorkerLaunchDescriptor descriptor)
        {
            internal IAuthoringWorkerSandboxInstance Owner => owner;
            internal AuthoringNativeStateSnapshotAcceptance? Acceptance
            {
                get; set;
            }
            internal AuthoringRuntimeIncarnationLease? Lease
            {
                get; set;
            }
            internal AuthoringWorkerLaunchDescriptor Descriptor => descriptor;
            internal bool Tracked
            {
                get; set;
            }
        }

        private sealed class ServiceCustody(IAuthoringServiceProcess owner, AuthoringServiceLaunchDescriptor descriptor)
        {
            internal IAuthoringServiceProcess Owner => owner;
            internal AuthoringNativeStateSnapshotAcceptance? Acceptance
            {
                get; set;
            }
            internal AuthoringRuntimeIncarnationLease? Lease
            {
                get; set;
            }
            internal AuthoringServiceLaunchDescriptor Descriptor => descriptor;
            internal bool Tracked
            {
                get; set;
            }
        }
    }

    /// <summary>
    /// Binds the original issuer's actual claimed state operation. Scope and actor
    /// context come exclusively from that claim; no admin-ID/user-ID mapping,
    /// approval policy or ScopeDigest encoding is introduced by this consumer.
    /// Runtime staging and common publication remain unqualified and closed.
    /// </summary>
    public static AuthoringExtensionProductionComposition ForApprovedOperation(
        LocalAuthoringPackageRuntime packages,
        IAuthoringCapabilityGrantCatalog grants,
        IAuthoringFencedExtensionStateStore stateStore,
        IAuthoringLifecycleReceiptStore receipts,
        TimeProvider timeProvider,
        AuthoringHostPlatform platform,
        IAuthoringExtensionApprovalAuthority approvals,
        AuthoringExtensionApprovalAuthority.ApprovedClaim claim,
        string grantPurpose,
        AuthoringCoreAuthorityRegistry coreAuthorities,
        ImmutableHashSet<string> coreOrUserShortcuts,
        IAuthorSavedViewQueryValidator queryValidator,
        LinuxBubblewrapWorkerOptions? workerOptions = null,
        LinuxBubblewrapServiceOptions? serviceOptions = null)
    {
        ArgumentNullException.ThrowIfNull(claim);
        // The interface has no current-claim read port. Consume the real issuer's
        // SQL-backed ReadAsync rather than substitute caller-supplied claim facts.
        if (approvals is not AuthoringExtensionApprovalAuthority issuer)
        {
            throw new AuthoringExtensionContractException("production_approval_read_owner_missing");
        }
        return new(packages, grants, stateStore, receipts, timeProvider, platform,
            AuthoringExtensionProductionPreflight.ScopeFor(claim), grantPurpose,
            coreAuthorities, coreOrUserShortcuts, queryValidator, workerOptions, serviceOptions, issuer, claim);
    }

    /// <summary>
    /// Observes only an original native worker capability and retained descriptor.
    /// A live observation still cannot attest membership in Resources or a Running receipt.
    /// </summary>
    public static AuthoringWorkerLaunchDescriptor ObserveWorker(
        IAuthoringWorkerSandboxInstance actualOwner)
    {
        if (!OperatingSystem.IsLinux())
        {
            throw new AuthoringExtensionContractException("production_platform_unsupported");
        }
        AuthoringExtensionProductionPreflight.Require(
            AuthoringRuntimeIncarnationLease.TryObserveWorker(actualOwner, out AuthoringRuntimeIncarnationLease? lease),
            "production_native_worker_lease_missing");
        AuthoringWorkerLaunchDescriptor descriptor = lease!.GetWorkerDescriptor(actualOwner);
        AuthoringExtensionProductionPreflight.Require(lease.IsCurrentOwner(actualOwner), "production_native_worker_lease_stale");
        return descriptor;
    }

    /// <summary>Reads real service custody; health flags and scalar runtime identities cannot issue a lease.</summary>
    public static async ValueTask<AuthoringServiceLaunchDescriptor> ObserveServiceAsync(
        IAuthoringServiceProcess actualOwner,
        CancellationToken cancellationToken = default)
    {
        using var operation = AuthoringExtensionProductionPreflight.BoundOperation(cancellationToken);
        cancellationToken = operation.Token;
        if (!OperatingSystem.IsLinux())
        {
            throw new AuthoringExtensionContractException("production_platform_unsupported");
        }
        AuthoringExtensionProductionPreflight.Require(
            AuthoringRuntimeIncarnationLease.TryObserveService(actualOwner, out AuthoringRuntimeIncarnationLease? lease),
            "production_native_service_lease_missing");
        AuthoringServiceLaunchDescriptor descriptor = lease!.GetServiceDescriptor(actualOwner);
        AuthoringServiceHealthReport health = await actualOwner.GetHealthAsync(cancellationToken).ConfigureAwait(false);
        AuthoringExtensionProductionPreflight.Require(health.ProtocolHandshakeComplete
            && health.RuntimeIdentity == descriptor.RuntimeIdentity && health.ExecutableSha256 == descriptor.ExecutableSha256
            && health.TransportSchemaReference == descriptor.TransportSchemaReference && lease.IsCurrentOwner(actualOwner),
            "production_native_service_readiness_drift");
        return descriptor;
    }
}
