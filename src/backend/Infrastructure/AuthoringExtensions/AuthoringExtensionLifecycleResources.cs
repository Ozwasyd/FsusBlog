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
    IAuthoringLifecycleHostResourceAuthority hostResources) : IAuthoringLifecycleResourceAuthority
{
    private readonly Lock _lock = new();
    private readonly SemaphoreSlim _lifecycleGate = new(1, 1);
    private readonly Dictionary<string, ActiveResources> _active = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> _quarantined = new(StringComparer.Ordinal);
    private readonly Dictionary<string, ImmutableArray<AuthoringExecutionTarget>> _targetHistory = new(StringComparer.Ordinal);

    public async ValueTask ActivateAtomicallyAsync(
        VerifiedAuthoringPackage package,
        ImmutableArray<AuthoringExecutionTarget> targets,
        CancellationToken cancellationToken)
    {
        await _lifecycleGate.WaitAsync(cancellationToken);
        try
        {
            if (targets.IsDefault)
            {
                throw new AuthoringExtensionContractException("Lifecycle activation targets are missing.");
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

            await hostResources.ActivateAtomicallyAsync(package, targets, cancellationToken);
            lock (_lock)
            {
                _targetHistory[historyKey] = [.. targets];
                _active.Add(package.Contract.Manifest.Id, new ActiveResources());
            }
        }
        finally
        {
            _lifecycleGate.Release();
        }
    }

    public async ValueTask TrackWorkerAsync(
        string extensionId,
        IAuthoringWorkerSandboxInstance worker,
        CancellationToken cancellationToken = default)
    {
        if (!TryTrack(extensionId, worker, static (resources, instance) => resources.Workers.Add(instance)))
        {
            await worker.TerminateAsync("lifecycle-not-active", CancellationToken.None);
            await worker.DisposeAsync();
            throw new AuthoringExtensionContractException("Worker started outside an active lifecycle generation.");
        }
    }

    public async ValueTask TrackServiceAsync(
        string extensionId,
        IAuthoringServiceProcess service,
        CancellationToken cancellationToken = default)
    {
        if (!TryTrack(extensionId, service, static (resources, process) => resources.Services.Add(process)))
        {
            await service.TerminateTreeAsync("lifecycle-not-active", CancellationToken.None);
            await service.DisposeAsync();
            throw new AuthoringExtensionContractException("Service started outside an active lifecycle generation.");
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
            ActiveResources? resources;
            lock (_lock)
            {
                if (!_active.TryGetValue(extensionId, out resources))
                {
                    resources = null;
                }
                else
                {
                    resources.Revoking = true;
                }
            }

            int workerFailures = 0;
            int serviceFailures = 0;
            if (resources is not null)
            {
                foreach (IAuthoringWorkerSandboxInstance worker in resources.Workers)
                {
                    try
                    {
                        await worker.TerminateAsync("lifecycle-revoked", CancellationToken.None);
                        await worker.DisposeAsync();
                    }
                    catch
                    {
                        workerFailures++;
                    }
                }

                foreach (IAuthoringServiceProcess service in resources.Services)
                {
                    try
                    {
                        await service.TerminateTreeAsync("lifecycle-revoked", CancellationToken.None);
                        await service.DisposeAsync();
                    }
                    catch
                    {
                        serviceFailures++;
                    }
                }
            }

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
        T resource,
        Action<ActiveResources, T> add)
        where T : class
    {
        if (string.IsNullOrWhiteSpace(extensionId) || resource is null)
        {
            return false;
        }

        lock (_lock)
        {
            if (!_active.TryGetValue(extensionId, out ActiveResources? resources) || resources.Revoking)
            {
                return false;
            }

            add(resources, resource);
            return true;
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

    private sealed class ActiveResources
    {
        public List<IAuthoringWorkerSandboxInstance> Workers { get; } = [];

        public List<IAuthoringServiceProcess> Services { get; } = [];

        public bool Revoking
        {
            get; set;
        }
    }
}
