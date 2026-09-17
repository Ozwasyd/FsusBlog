using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Security;

using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.Options;

namespace FsusBlog.Server.Infrastructure.PublicReadArtifacts;

public sealed class PublicHotReadEarlyDataPlaneRuntimeState : IDisposable
{
    private readonly IDisposable? _reloadRegistration;
    private int _enabled;

    public PublicHotReadEarlyDataPlaneRuntimeState(IOptionsMonitor<PublicHotReadOptions> options)
    {
        PublicHotReadRouteSecurityCatalog.ValidateOrThrow();
        PublicHotReadEarlyEndpointCatalog.ValidateOrThrow();
        Update(options.CurrentValue);
        _reloadRegistration = options.OnChange((value, _) => Update(value));
    }

    public bool Enabled => Volatile.Read(ref _enabled) == 1;

    public void Dispose() => _reloadRegistration?.Dispose();

    private void Update(PublicHotReadOptions options)
        => Volatile.Write(ref _enabled, options.Enabled ? 1 : 0);
}

public sealed class PublicHotReadClassifierCounters
{
    private long _sensitivePrefixBypass;
    private long _credentialBypass;

    internal void SensitivePrefixBypass()
        => Interlocked.Increment(ref _sensitivePrefixBypass);

    internal long SensitivePrefixBypassSnapshot()
        => Volatile.Read(ref _sensitivePrefixBypass);

    internal long CollectSensitivePrefixBypassAndReset()
        => Interlocked.Exchange(ref _sensitivePrefixBypass, 0);

    internal void CredentialBypass()
        => Interlocked.Increment(ref _credentialBypass);

    internal long CredentialBypassSnapshot()
        => Volatile.Read(ref _credentialBypass);

    internal long CollectCredentialBypassAndReset()
        => Interlocked.Exchange(ref _credentialBypass, 0);
}

internal enum PublicHotReadArtifactMediaKind : byte
{
    Binary = 0,
    Html = 1
}

internal sealed class PublicHotReadRequestFeature
{
    internal PublicHotReadRequestFeature(
        PublicHotReadRoute route,
        bool classified,
        bool rejectedPath,
        bool fallbackToEndpoint,
        string riskRouteKey,
        PublicHotReadRoutePolicy routePolicy,
        int classificationCount)
    {
        Route = route;
        Classified = classified;
        RejectedPath = rejectedPath;
        MediaKind = routePolicy.MediaKind;
        FallbackToEndpoint = fallbackToEndpoint;
        RiskRouteKey = riskRouteKey;
        RoutePolicy = routePolicy;
        ClassificationCount = classificationCount;
    }

    internal PublicHotReadRoute Route
    {
        get;
    }
    internal PublicHotReadRouteKind RouteKind => Route.Kind;
    internal int ArticleId => Route.ArticleId;
    internal PublicListKey ListKey => Route.ListKey;
    internal string HtmlRouteKey => Route.HtmlRouteKey;
    internal bool Classified
    {
        get;
    }
    internal bool RejectedPath
    {
        get;
    }
    internal PublicHotReadArtifactMediaKind MediaKind
    {
        get;
    }
    internal bool IsHtml => MediaKind == PublicHotReadArtifactMediaKind.Html;
    internal bool FallbackToEndpoint
    {
        get;
    }
    internal string RiskRouteKey
    {
        get;
    }
    internal PublicHotReadRoutePolicy RoutePolicy
    {
        get;
    }
    internal string RoutePolicyId => RoutePolicy.PolicyId;
    internal bool RequiresVisibilityEvidence => RoutePolicy.RequiresVisibilityEvidence;
    internal bool RequiresSecurityGate => RoutePolicy.RequiresSecurityGate;
    internal int ClassificationCount
    {
        get;
    }
}

internal sealed class PublicHotReadEarlyPipelineState
{
    internal PublicHotReadEarlyPipelineState(Endpoint syntheticEndpoint)
    {
        SyntheticEndpoint = syntheticEndpoint;
    }

    internal Endpoint SyntheticEndpoint
    {
        get;
    }
    internal bool RateLimitEvaluated
    {
        get; private set;
    }
    internal int RequestAuditContextExecutionCount
    {
        get; private set;
    }
    internal int EndpointRequestAuditContextSkipCount
    {
        get; private set;
    }
    internal int EndpointRateLimiterSkipCount
    {
        get; private set;
    }
    internal bool RequestAuditContextEvaluated => RequestAuditContextExecutionCount == 1;

    internal void MarkRateLimitEvaluated()
    {
        if (RateLimitEvaluated)
        {
            throw new InvalidOperationException("PublicHotRead rate limiter executed more than once.");
        }

        RateLimitEvaluated = true;
    }

    internal void MarkRequestAuditContextEvaluated()
    {
        if (RequestAuditContextExecutionCount != 0)
        {
            throw new InvalidOperationException("PublicHotRead request audit context executed more than once.");
        }

        RequestAuditContextExecutionCount = 1;
    }

