using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Responses;
using Microsoft.AspNetCore.Mvc;

namespace FsusBlog.Server.Infrastructure.Filters;

public sealed class RequiresPowFilter(
    ILogger<RequiresPowFilter> logger,
    IPowService powService,
    AdaptivePowGovernor governor) : IEndpointFilter
{
    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var validationResult = await PowValidationLogic.ValidateAsync(
            context.HttpContext, logger, powService, governor);

        if (validationResult != null)
        {
            // [修复 2026-02-24] 编译修复 (CS1501): 确保 Results 调用与方法签名完全匹配
            return validationResult switch
            {
                // Results.Unauthorized() 是一个空实现，我们应使用 Results.Json 并手动设置 401
                UnauthorizedObjectResult unauthorized => Results.Json(unauthorized.Value ?? ApiResponse.Fail("Unauthorized", 401), statusCode: 401),
                BadRequestObjectResult badRequest => Results.BadRequest(badRequest.Value ?? ApiResponse.Fail("Bad Request", 400)),
                ObjectResult { StatusCode: 403 } forbidden => Results.Json(forbidden.Value, statusCode: 403),
                _ => Results.StatusCode(500)
            };
        }

        return await next(context);
    }
}