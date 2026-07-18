using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Results;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Mvc;

namespace FsusBlog.Server.Infrastructure.Filters;

public sealed class StrongAnonymousRequestMetadata
{
    public static readonly StrongAnonymousRequestMetadata Instance = new();

    private StrongAnonymousRequestMetadata()
    {
    }
}

public static class StrongAnonymousEndpointFilterExtensions
{
    public static RouteHandlerBuilder RequireStrongAnonymousRequest(this RouteHandlerBuilder builder)
    {
        builder.WithMetadata(StrongAnonymousRequestMetadata.Instance);
        return builder.AddEndpointFilter<RejectIdentifiedPrincipalFilter>();
    }
}

public sealed partial class RejectIdentifiedPrincipalFilter(ILogger<RejectIdentifiedPrincipalFilter> logger) : IEndpointFilter
{
    public const string PublicErrorMessage = "匿名发布请求不能携带登录态，请刷新后重试。";
    public const string ErrorDetails = "anonymous_identity_contaminated";
    public const string AccessTokenBridgeHeaderName = "X-Fsus-Access-Token";
    public const string BearerBridgeHeaderName = "X-Fsus-Bearer-Token";
    public const string SessionBridgeHeaderName = "X-Fsus-Session-Id";

    private const string CookieHeaderName = "Cookie";
    private const string AuthorizationHeaderName = "Authorization";
    private const string AuthBridgeHeaderName = "X-Fsus-Auth-Bridge";

    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        HttpContext httpContext = context.HttpContext;
        bool hasCookie = httpContext.Request.Headers.ContainsKey(CookieHeaderName);
        bool hasAuthorization = httpContext.Request.Headers.ContainsKey(AuthorizationHeaderName);
        bool hasBridgeHeader = HasBridgeIdentityHeader(httpContext);
        bool hasAuthenticatedPrincipal = httpContext.User.Identity?.IsAuthenticated == true;

        if (!hasCookie && !hasAuthorization && !hasBridgeHeader && !hasAuthenticatedPrincipal)
        {
            return await next(context);
        }

        string reason = ResolveReason(hasCookie, hasAuthorization, hasBridgeHeader, hasAuthenticatedPrincipal);
        using var auditScope = AuditLogScope.Push(
            AuditSourceCatalog.Security,
            AuditTypeCatalog.Security,
            new KeyValuePair<string, object?>(AuditPropertyNames.Action, "anonymous.identity.rejected"),
            new KeyValuePair<string, object?>(AuditPropertyNames.Outcome, AuditOutcomeCatalog.Denied),
            new KeyValuePair<string, object?>(AuditPropertyNames.Severity, AuditSeverityCatalog.Warning),
            new KeyValuePair<string, object?>(AuditPropertyNames.ReasonCode, reason));

        LogAnonymousIdentityContaminated(
            logger,
            httpContext.TraceIdentifier,
            httpContext.Request.Path.Value ?? string.Empty,
            reason,
            hasCookie,
            hasAuthorization,
            hasBridgeHeader,
            hasAuthenticatedPrincipal);

        return EndpointFilterResults.FromActionResult(
            new ObjectResult(ErrorDetail.Create(
                ErrorCode.Forbidden,
                PublicErrorMessage,
                ErrorDetails,
                httpContext.TraceIdentifier))
            {
                StatusCode = StatusCodes.Status403Forbidden
            },
            httpContext);
    }

    private static bool HasBridgeIdentityHeader(HttpContext context)
        => context.Request.Headers.ContainsKey(AccessTokenBridgeHeaderName)
            || context.Request.Headers.ContainsKey(BearerBridgeHeaderName)
            || context.Request.Headers.ContainsKey(SessionBridgeHeaderName)
            || context.Request.Headers.ContainsKey(AuthBridgeHeaderName);

    private static string ResolveReason(
        bool hasCookie,
        bool hasAuthorization,
        bool hasBridgeHeader,
        bool hasAuthenticatedPrincipal)
    {
        if (hasCookie)
        {
            return "cookie_header";
        }

        if (hasAuthorization)
        {
            return "authorization_header";
        }

        if (hasBridgeHeader)
        {
            return "identity_bridge_header";
        }

        return hasAuthenticatedPrincipal ? "authenticated_principal" : "unknown_identity_contamination";
    }

    [LoggerMessage(
        EventId = 152,
        Level = LogLevel.Warning,
        Message = "Strong anonymous request rejected | TraceId: {TraceId} | Path: {Path} | Reason: {Reason} | HasCookie={HasCookie} | HasAuthorization={HasAuthorization} | HasBridgeHeader={HasBridgeHeader} | HasAuthenticatedPrincipal={HasAuthenticatedPrincipal}")]
    private static partial void LogAnonymousIdentityContaminated(
        ILogger logger,
        string traceId,
        string path,
        string reason,
        bool hasCookie,
        bool hasAuthorization,
        bool hasBridgeHeader,
        bool hasAuthenticatedPrincipal);
}
