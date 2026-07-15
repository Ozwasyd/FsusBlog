using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Security;
using FsusBlog.Server.Services.Security;
using System.Net;
using System.Text.Json;

namespace FsusBlog.Server.Services.Background;

/// <summary>
/// 爬虫 IP 库自动更新服务
/// </summary>
public class CrawlerUpdateWorker(
    IServiceProvider _serviceProvider,
    IConfiguration _configuration,
    IHttpClientFactory _httpClientFactory,
    IAntiCrawlerPolicyProvider _policyProvider,
    ILogger<CrawlerUpdateWorker> _logger,
    IBackgroundWorkerLease workerLease,
    TimeProvider timeProvider,
    IActiveReleaseCommitGuard? activeReleaseCommitGuard = null) : BackgroundService, ICrawlerRangeSyncService
{
    private const int MaxCidrsPerProvider = 8192;
    private static readonly Uri DefaultGoogleRangeUrl = new("https://developers.google.com/static/search/apis/ipranges/googlebot.json");
    private static readonly Uri DefaultBingRangeUrl = new("https://www.bing.com/toolbox/bingbot.json");
    private CrawlerUpdateRuntimeState _runtimeState = CrawlerUpdateRuntimeState.Initial;
    private readonly string? _configuredGoogleCidrs = _configuration["Security:CrawlerCidrs:Google"];
    private readonly string? _configuredBingCidrs = _configuration["Security:CrawlerCidrs:Bing"];
    private readonly string? _configuredSnapshotPath = _configuration["Security:CrawlerCidrs:SnapshotPath"];
    private readonly string _dataRoot = _configuration["FSUSBLOG_DATA_ROOT"]
        ?? Environment.GetEnvironmentVariable("FSUSBLOG_DATA_ROOT")
        ?? Path.Combine(AppContext.BaseDirectory, "data");
    private int _running;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        TimeSpan initialDelay = TimeSpan.FromSeconds(_policyProvider.Current.Options.CidrInitialDelaySeconds);
        await BackgroundTaskExecutor.RunLoopAsync(
            async token =>
            {
                if (initialDelay > TimeSpan.Zero)
                {
                    await Task.Delay(initialDelay, timeProvider, token);
                    initialDelay = TimeSpan.Zero;
                }

                AntiCrawlerPolicyOptions options = _policyProvider.Current.Options;
                if (options.CidrAutoUpdateEnabled)
                {
                    await workerLease.TryRunAsLeaderAsync(
                        "crawler-update-worker",
                        syncToken => SynchronizeOnceAsync(syncToken, enforceCommitGuard: true),
                        token);
                }

                await WaitForNextPolicyTickAsync(token);
                return true;
            },
            _logger,
            "crawler-update-worker",
            stoppingToken,
            onFaulted: ex =>
            {
                _logger.LogError(ex, "同步搜索引擎 IP 库失败，将使用旧缓存或空列表。");
                return Task.CompletedTask;
            });
    }

    public CrawlerRangesAdminStatus GetStatus()
    {
        using var scope = _serviceProvider.CreateScope();
        var detector = scope.ServiceProvider.GetRequiredService<CrawlerDetectorService>();
        CrawlerRangeStatus status = detector.GetRangeStatus();
        AntiCrawlerPolicyOptions options = _policyProvider.Current.Options;
        CrawlerUpdateRuntimeState runtimeState = Volatile.Read(ref _runtimeState);
        return new CrawlerRangesAdminStatus(
            options.CidrAutoUpdateEnabled,
            options.CidrUpdateIntervalMinutes,
            options.CidrMinUpdateIntervalMinutes,
            options.CidrInitialDelaySeconds,
            runtimeState.NextSyncAt,
            runtimeState.LastStartedAt,
            runtimeState.LastFinishedAt,
            runtimeState.LastOutcome,
            runtimeState.Running,
            status.GoogleRanges,
            status.BingRanges,
            status.LastSyncAt,
            status.LastSuccessAt,
            status.Source,
            status.LastError,
            options.GoogleCrawlerRangesUrl,
            options.BingCrawlerRangesUrl,
            options.SnapshotPath);
    }

    public Task<CrawlerRangeSyncResponse> SynchronizeOnceAsync(CancellationToken token = default)
        => SynchronizeOnceAsync(token, enforceCommitGuard: false);

    private async Task<CrawlerRangeSyncResponse> SynchronizeOnceAsync(
        CancellationToken token,
        bool enforceCommitGuard)
    {
        if (Interlocked.Exchange(ref _running, 1) == 1)
        {
            return new CrawlerRangeSyncResponse(GetStatus(), "already_running", timeProvider.GetUtcNow());
        }

        DateTimeOffset startedAt = timeProvider.GetUtcNow();
        DateTimeOffset? finishedAt = null;
        string? finalOutcome = null;
        PublishRuntimeState(state => state with
        {
            LastStartedAt = startedAt,
            LastOutcome = "running",
            Running = true
        });
        try
        {
            CrawlerRangeStatus status = await SynchronizeCoreAsync(token, enforceCommitGuard);
            finishedAt = timeProvider.GetUtcNow();
            finalOutcome = string.IsNullOrWhiteSpace(status.LastError) ? "success" : "degraded";
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested)
        {
            finishedAt = timeProvider.GetUtcNow();
            finalOutcome = "canceled";
            throw;
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !token.IsCancellationRequested)
        {
            finishedAt = timeProvider.GetUtcNow();
            finalOutcome = ex.GetType().Name;
            throw;
        }
        finally
        {
            if (finishedAt is { } completedAt && finalOutcome is not null)
            {
                PublishRuntimeState(state => state with
                {
                    LastFinishedAt = completedAt,
                    LastOutcome = finalOutcome,
                    Running = false
                });
            }
            else
            {
                PublishRuntimeState(state => state with { Running = false });
            }

            Volatile.Write(ref _running, 0);
        }

        return new CrawlerRangeSyncResponse(GetStatus(), finalOutcome!, finishedAt!.Value);
    }

    private async Task<CrawlerRangeStatus> SynchronizeCoreAsync(
        CancellationToken token,
        bool enforceCommitGuard)
    {
        _logger.LogInformation("开始同步搜索引擎 IP 白名单...");

        await using ObservedAsyncServiceScope scope = DependencyInjectionScopeTelemetry.CreateAsyncScope(
            _serviceProvider,
            "crawler_range_snapshot");
        var detector = scope.ServiceProvider.GetRequiredService<CrawlerDetectorService>();
        token.ThrowIfCancellationRequested();

        DateTimeOffset syncStartedAt = timeProvider.GetUtcNow();
        var errors = new List<string>(2);
        AntiCrawlerPolicyOptions options = _policyProvider.Current.Options;
        CrawlerRangeSnapshot? snapshot = LoadSnapshot(options);
        var configGoogle = ParseConfiguredCidrs(_configuredGoogleCidrs);
        var configBing = ParseConfiguredCidrs(_configuredBingCidrs);

        var googleErrors = new List<string>(1);
        var bingErrors = new List<string>(1);
        Task<List<string>> remoteGoogleTask = FetchRemoteCidrsAsync(ResolveUri(options.GoogleCrawlerRangesUrl, DefaultGoogleRangeUrl), "google", googleErrors, token);
        Task<List<string>> remoteBingTask = FetchRemoteCidrsAsync(ResolveUri(options.BingCrawlerRangesUrl, DefaultBingRangeUrl), "bing", bingErrors, token);
        await Task.WhenAll(remoteGoogleTask, remoteBingTask);
        errors.AddRange(googleErrors);
        errors.AddRange(bingErrors);
        var remoteGoogle = await remoteGoogleTask;
        var remoteBing = await remoteBingTask;

        var googleSelection = SelectRanges(remoteGoogle, snapshot?.Google, configGoogle);
        var bingSelection = SelectRanges(remoteBing, snapshot?.Bing, configBing);
        string source = ResolveSource(googleSelection.Source, bingSelection.Source);
        var googleCidrs = googleSelection.Ranges;
        var bingCidrs = bingSelection.Ranges;
        bool hasRanges = googleCidrs.Count + bingCidrs.Count > 0;
        bool remoteSucceeded = googleSelection.Source == "remote" || bingSelection.Source == "remote";

        if (enforceCommitGuard)
        {
            IActiveReleaseCommitGuard commitGuard = activeReleaseCommitGuard
                ?? throw new InvalidOperationException("Active release commit guard is required for the crawler worker commit boundary.");
            await commitGuard.EnsureCurrentAsync(token).ConfigureAwait(false);
        }

        if (remoteSucceeded && hasRanges)
        {
            SaveSnapshot(new CrawlerRangeSnapshot(googleCidrs, bingCidrs, syncStartedAt), options);
        }

        string? lastError = errors.Count == 0
            ? null
            : string.Join("; ", errors).Trim();
        if (!hasRanges)
        {
            lastError = string.IsNullOrWhiteSpace(lastError)
                ? "crawler_cidrs_empty"
                : $"{lastError}; crawler_cidrs_empty";
        }

        var status = new CrawlerRangeStatus(
            googleCidrs.Count,
            bingCidrs.Count,
            syncStartedAt,
            hasRanges ? (remoteSucceeded ? syncStartedAt : snapshot?.SavedAt ?? syncStartedAt) : null,
            hasRanges ? source : "empty",
            TruncateError(lastError));

        detector.UpdateCidrLists(googleCidrs, bingCidrs, status);
        return status;
    }

    private async Task WaitForNextPolicyTickAsync(CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            AntiCrawlerPolicyOptions options = _policyProvider.Current.Options;
            if (!options.CidrAutoUpdateEnabled)
            {
                PublishRuntimeState(state => state with { NextSyncAt = null });
                await Task.Delay(TimeSpan.FromSeconds(30), timeProvider, token);
                continue;
            }

            TimeSpan interval = TimeSpan.FromMinutes(Math.Max(options.CidrUpdateIntervalMinutes, options.CidrMinUpdateIntervalMinutes));
            DateTimeOffset anchor = Volatile.Read(ref _runtimeState).LastFinishedAt ?? timeProvider.GetUtcNow();
            DateTimeOffset next = anchor.Add(interval);
            PublishRuntimeState(state => state with { NextSyncAt = next });
            TimeSpan remaining = next - timeProvider.GetUtcNow();
            if (remaining <= TimeSpan.Zero)
            {
                return;
            }

            await Task.Delay(
                remaining < TimeSpan.FromSeconds(30) ? remaining : TimeSpan.FromSeconds(30),
                timeProvider,
                token);
        }
    }

    private void PublishRuntimeState(Func<CrawlerUpdateRuntimeState, CrawlerUpdateRuntimeState> update)
    {
        while (true)
        {
            CrawlerUpdateRuntimeState current = Volatile.Read(ref _runtimeState);
            CrawlerUpdateRuntimeState next = update(current);
            if (ReferenceEquals(Interlocked.CompareExchange(ref _runtimeState, next, current), current))
            {
                return;
            }
        }
    }

    private static List<string> ParseConfiguredCidrs(string? value)
    {
        var list = new List<string>(512);
        if (string.IsNullOrWhiteSpace(value))
        {
            return list;
        }

        foreach (string segment in value.Split([',', ';', '\n', '\r', '\t', ' '], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (!IPNetwork.TryParse(segment, out _))
            {
                continue;
            }

            list.Add(segment);
            if (list.Count >= MaxCidrsPerProvider)
            {
                break;
            }
        }

        return list;
    }

    private static Uri ResolveUri(string? configured, Uri fallback)
    {
        return CrawlerRangeUrlPolicy.ResolveOrThrow(configured, fallback, "Security:CrawlerCidrs remote URL");
    }

    private async Task<List<string>> FetchRemoteCidrsAsync(Uri uri, string provider, List<string> errors, CancellationToken token)
    {
        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(token);
            cts.CancelAfter(TimeSpan.FromSeconds(5));
            var client = _httpClientFactory.CreateClient();
            string json = await client.GetStringAsync(uri, cts.Token);
            var ranges = ParseCrawlerRangeJson(json);
            if (ranges.Count == 0)
            {
                errors.Add($"{provider}:remote_empty");
            }

            return ranges;
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !token.IsCancellationRequested)
        {
            errors.Add($"{provider}:{ex.GetType().Name}");
            _logger.LogWarning(ex, "远程同步 {Provider} crawler CIDR 失败，将尝试 snapshot/config fallback。", provider);
            return [];
        }
    }

    private CrawlerRangeSnapshot? LoadSnapshot(AntiCrawlerPolicyOptions options)
    {
        string path = ResolveSnapshotPath(options);
        if (!File.Exists(path))
        {
            return null;
        }

        try
        {
            string json = File.ReadAllText(path);
            return JsonSerializer.Deserialize<CrawlerRangeSnapshot>(json);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "读取 crawler CIDR last-known-good snapshot 失败: {Path}", path);
            return null;
        }
    }

    private void SaveSnapshot(CrawlerRangeSnapshot snapshot, AntiCrawlerPolicyOptions options)
    {
        string path = ResolveSnapshotPath(options);
        try
        {
            var json = JsonSerializer.Serialize(snapshot);
            WriteSnapshotAtomically(path, json);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "写入 crawler CIDR last-known-good snapshot 失败: {Path}", path);
        }
    }

    internal static void WriteSnapshotAtomically(string path, string json)
    {
        string? directory = Path.GetDirectoryName(path);
        if (!string.IsNullOrWhiteSpace(directory))
        {
            Directory.CreateDirectory(directory);
        }

        string tempDirectory = string.IsNullOrWhiteSpace(directory) ? "." : directory;
        string tempPath = Path.Combine(tempDirectory, $"{Path.GetFileName(path)}.{Guid.NewGuid():N}.tmp");
        try
        {
            File.WriteAllText(tempPath, json);
            File.Move(tempPath, path, overwrite: true);
        }
        finally
        {
            if (File.Exists(tempPath))
            {
                File.Delete(tempPath);
            }
        }
    }

    private string ResolveSnapshotPath(AntiCrawlerPolicyOptions options)
    {
        string? configured = options.SnapshotPath ?? _configuredSnapshotPath;
        if (!string.IsNullOrWhiteSpace(configured))
        {
            string normalized = NormalizeSnapshotPath(configured);
            return Path.Combine(_dataRoot, "security", normalized);
        }

        return Path.Combine(_dataRoot, "security", "crawler-ranges.snapshot.json");
    }

    private static string NormalizeSnapshotPath(string value)
    {
        string normalized = value.Trim().Replace('\\', '/');
        if (normalized.Length == 0
            || normalized.Length > 160
            || Path.IsPathRooted(normalized)
            || normalized.Contains(':', StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Security:CrawlerCidrs:SnapshotPath must be a relative path under the crawler snapshot data root.");
        }

        string[] segments = normalized.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (segments.Length == 0
            || segments.Any(static segment => segment is "." or ".."))
        {
            throw new InvalidOperationException("Security:CrawlerCidrs:SnapshotPath must not contain empty, current, or parent directory segments.");
        }

        return string.Join(Path.DirectorySeparatorChar, segments);
    }

    private static RangeSelection SelectRanges(List<string> remote, IReadOnlyList<string>? snapshot, List<string> config)
    {
        if (remote.Count > 0)
        {
            return new RangeSelection(remote, "remote");
        }

        if (snapshot is { Count: > 0 })
        {
            return new RangeSelection([.. snapshot], "cache");
        }

        if (config.Count > 0)
        {
            return new RangeSelection(config, "config");
        }

        return new RangeSelection([], "empty");
    }

    private static string ResolveSource(string googleSource, string bingSource)
    {
        if (googleSource == "remote" && bingSource == "remote") return "remote";
        if (googleSource == "empty" && bingSource == "empty") return "empty";
        if (googleSource == bingSource) return googleSource;
        if (googleSource == "remote" || bingSource == "remote") return "remote";
        if (googleSource == "cache" || bingSource == "cache") return "cache";
        return "config";
    }

    private static List<string> ParseCrawlerRangeJson(string json)
    {
        var ranges = new List<string>(512);
        using JsonDocument doc = JsonDocument.Parse(json);
        if (!doc.RootElement.TryGetProperty("prefixes", out JsonElement prefixes) || prefixes.ValueKind != JsonValueKind.Array)
        {
            return ranges;
        }

        foreach (JsonElement prefix in prefixes.EnumerateArray())
        {
            AddPrefix(prefix, "ipv4Prefix", ranges);
            AddPrefix(prefix, "ipv6Prefix", ranges);
            if (ranges.Count >= MaxCidrsPerProvider)
            {
                break;
            }
        }

        return ranges;
    }

    private static void AddPrefix(JsonElement prefix, string propertyName, List<string> ranges)
    {
        if (ranges.Count >= MaxCidrsPerProvider
            || !prefix.TryGetProperty(propertyName, out JsonElement value)
            || value.ValueKind != JsonValueKind.String)
        {
            return;
        }

        string? cidr = value.GetString();
        if (!string.IsNullOrWhiteSpace(cidr) && IPNetwork.TryParse(cidr, out _))
        {
            ranges.Add(cidr);
        }
    }

    private static string? TruncateError(string? value)
        => string.IsNullOrWhiteSpace(value)
            ? null
            : value.Length <= 512 ? value : value[..512];

    private sealed record RangeSelection(List<string> Ranges, string Source);

    private sealed record CrawlerRangeSnapshot(List<string> Google, List<string> Bing, DateTimeOffset SavedAt);

    private sealed record CrawlerUpdateRuntimeState(
        DateTimeOffset? NextSyncAt,
        DateTimeOffset? LastStartedAt,
        DateTimeOffset? LastFinishedAt,
        string LastOutcome,
        bool Running)
    {
        public static readonly CrawlerUpdateRuntimeState Initial = new(null, null, null, "not_started", false);
    }
}
