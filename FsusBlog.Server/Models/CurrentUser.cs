using System.Security.Claims;

namespace FsusBlog.Server.Models;

/// <summary>
/// 自动从 HttpContext.User 提取信息的强类型对象
/// </summary>
public record CurrentUser(long Id)
{
    public static ValueTask<CurrentUser?> BindAsync(HttpContext context)
    {
        // 从 JWT 的 NameIdentifier (通常是 sub) 中提取 ID
        var claim = context.User.FindFirst(ClaimTypes.NameIdentifier);

        if (claim == null || !long.TryParse(claim.Value, out var userId))
        {
            return ValueTask.FromResult<CurrentUser?>(null);
        }

        return ValueTask.FromResult<CurrentUser?>(new CurrentUser(userId));
    }
}