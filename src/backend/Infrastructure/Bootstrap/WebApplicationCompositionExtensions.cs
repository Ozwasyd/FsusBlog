using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Middlewares;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Security;

namespace FsusBlog.Server.Infrastructure.Bootstrap;

/// <summary>
/// Pure application composition root. Runtime policy, route decisions and response
/// materialization live in independently testable modules and are only assembled here.
/// </summary>
public static class WebApplicationCompositionExtensions
{
    private sealed record PipelineStage(
        string Id,
        PublicHotReadPipelineStageClassification Classification,
        string? ControlId,
        Action<WebApplication> Configure)
    {
        internal PublicHotReadPipelineStageDescriptor Descriptor
            => new(Id, Classification, ControlId);
    }

    private static readonly PipelineStage[] s_applicationPipelineStages =
    [
        new("forwarded-headers", PublicHotReadPipelineStageClassification.Infrastructure, null, static app => app.UseForwardedHeaders()),
        new("security-headers", PublicHotReadPipelineStageClassification.CrossCuttingControl, "release-and-security-headers", static app => app.UseFsusSecurityHeaders()),
        new("deployment-request-tracking", PublicHotReadPipelineStageClassification.CrossCuttingControl, "deployment-request-tracking", static app => app.UseMiddleware<DeploymentRequestTrackingMiddleware>()),
        new("core-middlewares", PublicHotReadPipelineStageClassification.CrossCuttingControl, "shield-exception-binary-boundary", static app => app.UseFsusCoreMiddlewares()),
        new("test-session-validation", PublicHotReadPipelineStageClassification.Infrastructure, null, static app => app.UseFsusTestSessionValidation()),
        new("observability-correlation", PublicHotReadPipelineStageClassification.CrossCuttingControl, "observability-correlation", static app => app.UseMiddleware<ObservabilityCorrelationMiddleware>()),
        new("public-hot-read-classifier", PublicHotReadPipelineStageClassification.BranchMechanic, null, static app => app.UseFsusPublicHotReadClassifier()),
        new("public-hot-read-request-audit-context", PublicHotReadPipelineStageClassification.CrossCuttingControl, "request-audit-context", static app => app.UseFsusPublicHotReadRequestAuditContext()),
        new("public-read-security-gate", PublicHotReadPipelineStageClassification.BranchMechanic, null, static app => app.UseFsusPublicHotReadSecurityGate()),
        new("public-artifact-revocation", PublicHotReadPipelineStageClassification.BranchMechanic, null, static app => app.UseFsusPublicArtifactRevocation()),
        new("public-hot-read-fast-path", PublicHotReadPipelineStageClassification.BranchMechanic, null, static app => app.UseFsusPublicHotReadFastPath()),
        new("public-hot-read-rate-limiter", PublicHotReadPipelineStageClassification.CrossCuttingControl, "public-read-rate-limit", static app => app.UseFsusPublicHotReadRateLimiter()),
        new("public-hot-read-fallback-restore", PublicHotReadPipelineStageClassification.BranchMechanic, null, static app => app.UseFsusPublicHotReadFallbackRestore()),
        new("endpoint-pipeline", PublicHotReadPipelineStageClassification.BranchMechanic, null, static app => ConfigureEndpointPipeline(app)),
        new("static-assets", PublicHotReadPipelineStageClassification.Infrastructure, null, static app => app.UseFsusStaticAssets())
    ];

    private static readonly PipelineStage[] s_endpointPipelineStages =
    [
        new("routing", PublicHotReadPipelineStageClassification.Infrastructure, null, static app => app.UseRouting()),
        new("endpoint-metadata-headers", PublicHotReadPipelineStageClassification.Infrastructure, null, static app => app.UseFsusEndpointMetadataHeaders()),
        new("websockets", PublicHotReadPipelineStageClassification.Infrastructure, null, static app => app.UseWebSockets()),
        new("response-compression", PublicHotReadPipelineStageClassification.EndpointFunctional, null, static app => app.UseResponseCompression()),
        new("output-cache", PublicHotReadPipelineStageClassification.EndpointFunctional, null, static app => app.UseOutputCache()),
        new("cors", PublicHotReadPipelineStageClassification.CrossCuttingControl, "cors", static app => app.UseCors()),
        new("antiforgery", PublicHotReadPipelineStageClassification.CrossCuttingControl, "antiforgery", static app => app.UseAntiforgery()),
        new("csrf-origin-guard", PublicHotReadPipelineStageClassification.CrossCuttingControl, "csrf-origin-guard", static app => app.UseFsusCsrfOriginGuard()),
        new("anonymous-gateway-header-guard", PublicHotReadPipelineStageClassification.CrossCuttingControl, "anonymous-gateway-header-guard", static app => app.UseMiddleware<AnonymousGatewayHeaderGuardMiddleware>()),
        new("authentication", PublicHotReadPipelineStageClassification.CrossCuttingControl, "authentication", static app => app.UseAuthentication()),
        new("rate-limiter", PublicHotReadPipelineStageClassification.CrossCuttingControl, "public-read-rate-limit", static app => app.UseFsusEndpointRateLimiter()),
        new("banned-user", PublicHotReadPipelineStageClassification.CrossCuttingControl, "banned-user", static app => app.UseMiddleware<BannedUserMiddleware>()),
        new("authorization", PublicHotReadPipelineStageClassification.CrossCuttingControl, "authorization", static app => app.UseAuthorization()),
        new("request-audit-context", PublicHotReadPipelineStageClassification.CrossCuttingControl, "request-audit-context", static app => app.UseFsusEndpointRequestAuditContext())
    ];

    internal static IReadOnlyList<PublicHotReadPipelineStageDescriptor> ApplicationPipelineStageDescriptors
        => s_applicationPipelineStages.Select(static stage => stage.Descriptor).ToArray();

    internal static IReadOnlyList<PublicHotReadPipelineStageDescriptor> EndpointPipelineStageDescriptors
        => s_endpointPipelineStages.Select(static stage => stage.Descriptor).ToArray();

    internal static IReadOnlyList<string> ApplicationPipelineStageIds
        => s_applicationPipelineStages.Select(static stage => stage.Id).ToArray();

    internal static IReadOnlyList<string> EndpointPipelineStageIds
        => s_endpointPipelineStages.Select(static stage => stage.Id).ToArray();

    public static void UseFsusApplicationPipeline(this WebApplication app)
    {
        PublicWebRuntime.ReportHttp3TransportStartup(app);
        PublicHotReadCrossCuttingControlCatalog.ValidateOrThrow(
            ApplicationPipelineStageDescriptors,
            EndpointPipelineStageDescriptors);
        foreach (PipelineStage stage in s_applicationPipelineStages)
        {
            stage.Configure(app);
        }
    }

    public static void MapFsusApplicationRoutes(this WebApplication app)
    {
        app.MapFsusOperationalRoutes();
        app.MapFsusApiRoutes();
        app.MapFsusPublicRoutes();
    }

    private static void ConfigureEndpointPipeline(WebApplication app)
    {
        foreach (PipelineStage stage in s_endpointPipelineStages)
        {
            stage.Configure(app);
        }
    }
}
