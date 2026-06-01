using System.Diagnostics;
using Microsoft.Extensions.Options;

namespace FsusBlog.Server.Infrastructure.Observability;

public sealed class ObservabilityCorrelationMiddleware(RequestDelegate next, IOptions<FsusObservabilityOptions> options)
{
    private readonly RequestDelegate _next = next;
    private readonly int _httpMetricsSampleRate = Math.Clamp(options.Value.HttpMetricsSampleRate, 1, 4096);
    private readonly double _slowRequestThresholdMs = Math.Max(1, options.Value.SlowRequestThresholdMilliseconds);

    public async Task InvokeAsync(HttpContext context)
    {
        string routeKind = FsusObservability.ResolveRouteKind(context);
        Activity? activity = Activity.Current;
        if (activity is not null)
        {
            string traceId = activity.TraceId.ToString();
            if (!string.IsNullOrWhiteSpace(traceId))
            {
                context.TraceIdentifier = traceId;
            }

            if (activity.IsAllDataRequested)
            {
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
}
