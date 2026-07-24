using FsusBlog.Server.Infrastructure.Distributed.Cluster;
using FsusBlog.Server.Infrastructure.Distributed.StateControl;

namespace FsusBlog.Server.Infrastructure.Distributed.Scheduling;

public sealed class LeasedModuleResponsibilityRuntime(
    ILeaseManager leases,
    ClusterMembershipOptions cluster,
    IAdaptiveSchedulerRuntimeOptionsSource options,
    TimeProvider timeProvider) : IResponsibilityRuntime, IResponsibilityActivationView
{
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly Dictionary<(ResponsibilityId Id, int Replica), RuntimeEntry> _active = [];

    public async ValueTask ActivateAsync(
        ResponsibilityAssignment assignment,
        CancellationToken cancellationToken)
    {
        if (assignment.NodeId != cluster.NodeId)
        {
            throw new InvalidOperationException("responsibility_activation_target_not_local");
        }

        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var key = (assignment.ResponsibilityId, assignment.Replica);
            DateTimeOffset now = timeProvider.GetUtcNow();
            if (cluster.Mode == ClusterRuntimeMode.Single)
            {
                _active[key] = new RuntimeEntry(
                    new ActiveResponsibility(assignment, now, now),
                    null);
                return;
            }

            AdaptiveSchedulerRuntimeOptions runtimeOptions = options.Current();
            if (_active.TryGetValue(key, out RuntimeEntry? current))
            {
                if (current.Lease is null
                    || !await leases.RenewAsync(
                        current.Lease.LeaseId,
                        current.Lease.FencingToken,
                        runtimeOptions.LeaseTtl,
                        cancellationToken).ConfigureAwait(false))
                {
                    _active.Remove(key);
                    throw new InvalidOperationException("responsibility_lease_lost");
                }
                _active[key] = current with
                {
                    Active = current.Active with
                    {
                        Assignment = assignment with
                        {
                            FencingToken = current.Lease.FencingToken
                        },
                        LastLeaseRenewedAt = now
                    }
                };
                return;
            }

            LeaseAcquireResult acquired = await leases.TryAcquireAsync(
                new LeaseKey(
                    "responsibility",
                    $"{assignment.ResponsibilityId.Value}.{assignment.Replica}"),
                cluster.NodeId,
                runtimeOptions.LeaseTtl,
                cancellationToken).ConfigureAwait(false);
            if (!acquired.Acquired || acquired.Lease is null)
            {
                throw new InvalidOperationException("responsibility_lease_contended");
            }
            ResponsibilityAssignment fenced = assignment with
            {
                FencingToken = acquired.Lease.FencingToken
            };
            _active[key] = new RuntimeEntry(
                new ActiveResponsibility(fenced, now, now),
                acquired.Lease);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async ValueTask DeactivateAsync(
        ResponsibilityId responsibilityId,
        CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            RuntimeEntry[] removed = _active
                .Where(entry => entry.Key.Id == responsibilityId)
                .Select(static entry => entry.Value)
                .ToArray();
            foreach ((ResponsibilityId Id, int Replica) key in _active.Keys
                .Where(key => key.Id == responsibilityId)
                .ToArray())
            {
                _active.Remove(key);
            }
            foreach (RuntimeEntry entry in removed)
            {
                if (entry.Lease is not null)
                {
                    _ = await leases.ReleaseAsync(
                        entry.Lease.LeaseId,
                        entry.Lease.FencingToken,
                        cancellationToken).ConfigureAwait(false);
                }
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    public async ValueTask<IReadOnlyList<ActiveResponsibility>> ListActiveAsync(
        CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            return _active.Values
                .Select(static entry => entry.Active)
                .OrderBy(static active => active.Assignment.ResponsibilityId.Value, StringComparer.Ordinal)
                .ThenBy(static active => active.Assignment.Replica)
                .ToArray();
        }
        finally
        {
            _gate.Release();
        }
    }

    public bool IsCapabilityActive(CapabilityId capability)
    {
        _gate.Wait();
        try
        {
            return _active.Values.Any(
                entry => entry.Active.Assignment.Capability == capability);
        }
        finally
        {
            _gate.Release();
        }
    }

    private sealed record RuntimeEntry(
        ActiveResponsibility Active,
        DistributedLease? Lease);
}

public sealed class ResponsibilityAssignmentState(
    ClusterMembershipOptions cluster,
    TimeProvider timeProvider) : IResponsibilityAssignmentSnapshotProvider
{
    private ResponsibilityAssignmentSnapshot _snapshot =
        ResponsibilityAssignmentSnapshot.Empty(cluster.Mode, timeProvider.GetUtcNow(), true);

    public ResponsibilityAssignmentSnapshot Capture() => Volatile.Read(ref _snapshot);

    internal void Publish(ResponsibilityAssignmentSnapshot snapshot)
        => Volatile.Write(ref _snapshot, snapshot);
}

public sealed class ResponsibilityAssignmentHostedService(
    IResponsibilityAssignmentPlanner planner,
    IResponsibilityRuntime runtime,
    ResponsibilityAssignmentState state,
    ClusterMembershipOptions cluster,
    IAdaptiveSchedulerRuntimeOptionsSource options,
    TimeProvider timeProvider,
    ILogger<ResponsibilityAssignmentHostedService> logger) : BackgroundService
{
    public async ValueTask<ResponsibilityAssignmentSnapshot> ReconcileOnceAsync(
        CancellationToken cancellationToken)
    {
        ResponsibilityAssignmentSnapshot previous = state.Capture();
        ResponsibilityAssignmentSnapshot planned =
            await planner.PlanAsync(previous, cancellationToken).ConfigureAwait(false);
        IReadOnlyList<ActiveResponsibility> active =
            await runtime.ListActiveAsync(cancellationToken).ConfigureAwait(false);

        foreach (IGrouping<ResponsibilityId, ActiveResponsibility> group in active
            .GroupBy(static item => item.Assignment.ResponsibilityId))
        {
            ResponsibilityAssignment[] desired = planned.Assignments
                .Where(assignment => assignment.NodeId == cluster.NodeId
                    && assignment.ResponsibilityId == group.Key)
                .ToArray();
            bool unchanged = desired.Length == group.Count()
                && desired.All(assignment => group.Any(
                    item => item.Assignment.Replica == assignment.Replica));
            if (!unchanged)
            {
                await runtime.DeactivateAsync(group.Key, cancellationToken).ConfigureAwait(false);
            }
        }

        foreach (ResponsibilityAssignment assignment in planned.Assignments
            .Where(assignment => assignment.NodeId == cluster.NodeId))
        {
            // Existing assignments are intentionally activated again to renew their
            // lease and refresh the fenced local module-routing view.
            await runtime.ActivateAsync(assignment, cancellationToken).ConfigureAwait(false);
        }

        IReadOnlyDictionary<(ResponsibilityId Id, int Replica), FencingToken?> localFences =
            (await runtime.ListActiveAsync(cancellationToken).ConfigureAwait(false))
                .ToDictionary(
                    static item => (
                        item.Assignment.ResponsibilityId,
                        item.Assignment.Replica),
                    static item => item.Assignment.FencingToken);
        ResponsibilityAssignmentSnapshot observed = planned with
        {
            Assignments = planned.Assignments
                .Select(assignment =>
                    assignment.NodeId == cluster.NodeId
                    && localFences.TryGetValue(
                        (assignment.ResponsibilityId, assignment.Replica),
                        out FencingToken? token)
                        ? assignment with
                        {
                            FencingToken = token
                        }
                        : assignment)
                .ToArray()
        };
        state.Publish(observed);
        return observed;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await ReconcileOnceAsync(stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception exception)
            {
                logger.LogError(exception, "responsibility-scheduler-reconcile-failed");
            }

            try
            {
                await Task.Delay(
                    options.Current().ReconcileInterval,
                    timeProvider,
                    stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
        }
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        // Stop and join the reconcile loop before releasing leases; otherwise an
        // in-flight cycle could reactivate a responsibility after shutdown cleanup.
        await base.StopAsync(cancellationToken).ConfigureAwait(false);
        IReadOnlyList<ActiveResponsibility> active =
            await runtime.ListActiveAsync(cancellationToken).ConfigureAwait(false);
        foreach (ResponsibilityId id in active
            .Select(static item => item.Assignment.ResponsibilityId)
            .Distinct())
        {
            await runtime.DeactivateAsync(id, cancellationToken).ConfigureAwait(false);
        }
    }
}
