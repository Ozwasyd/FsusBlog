using FsusBlog.Server.Entities;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using SqlSugar;
using StackExchange.Redis;
using System.Text.Json;

namespace FsusBlog.Server.Services;

/// <summary>
/// 站点统计服务实现
/// </summary>
public class StatsService(
    ISqlSugarClient _db,
    IConnectionMultiplexer _redis,
    ILogger<StatsService> _logger) : IStatsService
{
    private readonly IDatabase _cache = _redis.GetDatabase();
    private const string CACHE_KEY = "admin:dashboard:stats";

    private static readonly JsonSerializerOptions _jsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull
    };

    public async Task<SiteStatsDto> GetAdminStatsAsync()
    {
        // 1. 【缓存层】尝试优先命中 Redis
        try
        {
            var cachedValue = await _cache.StringGetAsync(CACHE_KEY);
            if (cachedValue.HasValue)
            {
                return JsonSerializer.Deserialize<SiteStatsDto>(cachedValue.ToString(), _jsonOptions)!;
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "仪表盘统计缓存读取异常，已自动切换为实时计算");
        }

        // 2. 【顺序执行】数据库统计逻辑
        // 使用 CopyNew 确保不与其他业务 Service 共用一个数据库上下文实例
        using var db = _db.CopyNew();
        _logger.LogInformation("正在执行站点数据全量统计 (顺序模式)...");

        // --- 维度 1: 内容计数 ---
        var totalArticles = await db.Queryable<Article>().CountAsync();
        var totalComments = await db.Queryable<Comment>().CountAsync();
        var trashCount = await db.Queryable<Article>()
            .ClearFilter() // 🌟 必须清除全局软删除过滤器才能看到垃圾箱数量
            .Where(a => a.IsDeleted)
            .CountAsync();

        // --- 维度 2: 排行榜与列表 ---
        var popularArticles = await db.Queryable<Article>()
            .OrderByDescending(a => a.Views)
            .Take(5)
            .Select(a => new PopularArticleDto { Id = a.Id, Title = a.Title, Views = a.Views })
            .ToListAsync();

        var recentComments = await db.Queryable<Comment>()
            .Includes(c => c.User) // 预加载用户头像/名称
            .OrderByDescending(c => c.CreateTime)
            .Take(5)
            .Select(c => new RecentCommentDto
            {
                UserName = c.User.Username ?? "匿名访客",
                Content = c.Content,
                CreateTime = c.CreateTime
            })
            .ToListAsync();

        // --- 维度 3: 访客分布统计 ---
        // 使用聚合函数一次性查出注册与匿名数量
        var visitStats = await db.Queryable<VisitLog>()
            .Select(v => new
            {
                Registered = SqlFunc.AggregateSum(SqlFunc.IIF(v.UserId != null, 1, 0)),
                Anonymous = SqlFunc.AggregateSum(SqlFunc.IIF(v.UserId == null, 1, 0))
            })
            .FirstAsync() ?? new { Registered = 0, Anonymous = 0 };

        var regionDistributions = await db.Queryable<VisitLog>()
            .GroupBy(v => v.Region)
            .Select(v => new RegionDistributionDto
            {
                Region = v.Region ?? "未知地区",
                Count = SqlFunc.AggregateCount(v.Id)
            })
            .OrderByDescending(it => it.Count)
            .Take(10)
            .ToListAsync();

        // 3. 【结果组装】
        var result = new SiteStatsDto
        {
            TotalArticles = totalArticles,
            TotalComments = totalComments,
            TrashCount = trashCount,
            PopularArticles = popularArticles,
            RecentComments = recentComments,
            RegionDistributions = regionDistributions,
            RegisteredVisits = visitStats.Registered,
            AnonymousVisits = visitStats.Anonymous,
            TotalVisits = visitStats.Registered + visitStats.Anonymous
        };

        // 4. 【异步背景更新缓存】
        // 使用 Task.Run 确保写 Redis 不会增加用户请求的响应延时
        _ = Task.Run(async () =>
        {
            try
            {
                var json = JsonSerializer.Serialize(result, _jsonOptions);
                await _cache.StringSetAsync(CACHE_KEY, json, TimeSpan.FromMinutes(10));
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "异步更新统计缓存失败");
            }
        });

        return result;
    }
}