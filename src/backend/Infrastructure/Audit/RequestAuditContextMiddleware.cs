namespace FsusBlog.Server.Infrastructure.Audit;

public sealed class RequestAuditContextMiddleware(RequestDelegate next)
{
    private readonly RequestDelegate _next = next;

    public async Task InvokeAsync(HttpContext context)
    {
        if (!ShouldAttachAuditContext(context))
        {
            await _next(context);
            return;
        }

        RequestAuditContextSnapshot snapshot = RequestAuditContextSnapshot.FromHttpContext(context);
        using IDisposable scope = snapshot.PushLogContext();
        await _next(context);
    }

    internal static bool ShouldAttachAuditContext(HttpContext context)
    {
        if (context.User.Identity?.IsAuthenticated == true)
        {
            return true;
        }

        if (!HttpMethods.IsGet(context.Request.Method)
            && !HttpMethods.IsHead(context.Request.Method)
            && !HttpMethods.IsOptions(context.Request.Method))
        {
            return true;
        }

        PathString path = context.Request.Path;
        return path.StartsWithSegments("/api/auth", StringComparison.OrdinalIgnoreCase)
            || path.StartsWithSegments("/api/binary/auth", StringComparison.OrdinalIgnoreCase)
            || path.StartsWithSegments("/api/security", StringComparison.OrdinalIgnoreCase)
            || path.StartsWithSegments("/api/binary/security", StringComparison.OrdinalIgnoreCase)
            || path.StartsWithSegments("/api/author", StringComparison.OrdinalIgnoreCase)
            || path.StartsWithSegments("/api/binary/author", StringComparison.OrdinalIgnoreCase)
            || path.StartsWithSegments("/api/admin", StringComparison.OrdinalIgnoreCase)
            || path.StartsWithSegments("/api/binary/admin", StringComparison.OrdinalIgnoreCase);
    }
}
