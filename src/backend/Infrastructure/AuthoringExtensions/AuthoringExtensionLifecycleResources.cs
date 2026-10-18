using System.Collections.Immutable;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

public sealed record AuthoringLifecycleHostResourceReport(
    int ContributionRegistrations,
    int RpcRequests,
    int Grants,
    int ScheduledJobs,
    int HostSurfaces);

public interface IAuthoringLifecycleHostResourceAuthority
{
    ValueTask ActivateAtomicallyAsync(
        VerifiedAuthoringPackage package,
        ImmutableArray<AuthoringExecutionTarget> targets,
        CancellationToken cancellationToken);

    ValueTask<AuthoringLifecycleHostResourceReport> RevokeAllAsync(
        string extensionId,
        CancellationToken cancellationToken);
}

/// <summary>Implemented by the original host resource owner only when it can hold its exact roster.</summary>
public interface IAuthoringLifecycleHostSettlementAuthority : IAuthoringLifecycleHostResourceAuthority
{
    ValueTask ActivateGenerationAtomicallyAsync(
        VerifiedAuthoringPackage package,
        ImmutableArray<AuthoringExecutionTarget> targets,
        long generation,
        CancellationToken cancellationToken);

    ValueTask<IAuthoringLifecycleHostSettlementScope?> AcquireSettlementScopeAsync(
        string extensionId,
        long generation,
        ImmutableArray<AuthoringExecutionTarget> targets,
        CancellationToken cancellationToken);
}

/// <summary>
/// Holds the exact old generation's registrations, RPC, grants, jobs and surfaces against mutation.
/// A separately activated newer generation must not invalidate or be revoked by this scope.
/// Null means the complete remaining roster is unknown. Dispose releases that original exclusion.
/// Neither a cached receipt nor caller-supplied counts implement this lifetime.
/// </summary>
public interface IAuthoringLifecycleHostSettlementScope : IDisposable
{
    ValueTask<AuthoringLifecycleHostResourceReport?> RevokeAllAsync(CancellationToken cancellationToken);
}

