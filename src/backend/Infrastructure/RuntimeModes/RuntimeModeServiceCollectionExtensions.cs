using FsusBlog.Server.Infrastructure.Bootstrap;

using Microsoft.Extensions.DependencyInjection.Extensions;

namespace FsusBlog.Server.Infrastructure.RuntimeModes;

public static class RuntimeModeServiceCollectionExtensions
{
    private const string DistributedInvalidationSubscriber = "PublicAotFileShellCacheInvalidationSubscriber";

    private static readonly IReadOnlyDictionary<string, string> s_workerRoles =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["NotificationStreamLocalFanoutWorker"] = FsusRuntimeRoles.Web,
            ["PublicHotReadMetricFlushWorker"] = FsusRuntimeRoles.Web,
            ["PublicHotReadStartupWarmupService"] = FsusRuntimeRoles.Web,
            ["PublicHotArtifactUpdateWorker"] = FsusRuntimeRoles.Web,
            ["PublicAotBackfillWorker"] = FsusRuntimeRoles.Web,
            ["ArticleViewFlushWorker"] = FsusRuntimeRoles.Content,
            ["ArticleDetailAedsArtifactBackfillWorker"] = FsusRuntimeRoles.Content,
            ["ArticleMutationOutboxDispatcher"] = FsusRuntimeRoles.Content,
            ["ArticleMutationOutboxStaleClaimDetector"] = FsusRuntimeRoles.Content,
            ["ScheduledPublishWorker"] = FsusRuntimeRoles.Content,
            ["SecurityRiskEventWriterWorker"] = FsusRuntimeRoles.Security,
            ["SecurityPolicySnapshotHostedService"] = FsusRuntimeRoles.Security,
            ["AnonymousCredentialRootRefreshHostedService"] = FsusRuntimeRoles.Security,
            ["ChallengeV2AuditEventWriterWorker"] = FsusRuntimeRoles.Security,
            ["AuditLogWriterWorker"] = FsusRuntimeRoles.Audit,
            ["AdminAuditLogWriterWorker"] = FsusRuntimeRoles.Audit,
            ["UploadSessionCleanupWorker"] = FsusRuntimeRoles.Maintenance,
            ["VisitLogProcessorService"] = FsusRuntimeRoles.Maintenance,
            ["ArticleViewProjectionRepairWorker"] = FsusRuntimeRoles.Maintenance,
            ["LogCleanupService"] = FsusRuntimeRoles.Maintenance,
            ["RumTelemetryFlushWorker"] = FsusRuntimeRoles.Maintenance
        };

    public static IServiceCollection ApplyFsusRuntimeModeGates(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        RuntimeModePlan plan = RuntimeModePlan.FromConfiguration(configuration);
        services.TryAddSingleton(plan);
        services.TryAddSingleton<RuntimeModeRuntimeState>();

        RemoveDisabledHostedServices(services, plan);
        if (!OpenApiExportMode.IsEnabled(configuration))
        {
            if (plan.Mode == FsusRuntimeModes.Adaptive)
            {
                services.AddHostedService<ClusterRuntimeFoundationHostedService>();
            }
            services.AddHostedService<RuntimeModeStartupLogService>();
        }
        return services;
    }

    internal static bool ShouldKeepHostedService(RuntimeModePlan plan, string implementationTypeName)
    {
        if (implementationTypeName == DistributedInvalidationSubscriber)
        {
            return plan.DistributedInvalidationEnabled;
        }
        if (plan.Mode != FsusRuntimeModes.StaticRole
            || !s_workerRoles.TryGetValue(implementationTypeName, out string? requiredRole))
        {
            return true;
        }
        return plan.StaticRoles.Contains(requiredRole);
    }

    private static void RemoveDisabledHostedServices(IServiceCollection services, RuntimeModePlan plan)
    {
        ServiceDescriptor[] disabled = services
            .Where(static descriptor => descriptor.ServiceType == typeof(IHostedService))
            .Where(descriptor => descriptor.ImplementationType is not null
                && !ShouldKeepHostedService(plan, descriptor.ImplementationType.Name))
            .ToArray();
        foreach (ServiceDescriptor descriptor in disabled)
        {
            services.Remove(descriptor);
        }
    }
}
