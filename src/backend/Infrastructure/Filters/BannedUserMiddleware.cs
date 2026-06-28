using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Interfaces;
using Microsoft.AspNetCore.Authorization;
using Microsoft.Extensions.Caching.Memory;
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

        if (context.User.IsAdminPrincipal())
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

        string? accountIdClaim = context.User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (int.TryParse(accountIdClaim, out int accountId))
        {
            string accountSubjectHash = AccountSubjectHasher.FromPrincipalOrFallback(context.User, accountId);
            bool forceAccountStateRefresh = endpoint?.Metadata.GetMetadata<ForceAccountStateRefreshMetadata>() != null;
            UserAccountSnapshot? user = await GetAccountStateAsync(accountId, accountSubjectHash, users, accountStateCache, forceRefresh: forceAccountStateRefresh);
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

            // 4. 提取账号标识与稳定 subject hash
            if (int.TryParse(accountIdClaim, out int accountIdForBan))
            {
                // 5. 高性能校验：直接命中 Redis
                string accountSubjectHash = AccountSubjectHasher.FromPrincipalOrFallback(context.User, accountIdForBan);
                BanStateSnapshot banState = await blacklist.GetBanStateAsync(accountIdForBan, accountSubjectHash);

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
        int accountId,
        string accountSubjectHash,
        IUserAccountReader users,
        IMemoryCache cache,
        bool forceRefresh)
    {
        string cacheKey = string.Concat("account:state:", accountSubjectHash);
        if (!forceRefresh && cache.TryGetValue(cacheKey, out UserAccountSnapshot cached))
        {
            return cached;
        }

        UserAccountSnapshot? snapshot = await users.GetAccountByIdAsync(accountId);
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
