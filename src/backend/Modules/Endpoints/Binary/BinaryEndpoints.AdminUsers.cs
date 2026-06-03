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
    private static void MapBinaryAdminUserEndpoints(IEndpointRouteBuilder group)
    {
        group.MapGet("/admin/users", static async Task<BinaryFrameResult> (
            int? page,
            int? pageSize,
            string? keyword,
            int? status,
            IUserCoreService core,
            IAedsEncoder aeds) =>
        {
            int pageValue = Math.Max(page ?? 1, 1);
            int sizeValue = Math.Clamp(pageSize ?? 10, 1, 100);
            var result = await core.GetAdminUserListAsync(pageValue, sizeValue, keyword, status);
            return BinaryResults.FromResult(result, aeds, AedsFrameType.AdminUserList, static (value, writer) => PodBinaryCodec.WriteAdminUserPage(value, writer));
        })
        .RequireAuthorization(policy => policy.RequireRole("admin"));

        group.MapPut("/admin/users/status", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IUserService userService,
            IAuditEventService auditEvents,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var payload = await ReadBinaryRequestPayloadAsync(httpContext, aeds, AedsFrameType.AdminChangeUserStatusRequest, cancellationToken);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }

            if (!PodBinaryCodec.TryDecodeAdminChangeUserStatusRequest(payload.Payload, out var request))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "用户状态变更请求体非法"), aeds);
            }

            if (request.Status is not 0 and not 1)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "用户状态变更仅允许封禁或解封"), aeds);
            }

            var (success, message) = await userService.AdminChangeStatusAsync(new AdminChangeStatusDto
            {
                UserId = request.UserId,
                Status = request.Status,
                Reason = request.Reason
            });

            await auditEvents.RecordHighValueAsync(new AuditEvent(
                AuditSourceCatalog.Admin,
                AuditTypeCatalog.Security,
                AuditActionCatalog.UserStatusChanged,
                success ? AuditOutcomeCatalog.Success : AuditOutcomeCatalog.Failure,
                success ? AuditSeverityCatalog.Warning : AuditSeverityCatalog.Error,
                "管理员变更用户状态",
                TargetType: "user",
                TargetId: request.UserId.ToString(System.Globalization.CultureInfo.InvariantCulture),
                ReasonCode: request.Reason,
                Context: new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["status"] = request.Status,
                    ["message"] = message
                }), cancellationToken);

            return success
                ? BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess)
                : BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, message), aeds);
        })
        .RequireAuthorization(policy => policy.RequireRole("admin"))
        .AddEndpointFilter<RequiresPowFilter>();

        group.MapPost("/admin/users/reset-pwd", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IUserService userService,
            IAuditEventService auditEvents,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var payload = await ReadBinaryRequestPayloadAsync(httpContext, aeds, AedsFrameType.AdminResetUserPasswordRequest, cancellationToken);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }

            if (!PodBinaryCodec.TryDecodeAdminResetUserPasswordRequest(payload.Payload, out var request))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "用户密码重置请求体非法"), aeds);
            }

            var (success, message) = await userService.AdminResetPasswordAsync(new AdminResetPwdDto
            {
                UserId = request.UserId,
                NewPassword = request.NewPassword
            });

            await auditEvents.RecordHighValueAsync(new AuditEvent(
                AuditSourceCatalog.Admin,
                AuditTypeCatalog.Security,
                AuditActionCatalog.UserPasswordReset,
                success ? AuditOutcomeCatalog.Success : AuditOutcomeCatalog.Failure,
                success ? AuditSeverityCatalog.Critical : AuditSeverityCatalog.Error,
                "管理员强制重置用户密码",
                TargetType: "user",
                TargetId: request.UserId.ToString(System.Globalization.CultureInfo.InvariantCulture),
                Context: new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["message"] = message
                }), cancellationToken);

            return success
                ? BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess)
                : BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, message), aeds);
        })
        .RequireAuthorization(policy => policy.RequireRole("admin"))
        .AddEndpointFilter<RequiresPowFilter>();
    }
}
