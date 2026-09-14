using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.NotificationStream;
using FsusBlog.Server.Services.Security;

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
        bool hasPerceptionCharacterV3ArtifactPool = false;
        foreach (ServiceDescriptor descriptor in services)
        {
            if (descriptor.ServiceType == typeof(IPerceptionCharacterV3ArtifactPool))
            {
                hasPerceptionCharacterV3ArtifactPool = true;
                break;
            }
        }

        services.TryAddSingleton<RedisActiveReleaseFenceStore>();
        services.TryAddSingleton<IActiveReleaseFenceReplicaStore>(static provider =>
            provider.GetRequiredService<RedisActiveReleaseFenceStore>());
        services.TryAddSingleton<IActiveReleaseFenceDurableWitness, SqlActiveReleaseFenceWitness>();
        services.TryAddSingleton<IActiveReleaseFenceStore, DurableActiveReleaseFenceStore>();
        services.TryAddSingleton<IActiveReleaseFence, ActiveReleaseFence>();
        services.TryAddSingleton<IActiveReleaseExecutionContextAccessor, ActiveReleaseExecutionContextAccessor>();
        services.TryAddSingleton<IActiveReleaseCommitGuard, ActiveReleaseCommitGuard>();
        services.TryAddSingleton<IReleaseIdentityProvider, ReleaseIdentityProvider>();
        services.TryAddSingleton<IActiveReleaseTransactionalCommitGuard, ActiveReleaseTransactionalCommitGuard>();
        services.TryAddSingleton<ISecurityChallengeKindCutoverStore, RedisSecurityChallengeKindCutoverStore>();
        services.TryAddSingleton<SecurityChallengeKindCutover>();
        if (hasPerceptionCharacterV3ArtifactPool)
        {
            services.TryAddSingleton<IPerceptionCharacterV3CutoverStore, RedisPerceptionCharacterV3CutoverStore>();
            services.TryAddSingleton<SecurityChallengeProtocolActivationGuard>();
            services.TryAddSingleton<ISecurityChallengeProtocolActivationGuard>(
                static provider => provider.GetRequiredService<SecurityChallengeProtocolActivationGuard>());
            services.TryAddSingleton<IPerceptionCharacterV3ActivationGate>(
                static provider => provider.GetRequiredService<SecurityChallengeProtocolActivationGuard>());
            services.TryAddSingleton<PerceptionCharacterV3ContractCutover>();
        }
        services.TryAddSingleton<ActiveReleaseFenceReadiness>();
        services.TryAddSingleton<NotificationStreamRestartCoordinator>();
        services.TryAddSingleton<ReleaseDrainParticipantRegistry>();
        services.TryAddSingleton<IBoundedQueueDrainCatalog>(static _ => BoundedQueueDeliveryCatalog.Embedded);
        services.TryAddSingleton<BoundedQueueDrainAggregator>();
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IReleaseDrainParticipant, BoundedQueueDrainReleaseParticipant>());
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IBoundedQueueDrainParticipant, AdminAuditBoundedQueueDrainParticipant>());
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IBoundedQueueDrainParticipant, AdminSessionTouchBoundedQueueDrainParticipant>());
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IBoundedQueueDrainParticipant, ArticleAssetCleanupBoundedQueueDrainParticipant>());
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IBoundedQueueDrainParticipant, ArticleBodyRepairBoundedQueueDrainParticipant>());
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IBoundedQueueDrainParticipant, ArticleDetailAedsBoundedQueueDrainParticipant>());
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IBoundedQueueDrainParticipant, AuditLogBoundedQueueDrainParticipant>());
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IBoundedQueueDrainParticipant, ChallengeAuditHighValueBoundedQueueDrainParticipant>());
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IBoundedQueueDrainParticipant, ChallengeAuditNormalBoundedQueueDrainParticipant>());
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IBoundedQueueDrainParticipant, ContentFilterReloadBoundedQueueDrainParticipant>());
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IBoundedQueueDrainParticipant, DistributedInvalidationIngressBoundedQueueDrainParticipant>());
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IBoundedQueueDrainParticipant, JavaScriptEnginePoolBoundedQueueDrainParticipant>());
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IBoundedQueueDrainParticipant, NotificationConnectionBoundedQueueDrainParticipant>());
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IBoundedQueueDrainParticipant, NotificationFanoutLosslessBoundedQueueDrainParticipant>());
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IBoundedQueueDrainParticipant, NotificationFanoutLowBoundedQueueDrainParticipant>());
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IBoundedQueueDrainParticipant, NotificationFanoutStateBoundedQueueDrainParticipant>());
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IBoundedQueueDrainParticipant, PublicAotBackfillBoundedQueueDrainParticipant>());
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IBoundedQueueDrainParticipant, PublicAotFileShellInvalidationBoundedQueueDrainParticipant>());
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IBoundedQueueDrainParticipant, PublicHotArtifactUpdateBoundedQueueDrainParticipant>());
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IBoundedQueueDrainParticipant, PublicHotReadRiskProjectionBoundedQueueDrainParticipant>());
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IBoundedQueueDrainParticipant, RumTelemetryBoundedQueueDrainParticipant>());
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IBoundedQueueDrainParticipant, SecurityRiskEventBoundedQueueDrainParticipant>());
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IBoundedQueueDrainParticipant, UploadSessionCleanupBoundedQueueDrainParticipant>());
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IBoundedQueueDrainParticipant, VisitLogBoundedQueueDrainParticipant>());
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
    public const string ChallengeKindCutoverPath = "/api/ops/deployment/fence/challenge-kind-cutover";
    public const string PerceptionCharacterV3CutoverPath = "/api/ops/deployment/fence/perception-character-v3-cutover";

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

        endpoints.MapPost(ChallengeKindCutoverPath, async Task<IResult> (
            HttpContext context,
            SecurityChallengeKindCutoverRequest request,
            [FromServices] SecurityChallengeKindCutover cutover,
            CancellationToken cancellationToken) =>
        {
            if (!DeploymentControlEndpoints.IsTrustedHostControl(context))
            {
                return TrustedHostRequired();
            }

            SecurityChallengeKindCutoverReceipt receipt = await cutover
                .ExecuteAsync(request, cancellationToken)
                .ConfigureAwait(false);
            return HttpResults.Json(receipt, statusCode: receipt.Accepted
                ? StatusCodes.Status200OK
                : StatusCodes.Status409Conflict);
        })
        .RequireAdminPermission(AdminPermissions.SystemConfig)
        .RequireRateLimiting("fixed_ip");

        endpoints.MapPost(PerceptionCharacterV3CutoverPath, async Task<IResult> (
            HttpContext context,
            PerceptionCharacterV3CutoverRequest request,
            [FromServices] PerceptionCharacterV3ContractCutover cutover,
            CancellationToken cancellationToken) =>
        {
            if (!DeploymentControlEndpoints.IsTrustedHostControl(context))
            {
                return TrustedHostRequired();
            }
            PerceptionCharacterV3CutoverReceipt result = await cutover
                .ExecuteAsync(request, cancellationToken).ConfigureAwait(false);
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
