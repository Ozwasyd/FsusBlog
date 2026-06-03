using FsusBlog.Server.Infrastructure.Execution;
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
    ILogger<CrawlerUpdateWorker> _logger) : BackgroundService
{
    private const int MaxCidrsPerProvider = 8192;
    private static readonly Uri DefaultGoogleRangeUrl = new("https://developers.google.com/static/search/apis/ipranges/googlebot.json");
    private static readonly Uri DefaultBingRangeUrl = new("https://www.bing.com/toolbox/bingbot.json");

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromHours(24));
        await BackgroundTaskExecutor.RunLoopAsync(
            async token =>
            {
                await SynchronizeOnceAsync(token);
                return await timer.WaitForNextTickAsync(token);
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

    internal async Task SynchronizeOnceAsync(CancellationToken token)
    {
        _logger.LogInformation("开始同步搜索引擎 IP 白名单...");

        await using var scope = _serviceProvider.CreateAsyncScope();
        var detector = scope.ServiceProvider.GetRequiredService<CrawlerDetectorService>();
        token.ThrowIfCancellationRequested();

        DateTimeOffset syncStartedAt = DateTimeOffset.UtcNow;
        var errors = new List<string>(2);
        CrawlerRangeSnapshot? snapshot = LoadSnapshot();
        var configGoogle = ParseConfiguredCidrs(_configuration["Security:CrawlerCidrs:Google"]);
        var configBing = ParseConfiguredCidrs(_configuration["Security:CrawlerCidrs:Bing"]);

        var remoteGoogle = await FetchRemoteCidrsAsync(ResolveUri("Security:CrawlerCidrs:GoogleUrl", DefaultGoogleRangeUrl), "google", errors, token);
        var remoteBing = await FetchRemoteCidrsAsync(ResolveUri("Security:CrawlerCidrs:BingUrl", DefaultBingRangeUrl), "bing", errors, token);

        var googleSelection = SelectRanges(remoteGoogle, snapshot?.Google, configGoogle);
        var bingSelection = SelectRanges(remoteBing, snapshot?.Bing, configBing);
        string source = ResolveSource(googleSelection.Source, bingSelection.Source);
        var googleCidrs = googleSelection.Ranges;
        var bingCidrs = bingSelection.Ranges;
        bool hasRanges = googleCidrs.Count + bingCidrs.Count > 0;
        bool remoteSucceeded = googleSelection.Source == "remote" || bingSelection.Source == "remote";

        if (remoteSucceeded && hasRanges)
        {
            SaveSnapshot(new CrawlerRangeSnapshot(googleCidrs, bingCidrs, syncStartedAt));
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

    private Uri ResolveUri(string key, Uri fallback)
    {
        string? configured = _configuration[key];
        return Uri.TryCreate(configured, UriKind.Absolute, out Uri? uri)
            ? uri
            : fallback;
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

    private CrawlerRangeSnapshot? LoadSnapshot()
    {
        string path = ResolveSnapshotPath();
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

    private void SaveSnapshot(CrawlerRangeSnapshot snapshot)
    {
        string path = ResolveSnapshotPath();
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            var json = JsonSerializer.Serialize(snapshot);
            File.WriteAllText(path, json);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "写入 crawler CIDR last-known-good snapshot 失败: {Path}", path);
        }
    }

    private string ResolveSnapshotPath()
    {
        string? configured = _configuration["Security:CrawlerCidrs:SnapshotPath"];
        if (!string.IsNullOrWhiteSpace(configured))
        {
            return configured;
        }

        string dataRoot = _configuration["FSUSBLOG_DATA_ROOT"]
            ?? Environment.GetEnvironmentVariable("FSUSBLOG_DATA_ROOT")
            ?? Path.Combine(AppContext.BaseDirectory, "data");
        return Path.Combine(dataRoot, "security", "crawler-ranges.snapshot.json");
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
}
