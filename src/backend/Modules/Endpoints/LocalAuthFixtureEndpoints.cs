// fixture-catalog: producer auth-session
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Services.Security;

using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.Configuration;

namespace FsusBlog.Server.Modules.Endpoints;

public static class LocalAuthFixtureEndpoints
{
    internal const string AllowLocalAuthFixtureConfigurationKey = "fsus:allowLocalAuthFixture";
    internal const string LocalAuthFixtureSecretConfigurationKey = "fsus:localAuthFixtureSecret";
    private const string LocalAuthFixtureSecretHeaderName = "X-Fsus-Local-Auth-Fixture-Secret";
    private const string AdminSensitiveAction = "admin-sensitive";
    private const int MaxRedirectPathChars = 2048;
    private const long MaxStorageStateBytes = 256 * 1024;
    private const string UserStorageStateFileName = "user.storage-state.json";
    private const string AdminStorageStateFileName = "admin.storage-state.json";

    public static void MapLocalAuthFixtureEndpoints(this WebApplication app)
    {
        if (!app.Environment.IsDevelopment()
            || !app.Configuration.GetValue<bool>(AllowLocalAuthFixtureConfigurationKey))
        {
            return;
        }

        var handler = async Task<IResult> (
            HttpContext context,
            IWebHostEnvironment environment,
            [FromServices] AuthCookieService authCookieService,
            string? redirect,
            CancellationToken cancellationToken) =>
        {
            ILocalAuthFixtureRefreshRunner refreshRunner = context.RequestServices
                .GetService<ILocalAuthFixtureRefreshRunner>()
                ?? LocalAuthFixtureRefreshRunner.Instance;
            LocalAuthFixtureRefreshResult refreshResult = await refreshRunner
                .RefreshAsync(context, environment, cancellationToken);
            if (!refreshResult.Success)
            {
                return Results.Problem(refreshResult.Message, statusCode: StatusCodes.Status500InternalServerError);
            }

            string userStorageStatePath = refreshResult.UserStorageStatePath;
            string adminStorageStatePath = refreshResult.AdminStorageStatePath;
            if (!File.Exists(userStorageStatePath) || !File.Exists(adminStorageStatePath))
            {
                return Results.NotFound("local auth fixture is not prepared");
            }

            if (!TryReadAccessTokenCookie(userStorageStatePath, "AccessToken", out string userAccessToken, out DateTimeOffset userAccessTokenExpiresAtUtc) ||
                !TryReadCookie(userStorageStatePath, "RefreshToken", out string refreshToken) ||
                !TryReadCookie(userStorageStatePath, "SessionId", out string userSessionId) ||
                !TryReadAccessTokenCookie(adminStorageStatePath, "AdminAccessToken", out string adminAccessToken, out DateTimeOffset adminAccessTokenExpiresAtUtc) ||
                !TryReadCookie(adminStorageStatePath, "AdminSessionId", out string adminSessionId))
            {
                return Results.Problem("local auth fixture is invalid", statusCode: StatusCodes.Status500InternalServerError);
            }

            ResolvedTemporalRoleContext temporalRoles = ResolvedTemporalRoleContext.FromEnvironment();
            authCookieService.SetTokenCookies(
                context,
                environment,
                userAccessToken,
                userAccessTokenExpiresAtUtc,
                refreshToken,
                userSessionId,
                temporalRoles.RequireInstant("session.absolute-expiry").UtcDateTime);

            authCookieService.SetAdminSessionCookies(
                context,
                environment,
                adminAccessToken,
                adminAccessTokenExpiresAtUtc,
                adminSessionId,
                temporalRoles.RequireInstant("session.admin-persistent-idle-expiry").UtcDateTime);

            return Results.Redirect(SanitizeRedirectPath(redirect));
        };

        app.MapGet("/__local/auth-fixture/admin", handler).AllowAnonymous().AddEndpointFilter(RequireLocalFixtureSecret).AddEndpointFilter(RequireLoopbackCaller);
        app.MapGet("/api/local/auth-fixture/admin", handler).AllowAnonymous().AddEndpointFilter(RequireLocalFixtureSecret).AddEndpointFilter(RequireLoopbackCaller);

        var statusHandler = (HttpContext context) => Results.Json(new
        {
            hasAccessToken = HasCookie(context, "AccessToken"),
            hasSessionId = HasCookie(context, "SessionId"),
            hasAdminAccessToken = HasCookie(context, "AdminAccessToken"),
            hasAdminSessionId = HasCookie(context, "AdminSessionId"),
            hasHostAccessToken = HasCookie(context, "__Host-AccessToken"),
            hasHostAdminAccessToken = HasCookie(context, "__Host-AdminAccessToken")
        });
        app.MapGet("/api/local/auth-fixture/status", statusHandler).AllowAnonymous().AddEndpointFilter(RequireLocalFixtureSecret).AddEndpointFilter(RequireLoopbackCaller);
        app.MapGet("/__local/auth-fixture/status", statusHandler).AllowAnonymous().AddEndpointFilter(RequireLocalFixtureSecret).AddEndpointFilter(RequireLoopbackCaller);

        var adminSensitiveProofHandler = async Task<IResult> (
            HttpContext context,
            [FromServices] IAdminPrincipalService adminPrincipals,
            CancellationToken cancellationToken) =>
        {
            if (!context.User.TryGetAdminPrincipalId(out long adminPrincipalId) ||
                string.IsNullOrWhiteSpace(context.User.GetAdminSessionId()) ||
                !context.User.HasAdminPermission(AdminPermissions.SystemConfig))
            {
                return Results.Forbid();
            }

            ResolvedTemporalRoleContext temporalRoles = ResolvedTemporalRoleContext.FromEnvironment();
            string proofToken = await adminPrincipals.CreateAdminStepUpProofTokenAsync(
                adminPrincipalId,
                context.User.GetAdminSessionId()!,
                AdminSensitiveAction,
                temporalRoles.RequireDuration("session.authenticated", "mfa.challenge-expiry"),
                cancellationToken);

            return Results.Json(new
            {
                proofToken,
                action = AdminSensitiveAction
            });
        };
        app.MapPost("/api/local/auth-fixture/admin-sensitive-proof", adminSensitiveProofHandler).AllowAnonymous().AddEndpointFilter(RequireLocalFixtureSecret).AddEndpointFilter(RequireLoopbackCaller);
        app.MapPost("/__local/auth-fixture/admin-sensitive-proof", adminSensitiveProofHandler).AllowAnonymous().AddEndpointFilter(RequireLocalFixtureSecret).AddEndpointFilter(RequireLoopbackCaller);
    }

