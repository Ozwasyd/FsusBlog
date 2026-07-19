using System.Buffers;
using System.Data.Common;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Helpers.Security;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Outputs;

using SqlSugar;

namespace FsusBlog.Server.Modules.Endpoints.Binary;

public static partial class BinaryEndpoints
{
    private static void MapBinaryMessageEndpoints(IEndpointRouteBuilder group)
    {
        group.MapGet("/messages/conversations", static async Task<BinaryFrameResult> (
            int size,
            string? filter,
            string? cursor,
            IMessageQueryService query,
            AccountPrincipalContext account,
            IConfiguration configuration,
            IAedsEncoder aeds) =>
        {
            if (!IsMessageCursorPaginationEnabled(configuration))
            {
                return BinaryResults.FromError(
                    ErrorDetail.Create(ErrorCode.InfraFailure, "message_cursor_pagination_disabled"),
                    aeds,
                    StatusCodes.Status503ServiceUnavailable);
            }
            MessageConversationCursor? position = null;
            if (!string.IsNullOrWhiteSpace(cursor))
            {
                if (!MessageConversationCursor.TryDecode(cursor, out MessageConversationCursor decoded))
                {
                    return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "会话游标非法"), aeds);
                }

                position = decoded;
            }

            int pageSize = Math.Clamp(size <= 0 ? 20 : size, 1, 50);
            var data = await query.GetAccountConversationsAsync(account.AccountId, pageSize, filter, position);
            return BinaryResults.Frame(aeds, AedsFrameType.ConversationList, writer => PodBinaryCodec.WriteConversationList(data, writer));
        })
        .RequireAnonymousAccountPrincipal();

        group.MapGet("/messages/conversations/{id:long}", static async Task<BinaryFrameResult> (
            long id,
            long? beforeMessageId,
            IMessageQueryService query,
            AccountPrincipalContext account,
            IConfiguration configuration,
            IAedsEncoder aeds) =>
        {
            if (!IsMessageThreadPaginationEnabled(configuration))
            {
                return BinaryResults.FromError(
                    ErrorDetail.Create(ErrorCode.InfraFailure, "message_thread_pagination_disabled"),
                    aeds,
                    StatusCodes.Status503ServiceUnavailable);
            }
            if (beforeMessageId <= 0)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "消息游标非法"), aeds);
            }

            var detail = await query.GetAccountConversationDetailAsync(account.AccountId, id, beforeMessageId);
            return detail is null
                ? BinaryResults.FromError(ErrorDetail.Create(ErrorCode.NotFound, "会话不存在"), aeds)
                : BinaryResults.Frame(aeds, AedsFrameType.ConversationDetailV3, writer => PodBinaryCodec.WriteConversationDetailV3(detail, writer));
        })
        .RequireAnonymousAccountPrincipal();

        group.MapPost("/messages/conversations", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IMessageCommandService command,
            AccountPrincipalContext account,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var payload = await ReadBinaryRequestPayloadAsync(httpContext, aeds, AedsFrameType.ConversationCreateRequest, cancellationToken);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }

            if (!PodBinaryCodec.TryDecodeConversationCreateRequest(payload.Payload, out var request))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "会话请求体非法"), aeds);
            }

            var result = await command.CreateAccountTicketAsync(account.AccountId, request.Subject, request.Body);
            return result.IsSuccess
                ? BinaryResults.Frame(aeds, AedsFrameType.ConversationDetailV2, writer => PodBinaryCodec.WriteConversationDetailV2(result.Value!, writer))
                : BinaryResults.FromError(result.Error, aeds);
        })
        .RequireAnonymousAccountPrincipal()
        .AddEndpointFilter<RequiresPowFilter>();

        group.MapPost("/messages/conversations/{id:long}/reply", static async Task<BinaryFrameResult> (
            long id,
            HttpContext httpContext,
            IMessageCommandService command,
            AccountPrincipalContext account,
            IConfiguration configuration,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            if (!IsMessageReplyWritesEnabled(configuration))
            {
                return BinaryResults.FromError(
                    ErrorDetail.Create(ErrorCode.InfraFailure, "message_reply_writes_disabled"),
                    aeds,
                    StatusCodes.Status503ServiceUnavailable);
            }

            if (!IsPreciseMessageReadCursorEnabled(configuration))
            {
                return BinaryResults.FromError(
                    ErrorDetail.Create(ErrorCode.InfraFailure, "message_read_cursor_disabled"),
                    aeds,
                    StatusCodes.Status503ServiceUnavailable);
            }

            var payload = await ReadBinaryRequestPayloadAsync(httpContext, aeds, AedsFrameType.AccountConversationReplyRequest, cancellationToken);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }

            if (!PodBinaryCodec.TryDecodeAccountConversationReplyRequest(payload.Payload, out var request))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "回复请求体非法"), aeds);
            }

            var result = await command.ReplyAsAccountAsync(account.AccountId, id, request.ReadThroughMessageId, request.Body);
            return result.IsSuccess
                ? BinaryResults.Frame(aeds, AedsFrameType.ConversationMessage, writer => PodBinaryCodec.WriteConversationMessage(result.Value!, writer))
                : BinaryResults.FromError(result.Error, aeds);
        })
        .RequireAnonymousAccountPrincipal()
        .AddEndpointFilter<RequiresPowFilter>();

        group.MapPost("/messages/conversations/{id:long}/read", static async Task<BinaryFrameResult> (
            long id,
            HttpContext httpContext,
            IMessageCommandService command,
            AccountPrincipalContext account,
            IConfiguration configuration,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            if (!IsPreciseMessageReadCursorEnabled(configuration))
            {
                return BinaryResults.FromError(
                    ErrorDetail.Create(ErrorCode.InfraFailure, "message_read_cursor_disabled"),
                    aeds,
                    StatusCodes.Status503ServiceUnavailable);
            }

            var payload = await ReadBinaryRequestPayloadAsync(httpContext, aeds, AedsFrameType.ConversationReadRequest, cancellationToken);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }

            if (!PodBinaryCodec.TryDecodeConversationReadRequest(payload.Payload, out var request))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "已读请求体非法"), aeds);
            }

            var result = await command.MarkConversationReadAsync(account.AccountId, id, request.ReadThroughMessageId);
            return result.IsSuccess
                ? BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess)
                : BinaryResults.FromError(result.Error, aeds);
        })
        .RequireAnonymousAccountPrincipal();

        group.MapGet("/admin/messages/conversations", static async Task<BinaryFrameResult> (
            int size,
            string? filter,
            string? cursor,
            IMessageQueryService query,
            IConfiguration configuration,
            IAedsEncoder aeds) =>
        {
            if (!IsMessageCursorPaginationEnabled(configuration))
            {
                return BinaryResults.FromError(
                    ErrorDetail.Create(ErrorCode.InfraFailure, "message_cursor_pagination_disabled"),
                    aeds,
                    StatusCodes.Status503ServiceUnavailable);
            }
            if (!IsAdminQueueProjectionEnabled(configuration))
            {
                return BinaryResults.FromError(
                    ErrorDetail.Create(ErrorCode.InfraFailure, "message_admin_queue_projection_disabled"),
                    aeds,
                    StatusCodes.Status503ServiceUnavailable);
            }

            MessageConversationCursor? position = null;
            if (!string.IsNullOrWhiteSpace(cursor))
            {
                if (!MessageConversationCursor.TryDecode(cursor, out MessageConversationCursor decoded))
                {
                    return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "会话游标非法"), aeds);
                }

                position = decoded;
            }

            int pageSize = Math.Clamp(size <= 0 ? 20 : size, 1, 100);
            var data = await query.GetAdminConversationsAsync(pageSize, filter, position);
            return BinaryResults.Frame(aeds, AedsFrameType.ConversationList, writer => PodBinaryCodec.WriteConversationList(data, writer));
        })
        .RequireAdminPermission(AdminPermissions.AdminManage);

        group.MapGet("/admin/messages/conversations/{id:long}", static async Task<BinaryFrameResult> (
            long id,
            long? beforeMessageId,
            IMessageQueryService query,
            IConfiguration configuration,
            IAedsEncoder aeds) =>
        {
            if (!IsMessageThreadPaginationEnabled(configuration))
            {
                return BinaryResults.FromError(
                    ErrorDetail.Create(ErrorCode.InfraFailure, "message_thread_pagination_disabled"),
                    aeds,
                    StatusCodes.Status503ServiceUnavailable);
            }
            if (!IsAdminQueueProjectionEnabled(configuration))
            {
                return BinaryResults.FromError(
                    ErrorDetail.Create(ErrorCode.InfraFailure, "message_admin_queue_projection_disabled"),
                    aeds,
                    StatusCodes.Status503ServiceUnavailable);
            }

            if (beforeMessageId <= 0)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "消息游标非法"), aeds);
            }

            var detail = await query.GetAdminConversationDetailAsync(id, beforeMessageId);
            return detail is null
                ? BinaryResults.FromError(ErrorDetail.Create(ErrorCode.NotFound, "会话不存在"), aeds)
                : BinaryResults.Frame(aeds, AedsFrameType.ConversationDetailV3, writer => PodBinaryCodec.WriteConversationDetailV3(detail, writer));
        })
        .RequireAdminPermission(AdminPermissions.AdminManage);

        group.MapPost("/admin/messages/conversations/{id:long}/reply", static async Task<BinaryFrameResult> (
            long id,
            HttpContext httpContext,
            IMessageCommandService command,
            IConfiguration configuration,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            if (!IsMessageReplyWritesEnabled(configuration))
            {
                return BinaryResults.FromError(
                    ErrorDetail.Create(ErrorCode.InfraFailure, "message_reply_writes_disabled"),
                    aeds,
                    StatusCodes.Status503ServiceUnavailable);
            }

            if (!TryResolveAdminMessageActor(httpContext, out AdminMessageActor adminActor))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Unauthorized, "admin_session_missing"), aeds, StatusCodes.Status401Unauthorized);
            }

            var payload = await ReadBinaryRequestPayloadAsync(httpContext, aeds, AedsFrameType.ConversationReplyRequest, cancellationToken);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }

            if (!PodBinaryCodec.TryDecodeStringMutationRequest(payload.Payload, out string body))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "回复请求体非法"), aeds);
            }

            var result = await command.ReplyAsAdminAsync(id, body, adminActor);
            return result.IsSuccess
                ? BinaryResults.Frame(aeds, AedsFrameType.ConversationMessage, writer => PodBinaryCodec.WriteConversationMessage(result.Value!, writer))
                : BinaryResults.FromError(result.Error, aeds);
        })
        .RequireAdminPermission(AdminPermissions.AdminManage)
        .AddEndpointFilter<RequiresPowFilter>();

        group.MapPost("/admin/messages/conversations/{id:long}/status", static async Task<BinaryFrameResult> (
            long id,
            HttpContext httpContext,
            IMessageCommandService command,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            if (!TryResolveAdminMessageActor(httpContext, out AdminMessageActor adminActor))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Unauthorized, "admin_session_missing"), aeds, StatusCodes.Status401Unauthorized);
            }

            var payload = await ReadBinaryRequestPayloadAsync(httpContext, aeds, AedsFrameType.ConversationStatusRequest, cancellationToken);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }

            if (!PodBinaryCodec.TryDecodeConversationStatusRequest(payload.Payload, out ConversationStatusValue status))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "无效状态，仅支持 open/pending/closed"), aeds);
            }

            var result = await command.UpdateConversationStatusAsync(id, status, adminActor);
            return result.IsSuccess
                ? BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess)
                : BinaryResults.FromError(result.Error, aeds);
        })
        .RequireAdminPermission(AdminPermissions.AdminManage)
        .AddEndpointFilter<RequiresPowFilter>();

        group.MapPost("/admin/messages/system-send", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IMessageCommandService command,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            if (!TryResolveAdminMessageActor(httpContext, out AdminMessageActor adminActor))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Unauthorized, "admin_session_missing"), aeds, StatusCodes.Status401Unauthorized);
            }

            var payload = await ReadBinaryRequestPayloadAsync(httpContext, aeds, AedsFrameType.SystemMessageRequest, cancellationToken);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }

            if (!PodBinaryCodec.TryDecodeSystemMessageRequest(payload.Payload, out var request))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "系统消息请求体非法"), aeds);
            }

            if (!IsValidSystemMessageTarget(request.TargetAccountId))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "系统消息必须指定目标账号"), aeds);
            }

            var result = await command.SendSystemMessageAsync(request.Subject, request.Body, request.TargetAccountId, adminActor);
            return result.IsSuccess
                ? BinaryResults.Frame(aeds, AedsFrameType.ConversationDetailV2, writer => PodBinaryCodec.WriteConversationDetailV2(result.Value!, writer))
                : BinaryResults.FromError(result.Error, aeds);
        })
        .RequireAdminPermission(AdminPermissions.AdminManage)
        .AddEndpointFilter<RequiresPowFilter>();
    }

    private static bool TryResolveAdminMessageActor(HttpContext httpContext, out AdminMessageActor adminActor)
    {
        if (TryResolveAdminSessionContext(httpContext, out long adminPrincipalId, out string adminSessionId))
        {
            adminActor = new AdminMessageActor(adminPrincipalId, adminSessionId);
            return true;
        }

        adminActor = default;
        return false;
    }

    private static bool IsPreciseMessageReadCursorEnabled(IConfiguration configuration)
        => configuration.GetValue<bool?>("Messages:PreciseReadCursorEnabled") ?? true;

    private static bool IsMessageCursorPaginationEnabled(IConfiguration configuration)
        => configuration.GetValue<bool?>("Messages:CursorPaginationEnabled") ?? true;

    private static bool IsMessageThreadPaginationEnabled(IConfiguration configuration)
        => configuration.GetValue<bool?>("Messages:ThreadPaginationEnabled") ?? true;

    private static bool IsAdminQueueProjectionEnabled(IConfiguration configuration)
        => configuration.GetValue<bool?>("Messages:AdminQueueProjectionEnabled") ?? true;

    private static bool IsMessageReplyWritesEnabled(IConfiguration configuration)
        => configuration.GetValue<bool?>("Messages:ReplyWritesEnabled") ?? true;
}