public sealed class AuthoringExtensionLifecycleResources(
    IAuthoringLifecycleHostResourceAuthority hostResources,
    AuthoringFilterRegistryAuthority? filterRegistry = null) : IAuthoringLifecycleResourceAuthority
{
    private readonly Lock _lock = new();
    private readonly SemaphoreSlim _lifecycleGate = new(1, 1);
    private readonly object _settlementKey = new();
    private readonly Dictionary<string, ActiveResources> _active = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> _quarantined = new(StringComparer.Ordinal);
    private readonly Dictionary<string, ImmutableArray<AuthoringExecutionTarget>> _targetHistory = new(StringComparer.Ordinal);

    public async ValueTask ActivateAtomicallyAsync(
        VerifiedAuthoringPackage package,
        ImmutableArray<AuthoringExecutionTarget> targets,
        long generation,
        CancellationToken cancellationToken)
    {
        await _lifecycleGate.WaitAsync(cancellationToken);
        try
        {
            if (targets.IsDefault || generation < 1)
            {
                throw new AuthoringExtensionContractException("Lifecycle activation targets or generation are missing.");
            }

            string historyKey = HistoryKey(package);
            if (targets.IsEmpty)
            {
                lock (_lock)
                {
                    if (!_targetHistory.TryGetValue(historyKey, out targets))
                    {
                        throw new AuthoringExtensionContractException("Lifecycle rollback has no exact prior runtime mapping.");
                    }
                }
            }

            ValidateTargets(package, targets);
            ActiveResources? previous;
            lock (_lock)
            {
                if (_quarantined.ContainsKey(package.Contract.Manifest.Id))
                {
                    throw new AuthoringExtensionContractException("Quarantined extension requires an explicit host re-enable approval.");
                }

                _active.TryGetValue(package.Contract.Manifest.Id, out previous);
                if (previous is not null &&
                    (generation <= previous.Generation ||
                        (!previous.Retired && previous.Settlement?.CleanupReport?.IsEmpty != true)))
                {
                    throw new AuthoringExtensionContractException("Lifecycle activation would overlap existing runtime authority.");
                }
            }

            if (filterRegistry is null && package.Contract.Manifest.Contributions.Any(static contribution =>
                contribution.Kind == AuthoringContributionKind.ArticleLibraryFilter))
            {
                throw new AuthoringFilterContractException("filter_registry_unavailable");
            }
            filterRegistry?.ValidateActivation(package, targets);
            if (hostResources is IAuthoringLifecycleHostSettlementAuthority settlementAuthority)
            {
                await settlementAuthority.ActivateGenerationAtomicallyAsync(package, targets, generation, cancellationToken);
            }
            else
            {
                await hostResources.ActivateAtomicallyAsync(package, targets, cancellationToken);
            }
            cancellationToken.ThrowIfCancellationRequested();
            filterRegistry?.ActivateAtomically(package, targets);
            lock (_lock)
            {
                _targetHistory[historyKey] = [.. targets];
                _active[package.Contract.Manifest.Id] = new ActiveResources(package, targets, generation)
                {
                    Previous = previous
                };
            }
        }
        finally
        {
            _lifecycleGate.Release();
        }
    }

    public async ValueTask TrackWorkerAsync(
        string extensionId,
        long generation,
        IAuthoringWorkerSandboxInstance worker,
        CancellationToken cancellationToken = default)
    {
        if (cancellationToken.IsCancellationRequested)
        {
            await TerminateAndDisposeWorkerAsync(new(worker), "lifecycle-track-cancelled");
            cancellationToken.ThrowIfCancellationRequested();
        }

        if (!TryTrack(extensionId, generation, worker, static resources => resources.Workers))
        {
            await TerminateAndDisposeWorkerAsync(new(worker), "lifecycle-not-active");
            throw new AuthoringExtensionContractException("Worker started outside an active lifecycle generation.");
        }
    }

    public async ValueTask TrackServiceAsync(
        string extensionId,
        long generation,
        IAuthoringServiceProcess service,
        CancellationToken cancellationToken = default)
    {
        if (cancellationToken.IsCancellationRequested)
        {
            await TerminateAndDisposeServiceAsync(new(service), "lifecycle-track-cancelled");
            cancellationToken.ThrowIfCancellationRequested();
        }

        if (!TryTrack(extensionId, generation, service, static resources => resources.Services))
        {
            await TerminateAndDisposeServiceAsync(new(service), "lifecycle-not-active");
            throw new AuthoringExtensionContractException("Service started outside an active lifecycle generation.");
        }
    }

    public ValueTask ReleaseWorkerAsync(
        string extensionId,
        long generation,
        IAuthoringWorkerSandboxInstance worker) =>
        ReleaseAsync(extensionId, generation, worker, static resources => resources.Workers);

    public ValueTask ReleaseServiceAsync(
        string extensionId,
        long generation,
        IAuthoringServiceProcess service) =>
        ReleaseAsync(extensionId, generation, service, static resources => resources.Services);

    /// <summary>
    /// Captures the original generation and excludes its mutation until release. A known, fully
    /// settled old generation may coexist with newer preparation. Missing history is never recreated.
    /// </summary>
    public async ValueTask<SettlementScope> AcquireSettlementScopeAsync(
        string extensionId,
        long expectedGeneration,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await _lifecycleGate.WaitAsync(cancellationToken);
        SettlementScope? scope = null;
        try
        {
            lock (_lock)
            {
                if (expectedGeneration < 1 ||
                    FindGeneration(extensionId, expectedGeneration) is not ActiveResources resources ||
                    (resources.Settlement is not null && !resources.Settlement.AcquisitionFailed) ||
                    (resources.Revoking && !resources.SettlementRequired))
                {
                    throw new AuthoringExtensionContractException("Exact original lifecycle roster is unavailable or held.");
                }

                scope = resources.Settlement ?? new SettlementScope(this, extensionId, expectedGeneration, _settlementKey);
                scope.MarkAcquisitionFailed(_settlementKey, false);
                resources.Settlement = scope;
                resources.SettlementRequired = true;
                resources.Revoking = true;
            }

            if (!scope.HasHostScope && hostResources is IAuthoringLifecycleHostSettlementAuthority authority)
            {
                scope.AttachHostScope(_settlementKey, await authority.AcquireSettlementScopeAsync(
                    extensionId, expectedGeneration, scope.Targets, cancellationToken));
            }
            cancellationToken.ThrowIfCancellationRequested();
            return scope;
        }
        catch (Exception exception)
        {
            if (scope is not null)
            {
                lock (_lock)
                {
                    scope.MarkAcquisitionFailed(_settlementKey, true);
                }
            }
            try
            {
                scope?.Dispose();
            }
            catch (Exception releaseFailure)
            {
                exception.Data["LifecycleSettlementReleaseFailure"] = releaseFailure;
            }
            throw;
        }
        finally
        {
            _lifecycleGate.Release();
        }
    }

    public ValueTask<AuthoringLifecycleResourceReport> RevokeAllAsync(
        string extensionId,
        long generation,
        CancellationToken cancellationToken) =>
        RevokeAllCoreAsync(extensionId, generation, null, cancellationToken);

    private async ValueTask<AuthoringLifecycleResourceReport> RevokeAllCoreAsync(
        string extensionId,
        long generation,
        SettlementScope? settlement,
        CancellationToken cancellationToken)
    {
        await _lifecycleGate.WaitAsync(cancellationToken);
        try
        {
            TrackedResource<IAuthoringWorkerSandboxInstance>[] workers;
            TrackedResource<IAuthoringServiceProcess>[] services;
            lock (_lock)
            {
                ActiveResources? resources = settlement is null
                    ? _active.GetValueOrDefault(extensionId)
                    : FindGeneration(extensionId, generation);
                if (resources is null)
                {
                    if (settlement is not null)
                    {
                        throw new AuthoringExtensionContractException("Original lifecycle settlement history is unavailable.");
                    }
                    workers = [];
                    services = [];
                }
                else if (generation < 1 || resources.Generation > generation)
                {
                    throw new AuthoringExtensionContractException(
                        "Lifecycle resource revocation generation is older than the active generation.");
                }
                else if ((settlement is not null && !ReferenceEquals(resources.Settlement, settlement)) ||
                    (resources.SettlementRequired && settlement is null))
                {
                    throw new AuthoringExtensionContractException("The original lifecycle settlement scope owns revocation.");
                }
                else
                {
                    resources.Revoking = true;
                    workers = [.. resources.Workers];
                    services = [.. resources.Services];
                }
            }

            int workerFailures = 0;
            int serviceFailures = 0;
            foreach (TrackedResource<IAuthoringWorkerSandboxInstance> worker in workers)
            {
                try
                {
                    await TerminateAndDisposeWorkerAsync(worker, "lifecycle-revoked");
                    lock (_lock)
                    {
                        if (settlement is null)
                        {
                            _active[extensionId].Workers.Remove(worker);
                        }
                    }
                }
                catch
                {
                    workerFailures++;
                }
            }

            foreach (TrackedResource<IAuthoringServiceProcess> service in services)
            {
                try
                {
                    await TerminateAndDisposeServiceAsync(service, "lifecycle-revoked");
                    lock (_lock)
                    {
                        if (settlement is null)
                        {
                            _active[extensionId].Services.Remove(service);
                        }
                    }
                }
                catch
                {
                    serviceFailures++;
                }
            }

            if (settlement is null || _active[extensionId].Generation == generation)
            {
                filterRegistry?.Remove(extensionId);
            }
            AuthoringLifecycleHostResourceReport? host;
            if (settlement is null)
            {
                host = await hostResources.RevokeAllAsync(extensionId, CancellationToken.None);
            }
            else if (settlement.HasHostScope)
            {
                host = await settlement.RevokeHostScopeAsync(_settlementKey, CancellationToken.None);
            }
            else
            {
                // The old cleanup callback may still revoke resources, but it holds no host roster.
                await hostResources.RevokeAllAsync(extensionId, CancellationToken.None);
                host = null;
            }
            if (settlement is not null)
            {
                lock (_lock)
                {
                    settlement.RecordHostReport(_settlementKey, host);
                }
            }
            if (host is null)
            {
                throw new AuthoringExtensionContractException("Lifecycle host settlement resources remain unknown.");
            }
            if (settlement is not null && !settlement.NativeCustodySettled)
            {
                throw new AuthoringExtensionContractException("Lifecycle native settlement custody is unavailable or retained.");
            }
            var report = new AuthoringLifecycleResourceReport(
                host.ContributionRegistrations,
                workerFailures,
                serviceFailures,
                host.RpcRequests,
                host.Grants,
                host.ScheduledJobs,
                host.HostSurfaces);
            if (settlement is not null)
            {
                lock (_lock)
                {
                    settlement.RecordCleanupReport(_settlementKey, report);
                }
            }
            else if (report.IsEmpty)
            {
                lock (_lock)
                {
                    if (!_active.TryGetValue(extensionId, out ActiveResources? current))
                    {
                        return report;
                    }
                    if (current.Previous is null)
                    {
                        _active.Remove(extensionId);
                    }
                    else
                    {
                        current.Retired = true;
                    }
                }
            }

            return report;
        }
        finally
        {
            _lifecycleGate.Release();
        }
    }

    public async ValueTask<bool> RebindGenerationAsync(
        string extensionId,
        long expectedGeneration,
        long replacementGeneration,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(extensionId) || expectedGeneration < 1 || replacementGeneration < 1)
        {
            throw new AuthoringExtensionContractException("Lifecycle generation rebind is missing or invalid.");
        }

        await _lifecycleGate.WaitAsync(cancellationToken);
        try
        {
            lock (_lock)
            {
                if (!_active.TryGetValue(extensionId, out ActiveResources? resources))
                {
                    return false;
                }

                if (resources.Retired)
                {
                    return false;
                }

                if (resources.Generation != expectedGeneration || resources.Revoking)
                {
                    throw new AuthoringExtensionContractException(
                        "Lifecycle generation rebind is stale or already revoking.");
                }

                resources.Generation = replacementGeneration;
                return true;
            }
        }
        finally
        {
            _lifecycleGate.Release();
        }
    }

    public async ValueTask QuarantineAsync(
        string extensionId,
        long generation,
        string reason,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(extensionId) || string.IsNullOrWhiteSpace(reason) || reason.Length > 128)
        {
            throw new AuthoringExtensionContractException("Quarantine identity or reason is missing or unbounded.");
        }

        lock (_lock)
        {
            _quarantined[extensionId] = reason;
        }

        AuthoringLifecycleResourceReport remaining = await RevokeAllAsync(
            extensionId,
            generation,
            cancellationToken);
        if (!remaining.IsEmpty)
        {
            throw new AuthoringExtensionContractException("Quarantine left active authoring extension resources.");
        }
    }

    public ValueTask ClearQuarantineAsync(
        string extensionId,
        string expectedReason,
        string approvalReceiptId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (string.IsNullOrWhiteSpace(approvalReceiptId))
        {
            throw new AuthoringExtensionContractException("Quarantine re-enable requires an explicit approval receipt.");
        }

        lock (_lock)
        {
            if (!_quarantined.TryGetValue(extensionId, out string? reason) ||
                !string.Equals(reason, expectedReason, StringComparison.Ordinal))
            {
                throw new AuthoringExtensionContractException("Quarantine reason drifted before re-enable approval.");
            }

            _quarantined.Remove(extensionId);
        }

        return ValueTask.CompletedTask;
    }

    private bool TryTrack<T>(
        string extensionId,
        long generation,
        T resource,
        Func<ActiveResources, List<TrackedResource<T>>> select)
        where T : class, IAsyncDisposable
    {
        if (string.IsNullOrWhiteSpace(extensionId) || generation < 1 || resource is null)
        {
            return false;
        }

        TrackedResource<T> entry = CaptureTrackedResource(resource);
        lock (_lock)
        {
            if (!_active.TryGetValue(extensionId, out ActiveResources? resources) ||
                resources.Generation != generation || resources.Revoking)
            {
                return false;
            }

            List<TrackedResource<T>> tracked = select(resources);
            if (!tracked.Any(candidate => ReferenceEquals(candidate.Instance, resource)))
            {
                tracked.Add(entry);
            }
            return true;
        }
    }

    private ActiveResources? FindGeneration(string extensionId, long generation)
    {
        _active.TryGetValue(extensionId, out ActiveResources? resources);
        while (resources is not null && resources.Generation != generation)
        {
            resources = resources.Previous;
        }
        return resources;
    }

    private static TrackedResource<T> CaptureTrackedResource<T>(T instance)
        where T : class, IAsyncDisposable
    {
        var entry = new TrackedResource<T>(instance);
        if (!OperatingSystem.IsLinux())
        {
            return entry;
        }
        try
        {
            if (instance is IAuthoringWorkerSandboxInstance worker &&
                AuthoringRuntimeIncarnationLease.TryObserveWorker(worker, out AuthoringRuntimeIncarnationLease? workerLease))
            {
                entry.Incarnation = workerLease;
                entry.WorkerDescriptor = workerLease.GetWorkerDescriptor(worker);
            }
            else if (instance is IAuthoringServiceProcess service &&
                AuthoringRuntimeIncarnationLease.TryObserveService(service, out AuthoringRuntimeIncarnationLease? serviceLease))
            {
                entry.Incarnation = serviceLease;
                entry.ServiceDescriptor = serviceLease.GetServiceDescriptor(service);
            }
        }
        catch (AuthoringExtensionContractException)
        {
            // A concurrently ended owner cannot supply a new live descriptor. Keep that history unknown.
        }
        return entry;
    }

    private static bool NativeCustodyIsSettled<T>(TrackedResource<T> resource)
        where T : class, IAsyncDisposable =>
        OperatingSystem.IsLinux() && resource.Disposed &&
        (resource.WorkerDescriptor is not null || resource.ServiceDescriptor is not null) &&
        resource.Incarnation is not null && !resource.Incarnation.CustodyRetained;

    private async ValueTask ReleaseAsync<T>(
        string extensionId,
        long generation,
        T resource,
        Func<ActiveResources, List<TrackedResource<T>>> select)
        where T : class, IAsyncDisposable
    {
        TrackedResource<T>? tracked;
        TaskCompletionSource? completion = null;
        Task release;
        lock (_lock)
        {
            if (generation < 1 ||
                !_active.TryGetValue(extensionId, out ActiveResources? resources) ||
                generation > resources.Generation || resources.Revoking)
            {
                return;
            }

            tracked = select(resources).Find(candidate => ReferenceEquals(candidate.Instance, resource));
            if (tracked is null)
            {
                return;
            }

            if (tracked.ReleaseTask is null)
            {
                completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
                tracked.ReleaseTask = completion.Task;
            }
            release = tracked.ReleaseTask;
        }

        if (completion is not null)
        {
            try
            {
                await resource.DisposeAsync();
                lock (_lock)
                {
                    tracked.Disposed = true;
                    tracked.Failure = null;
                    if (!_active[extensionId].SettlementRequired && NativeCustodyIsSettled(tracked))
                    {
                        select(_active[extensionId]).Remove(tracked);
                    }
                }
                completion.SetResult();
            }
            catch (Exception exception)
            {
                lock (_lock)
                {
                    tracked.Failure = exception;
                }
                completion.SetException(exception);
            }
        }

        await release;
    }

    private ValueTask TerminateAndDisposeWorkerAsync(
        TrackedResource<IAuthoringWorkerSandboxInstance> worker,
        string reason) =>
        TerminateAndDisposeAsync(worker,
            instance => instance.TerminateAsync(reason, CancellationToken.None),
            "Lifecycle could not confirm worker termination before disposal.");

    private ValueTask TerminateAndDisposeServiceAsync(
        TrackedResource<IAuthoringServiceProcess> service,
        string reason) =>
        TerminateAndDisposeAsync(service,
            instance => instance.TerminateTreeAsync(reason, CancellationToken.None),
            "Lifecycle could not confirm service-tree termination before disposal.");

    private async ValueTask TerminateAndDisposeAsync<T>(
        TrackedResource<T> resource,
        Func<T, ValueTask> terminate,
        string terminationFailure)
        where T : class, IAsyncDisposable
    {
        if (resource.ReleaseTask is not null)
        {
            try
            {
                await resource.ReleaseTask;
            }
            catch
            {
                // Release reports its failure to its callers; revoke retains the cleanup retry.
            }
        }

        if (!resource.Disposed)
        {
            bool terminated = false;
            try
            {
                await terminate(resource.Instance);
                terminated = true;
            }
            catch (Exception exception)
            {
                lock (_lock)
                {
                    resource.Failure = exception;
                }
            }

            lock (_lock)
            {
                resource.TerminationSucceeded = terminated;
            }
            try
            {
                await resource.Instance.DisposeAsync();
                lock (_lock)
                {
                    resource.Disposed = true;
                    resource.TerminationFailed = !terminated;
                    if (terminated)
                    {
                        resource.Failure = null;
                    }
                }
            }
            catch (Exception exception)
            {
                lock (_lock)
                {
                    resource.Failure = exception;
                }
                throw;
            }
        }

        if (resource.TerminationFailed)
        {
            // Successful disposal cannot be repeated to confirm an earlier failed termination.
            throw new AuthoringExtensionContractException(terminationFailure);
        }
    }

    private static void ValidateTargets(
        VerifiedAuthoringPackage package,
        ImmutableArray<AuthoringExecutionTarget> targets)
    {
        if (targets.Length != package.Contract.Manifest.Contributions.Length ||
            targets.Any(target => target.Status != AuthoringExecutionResolutionStatus.Ready ||
                !string.Equals(target.ExtensionId, package.Contract.Manifest.Id, StringComparison.Ordinal) ||
                !string.Equals(target.ExtensionVersion, package.Contract.Manifest.Version, StringComparison.Ordinal) ||
                !string.Equals(target.PackageSha256, package.Contract.Manifest.PackageSha256, StringComparison.Ordinal)) ||
            targets.Select(static target => target.ContributionId).Distinct(StringComparer.Ordinal).Count() != targets.Length)
        {
            throw new AuthoringExtensionContractException("Lifecycle activation mapping is partial, stale, or duplicated.");
        }
    }

    private static string HistoryKey(VerifiedAuthoringPackage package) =>
        string.Join(':',
            package.Contract.Manifest.Id,
            package.Contract.Manifest.Version,
            package.Contract.Manifest.PackageSha256,
            package.Contract.Manifest.ContentSha256);

    private sealed class ActiveResources(
        VerifiedAuthoringPackage package,
        ImmutableArray<AuthoringExecutionTarget> targets,
        long generation)
    {
        public VerifiedAuthoringPackage Package { get; } = package;

        public ImmutableArray<AuthoringExecutionTarget> Targets { get; } = targets;

        public long Generation { get; set; } = generation;

        public List<TrackedResource<IAuthoringWorkerSandboxInstance>> Workers { get; } = [];

        public List<TrackedResource<IAuthoringServiceProcess>> Services { get; } = [];

        public bool Revoking
        {
            get; set;
        }

        public SettlementScope? Settlement;

        public bool SettlementRequired;

        public bool Retired;

        public ActiveResources? Previous;
    }

    private sealed class TrackedResource<T>(T instance)
        where T : class, IAsyncDisposable
    {
        public T Instance { get; } = instance;

        public Task? ReleaseTask
        {
            get; set;
        }

        public bool Disposed
        {
            get; set;
        }

        public bool TerminationFailed
        {
            get; set;
        }

        public bool? TerminationSucceeded;

        public Exception? Failure;

        public AuthoringRuntimeIncarnationLease? Incarnation;

        public AuthoringWorkerLaunchDescriptor? WorkerDescriptor;

        public AuthoringServiceLaunchDescriptor? ServiceDescriptor;
    }

    /// <summary>Owner-observed cleanup facts for one exact retained lease; null termination means unattempted.</summary>
    public sealed record LeaseCleanupFacts(
        bool DisposalSucceeded,
        bool? TerminationSucceeded,
        Exception? Failure,
        bool? NativeCustodyRetained);

    /// <summary>
    /// An original-owner exclusion lifetime, not a receipt or execution-result authority. The native
    /// producer must verify the retained runtime instances itself. Failed or unknown cleanup keeps
    /// the old generation closed after Dispose; successful cleanup is retired only at Dispose.
    /// </summary>
    public sealed class SettlementScope : IDisposable
    {
        private readonly AuthoringExtensionLifecycleResources _owner;
        private readonly ActiveResources _resources;
        private readonly TrackedResource<IAuthoringWorkerSandboxInstance>[] _workers;
        private readonly TrackedResource<IAuthoringServiceProcess>[] _services;
        private IAuthoringLifecycleHostSettlementScope? _hostScope;
        private AuthoringLifecycleHostResourceReport? _hostReport;
        private AuthoringLifecycleResourceReport? _report;
        private bool _acquisitionFailed;
        private Task? _settlementTask;
        private Exception? _failure;
        private Exception? _releaseFailure;
        private bool _released;
        private bool _disposing;

        internal SettlementScope(AuthoringExtensionLifecycleResources owner, string extensionId, long generation, object key)
        {
            _owner = owner;
            RequireOwner(key);
            ActiveResources resources = owner.FindGeneration(extensionId, generation) ??
                throw new AuthoringExtensionContractException("Original lifecycle generation is unavailable.");
            _resources = resources;
            _workers = [.. resources.Workers];
            _services = [.. resources.Services];
            Generation = resources.Generation;
            Workers = [.. _workers.Select(static entry => entry.Instance)];
            Services = [.. _services.Select(static entry => entry.Instance)];
        }

        internal bool HasHostScope => _hostScope is not null;

        internal bool AcquisitionFailed => _acquisitionFailed;

        private void RequireOwner(object key)
        {
            if (!ReferenceEquals(key, _owner._settlementKey))
            {
                throw new AuthoringExtensionContractException("Only the original resource owner can record settlement facts.");
            }
        }

        internal void MarkAcquisitionFailed(object key, bool failed)
        {
            RequireOwner(key);
            _acquisitionFailed = failed;
        }

        internal void AttachHostScope(object key, IAuthoringLifecycleHostSettlementScope? scope)
        {
            RequireOwner(key);
            _hostScope = scope;
        }

        internal ValueTask<AuthoringLifecycleHostResourceReport?> RevokeHostScopeAsync(object key, CancellationToken token)
        {
            RequireOwner(key);
            return (_hostScope ?? throw new AuthoringExtensionContractException("Original held host scope is unavailable."))
                .RevokeAllAsync(token);
        }

        internal void RecordHostReport(object key, AuthoringLifecycleHostResourceReport? report)
        {
            RequireOwner(key);
            _hostReport = report;
        }

        internal void RecordCleanupReport(object key, AuthoringLifecycleResourceReport report)
        {
            RequireOwner(key);
            _report = report;
        }

        public VerifiedAuthoringPackage Package => _resources.Package;

        public string ExtensionId => Package.Contract.Manifest.Id;

        public long Generation
        {
            get;
        }

        public ImmutableArray<AuthoringExecutionTarget> Targets => _resources.Targets;

        public ImmutableArray<IAuthoringWorkerSandboxInstance> Workers
        {
            get;
        }

        public ImmutableArray<IAuthoringServiceProcess> Services
        {
            get;
        }

        public bool NativeCustodySettled =>
            OperatingSystem.IsLinux() &&
            _workers.All(NativeCustodyIsSettled) && _services.All(NativeCustodyIsSettled);

        public AuthoringRuntimeIncarnationLease? GetWorkerIncarnation(IAuthoringWorkerSandboxInstance worker) =>
            _workers.Single(entry => ReferenceEquals(entry.Instance, worker)).Incarnation;

        public AuthoringRuntimeIncarnationLease? GetServiceIncarnation(IAuthoringServiceProcess service) =>
            _services.Single(entry => ReferenceEquals(entry.Instance, service)).Incarnation;

        public AuthoringWorkerLaunchDescriptor? GetWorkerDescriptor(IAuthoringWorkerSandboxInstance worker) =>
            _workers.Single(entry => ReferenceEquals(entry.Instance, worker)).WorkerDescriptor;

        public AuthoringServiceLaunchDescriptor? GetServiceDescriptor(IAuthoringServiceProcess service) =>
            _services.Single(entry => ReferenceEquals(entry.Instance, service)).ServiceDescriptor;

        public AuthoringLifecycleHostResourceReport? HostCleanupReport
        {
            get
            {
                lock (_owner._lock)
                {
                    return _hostReport;
                }
            }
        }

        public AuthoringLifecycleResourceReport? CleanupReport
        {
            get
            {
                lock (_owner._lock)
                {
                    return _report;
                }
            }
        }

        public Exception? CleanupFailure
        {
            get
            {
                lock (_owner._lock)
                {
                    return _failure;
                }
            }
        }

        public Exception? ReleaseFailure
        {
            get
            {
                lock (_owner._lock)
                {
                    return _releaseFailure;
                }
            }
        }

        public bool IsReleased
        {
            get
            {
                lock (_owner._lock)
                {
                    return _released;
                }
            }
        }

        public LeaseCleanupFacts GetWorkerCleanupFacts(IAuthoringWorkerSandboxInstance worker)
        {
            lock (_owner._lock)
            {
                TrackedResource<IAuthoringWorkerSandboxInstance> entry = _workers.Single(
                    entry => ReferenceEquals(entry.Instance, worker));
                return new(entry.Disposed, entry.TerminationSucceeded, entry.Failure,
                    OperatingSystem.IsLinux() ? entry.Incarnation?.CustodyRetained : null);
            }
        }

        public LeaseCleanupFacts GetServiceCleanupFacts(IAuthoringServiceProcess service)
        {
            lock (_owner._lock)
            {
                TrackedResource<IAuthoringServiceProcess> entry = _services.Single(
                    entry => ReferenceEquals(entry.Instance, service));
                return new(entry.Disposed, entry.TerminationSucceeded, entry.Failure,
                    OperatingSystem.IsLinux() ? entry.Incarnation?.CustodyRetained : null);
            }
        }

        public async ValueTask SettleAsync(CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            TaskCompletionSource? completion = null;
            Task pending;
            lock (_owner._lock)
            {
                ObjectDisposedException.ThrowIf(_released, this);
                if (!ReferenceEquals(_resources.Settlement, this))
                {
                    throw new AuthoringExtensionContractException("Lifecycle settlement scope is not the original holder.");
                }
                if (_disposing)
                {
                    throw new AuthoringExtensionContractException("Lifecycle settlement scope is releasing.");
                }
                if (_settlementTask is null || (_settlementTask.IsCompleted && _report?.IsEmpty != true))
                {
                    completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
                    _settlementTask = completion.Task;
                    _report = null;
                    _hostReport = null;
                    _failure = null;
                }
                pending = _settlementTask;
            }
            if (completion is not null)
            {
                try
                {
                    await _owner.RevokeAllCoreAsync(ExtensionId, Generation, this, cancellationToken);
                    completion.SetResult();
                }
                catch (Exception exception)
                {
                    lock (_owner._lock)
                    {
                        _failure = exception;
                    }
                    completion.SetException(exception);
                }
            }
            await pending;
        }

        public void Dispose()
        {
            lock (_owner._lock)
            {
                if (_released)
                {
                    return;
                }
                if (!ReferenceEquals(_resources.Settlement, this))
                {
                    throw new AuthoringExtensionContractException("Lifecycle settlement scope is not the original holder.");
                }
                if (_disposing || _settlementTask is { IsCompleted: false })
                {
                    throw new AuthoringExtensionContractException("Lifecycle cleanup must settle before scope release.");
                }
                _disposing = true;
            }
            try
            {
                _hostScope?.Dispose();
            }
            catch (Exception exception)
            {
                lock (_owner._lock)
                {
                    _disposing = false;
                    _releaseFailure ??= exception;
                }
                throw;
            }
            lock (_owner._lock)
            {
                if (_report?.IsEmpty == true && _failure is null)
                {
                    _resources.Retired = true;
                }
                _resources.Settlement = null;
                _released = true;
                _disposing = false;
            }
        }
    }
}
