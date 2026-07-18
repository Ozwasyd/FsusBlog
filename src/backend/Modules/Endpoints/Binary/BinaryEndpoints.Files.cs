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
    private static void MapBinaryFileEndpoints(IEndpointRouteBuilder group)
    {
        group.MapDelete("/file/delete", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IFileService fileService,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var payload = await ReadBinaryRequestPayloadAsync(httpContext, aeds, AedsFrameType.FileDeleteRequest, cancellationToken);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }

            if (!PodBinaryCodec.TryDecodeStringMutationRequest(payload.Payload, out string url) ||
                string.IsNullOrWhiteSpace(url))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "参数不能为空"), aeds);
            }

            if (!TryNormalizeImageDeletePath(url, out string ioRelativePath, out string? errorMessage))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, errorMessage ?? "非法路径请求"), aeds);
            }

            bool success = await fileService.DeleteImageAsync(ioRelativePath);
            return success
                ? BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess)
                : BinaryResults.FromError(ErrorDetail.Create(ErrorCode.NotFound, "文件不存在或已被移除"), aeds);
        })
        .RequireAdminPermission(AdminPermissions.ArticleWrite)
        .AddEndpointFilter<RequiresPowFilter>();
    }
}
