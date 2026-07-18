using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Operations;
using Microsoft.AspNetCore.Mvc;

using HttpResults = Microsoft.AspNetCore.Http.Results;

namespace FsusBlog.Server.Infrastructure.NotificationStream;

public static class NotificationStreamRestartEndpoints
{
    public const string RestartPath = "/api/ops/deployment/notification-stream/restart";
    public const string StatusPath = "/api/ops/deployment/notification-stream/restart/status";

    public static IEndpointRouteBuilder MapNotificationStreamRestartEndpoints(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapPost(RestartPath, (
            HttpContext context,
            NotificationStreamRestartRequest request,
            [FromServices] NotificationStreamRestartCoordinator coordinator) =>
        {
            if (!DeploymentControlEndpoints.IsTrustedHostControl(context))
            {
                return TrustedHostRequired();
            }

            NotificationStreamRestartSnapshot result = coordinator.RequestRestart(request);
            return HttpResults.Json(result, statusCode: result.Accepted
                ? StatusCodes.Status202Accepted
                : StatusCodes.Status409Conflict);
        })
        .RequireAdminPermission(AdminPermissions.SystemConfig)
        .RequireRateLimiting("fixed_ip");

        endpoints.MapGet(StatusPath, (
            HttpContext context,
            [FromServices] NotificationStreamRestartCoordinator coordinator) =>
        {
            if (!DeploymentControlEndpoints.IsTrustedHostControl(context))
            {
                return TrustedHostRequired();
            }

            return HttpResults.Json(coordinator.Current);
        })
        .RequireAdminPermission(AdminPermissions.SystemConfig)
        .RequireRateLimiting("fixed_ip");

        return endpoints;
    }

    private static IResult TrustedHostRequired()
        => HttpResults.Json(
            new
            {
                accepted = false,
                status = "rejected",
                errorCode = "trusted_host_required"
            },
            statusCode: StatusCodes.Status403Forbidden);
}
