using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Responses;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;

namespace FsusBlog.Server.Infrastructure.Filters;

/// <summary>
/// 敏感内容拦截过滤器
/// 修复日期: 2026-02-21
/// 职责: 在进入 Controller 业务逻辑前，进行全局的文本安全阻断
/// </summary>
[AttributeUsage(AttributeTargets.Method | AttributeTargets.Class)]
public class SensitiveContentFilterAttribute : Attribute, IAsyncActionFilter
{
    public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
    {
        // 1. 遍历 Action 的所有入参
        foreach (var argument in context.ActionArguments.Values)
        {
            // 2. 性能最大化：使用 is 模式匹配进行极速的 O(1) 类型转换，彻底弃用反射
            if (argument is ICheckableContent checkableObj)
            {
                string textToValidate = checkableObj.GetTextToCheck();

                if (!string.IsNullOrWhiteSpace(textToValidate))
                {
                    // 3. 从 DI 容器中获取我们一直在后台运行的 DFA 单例引擎
                    var filterService = context.HttpContext.RequestServices.GetRequiredService<IContentFilterService>();

                    ContentValidationResult validation = filterService.ValidateContent(textToValidate);

                    if (!validation.IsValid)
                    {
                        // 4. 拦截请求，直接返回 400 错误，保护 Controller 不被污染
                        var logger = context.HttpContext.RequestServices.GetRequiredService<ILogger<SensitiveContentFilterAttribute>>();
                        logger.LogWarning("过滤器拦截敏感请求 | IP: {IP} | 原因: {Reason}",
                            context.HttpContext.Connection.RemoteIpAddress?.ToString(), validation.ReasonCode);

                        context.Result = new BadRequestObjectResult(ApiResponse.Fail(validation.Message, 400, context.HttpContext.TraceIdentifier));
                        return;
                    }
                }
            }
        }

        // 5. 校验通过，放行到 Controller
        await next();
    }
}
