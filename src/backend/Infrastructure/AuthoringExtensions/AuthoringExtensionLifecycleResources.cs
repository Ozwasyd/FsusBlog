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

public sealed class AuthoringExtensionLifecycleResources(
    IAuthoringLifecycleHostResourceAuthority hostResources,
    AuthoringFilterRegistryAuthority? filterRegistry = null) : IAuthoringLifecycleResourceAuthority
{
    private readonly Lock _lock = new();
    private readonly SemaphoreSlim _lifecycleGate = new(1, 1);
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
            lock (_lock)
            {
                if (_quarantined.ContainsKey(package.Contract.Manifest.Id))
                {
                    throw new AuthoringExtensionContractException("Quarantined extension requires an explicit host re-enable approval.");
                }

                if (_active.ContainsKey(package.Contract.Manifest.Id))
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
            await hostResources.ActivateAtomicallyAsync(package, targets, cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            filterRegistry?.ActivateAtomically(package, targets);
            lock (_lock)
            {
                _targetHistory[historyKey] = [.. targets];
                _active.Add(package.Contract.Manifest.Id, new ActiveResources(generation));
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

    public async ValueTask<AuthoringLifecycleResourceReport> RevokeAllAsync(
        string extensionId,
        long generation,
        CancellationToken cancellationToken)
    {
        await _lifecycleGate.WaitAsync(cancellationToken);
        try
        {
            TrackedResource<IAuthoringWorkerSandboxInstance>[] workers;
            TrackedResource<IAuthoringServiceProcess>[] services;
            lock (_lock)
            {
                if (!_active.TryGetValue(extensionId, out ActiveResources? resources))
                {
                    workers = [];
                    services = [];
                }
                else if (generation < 1 || resources.Generation > generation)
                {
                    throw new AuthoringExtensionContractException(
                        "Lifecycle resource revocation generation is older than the active generation.");
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
                        _active[extensionId].Workers.Remove(worker);
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
                        _active[extensionId].Services.Remove(service);
                    }
                }
                catch
                {
                    serviceFailures++;
                }
            }

            filterRegistry?.Remove(extensionId);
            AuthoringLifecycleHostResourceReport host = await hostResources.RevokeAllAsync(
                extensionId,
                CancellationToken.None);
            var report = new AuthoringLifecycleResourceReport(
                host.ContributionRegistrations,
                workerFailures,
                serviceFailures,
                host.RpcRequests,
                host.Grants,
                host.ScheduledJobs,
                host.HostSurfaces);
            if (report.IsEmpty)
            {
                lock (_lock)
                {
                    _active.Remove(extensionId);
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
                tracked.Add(new(resource));
            }
            return true;
        }
    }

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
                tracked.Disposed = true;
                lock (_lock)
                {
                    select(_active[extensionId]).Remove(tracked);
                }
                completion.SetResult();
            }
            catch (Exception exception)
            {
                completion.SetException(exception);
            }
        }

        await release;
    }

    private static ValueTask TerminateAndDisposeWorkerAsync(
        TrackedResource<IAuthoringWorkerSandboxInstance> worker,
        string reason) =>
        TerminateAndDisposeAsync(worker,
            instance => instance.TerminateAsync(reason, CancellationToken.None),
            "Lifecycle could not confirm worker termination before disposal.");

    private static ValueTask TerminateAndDisposeServiceAsync(
        TrackedResource<IAuthoringServiceProcess> service,
        string reason) =>
        TerminateAndDisposeAsync(service,
            instance => instance.TerminateTreeAsync(reason, CancellationToken.None),
            "Lifecycle could not confirm service-tree termination before disposal.");

    private static async ValueTask TerminateAndDisposeAsync<T>(
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
            catch
            {
            }

            await resource.Instance.DisposeAsync();
            resource.Disposed = true;
            resource.TerminationFailed = !terminated;
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

    private sealed class ActiveResources(long generation)
    {
        public long Generation { get; set; } = generation;

        public List<TrackedResource<IAuthoringWorkerSandboxInstance>> Workers { get; } = [];

        public List<TrackedResource<IAuthoringServiceProcess>> Services { get; } = [];

        public bool Revoking
        {
            get; set;
        }
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
    }
}
