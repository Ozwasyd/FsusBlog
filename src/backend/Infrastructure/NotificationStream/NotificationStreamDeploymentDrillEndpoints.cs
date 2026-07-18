using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Interfaces;
using FsusBlog.Shared.Contracts.NotificationStream;

using HttpResults = Microsoft.AspNetCore.Http.Results;

namespace FsusBlog.Server.Infrastructure.NotificationStream;

public sealed record NotificationStreamDeploymentDrillRequest(
    string ReleaseId,
    string Slot,
    long Generation,
    string DrillId,
    int Count = 4,
    bool DryRun = false);

public sealed record NotificationStreamDeploymentDrillResponse(
    bool Accepted,
    string Status,
    string? ErrorCode,
    string ReleaseId,
    string Slot,
    long Generation,
    string DrillId,
    IReadOnlyList<long> EventIds,
    bool DryRun);

public static class NotificationStreamDeploymentDrillEndpoints
{
    public const string PublishPath = "/api/ops/deployment/notification-stream/drill/publish";
    private const int MaximumEvents = 32;

    public static IEndpointRouteBuilder MapNotificationStreamDeploymentDrillEndpoints(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapPost(PublishPath, PublishAsync)
            .RequireAdminPermission(AdminPermissions.SystemConfig)
            .RequireRateLimiting("fixed_ip");
        return endpoints;
    }

    private static async Task<IResult> PublishAsync(
        HttpContext context,
        NotificationStreamDeploymentDrillRequest request,
        IConfiguration configuration,
        IReleaseIdentityProvider releaseIdentity,
        DeploymentRuntimeState deploymentRuntime,
        NotificationStreamConnectionManager connections,
        IActiveReleaseFence activeFence,
        INotificationStreamPublisher publisher,
        CancellationToken cancellationToken)
    {
        if (!DeploymentControlEndpoints.IsTrustedHostControl(context))
        {
            return Reject(StatusCodes.Status403Forbidden, "trusted_host_required", request);
        }

        if (!configuration.GetValue("Deployment:NotificationStreamDrillEnabled", false))
        {
            return HttpResults.NotFound();
        }

        ReleaseIdentitySnapshot local = releaseIdentity.Current;
        DeploymentRuntimeSnapshot runtime = deploymentRuntime.CreateSnapshot(connections.ConnectionCount);
        string drillId = (request.DrillId ?? string.Empty).Trim();
        string? errorCode = !string.Equals(request.ReleaseId?.Trim(), local.ReleaseId, StringComparison.Ordinal)
            ? "notification_drill_release_mismatch"
            : !string.Equals(request.Slot?.Trim(), local.ReleaseSlot, StringComparison.Ordinal)
                ? "notification_drill_slot_mismatch"
                : request.Generation <= 0 || request.Generation != runtime.Generation
                    ? "notification_drill_generation_mismatch"
                    : runtime.State != DeploymentLifecycleStates.Active || !runtime.CanClaimBackgroundWork
                        ? "notification_drill_release_not_active"
                        : drillId.Length is < 8 or > 96 || !drillId.All(IsSafeIdentifierCharacter)
                            ? "notification_drill_id_invalid"
                            : request.Count is < 1 or > MaximumEvents
                                ? "notification_drill_count_invalid"
                                : null;
        if (errorCode is not null)
        {
            return Reject(StatusCodes.Status409Conflict, errorCode, request);
        }

        ActiveReleaseFenceOperationResult fence = await activeFence.VerifyAsync(
            new ActiveReleaseFenceVerifyRequest(local.ReleaseId, local.ReleaseSlot, runtime.Generation, RequireActive: true),
            cancellationToken).ConfigureAwait(false);
        if (!fence.Accepted || !activeFence.Current.LocalReleaseIsActive)
        {
            return Reject(StatusCodes.Status409Conflict, fence.ErrorCode ?? "notification_drill_active_fence_not_owned", request);
        }

        if (request.DryRun)
        {
            return HttpResults.Ok(new NotificationStreamDeploymentDrillResponse(
                true,
                "would-publish",
                null,
                local.ReleaseId,
                local.ReleaseSlot,
                runtime.Generation,
                drillId,
                [],
                true));
        }

        var eventIds = new long[request.Count];
        for (int index = 0; index < eventIds.Length; index++)
        {
            var payload = new DeploymentDrillPayload(
                drillId,
                Sequence: index + 1,
                local.ReleaseId,
                local.ReleaseSlot,
                runtime.Generation,
                PublishedAtUnixMs: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            var published = await publisher.PublishAsync(
                NotificationStreamEventType.CacheControl,
                payload,
                new NotificationStreamGroupTarget(NotificationStreamTargetCollections.ContentFeed),
                cancellationToken).ConfigureAwait(false);
            if (published.IsFailure)
            {
                return Reject(StatusCodes.Status503ServiceUnavailable, "notification_drill_publish_failed", request);
            }

            eventIds[index] = published.Value.Value;
        }

        return HttpResults.Ok(new NotificationStreamDeploymentDrillResponse(
            true,
            "published",
            null,
            local.ReleaseId,
            local.ReleaseSlot,
            runtime.Generation,
            drillId,
            eventIds,
            false));
    }

    private static IResult Reject(int statusCode, string errorCode, NotificationStreamDeploymentDrillRequest request)
        => HttpResults.Json(
            new NotificationStreamDeploymentDrillResponse(
                false,
                "rejected",
                errorCode,
                request.ReleaseId ?? string.Empty,
                request.Slot ?? string.Empty,
                request.Generation,
                request.DrillId ?? string.Empty,
                [],
                request.DryRun),
            statusCode: statusCode);

    private static bool IsSafeIdentifierCharacter(char value)
        => char.IsAsciiLetterOrDigit(value) || value is '.' or '_' or '-';

    private sealed record DeploymentDrillPayload(
        string DrillId,
        int Sequence,
        string ReleaseId,
        string Slot,
        long Generation,
        long PublishedAtUnixMs);
}
