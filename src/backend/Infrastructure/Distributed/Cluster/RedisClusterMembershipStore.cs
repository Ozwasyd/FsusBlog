using System.Text.Json;

using FsusBlog.Server.Infrastructure.Cache;

using StackExchange.Redis;

namespace FsusBlog.Server.Infrastructure.Distributed.Cluster;

public sealed class RedisClusterMembershipStore(
    IConnectionMultiplexer redis,
    IRuntimeKeyScope runtimeKeyScope) : IClusterMembershipStore
{
    private static readonly JsonSerializerOptions s_jsonOptions = new(JsonSerializerDefaults.Web);
    private readonly RedisKey _membershipKey =
        runtimeKeyScope.PrefixKey("fsus:cluster:membership:v1");

    public async ValueTask UpsertNodeAsync(
        NodeDescriptor node,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await Database.HashSetAsync(
            _membershipKey,
            node.NodeId.Value,
            JsonSerializer.Serialize(node, s_jsonOptions)).ConfigureAwait(false);
    }

    public ValueTask MarkHeartbeatAsync(
        NodeHeartbeat heartbeat,
        CancellationToken cancellationToken)
        => UpdateAsync(
            heartbeat.NodeId,
            node => node.InstanceId == heartbeat.InstanceId
                && node.Status is not ClusterMemberStatus.Draining
                    and not ClusterMemberStatus.Maintenance
                    ? node with
                    {
                        Status = ClusterMemberStatus.Alive,
                        LastHeartbeatAt = heartbeat.ObservedAt,
                        Resources = heartbeat.Resources,
                        ActiveResponsibilities = heartbeat.ActiveResponsibilities
                    }
                    : node,
            cancellationToken);

    public async ValueTask<IReadOnlyList<NodeDescriptor>> ListAliveNodesAsync(
        CancellationToken cancellationToken)
        => (await ListNodesAsync(cancellationToken).ConfigureAwait(false))
            .Where(static node => node.Status == ClusterMemberStatus.Alive)
            .ToArray();

    public async ValueTask<IReadOnlyList<NodeDescriptor>> ListNodesAsync(
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        HashEntry[] entries = await Database.HashGetAllAsync(_membershipKey).ConfigureAwait(false);
        return entries
            .Select(static entry => JsonSerializer.Deserialize<NodeDescriptor>(
                entry.Value.ToString(),
                s_jsonOptions))
            .OfType<NodeDescriptor>()
            .OrderBy(static node => node.NodeId.Value, StringComparer.Ordinal)
            .ToArray();
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
        => UpdateAsync(
            nodeId,
            node => expectedInstanceId == Guid.Empty || node.InstanceId == expectedInstanceId
                ? node with
                {
                    Status = status
                }
                : node,
            cancellationToken);

    public async ValueTask DetectFailuresAsync(
        DateTimeOffset observedAt,
        TimeSpan suspectAfter,
        TimeSpan deadAfter,
        CancellationToken cancellationToken)
    {
        if (deadAfter <= suspectAfter)
        {
            throw new ArgumentOutOfRangeException(nameof(deadAfter));
        }
        IReadOnlyList<NodeDescriptor> nodes = await ListNodesAsync(cancellationToken).ConfigureAwait(false);
        foreach (NodeDescriptor snapshot in nodes)
        {
            await UpdateAsync(
                snapshot.NodeId,
                node =>
                {
                    if (node.InstanceId != snapshot.InstanceId
                        || node.Status is ClusterMemberStatus.Draining
                            or ClusterMemberStatus.Maintenance)
                    {
                        return node;
                    }
                    TimeSpan elapsed = observedAt - node.LastHeartbeatAt;
                    return elapsed >= deadAfter
                        ? node with
                        {
                            Status = ClusterMemberStatus.Dead
                        }
                        : elapsed >= suspectAfter
                            ? node with
                            {
                                Status = ClusterMemberStatus.Suspect
                            }
                            : node;
                },
                cancellationToken).ConfigureAwait(false);
        }
    }

    private IDatabase Database => redis.GetDatabase();

    private async ValueTask UpdateAsync(
        NodeId nodeId,
        Func<NodeDescriptor, NodeDescriptor> update,
        CancellationToken cancellationToken)
    {
        for (int attempt = 0; attempt < 5; attempt++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            RedisValue current = await Database.HashGetAsync(
                _membershipKey,
                nodeId.Value).ConfigureAwait(false);
            if (current.IsNullOrEmpty)
            {
                return;
            }
            NodeDescriptor? descriptor = JsonSerializer.Deserialize<NodeDescriptor>(
                current.ToString(),
                s_jsonOptions);
            if (descriptor is null)
            {
                return;
            }
            string updated = JsonSerializer.Serialize(update(descriptor), s_jsonOptions);
            ITransaction transaction = Database.CreateTransaction();
            transaction.AddCondition(Condition.HashEqual(_membershipKey, nodeId.Value, current));
            _ = transaction.HashSetAsync(_membershipKey, nodeId.Value, updated);
            if (await transaction.ExecuteAsync().ConfigureAwait(false))
            {
                return;
            }
        }
        throw new InvalidOperationException("cluster_membership_concurrent_update_exhausted");
    }
}
