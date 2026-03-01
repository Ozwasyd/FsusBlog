using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Responses;
using Microsoft.AspNetCore.Http.HttpResults;

namespace FsusBlog.Server.Modules.Endpoints;

/// <summary>
/// 消息中心端点 (Minimal API)
/// 修复日期: 2026-02-23 (使用完整的 Results<T> 联合类型以实现零分配和精确元数据)
/// </summary>
public static class MessageEndpoints
{
    public static IEndpointRouteBuilder MapMessageEndpoints(this IEndpointRouteBuilder app)
    {
        // --- 1. 用户收件箱接口 (Base Path: /api/v1/messages) ---
        var userGroup = app.MapGroup("/api/v1/messages").RequireAuthorization();

        // 获取收件箱
        userGroup.MapGet("/inbox", static async (
            int page,
            int size,
            IMessageService svc,
            CurrentUser user) =>
        {
            var pageSize = Math.Clamp(size, 1, 50);
            var pageNum = Math.Max(1, page);

            var data = await svc.GetInboxAsync(user.Id, pageNum, pageSize);
            return TypedResults.Ok(ApiResponse<List<MessageInboxDto>>.Success(data));
        });

        // 删除消息
        userGroup.MapDelete("/{id:long}", static async (
            long id,
            IMessageService svc,
            CurrentUser user) =>
        {
            await svc.DeleteMessageAsync(user.Id, id);
            return TypedResults.Ok(ApiResponse.Success("消息已从收件箱移除"));
        });

        // 标记单条已读
        userGroup.MapPost("/{id:long}/read", static async (
            long id,
            IMessageService svc,
            CurrentUser user) =>
        {
            await svc.MarkAsReadAsync(user.Id, id);
            return TypedResults.Ok(ApiResponse.Success("已读"));
        });

        // 全部标记为已读
        userGroup.MapPost("/read-all", static async (
            IMessageService svc,
            CurrentUser user) =>
        {
            await svc.MarkAllAsReadAsync(user.Id);
            return TypedResults.Ok(ApiResponse.Success("已清空未读"));
        });

        // --- 2. 管理员消息管理接口 (Base Path: /api/v1/admin/messages) ---
        var adminGroup = app.MapGroup("/api/v1/admin/messages")
            .RequireAuthorization(policy => policy.RequireRole("admin"));

        // 发布全站公告
        // 核心修复：显式声明完整的、无别名的返回类型
        adminGroup.MapPost("/broadcast", static async Task<Results<Ok<ApiResponse>, BadRequest<ApiResponse>>> (
            BroadcastRequest req,
            IMessageService svc) =>
        {
            if (string.IsNullOrWhiteSpace(req.Title))
                return TypedResults.BadRequest(ApiResponse.Fail("标题不能为空"));

            await svc.PublishGlobalNoticeAsync(req.Title, req.Content);
            return TypedResults.Ok(ApiResponse.Success("全站公告已实时分发"));
        })
        .AddEndpointFilter<RequiresPowFilter>();

        // 发送点对点私信
        // 核心修复：显式声明完整的、无别名的返回类型
        adminGroup.MapPost("/direct", static async Task<Results<Ok<ApiResponse>, BadRequest<ApiResponse>>> (
            AdminDirectMessageRequest req,
            IMessageService svc) =>
        {
            if (req.TargetUserId <= 0)
                return TypedResults.BadRequest(ApiResponse.Fail("无效的目标用户"));
            if (string.IsNullOrWhiteSpace(req.Title))
                return TypedResults.BadRequest(ApiResponse.Fail("标题不能为空"));

            await svc.SendPrivateNoticeAsync(req.TargetUserId, req.Title, req.Content);
            return TypedResults.Ok(ApiResponse.Success("私信已送达"));
        })
        .AddEndpointFilter<RequiresPowFilter>();

        // 获取发送历史记录
        adminGroup.MapGet("/history", static async (
            int page,
            int size,
            IMessageService svc) =>
        {
            var pageSize = Math.Clamp(size, 1, 50);
            var data = await svc.GetAdminSentMessagesAsync(page, pageSize);
            return TypedResults.Ok(ApiResponse<List<MessageInboxDto>>.Success(data));
        });

        // 管理员物理撤回（删除）
        adminGroup.MapDelete("/{id:long}", static async (
            long id,
            IMessageService svc) =>
        {
            await svc.RevokeMessageAsync(id);
            return TypedResults.Ok(ApiResponse.Success("消息已成功撤回并从全端移除"));
        })
        .AddEndpointFilter<RequiresPowFilter>();

        return app;
    }
}

// 契约定义保持不变
public record BroadcastRequest(string Title, string Content);
public record AdminDirectMessageRequest(long TargetUserId, string Title, string Content);