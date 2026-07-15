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

    internal void SensitivePrefixBypass()
        => Interlocked.Increment(ref _sensitivePrefixBypass);

    internal long SensitivePrefixBypassSnapshot()
        => Volatile.Read(ref _sensitivePrefixBypass);

    internal long CollectSensitivePrefixBypassAndReset()
        => Interlocked.Exchange(ref _sensitivePrefixBypass, 0);
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
        bool isHtml,
        bool fallbackToEndpoint,
        string riskRouteKey,
        bool requiresSecurityGate,
        int classificationCount)
    {
        Route = route;
        Classified = classified;
        RejectedPath = rejectedPath;
        MediaKind = isHtml ? PublicHotReadArtifactMediaKind.Html : PublicHotReadArtifactMediaKind.Binary;
        FallbackToEndpoint = fallbackToEndpoint;
        RiskRouteKey = riskRouteKey;
        RequiresSecurityGate = requiresSecurityGate;
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
    internal bool RequiresSecurityGate { get; }
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
    private static readonly Endpoint Binary = Create("public.hot-read.binary", "public-hot-read:binary", "public-hot-read-binary");
    private static readonly Endpoint ArticleDetail = Create("article.detail", "public-hot-read:article-detail", "public-hot-read-binary");
    private static readonly Endpoint Category = Create("taxonomy.category", "public-hot-read:category", "public-hot-read-binary");
    private static readonly Endpoint Tag = Create("taxonomy.tag", "public-hot-read:tag", "public-hot-read-binary");
    private static readonly Endpoint Html = Create("public.hot-read.html", "public-hot-read:html", "public-hot-read-html");
    private static readonly Endpoint PublicHome = Create("public.html.home", "public-hot-read:public-home", "public-hot-read-html");
    private static readonly Endpoint PublicFallback = Create("public.html.fallback", "public-hot-read:public-fallback", "public-hot-read-html");

    internal static Endpoint Resolve(PublicHotReadRequestFeature feature)
        => feature.RiskRouteKey switch
        {
            "article.detail" => ArticleDetail,
            "taxonomy.category" => Category,
            "taxonomy.tag" => Tag,
            "public.hot-read.html" => Html,
            "public.html.home" => PublicHome,
            "public.html.fallback" => PublicFallback,
            _ => Binary
        };

    private static Endpoint Create(string riskRouteKey, string displayName, string routeKind)
        => new(
            static _ => Task.CompletedTask,
            new EndpointMetadataCollection(
                new EnableRateLimitingAttribute("public_read"),
                RiskActionRegistry.Default.CreateMetadata(RiskActionNames.PublicRead, riskRouteKey),
                new FsusRouteKindMetadata(routeKind)),
            displayName);
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
                    out bool sensitivePrefixBypass))
            {
                if (sensitivePrefixBypass)
                {
                    classifierCounters.SensitivePrefixBypass();
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
