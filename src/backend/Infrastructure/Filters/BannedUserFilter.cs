using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Interfaces;
using Microsoft.AspNetCore.Authorization;
using Microsoft.Extensions.Caching.Memory;
using System.Globalization;
using System.Security.Claims;

namespace FsusBlog.Server.Infrastructure.Filters;

public class BannedUserMiddleware(RequestDelegate _next)
{
    private const string BannedWriteErrorCode = "ACCOUNT_BANNED_WRITE_LOCKED";
    private const string BannedWriteMessage = "account is restricted and cannot perform this write action";

    private static readonly MemoryCacheEntryOptions AccountStateCacheOptions = new()
    {
        AbsoluteExpirationRelativeToNow = TimeSpan.FromSeconds(60)
    };

    public async Task InvokeAsync(
        HttpContext context,
        IBlacklistService blacklist,
        IUserAccountReader users,
        IMemoryCache accountStateCache)
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

        string method = context.Request.Method;
        bool isWriteAction =
            HttpMethods.IsPost(method)
            || HttpMethods.IsPut(method)
            || HttpMethods.IsDelete(method)
            || HttpMethods.IsPatch(method);

        string? userIdClaim = context.User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (int.TryParse(userIdClaim, out int userId))
        {
            UserAccountSnapshot? user = await GetAccountStateAsync(userId, users, accountStateCache, forceRefresh: isWriteAction);
            if (user == null || user.Value.DeletedAt.HasValue || user.Value.Status == 2)
            {
                await MiddlewareResults.WriteErrorAsync(context, "账户已注销", StatusCodes.Status401Unauthorized);
                return;
            }
        }

        if (isWriteAction)
        {
            if (endpoint?.Metadata.GetMetadata<RestrictedAccountActionMetadata>() != null)
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
                    await MiddlewareResults.WriteErrorAsync(
                        context,
                        BannedWriteMessage,
                        StatusCodes.Status423Locked,
                        details: BannedWriteErrorCode);
                    return;
                }
            }
        }

        // 正常请求或 GET 请求，继续执行
        await _next(context);
    }

    private static async Task<UserAccountSnapshot?> GetAccountStateAsync(
        int userId,
        IUserAccountReader users,
        IMemoryCache cache,
        bool forceRefresh)
    {
        string cacheKey = string.Concat("user:account-state:", userId.ToString(CultureInfo.InvariantCulture));
        if (!forceRefresh && cache.TryGetValue(cacheKey, out UserAccountSnapshot cached))
        {
            return cached;
        }

        UserAccountSnapshot? snapshot = await users.GetAccountByIdAsync(userId);
        if (snapshot.HasValue)
        {
            cache.Set(cacheKey, snapshot.Value, AccountStateCacheOptions);
        }
        else
        {
            cache.Remove(cacheKey);
        }

        return snapshot;
    }
}

[Obsolete("Use BannedUserMiddleware. The type remains only for binary/source compatibility with older tests.")]
public sealed class BannedUserFilter(RequestDelegate next) : BannedUserMiddleware(next)
{
}
