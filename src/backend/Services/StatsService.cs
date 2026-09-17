using System.Data;
using System.Data.Common;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Privacy;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Dtos;

using SqlSugar;

namespace FsusBlog.Server.Services;

/// <summary>
/// Reads administrative and public site statistics through generation-scoped cache identities.
/// </summary>
// Public named-argument source compatibility; exact exception registered in csharp-style-policy.
#pragma warning disable IDE1006
public partial class StatsService(
    ISqlSugarClient _db,
    ICacheTypedReader _cacheReader,
    ICacheRawWriter _cacheWriter,
    ICacheMissCoordinator _cacheMissCoordinator,
    IDbConcurrencyGate _dbConcurrencyGate,
    IReadAnalyticsPrivacyPolicy _readAnalyticsPrivacy,
    ILogger<StatsService> _logger) : IStatsService
#pragma warning restore IDE1006
{
    public async Task<AdminStatsQueryDto> GetAdminStatsAsync()
        => await GetAdminStatsAsync("main");

    internal async Task<AdminStatsQueryDto> GetAdminStatsForGenerationAsync(long sourceGeneration)
        => await GetAdminStatsAsync(AdminStatsFrameVersioning.BuildSourceIdentity(sourceGeneration));

    private async Task<AdminStatsQueryDto> GetAdminStatsAsync(string identity)
        => new()
        {
            Overview = await GetAdminStatsOverviewAsync(identity),
            RecentComments = await GetAdminRecentCommentsAsync(identity),
            Regions = await GetAdminRegionStatsAsync(identity)
        };

    public async Task<AdminStatsOverviewDto> GetAdminStatsOverviewAsync()
        => await GetAdminStatsOverviewAsync("main");

    private async Task<AdminStatsOverviewDto> GetAdminStatsOverviewAsync(string identity)
    {
        return await _cacheMissCoordinator.CoordinateAsync(
                CachePolicyId.AdminStatsOverview,
                identity,
                ct => BoundaryExecutor.ExecuteValueAsync(
                    () => _cacheReader.TryGetAsync(CachePolicyId.AdminStatsOverview, identity, ServerCacheBinaryCodec.DecodeAdminStats, ct),
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
                            () => _cacheWriter.SetRawAsync(CachePolicyId.AdminStatsOverview, identity, ServerCacheBinaryCodec.EncodeAdminStats(result), null, gateCt),
                            _logger,
                            "stats-cache-write",
                            LogLevel.Error);
                        return result;
                    },
                    async gateCt =>
                    {
                        CacheReadResult<AdminStatsOverviewDto> retry = await _cacheReader.TryGetAsync(CachePolicyId.AdminStatsOverview, identity, ServerCacheBinaryCodec.DecodeAdminStats, gateCt);
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
        => await GetAdminRecentCommentsAsync("main");

    private async Task<List<RecentCommentStatItemDto>> GetAdminRecentCommentsAsync(string identity)
    {
        return await _cacheMissCoordinator.CoordinateAsync(
                CachePolicyId.AdminStatsRecentComments,
                identity,
                ct => _cacheReader.TryGetAsync(CachePolicyId.AdminStatsRecentComments, identity, ServerCacheBinaryCodec.DecodeRecentCommentStats, ct),
                async ct =>
                {
                    List<RecentCommentStatItemDto> result = await LoadRecentCommentsAsync(ct);
                    await _cacheWriter.SetRawAsync(CachePolicyId.AdminStatsRecentComments, identity, ServerCacheBinaryCodec.EncodeRecentCommentStats(result), null, ct);
                    return result;
                },
                "admin-stats-recent-comments")
            .ConfigureAwait(false)
            ?? [];
    }

    public async Task<List<RegionStatItemDto>> GetAdminRegionStatsAsync()
        => await GetAdminRegionStatsAsync("main");

    private async Task<List<RegionStatItemDto>> GetAdminRegionStatsAsync(string identity)
    {
        return await _cacheMissCoordinator.CoordinateAsync(
                CachePolicyId.AdminStatsRegions,
                identity,
                ct => _cacheReader.TryGetAsync(CachePolicyId.AdminStatsRegions, identity, ServerCacheBinaryCodec.DecodeRegionStats, ct),
                async ct =>
                {
                    List<RegionStatItemDto> result = await LoadRegionStatsAsync(ct);
                    await _cacheWriter.SetRawAsync(CachePolicyId.AdminStatsRegions, identity, ServerCacheBinaryCodec.EncodeRegionStats(result), null, ct);
                    return result;
                },
                "admin-stats-regions")
            .ConfigureAwait(false)
            ?? [];
    }

    private async Task<AdminStatsOverviewDto> LoadAdminStatsOverviewFromDbAsync(CancellationToken cancellationToken)
    {
        LogStatsCalculationStarted();
        var articleCountQuery = _db.Queryable<Article>()
            .Select(a => new
            {
                Total = SqlFunc.AggregateCount(a.Id),
                Trash = SqlFunc.AggregateSum(SqlFunc.IIF(a.IsDeleted, 1, 0))
            });
        int totalArticles = 0;
        int trashCount = 0;
        var articleCountSql = articleCountQuery.ToSql();
        using (var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(articleCountSql.Key, articleCountSql.Value))
        {
            if (await reader.ReadAsync(cancellationToken))
            {
                totalArticles = reader.IsNull("Total") ? 0 : (int)reader.ReadInt64("Total");
                trashCount = reader.IsNull("Trash") ? 0 : (int)reader.ReadInt64("Trash");
            }
        }

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

        const string ReadStatsSql = """
                SELECT
                    COALESCE((SELECT SUM(total_reads)::bigint FROM daily_read_stats), 0)::bigint AS "TotalReads",
                    COALESCE((SELECT SUM(human_verified_reads)::bigint FROM daily_read_stats), 0)::bigint AS "HumanVerifiedReads",
                    0::bigint AS "UniqueViewerKeyEstimate",
                    COALESCE((SELECT SUM(read_count)::bigint FROM event_type_read_stats WHERE event_type = 'article_read'), 0)::bigint AS "ArticleReads",
                    COALESCE((SELECT SUM(read_count)::bigint FROM event_type_read_stats WHERE event_type = 'site_read'), 0)::bigint AS "SiteReads";
                """;

        int totalReads = 0;
        int humanVerifiedReads = 0;
        int uniqueViewerKeyEstimate = 0;
        int articleReads = 0;
        int siteReads = 0;

        using (var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(ReadStatsSql))
        {
            if (await reader.ReadAsync(cancellationToken))
            {
                totalReads = reader.IsNull("TotalReads") ? 0 : (int)reader.ReadInt64("TotalReads");
                humanVerifiedReads = reader.IsNull("HumanVerifiedReads") ? 0 : (int)reader.ReadInt64("HumanVerifiedReads");
                uniqueViewerKeyEstimate = reader.IsNull("UniqueViewerKeyEstimate") ? 0 : (int)reader.ReadInt64("UniqueViewerKeyEstimate");
                articleReads = reader.IsNull("ArticleReads") ? 0 : (int)reader.ReadInt64("ArticleReads");
                siteReads = reader.IsNull("SiteReads") ? 0 : (int)reader.ReadInt64("SiteReads");
            }
        }

        var result = new AdminStatsOverviewDto
        {
            Summary = new StatsSummaryDto
            {
                TotalArticles = totalArticles,
                TotalComments = totalComments,
                TrashCount = trashCount,
                TotalReads = totalReads,
                HumanVerifiedReads = humanVerifiedReads,
                UniqueViewerKeyEstimate = uniqueViewerKeyEstimate,
                ArticleReads = articleReads,
                SiteReads = siteReads
            },
            PopularArticles = popularArticles,
        };
        return result;
    }

    internal async Task<List<RecentCommentStatItemDto>> LoadRecentCommentsAsync(CancellationToken cancellationToken)
    {
        var recentQuery = _db.Queryable<Comment>()
            .Where(c => c.ModerationStatus == CommentModerationStatus.Approved && !c.IsDeleted)
            .OrderByDescending(c => c.CreateTime)
            .Take(5)
            .Select(c => new
            {
                c.Content,
                c.CreateTime,
                c.AuthorMode,
                c.PublicHandle,
                c.AnonymousDisplayName,
                c.AnonymousScope
            });

        var recentSql = recentQuery.ToSql();
        var recentComments = new List<RecentCommentStatItemDto>(5);

        using var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(recentSql.Key, recentSql.Value);
        int fContent = reader.GetOrdinal("Content");
        int fTime = reader.GetOrdinal("CreateTime");
        int fAuthorMode = reader.GetOrdinal("AuthorMode");
        int fPublicHandle = reader.GetOrdinal("PublicHandle");
        int fAnonymousDisplayName = reader.GetOrdinal("AnonymousDisplayName");
        int fAnonymousScope = reader.GetOrdinal("AnonymousScope");

        while (await reader.ReadAsync(cancellationToken))
        {
            recentComments.Add(CreateRecentCommentStatItem(
                reader.IsDBNull(fAuthorMode) ? null : reader.GetString(fAuthorMode),
                reader.IsDBNull(fPublicHandle) ? null : reader.GetString(fPublicHandle),
                reader.IsDBNull(fAnonymousDisplayName) ? null : reader.GetString(fAnonymousDisplayName),
                reader.IsDBNull(fAnonymousScope) ? null : reader.GetString(fAnonymousScope),
                reader.GetString(fContent),
                reader.GetDateTime(fTime)));
        }

        return recentComments;
    }

    internal static RecentCommentStatItemDto CreateRecentCommentStatItem(
        string? authorMode,
        string? publicHandle,
        string? anonymousDisplayName,
        string? anonymousScope,
        string content,
        DateTime createTime)
    {
        string mode = NormalizeRecentCommentAuthorMode(authorMode);
        return new RecentCommentStatItemDto(
            ResolveRecentCommentAuthorDisplayName(mode, publicHandle, anonymousDisplayName),
            mode,
            BuildRecentCommentAuthorBadge(mode),
            string.Equals(mode, CommentAuthorModes.ZkAnonymous, StringComparison.Ordinal)
                ? TextHelpers.NormalizeNullable(anonymousScope, 128)
                : null,
            content,
            createTime);
    }

    private static string NormalizeRecentCommentAuthorMode(string? authorMode)
    {
        string? normalized = TextHelpers.NormalizeModeToken(authorMode);
        return normalized is CommentAuthorModes.Public or CommentAuthorModes.ZkAnonymous
            ? normalized
            : CommentAuthorModes.LegacyServerVisiblePseudonymous;
    }

    private static string ResolveRecentCommentAuthorDisplayName(string mode, string? publicHandle, string? anonymousDisplayName)
    {
        if (string.Equals(mode, CommentAuthorModes.Public, StringComparison.Ordinal))
        {
            return TextHelpers.NormalizeNullable(publicHandle, 96) ?? "未署名用户";
        }

        string? snapshotName = TextHelpers.NormalizeNullable(anonymousDisplayName, 96);
        if (snapshotName is not null)
        {
            return snapshotName;
        }

        return string.Equals(mode, CommentAuthorModes.ZkAnonymous, StringComparison.Ordinal)
            ? "强匿名评论者"
            : "匿名评论者";
    }

    private static string? BuildRecentCommentAuthorBadge(string mode)
        => string.Equals(mode, CommentAuthorModes.ZkAnonymous, StringComparison.Ordinal)
            ? "已验证匿名资格"
            : null;

    internal async Task<List<RegionStatItemDto>> LoadRegionStatsAsync(CancellationToken cancellationToken)
    {
        const string RegionSql = """
            WITH normalized_regions AS (
                SELECT
                    CASE
                        WHEN region IS NULL
                            OR btrim(region) = ''
                            OR lower(btrim(region)) = 'unknown'
                            OR btrim(region) = '未知'
                        THEN '未知地区'
                        ELSE btrim(region)
                    END AS "Region",
                    read_count
                FROM region_read_stats
            )
            SELECT
                "Region",
                SUM(read_count)::bigint AS "Count"
            FROM normalized_regions
            GROUP BY "Region"
            HAVING SUM(read_count) >= @KThreshold
            ORDER BY "Count" DESC, "Region" ASC
            LIMIT 10;
            """;

        var aggregateCells = new List<ReadAggregateCount>(10);
        using var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(
            RegionSql,
            new SugarParameter("@KThreshold", _readAnalyticsPrivacy.Budget.KThreshold));
        int fRegion = reader.GetOrdinal("Region");
        int fCount = reader.GetOrdinal("Count");

        while (await reader.ReadAsync(cancellationToken))
        {
            string region = reader.IsDBNull(fRegion) ? "未知地区" : reader.GetString(fRegion);
            int count = (int)reader.GetInt64(fCount);
            aggregateCells.Add(new ReadAggregateCount(region, count));
        }

        return _readAnalyticsPrivacy
            .Protect(ReadAnalyticsPrivacyPolicy.AdminRegionScope, aggregateCells)
            .Select(static cell => new RegionStatItemDto(cell.Label, checked((int)Math.Min(int.MaxValue, cell.Count))))
            .ToList();
    }

    internal static string NormalizeRegionForStats(string? region)
    {
        if (string.IsNullOrWhiteSpace(region))
        {
            return "未知地区";
        }

        string trimmed = TextHelpers.TrimOrNull(region) ?? string.Empty;
        return string.Equals(trimmed, "未知", StringComparison.Ordinal) ||
            string.Equals(trimmed, "Unknown", StringComparison.OrdinalIgnoreCase)
            ? "未知地区"
            : trimmed;
    }

    // LoggerMessage source-generates typed logging calls without a params object array.

    [LoggerMessage(EventId = 1, Level = LogLevel.Warning, Message = "仪表盘统计缓存读取异常，已自动切换为实时计算")]
    private partial void LogCacheReadError(Exception ex);

    [LoggerMessage(EventId = 2, Level = LogLevel.Information, Message = "正在执行站点数据全量统计 (Dapper-Like 直接映射模式)...")]
    private partial void LogStatsCalculationStarted();

    [LoggerMessage(EventId = 3, Level = LogLevel.Error, Message = "异步更新统计缓存失败")]
    private partial void LogCacheWriteError(Exception ex);
}
