using Serilog.Context;

namespace FsusBlog.Server.Infrastructure.Audit;

public sealed class RequestAuditContextMiddleware(RequestDelegate next)
{
    private readonly RequestDelegate _next = next;

    public async Task InvokeAsync(HttpContext context)
    {
        RequestAuditContextSnapshot snapshot = RequestAuditContextSnapshot.FromHttpContext(context);
        IReadOnlyDictionary<string, object?> properties = snapshot.ToProperties();

        IDisposable[] disposables =
        [
            LogContext.PushProperty("TraceId", properties["TraceId"]),
            LogContext.PushProperty("RequestPath", properties["RequestPath"]),
            LogContext.PushProperty("RequestMethod", properties["RequestMethod"]),
            LogContext.PushProperty("UserId", properties["UserId"])
        ];

        try
        {
            await _next(context);
        }
        finally
        {
            for (int i = disposables.Length - 1; i >= 0; i--)
            {
                disposables[i].Dispose();
            }
        }
    }
}
