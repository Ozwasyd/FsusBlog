using FsusBlog.Server.Services.Security;
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
    // Google 官方 IP 库地址
    private const string GoogleIpUrl = "https://developers.google.com/static/search/apis/ipranges/googlebot.json";
    // Bing 官方 IP 库地址
    private const string BingIpUrl = "https://www.bing.com/toolbox/bingbot.json";

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                _logger.LogInformation("开始同步搜索引擎 IP 白名单...");

                using var scope = _serviceProvider.CreateScope();
                var detector = scope.ServiceProvider.GetRequiredService<CrawlerDetectorService>();
                using var client = _httpClientFactory.CreateClient();

                // 强制应用超时控制
                client.Timeout = TimeSpan.FromSeconds(30);

                // 1. 获取 Google IP
                using var googleResponse = await client.GetAsync(GoogleIpUrl, stoppingToken);
                googleResponse.EnsureSuccessStatusCode();
                var googleJson = await googleResponse.Content.ReadAsStringAsync(stoppingToken);
                var googleCidrs = ParseGoogleJson(googleJson);

                // 2. 获取 Bing IP
                using var bingResponse = await client.GetAsync(BingIpUrl, stoppingToken);
                bingResponse.EnsureSuccessStatusCode();
                var bingJson = await bingResponse.Content.ReadAsStringAsync(stoppingToken);
                var bingCidrs = ParseBingJson(bingJson);

                // 3. 更新原子快照
                detector.UpdateCidrLists(googleCidrs, bingCidrs);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "同步搜索引擎 IP 库失败，将使用旧缓存或空列表。");
            }

            // 每天更新一次 (24小时)
            await Task.Delay(TimeSpan.FromHours(24), stoppingToken);
        }
    }

    private static List<string> ParseGoogleJson(string json)
    {
        var list = new List<string>();
        using var doc = JsonDocument.Parse(json);
        foreach (var item in doc.RootElement.GetProperty("prefixes").EnumerateArray())
        {
            if (item.TryGetProperty("ipv4Prefix", out var v4)) list.Add(v4.GetString()!);
            else if (item.TryGetProperty("ipv6Prefix", out var v6)) list.Add(v6.GetString()!);
        }
        return list;
    }

    private static List<string> ParseBingJson(string json)
    {
        var list = new List<string>();
        using var doc = JsonDocument.Parse(json);
        foreach (var item in doc.RootElement.GetProperty("prefixes").EnumerateArray())
        {
            if (item.TryGetProperty("ipv4Prefix", out var v4)) list.Add(v4.GetString()!);
            else if (item.TryGetProperty("ipv6Prefix", out var v6)) list.Add(v6.GetString()!);
        }
        return list;
    }
}