using System.Buffers;
using System.Data.Common;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Server.Contracts.Assets;
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
    private static void MapBinaryFileEndpoints(IEndpointRouteBuilder group)
    {
        group.MapDelete("/file/delete", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IAssetStore assetStore,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
            await HandleFileDeleteAsync(httpContext, assetStore, aeds, cancellationToken))
        .RequireAdminPermission(AdminPermissions.ArticleWrite)
        .AddEndpointFilterWithMetadata<RequiresPowFilter>();
    }

    internal static async Task<BinaryFrameResult> HandleFileDeleteAsync(
        HttpContext httpContext,
        IAssetStore assetStore,
        IAedsEncoder aeds,
        CancellationToken cancellationToken)
    {
        using BinaryRequestPayload payload = await ReadBinaryRequestPayloadAsync(
            httpContext,
            aeds,
            AedsFrameType.FileDeleteRequest,
            cancellationToken);
        if (!payload.IsSuccess)
        {
            return BinaryResults.FromError(payload.Error, aeds);
        }

        if (!PodBinaryCodec.TryDecodeStringMutationRequest(payload.Payload, out string rawAssetId)
            || !AssetId.TryParse(rawAssetId, out AssetId assetId))
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "资产标识非法"), aeds);
        }

        AssetDeleteOutcome outcome = await assetStore.DeleteAsync(assetId, cancellationToken);
        if (outcome.Result == AssetDeleteResult.Referenced)
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Conflict, "资产仍被引用，无法删除"), aeds);
        }

        return outcome.Result == AssetDeleteResult.Deleted
            ? BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess)
            : BinaryResults.FromError(ErrorDetail.Create(ErrorCode.NotFound, "文件不存在或已被移除"), aeds);
    }
}
