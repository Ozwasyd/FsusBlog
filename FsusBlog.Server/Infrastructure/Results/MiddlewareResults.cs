using FsusBlog.Server.Models.Responses;

namespace FsusBlog.Server.Infrastructure.Results;

public static class MiddlewareResults
{
    public static Task WriteErrorAsync(HttpContext context, string message, int statusCode, string? traceId = null)
    {
        context.Response.StatusCode = statusCode;
        context.Response.ContentType = "application/json";
        return context.Response.WriteAsJsonAsync(ApiResponse.Fail(message, statusCode, traceId ?? context.TraceIdentifier));
    }
}
