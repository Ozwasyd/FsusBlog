using FsusBlog.Server.Infrastructure.Distributed.Cluster;

namespace FsusBlog.Server.Infrastructure.Distributed.Scheduling;

public sealed record AdaptiveSchedulerRuntimeOptions(
    bool Enabled,
    TimeSpan ReconcileInterval,
    TimeSpan LeaseTtl)
{
    public const string SectionName = "Runtime:Scheduler";

    public static AdaptiveSchedulerRuntimeOptions FromConfiguration(IConfiguration configuration)
    {
        IConfigurationSection section = configuration.GetSection(SectionName);
        int intervalSeconds = Math.Clamp(section.GetValue("ReconcileSeconds", 10), 1, 300);
        int leaseSeconds = Math.Clamp(
            section.GetValue("LeaseTtlSeconds", Math.Max(30, intervalSeconds * 3)),
            intervalSeconds + 1,
            1800);
        return new AdaptiveSchedulerRuntimeOptions(
            section.GetValue("Enabled", true),
            TimeSpan.FromSeconds(intervalSeconds),
            TimeSpan.FromSeconds(leaseSeconds));
    }
}

public interface IAdaptiveSchedulerRuntimeOptionsSource
{
    AdaptiveSchedulerRuntimeOptions Current();
}

public sealed class ConfigurationAdaptiveSchedulerRuntimeOptionsSource(
    IConfiguration configuration) : IAdaptiveSchedulerRuntimeOptionsSource
{
    public AdaptiveSchedulerRuntimeOptions Current()
        => AdaptiveSchedulerRuntimeOptions.FromConfiguration(configuration);
}

