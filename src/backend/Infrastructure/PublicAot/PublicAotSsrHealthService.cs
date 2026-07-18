using System.Diagnostics;

using FsusBlog.Core.Common;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public sealed record PublicAotSsrNodeProbeResult(
    string Status,
    string NodeExecutable,
    bool Available,
    string? Version,
    string? Error);

public sealed record PublicAotSsrWorkerProbeResult(
    string Status,
    string Command,
    double? LatencyMs,
    string? Error);

public sealed record PublicAotSsrHealthReport(
    string Status,
    DateTimeOffset CheckedAtUtc,
    PublicAotSsrWorkerResourceStatus Resource,
    PublicAotSsrNodeProbeResult Node,
    PublicAotSsrWorkerProbeResult SampleWorkerProbe,
    PublicAotSsrRuntimeSnapshot Runtime);

public sealed class PublicAotSsrHealthService(
    IWebHostEnvironment env,
    IConfiguration configuration,
    PublicAotSsrRuntimeState runtimeState,
    PublicAotBackfillScheduler scheduler,
    IPublicAotEntryRenderer renderer,
    ILogger<PublicAotSsrHealthService> logger)
{
    public async Task<PublicAotSsrHealthReport> CheckAsync(CancellationToken cancellationToken = default)
    {
        DateTimeOffset checkedAt = DateTimeOffset.UtcNow;
        PublicAotSsrWorkerResourceStatus resource = runtimeState.GetOrCreateWorkerResourceSnapshot(
            () => PublicAotNodeSsrRenderer.CheckWorkerResource(env, configuration));
        PublicAotSsrNodeProbeResult node = await ProbeNodeAsync(cancellationToken).ConfigureAwait(false);
        PublicAotSsrWorkerProbeResult sampleWorkerProbe = await ProbeWorkerAsync(resource, cancellationToken).ConfigureAwait(false);
        PublicAotSsrRuntimeSnapshot runtime = runtimeState.CreateSnapshot(scheduler.InFlightCount, scheduler.QueueCapacity);
        bool failed = string.Equals(resource.Status, "failed", StringComparison.Ordinal)
            || string.Equals(node.Status, "failed", StringComparison.Ordinal)
            || string.Equals(sampleWorkerProbe.Status, "failed", StringComparison.Ordinal);
        bool degraded = runtime.Circuit.State != PublicAotSsrCircuitState.Closed || runtime.RouteQuarantines.Count > 0;
        string status = failed ? "failed" : degraded ? "degraded" : "ok";

        return new PublicAotSsrHealthReport(status, checkedAt, resource, node, sampleWorkerProbe, runtime);
    }

    private async Task<PublicAotSsrNodeProbeResult> ProbeNodeAsync(CancellationToken cancellationToken)
    {
        string nodeExecutable = configuration["PublicAot:SsrNodePath"]?.Trim() is { Length: > 0 } configuredNode
            ? configuredNode
            : "node";
        try
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = nodeExecutable,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            };
            startInfo.ArgumentList.Add("--version");
            using var process = new Process { StartInfo = startInfo };
            if (!process.Start())
            {
                return new PublicAotSsrNodeProbeResult("failed", nodeExecutable, false, null, "node_start_failed");
            }

            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeoutCts.CancelAfter(TimeSpan.FromSeconds(3));
            string version = (await process.StandardOutput.ReadToEndAsync(timeoutCts.Token).ConfigureAwait(false)).Trim();
            string stderr = (await process.StandardError.ReadToEndAsync(timeoutCts.Token).ConfigureAwait(false)).Trim();
            await process.WaitForExitAsync(timeoutCts.Token).ConfigureAwait(false);
            if (process.ExitCode != 0)
            {
                return new PublicAotSsrNodeProbeResult("failed", nodeExecutable, false, null, string.IsNullOrWhiteSpace(stderr) ? $"exit:{process.ExitCode}" : stderr);
            }

            return new PublicAotSsrNodeProbeResult("ok", nodeExecutable, true, version, null);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "public_aot_node_probe_failed");
            return new PublicAotSsrNodeProbeResult("failed", nodeExecutable, false, null, ex.GetType().Name);
        }
    }

    private async Task<PublicAotSsrWorkerProbeResult> ProbeWorkerAsync(
        PublicAotSsrWorkerResourceStatus resource,
        CancellationToken cancellationToken)
    {
        if (!string.Equals(resource.Status, "ok", StringComparison.Ordinal))
        {
            return new PublicAotSsrWorkerProbeResult("skipped", "validateBundle", null, resource.Error);
        }

        long startedAt = Stopwatch.GetTimestamp();
        try
        {
            Result result = await renderer.ValidateBundleAsync(CreateProbeBundle(), cancellationToken).ConfigureAwait(false);
            TimeSpan elapsed = Stopwatch.GetElapsedTime(startedAt);
            return result.IsSuccess
                ? new PublicAotSsrWorkerProbeResult("ok", "validateBundle", elapsed.TotalMilliseconds, null)
                : new PublicAotSsrWorkerProbeResult("failed", "validateBundle", elapsed.TotalMilliseconds, result.Error.Message);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            TimeSpan elapsed = Stopwatch.GetElapsedTime(startedAt);
            logger.LogWarning(ex, "public_aot_worker_probe_failed");
            return new PublicAotSsrWorkerProbeResult("failed", "validateBundle", elapsed.TotalMilliseconds, ex.GetType().Name);
        }
    }

    private static PublicAotShellBundleContract CreateProbeBundle()
        => new()
        {
            Entries =
            [
                new PublicAotShellEntryContract
                {
                    PageId = PublicPageId.Home,
                    RouteKey = "home",
                    Html = "<main data-public-aot-probe=\"home\"></main>",
                    RendererVersion = PublicAotConstants.RendererVersion
                }
            ],
            GeneratedAtUtc = DateTimeOffset.UtcNow
        };
}
