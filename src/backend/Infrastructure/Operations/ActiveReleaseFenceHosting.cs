using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.NotificationStream;

using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection.Extensions;

using HttpResults = Microsoft.AspNetCore.Http.Results;

namespace FsusBlog.Server.Infrastructure.Operations;

public sealed record ActiveReleaseFenceHealthCheck(
    string Status,
    bool StoreReachable,
    bool LocalReleaseIsActive,
    string FenceStatus,
    string ReleaseId,
    string Slot,
    long Generation,
    DateTimeOffset RefreshedAtUtc,
    string? Error = null) : IProductionHealthCheck;

public sealed class ActiveReleaseFenceReadiness(IActiveReleaseFence fence)
{
    public async Task<ActiveReleaseFenceHealthCheck> EvaluateAsync(
        bool requireLocalOwnership = true,
        CancellationToken cancellationToken = default)
    {
        ActiveReleaseFenceRuntimeSnapshot snapshot = await fence
            .RefreshAsync(forceStoreRead: false, cancellationToken)
            .ConfigureAwait(false);
        bool ready = snapshot.StoreReachable
            && (requireLocalOwnership ? snapshot.LocalReleaseIsActive : !snapshot.LocalReleaseIsActive);
        return new ActiveReleaseFenceHealthCheck(
            ready ? "ok" : "failed",
            snapshot.StoreReachable,
            snapshot.LocalReleaseIsActive,
            snapshot.Fence.Status,
            snapshot.Fence.ReleaseId,
            snapshot.Fence.Slot,
            snapshot.Fence.Generation,
            snapshot.RefreshedAtUtc,
            ready
                ? null
                : snapshot.ErrorCode ?? (requireLocalOwnership
                    ? "active_release_fence_not_owned"
                    : "inactive_release_unexpectedly_owns_fence"));
    }
}

public static class ActiveReleaseFenceServiceCollectionExtensions
{
    public static IServiceCollection AddActiveReleaseFencing(this IServiceCollection services)
    {
        services.TryAddSingleton<RedisActiveReleaseFenceStore>();
        services.TryAddSingleton<IActiveReleaseFenceReplicaStore>(static provider =>
            provider.GetRequiredService<RedisActiveReleaseFenceStore>());
        services.TryAddSingleton<IActiveReleaseFenceDurableWitness, SqlActiveReleaseFenceWitness>();
        services.TryAddSingleton<IActiveReleaseFenceStore, DurableActiveReleaseFenceStore>();
        services.TryAddSingleton<IActiveReleaseFence, ActiveReleaseFence>();
        services.TryAddSingleton<IActiveReleaseExecutionContextAccessor, ActiveReleaseExecutionContextAccessor>();
        services.TryAddSingleton<IActiveReleaseCommitGuard, ActiveReleaseCommitGuard>();
        services.TryAddSingleton<IActiveReleaseTransactionalCommitGuard, ActiveReleaseTransactionalCommitGuard>();
        services.TryAddSingleton<ActiveReleaseFenceReadiness>();
        services.TryAddSingleton<NotificationStreamRestartCoordinator>();
        services.TryAddSingleton<ReleaseDrainParticipantRegistry>();
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IReleaseDrainParticipant, ArticleViewReleaseDrainParticipant>());
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IReleaseDrainParticipant, HotStatsReleaseDrainParticipant>());
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IReleaseDrainParticipant, NotificationStreamReleaseDrainParticipant>());
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IReleaseDrainParticipant, AuditLogReleaseDrainParticipant>());
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IReleaseDrainParticipant, AdminAuditLogReleaseDrainParticipant>());
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IReleaseDrainParticipant, VisitLogReleaseDrainParticipant>());
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IReleaseDrainParticipant, RumTelemetryReleaseDrainParticipant>());
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IReleaseDrainParticipant, SecurityRiskReleaseDrainParticipant>());
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IReleaseDrainParticipant, ChallengeAuditReleaseDrainParticipant>());
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IReleaseDrainParticipant, PublicHotUpdateReleaseDrainParticipant>());
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IReleaseDrainParticipant, ArticleDetailAedsReleaseDrainParticipant>());
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IReleaseDrainParticipant, PublicAotBackfillReleaseDrainParticipant>());
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IReleaseDrainParticipant, UploadCleanupReleaseDrainParticipant>());
        services.Replace(ServiceDescriptor.Singleton<IBackgroundWorkerLease, ActiveReleaseFencedBackgroundWorkerLease>());
        if (!OpenApiExportMode.IsEnabled())
        {
            services.TryAddEnumerable(ServiceDescriptor.Singleton<IHostedService, ActiveReleaseFenceStartupValidationHostedService>());
            services.TryAddEnumerable(ServiceDescriptor.Singleton<IHostedService, ActiveReleaseFenceRefreshWorker>());
            services.TryAddEnumerable(ServiceDescriptor.Singleton<IHostedService, ActiveReleaseFencedCommitAuditWorker>());
        }
        return services;
    }
}

