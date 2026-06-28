using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
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
using FsusBlog.Server.Services.Distribution;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Outputs;
using SqlSugar;
using System.Buffers;
using System.Data.Common;

namespace FsusBlog.Server.Modules.Endpoints.Binary;

public static partial class BinaryEndpoints
{
    private const int ArticleListDefaultPage = 1;
    private const int ArticleListDefaultSize = 10;
    private const int ArticleListMaxSize = 100;

    private static void MapBinaryArticleEndpoints(IEndpointRouteBuilder group)
    {
        group.MapGet("/article/{articleId:int}/related.aeds", static async Task<BinaryFrameResult> (
            int articleId,
            RelatedReadingService service,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            RelatedReadingResponse? response = await service.BuildAsync(articleId, cancellationToken);
            return response is null
                ? BinaryResults.FromError(ErrorDetail.Create(ErrorCode.NotFound, "article_not_found"), aeds)
                : BinaryResults.Frame(aeds, AedsFrameType.ArticleRelatedReading, writer => PodBinaryCodec.WriteRelatedReading(response, writer));
        })
        .AllowAnonymous()
        .RequireRateLimiting("public_read")
        .AddEndpointFilter<RiskAwarePublicReadFilter>()
        .CacheOutput(static builder => builder
            .Expire(TimeSpan.FromMinutes(1))
            .Tag(CacheTag.ArticleList.ToOutputCacheTag()));

        group.MapGet("/admin/article", static async Task<IResult> (
            int? page,
            int? size,
            int? categoryId,
            int? tagId,
            string? keyword,
            bool? isDeleted,
            HttpContext httpContext,
            IArticleEndpointService articles,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            if (!TryBindArticleListPagination(page, size, out int pageValue, out int sizeValue, out ErrorDetail paginationError))
            {
                return BinaryResults.FromError(paginationError, aeds);
            }

            int? status = null;
            if (httpContext.Request.Query.TryGetValue("status", out var rawStatus))
            {
                string? statusValue = rawStatus.ToString();
                if (!int.TryParse(statusValue, out int parsedStatus))
                {
                    return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "文章发布状态参数非法"), aeds);
                }

                status = parsedStatus;
            }

            bool deleted = (isDeleted ?? false) || status == (int)ArticleStatus.Deleted;
            var payloadResult = await articles.GetPageListAsync(
                pageValue,
                sizeValue,
                categoryId,
                tagId,
                deleted,
                canReadDeleted: true,
                status,
                canReadPrivate: true,
                keyword: keyword,
                cancellationToken: cancellationToken);
            if (payloadResult.HasCachedFrame)
            {
                return BinaryResults.PreencodedFrame(payloadResult.CachedFrame);
            }

            return BinaryResults.FromResult(payloadResult.Result, aeds, AedsFrameType.ArticleList, static (value, writer) => PodBinaryCodec.WriteArticlePage(value, writer));
        })
        .RequireAdminPermission(AdminPermissions.ArticleWrite);

        group.MapGet("/admin/article/{id:int}", static async Task<IResult> (
            int id,
            IArticleEndpointService articles,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var result = await articles.GetByIdAsync(id, canReadPrivate: true, cancellationToken);
            if (!result.IsSuccess || result.Value is null)
            {
                return BinaryResults.FromError(result.Error.Code == ErrorCode.None
                    ? ErrorDetail.Create(ErrorCode.NotFound, "文章不存在")
                    : result.Error,
                    aeds);
            }

            var detail = result.Value.Value;
            return BinaryResults.Frame(aeds, AedsFrameType.ArticleDetail, writer => PodBinaryCodec.WriteArticleDetail(detail, writer));
        }).RequireAdminPermission(AdminPermissions.ArticleWrite);

        group.MapGet("/admin/article/hot", static async Task<IResult> (
            int? size,
            IArticleEndpointService articles,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            int count = Math.Clamp(size ?? 10, 1, 50);
            var payloadResult = await articles.GetHotArticlesAsync(count, cancellationToken);
            if (payloadResult.HasCachedFrame)
            {
                return BinaryResults.PreencodedFrame(payloadResult.CachedFrame);
            }

            return BinaryResults.FromResult(
                payloadResult.Result,
                aeds,
                AedsFrameType.ArticleHot,
                static (value, writer) => PodBinaryCodec.WritePopularArticles(value, writer),
                "热门文章数据为空");
        })
        .RequireAdminPermission(AdminPermissions.ArticleWrite);

        group.MapGet("/admin/article/featured", static async Task<BinaryFrameResult> (
            int? size,
            IArticleEndpointService articles,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            int count = Math.Clamp(size ?? 3, 1, 10);
            var result = await articles.GetFeaturedArticlesAsync(count, cancellationToken);
            if (!result.IsSuccess)
            {
                return BinaryResults.FromError(result.Error, aeds);
            }

            IReadOnlyList<FeaturedArticleSummaryDto> featured = result.Value ?? [];
            return BinaryResults.Frame(aeds, AedsFrameType.ArticleFeatured, writer => PodBinaryCodec.WriteFeaturedArticles(featured, writer));
        })
        .RequireAdminPermission(AdminPermissions.ArticleWrite);

        group.MapPost("/admin/article", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IArticleEndpointService articles,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var payload = await ReadBinaryRequestPayloadAsync(httpContext, aeds, AedsFrameType.ArticleWriteRequest, cancellationToken);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }

            if (!PodBinaryCodec.TryDecodeArticleWriteRequest(payload.Payload, out var request))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "文章写入请求体非法"), aeds);
            }

            int id = await articles.CreateAsync(request, cancellationToken);

            return id > 0
                ? BinaryResults.Frame(aeds, AedsFrameType.MutationId, writer => PodBinaryCodec.WriteMutationId(id, writer))
                : BinaryResults.FromError(ErrorDetail.Create(ErrorCode.InfraFailure, "发布失败：数据库操作异常"), aeds);
        })
        .RequireAdminPermission(AdminPermissions.ArticleWrite)
        .AddEndpointFilter<RequiresPowFilter>();

        group.MapPut("/admin/article/{id:int}", static async Task<BinaryFrameResult> (
            int id,
            HttpContext httpContext,
            IArticleEndpointService articles,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var payload = await ReadBinaryRequestPayloadAsync(httpContext, aeds, AedsFrameType.ArticleWriteRequest, cancellationToken);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }

            if (!PodBinaryCodec.TryDecodeArticleWriteRequest(payload.Payload, out var request))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "文章写入请求体非法"), aeds);
            }

            bool success = await articles.UpdateAsync(id, request, cancellationToken);

            return success
                ? BinaryResults.Frame(aeds, AedsFrameType.MutationId, writer => PodBinaryCodec.WriteMutationId(id, writer))
                : BinaryResults.FromError(ErrorDetail.Create(ErrorCode.InfraFailure, "更新失败：数据库操作异常"), aeds);
        })
        .RequireAdminPermission(AdminPermissions.ArticleWrite)
        .AddEndpointFilter<RequiresPowFilter>();

        group.MapDelete("/admin/article/trash", static async Task<BinaryFrameResult> (
            IArticleEndpointService articles,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            int count = await articles.ClearTrashAsync(cancellationToken);
            if (count < 0)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.InfraFailure, "清空回收站失败：数据库操作异常"), aeds);
            }

            using var _ = AuditLogScope.Push(
                AuditSourceCatalog.Article,
                AuditTypeCatalog.Audit,
                new KeyValuePair<string, object?>("AuditAction", "trash.clear"),
                new KeyValuePair<string, object?>("DestroyedCount", count));
            return BinaryResults.Frame(aeds, AedsFrameType.TrashClearResponse, writer => PodBinaryCodec.WriteTrashClearResponse(new TrashClearResponseDto(count), writer));
        })
        .RequireAdminPermission(AdminPermissions.ArticleWrite)
        .AddEndpointFilter<RequiresPowFilter>();

        group.MapDelete("/admin/article/{id:int}", static async Task<BinaryFrameResult> (
            int id,
            HttpContext httpContext,
            IArticleEndpointService articles,
            IAdminPrincipalService adminPrincipals,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var stepUp = await RequireAdminSensitiveStepUpAsync(httpContext, adminPrincipals);
            if (stepUp is not null)
            {
                return BinaryResults.FromError(stepUp.Value.Error, aeds, stepUp.Value.StatusCode);
            }

            bool success = await articles.DeleteAsync(id, cancellationToken);
            return success
                ? BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess)
                : BinaryResults.FromError(ErrorDetail.Create(ErrorCode.NotFound, "操作失败：资源不存在"), aeds);
        })
        .RequireAdminPermission(AdminPermissions.ArticleWrite)
        .RequireRateLimiting("fixed_ip")
        .AddEndpointFilter<RequiresPowFilter>();

        group.MapPut("/admin/article/restore/{id:int}", static async Task<BinaryFrameResult> (
            int id,
            HttpContext httpContext,
            IArticleEndpointService articles,
            IAdminPrincipalService adminPrincipals,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var stepUp = await RequireAdminSensitiveStepUpAsync(httpContext, adminPrincipals);
            if (stepUp is not null)
            {
                return BinaryResults.FromError(stepUp.Value.Error, aeds, stepUp.Value.StatusCode);
            }

            bool success = await articles.RestoreAsync(id, cancellationToken);
            return success
                ? BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess)
                : BinaryResults.FromError(ErrorDetail.Create(ErrorCode.NotFound, "恢复失败：资源不存在"), aeds);
        })
        .RequireAdminPermission(AdminPermissions.ArticleWrite)
        .RequireRateLimiting("fixed_ip")
        .AddEndpointFilter<RequiresPowFilter>();

        group.MapDelete("/admin/article/permanent/{id:int}", static async Task<BinaryFrameResult> (
            int id,
            HttpContext httpContext,
            IArticleEndpointService articles,
            IAdminPrincipalService adminPrincipals,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var stepUp = await RequireAdminSensitiveStepUpAsync(httpContext, adminPrincipals);
            if (stepUp is not null)
            {
                return BinaryResults.FromError(stepUp.Value.Error, aeds, stepUp.Value.StatusCode);
            }

            bool success = await articles.PermanentlyDeleteArticleAsync(id, cancellationToken);
            return success
                ? BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess)
                : BinaryResults.FromError(ErrorDetail.Create(ErrorCode.NotFound, "操作失败：资源不存在"), aeds);
        })
        .RequireAdminPermission(AdminPermissions.ArticleWrite)
        .RequireRateLimiting("fixed_ip")
        .AddEndpointFilter<RequiresPowFilter>();
    }

    private static bool TryBindArticleListPagination(
        int? page,
        int? size,
        out int pageValue,
        out int sizeValue,
        out ErrorDetail error)
    {
        pageValue = page ?? ArticleListDefaultPage;
        sizeValue = size ?? ArticleListDefaultSize;
        if (pageValue < 1)
        {
            error = ErrorDetail.Create(ErrorCode.Validation, "分页页码参数非法");
            return false;
        }

        if (sizeValue < 1 || sizeValue > ArticleListMaxSize)
        {
            error = ErrorDetail.Create(ErrorCode.Validation, "分页大小参数非法");
            return false;
        }

        error = ErrorDetail.None;
        return true;
    }
}
