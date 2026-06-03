using Serilog.Context;

namespace FsusBlog.Server.Infrastructure.Audit;

public sealed class RequestAuditContextMiddleware(RequestDelegate next)
{
    private readonly RequestDelegate _next = next;

    public async Task InvokeAsync(HttpContext context)
    {
        RequestAuditContextSnapshot snapshot = RequestAuditContextSnapshot.FromHttpContext(context);
        IReadOnlyDictionary<string, object?> properties = snapshot.ToProperties();
        var disposables = new List<IDisposable>(properties.Count);
        foreach ((string key, object? value) in properties)
        {
            disposables.Add(LogContext.PushProperty(key, value));
        }

        try
        {
            await _next(context);
        }
        finally
        {
            for (int i = disposables.Count - 1; i >= 0; i--)
            {
                disposables[i].Dispose();
            }
        }
    }
}
