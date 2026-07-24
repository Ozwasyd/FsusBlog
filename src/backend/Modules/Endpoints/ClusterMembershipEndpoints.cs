using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Distributed.Cluster;
using FsusBlog.Server.Infrastructure.Distributed.StateControl;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Services.Security;

using Microsoft.AspNetCore.Mvc;

namespace FsusBlog.Server.Modules.Endpoints;

public static class ClusterMembershipEndpoints
{
    private const string AdminSensitiveAction = "admin-sensitive";
    private const string MfaProofHeader = "X-Fsus-Mfa-Proof";

    public static IEndpointRouteBuilder MapClusterMembershipEndpoints(
        this IEndpointRouteBuilder app)
    {
        RouteGroupBuilder group = app.MapGroup("/api/ops/cluster")
            .WithTags("ClusterOperations")
            .RequireAdminPermission(AdminPermissions.SystemConfig)
            .RequireRateLimiting("fixed_ip")
            .RequireNoStoreResponse();

        group.MapGet("/nodes", ReadSnapshotAsync);
        group.MapPost("/nodes/{nodeId}/state", SetNodeStateAsync);
        group.MapPost("/scheduler", SetSchedulerAsync);
        group.MapPost("/leases/{leaseId}/release-expired", ReleaseExpiredLeaseAsync);
        return app;
    }

    private static async Task<IResult> ReadSnapshotAsync(
        [FromServices] ClusterOperationsService operations,
        CancellationToken cancellationToken)
    {
        ClusterOperationsSnapshot snapshot =
            await operations.CaptureAsync(cancellationToken).ConfigureAwait(false);
        return Results.Json(new
        {
            snapshot.Enabled,
            snapshot.Mode,
            snapshot.CurrentNodeId,
            snapshot.SchedulingAllowed,
            snapshot.Health,
            scheduler = new
            {
                snapshot.Scheduler.Generation,
                snapshot.Scheduler.ObservedAt,
                snapshot.Scheduler.Mode,
                snapshot.Scheduler.Enabled,
                assignments = snapshot.Scheduler.Assignments.Select(assignment => new
                {
                    responsibilityId = assignment.ResponsibilityId.Value,
                    capability = assignment.Capability.Value,
                    assignment.Replica,
                    nodeId = assignment.NodeId.Value,
                    assignment.AssignedAt,
                    assignment.PlacementScore,
                    assignment.Reason,
                    fencingToken = assignment.FencingToken?.Value,
                    state = AssignmentState(snapshot, assignment)
                }),
                snapshot.Scheduler.Unassigned
            },
            nodes = snapshot.Nodes.Select(static node => new
            {
                nodeId = node.NodeId.Value,
                node.InstanceId,
                node.Version,
                node.StartedAt,
                mode = ClusterMembershipWireNames.Mode(node.Mode),
                capabilities = node.Capabilities.Select(static capability => capability.Value),
                status = ClusterMembershipWireNames.Status(node.Status),
                node.LastHeartbeatAt,
                resources = node.Resources,
                activeResponsibilities = node.ActiveResponsibilities
                    .Select(static capability => capability.Value)
            }),
            leases = snapshot.Leases.Select(static lease => new
            {
                key = lease.Key.ToString(),
                responsibility = lease.Key.Responsibility,
                resource = lease.Key.Resource,
                leaseId = lease.LeaseId.ToString(),
                holderNodeId = lease.HolderNodeId.Value,
                fencingToken = lease.FencingToken.Value,
                ttlMilliseconds = lease.Ttl.TotalMilliseconds,
                lease.LastRenewedAt,
                lease.ExpiresAt
            }),
            tasks = snapshot.Tasks.Select(static task => new
            {
                key = task.IdempotencyKey.ToString(),
                leaseKey = task.LeaseKey.ToString(),
                status = task.Status.ToString().ToLowerInvariant(),
                task.Attempt,
                writerNodeId = task.WriterNodeId.Value,
                fencingToken = task.FencingToken.Value,
                checkpoint = task.Checkpoint is null
                    ? null
                    : new
                    {
                        task.Checkpoint.Version,
                        task.Checkpoint.PayloadBytes,
                        task.Checkpoint.PayloadSha256,
                        task.Checkpoint.UpdatedAt
                    },
                task.LastError,
                task.UpdatedAt
            }),
            events = snapshot.Events.Select(static clusterEvent => new
            {
                clusterEvent.Sequence,
                clusterEvent.ObservedAt,
                kind = EventKind(clusterEvent.Kind),
                clusterEvent.State,
                clusterEvent.Reason,
                clusterEvent.NodeId,
                clusterEvent.ResponsibilityId,
                clusterEvent.SourceNodeId,
                clusterEvent.TargetNodeId,
                clusterEvent.TraceId
            }),
            snapshot.Metrics
        });
    }

    private static async Task<IResult> SetNodeStateAsync(
        string nodeId,
        [FromBody] ClusterNodeStateRequest request,
        HttpContext context,
        [FromServices] ClusterOperationsService operations,
        [FromServices] IAdminPrincipalService adminPrincipals,
        CancellationToken cancellationToken)
    {
        IResult? stepUp = await RequireAdminSensitiveStepUpAsync(
            context,
            adminPrincipals,
            cancellationToken).ConfigureAwait(false);
        if (stepUp is not null)
        {
            return stepUp;
        }
        if (!TryParseOperatorStatus(request.State, out ClusterMemberStatus status))
        {
            return Results.BadRequest(new
            {
                code = "cluster_node_state_invalid"
            });
        }
        try
        {
            NodeDescriptor node = await operations.SetNodeStateAsync(
                new NodeId(nodeId),
                status,
                request.Reason,
                cancellationToken).ConfigureAwait(false);
            return Results.Json(new
            {
                nodeId = node.NodeId.Value,
                status = ClusterMembershipWireNames.Status(node.Status)
            });
        }
        catch (KeyNotFoundException)
        {
            return Results.NotFound(new
            {
                code = "cluster_node_not_found"
            });
        }
        catch (InvalidOperationException exception)
        {
            return Results.Conflict(new
            {
                code = exception.Message
            });
        }
    }