public sealed class AdaptiveResponsibilityScheduler(
    IClusterMembershipStore membership,
    ClusterMembershipOptions cluster,
    IAdaptiveSchedulerRuntimeOptionsSource options,
    TimeProvider timeProvider) : IResponsibilityAssignmentPlanner
{
    public async ValueTask<ResponsibilityAssignmentSnapshot> PlanAsync(
        ResponsibilityAssignmentSnapshot previous,
        CancellationToken cancellationToken)
    {
        DateTimeOffset now = timeProvider.GetUtcNow();
        AdaptiveSchedulerRuntimeOptions runtime = options.Current();
        if (!runtime.Enabled)
        {
            return new ResponsibilityAssignmentSnapshot(
                previous.Generation + 1,
                now,
                ClusterMembershipWireNames.Mode(cluster.Mode),
                false,
                [],
                []);
        }

        if (cluster.Mode == ClusterRuntimeMode.Single)
        {
            return PlanSingle(previous, now);
        }

        IReadOnlyList<NodeDescriptor> nodes =
            await membership.ListNodesAsync(cancellationToken).ConfigureAwait(false);
        return cluster.Mode == ClusterRuntimeMode.StaticRole
            ? PlanStatic(previous, nodes, now)
            : PlanAdaptive(previous, nodes, now);
    }

    private ResponsibilityAssignmentSnapshot PlanSingle(
        ResponsibilityAssignmentSnapshot previous,
        DateTimeOffset now)
    {
        ResponsibilityAssignment[] assignments = CoreResponsibilityCatalog.All
            .Select(descriptor => PreserveOrCreate(
                previous,
                descriptor,
                0,
                cluster.NodeId,
                now,
                0,
                "single-local-fast-path"))
            .ToArray();
        return Snapshot(previous, now, true, assignments, []);
    }

    private ResponsibilityAssignmentSnapshot PlanStatic(
        ResponsibilityAssignmentSnapshot previous,
        IReadOnlyList<NodeDescriptor> nodes,
        DateTimeOffset now)
    {
        var assignments = new List<ResponsibilityAssignment>();
        var unassigned = new List<string>();
        foreach (ResponsibilityDescriptor descriptor in CoreResponsibilityCatalog.All)
        {
            NodeDescriptor[] candidates = Eligible(nodes, descriptor)
                .OrderBy(static node => node.NodeId.Value, StringComparer.Ordinal)
                .Take(descriptor.MaxReplicas)
                .ToArray();
            if (candidates.Length == 0)
            {
                unassigned.Add($"{descriptor.Id}:no-healthy-capability");
                continue;
            }
            for (int replica = 0; replica < candidates.Length; replica++)
            {
                assignments.Add(PreserveOrCreate(
                    previous,
                    descriptor,
                    replica,
                    candidates[replica].NodeId,
                    now,
                    Score(candidates[replica], descriptor),
                    "static-capability"));
            }
        }
        return Snapshot(previous, now, true, assignments, unassigned);
    }

    private ResponsibilityAssignmentSnapshot PlanAdaptive(
        ResponsibilityAssignmentSnapshot previous,
        IReadOnlyList<NodeDescriptor> nodes,
        DateTimeOffset now)
    {
        var assignments = new List<ResponsibilityAssignment>();
        var unassigned = new List<string>();
        foreach (ResponsibilityDescriptor descriptor in CoreResponsibilityCatalog.All)
        {
            NodeDescriptor[] candidates = Eligible(nodes, descriptor)
                .OrderBy(node => Score(node, descriptor))
                .ThenBy(static node => node.NodeId.Value, StringComparer.Ordinal)
                .ToArray();
            if (candidates.Length == 0)
            {
                unassigned.Add($"{descriptor.Id}:no-healthy-capability");
                continue;
            }

            int desiredReplicas = ResolveReplicaCount(descriptor, candidates, previous, now);
            var usedNodes = new HashSet<NodeId>();
            for (int replica = 0; replica < desiredReplicas; replica++)
            {
                ResponsibilityAssignment? current = previous.Assignments.FirstOrDefault(
                    assignment => assignment.ResponsibilityId == descriptor.Id
                        && assignment.Replica == replica);
                NodeDescriptor best = candidates.FirstOrDefault(node => !usedNodes.Contains(node.NodeId))
                    ?? candidates[replica % candidates.Length];
                NodeDescriptor selected = SelectWithStability(
                    descriptor,
                    current,
                    best,
                    candidates,
                    now);
                usedNodes.Add(selected.NodeId);
                double score = Score(selected, descriptor);
                string reason = current is null
                    ? "adaptive-initial"
                    : current.NodeId == selected.NodeId
                        ? "adaptive-stable"
                        : "adaptive-reassigned";
                assignments.Add(current is not null && current.NodeId == selected.NodeId
                    ? current with
                    {
                        PlacementScore = score,
                        Reason = reason,
                        FencingToken = null
                    }
                    : new ResponsibilityAssignment(
                        descriptor.Id,
                        descriptor.RequiredCapability,
                        replica,
                        selected.NodeId,
                        now,
                        score,
                        reason));
            }
        }
        return Snapshot(previous, now, true, assignments, unassigned);
    }

    private static IEnumerable<NodeDescriptor> Eligible(
        IReadOnlyList<NodeDescriptor> nodes,
        ResponsibilityDescriptor descriptor)
        => nodes.Where(static node =>
                node.Status == ClusterMemberStatus.Alive
                && node.Resources.NetworkReachable)
            .Where(node => node.Capabilities.Contains(descriptor.RequiredCapability));

    private static int ResolveReplicaCount(
        ResponsibilityDescriptor descriptor,
        IReadOnlyList<NodeDescriptor> candidates,
        ResponsibilityAssignmentSnapshot previous,
        DateTimeOffset now)
    {
        int capacity = Math.Min(descriptor.MaxReplicas, candidates.Count);
        int minimum = Math.Min(descriptor.MinReplicas, capacity);
        int previousCount = previous.Assignments.Count(
            assignment => assignment.ResponsibilityId == descriptor.Id);
        double pressure = candidates.Max(node => Pressure(node, descriptor));
        if (pressure >= descriptor.Policy.ScaleOutPressure)
        {
            int increment = pressure >= 0.90 ? 2 : 1;
            return Math.Clamp(Math.Max(minimum, previousCount) + increment, minimum, capacity);
        }
        if (previousCount > minimum
            && pressure <= descriptor.Policy.ScaleInPressure
            && PreviousAssignmentsOldEnough(descriptor, previous, now))
        {
            return Math.Max(minimum, previousCount - 1);
        }
        return Math.Clamp(Math.Max(minimum, previousCount), minimum, capacity);
    }

    private static bool PreviousAssignmentsOldEnough(
        ResponsibilityDescriptor descriptor,
        ResponsibilityAssignmentSnapshot previous,
        DateTimeOffset now)
        => previous.Assignments
            .Where(assignment => assignment.ResponsibilityId == descriptor.Id)
            .All(assignment => now - assignment.AssignedAt >= descriptor.Policy.Cooldown);

    private static NodeDescriptor SelectWithStability(
        ResponsibilityDescriptor descriptor,
        ResponsibilityAssignment? current,
        NodeDescriptor best,
        IReadOnlyList<NodeDescriptor> candidates,
        DateTimeOffset now)
    {
        if (current is null)
        {
            return best;
        }
        NodeDescriptor? currentNode = candidates.FirstOrDefault(node => node.NodeId == current.NodeId);
        if (currentNode is null)
        {
            return best;
        }
        TimeSpan age = now - current.AssignedAt;
        if (age < descriptor.Policy.MinimumRunTime || age < descriptor.Policy.Cooldown)
        {
            return currentNode;
        }
        double improvement = Score(currentNode, descriptor) - Score(best, descriptor);
        double requiredImprovement =
            descriptor.Policy.HysteresisScore + descriptor.Policy.MigrationCost;
        return improvement > requiredImprovement ? best : currentNode;
    }

    private static double Score(NodeDescriptor node, ResponsibilityDescriptor descriptor)
    {
        double pressure = Pressure(node, descriptor);
        double localityBonus = node.ActiveResponsibilities.Contains(descriptor.RequiredCapability)
            ? 0.05
            : 0;
        double leasePenalty = Math.Clamp(node.Resources.ActiveLeaseCount / 100d, 0, 1) * 0.04;
        return Math.Round(Math.Max(0, pressure + leasePenalty - localityBonus), 6);
    }

    private static double Pressure(NodeDescriptor node, ResponsibilityDescriptor descriptor)
    {
        ResponsibilityResourceProfile weights = descriptor.ResourceProfile;
        double gcHeapPressure = Math.Clamp(
            node.Resources.ManagedHeapBytes / (2d * 1024 * 1024 * 1024),
            0,
            1);
        double memoryPressure = Math.Max(
            NormalizePercent(node.Resources.MemoryPressurePercent),
            gcHeapPressure);
        double weighted =
            NormalizePercent(node.Resources.CpuUsagePercent) * weights.CpuWeight
            + memoryPressure * weights.MemoryWeight
            + NormalizePercent(node.Resources.IoPressurePercent) * weights.IoWeight
            + Math.Clamp(node.Resources.QueueLength / 1000d, 0, 1) * weights.QueueWeight
            + Math.Clamp(node.Resources.P99LatencyMilliseconds / 2000d, 0, 1) * weights.LatencyWeight
            + Math.Clamp(node.Resources.RecentErrorRate, 0, 1) * weights.ErrorWeight;
        double weightTotal =
            weights.CpuWeight
            + weights.MemoryWeight
            + weights.IoWeight
            + weights.QueueWeight
            + weights.LatencyWeight
            + weights.ErrorWeight;
        return Math.Clamp(weighted / weightTotal, 0, 1);
    }

    private static double NormalizePercent(double value) => Math.Clamp(value / 100d, 0, 1);

    private static ResponsibilityAssignment PreserveOrCreate(
        ResponsibilityAssignmentSnapshot previous,
        ResponsibilityDescriptor descriptor,
        int replica,
        NodeId nodeId,
        DateTimeOffset now,
        double score,
        string reason)
    {
        ResponsibilityAssignment? current = previous.Assignments.FirstOrDefault(
            assignment => assignment.ResponsibilityId == descriptor.Id
                && assignment.Replica == replica
                && assignment.NodeId == nodeId);
        return current is null
            ? new ResponsibilityAssignment(
                descriptor.Id,
                descriptor.RequiredCapability,
                replica,
                nodeId,
                now,
                score,
                reason)
            : current with
            {
                PlacementScore = score,
                Reason = reason,
                FencingToken = null
            };
    }

    private ResponsibilityAssignmentSnapshot Snapshot(
        ResponsibilityAssignmentSnapshot previous,
        DateTimeOffset now,
        bool enabled,
        IReadOnlyList<ResponsibilityAssignment> assignments,
        IReadOnlyList<string> unassigned)
        => new(
            previous.Generation + 1,
            now,
            ClusterMembershipWireNames.Mode(cluster.Mode),
            enabled,
            assignments
                .OrderBy(static assignment => assignment.ResponsibilityId.Value, StringComparer.Ordinal)
                .ThenBy(static assignment => assignment.Replica)
                .ToArray(),
            unassigned.Order(StringComparer.Ordinal).ToArray());
}
