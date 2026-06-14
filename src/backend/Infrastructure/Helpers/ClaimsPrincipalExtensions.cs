using System.Security.Claims;
using System.Runtime.CompilerServices;
using FsusBlog.Server.Infrastructure;

namespace FsusBlog.Server.Infrastructure.Helpers;

/// <summary>
/// ClaimsPrincipal 扩展工具类
/// 用于从 HttpContext.User 中快速提取身份信息
/// 修复日期: 2026-02-23 (引入 ReadOnlySpan<char> 实现零内存分配的 ID 解析，移除冗余包装方法并实现内联加速)
/// </summary>
public static class ClaimsPrincipalExtensions
{
    /// <summary>
    /// 从 Claims 中安全获取用户 ID (int)
    /// </summary>
    /// <returns>返回用户 ID，若解析失败则返回 0</returns>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static int GetUserId(this ClaimsPrincipal? user)
    {
        long? parsed = FastUserIdProvider.TryParseUserId(user);
        return parsed is > 0 and <= int.MaxValue ? (int)parsed.Value : 0;
    }

    /// <summary>
    /// 从 Claims 中获取用户名
    /// </summary>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static string GetUserName(this ClaimsPrincipal? user)
    {
        if (user == null) return "匿名用户";

        // 优先获取显示名，备选用户名，最后回退到默认值
        return user.FindFirst(ClaimTypes.Name)?.Value
               ?? user.FindFirst("preferred_username")?.Value
               ?? "匿名用户";
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static string? GetSessionId(this ClaimsPrincipal? user)
    {
        return user?.FindFirst("sid")?.Value;
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static bool IsMfaVerified(this ClaimsPrincipal? user)
    {
        return user?.FindFirst("mfa")?.Value == "1";
    }
}
