using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Common;

namespace FsusBlog.Server.Infrastructure.Results;

public static class MiddlewareResults
{
    public static Task WriteErrorAsync(
        HttpContext context,
        string message,
        ApiErrorTransportMappingId mappingId,
        string? traceId = null,
        string? details = null)
    {
        var error = ApiErrorSemanticMapper.CreateError(mappingId, message, traceId ?? context.TraceIdentifier, details);
        var aeds = context.RequestServices.GetService<IAedsEncoder>();
        if (aeds is not null)
        {
            return BinaryResults.FromError(error, aeds, mappingId).ExecuteAsync(context);
        }

        context.Response.StatusCode = ApiErrorSemanticMapper.GetMapping(mappingId).HttpStatus;
        return Task.CompletedTask;
    }

}
