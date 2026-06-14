using System.Diagnostics;
using Microsoft.Extensions.Options;

namespace FsusBlog.Server.Infrastructure.Observability;

public sealed class ObservabilityCorrelationMiddleware
{
    private readonly RequestDelegate _next;
    private readonly int _httpMetricsSampleRate;
    private readonly double _slowRequestThresholdMs;
    private readonly bool _traceExporterEnabled;

    public ObservabilityCorrelationMiddleware(RequestDelegate next, IOptions<FsusObservabilityOptions> options)
        : this(next, options, runtimeState: null)
    {
    }

    public ObservabilityCorrelationMiddleware(
        RequestDelegate next,
        IOptions<FsusObservabilityOptions> options,
        ObservabilityRuntimeState? runtimeState)
    {
        _next = next;
        _httpMetricsSampleRate = Math.Clamp(options.Value.HttpMetricsSampleRate, 1, 4096);
        _slowRequestThresholdMs = Math.Max(1, options.Value.SlowRequestThresholdMilliseconds);
        _traceExporterEnabled = runtimeState?.ExporterEnabled ?? options.Value.ExporterEnabled;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        string? routeKind = null;
        Activity? activity = Activity.Current;
        if (activity is not null)
        {
            if (ShouldMaterializeTraceId(activity))
            {
                string materializedTraceId = activity.TraceId.ToString();
                if (!string.IsNullOrWhiteSpace(materializedTraceId))
                {
                    context.TraceIdentifier = materializedTraceId;
                }
            }

            if (activity.IsAllDataRequested)
            {
                routeKind = FsusObservability.ResolveRouteKind(context);
                FsusObservability.SetTag(activity, "fsus.route_kind", routeKind);
            }
        }

        context.Response.OnStarting(static state =>
        {
            var httpContext = (HttpContext)state;
            httpContext.Response.Headers["X-Fsus-Trace-Id"] = httpContext.TraceIdentifier;
            return Task.CompletedTask;
        }, context);

        long startedAt = Stopwatch.GetTimestamp();
        try
        {
            await _next(context);
        }
        finally
        {
            TimeSpan duration = FsusObservability.GetElapsed(startedAt);
            int statusCode = context.Response.StatusCode;
            if (ShouldRecordHttpRequest(statusCode, duration))
            {
                routeKind ??= FsusObservability.ResolveRouteKind(context);
                FsusObservability.RecordHttpRequest(routeKind, statusCode, duration);
            }

            Activity? current = Activity.Current;
            if (current?.IsAllDataRequested == true)
            {
                FsusObservability.SetTag(current, "fsus.http.status_code", statusCode);
            }
        }
    }

    private bool ShouldRecordHttpRequest(int statusCode, TimeSpan duration)
        => statusCode >= StatusCodes.Status500InternalServerError
            || duration.TotalMilliseconds >= _slowRequestThresholdMs
            || _httpMetricsSampleRate <= 1
            || Random.Shared.Next(_httpMetricsSampleRate) == 0;

    private bool ShouldMaterializeTraceId(Activity activity)
        => _traceExporterEnabled || activity.IsAllDataRequested || activity.Recorded;
}
