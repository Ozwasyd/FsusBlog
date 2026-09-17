using FsusBlog.Server.Infrastructure.PublicReadArtifacts;

namespace FsusBlog.Server.Infrastructure.Filters;

public sealed class RiskAwarePublicReadFilter(PublicReadSecurityGate gate) : IEndpointFilter
{
    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        HttpContext httpContext = context.HttpContext;
        if (httpContext.Features.Get<PublicReadSecurityGateResultFeature>() is not null)
        {
            return await next(context);
        }

        IResult? rejection = await gate.EvaluateAsync(httpContext);
        return rejection ?? await next(context);
    }
}
