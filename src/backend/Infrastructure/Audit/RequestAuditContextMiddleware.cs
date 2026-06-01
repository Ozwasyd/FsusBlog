using System.Security.Claims;
using Serilog.Context;

namespace FsusBlog.Server.Infrastructure.Audit;

public sealed class RequestAuditContextMiddleware(RequestDelegate next)
{
    private readonly RequestDelegate _next = next;

    public async Task InvokeAsync(HttpContext context)
    {
        using IDisposable traceId = LogContext.PushProperty("TraceId", context.TraceIdentifier);
        using IDisposable requestPath = LogContext.PushProperty("RequestPath", context.Request.Path.Value);
        using IDisposable requestMethod = LogContext.PushProperty("RequestMethod", context.Request.Method);
        using IDisposable userId = LogContext.PushProperty("UserId", context.User.FindFirstValue(ClaimTypes.NameIdentifier));

        await _next(context);
    }
}
