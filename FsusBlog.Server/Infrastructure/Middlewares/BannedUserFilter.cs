using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Responses;
using System.Net;
using System.Security.Claims;

namespace FsusBlog.Server.Infrastructure.Middlewares;

public class BannedUserFilter(RequestDelegate _next)
{
    public async Task InvokeAsync(HttpContext context, IBlacklistService blacklist)
    {
        // 1. 只处理已登录用户
        if (context.User.Identity?.IsAuthenticated != true)
        {
            await _next(context);
            return;
        }

        // 2. 动词过滤 
        var method = context.Request.Method.ToUpper();
        bool isWriteAction = method == "POST" || method == "PUT" || method == "DELETE" || method == "PATCH";

        if (isWriteAction)
        {
            var path = context.Request.Path.Value?.ToLower() ?? "";

            bool isMessageRelated = path.Contains("/messages");
            bool isReadAction = path.EndsWith("/read") || path.EndsWith("/read-all");
            bool isDeleteAction = method == "DELETE";

            // 允许：1.退出登录  2.消息已读相关  3.删除消息动作
            bool isWhitelisted = path.EndsWith("/logout") || isReadAction || (isMessageRelated && isDeleteAction);

            if (isWhitelisted)
            {
                await _next(context);
                return;
            }

            // 4. 提取标识 (int 类型)
            var userIdClaim = context.User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
            if (int.TryParse(userIdClaim, out int userId))
            {
                // 5. 高性能校验：直接命中 Redis
                var banReason = await blacklist.GetBanReasonAsync(userId);

                if (!string.IsNullOrEmpty(banReason))
                {
                    // 6. 命中封禁：返回统一的 ApiResponse 结构
                    context.Response.StatusCode = (int)HttpStatusCode.Forbidden;
                    context.Response.ContentType = "application/json";

                    // 保持与项目整体响应结构一致
                    var response = ApiResponse.Fail($"账号受限：{banReason}", 403);

                    await context.Response.WriteAsJsonAsync(response);
                    return;
                }
            }
        }

        // 正常请求或 GET 请求，继续执行
        await _next(context);
    }
}