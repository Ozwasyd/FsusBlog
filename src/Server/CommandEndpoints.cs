namespace FsusBlog.V2.Server;

internal static class CommandEndpoints
{
    internal const string Policy = "command";

    internal static RouteHandlerBuilder MapCommandGet(this IEndpointRouteBuilder routes, string pattern, Delegate handler) =>
        routes.MapGet(pattern, handler).RequireRateLimiting(Policy);

    internal static RouteHandlerBuilder MapCommandPost(this IEndpointRouteBuilder routes, string pattern, Delegate handler) =>
        routes.MapPost(pattern, handler).RequireRateLimiting(Policy);

    internal static RouteHandlerBuilder MapCommandPut(this IEndpointRouteBuilder routes, string pattern, Delegate handler) =>
        routes.MapPut(pattern, handler).RequireRateLimiting(Policy);

    internal const string QueryPolicy = "query";

    internal static RouteHandlerBuilder MapQueryGet(this IEndpointRouteBuilder routes, string pattern, Delegate handler) =>
        routes.MapGet(pattern, handler).RequireRateLimiting(QueryPolicy);

    internal static RouteHandlerBuilder MapQueryMethods(this IEndpointRouteBuilder routes, string pattern, IEnumerable<string> methods, Delegate handler) =>
        routes.MapMethods(pattern, methods, handler).RequireRateLimiting(QueryPolicy);
}
