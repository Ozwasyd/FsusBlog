using System.Text.Json;
using FsusBlog.Server.Infrastructure.Auth;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;

namespace FsusBlog.Server.Modules.Endpoints;

public static class LocalAuthFixtureEndpoints
{
    private const string UserStorageStateFileName = "user.storage-state.json";
    private const string AdminStorageStateFileName = "admin.storage-state.json";

    public static void MapLocalAuthFixtureEndpoints(this WebApplication app)
    {
        if (!app.Environment.IsDevelopment())
        {
            return;
        }

        var handler = (
            HttpContext context,
            IWebHostEnvironment environment,
            AuthCookieService authCookieService,
            string? redirect) =>
        {
            string userStorageStatePath = ResolveStorageStatePath(environment, UserStorageStateFileName);
            string adminStorageStatePath = ResolveStorageStatePath(environment, AdminStorageStateFileName);
            if (!File.Exists(userStorageStatePath) || !File.Exists(adminStorageStatePath))
            {
                return Results.NotFound("local auth fixture is not prepared");
            }

            if (!TryReadCookie(userStorageStatePath, "AccessToken", out string userAccessToken) ||
                !TryReadCookie(userStorageStatePath, "RefreshToken", out string refreshToken) ||
                !TryReadCookie(adminStorageStatePath, "AdminAccessToken", out string adminAccessToken) ||
                !TryReadCookie(adminStorageStatePath, "AdminSessionId", out string adminSessionId))
            {
                return Results.Problem("local auth fixture is invalid", statusCode: StatusCodes.Status500InternalServerError);
            }

            authCookieService.SetTokenCookies(
                context,
                environment,
                userAccessToken,
                refreshToken,
                DateTime.UtcNow.AddDays(30));

            authCookieService.SetAdminSessionCookies(
                context,
                environment,
                adminAccessToken,
                adminSessionId,
                DateTime.UtcNow.AddHours(24));

            return Results.Redirect(SanitizeRedirectPath(redirect, forceLocalFixtureRefresh: true));
        };

        app.MapGet("/__local/auth-fixture/admin", handler).AllowAnonymous();
        app.MapGet("/api/local/auth-fixture/admin", handler).AllowAnonymous();

        var statusHandler = (HttpContext context) => Results.Json(new
        {
            hasAccessToken = context.Request.Cookies.ContainsKey("AccessToken"),
            hasSessionId = context.Request.Cookies.ContainsKey("SessionId"),
            hasAdminAccessToken = context.Request.Cookies.ContainsKey("AdminAccessToken"),
            hasAdminSessionId = context.Request.Cookies.ContainsKey("AdminSessionId"),
            hasHostAdminAccessToken = context.Request.Cookies.ContainsKey("__Host-AdminAccessToken")
        });
        app.MapGet("/api/local/auth-fixture/status", statusHandler).AllowAnonymous();
        app.MapGet("/__local/auth-fixture/status", statusHandler).AllowAnonymous();
    }

    private static string ResolveStorageStatePath(IWebHostEnvironment environment, string fileName)
    {
        string root = environment.ContentRootPath;
        for (int depth = 0; depth < 6; depth += 1)
        {
            string candidate = Path.Combine(root, "src", "frontend", ".playwright-fixtures", fileName);
            if (File.Exists(candidate))
            {
                return candidate;
            }

            DirectoryInfo? parent = Directory.GetParent(root);
            if (parent is null)
            {
                break;
            }

            root = parent.FullName;
        }

        return Path.Combine(environment.ContentRootPath, "..", "..", "src", "frontend", ".playwright-fixtures", fileName);
    }

    private static bool TryReadCookie(string storageStatePath, string cookieName, out string value)
    {
        value = string.Empty;
        using FileStream stream = File.OpenRead(storageStatePath);
        using JsonDocument document = JsonDocument.Parse(stream);
        if (!document.RootElement.TryGetProperty("cookies", out JsonElement cookies) ||
            cookies.ValueKind != JsonValueKind.Array)
        {
            return false;
        }

        foreach (JsonElement cookie in cookies.EnumerateArray())
        {
            if (cookie.TryGetProperty("name", out JsonElement name) &&
                string.Equals(name.GetString(), cookieName, StringComparison.Ordinal) &&
                cookie.TryGetProperty("value", out JsonElement cookieValue) &&
                !string.IsNullOrWhiteSpace(cookieValue.GetString()))
            {
                value = cookieValue.GetString()!;
                return true;
            }
        }

        return false;
    }

    private static string SanitizeRedirectPath(string? redirect, bool forceLocalFixtureRefresh = false)
    {
        if (string.IsNullOrWhiteSpace(redirect) ||
            !redirect.StartsWith("/", StringComparison.Ordinal) ||
            redirect.StartsWith("//", StringComparison.Ordinal))
        {
            redirect = "/user/manage";
        }

        if (!forceLocalFixtureRefresh || !redirect.StartsWith("/user/manage", StringComparison.Ordinal))
        {
            return redirect;
        }

        char separator = redirect.Contains('?', StringComparison.Ordinal) ? '&' : '?';
        return $"{redirect}{separator}fsusLocalFixtureLogin=1";
    }
}
