using System.Security.Claims;

namespace FsusBlog.Server.Infrastructure.Helpers;

/// <summary>
/// ClaimsPrincipal 扩展工具类
/// 用于从 HttpContext.User 中快速提取身份信息
/// </summary>
public static class ClaimsPrincipalExtensions
{
    /// <summary>
    /// 从 Claims 中安全获取用户 ID (int)
    /// </summary>
    /// <returns>返回用户 ID，若解析失败则返回 0</returns>
    public static int GetUserId(this ClaimsPrincipal user)
    {
        if (user == null) return 0;

        // 兼容性查找：优先查找标准 NameIdentifier，备选 sub 声明
        var value = user.FindFirstValue(ClaimTypes.NameIdentifier)
                    ?? user.FindFirstValue("sub");

        if (string.IsNullOrWhiteSpace(value)) return 0;

        // 进行安全转换并处理可能的空格干扰
        return int.TryParse(value.Trim(), out int id) ? id : 0;
    }

    /// <summary>
    /// 从 Claims 中获取用户名
    /// </summary>
    public static string GetUserName(this ClaimsPrincipal user)
    {
        if (user == null) return "匿名用户";

        // 优先获取显示名，备选用户名，最后回退到默认值
        return user.FindFirstValue(ClaimTypes.Name)
               ?? user.FindFirstValue("preferred_username")
               ?? "匿名用户";
    }

    /// <summary>
    /// 内部辅助方法：简化 FindFirst 的获取
    /// </summary>
    private static string? FindFirstValue(this ClaimsPrincipal user, string claimType)
    {
        return user.FindFirst(claimType)?.Value;
    }
}
