using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Operations;

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
            NotificationStreamRestartCoordinator coordinator) =>
        {
            if (!DeploymentControlEndpoints.IsTrustedHostControl(context))
            {
                return TrustedHostRequired();
            }

            NotificationStreamRestartSnapshot result = coordinator.RequestRestart(request);
            return Results.Json(result, statusCode: result.Accepted
                ? StatusCodes.Status202Accepted
                : StatusCodes.Status409Conflict);
        })
        .RequireAdminPermission(AdminPermissions.SystemConfig)
        .RequireRateLimiting("fixed_ip");

        endpoints.MapGet(StatusPath, (
            HttpContext context,
            NotificationStreamRestartCoordinator coordinator) =>
        {
            if (!DeploymentControlEndpoints.IsTrustedHostControl(context))
            {
                return TrustedHostRequired();
            }

            return Results.Json(coordinator.Current);
        })
        .RequireAdminPermission(AdminPermissions.SystemConfig)
        .RequireRateLimiting("fixed_ip");

        return endpoints;
    }

    private static IResult TrustedHostRequired()
        => Results.Json(
            new { accepted = false, status = "rejected", errorCode = "trusted_host_required" },
            statusCode: StatusCodes.Status403Forbidden);
}
