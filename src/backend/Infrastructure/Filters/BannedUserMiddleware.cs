using System.Security.Claims;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Interfaces;

namespace FsusBlog.Server.Infrastructure.Filters;

// Public named-argument source compatibility; exact exception registered in csharp-style-policy.
#pragma warning disable IDE1006
public class BannedUserMiddleware(RequestDelegate _next)
#pragma warning restore IDE1006
{
    private const string BannedWriteErrorCode = "ACCOUNT_BANNED_WRITE_LOCKED";
    private const string BannedWriteMessage = "account is restricted and cannot perform this write action";

    // SECURITY-INVARIANT: Authenticated non-admin restricted account sessions may invoke only
    // endpoints with explicit restricted-account action metadata; unauthenticated requests and
    // authenticated administrators bypass this account gate.
    public async Task InvokeAsync(
        HttpContext context,
        IBlacklistService blacklist,
        IAccountStateProjection accountStates)
    {
        // 1. 只处理已登录用户
        if (context.User.Identity?.IsAuthenticated != true)
        {
            await _next(context);
            return;
        }

        var endpoint = context.GetEndpoint();
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
        AccountStateReadResult accountState = forceAccountStateRefresh
            ? await accountStates.RefreshAsync(accountId, accountSubjectHash, context.RequestAborted)
            : await accountStates.ReadAsync(accountId, accountSubjectHash, context.RequestAborted);
        if (accountState.Outcome is AccountStateReadOutcome.Missing
            or AccountStateReadOutcome.Deleted
            or AccountStateReadOutcome.SubjectMismatch)
        {
            await MiddlewareResults.WriteErrorAsync(context, "账户已注销", StatusCodes.Status401Unauthorized);
            return;
        }
        if (accountState.Outcome is AccountStateReadOutcome.Unknown or AccountStateReadOutcome.Conflict)
        {
            await MiddlewareResults.WriteErrorAsync(
                context,
                "账户状态暂不可确认",
                StatusCodes.Status503ServiceUnavailable,
                details: "account_state_unknown");
            return;
        }

        bool restrictedSession = string.Equals(
            context.User.FindFirst(UserSessionModes.ClaimType)?.Value,
            UserSessionModes.ToClaimValue(UserSessionMode.Restricted),
            StringComparison.Ordinal);
        if (restrictedSession)
        {
            if (endpoint?.Metadata.GetMetadata<RestrictedAccountActionMetadata>() != null)
            {
                await _next(context);
                return;
            }

            await MiddlewareResults.WriteErrorAsync(
                context,
                BannedWriteMessage,
                StatusCodes.Status423Locked,
                details: BannedWriteErrorCode);
            return;
        }

        if (isWriteAction)
        {
            if (endpoint?.Metadata.GetMetadata<RestrictedAccountActionMetadata>() != null)
            {
                await _next(context);
                return;
            }

            // SECURITY-INVARIANT: the reusable projection key is the stable subject hash only.
            // Account ID is used solely by the bounded unknown-authority admission.
            BanStateSnapshot banState = await blacklist.GetBanStateAsync(accountId, accountSubjectHash);

            if (!banState.IsKnown)
            {
                await MiddlewareResults.WriteErrorAsync(
                    context,
                    "账户状态暂不可确认",
                    StatusCodes.Status503ServiceUnavailable,
                    details: "ban_state_unknown");
                return;
            }

            if (banState.IsDeleted)
            {
                await MiddlewareResults.WriteErrorAsync(context, "账户已注销", StatusCodes.Status401Unauthorized);
                return;
            }

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

}
