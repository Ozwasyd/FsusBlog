using FsusBlog.Server.Entities;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using SqlSugar;
using StackExchange.Redis;
using System.Data;
using System.Data.Common;
using System.Text.Json;

namespace FsusBlog.Server.Services;

/// <summary>
/// 站点统计服务实现
/// 修复日期: 2026-02-23 (修复 LINQ 投影后上下文丢失导致的编译错误，保持 Dapper 级物理映射)
/// </summary>
public partial class StatsService(
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
        // 1. 【缓存层】零分配读取
        try
        {
            using var lease = await _cache.StringGetLeaseAsync(CACHE_KEY);
            if (lease != null && lease.Length > 0)
            {
                var cachedValue = JsonSerializer.Deserialize<SiteStatsDto>(lease.Span, _jsonOptions);
                if (cachedValue != null) return cachedValue;
            }
        }
        catch (Exception ex)
        {
            LogCacheReadError(ex);
        }

        // 2. 执行数据库统计
        // 核心优化：直接复用注入的 _db 实例，避免 CopyNew() 申请独立物理连接
        LogStatsCalculationStarted();

        // --- 维度 1: 内容计数 ---
        var totalArticles = await _db.Queryable<Article>().CountAsync();
        var totalComments = await _db.Queryable<Comment>().CountAsync();
        var trashCount = await _db.Queryable<Article>()
            .ClearFilter()
            .Where(a => a.IsDeleted)
            .CountAsync();

        // --- 维度 2: 排行榜 (物理映射 PopularArticleDto) ---
        var popularQuery = _db.Queryable<Article>()
            .OrderByDescending(a => a.Views)
            .Take(5)
            .Select(a => new { a.Id, a.Title, a.Views });

        var popularSql = popularQuery.ToSql();
        var popularArticles = new List<PopularArticleDto>(5);

        using (var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(popularSql.Key, popularSql.Value))
        {
            int fId = reader.GetOrdinal("Id");
            int fTitle = reader.GetOrdinal("Title");
            int fViews = reader.GetOrdinal("Views");

            while (await reader.ReadAsync())
            {
                popularArticles.Add(new PopularArticleDto(
                    reader.GetInt32(fId),
                    reader.GetString(fTitle),
                    reader.GetInt32(fViews)));
            }
        }

        // --- 维度 2: 最新评论 (物理映射 RecentCommentDto) ---
        var recentQuery = _db.Queryable<Comment>()
            .LeftJoin<User>((c, u) => c.UserId == u.Id)
            .OrderByDescending(c => c.CreateTime)
            .Take(5)
            .Select((c, u) => new
            {
                u.Id,
                u.Username,
                c.Content,
                c.CreateTime
            });

        var recentSql = recentQuery.ToSql();
        var recentComments = new List<RecentCommentDto>(5);

        using (var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(recentSql.Key, recentSql.Value))
        {
            int fUserId = reader.GetOrdinal("Id");
            int fUserName = reader.GetOrdinal("Username");
            int fContent = reader.GetOrdinal("Content");
            int fTime = reader.GetOrdinal("CreateTime");

            while (await reader.ReadAsync())
            {
                recentComments.Add(new RecentCommentDto(
                    reader.IsDBNull(fUserId) ? 0 : reader.GetInt32(fUserId),
                    reader.IsDBNull(fUserName) ? "匿名访客" : reader.GetString(fUserName),
                    reader.GetString(fContent),
                    reader.GetDateTime(fTime)));
            }
        }

        // --- 维度 3: 访客统计 (聚合查询) ---
        var visitStatsQuery = _db.Queryable<VisitLog>()
            .Select(v => new
            {
                Registered = SqlFunc.AggregateSum(SqlFunc.IIF(v.UserId != null, 1, 0)),
                Anonymous = SqlFunc.AggregateSum(SqlFunc.IIF(v.UserId == null, 1, 0))
            });

        var visitStatsSql = visitStatsQuery.ToSql();
        int registeredVisits = 0;
        int anonymousVisits = 0;

        using (var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(visitStatsSql.Key, visitStatsSql.Value))
        {
            if (await reader.ReadAsync())
            {
                // 核心优化：彻底消灭装箱刺客。Postgres SUM 返回 Int64。
                registeredVisits = reader.IsDBNull(0) ? 0 : (int)reader.GetInt64(0);
                anonymousVisits = reader.IsDBNull(1) ? 0 : (int)reader.GetInt64(1);
            }
        }

        // --- 维度 3: 地域分布 (物理映射 RegionDistributionDto) ---
        var regionQuery = _db.Queryable<VisitLog>()
            .GroupBy(v => v.Region)
            .Select(v => new
            {
                Region = SqlFunc.IsNull(v.Region, "未知地区"),
                Count = SqlFunc.AggregateCount(v.Id)
            })
            // 核心修复：Select 之后上下文已变，直接对投影后的 Count 属性排序
            .OrderByDescending(v => v.Count)
            .Take(10);

        var regionSql = regionQuery.ToSql();
        var regionDistributions = new List<RegionDistributionDto>(10);

        using (var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(regionSql.Key, regionSql.Value))
        {
            int fRegion = reader.GetOrdinal("Region");
            int fCount = reader.GetOrdinal("Count");

            while (await reader.ReadAsync())
            {
                regionDistributions.Add(new RegionDistributionDto(
                    reader.GetString(fRegion),
                    (int)reader.GetInt64(fCount)));
            }
        }

        // 3. 【结果组装】
        var result = new SiteStatsDto
        {
            TotalArticles = totalArticles,
            TotalComments = totalComments,
            TrashCount = trashCount,
            PopularArticles = popularArticles,
            RecentComments = recentComments,
            RegionDistributions = regionDistributions,
            RegisteredVisits = registeredVisits,
            AnonymousVisits = anonymousVisits,
            TotalVisits = registeredVisits + anonymousVisits
        };

        // 4. 【缓存回填】同步调度，避免 Task.Run 游离任务导致不可控并发与异常黑洞
        try
        {
            var bytes = JsonSerializer.SerializeToUtf8Bytes(result, _jsonOptions);
            await _cache.StringSetAsync(CACHE_KEY, bytes, TimeSpan.FromMinutes(10));
        }
        catch (Exception ex)
        {
            LogCacheWriteError(ex);
        }

        return result;
    }

    // ==========================================
    // 高性能日志源生成器 (Zero-Allocation Logging)
    // ==========================================

    [LoggerMessage(EventId = 1, Level = LogLevel.Warning, Message = "仪表盘统计缓存读取异常，已自动切换为实时计算")]
    private partial void LogCacheReadError(Exception ex);

    [LoggerMessage(EventId = 2, Level = LogLevel.Information, Message = "正在执行站点数据全量统计 (Dapper-Like 直接映射模式)...")]
    private partial void LogStatsCalculationStarted();

    [LoggerMessage(EventId = 3, Level = LogLevel.Error, Message = "异步更新统计缓存失败")]
    private partial void LogCacheWriteError(Exception ex);
}
