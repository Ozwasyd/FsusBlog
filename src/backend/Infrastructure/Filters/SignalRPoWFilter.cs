using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using Microsoft.AspNetCore.Mvc.Infrastructure;
using Microsoft.AspNetCore.SignalR;

namespace FsusBlog.Server.Infrastructure.Filters;

/// <summary>
/// SignalR 连接卫士 (终版)
/// 修复日期: 2026-02-24 (重构为与 REST API 共享 PowValidationLogic 核心，确保防御强度绝对一致)
/// </summary>
public class SignalRPoWFilter(
    ILogger<SignalRPoWFilter> logger,
    IPowService powService,
    AdaptivePowGovernor governor) : IHubFilter
{
    // 方法调用拦截 (保持透传)
    public async ValueTask<object?> InvokeMethodAsync(HubInvocationContext invocationContext, Func<HubInvocationContext, ValueTask<object?>> next)
    {
        return await next(invocationContext);
    }

    // 拦截连接建立 (核心防御逻辑)
    public async Task OnConnectedAsync(HubLifetimeContext context, Func<HubLifetimeContext, Task> next)
    {
        var http = context.Context.GetHttpContext();
        if (http == null)
        {
            logger.LogWarning("SignalR PoW 校验失败：缺少 HttpContext");
            context.Context.Abort();
            return;
        }

        // 1. 已登录用户直接放行 (JWT 校验已由框架层完成)
        if (context.Context.User?.Identity?.IsAuthenticated == true)
        {
            await next(context);
            return;
        }

        // 2. [修复 2026-02-24] 架构演进：将验证委托给共享的 PowValidationLogic 引擎
        // 逻辑自洽：确保 SignalR 的难度校验、RPS 统计、HMAC 签名验证与 REST API 完全一致
        var validationResult = await PowValidationLogic.ValidateFromQueryAsync(http, logger, powService, governor);

        if (validationResult != null)
        {
            if (validationResult is IStatusCodeActionResult status)
            {
                logger.LogWarning("SignalR PoW 拒绝连接 | StatusCode: {StatusCode}", status.StatusCode);
            }

            context.Context.Abort();
            return;
        }

        // 3. 校验通过，放行连接
        await next(context);
    }
}
