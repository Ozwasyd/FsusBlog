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

    internal PublicHotReadRoute Route { get; }
    internal PublicHotReadRouteKind RouteKind => Route.Kind;
    internal int ArticleId => Route.ArticleId;
    internal PublicListKey ListKey => Route.ListKey;
    internal string HtmlRouteKey => Route.HtmlRouteKey;
    internal bool Classified { get; }
    internal bool RejectedPath { get; }
    internal PublicHotReadArtifactMediaKind MediaKind { get; }
    internal bool IsHtml => MediaKind == PublicHotReadArtifactMediaKind.Html;
    internal bool FallbackToEndpoint { get; }
    internal string RiskRouteKey { get; }
    internal PublicHotReadRoutePolicy RoutePolicy { get; }
    internal string RoutePolicyId => RoutePolicy.PolicyId;
    internal bool RequiresVisibilityEvidence => RoutePolicy.RequiresVisibilityEvidence;
    internal bool RequiresSecurityGate => RoutePolicy.RequiresSecurityGate;
    internal int ClassificationCount { get; }
}

internal sealed class PublicHotReadEarlyPipelineState
{
    internal PublicHotReadEarlyPipelineState(Endpoint syntheticEndpoint)
    {
        SyntheticEndpoint = syntheticEndpoint;
    }

    internal Endpoint SyntheticEndpoint { get; }
    internal bool RateLimitEvaluated { get; set; }
}

internal sealed class PublicReadSecurityGateResultFeature
{
    internal static readonly PublicReadSecurityGateResultFeature Allowed = new();

    private PublicReadSecurityGateResultFeature()
    {
    }
}

internal static class PublicHotReadEarlyEndpointCatalog
{
    private static readonly Endpoint ArticleDetail = Create(PublicHotReadRouteKind.ArticleDetail, "article.detail", "public-hot-read:article-detail", "public-hot-read-binary");
    private static readonly Endpoint ArticleList = Create(PublicHotReadRouteKind.ArticleList, "public.hot-read.binary", "public-hot-read:article-list", "public-hot-read-binary");
    private static readonly Endpoint ArticleHot = Create(PublicHotReadRouteKind.ArticleHot, "public.hot-read.binary", "public-hot-read:article-hot", "public-hot-read-binary");
    private static readonly Endpoint ArticleFeatured = Create(PublicHotReadRouteKind.ArticleFeatured, "public.hot-read.binary", "public-hot-read:article-featured", "public-hot-read-binary");
    private static readonly Endpoint Category = Create(PublicHotReadRouteKind.Category, "taxonomy.category", "public-hot-read:category", "public-hot-read-binary");
    private static readonly Endpoint Tag = Create(PublicHotReadRouteKind.Tag, "taxonomy.tag", "public-hot-read:tag", "public-hot-read-binary");
    private static readonly Endpoint Html = Create(PublicHotReadRouteKind.ArticleHtml, "public.hot-read.html", "public-hot-read:html", "public-hot-read-html");
    private static readonly Endpoint PublicHome = Create(PublicHotReadRouteKind.PublicHtml, "public.html.home", "public-hot-read:public-home", "public-hot-read-html");
    private static readonly Endpoint PublicFallback = Create(PublicHotReadRouteKind.PublicHtml, "public.html.fallback", "public-hot-read:public-fallback", "public-hot-read-html");

    internal static IReadOnlyList<Endpoint> All =>
        [ArticleDetail, ArticleList, ArticleHot, ArticleFeatured, Category, Tag, Html, PublicHome, PublicFallback];

    internal static Endpoint Resolve(PublicHotReadRequestFeature feature)
        => feature.RouteKind switch
        {
            PublicHotReadRouteKind.ArticleDetail => ArticleDetail,
            PublicHotReadRouteKind.ArticleList => ArticleList,
            PublicHotReadRouteKind.ArticleHot => ArticleHot,
            PublicHotReadRouteKind.ArticleFeatured => ArticleFeatured,
            PublicHotReadRouteKind.Category => Category,
            PublicHotReadRouteKind.Tag => Tag,
            PublicHotReadRouteKind.ArticleHtml => Html,
            PublicHotReadRouteKind.PublicHtml when feature.RiskRouteKey == "public.html.home" => PublicHome,
            PublicHotReadRouteKind.PublicHtml => PublicFallback,
            _ => throw new InvalidOperationException($"public hot-read endpoint policy missing: {feature.RouteKind}")
        };

    internal static void ValidateOrThrow()
    {
        foreach (PublicHotReadRoutePolicy policy in PublicHotReadRouteSecurityCatalog.All)
        {
            if (!All.Any(endpoint =>
                    endpoint.Metadata.GetMetadata<PublicFastPathRouteMetadata>()?.PolicyId == policy.PolicyId))
            {
                throw new InvalidOperationException(
                    $"public hot-read endpoint metadata missing for policy: {policy.PolicyId}");
            }
        }

        foreach (Endpoint endpoint in All)
        {
            PublicFastPathRouteMetadata metadata = endpoint.Metadata.GetMetadata<PublicFastPathRouteMetadata>()
                ?? throw new InvalidOperationException(
                    $"public hot-read endpoint security metadata missing: {endpoint.DisplayName}");
            if (!PublicHotReadRouteSecurityCatalog.All.Any(policy =>
                    policy.PolicyId == metadata.PolicyId
                    && metadata.RequiresVisibilityEvidence == policy.RequiresVisibilityEvidence
                    && metadata.RequiresSecurityGate == policy.RequiresSecurityGate
                    && metadata.RequiresRateLimit == policy.RequiresRateLimit
                    && metadata.RequiresTraceCorrelation == policy.RequiresTraceCorrelation
                    && metadata.RequiresReleaseHeaders == policy.RequiresReleaseHeaders))
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

    public static IApplicationBuilder UseFsusPublicHotReadRateLimiter(this IApplicationBuilder app)
        => app.UseWhen(
            static context => context.Features.Get<PublicHotReadRequestFeature>()?.RequiresSecurityGate == true,
            static branch =>
            {
                branch.Use((context, next) =>
                {
                    PublicHotReadEarlyPipelineState state =
                        context.Features.Get<PublicHotReadEarlyPipelineState>()
                        ?? throw new InvalidOperationException("PublicHotRead early rate limiter requires classifier state.");
                    state.RateLimitEvaluated = true;
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
