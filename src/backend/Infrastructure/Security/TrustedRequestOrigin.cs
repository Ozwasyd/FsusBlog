using Microsoft.Extensions.Primitives;

namespace FsusBlog.Server.Infrastructure.Security;

public static class TrustedRequestOrigin
{
    public static bool RequireTrustedOriginOrReferer(HttpContext context)
    {
        if (TryGetRequestOrigin(context.Request.Headers.Origin, out string origin) ||
            TryGetRequestOrigin(context.Request.Headers.Referer, out origin))
        {
            return ResolveAllowedOrigins(context).Contains(origin);
        }

        return false;
    }

    public static void UseFsusCsrfOriginGuard(this IApplicationBuilder app)
    {
        app.Use(async (context, next) =>
        {
            if (IsUnsafeMethod(context.Request.Method) &&
                HasBrowserCredential(context.Request) &&
                !RequireTrustedOriginOrReferer(context))
            {
                context.Response.StatusCode = StatusCodes.Status403Forbidden;
                context.Response.Headers.CacheControl = "no-store";
                return;
            }

            await next();
        });
    }

    private static bool IsUnsafeMethod(string method)
        => HttpMethods.IsPost(method) ||
            HttpMethods.IsPut(method) ||
            HttpMethods.IsDelete(method) ||
            HttpMethods.IsPatch(method);

    private static bool HasBrowserCredential(HttpRequest request)
        => request.Cookies.Count > 0 ||
            request.Headers.ContainsKey("Cookie");

    private static bool TryGetRequestOrigin(StringValues values, out string origin)
    {
        origin = string.Empty;
        string value = values.ToString().Trim();
        if (string.IsNullOrWhiteSpace(value))
        {
            return false;
        }

        if (!Uri.TryCreate(value, UriKind.Absolute, out Uri? uri) ||
            (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
        {
            return false;
        }

        origin = uri.GetLeftPart(UriPartial.Authority);
        return true;
    }

    private static HashSet<string> ResolveAllowedOrigins(HttpContext context)
    {
        var configuration = context.RequestServices.GetRequiredService<IConfiguration>();
        HashSet<string> origins = new(StringComparer.OrdinalIgnoreCase);
        AddOrigins(origins, configuration["CORS_ALLOWED_HOSTS"]);
        AddOrigins(origins, configuration["Fido2:Origins"]);
        AddOrigin(origins, configuration["Seo:BaseUrl"]);

        if (context.RequestServices.GetService<IWebHostEnvironment>()?.IsDevelopment() == true)
        {
            origins.Add("http://localhost:3000");
            origins.Add("http://127.0.0.1:3000");
            origins.Add("http://localhost:5173");
            origins.Add("http://127.0.0.1:5173");
        }

        return origins;
    }

    private static void AddOrigins(HashSet<string> origins, string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return;
        }

        foreach (string candidate in raw.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
        {
            AddOrigin(origins, candidate);
        }
    }

    private static void AddOrigin(HashSet<string> origins, string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw) ||
            !Uri.TryCreate(raw.Trim(), UriKind.Absolute, out Uri? uri) ||
            (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
        {
            return;
        }

        origins.Add(uri.GetLeftPart(UriPartial.Authority));
    }
}
