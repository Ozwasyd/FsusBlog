using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Common;
using Microsoft.AspNetCore.Mvc;

namespace FsusBlog.Server.Infrastructure.Results;

public static class EndpointFilterResults
{
    public static IResult FromActionResult(IActionResult actionResult, HttpContext context)
    {
        int statusCode = actionResult switch
        {
            UnauthorizedObjectResult => StatusCodes.Status401Unauthorized,
            BadRequestObjectResult => StatusCodes.Status400BadRequest,
            ObjectResult { StatusCode: int explicitStatusCode } => explicitStatusCode,
            _ => StatusCodes.Status500InternalServerError
        };

        var error = actionResult is ObjectResult { Value: ErrorDetail detail }
            ? detail.WithTraceId(context.TraceIdentifier)
            : ApiErrorSemanticMapper.CreateError(statusCode, traceId: context.TraceIdentifier);

        var aeds = context.RequestServices.GetService<IAedsEncoder>();
        if (aeds is not null)
        {
            return BinaryResults.FromError(error, aeds, statusCode);
        }

        return Microsoft.AspNetCore.Http.Results.StatusCode(statusCode);
    }
}
