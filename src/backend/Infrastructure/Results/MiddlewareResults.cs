using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Common;

namespace FsusBlog.Server.Infrastructure.Results;

public static class MiddlewareResults
{
    public static Task WriteErrorAsync(HttpContext context, string message, int statusCode, string? traceId = null)
    {
        var error = ApiErrorSemanticMapper.CreateError(statusCode, message, traceId ?? context.TraceIdentifier);
        var aeds = context.RequestServices.GetService<IAedsEncoder>();
        if (aeds is not null)
        {
            return BinaryResults.FromError(error, aeds, statusCode).ExecuteAsync(context);
        }

        context.Response.StatusCode = statusCode;
        return Task.CompletedTask;
    }

}