    internal void MarkEndpointRequestAuditContextSkipped()
    {
        if (!RequestAuditContextEvaluated || EndpointRequestAuditContextSkipCount != 0)
        {
            throw new InvalidOperationException("PublicHotRead endpoint request audit skip guard is invalid.");
        }

        EndpointRequestAuditContextSkipCount = 1;
    }

    internal void MarkEndpointRateLimiterSkipped()
    {
        if (!RateLimitEvaluated || EndpointRateLimiterSkipCount != 0)
        {
            throw new InvalidOperationException("PublicHotRead endpoint rate limiter skip guard is invalid.");
        }

        EndpointRateLimiterSkipCount = 1;
    }
}

internal sealed class PublicReadSecurityGateResultFeature
{
    internal static readonly PublicReadSecurityGateResultFeature s_allowed = new();

    private PublicReadSecurityGateResultFeature()
    {
    }
}

internal static class PublicHotReadEarlyEndpointCatalog
{
    private static readonly Endpoint s_articleDetail = Create(PublicHotReadRouteKind.ArticleDetail, "article.detail", "public-hot-read:article-detail", "public-hot-read-binary");
    private static readonly Endpoint s_articleList = Create(PublicHotReadRouteKind.ArticleList, "public.hot-read.binary", "public-hot-read:article-list", "public-hot-read-binary");
    private static readonly Endpoint s_articleHot = Create(PublicHotReadRouteKind.ArticleHot, "public.hot-read.binary", "public-hot-read:article-hot", "public-hot-read-binary");
    private static readonly Endpoint s_articleFeatured = Create(PublicHotReadRouteKind.ArticleFeatured, "public.hot-read.binary", "public-hot-read:article-featured", "public-hot-read-binary");
    private static readonly Endpoint s_category = Create(PublicHotReadRouteKind.Category, "taxonomy.category", "public-hot-read:category", "public-hot-read-binary");
    private static readonly Endpoint s_tag = Create(PublicHotReadRouteKind.Tag, "taxonomy.tag", "public-hot-read:tag", "public-hot-read-binary");
    private static readonly Endpoint s_html = Create(PublicHotReadRouteKind.ArticleHtml, "public.hot-read.html", "public-hot-read:html", "public-hot-read-html");
    private static readonly Endpoint s_publicHome = Create(PublicHotReadRouteKind.PublicHtml, "public.html.home", "public-hot-read:public-home", "public-hot-read-html");
    private static readonly Endpoint s_publicFallback = Create(PublicHotReadRouteKind.PublicHtml, "public.html.fallback", "public-hot-read:public-fallback", "public-hot-read-html");

    internal static IReadOnlyList<Endpoint> All =>
        [s_articleDetail, s_articleList, s_articleHot, s_articleFeatured, s_category, s_tag, s_html, s_publicHome, s_publicFallback];

    internal static Endpoint Resolve(PublicHotReadRequestFeature feature)
        => feature.RouteKind switch
        {
            PublicHotReadRouteKind.ArticleDetail => s_articleDetail,
            PublicHotReadRouteKind.ArticleList => s_articleList,
            PublicHotReadRouteKind.ArticleHot => s_articleHot,
            PublicHotReadRouteKind.ArticleFeatured => s_articleFeatured,
            PublicHotReadRouteKind.Category => s_category,
            PublicHotReadRouteKind.Tag => s_tag,
            PublicHotReadRouteKind.ArticleHtml => s_html,
            PublicHotReadRouteKind.PublicHtml when feature.RiskRouteKey == "public.html.home" => s_publicHome,
            PublicHotReadRouteKind.PublicHtml => s_publicFallback,
            _ => throw new InvalidOperationException($"public hot-read endpoint policy missing: {feature.RouteKind}")
        };

    internal static void ValidateOrThrow()
        => ValidateOrThrow(PublicHotReadRouteSecurityCatalog.All, All);

    internal static void ValidateOrThrow(
        IReadOnlyList<PublicHotReadRoutePolicy> policies,
        IReadOnlyList<Endpoint> endpoints)
    {
        foreach (PublicHotReadRoutePolicy policy in policies)
        {
            if (!endpoints.Any(endpoint =>
                    endpoint.Metadata.GetMetadata<PublicFastPathRouteMetadata>()?.PolicyId == policy.PolicyId))
            {
                throw new InvalidOperationException(
                    $"public hot-read endpoint metadata missing for policy: {policy.PolicyId}");
            }
        }

        foreach (Endpoint endpoint in endpoints)
        {
            PublicFastPathRouteMetadata metadata = endpoint.Metadata.GetMetadata<PublicFastPathRouteMetadata>()
                ?? throw new InvalidOperationException(
                    $"public hot-read endpoint security metadata missing: {endpoint.DisplayName}");
            if (!policies.Any(policy =>
                    policy.PolicyId == metadata.PolicyId
                    && metadata.RequiresVisibilityEvidence == policy.RequiresVisibilityEvidence
                    && metadata.RequiresSecurityGate == policy.RequiresSecurityGate
                    && metadata.RequiresRateLimit == policy.RequiresRateLimit
                    && metadata.RequiresTraceCorrelation == policy.RequiresTraceCorrelation
                    && metadata.RequiresReleaseHeaders == policy.RequiresReleaseHeaders
                    && metadata.RequiresAnonymousRequest == policy.RequiresAnonymousRequest
                    && metadata.RequiresSafeMethod == policy.RequiresSafeMethod
                    && metadata.DefersCorsRequestsToEndpointPipeline == policy.DefersCorsRequestsToEndpointPipeline))
            {
                throw new InvalidOperationException(
                    $"public hot-read endpoint security metadata mismatch: {endpoint.DisplayName}");
            }
        }
    }