    private static async ValueTask<object?> RequireLocalFixtureSecret(
        EndpointFilterInvocationContext context,
        EndpointFilterDelegate next)
    {
        IConfiguration configuration = context.HttpContext.RequestServices.GetRequiredService<IConfiguration>();
        string expectedSecret = configuration[LocalAuthFixtureSecretConfigurationKey] ?? string.Empty;
        string providedSecret = context.HttpContext.Request.Headers[LocalAuthFixtureSecretHeaderName].ToString();
        if (string.IsNullOrWhiteSpace(expectedSecret) ||
            string.IsNullOrWhiteSpace(providedSecret) ||
            !FixedTimeEquals(expectedSecret.Trim(), providedSecret.Trim()))
        {
            return Results.Unauthorized();
        }

        return await next(context);
    }

    private static async ValueTask<object?> RequireLoopbackCaller(
        EndpointFilterInvocationContext context,
        EndpointFilterDelegate next)
    {
        IPAddress? remoteAddress = context.HttpContext.Connection.RemoteIpAddress;
        if (remoteAddress is null || !IPAddress.IsLoopback(remoteAddress))
        {
            return Results.NotFound();
        }

        return await next(context);
    }

    private static bool FixedTimeEquals(string expected, string actual)
    {
        byte[] expectedBytes = Encoding.UTF8.GetBytes(expected);
        byte[] actualBytes = Encoding.UTF8.GetBytes(actual);
        return expectedBytes.Length == actualBytes.Length &&
            CryptographicOperations.FixedTimeEquals(expectedBytes, actualBytes);
    }

    internal static string ResolveStorageStatePath(IWebHostEnvironment environment, string fileName)
    {
        string repoRoot = ResolveRepoRoot(environment);
        string? configuredRoot = Environment.GetEnvironmentVariable("FSUSBLOG_FIXTURE_ROOT");
        string fixtureRoot = string.IsNullOrWhiteSpace(configuredRoot)
            ? Path.Combine(repoRoot, ".tmp", "fixtures", ResolveFixtureNamespace())
            : Path.GetFullPath(configuredRoot, repoRoot);
        return Path.Combine(fixtureRoot, "auth", fileName);
    }

    internal static string ResolveFixtureNamespace()
    {
        string raw = Environment.GetEnvironmentVariable("FSUSBLOG_TEST_NAMESPACE") ?? "local";
        var normalized = new StringBuilder(raw.Length);
        bool previousWasInvalid = false;
        foreach (char value in raw.Trim().ToLowerInvariant())
        {
            if (char.IsAsciiLetterOrDigit(value) || value is '_' or '.' or '-')
            {
                normalized.Append(value);
                previousWasInvalid = false;
            }
            else if (!previousWasInvalid)
            {
                normalized.Append('-');
                previousWasInvalid = true;
            }
        }

        string result = normalized.ToString().Trim('-');
        return string.IsNullOrWhiteSpace(result) || result is "." or ".." ? "local" : result;
    }

