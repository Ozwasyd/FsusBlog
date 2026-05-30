using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;

namespace FsusBlog.Server.Infrastructure.Filters;

/// <summary>
/// PoW (工作量证明) 强制校验过滤器 (MVC Controller 版)
/// 修复日期: 2026-02-24 (重构为 ServiceFilter 以实现构造函数注入，消除服务定位开销)
/// </summary>
[AttributeUsage(AttributeTargets.Method | AttributeTargets.Class)]
public sealed class RequiresPowAttribute : ServiceFilterAttribute
{
    public RequiresPowAttribute() : base(typeof(RequiresPowFilterImpl))
    {
    }

    /// <summary>
    /// 过滤器核心实现 (注册为 Scoped 服务)
    /// </summary>
    public class RequiresPowFilterImpl(
        IPowService powService,
        AdaptivePowGovernor governor,
        ILogger<RequiresPowFilterImpl> logger) : IAsyncActionFilter
    {
        public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
        {
            var validationResult = await PowValidationLogic.ValidateAsync(
                context.HttpContext, logger, powService, governor);

            if (validationResult != null)
            {
                context.Result = validationResult;
                return;
            }

            await next();
        }
    }
}