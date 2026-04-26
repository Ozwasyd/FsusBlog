using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using SqlSugar;
using System.Data;
using System.Data.Common;

namespace FsusBlog.Server.Services;

/// <summary>
/// 站点统计服务实现
/// 修复日期: 2026-02-23 (修复 LINQ 投影后上下文丢失导致的编译错误，保持 Dapper 级物理映射)
/// </summary>
public partial class StatsService(
    ISqlSugarClient _db,
    IUnifiedCache _cache,
    ICacheMissCoordinator _cacheMissCoordinator,
    IDbConcurrencyGate _dbConcurrencyGate,
    ILogger<StatsService> _logger) : IStatsService
{
    public async Task<AdminStatsOverviewDto> GetAdminStatsOverviewAsync()
    {
        return await _cacheMissCoordinator.CoordinateAsync(
                CachePolicyId.AdminStats,
                "main",
                ct => BoundaryExecutor.ExecuteValueAsync(
                    () => _cache.TryGetJsonAsync<AdminStatsOverviewDto>(CachePolicyId.AdminStats, "main", ct),
                    _ => new CacheReadResult<AdminStatsOverviewDto>(false, default),
                    _logger,
                    "stats-cache-read",
                    LogLevel.Warning),
                async ct => await _dbConcurrencyGate.ExecuteAsync(
                    "admin-stats",
                    async gateCt =>
                    {
                        AdminStatsOverviewDto result = await LoadAdminStatsOverviewFromDbAsync(gateCt);
                        await BoundaryExecutor.ExecuteAsync(
                            () => _cache.SetJsonAsync(CachePolicyId.AdminStats, "main", result, gateCt),
                            _logger,
                            "stats-cache-write",
                            LogLevel.Error);
                        return result;
                    },
                    async gateCt =>
                    {
                        CacheReadResult<AdminStatsOverviewDto> retry = await _cache.TryGetJsonAsync<AdminStatsOverviewDto>(CachePolicyId.AdminStats, "main", gateCt);
                        if (retry.Hit && retry.Value is not null)
                        {
                            return retry.Value;
                        }

                        throw new TimeoutException("db-gate-timeout:admin-stats");
                    },
                    ct),
                "admin-stats")
            .ConfigureAwait(false)
            ?? new AdminStatsOverviewDto();
    }

    public async Task<List<RecentCommentStatItemDto>> GetAdminRecentCommentsAsync()
        => await LoadRecentCommentsAsync(CancellationToken.None);

    public async Task<List<RegionStatItemDto>> GetAdminRegionStatsAsync()
        => await LoadRegionStatsAsync(CancellationToken.None);

    private async Task<AdminStatsOverviewDto> LoadAdminStatsOverviewFromDbAsync(CancellationToken cancellationToken)
    {
        LogStatsCalculationStarted();

        int totalArticles = await _db.Queryable<Article>().CountAsync();
        int trashCount = await _db.Queryable<Article>().Where(a => a.IsDeleted).CountAsync();
        int totalComments = await _db.Queryable<Comment>().CountAsync();

        var popularQuery = _db.Queryable<Article>()
            .OrderByDescending(a => a.Views)
            .Take(5)
            .Select(a => new { a.Id, a.Title, a.Views });

        var popularSql = popularQuery.ToSql();
        var popularArticles = new List<PopularArticleStatItemDto>(5);

        using (var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(popularSql.Key, popularSql.Value))
        {
            int fId = reader.GetOrdinal("Id");
            int fTitle = reader.GetOrdinal("Title");
            int fViews = reader.GetOrdinal("Views");

            while (await reader.ReadAsync(cancellationToken))
            {
                popularArticles.Add(new PopularArticleStatItemDto(
                    reader.GetInt32(fId),
                    reader.GetString(fTitle),
                    reader.GetInt32(fViews)));
            }
        }

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
            if (await reader.ReadAsync(cancellationToken))
            {
                registeredVisits = reader.IsDBNull(0) ? 0 : (int)reader.GetInt64(0);
                anonymousVisits = reader.IsDBNull(1) ? 0 : (int)reader.GetInt64(1);
            }
        }

        return new AdminStatsOverviewDto
        {
            Summary = new StatsSummaryDto
            {
                TotalArticles = totalArticles,
                TotalComments = totalComments,
                TrashCount = trashCount,
                RegisteredVisits = registeredVisits,
                AnonymousVisits = anonymousVisits,
                TotalVisits = registeredVisits + anonymousVisits
            },
            PopularArticles = popularArticles,
        };
    }

    private async Task<List<RecentCommentStatItemDto>> LoadRecentCommentsAsync(CancellationToken cancellationToken)
    {
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
        var recentComments = new List<RecentCommentStatItemDto>(5);

        using var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(recentSql.Key, recentSql.Value);
        int fUserId = reader.GetOrdinal("Id");
        int fUserName = reader.GetOrdinal("Username");
        int fContent = reader.GetOrdinal("Content");
        int fTime = reader.GetOrdinal("CreateTime");

        while (await reader.ReadAsync(cancellationToken))
        {
            recentComments.Add(new RecentCommentStatItemDto(
                reader.IsDBNull(fUserId) ? null : reader.GetInt32(fUserId),
                reader.IsDBNull(fUserName) ? "匿名访客" : reader.GetString(fUserName),
                reader.GetString(fContent),
                reader.GetDateTime(fTime)));
        }

        return recentComments;
    }

    private async Task<List<RegionStatItemDto>> LoadRegionStatsAsync(CancellationToken cancellationToken)
    {
        var regionQuery = _db.Queryable<VisitLog>()
            .GroupBy(v => v.Region)
            .Select(v => new
            {
                Region = SqlFunc.IsNull(v.Region, "未知地区"),
                Count = SqlFunc.AggregateCount(v.Id)
            })
            .OrderByDescending(v => v.Count)
            .Take(10);

        var regionSql = regionQuery.ToSql();
        var regionDistributions = new List<RegionStatItemDto>(10);

        using var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(regionSql.Key, regionSql.Value);
        int fRegion = reader.GetOrdinal("Region");
        int fCount = reader.GetOrdinal("Count");

        while (await reader.ReadAsync(cancellationToken))
        {
            regionDistributions.Add(new RegionStatItemDto(
                reader.GetString(fRegion),
                (int)reader.GetInt64(fCount)));
        }

        return regionDistributions;
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
