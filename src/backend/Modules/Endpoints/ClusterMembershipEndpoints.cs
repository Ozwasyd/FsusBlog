using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Distributed.Cluster;
using FsusBlog.Server.Infrastructure.Policies;

using Microsoft.AspNetCore.Mvc;

namespace FsusBlog.Server.Modules.Endpoints;

public static class ClusterMembershipEndpoints
{
    public static IEndpointRouteBuilder MapClusterMembershipEndpoints(
        this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/ops/cluster/nodes", async (
            [FromServices] IClusterMembershipStore store,
            [FromServices] ClusterMembershipOptions options,
            CancellationToken cancellationToken) =>
        {
            IReadOnlyList<NodeDescriptor> nodes =
                await store.ListNodesAsync(cancellationToken).ConfigureAwait(false);
            return Results.Json(new
            {
                enabled = options.Enabled,
                mode = ClusterMembershipWireNames.Mode(options.Mode),
                currentNodeId = options.NodeId.Value,
                nodes = nodes.Select(static node => new
                {
                    nodeId = node.NodeId.Value,
                    instanceId = node.InstanceId,
                    version = node.Version,
                    startedAt = node.StartedAt,
                    mode = ClusterMembershipWireNames.Mode(node.Mode),
                    capabilities = node.Capabilities.Select(static capability => capability.Value),
                    status = ClusterMembershipWireNames.Status(node.Status),
                    lastHeartbeatAt = node.LastHeartbeatAt,
                    resources = node.Resources,
                    activeResponsibilities = node.ActiveResponsibilities
                        .Select(static capability => capability.Value)
                })
            });
        })
        .RequireAdminPermission(AdminPermissions.SystemConfig)
        .RequireRateLimiting("fixed_ip")
        .RequireNoStoreResponse();
        return app;
    }
}