    private static Endpoint Create(
        PublicHotReadRouteKind kind,
        string riskRouteKey,
        string displayName,
        string routeKind)
    {
        if (!PublicHotReadRouteSecurityCatalog.TryGet(kind, out PublicHotReadRoutePolicy policy))
        {
            throw new InvalidOperationException($"public hot-read route policy missing: {kind}");
        }

        return new(
            static _ => Task.CompletedTask,
            new EndpointMetadataCollection(
                new EnableRateLimitingAttribute("public_read"),
                RiskActionRegistry.Default.CreateMetadata(RiskActionNames.PublicRead, riskRouteKey),
                new FsusRouteKindMetadata(routeKind),
                policy.ToEndpointMetadata()),
            displayName);
    }
}

public static class PublicHotReadEarlyDataPlaneExtensions
{
    public static IApplicationBuilder UseFsusPublicHotReadClassifier(this IApplicationBuilder app)
    {
        PublicHotReadEarlyDataPlaneRuntimeState runtimeState =
            app.ApplicationServices.GetRequiredService<PublicHotReadEarlyDataPlaneRuntimeState>();
        PublicHotReadClassifierCounters classifierCounters =
            app.ApplicationServices.GetRequiredService<PublicHotReadClassifierCounters>();
        return app.Use((context, next) =>
        {
            if (!runtimeState.Enabled)
            {
                return next(context);
            }

            if (!PublicHotReadFastPath.TryCreateRequestFeatureWithBypass(
                    context,
                    out PublicHotReadRequestFeature? feature,
                    out bool sensitivePrefixBypass,
                    out bool credentialBypass))
            {
                if (sensitivePrefixBypass)
                {
                    classifierCounters.SensitivePrefixBypass();
                }

                if (credentialBypass)
                {
                    classifierCounters.CredentialBypass();
                }

                return next(context);
            }

            PublicHotReadRequestFeature requestFeature = feature!;
            context.Features.Set(requestFeature);
            if (requestFeature.RequiresSecurityGate)
            {
                Endpoint endpoint = PublicHotReadEarlyEndpointCatalog.Resolve(requestFeature);
                context.SetEndpoint(endpoint);
                context.Features.Set(new PublicHotReadEarlyPipelineState(endpoint));
            }

            return next(context);
        });
    }

    public static IApplicationBuilder UseFsusPublicHotReadRequestAuditContext(this IApplicationBuilder app)
        => app.UseWhen(
            static context => context.Features.Get<PublicHotReadEarlyPipelineState>() is not null,
            static branch =>
            {
                branch.UseMiddleware<RequestAuditContextMiddleware>();
                branch.Use((context, next) =>
                {
                    PublicHotReadEarlyPipelineState state =
                        context.Features.Get<PublicHotReadEarlyPipelineState>()
                        ?? throw new InvalidOperationException(
                            "PublicHotRead early request audit requires classifier state.");
                    state.MarkRequestAuditContextEvaluated();
                    return next(context);
                });
            });

    public static IApplicationBuilder UseFsusPublicHotReadRateLimiter(this IApplicationBuilder app)
        => app.UseWhen(
            static context =>
                context.Features.Get<PublicHotReadRequestFeature>()?.RequiresSecurityGate == true
                && !context.Response.HasStarted,
            static branch =>
            {
                branch.Use((context, next) =>
                {
                    PublicHotReadEarlyPipelineState state =
                        context.Features.Get<PublicHotReadEarlyPipelineState>()
                        ?? throw new InvalidOperationException("PublicHotRead early rate limiter requires classifier state.");
                    state.MarkRateLimitEvaluated();
                    return next(context);
                });
                branch.UseRateLimiter();
            });

    public static IApplicationBuilder UseFsusPublicHotReadFallbackRestore(this IApplicationBuilder app)
        => app.Use((context, next) =>
        {
            PublicHotReadEarlyPipelineState? state = context.Features.Get<PublicHotReadEarlyPipelineState>();
            if (state is not null && ReferenceEquals(context.GetEndpoint(), state.SyntheticEndpoint))
            {
                context.SetEndpoint(null);
            }

            return next(context);
        });
}
