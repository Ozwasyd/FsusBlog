using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Distributed.Cluster;
using FsusBlog.Server.Infrastructure.Distributed.StateControl;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Modules.Endpoints.Binary;
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
        RouteGroupBuilder group = app.MapGroup("/api/binary/author/ops/cluster")
            .WithTags("ClusterOperations")
            .WithMetadata(new FsusRouteKindMetadata("binary"))
            .RequireAdminPermission(AdminPermissions.SystemConfig)
            .RequireRateLimiting("fixed_ip")
            .RequireNoStoreResponse();

        group.MapGet("/nodes", ReadSnapshotAsync)
            .WithMetadata(new FsusOpenApiAedsContractMetadata(RequestFrame: null, ResponseFrame: AedsFrameType.ClusterRuntimeSnapshot));
        group.MapPost("/nodes/{nodeId}/state", SetNodeStateAsync)
            .WithMetadata(new FsusOpenApiAedsContractMetadata(RequestFrame: AedsFrameType.ClusterNodeStateRequest, ResponseFrame: AedsFrameType.ClusterRuntimeSnapshot));
        group.MapPost("/scheduler", SetSchedulerAsync)
            .WithMetadata(new FsusOpenApiAedsContractMetadata(RequestFrame: AedsFrameType.ClusterSchedulerStateRequest, ResponseFrame: AedsFrameType.ClusterRuntimeSnapshot));
        group.MapPost("/leases/{leaseId}/release-expired", ReleaseExpiredLeaseAsync)
            .WithMetadata(new FsusOpenApiAedsContractMetadata(RequestFrame: AedsFrameType.ClusterLeaseReleaseRequest, ResponseFrame: AedsFrameType.ClusterRuntimeSnapshot));
        return app;
    }

    private static async Task<IResult> ReadSnapshotAsync(
        [FromServices] ClusterOperationsService operations,
        [FromServices] IAedsEncoder aeds,
        CancellationToken cancellationToken)
    {
        ClusterOperationsSnapshot snapshot =
            await operations.CaptureAsync(cancellationToken).ConfigureAwait(false);
        return AedsJsonResults.Ok(aeds, AedsFrameType.ClusterRuntimeSnapshot, new
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
        HttpContext context,
        [FromServices] ClusterOperationsService operations,
        [FromServices] IAdminPrincipalService adminPrincipals,
        [FromServices] IAedsEncoder aeds,
        CancellationToken cancellationToken)
    {
        IResult? stepUp = await RequireAdminSensitiveStepUpAsync(
            context,
            adminPrincipals,
            aeds,
            cancellationToken).ConfigureAwait(false);
        if (stepUp is not null)
        {
            return stepUp;
        }

        AedsJsonRequest<ClusterNodeStateRequest> request = await AedsJsonResults.ReadAsync<ClusterNodeStateRequest>(
            context,
            aeds,
            AedsFrameType.ClusterNodeStateRequest,
            AedsJsonResults.MaxAuthoringFrameBytes,
            "cluster_node_state_invalid",
            cancellationToken).ConfigureAwait(false);
        if (!request.IsSuccess)
        {
            return request.ToErrorResult(aeds);
        }

        if (!TryParseOperatorStatus(request.Value!.State, out ClusterMemberStatus status))
        {
            return AedsJsonResults.BadRequest(aeds, "cluster_node_state_invalid");
        }
        try
        {
            NodeDescriptor node = await operations.SetNodeStateAsync(
                new NodeId(nodeId),
                status,
                request.Value.Reason,
                cancellationToken).ConfigureAwait(false);
            return AedsJsonResults.Ok(aeds, AedsFrameType.ClusterRuntimeSnapshot, new
            {
                nodeId = node.NodeId.Value,
                status = ClusterMembershipWireNames.Status(node.Status)
            });
        }
        catch (KeyNotFoundException)
        {
            return AedsJsonResults.NotFound(aeds, "cluster_node_not_found");
        }
        catch (InvalidOperationException exception)
        {
            return AedsJsonResults.Error(aeds, ApiErrorTransportMappingId.Default409Conflict, exception.Message);
        }
    }

    private static async Task<IResult> SetSchedulerAsync(
        HttpContext context,
        [FromServices] ClusterOperationsService operations,
        [FromServices] IAdminPrincipalService adminPrincipals,
        [FromServices] IAedsEncoder aeds,
        CancellationToken cancellationToken)
    {
        IResult? stepUp = await RequireAdminSensitiveStepUpAsync(
            context,
            adminPrincipals,
            aeds,
            cancellationToken).ConfigureAwait(false);
        if (stepUp is not null)
        {
            return stepUp;
        }

        AedsJsonRequest<ClusterSchedulerStateRequest> request = await AedsJsonResults.ReadAsync<ClusterSchedulerStateRequest>(
            context,
            aeds,
            AedsFrameType.ClusterSchedulerStateRequest,
            AedsJsonResults.MaxAuthoringFrameBytes,
            "cluster_scheduler_state_invalid",
            cancellationToken).ConfigureAwait(false);
        if (!request.IsSuccess)
        {
            return request.ToErrorResult(aeds);
        }

        bool schedulingAllowed = operations.SetSchedulingAllowed(
            request.Value!.Enabled,
            request.Value.Reason);
        return AedsJsonResults.Ok(aeds, AedsFrameType.ClusterRuntimeSnapshot, new
        {
            schedulingAllowed
        });
    }

    private static async Task<IResult> ReleaseExpiredLeaseAsync(
        string leaseId,
        HttpContext context,
        [FromServices] ClusterOperationsService operations,
        [FromServices] IAdminPrincipalService adminPrincipals,
        [FromServices] IAedsEncoder aeds,
        CancellationToken cancellationToken)
    {
        IResult? stepUp = await RequireAdminSensitiveStepUpAsync(
            context,
            adminPrincipals,
            aeds,
            cancellationToken).ConfigureAwait(false);
        if (stepUp is not null)
        {
            return stepUp;
        }

        AedsJsonRequest<ClusterLeaseReleaseRequest> request = await AedsJsonResults.ReadAsync<ClusterLeaseReleaseRequest>(
            context,
            aeds,
            AedsFrameType.ClusterLeaseReleaseRequest,
            AedsJsonResults.MaxAuthoringFrameBytes,
            "cluster_lease_release_invalid",
            cancellationToken).ConfigureAwait(false);
        if (!request.IsSuccess)
        {
            return request.ToErrorResult(aeds);
        }

        if (!Guid.TryParseExact(leaseId, "N", out Guid parsedLeaseId))
        {
            return AedsJsonResults.BadRequest(aeds, "cluster_lease_id_invalid");
        }
        bool released = await operations.ReleaseExpiredLeaseAsync(
            new LeaseId(parsedLeaseId),
            request.Value!.Reason,
            cancellationToken).ConfigureAwait(false);
        return AedsJsonResults.Ok(aeds, AedsFrameType.ClusterRuntimeSnapshot, new
        {
            released
        });
    }

    private static async Task<IResult?> RequireAdminSensitiveStepUpAsync(
        HttpContext context,
        IAdminPrincipalService adminPrincipals,
        IAedsEncoder aeds,
        CancellationToken cancellationToken)
    {
        if (!context.User.TryGetAdminPrincipalId(out long adminPrincipalId)
            || string.IsNullOrWhiteSpace(context.User.GetAdminSessionId()))
        {
            return AedsJsonResults.Unauthorized(aeds);
        }
        if (!TrustedRequestOrigin.RequireTrustedOriginOrReferer(context))
        {
            return AedsJsonResults.Error(aeds, ApiErrorTransportMappingId.Default403Forbidden, "origin_not_allowed");
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
            return AedsJsonResults.PreconditionRequired(aeds, "mfa_proof_required");
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
