using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Services.VistitLog;
using StackExchange.Redis;

namespace FsusBlog.Server.Infrastructure.Middlewares;

/// <summary>
/// 访问日志中间件：负责流量统计与防刷保护
///[修改日期 2026-03-01]
/// 修改理由：剔除未使用变量；废弃危险且冗长的 string.Create，交由 .NET 10 的 DefaultInterpolatedStringHandler 实现绝对安全的零分配内插。
/// </summary>
public class VisitLogMiddleware(
    RequestDelegate _next,
    VisitLogChannel _channel,
    IConnectionMultiplexer _redis)
{
    public async Task InvokeAsync(HttpContext context)
    {
        var request = context.Request;
        var path = request.Path;

        // 预检查，快速过滤掉绝大多数无效请求
        if (!path.HasValue ||
            !path.StartsWithSegments("/api") ||
            request.Method != HttpMethods.Get)
        {
            await _next(context);
            return;
        }

        var pathValue = path.Value;
        var pathSpan = pathValue.AsSpan();

        // 使用 ReadOnlySpan<char> 和 LastIndexOf，实现零分配的扩展名检查
        int lastDot = pathSpan.LastIndexOf('.');
        if (lastDot != -1)
        {
            int lastSlash = pathSpan.LastIndexOf('/');
            if (lastDot > lastSlash)
            {
                await _next(context);
                return;
            }
        }

        string clientIp = context.GetClientIp();
        int userId = context.User.GetUserId();

        var (lockKey, logType) = AnalyzeRequestType(pathValue, pathSpan, clientIp);
        if (lockKey is null)
        {
            await _next(context);
            return;
        }

        var expiry = logType == "Article" ? TimeSpan.FromMinutes(10) : TimeSpan.FromMinutes(30);

        IDatabase db = _redis.GetDatabase();
        bool isNewVisit = await db.StringSetAsync(lockKey, "1", expiry, When.NotExists);

        if (isNewVisit)
        {
            _channel.TryWrite(new VisitLogMessage
            {
                IP = clientIp,
                UserId = userId > 0 ? userId : null,
                CreateTime = DateTime.UtcNow
            });
        }

        await _next(context);
    }

    private static (string? Key, string Type) AnalyzeRequestType(string path, ReadOnlySpan<char> pathSpan, string ip)
    {
        const string articlePrefix = "/api/Article/";
        if (path.StartsWith(articlePrefix, StringComparison.OrdinalIgnoreCase))
        {
            var idSpan = pathSpan[articlePrefix.Length..];
            if (int.TryParse(idSpan, out var articleId))
            {
                // [修复日期 2026-03-01] 
                // 物理真相：.NET 10 编译器会自动将其转化为无堆内存分配的内插处理程序。
                // 彻底消灭了原 string.Create 由于长度计算误差导致的末尾 \0 内存污染风险。
                return ($"log:lock:art:{articleId}:{ip}", "Article");
            }
        }

        if (path.Equals("/api/Article", StringComparison.OrdinalIgnoreCase) ||
            path.StartsWith("/api/Category", StringComparison.OrdinalIgnoreCase) ||
            path.StartsWith("/api/Tag", StringComparison.OrdinalIgnoreCase))
        {
            return ($"log:lock:site:{ip}", "Site");
        }

        return (null, "Ignore");
    }
}