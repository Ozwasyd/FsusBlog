using System.Security.Claims;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Interfaces;

using Microsoft.AspNetCore.Authorization;
using Microsoft.Extensions.Caching.Memory;

namespace FsusBlog.Server.Infrastructure.Filters;

// Public named-argument source compatibility; exact exception registered in csharp-style-policy.
#pragma warning disable IDE1006
public class BannedUserMiddleware(RequestDelegate _next)
#pragma warning restore IDE1006
{
    private const string BannedWriteErrorCode = "ACCOUNT_BANNED_WRITE_LOCKED";
    private const string BannedWriteMessage = "account is restricted and cannot perform this write action";

    private static readonly MemoryCacheEntryOptions s_accountStateCacheOptions = new()
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

        // SECURITY-INVARIANT: Anonymous endpoint metadata wins over a stale authenticated cookie so
        // restricted users can still reach login and refresh recovery paths.
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
        string? accountSubjectClaim = context.User.FindFirst(AccountSubjectHasher.ClaimType)?.Value;
        if (!int.TryParse(accountIdClaim, out int accountId)
            || !AccountSubjectHashRequirement.TryResolve(accountSubjectClaim, out string accountSubjectHash))
        {
            await MiddlewareResults.WriteErrorAsync(context, "账户身份无效", StatusCodes.Status401Unauthorized);
            return;
        }

        bool forceAccountStateRefresh = endpoint?.Metadata.GetMetadata<ForceAccountStateRefreshMetadata>() != null;
        UserAccountSnapshot? user = await GetAccountStateAsync(accountId, accountSubjectHash, users, accountStateCache, forceRefresh: forceAccountStateRefresh);
        if (user == null || user.Value.DeletedAt.HasValue || user.Value.Status == 2)
        {
            await MiddlewareResults.WriteErrorAsync(context, "账户已注销", StatusCodes.Status401Unauthorized);
            return;
        }

        if (isWriteAction)
        {
            if (endpoint?.Metadata.GetMetadata<RestrictedAccountActionMetadata>() != null)
            {
                await _next(context);
                return;
            }

            // SECURITY-INVARIANT: Ban state is keyed by both the account ID and stable subject hash.
            BanStateSnapshot banState = await blacklist.GetBanStateAsync(accountId, accountSubjectHash);

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
        if (snapshot.HasValue
            && AccountSubjectHashRequirement.TryResolve(
                snapshot.Value.AccountSubjectHash,
                out string physicalAccountSubjectHash)
            && string.Equals(
                physicalAccountSubjectHash,
                accountSubjectHash,
                StringComparison.Ordinal))
        {
            cache.Set(cacheKey, snapshot.Value, s_accountStateCacheOptions);
        }
        else
        {
            cache.Remove(cacheKey);
            return null;
        }

        return snapshot;
    }
}
