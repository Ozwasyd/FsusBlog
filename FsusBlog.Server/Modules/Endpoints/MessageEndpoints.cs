using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Modules.Endpoints;

public static class MessageEndpoints
{
    public static IEndpointRouteBuilder MapMessageEndpoints(this IEndpointRouteBuilder app)
    {
        var userGroup = app.MapGroup("/api/v1/messages").RequireAuthorization();

        userGroup.MapGet("/conversations", static async Task<IResult> (
            int page,
            int size,
            string? filter,
            IMessageQueryService query,
            CurrentUser user) =>
        {
            int pageSize = Math.Clamp(size <= 0 ? 20 : size, 1, 50);
            int pageNum = Math.Max(1, page);
            var data = await query.GetUserConversationsAsync(checked((int)user.Id), pageNum, pageSize, filter);
            return ApiResults.Ok(data);
        });

        userGroup.MapGet("/conversations/{id:long}", static async Task<IResult> (
            long id,
            IMessageQueryService query,
            CurrentUser user) =>
        {
            var detail = await query.GetUserConversationDetailAsync(checked((int)user.Id), id);
            return detail is null ? ApiResults.NotFound("会话不存在") : ApiResults.Ok(detail);
        });

        userGroup.MapPost("/conversations", static async Task<IResult> (
            CreateConversationRequest req,
            IMessageCommandService command,
            CurrentUser user) =>
        {
            var result = await command.CreateUserTicketAsync(checked((int)user.Id), req.Subject, req.Body);
            return ApiResults.FromResult(result);
        }).AddEndpointFilter<RequiresPowFilter>();

        userGroup.MapPost("/conversations/{id:long}/reply", static async Task<IResult> (
            long id,
            ReplyConversationRequest req,
            IMessageCommandService command,
            CurrentUser user) =>
        {
            var result = await command.ReplyAsUserAsync(checked((int)user.Id), id, req.Body);
            return ApiResults.FromResult(result);
        }).AddEndpointFilter<RequiresPowFilter>();

        userGroup.MapPost("/conversations/{id:long}/read", static async Task<IResult> (
            long id,
            IMessageCommandService command,
            CurrentUser user) =>
        {
            var result = await command.MarkConversationReadAsync(checked((int)user.Id), id);
            return ApiResults.FromResult(result, "ok");
        });

        var adminGroup = app.MapGroup("/api/v1/admin/messages")
            .RequireAuthorization(policy => policy.RequireRole("admin"));

        adminGroup.MapGet("/conversations", static async Task<IResult> (
            int page,
            int size,
            string? filter,
            IMessageQueryService query) =>
        {
            int pageSize = Math.Clamp(size <= 0 ? 20 : size, 1, 100);
            int pageNum = Math.Max(1, page);
            var data = await query.GetAdminConversationsAsync(pageNum, pageSize, filter);
            return ApiResults.Ok(data);
        });

        adminGroup.MapGet("/conversations/{id:long}", static async Task<IResult> (
            long id,
            IMessageQueryService query) =>
        {
            var detail = await query.GetAdminConversationDetailAsync(id);
            return detail is null ? ApiResults.NotFound("会话不存在") : ApiResults.Ok(detail);
        });

        adminGroup.MapPost("/conversations/{id:long}/reply", static async Task<IResult> (
            long id,
            ReplyConversationRequest req,
            IMessageCommandService command,
            CurrentUser user) =>
        {
            var result = await command.ReplyAsAdminAsync(id, req.Body, checked((int)user.Id));
            return ApiResults.FromResult(result);
        }).AddEndpointFilter<RequiresPowFilter>();

        adminGroup.MapPost("/conversations/{id:long}/status", static async Task<IResult> (
            long id,
            AdminConversationStatusRequest req,
            IMessageCommandService command,
            CurrentUser user) =>
        {
            if (!TryParseStatus(req.Status, out ConversationStatusValue status))
            {
                return ApiResults.BadRequest("无效状态，仅支持 open/pending/closed");
            }

            var result = await command.UpdateConversationStatusAsync(id, status, checked((int)user.Id));
            return ApiResults.FromResult(result, "ok");
        }).AddEndpointFilter<RequiresPowFilter>();

        adminGroup.MapPost("/system-send", static async Task<IResult> (
            SendSystemMessageRequest req,
            IMessageCommandService command,
            CurrentUser user) =>
        {
            var result = await command.SendSystemMessageAsync(req.Subject, req.Body, req.TargetUserId, checked((int)user.Id));
            return ApiResults.FromResult(result);
        }).AddEndpointFilter<RequiresPowFilter>();

        return app;
    }

    private static bool TryParseStatus(string? raw, out ConversationStatusValue status)
    {
        status = ConversationStatusValue.Open;
        if (string.IsNullOrWhiteSpace(raw))
        {
            return false;
        }

        return raw.Trim().ToLowerInvariant() switch
        {
            "open" => true,
            "pending" => (status = ConversationStatusValue.Pending) == ConversationStatusValue.Pending,
            "closed" => (status = ConversationStatusValue.Closed) == ConversationStatusValue.Closed,
            _ => false
        };
    }
}
