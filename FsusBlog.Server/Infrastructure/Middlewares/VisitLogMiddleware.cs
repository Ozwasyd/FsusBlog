using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Helpers;
using IP2Location;
using Microsoft.Extensions.Caching.Distributed;
using Microsoft.Extensions.ObjectPool;
using SqlSugar;

namespace FsusBlog.Server.Infrastructure.Middlewares;

/// <summary>
/// 访问日志中间件：负责流量统计、地域识别与防刷保护
/// </summary>
public class VisitLogMiddleware(
    RequestDelegate _next,
    ObjectPool<Component> _pool,
    IDistributedCache _cache,
    ILogger<VisitLogMiddleware> _logger)
{
    // 静态扩展名集合，优化 O(1) 查找
    private static readonly HashSet<string> IgnoreExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".js", ".css", ".png", ".jpg", ".jpeg", ".ico", ".svg", ".woff", ".woff2", ".map", ".json", ".txt"
    };

    public async Task InvokeAsync(HttpContext context, ISqlSugarClient db)
    {
        var request = context.Request;

        // 1. 快速过滤：仅记录 API 的 GET 请求，排除静态资源
        if (!request.Path.HasValue ||
            !request.Path.StartsWithSegments("/api") ||
            request.Method != "GET")
        {
            await _next(context);
            return;
        }

        string path = request.Path.Value!;
        string ext = Path.GetExtension(path);
        if (!string.IsNullOrEmpty(ext) && IgnoreExtensions.Contains(ext))
        {
            await _next(context);
            return;
        }

        // 2. 提取核心元数据 (必须在异步任务外提取，因为 HttpContext 不跨线程安全)
        string clientIp = context.GetClientIp();
        int userId = context.User.GetUserId(); // 使用我们之前的扩展方法

        // 3. 解析请求类型并生成防刷 Key
        var (lockKey, logType) = AnalyzeRequestType(path, clientIp);
        if (string.IsNullOrEmpty(lockKey))
        {
            await _next(context);
            return;
        }

        // 4. Redis 防刷拦截
        // 如果该 IP 在冷却期内，直接放行，不执行后续逻辑
        var isLocked = await _cache.GetAsync<string>(lockKey);
        if (isLocked != null)
        {
            await _next(context);
            return;
        }

        // 5. 异步入库 (Fire-and-Forget)
        // 剥离主线程，确保不增加 API 响应耗时
        _ = Task.Run(async () =>
        {
            try
            {
                // 使用独立的 DB 上下文
                using var asyncDb = db.CopyNew();

                // A. 写入冷却锁 (文章10分钟，全站30分钟)
                var expiry = logType == "Article" ? TimeSpan.FromMinutes(10) : TimeSpan.FromMinutes(30);
                await _cache.SetAsync(lockKey, "1", expiry);

                // B. IP 地域解析 (从对象池借用组件)
                string region = "未知地区";
                var ipObj = _pool.Get();
                try
                {
                    var res = ipObj.IPQuery(clientIp);
                    if (res?.Status == "OK")
                    {
                        region = $"{res.CountryLong}-{res.Region}-{res.City}".Trim('-');
                    }
                }
                finally
                {
                    _pool.Return(ipObj);
                }

                // C. 执行入库
                await asyncDb.Insertable(new VisitLog
                {
                    IP = clientIp,
                    UserId = userId > 0 ? userId : null,
                    Region = region,
                    CreateTime = DateTime.UtcNow
                    // 如果实体支持，建议增加字段记录 logType
                }).ExecuteCommandAsync();
            }
            catch (Exception ex)
            {
                // 仅记录，不抛出，确保中间件崩溃不影响业务
                _logger.LogError(ex, "后台访问日志记录失败 | IP: {IP} | Path: {Path}", clientIp, path);
            }
        });

        await _next(context);
    }

    /// <summary>
    /// 高性能路径分析：避免使用 Split 产生大量字符串碎片
    /// </summary>
    private static (string? Key, string Type) AnalyzeRequestType(string path, string ip)
    {
        // 1. 文章详情检测: /api/Article/{id}
        if (path.StartsWith("/api/Article/", StringComparison.OrdinalIgnoreCase))
        {
            var idPart = path.AsSpan("/api/Article/".Length);
            if (int.TryParse(idPart, out var articleId))
            {
                return ($"log:lock:art:{articleId}:{ip}", "Article");
            }
        }

        // 2. 列表页检测 (首页、分类、标签)
        if (path.Equals("/api/Article", StringComparison.OrdinalIgnoreCase) ||
            path.StartsWith("/api/Category", StringComparison.OrdinalIgnoreCase) ||
            path.StartsWith("/api/Tag", StringComparison.OrdinalIgnoreCase))
        {
            return ($"log:lock:site:{ip}", "Site");
        }

        return (null, "Ignore");
    }
}
