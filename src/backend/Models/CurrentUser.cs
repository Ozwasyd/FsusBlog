using System.Security.Claims;

namespace FsusBlog.Server.Models;

/// <summary>
/// 自动从 HttpContext.User 提取信息的强类型对象
/// 修复日期: 2026-02-23 (重构为 readonly record struct 实现栈分配与零装箱的极限绑定性能)
/// </summary>
public readonly record struct CurrentUser(long Id)
{
    // 核心优化：利用 .NET 7+ 的静态抽象接口，实现无反射、高性能的自定义参数绑定
    public static ValueTask<CurrentUser?> BindAsync(HttpContext context, System.Reflection.ParameterInfo parameter)
    {
        // 从 JWT 的 NameIdentifier (通常是 sub) 中提取 ID
        // .NET 8+ 的 ClaimsPrincipal.FindFirstValue 是一个经过高度优化的方法
        var userIdStr = context.User.FindFirstValue(ClaimTypes.NameIdentifier);

        if (userIdStr == null || !long.TryParse(userIdStr, out var userId))
        {
            // 核心优化：使用更底层的 ValueTask 构造函数，彻底避免返回 null 时的装箱开销
            return new ValueTask<CurrentUser?>(result: null);
        }

        // 核心优化：直接构造并包装值类型，零装箱
        return new ValueTask<CurrentUser?>(new CurrentUser(userId));
    }
}