    private static async Task<IResult> SetSchedulerAsync(
        [FromBody] ClusterSchedulerStateRequest request,
        HttpContext context,
        [FromServices] ClusterOperationsService operations,
        [FromServices] IAdminPrincipalService adminPrincipals,
        CancellationToken cancellationToken)
    {
        IResult? stepUp = await RequireAdminSensitiveStepUpAsync(
            context,
            adminPrincipals,
            cancellationToken).ConfigureAwait(false);
        if (stepUp is not null)
        {
            return stepUp;
        }
        bool schedulingAllowed = operations.SetSchedulingAllowed(
            request.Enabled,
            request.Reason);
        return Results.Json(new
        {
            schedulingAllowed
        });
    }

    private static async Task<IResult> ReleaseExpiredLeaseAsync(
        string leaseId,
        [FromBody] ClusterLeaseReleaseRequest request,
        HttpContext context,
        [FromServices] ClusterOperationsService operations,
        [FromServices] IAdminPrincipalService adminPrincipals,
        CancellationToken cancellationToken)
    {
        IResult? stepUp = await RequireAdminSensitiveStepUpAsync(
            context,
            adminPrincipals,
            cancellationToken).ConfigureAwait(false);
        if (stepUp is not null)
        {
            return stepUp;
        }
        if (!Guid.TryParseExact(leaseId, "N", out Guid parsedLeaseId))
        {
            return Results.BadRequest(new
            {
                code = "cluster_lease_id_invalid"
            });
        }
        bool released = await operations.ReleaseExpiredLeaseAsync(
            new LeaseId(parsedLeaseId),
            request.Reason,
            cancellationToken).ConfigureAwait(false);
        return Results.Json(new
        {
            released
        });
    }

    private static async Task<IResult?> RequireAdminSensitiveStepUpAsync(
        HttpContext context,
        IAdminPrincipalService adminPrincipals,
        CancellationToken cancellationToken)
    {
        if (!context.User.TryGetAdminPrincipalId(out long adminPrincipalId)
            || string.IsNullOrWhiteSpace(context.User.GetAdminSessionId()))
        {
            return Results.Unauthorized();
        }
        if (!TrustedRequestOrigin.RequireTrustedOriginOrReferer(context))
        {
            return Results.Json(
                new
                {
                    code = "origin_not_allowed"
                },
                statusCode: StatusCodes.Status403Forbidden);
        }
        string proofToken = context.Request.Headers.TryGetValue(MfaProofHeader, out var values)
            ? values.ToString().Trim()
            : string.Empty;
        if (string.IsNullOrWhiteSpace(proofToken)
            || !await adminPrincipals.ValidateAndConsumeAdminStepUpProofTokenAsync(
                adminPrincipalId,
                context.User.GetAdminSessionId()!,
                AdminSensitiveAction,
                proofToken,
                cancellationToken).ConfigureAwait(false))
        {
            return Results.Json(
                new
                {
                    code = "mfa_proof_required"
                },
                statusCode: StatusCodes.Status428PreconditionRequired);
        }
        return null;
    }

    internal static bool TryParseOperatorStatus(
        string? value,
        out ClusterMemberStatus status)
    {
        status = value?.Trim().ToLowerInvariant() switch
        {
            "alive" => ClusterMemberStatus.Alive,
            "draining" => ClusterMemberStatus.Draining,
            "maintenance" => ClusterMemberStatus.Maintenance,
            _ => (ClusterMemberStatus)(-1)
        };
        return Enum.IsDefined(status);
    }

    private static string AssignmentState(
        ClusterOperationsSnapshot snapshot,
        Infrastructure.Distributed.Scheduling.ResponsibilityAssignment assignment)
    {
        NodeDescriptor? node = snapshot.Nodes.FirstOrDefault(
            candidate => candidate.NodeId == assignment.NodeId);
        if (node?.Status is ClusterMemberStatus.Dead or ClusterMemberStatus.Suspect)
        {
            return "failed";
        }
        if (node?.Status is ClusterMemberStatus.Draining or ClusterMemberStatus.Maintenance)
        {
            return "migrating";
        }
        if (assignment.NodeId == new NodeId(snapshot.CurrentNodeId)
            && snapshot.Enabled
            && assignment.FencingToken is null)
        {
            return "waitingLease";
        }
        return "active";
    }

    private static string EventKind(ClusterOperationsEventKind kind)
        => kind switch
        {
            ClusterOperationsEventKind.SchedulerDecision => "scheduler-decision",
            ClusterOperationsEventKind.NodeLifecycle => "node-lifecycle",
            ClusterOperationsEventKind.ResponsibilityTransition => "responsibility-transition",
            ClusterOperationsEventKind.Lease => "lease",
            ClusterOperationsEventKind.OperatorAction => "operator-action",
            _ => throw new ArgumentOutOfRangeException(nameof(kind))
        };
}

public sealed record ClusterNodeStateRequest(string State, string Reason);

public sealed record ClusterSchedulerStateRequest(bool Enabled, string Reason);

public sealed record ClusterLeaseReleaseRequest(string Reason);
