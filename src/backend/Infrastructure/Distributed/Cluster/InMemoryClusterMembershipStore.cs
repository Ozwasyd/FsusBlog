namespace FsusBlog.Server.Infrastructure.Distributed.Cluster;

public sealed class InMemoryClusterMembershipStore : IClusterMembershipStore
{
    private readonly object _gate = new();
    private readonly Dictionary<NodeId, NodeDescriptor> _nodes = [];

    public ValueTask UpsertNodeAsync(NodeDescriptor node, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        lock (_gate)
        {
            _nodes[node.NodeId] = node;
        }
        return ValueTask.CompletedTask;
    }

    public ValueTask MarkHeartbeatAsync(NodeHeartbeat heartbeat, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        lock (_gate)
        {
            if (_nodes.TryGetValue(heartbeat.NodeId, out NodeDescriptor? node)
                && node.InstanceId == heartbeat.InstanceId
                && node.Status is not ClusterMemberStatus.Draining
                    and not ClusterMemberStatus.Maintenance)
            {
                _nodes[heartbeat.NodeId] = node with
                {
                    Status = ClusterMemberStatus.Alive,
                    LastHeartbeatAt = heartbeat.ObservedAt,
                    Resources = heartbeat.Resources,
                    ActiveResponsibilities = heartbeat.ActiveResponsibilities
                };
            }
        }
        return ValueTask.CompletedTask;
    }

    public ValueTask<IReadOnlyList<NodeDescriptor>> ListAliveNodesAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        lock (_gate)
        {
            return ValueTask.FromResult<IReadOnlyList<NodeDescriptor>>(
                _nodes.Values
                    .Where(static node => node.Status == ClusterMemberStatus.Alive)
                    .OrderBy(static node => node.NodeId.Value, StringComparer.Ordinal)
                    .ToArray());
        }
    }

    public ValueTask<IReadOnlyList<NodeDescriptor>> ListNodesAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        lock (_gate)
        {
            return ValueTask.FromResult<IReadOnlyList<NodeDescriptor>>(
                _nodes.Values.OrderBy(static node => node.NodeId.Value, StringComparer.Ordinal).ToArray());
        }
    }

    public ValueTask MarkNodeSuspectAsync(NodeId nodeId, CancellationToken cancellationToken)
        => SetNodeStatusAsync(nodeId, ClusterMemberStatus.Suspect, cancellationToken);

    public ValueTask MarkNodeDeadAsync(NodeId nodeId, CancellationToken cancellationToken)
        => SetNodeStatusAsync(nodeId, ClusterMemberStatus.Dead, cancellationToken);

    public ValueTask SetNodeStatusAsync(
        NodeId nodeId,
        ClusterMemberStatus status,
        CancellationToken cancellationToken)
        => SetNodeStatusAsync(nodeId, Guid.Empty, status, cancellationToken);

    public ValueTask SetNodeStatusAsync(
        NodeId nodeId,
        Guid expectedInstanceId,
        ClusterMemberStatus status,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        lock (_gate)
        {
            if (_nodes.TryGetValue(nodeId, out NodeDescriptor? node)
                && (expectedInstanceId == Guid.Empty || node.InstanceId == expectedInstanceId))
            {
                _nodes[nodeId] = node with
                {
                    Status = status
                };
            }
        }
        return ValueTask.CompletedTask;
    }

    public ValueTask DetectFailuresAsync(
        DateTimeOffset observedAt,
        TimeSpan suspectAfter,
        TimeSpan deadAfter,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (deadAfter <= suspectAfter)
        {
            throw new ArgumentOutOfRangeException(nameof(deadAfter));
        }
        lock (_gate)
        {
            foreach ((NodeId nodeId, NodeDescriptor node) in _nodes.ToArray())
            {
                if (node.Status is ClusterMemberStatus.Draining or ClusterMemberStatus.Maintenance)
                {
                    continue;
                }
                TimeSpan elapsed = observedAt - node.LastHeartbeatAt;
                ClusterMemberStatus status = elapsed >= deadAfter
                    ? ClusterMemberStatus.Dead
                    : elapsed >= suspectAfter
                        ? ClusterMemberStatus.Suspect
                        : node.Status;
                _nodes[nodeId] = node with
                {
                    Status = status
                };
            }
        }
        return ValueTask.CompletedTask;
    }
}
