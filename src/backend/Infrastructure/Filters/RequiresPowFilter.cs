using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using Microsoft.AspNetCore.Mvc;

namespace FsusBlog.Server.Infrastructure.Filters;

public sealed class RequiresPowFilter(
    ILogger<RequiresPowFilter> logger,
    IPowService powService,
    AdaptivePowGovernor governor) : IEndpointFilter
{
    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var validationResult = await PowValidationLogic.ValidateAsync(
            context.HttpContext, logger, powService, governor);

        if (validationResult != null)
        {
            return EndpointFilterResults.FromActionResult(validationResult, context.HttpContext);
        }

        return await next(context);
    }
}
