using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Interfaces;
using Microsoft.AspNetCore.Authorization;
using System.Security.Claims;

namespace FsusBlog.Server.Infrastructure.Filters;

public class BannedUserMiddleware(RequestDelegate _next)
{
    public async Task InvokeAsync(HttpContext context, IBlacklistService blacklist, IUserAccountReader users)
    {
        // 1. 只处理已登录用户
        if (context.User.Identity?.IsAuthenticated != true)
        {
            await _next(context);
            return;
        }

        // --- 核心修复(2026-02-21)：允许所有带有 [AllowAnonymous] 的终结点直接放行 ---
        // 逻辑自洽：解决受限用户在携带旧 Token 请求 Login/RefreshToken 时被中间件误杀拦截的问题。
        // 性能最大化：利用 Endpoint Routing 提供的内存元数据，O(1) 复杂度极速判定。
        var endpoint = context.GetEndpoint();
        if (endpoint?.Metadata?.GetMetadata<IAllowAnonymous>() != null)
        {
            await _next(context);
            return;
        }

        var userIdClaim = context.User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (int.TryParse(userIdClaim, out int userId))
        {
            UserAccountSnapshot? user = await users.GetAccountByIdAsync(userId);
            if (user == null || user.Value.DeletedAt.HasValue || user.Value.Status == 2)
            {
                await MiddlewareResults.WriteErrorAsync(context, "账户已注销", StatusCodes.Status401Unauthorized);
                return;
            }
        }

        // 2. 动词过滤
        var method = context.Request.Method.ToUpper();
        bool isWriteAction = method == "POST" || method == "PUT" || method == "DELETE" || method == "PATCH";

        if (isWriteAction)
        {
            if (endpoint?.Metadata.GetMetadata<BannedUserWriteBypassMetadata>() != null)
            {
                await _next(context);
                return;
            }

            // 4. 提取标识 (int 类型)
            if (int.TryParse(userIdClaim, out int userIdForBan))
            {
                // 5. 高性能校验：直接命中 Redis
                BanStateSnapshot banState = await blacklist.GetBanStateAsync(userIdForBan);

                if (banState.IsBanned)
                {
                    // 将 HTTP 状态码与业务代码从 403 改为 423 (Locked)。
                    // 根本原因：前端的全局 Axios 拦截器一旦捕获到 403，会强制执行清空用户状态并疯狂弹出 Toast。
                    // 状态被清空后，App.vue 失去登录标识导致横幅消失；同时触发 SignalR 以游客身份携带 PoW 尝试重连，陷入死循环。
                    // 改用 423 Locked 可以完美绕过前端的 403 全局拦截，把封禁通知的权利完全交还给 SignalR。
                    await MiddlewareResults.WriteErrorAsync(context, $"账号受限：{banState.Message}", 423);
                    return;
                }
            }
        }

        // 正常请求或 GET 请求，继续执行
        await _next(context);
    }
}

[Obsolete("Use BannedUserMiddleware. The type remains only for binary/source compatibility with older tests.")]
public sealed class BannedUserFilter(RequestDelegate next) : BannedUserMiddleware(next)
{
}
