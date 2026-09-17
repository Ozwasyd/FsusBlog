// fixture-catalog: consumer legacy-auth-refresh-runtime auth-basic
using System.Diagnostics;

using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Hosting;

namespace FsusBlog.Server.Modules.Endpoints;

public sealed record LocalAuthFixtureRefreshResult(
    bool Success,
    string Message,
    string UserStorageStatePath,
    string AdminStorageStatePath)
{
    public static LocalAuthFixtureRefreshResult Failed(string message)
        => new(false, message, string.Empty, string.Empty);

    public static LocalAuthFixtureRefreshResult Ready(string userStorageStatePath, string adminStorageStatePath)
        => new(true, string.Empty, userStorageStatePath, adminStorageStatePath);
}

public interface ILocalAuthFixtureRefreshRunner
{
    Task<LocalAuthFixtureRefreshResult> RefreshAsync(
        HttpContext context,
        IWebHostEnvironment environment,
        CancellationToken cancellationToken);
}

internal sealed class LocalAuthFixtureRefreshRunner : ILocalAuthFixtureRefreshRunner
{
    private static readonly TimeSpan s_refreshTimeout = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan s_outputDrainTimeout = TimeSpan.FromSeconds(5);

    public static LocalAuthFixtureRefreshRunner Instance { get; } = new();

    private LocalAuthFixtureRefreshRunner()
    {
    }

    public async Task<LocalAuthFixtureRefreshResult> RefreshAsync(
        HttpContext context,
        IWebHostEnvironment environment,
        CancellationToken cancellationToken)
    {
        if (!environment.IsDevelopment() && !environment.IsEnvironment("Test"))
        {
            return LocalAuthFixtureRefreshResult.Failed("local auth fixture refresh is unavailable");
        }

        string repoRoot = LocalAuthFixtureEndpoints.ResolveRepoRoot(environment);
        string scriptPath = Path.GetFullPath(Path.Combine(
            repoRoot,
            "tests",
            "frontend",
            "fixtures",
            "prepare-auth-smoke-users.mjs"));
        if (!LocalAuthFixtureEndpoints.ValidateLocalAuthFixtureScriptPath(repoRoot, scriptPath))
        {
            return LocalAuthFixtureRefreshResult.Failed("local auth fixture script path is invalid");
        }

        if (!File.Exists(scriptPath))
        {
            return LocalAuthFixtureRefreshResult.Failed("local auth fixture script is missing");
        }

        using var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = "node",
                WorkingDirectory = repoRoot,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
        };
        process.StartInfo.ArgumentList.Add(scriptPath);
        process.StartInfo.Environment["FSUSBLOG_BASE_URL"] = LocalAuthFixtureEndpoints.ResolveBackendBaseUrl(context);
        process.StartInfo.Environment["PLAYWRIGHT_BASE_URL"] = Environment.GetEnvironmentVariable("PLAYWRIGHT_BASE_URL") ?? "http://localhost:3000";
        process.StartInfo.Environment["FSUSBLOG_PG_CONTAINER"] = Environment.GetEnvironmentVariable("FSUSBLOG_PG_CONTAINER") ?? "fsusblog-dev-postgres";
        process.StartInfo.Environment["FSUSBLOG_REDIS_CONTAINER"] = Environment.GetEnvironmentVariable("FSUSBLOG_REDIS_CONTAINER") ?? "fsusblog-dev-redis";
        try
        {
            if (!process.Start())
            {
                return LocalAuthFixtureRefreshResult.Failed("local auth fixture refresh did not start");
            }
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            return LocalAuthFixtureRefreshResult.Failed("local auth fixture refresh failed");
        }

        Task<string> stdout = process.StandardOutput.ReadToEndAsync();
        Task<string> stderr = process.StandardError.ReadToEndAsync();
        using var timeout = new CancellationTokenSource(s_refreshTimeout);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, timeout.Token);
        try
        {
            await process.WaitForExitAsync(linked.Token);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            TryKill(process);
            await DrainAsync(stdout, stderr);
            return LocalAuthFixtureRefreshResult.Failed("local auth fixture refresh timed out");
        }
        catch (OperationCanceledException)
        {
            TryKill(process);
            await DrainAsync(stdout, stderr);
            throw;
        }

        await DrainAsync(stdout, stderr);
        if (process.ExitCode != 0)
        {
            return LocalAuthFixtureRefreshResult.Failed("local auth fixture refresh failed");
        }

        return LocalAuthFixtureRefreshResult.Ready(
            LocalAuthFixtureEndpoints.ResolveStorageStatePath(environment, "user.storage-state.json"),
            LocalAuthFixtureEndpoints.ResolveStorageStatePath(environment, "admin.storage-state.json"));
    }

    private static async Task DrainAsync(Task<string> stdout, Task<string> stderr)
    {
        try
        {
            _ = await Task.WhenAll(stdout, stderr)
                .WaitAsync(s_outputDrainTimeout)
                .ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is TimeoutException or IOException or ObjectDisposedException)
        {
            // Process output is diagnostic-only. Never expose it or let a broken pipe defeat
            // the fixed timeout/failure contract of the development-only fixture endpoint.
        }
    }

    private static void TryKill(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception or NotSupportedException)
        {
            // The public fixture endpoint still returns a fixed failure without exposing process details.
        }
    }
}
