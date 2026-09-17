namespace FsusBlog.Server.Infrastructure.Middlewares;

/// <summary>
/// 保留中间件占位以维持启动管线兼容；访问计数已迁移到 HumanReadProofService。
/// </summary>
public sealed class VisitLogMiddleware(RequestDelegate next)
{
    public Task InvokeAsync(HttpContext context) => next(context);
}
