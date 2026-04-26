using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Services.Security;
using System.Net;
using System.Text.Json;

namespace FsusBlog.Server.Services.Background;

/// <summary>
/// 爬虫 IP 库自动更新服务
/// 修复日期: 2026-02-22 (追加 EnsureSuccessStatusCode 避免把 404/500 错误页面当 JSON 强行解析造成死机)
/// </summary>
public class CrawlerUpdateWorker(
    IServiceProvider _serviceProvider,
    IHttpClientFactory _httpClientFactory,
    ILogger<CrawlerUpdateWorker> _logger) : BackgroundService
{
    private const int MaxCidrsPerProvider = 8192;

    // Google 官方 IP 库地址
    private const string GoogleIpUrl = "https://developers.google.com/static/search/apis/ipranges/googlebot.json";
    // Bing 官方 IP 库地址
    private const string BingIpUrl = "https://www.bing.com/toolbox/bingbot.json";

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
        using var client = _httpClientFactory.CreateClient();
        client.Timeout = TimeSpan.FromSeconds(30);

        using var googleResponse = await client.GetAsync(GoogleIpUrl, token);
        googleResponse.EnsureSuccessStatusCode();
        var googleJson = await googleResponse.Content.ReadAsStringAsync(token);
        var googleCidrs = ParseGoogleJson(googleJson);

        using var bingResponse = await client.GetAsync(BingIpUrl, token);
        bingResponse.EnsureSuccessStatusCode();
        var bingJson = await bingResponse.Content.ReadAsStringAsync(token);
        var bingCidrs = ParseBingJson(bingJson);

        detector.UpdateCidrLists(googleCidrs, bingCidrs);
    }

    private static List<string> ParseGoogleJson(string json)
    {
        var list = new List<string>(512);
        using var doc = JsonDocument.Parse(json);
        if (!doc.RootElement.TryGetProperty("prefixes", out var prefixes) || prefixes.ValueKind != JsonValueKind.Array)
        {
            return list;
        }

        foreach (var item in prefixes.EnumerateArray())
        {
            if (TryReadCidr(item, "ipv4Prefix", out var v4)) list.Add(v4);
            else if (TryReadCidr(item, "ipv6Prefix", out var v6)) list.Add(v6);
            if (list.Count >= MaxCidrsPerProvider) break;
        }
        return list;
    }

    private static List<string> ParseBingJson(string json)
    {
        var list = new List<string>(512);
        using var doc = JsonDocument.Parse(json);
        if (!doc.RootElement.TryGetProperty("prefixes", out var prefixes) || prefixes.ValueKind != JsonValueKind.Array)
        {
            return list;
        }

        foreach (var item in prefixes.EnumerateArray())
        {
            if (TryReadCidr(item, "ipv4Prefix", out var v4)) list.Add(v4);
            else if (TryReadCidr(item, "ipv6Prefix", out var v6)) list.Add(v6);
            if (list.Count >= MaxCidrsPerProvider) break;
        }
        return list;
    }

    private static bool TryReadCidr(JsonElement item, string propertyName, out string cidr)
    {
        cidr = string.Empty;
        if (!item.TryGetProperty(propertyName, out var node))
        {
            return false;
        }

        var raw = node.GetString();
        if (string.IsNullOrWhiteSpace(raw))
        {
            return false;
        }

        if (!IPNetwork.TryParse(raw, out _))
        {
            return false;
        }

        cidr = raw;
        return true;
    }
}
