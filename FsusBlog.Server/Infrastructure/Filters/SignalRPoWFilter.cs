using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Responses;
using Microsoft.AspNetCore.Mvc;
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
        var http = context.Context.GetHttpContext() ?? throw new HubException("无法在缺少 HttpContext 的情况下处理连接。");

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
            // 如果验证失败，提取错误信息并抛出 HubException
            if (validationResult is ObjectResult objectResult && objectResult.Value is ApiResponse apiResponse)
            {
                throw new HubException(apiResponse.Message);
            }
            // 兜底异常
            throw new HubException("安全验证失败，连接被拒绝。");
        }

        // 3. 校验通过，放行连接
        await next(context);
    }
}