    internal static bool ValidateLocalAuthFixtureScriptPath(string repoRoot, string scriptPath)
    {
        string expectedDirectory = Path.GetFullPath(Path.Combine(repoRoot, "tests", "frontend", "fixtures"));
        return string.Equals(Path.GetFileName(scriptPath), "prepare-auth-smoke-users.mjs", StringComparison.Ordinal) &&
            IsPathWithinDirectory(expectedDirectory, scriptPath);
    }

    internal static bool IsPathWithinDirectory(string directory, string candidatePath)
    {
        string root = Path.GetFullPath(directory);
        string candidate = Path.GetFullPath(candidatePath);
        string relative = Path.GetRelativePath(root, candidate);
        return relative.Length == 0 ||
            (!relative.StartsWith("..", StringComparison.Ordinal) &&
             !Path.IsPathRooted(relative));
    }

    internal static string ResolveRepoRoot(IWebHostEnvironment environment)
    {
        string[] candidates =
        {
            environment.ContentRootPath,
            Directory.GetCurrentDirectory(),
            Path.GetFullPath(Path.Combine(environment.ContentRootPath, "..")),
            Path.GetFullPath(Path.Combine(environment.ContentRootPath, "..", ".."))
        };
        foreach (string root in candidates)
        {
            if (File.Exists(Path.Combine(root, "tests", "frontend", "fixtures", "prepare-auth-smoke-users.mjs")))
            {
                return root;
            }
        }

        return environment.ContentRootPath;
    }

    internal static string ResolveBackendBaseUrl(HttpContext context)
    {
        int port = context.Connection.LocalPort;
        if (port > 0)
        {
            return $"{context.Request.Scheme}://127.0.0.1:{port}";
        }

        return $"{context.Request.Scheme}://{context.Request.Host}";
    }

    private static bool TryReadCookie(string storageStatePath, string cookieName, out string value)
        => TryReadCookie(storageStatePath, cookieName, out value, out _);

    private static bool TryReadAccessTokenCookie(
        string storageStatePath,
        string cookieName,
        out string value,
        out DateTimeOffset expiresAtUtc)
    {
        expiresAtUtc = default;
        if (!TryReadCookie(storageStatePath, cookieName, out value, out long? expiresAtUnixSeconds) ||
            expiresAtUnixSeconds is not > 0)
        {
            return false;
        }

        expiresAtUtc = DateTimeOffset.FromUnixTimeSeconds(expiresAtUnixSeconds.Value);
        return true;
    }

    private static bool TryReadCookie(
        string storageStatePath,
        string cookieName,
        out string value,
        out long? expiresAtUnixSeconds)
    {
        value = string.Empty;
        expiresAtUnixSeconds = null;
        using FileStream stream = File.OpenRead(storageStatePath);
        if (stream.Length > MaxStorageStateBytes)
        {
            return false;
        }

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
                if (cookie.TryGetProperty("expires", out JsonElement expires) &&
                    expires.ValueKind == JsonValueKind.Number &&
                    expires.TryGetInt64(out long parsedExpiresAtUnixSeconds))
                {
                    expiresAtUnixSeconds = parsedExpiresAtUnixSeconds;
                }
                return true;
            }
        }

        return false;
    }

    private static bool HasCookie(HttpContext context, string cookieName)
        => context.Request.Cookies.TryGetValue(cookieName, out string? value) &&
           !string.IsNullOrWhiteSpace(value);

    private static string SanitizeRedirectPath(string? redirect)
    {
        if (string.IsNullOrWhiteSpace(redirect) ||
            redirect.Length > MaxRedirectPathChars ||
            !redirect.StartsWith("/", StringComparison.Ordinal) ||
            redirect.StartsWith("//", StringComparison.Ordinal))
        {
            redirect = "/user/manage";
        }

        int fragmentIndex = redirect.IndexOf('#', StringComparison.Ordinal);
        string fragment = fragmentIndex >= 0 ? redirect[fragmentIndex..] : string.Empty;
        string withoutFragment = fragmentIndex >= 0 ? redirect[..fragmentIndex] : redirect;
        int queryIndex = withoutFragment.IndexOf('?', StringComparison.Ordinal);
        if (queryIndex < 0)
        {
            return withoutFragment + fragment;
        }

        string path = withoutFragment[..queryIndex];
        string query = withoutFragment[(queryIndex + 1)..];
        var allowed = QueryHelpers.ParseQuery(query)
            .Where(static pair => pair.Key is not ("fsusLocalFixtureLogin" or "fsusLocalFixtureAdmin"))
            .SelectMany(static pair => pair.Value.Select(value =>
                new KeyValuePair<string, string?>(pair.Key, value)));
        return path + QueryString.Create(allowed) + fragment;
    }
}
