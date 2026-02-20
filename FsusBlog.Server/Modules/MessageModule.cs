using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Responses;

namespace FsusBlog.Server.Modules;

using Microsoft.AspNetCore.Mvc;

public static class MessageModule
{
    public static IEndpointRouteBuilder MapMessageEndpoints(this IEndpointRouteBuilder app)
    {
        // --- 1. 用户收件箱接口 (Base Path: /api/v1/messages) ---
        var userGroup = app.MapGroup("/api/v1/messages").RequireAuthorization();

        // 获取收件箱 - 显式指定参数来源
        userGroup.MapGet("/inbox", static async (
            [FromQuery] int page,
            [FromQuery] int size,
            IMessageService svc,
            CurrentUser user) =>
        {
            // 性能优化：使用 Math 限制范围，逻辑更清晰
            var pageSize = Math.Clamp(size, 1, 50);
            var pageNum = Math.Max(1, page);

            var data = await svc.GetInboxAsync(user.Id, pageNum, pageSize);
            return Results.Ok(ApiResponse<List<MessageInboxDto>>.Success(data));
        });

        // 删除消息 - 约束 id 为 long
        userGroup.MapDelete("/{id:long}", static async (
            long id,
            IMessageService svc,
            CurrentUser user) =>
        {
            await svc.DeleteMessageAsync(user.Id, id);
            return Results.Ok(ApiResponse.Success("消息已从收件箱移除"));
        });

        // 标记单条已读
        userGroup.MapPost("/{id:long}/read", static async (
            long id,
            IMessageService svc,
            CurrentUser user) =>
        {
            await svc.MarkAsReadAsync(user.Id, id);
            return Results.Ok(ApiResponse.Success("已读"));
        });

        // 全部标记为已读
        userGroup.MapPost("/read-all", static async (
            IMessageService svc,
            CurrentUser user) =>
        {
            await svc.MarkAllAsReadAsync(user.Id);
            return Results.Ok(ApiResponse.Success("已清空未读"));
        });

        // --- 2. 管理员消息管理接口 (Base Path: /api/v1/admin/messages) ---
        var adminGroup = app.MapGroup("/api/v1/admin/messages")
            .RequireAuthorization(policy => policy.RequireRole("admin"));

        // 发布全站公告
        adminGroup.MapPost("/broadcast", static async (
            [FromBody] BroadcastRequest req,
            IMessageService svc) =>
        {
            if (string.IsNullOrWhiteSpace(req.Title))
                return Results.BadRequest(ApiResponse.Fail("标题不能为空"));

            await svc.PublishGlobalNoticeAsync(req.Title, req.Content);
            return Results.Ok(ApiResponse.Success("全站公告已实时分发"));
        });

        // 发送点对点私信
        adminGroup.MapPost("/direct", static async (
            [FromBody] AdminDirectMessageRequest req,
            IMessageService svc) =>
        {
            if (req.TargetUserId <= 0)
                return Results.BadRequest(ApiResponse.Fail("无效的目标用户"));
            if (string.IsNullOrWhiteSpace(req.Title))
                return Results.BadRequest(ApiResponse.Fail("标题不能为空"));

            await svc.SendPrivateNoticeAsync(req.TargetUserId, req.Title, req.Content);
            return Results.Ok(ApiResponse.Success("私信已送达"));
        });

        // 获取发送历史记录
        adminGroup.MapGet("/history", static async (
            [FromQuery] int page,
            [FromQuery] int size,
            IMessageService svc) =>
        {
            var pageSize = Math.Clamp(size, 1, 50);
            var data = await svc.GetAdminSentMessagesAsync(page, pageSize);
            return Results.Ok(ApiResponse<List<MessageInboxDto>>.Success(data));
        });

        // 管理员物理撤回（删除）
        adminGroup.MapDelete("/{id:long}", static async (
            long id,
            IMessageService svc) =>
        {
            await svc.RevokeMessageAsync(id);
            return Results.Ok(ApiResponse.Success("消息已成功撤回并从全端移除"));
        });

        return app;
    }
}

// 契约定义保持不变，确保序列化性能
public record BroadcastRequest(string Title, string Content);
public record AdminDirectMessageRequest(long TargetUserId, string Title, string Content);