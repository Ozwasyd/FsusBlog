using FsusBlog.Server.Infrastructure.Observability;

using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.ResponseCompression;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Primitives;

namespace FsusBlog.Server.Infrastructure.Security;

internal sealed class PublicResponseCompressionMetadata
{
    public static PublicResponseCompressionMetadata Instance { get; } = new();

    private PublicResponseCompressionMetadata()
    {
    }
}

internal sealed class PublicResponseCompressionPolicyOptions
{
    public const string SectionName = "ResponseCompressionPolicy";

    public bool Enabled { get; set; } = true;
}

internal static class PublicResponseCompressionEndpointConventionBuilderExtensions
{
    public static TBuilder AllowPublicResponseCompression<TBuilder>(this TBuilder builder)
        where TBuilder : IEndpointConventionBuilder
    {
        builder.WithMetadata(PublicResponseCompressionMetadata.Instance);
        return builder;
    }
}

internal static class PublicResponseCompressionServiceCollectionExtensions
{
    public static IServiceCollection AddFsusPublicResponseCompression(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        services.Configure<PublicResponseCompressionPolicyOptions>(
            configuration.GetSection(PublicResponseCompressionPolicyOptions.SectionName));
        services.AddResponseCompression(options =>
        {
            options.EnableForHttps = true;
            options.Providers.Add<BrotliCompressionProvider>();
            options.Providers.Add<GzipCompressionProvider>();
            options.MimeTypes = PublicResponseCompressionPolicy.AllowedMimeTypes;
        });
        services.Replace(ServiceDescriptor.Singleton<IResponseCompressionProvider, EndpointAwareResponseCompressionProvider>());
        return services;
    }
}

internal sealed class EndpointAwareResponseCompressionProvider : IResponseCompressionProvider
{
    private readonly ResponseCompressionProvider _inner;
    private readonly IOptionsMonitor<PublicResponseCompressionPolicyOptions> _options;

    public EndpointAwareResponseCompressionProvider(
        IServiceProvider services,
        IOptions<ResponseCompressionOptions> compressionOptions,
        IOptionsMonitor<PublicResponseCompressionPolicyOptions> options)
    {
        _inner = new ResponseCompressionProvider(services, compressionOptions);
        _options = options;
    }

    public ICompressionProvider? GetCompressionProvider(HttpContext context)
        => PublicResponseCompressionPolicy.IsRequestEligible(context, _options.CurrentValue)
            ? _inner.GetCompressionProvider(context)
            : null;

    public bool ShouldCompressResponse(HttpContext context)
        => PublicResponseCompressionPolicy.IsRequestEligible(context, _options.CurrentValue)
            && PublicResponseCompressionPolicy.IsResponseEligible(context.Response)
            && _inner.ShouldCompressResponse(context);

    public bool CheckRequestAcceptsCompression(HttpContext context)
        => PublicResponseCompressionPolicy.IsRequestEligible(context, _options.CurrentValue)
            && _inner.CheckRequestAcceptsCompression(context);
}

internal static class PublicResponseCompressionPolicy
{
    public static readonly string[] AllowedMimeTypes =
    [
        "application/atom+xml",
        "application/feed+json",
        "application/json",
        "application/rss+xml",
        "application/xml",
        "text/plain"
    ];

    private static readonly string[] SensitiveRequestHeaders =
    [
        "Authorization",
        "Cookie",
        "X-CSRF-TOKEN",
        "X-Fsus-Csrf-Token",
        "X-XSRF-TOKEN"
    ];

    private static readonly string[] SensitiveVaryHeaders =
    [
        "*",
        "Authorization",
        "Cookie",
        "X-CSRF-TOKEN",
        "X-Fsus-Csrf-Token",
        "X-XSRF-TOKEN"
    ];

    private static readonly PathString[] SensitivePathPrefixes =
    [
        new("/account"),
        new("/admin"),
        new("/api/auth"),
        new("/api/binary"),
        new("/api/notifications"),
        new("/auth"),
        new("/internal"),
        new("/manage"),
        new("/settings"),
        new("/user")
    ];

    public static bool IsRequestEligible(
        HttpContext context,
        PublicResponseCompressionPolicyOptions options)
    {
        if (!options.Enabled
            || !context.Request.IsHttps
            || (!HttpMethods.IsGet(context.Request.Method) && !HttpMethods.IsHead(context.Request.Method))
            || context.WebSockets.IsWebSocketRequest
            || context.User.Identity?.IsAuthenticated == true)
        {
            return false;
        }

        Endpoint? endpoint = context.GetEndpoint();
        if (endpoint is null
            || endpoint.Metadata.GetMetadata<PublicResponseCompressionMetadata>() is null
            || endpoint.Metadata.GetMetadata<IAllowAnonymous>() is null
            || endpoint.Metadata.GetOrderedMetadata<IAuthorizeData>().Count != 0
            || endpoint.Metadata.GetMetadata<IAntiforgeryMetadata>()?.RequiresValidation == true)
        {
            return false;
        }

        string? routeKind = endpoint.Metadata.GetMetadata<FsusRouteKindMetadata>()?.RouteKind;
        if (string.Equals(routeKind, "binary", StringComparison.OrdinalIgnoreCase)
            || string.Equals(routeKind, "notification-stream", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        foreach (string header in SensitiveRequestHeaders)
        {
            if (!StringValues.IsNullOrEmpty(context.Request.Headers[header]))
            {
                return false;
            }
        }

        foreach (PathString prefix in SensitivePathPrefixes)
        {
            if (context.Request.Path.StartsWithSegments(prefix, StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }
        }

        return true;
    }

    public static bool IsResponseEligible(HttpResponse response)
    {
        if (response.StatusCode != StatusCodes.Status200OK
            || !StringValues.IsNullOrEmpty(response.Headers.SetCookie)
            || !StringValues.IsNullOrEmpty(response.Headers.ContentDisposition)
            || !StringValues.IsNullOrEmpty(response.Headers.ContentEncoding)
            || !HasPublicCacheDirective(response.Headers.CacheControl)
            || HasUnsafeVary(response.Headers.Vary))
        {
            return false;
        }

        string mediaType = response.ContentType?.Split(';', 2, StringSplitOptions.TrimEntries)[0]
            ?? string.Empty;
        return AllowedMimeTypes.Contains(mediaType, StringComparer.OrdinalIgnoreCase);
    }

    private static bool HasPublicCacheDirective(StringValues cacheControl)
    {
        bool isPublic = false;
        foreach (string? value in cacheControl)
        {
            foreach (string directive in (value ?? string.Empty).Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                int separator = directive.IndexOf('=');
                ReadOnlySpan<char> directiveName = separator < 0
                    ? directive.AsSpan()
                    : directive.AsSpan(0, separator).Trim();
                if (directiveName.Equals("private", StringComparison.OrdinalIgnoreCase)
                    || directiveName.Equals("no-store", StringComparison.OrdinalIgnoreCase)
                    || directiveName.Equals("no-cache", StringComparison.OrdinalIgnoreCase))
                {
                    return false;
                }

                isPublic |= directiveName.Equals("public", StringComparison.OrdinalIgnoreCase);
            }
        }

        return isPublic;
    }

    private static bool HasUnsafeVary(StringValues vary)
    {
        foreach (string? value in vary)
        {
            foreach (string token in (value ?? string.Empty).Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                if (SensitiveVaryHeaders.Contains(token, StringComparer.OrdinalIgnoreCase))
                {
                    return true;
                }
            }
        }

        return false;
    }
}
