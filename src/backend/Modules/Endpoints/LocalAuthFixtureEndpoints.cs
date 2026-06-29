using System.Diagnostics;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using FsusBlog.Server.Infrastructure.Auth;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;

namespace FsusBlog.Server.Modules.Endpoints;

public static class LocalAuthFixtureEndpoints
{
    internal const string AllowLocalAuthFixtureConfigurationKey = "fsus:allowLocalAuthFixture";
    internal const string LocalAuthFixtureSecretConfigurationKey = "fsus:localAuthFixtureSecret";
    private const string LocalAuthFixtureSecretHeaderName = "X-Fsus-Local-Auth-Fixture-Secret";
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
            var refreshResult = await RefreshPersistedAuthFixturesAsync(context, environment, cancellationToken);
            if (!refreshResult.Success)
            {
                return Results.Problem(refreshResult.Message, statusCode: StatusCodes.Status500InternalServerError);
            }

            string userStorageStatePath = ResolveStorageStatePath(environment, UserStorageStateFileName);
            string adminStorageStatePath = ResolveStorageStatePath(environment, AdminStorageStateFileName);
            if (!File.Exists(userStorageStatePath) || !File.Exists(adminStorageStatePath))
            {
                return Results.NotFound("local auth fixture is not prepared");
            }

            if (!TryReadCookie(userStorageStatePath, "AccessToken", out string userAccessToken) ||
                !TryReadCookie(userStorageStatePath, "RefreshToken", out string refreshToken) ||
                !TryReadCookie(userStorageStatePath, "SessionId", out string userSessionId) ||
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
                userSessionId,
                DateTime.UtcNow.AddDays(30));

            authCookieService.SetAdminSessionCookies(
                context,
                environment,
                adminAccessToken,
                adminSessionId,
                DateTime.UtcNow.AddHours(24));

            return Results.Redirect(SanitizeRedirectPath(redirect, forceLocalFixtureRefresh: true));
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

    private static string ResolveStorageStatePath(IWebHostEnvironment environment, string fileName)
    {
        return Path.Combine(ResolveRepoRoot(environment), "src", "frontend", ".playwright-fixtures", fileName);
    }

    private static async Task<(bool Success, string Message)> RefreshPersistedAuthFixturesAsync(
        HttpContext context,
        IWebHostEnvironment environment,
        CancellationToken cancellationToken)
    {
        string repoRoot = ResolveRepoRoot(environment);
        string scriptPath = Path.GetFullPath(Path.Combine(repoRoot, "tests", "frontend", "fixtures", "prepare-auth-smoke-users.mjs"));
        if (!ValidateLocalAuthFixtureScriptPath(repoRoot, scriptPath))
        {
            return (false, "local auth fixture script path is invalid");
        }

        if (!File.Exists(scriptPath))
        {
            return (false, "local auth fixture script is missing");
        }

        var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = "node",
                WorkingDirectory = repoRoot,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            },
            EnableRaisingEvents = true
        };
        process.StartInfo.ArgumentList.Add(scriptPath);
        process.StartInfo.Environment["FSUSBLOG_BASE_URL"] = ResolveBackendBaseUrl(context);
        process.StartInfo.Environment["PLAYWRIGHT_BASE_URL"] = Environment.GetEnvironmentVariable("PLAYWRIGHT_BASE_URL") ?? "http://localhost:3000";
        process.StartInfo.Environment["FSUSBLOG_PG_CONTAINER"] = Environment.GetEnvironmentVariable("FSUSBLOG_PG_CONTAINER") ?? "fsusblog-dev-postgres";
        process.StartInfo.Environment["FSUSBLOG_REDIS_CONTAINER"] = Environment.GetEnvironmentVariable("FSUSBLOG_REDIS_CONTAINER") ?? "fsusblog-dev-redis";
        if (!string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("Jwt__AccessTokenExpiresMinutes")))
        {
            process.StartInfo.Environment["FSUSBLOG_JWT_ACCESS_TOKEN_EXPIRES_MINUTES"] = Environment.GetEnvironmentVariable("Jwt__AccessTokenExpiresMinutes");
        }

        var stdout = new StringBuilder();
        var stderr = new StringBuilder();
        process.OutputDataReceived += (_, args) =>
        {
            if (!string.IsNullOrWhiteSpace(args.Data))
            {
                stdout.AppendLine(args.Data);
            }
        };
        process.ErrorDataReceived += (_, args) =>
        {
            if (!string.IsNullOrWhiteSpace(args.Data))
            {
                stderr.AppendLine(args.Data);
            }
        };

        try
        {
            if (!process.Start())
            {
                return (false, "local auth fixture refresh did not start");
            }

            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            await process.WaitForExitAsync(cancellationToken);
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            return (false, "local auth fixture refresh failed");
        }

        if (process.ExitCode != 0)
        {
            return (false, "local auth fixture refresh failed");
        }

        return (true, string.Empty);
    }

    private static bool ValidateLocalAuthFixtureScriptPath(string repoRoot, string scriptPath)
    {
        string expectedDirectory = Path.GetFullPath(Path.Combine(repoRoot, "tests", "frontend", "fixtures"));
        return string.Equals(Path.GetFileName(scriptPath), "prepare-auth-smoke-users.mjs", StringComparison.Ordinal) &&
            IsPathWithinDirectory(expectedDirectory, scriptPath);
    }

    private static bool IsPathWithinDirectory(string directory, string candidatePath)
    {
        string root = Path.GetFullPath(directory);
        string candidate = Path.GetFullPath(candidatePath);
        string relative = Path.GetRelativePath(root, candidate);
        return relative.Length == 0 ||
            (!relative.StartsWith("..", StringComparison.Ordinal) &&
             !Path.IsPathRooted(relative));
    }

    private static string ResolveRepoRoot(IWebHostEnvironment environment)
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

    private static string ResolveBackendBaseUrl(HttpContext context)
    {
        int port = context.Connection.LocalPort;
        if (port > 0)
        {
            return $"{context.Request.Scheme}://127.0.0.1:{port}";
        }

        return $"{context.Request.Scheme}://{context.Request.Host}";
    }

    private static bool TryReadCookie(string storageStatePath, string cookieName, out string value)
    {
        value = string.Empty;
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
                return true;
            }
        }

        return false;
    }

    private static bool HasCookie(HttpContext context, string cookieName)
        => context.Request.Cookies.TryGetValue(cookieName, out string? value) &&
           !string.IsNullOrWhiteSpace(value);

    private static string SanitizeRedirectPath(string? redirect, bool forceLocalFixtureRefresh = false)
    {
        if (string.IsNullOrWhiteSpace(redirect) ||
            redirect.Length > MaxRedirectPathChars ||
            !redirect.StartsWith("/", StringComparison.Ordinal) ||
            redirect.StartsWith("//", StringComparison.Ordinal))
        {
            redirect = "/user/manage";
        }

        if (!forceLocalFixtureRefresh || !redirect.StartsWith("/user/manage", StringComparison.Ordinal))
        {
            return redirect;
        }

        if (redirect.Contains("?fsusLocalFixtureLogin=1", StringComparison.Ordinal) ||
            redirect.Contains("&fsusLocalFixtureLogin=1", StringComparison.Ordinal))
        {
            return redirect;
        }

        char separator = redirect.Contains('?', StringComparison.Ordinal) ? '&' : '?';
        return $"{redirect}{separator}fsusLocalFixtureLogin=1";
    }
}
