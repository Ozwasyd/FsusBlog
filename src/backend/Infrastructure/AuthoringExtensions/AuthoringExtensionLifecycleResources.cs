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
            await TerminateAndDisposeWorkerAsync(worker, "lifecycle-track-cancelled");
            cancellationToken.ThrowIfCancellationRequested();
        }

        if (!TryTrack(extensionId, generation, worker, static (resources, instance) => resources.Workers.Add(instance)))
        {
            await TerminateAndDisposeWorkerAsync(worker, "lifecycle-not-active");
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
            await TerminateAndDisposeServiceAsync(service, "lifecycle-track-cancelled");
            cancellationToken.ThrowIfCancellationRequested();
        }

        if (!TryTrack(extensionId, generation, service, static (resources, process) => resources.Services.Add(process)))
        {
            await TerminateAndDisposeServiceAsync(service, "lifecycle-not-active");
            throw new AuthoringExtensionContractException("Service started outside an active lifecycle generation.");
        }
    }

    public async ValueTask ReleaseWorkerAsync(
        string extensionId,
        long generation,
        IAuthoringWorkerSandboxInstance worker)
    {
        if (TryRelease(extensionId, generation, worker, static resources => resources.Workers))
        {
            await worker.DisposeAsync();
        }
    }

    public async ValueTask ReleaseServiceAsync(
        string extensionId,
        long generation,
        IAuthoringServiceProcess service)
    {
        if (TryRelease(extensionId, generation, service, static resources => resources.Services))
        {
            await service.DisposeAsync();
        }
    }

    public async ValueTask<AuthoringLifecycleResourceReport> RevokeAllAsync(
        string extensionId,
        long generation,
        CancellationToken cancellationToken)
    {
        await _lifecycleGate.WaitAsync(cancellationToken);
        try
        {
            IAuthoringWorkerSandboxInstance[] workers;
            IAuthoringServiceProcess[] services;
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
                    resources.Workers.Clear();
                    resources.Services.Clear();
                }
            }

            List<IAuthoringWorkerSandboxInstance> workerFailures = [];
            List<IAuthoringServiceProcess> serviceFailures = [];
            foreach (IAuthoringWorkerSandboxInstance worker in workers)
            {
                try
                {
                    await TerminateAndDisposeWorkerAsync(worker, "lifecycle-revoked");
                }
                catch
                {
                    workerFailures.Add(worker);
                }
            }

            foreach (IAuthoringServiceProcess service in services)
            {
                try
                {
                    await TerminateAndDisposeServiceAsync(service, "lifecycle-revoked");
                }
                catch
                {
                    serviceFailures.Add(service);
                }
            }

            if (workerFailures.Count > 0 || serviceFailures.Count > 0)
            {
                lock (_lock)
                {
                    if (_active.TryGetValue(extensionId, out ActiveResources? resources))
                    {
                        resources.Workers.AddRange(workerFailures);
                        resources.Services.AddRange(serviceFailures);
                    }
                }
            }

            filterRegistry?.Remove(extensionId);
            AuthoringLifecycleHostResourceReport host = await hostResources.RevokeAllAsync(
                extensionId,
                CancellationToken.None);
            var report = new AuthoringLifecycleResourceReport(
                host.ContributionRegistrations,
                workerFailures.Count,
                serviceFailures.Count,
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
        Action<ActiveResources, T> add)
        where T : class
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

            add(resources, resource);
            return true;
        }
    }

    private bool TryRelease<T>(
        string extensionId,
        long generation,
        T resource,
        Func<ActiveResources, List<T>> select)
        where T : class
    {
        lock (_lock)
        {
            if (generation < 1 ||
                !_active.TryGetValue(extensionId, out ActiveResources? resources) ||
                generation > resources.Generation)
            {
                return false;
            }

            List<T> tracked = select(resources);
            int index = tracked.FindIndex(candidate => ReferenceEquals(candidate, resource));
            if (index < 0)
            {
                return false;
            }

            tracked.RemoveAt(index);
            return true;
        }
    }

    private static async ValueTask TerminateAndDisposeWorkerAsync(
        IAuthoringWorkerSandboxInstance worker,
        string reason)
    {
        bool terminated = false;
        try
        {
            await worker.TerminateAsync(reason, CancellationToken.None);
            terminated = true;
        }
        catch
        {
        }

        await worker.DisposeAsync();
        if (!terminated)
        {
            throw new AuthoringExtensionContractException(
                "Lifecycle could not confirm worker termination before disposal.");
        }
    }

    private static async ValueTask TerminateAndDisposeServiceAsync(
        IAuthoringServiceProcess service,
        string reason)
    {
        bool terminated = false;
        try
        {
            await service.TerminateTreeAsync(reason, CancellationToken.None);
            terminated = true;
        }
        catch
        {
        }

        await service.DisposeAsync();
        if (!terminated)
        {
            throw new AuthoringExtensionContractException(
                "Lifecycle could not confirm service-tree termination before disposal.");
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

        public List<IAuthoringWorkerSandboxInstance> Workers { get; } = [];

        public List<IAuthoringServiceProcess> Services { get; } = [];

        public bool Revoking
        {
            get; set;
        }
    }
}
