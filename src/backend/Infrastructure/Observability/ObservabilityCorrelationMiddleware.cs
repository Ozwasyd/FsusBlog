using System.Diagnostics;

namespace FsusBlog.Server.Infrastructure.Observability;

public sealed class ObservabilityCorrelationMiddleware(RequestDelegate next)
{
    private readonly RequestDelegate _next = next;

    public async Task InvokeAsync(HttpContext context)
    {
        string routeKind = FsusObservability.ClassifyRoute(context.Request.Path);
        Activity? activity = Activity.Current;
        if (activity is not null)
        {
            string traceId = activity.TraceId.ToString();
            if (!string.IsNullOrWhiteSpace(traceId))
            {
                context.TraceIdentifier = traceId;
            }

            FsusObservability.SetTag(activity, "fsus.route_kind", routeKind);
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
            FsusObservability.RecordHttpRequest(routeKind, context.Response.StatusCode, duration);
            FsusObservability.SetTag(Activity.Current, "fsus.http.status_code", context.Response.StatusCode);
        }
    }
}