public static class ActiveReleaseFenceEndpoints
{
    public const string AcquirePath = "/api/ops/deployment/fence/acquire";
    public const string RevokePath = "/api/ops/deployment/fence/revoke";
    public const string StatusPath = "/api/ops/deployment/fence/status";

    public static IEndpointRouteBuilder MapActiveReleaseFenceEndpoints(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapPost(AcquirePath, async Task<IResult> (
            HttpContext context,
            ActiveReleaseFenceAcquireRequest request,
            [FromServices] IActiveReleaseFence fence,
            CancellationToken cancellationToken) =>
        {
            if (!DeploymentControlEndpoints.IsTrustedHostControl(context))
            {
                return TrustedHostRequired();
            }

            ActiveReleaseFenceOperationResult result = await fence
                .AcquireAsync(request, cancellationToken)
                .ConfigureAwait(false);
            return HttpResults.Json(result, statusCode: result.Accepted
                ? StatusCodes.Status200OK
                : StatusCodes.Status409Conflict);
        })
        .RequireAdminPermission(AdminPermissions.SystemConfig)
        .RequireRateLimiting("fixed_ip");

        endpoints.MapPost(RevokePath, async Task<IResult> (
            HttpContext context,
            ActiveReleaseFenceRevokeRequest request,
            [FromServices] IActiveReleaseFence fence,
            CancellationToken cancellationToken) =>
        {
            if (!DeploymentControlEndpoints.IsTrustedHostControl(context))
            {
                return TrustedHostRequired();
            }

            ActiveReleaseFenceOperationResult result = await fence
                .RevokeAsync(request, cancellationToken)
                .ConfigureAwait(false);
            return HttpResults.Json(result, statusCode: result.Accepted
                ? StatusCodes.Status200OK
                : StatusCodes.Status409Conflict);
        })
        .RequireAdminPermission(AdminPermissions.SystemConfig)
        .RequireRateLimiting("fixed_ip");

        endpoints.MapGet(StatusPath, async Task<IResult> (
            HttpContext context,
            string? releaseId,
            string? slot,
            long? generation,
            bool? requireActive,
            [FromServices] IActiveReleaseFence fence,
            CancellationToken cancellationToken) =>
        {
            if (!DeploymentControlEndpoints.IsTrustedHostControl(context))
            {
                return TrustedHostRequired();
            }

            ActiveReleaseFenceOperationResult result = await fence.VerifyAsync(
                new ActiveReleaseFenceVerifyRequest(
                    releaseId,
                    slot,
                    generation,
                    requireActive ?? true),
                cancellationToken).ConfigureAwait(false);
            return HttpResults.Json(result, statusCode: result.Accepted
                ? StatusCodes.Status200OK
                : StatusCodes.Status409Conflict);
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
