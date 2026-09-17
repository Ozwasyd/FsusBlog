namespace FsusBlog.Server.Infrastructure.PublicAot;

public interface IPublicAotRuntimeState
{
    void SetAssetMode(HttpContext context, string assetMode);

    void SetClassifiedFailure(
        HttpContext context,
        PublicAotRenderStatus status,
        string assetMode);

    void SetDevelopmentFallback(HttpContext context);

    void SetFresh(HttpContext context, PublicAotCacheEntry entry);

    void SetCacheMiss(HttpContext context, bool classifyColdMiss, bool queued);

    PublicAotSsrFailureClass RecordBackfillFailure(
        PublicAotBackfillRequest request,
        string message);

    void RecordBackfillFailure(
        PublicAotBackfillRequest request,
        PublicAotSsrFailureClass failureClass,
        string message);

    void RecordBackfillSuccess(PublicAotBackfillRequest request);

    void ClearAllRouteQuarantines();
}

public sealed class PublicAotRuntimeState(
    PublicAotSsrRuntimeState ssrRuntimeState) : IPublicAotRuntimeState
{
    public const string PublicAotSourceContextKey = "__fsus_public_aot_source";
    public const string PublicAotVersionContextKey = "__fsus_public_aot_version";
    public const string PublicAotBackfillContextKey = "__fsus_public_aot_backfill";
    public const string PublicAotStateContextKey = "__fsus_public_aot_state";
    public const string PublicAotAssetModeContextKey = "__fsus_public_aot_asset_mode";

    public void SetAssetMode(HttpContext context, string assetMode)
    {
        context.Items[PublicAotAssetModeContextKey] = assetMode;
    }

    public void SetClassifiedFailure(
        HttpContext context,
        PublicAotRenderStatus status,
        string assetMode)
    {
        context.Items[PublicAotSourceContextKey] = status == PublicAotRenderStatus.PermanentRedirect
            ? "server-redirect"
            : "server-status";
        context.Items[PublicAotVersionContextKey] = PublicAotConstants.RendererVersion;
        context.Items[PublicAotBackfillContextKey] = "none";
        context.Items[PublicAotStateContextKey] = status switch
        {
            PublicAotRenderStatus.PermanentRedirect => "permanent-redirect",
            PublicAotRenderStatus.NotFound => "not-found",
            PublicAotRenderStatus.Gone => "gone",
            _ => "transient-failure"
        };
        context.Items[PublicAotAssetModeContextKey] = assetMode;
    }

    public void SetDevelopmentFallback(HttpContext context)
    {
        context.Items[PublicAotSourceContextKey] = "spa-fallback";
        context.Items[PublicAotVersionContextKey] = PublicAotConstants.RendererVersion;
        context.Items[PublicAotBackfillContextKey] = "dev-source-bypass";
        context.Items[PublicAotStateContextKey] = "fallback";
    }

    public void SetFresh(HttpContext context, PublicAotCacheEntry entry)
    {
        context.Items[PublicAotSourceContextKey] = entry.Source.ToHeaderValue();
        context.Items[PublicAotVersionContextKey] = entry.RendererVersion;
        context.Items[PublicAotBackfillContextKey] = "none";
        context.Items[PublicAotStateContextKey] = "fresh";
    }

    public void SetCacheMiss(HttpContext context, bool classifyColdMiss, bool queued)
    {
        context.Items[PublicAotSourceContextKey] = classifyColdMiss ? "server-status" : "spa-fallback";
        context.Items[PublicAotVersionContextKey] = PublicAotConstants.RendererVersion;
        context.Items[PublicAotBackfillContextKey] = queued ? "queued" : "dropped";
        context.Items[PublicAotStateContextKey] = classifyColdMiss ? "cold-miss" : "fallback";
    }

    public PublicAotSsrFailureClass RecordBackfillFailure(
        PublicAotBackfillRequest request,
        string message)
    {
        PublicAotSsrFailureClass failureClass = PublicAotSsrRuntimeState.ClassifyFailure(message);
        RecordBackfillFailure(request, failureClass, message);
        return failureClass;
    }

    public void RecordBackfillFailure(
        PublicAotBackfillRequest request,
        PublicAotSsrFailureClass failureClass,
        string message)
    {
        ssrRuntimeState.RecordBackfillFailure(request, failureClass, message, TimeSpan.Zero);
    }

    public void RecordBackfillSuccess(PublicAotBackfillRequest request)
    {
        ssrRuntimeState.RecordBackfillSuccess(request, TimeSpan.Zero);
    }

    public void ClearAllRouteQuarantines()
    {
        ssrRuntimeState.ClearAllRouteQuarantines();
    }
}
