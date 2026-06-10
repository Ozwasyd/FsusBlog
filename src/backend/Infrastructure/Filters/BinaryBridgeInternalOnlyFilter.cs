namespace FsusBlog.Server.Infrastructure.Filters;

public static class BinaryBridgeInternalRequest
{
    public const string ItemKey = "__fsusblog_binary_bridge_internal";
    public const string AuthoringPrefix = "/_fsus/internal/binary-bridge/author";
    public const string SecurityPrefix = "/_fsus/internal/binary-bridge/admin/security";
}

public sealed class BinaryBridgeInternalOnlyFilter : IEndpointFilter
{
    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        if (context.HttpContext.Items.TryGetValue(BinaryBridgeInternalRequest.ItemKey, out object? value)
            && value is true)
        {
            return await next(context);
        }

        return TypedResults.NotFound();
    }
}
