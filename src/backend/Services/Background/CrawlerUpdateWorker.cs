using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Services.Security;
using System.Net;

namespace FsusBlog.Server.Services.Background;

/// <summary>
/// 爬虫 IP 库自动更新服务
/// </summary>
public class CrawlerUpdateWorker(
    IServiceProvider _serviceProvider,
    IConfiguration _configuration,
    ILogger<CrawlerUpdateWorker> _logger) : BackgroundService
{
    private const int MaxCidrsPerProvider = 8192;

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

        var googleCidrs = ParseConfiguredCidrs(_configuration["Security:CrawlerCidrs:Google"]);
        var bingCidrs = ParseConfiguredCidrs(_configuration["Security:CrawlerCidrs:Bing"]);
        detector.UpdateCidrLists(googleCidrs, bingCidrs);
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
}
