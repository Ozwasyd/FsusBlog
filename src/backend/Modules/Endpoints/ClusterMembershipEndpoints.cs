using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Distributed.Cluster;
using FsusBlog.Server.Infrastructure.Distributed.Scheduling;
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
            [FromServices] IResponsibilityAssignmentSnapshotProvider assignments,
            CancellationToken cancellationToken) =>
        {
            IReadOnlyList<NodeDescriptor> nodes =
                await store.ListNodesAsync(cancellationToken).ConfigureAwait(false);
            ResponsibilityAssignmentSnapshot assignmentSnapshot = assignments.Capture();
            return Results.Json(new
            {
                enabled = options.Enabled,
                mode = ClusterMembershipWireNames.Mode(options.Mode),
                currentNodeId = options.NodeId.Value,
                scheduler = new
                {
                    assignmentSnapshot.Generation,
                    assignmentSnapshot.ObservedAt,
                    assignmentSnapshot.Mode,
                    assignmentSnapshot.Enabled,
                    assignments = assignmentSnapshot.Assignments.Select(static assignment => new
                    {
                        responsibilityId = assignment.ResponsibilityId.Value,
                        capability = assignment.Capability.Value,
                        assignment.Replica,
                        nodeId = assignment.NodeId.Value,
                        assignment.AssignedAt,
                        assignment.PlacementScore,
                        assignment.Reason,
                        fencingToken = assignment.FencingToken?.Value
                    }),
                    assignmentSnapshot.Unassigned
                },
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
