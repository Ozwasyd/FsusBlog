using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Helpers.Security;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Outputs;
using SqlSugar;
using System.Buffers;
using System.Data.Common;

namespace FsusBlog.Server.Modules.Endpoints.Binary;

public static partial class BinaryEndpoints
{
    private static void MapBinaryMessageEndpoints(IEndpointRouteBuilder group)
    {
        group.MapGet("/messages/conversations", static async Task<BinaryFrameResult> (
            int page,
            int size,
            string? filter,
            IMessageQueryService query,
            CurrentUser user,
            IAedsEncoder aeds) =>
        {
            int pageSize = Math.Clamp(size <= 0 ? 20 : size, 1, 50);
            int pageNum = Math.Max(1, page);
            var data = await query.GetUserConversationsAsync(checked((int)user.Id), pageNum, pageSize, filter);
            return BinaryResults.Frame(aeds, AedsFrameType.ConversationList, writer => PodBinaryCodec.WriteConversationList(data, writer));
        })
        .RequireAuthorization();

        group.MapGet("/messages/conversations/{id:long}", static async Task<BinaryFrameResult> (
            long id,
            IMessageQueryService query,
            CurrentUser user,
            IAedsEncoder aeds) =>
        {
            var detail = await query.GetUserConversationDetailAsync(checked((int)user.Id), id);
            return detail is null
                ? BinaryResults.FromError(ErrorDetail.Create(ErrorCode.NotFound, "会话不存在"), aeds)
                : BinaryResults.Frame(aeds, AedsFrameType.ConversationDetail, writer => PodBinaryCodec.WriteConversationDetail(detail, writer));
        })
        .RequireAuthorization();

        group.MapPost("/messages/conversations", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IMessageCommandService command,
            CurrentUser user,
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

            var result = await command.CreateUserTicketAsync(checked((int)user.Id), request.Subject, request.Body);
            return result.IsSuccess
                ? BinaryResults.Frame(aeds, AedsFrameType.ConversationDetail, writer => PodBinaryCodec.WriteConversationDetail(result.Value!, writer))
                : BinaryResults.FromError(result.Error, aeds);
        })
        .RequireAuthorization()
        .AddEndpointFilter<RequiresPowFilter>();

        group.MapPost("/messages/conversations/{id:long}/reply", static async Task<BinaryFrameResult> (
            long id,
            HttpContext httpContext,
            IMessageCommandService command,
            CurrentUser user,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var payload = await ReadBinaryRequestPayloadAsync(httpContext, aeds, AedsFrameType.ConversationReplyRequest, cancellationToken);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }

            if (!PodBinaryCodec.TryDecodeStringMutationRequest(payload.Payload, out string body))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "回复请求体非法"), aeds);
            }

            var result = await command.ReplyAsUserAsync(checked((int)user.Id), id, body);
            return result.IsSuccess
                ? BinaryResults.Frame(aeds, AedsFrameType.ConversationMessage, writer => PodBinaryCodec.WriteConversationMessage(result.Value!, writer))
                : BinaryResults.FromError(result.Error, aeds);
        })
        .RequireAuthorization()
        .AddEndpointFilter<RequiresPowFilter>();

        group.MapPost("/messages/conversations/{id:long}/read", static async Task<BinaryFrameResult> (
            long id,
            IMessageCommandService command,
            CurrentUser user,
            IAedsEncoder aeds) =>
        {
            var result = await command.MarkConversationReadAsync(checked((int)user.Id), id);
            return result.IsSuccess
                ? BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess)
                : BinaryResults.FromError(result.Error, aeds);
        })
        .RequireAuthorization();

        group.MapGet("/admin/messages/conversations", static async Task<BinaryFrameResult> (
            int page,
            int size,
            string? filter,
            IMessageQueryService query,
            IAedsEncoder aeds) =>
        {
            int pageSize = Math.Clamp(size <= 0 ? 20 : size, 1, 100);
            int pageNum = Math.Max(1, page);
            var data = await query.GetAdminConversationsAsync(pageNum, pageSize, filter);
            return BinaryResults.Frame(aeds, AedsFrameType.ConversationList, writer => PodBinaryCodec.WriteConversationList(data, writer));
        })
        .RequireAdminPermission(AdminPermissions.AdminManage);

        group.MapGet("/admin/messages/conversations/{id:long}", static async Task<BinaryFrameResult> (
            long id,
            IMessageQueryService query,
            IAedsEncoder aeds) =>
        {
            var detail = await query.GetAdminConversationDetailAsync(id);
            return detail is null
                ? BinaryResults.FromError(ErrorDetail.Create(ErrorCode.NotFound, "会话不存在"), aeds)
                : BinaryResults.Frame(aeds, AedsFrameType.ConversationDetail, writer => PodBinaryCodec.WriteConversationDetail(detail, writer));
        })
        .RequireAdminPermission(AdminPermissions.AdminManage);

        group.MapPost("/admin/messages/conversations/{id:long}/reply", static async Task<BinaryFrameResult> (
            long id,
            HttpContext httpContext,
            IMessageCommandService command,
            CurrentUser user,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var payload = await ReadBinaryRequestPayloadAsync(httpContext, aeds, AedsFrameType.ConversationReplyRequest, cancellationToken);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }

            if (!PodBinaryCodec.TryDecodeStringMutationRequest(payload.Payload, out string body))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "回复请求体非法"), aeds);
            }

            var result = await command.ReplyAsAdminAsync(id, body, checked((int)user.Id));
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
            CurrentUser user,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var payload = await ReadBinaryRequestPayloadAsync(httpContext, aeds, AedsFrameType.ConversationStatusRequest, cancellationToken);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }

            if (!PodBinaryCodec.TryDecodeConversationStatusRequest(payload.Payload, out ConversationStatusValue status))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "无效状态，仅支持 open/pending/closed"), aeds);
            }

            var result = await command.UpdateConversationStatusAsync(id, status, checked((int)user.Id));
            return result.IsSuccess
                ? BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess)
                : BinaryResults.FromError(result.Error, aeds);
        })
        .RequireAdminPermission(AdminPermissions.AdminManage)
        .AddEndpointFilter<RequiresPowFilter>();

        group.MapPost("/admin/messages/system-send", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IMessageCommandService command,
            CurrentUser user,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var payload = await ReadBinaryRequestPayloadAsync(httpContext, aeds, AedsFrameType.SystemMessageRequest, cancellationToken);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }

            if (!PodBinaryCodec.TryDecodeSystemMessageRequest(payload.Payload, out var request))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "系统消息请求体非法"), aeds);
            }

            if (!request.TargetUserId.HasValue || request.TargetUserId.Value <= 0)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "系统消息必须指定目标用户"), aeds);
            }

            var result = await command.SendSystemMessageAsync(request.Subject, request.Body, request.TargetUserId, checked((int)user.Id));
            return result.IsSuccess
                ? BinaryResults.Frame(aeds, AedsFrameType.ConversationDetail, writer => PodBinaryCodec.WriteConversationDetail(result.Value!, writer))
                : BinaryResults.FromError(result.Error, aeds);
        })
        .RequireAdminPermission(AdminPermissions.AdminManage)
        .AddEndpointFilter<RequiresPowFilter>();
    }
}
