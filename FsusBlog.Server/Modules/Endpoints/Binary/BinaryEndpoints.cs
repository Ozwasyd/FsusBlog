using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Models.Responses;
using Microsoft.AspNetCore.Http.HttpResults;

namespace FsusBlog.Server.Modules.Endpoints.Binary;

public static class BinaryEndpoints
{
    private const string BinaryContentType = "application/octet-stream";

    public static void MapBinaryEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("api/binary").WithTags("Binary-POD");

        group.MapGet("/article", static async Task<Results<FileContentHttpResult, JsonHttpResult<ApiResponse>>> (
            int? page,
            int? size,
            int? categoryId,
            int? tagId,
            bool? isDeleted,
            HttpContext httpContext,
            IArticleCoreService core,
            IAedsEncoder aeds) =>
        {
            int pageValue = Math.Max(page ?? 1, 1);
            int sizeValue = Math.Clamp(size ?? 10, 1, 100);
            bool deleted = isDeleted ?? false;
            if (deleted && (httpContext.User.Identity?.IsAuthenticated != true || !httpContext.User.IsInRole("admin")))
            {
                return ToErrorResult(new ErrorDetail(ErrorCode.Forbidden, "权限不足"));
            }

            var result = await core.GetPageListAsync(pageValue, sizeValue, categoryId, tagId, deleted);
            return ToBinaryResult(result, aeds, AedsFrameType.ArticleList, static value => PodBinaryCodec.EncodeArticlePage(value));
        }).AllowAnonymous();

        group.MapGet("/article/{id:int}", static async Task<Results<FileContentHttpResult, JsonHttpResult<ApiResponse>>> (
            int id,
            IArticleCoreService core,
            IAedsEncoder aeds) =>
        {
            var result = await core.GetByIdAsync(id);
            if (!result.IsSuccess || result.Value is null)
            {
                return ToErrorResult(result.Error.Code == ErrorCode.None
                    ? new ErrorDetail(ErrorCode.NotFound, "文章不存在")
                    : result.Error);
            }

            return ToBinaryFrame(aeds, AedsFrameType.ArticleDetail, PodBinaryCodec.EncodeArticleDetail(result.Value.Value));
        }).AllowAnonymous();

        group.MapGet("/article/hot", static async Task<Results<FileContentHttpResult, JsonHttpResult<ApiResponse>>> (
            int? size,
            IArticleCoreService core,
            IAedsEncoder aeds) =>
        {
            int count = Math.Clamp(size ?? 10, 1, 50);
            var result = await core.GetHotArticlesAsync(count);
            return ToBinaryResult(
                result,
                aeds,
                AedsFrameType.ArticleHot,
                static value => PodBinaryCodec.EncodePopularArticles(value),
                "热门文章数据为空");
        }).AllowAnonymous();

        group.MapGet("/article/search", static async Task<Results<FileContentHttpResult, JsonHttpResult<ApiResponse>>> (
            string keyword,
            IArticleCoreService core,
            IAedsEncoder aeds) =>
        {
            if (string.IsNullOrWhiteSpace(keyword))
            {
                return ToErrorResult(new ErrorDetail(ErrorCode.Validation, "搜索关键词不能为空"));
            }

            var result = await core.SearchArticlesAsync(keyword);
            return ToBinaryResult(
                result,
                aeds,
                AedsFrameType.ArticleSearch,
                static value => PodBinaryCodec.EncodeArticleSearch(value),
                "搜索数据为空");
        }).AllowAnonymous();

        group.MapGet("/comment/{articleId:int}", static async Task<Results<FileContentHttpResult, JsonHttpResult<ApiResponse>>> (
            int articleId,
            long? cursor,
            int? limit,
            ICommentCoreService core,
            IAedsEncoder aeds) =>
        {
            int actualLimit = Math.Clamp(limit ?? 10, 5, 50);
            var result = await core.GetCommentsByCursorAsync(articleId, cursor, actualLimit);
            return ToBinaryResult(result, aeds, AedsFrameType.CommentArticleCursor, static value => PodBinaryCodec.EncodeCommentCursor(value));
        }).AllowAnonymous();

        group.MapGet("/comment/me", static async Task<Results<FileContentHttpResult, JsonHttpResult<ApiResponse>>> (
            HttpContext httpContext,
            long? cursor,
            int? limit,
            ICommentCoreService core,
            IAedsEncoder aeds) =>
        {
            int userId = httpContext.User.GetUserId();
            if (userId <= 0)
            {
                return ToErrorResult(new ErrorDetail(ErrorCode.Unauthorized, "未找到用户信息"));
            }

            int actualLimit = Math.Clamp(limit ?? 10, 5, 50);
            var result = await core.GetUserCommentsAsync(userId, cursor, actualLimit);
            return ToBinaryResult(result, aeds, AedsFrameType.CommentUserCursor, static value => PodBinaryCodec.EncodeUserCommentCursor(value));
        }).AllowAnonymous();

        group.MapGet("/stats", static async Task<Results<FileContentHttpResult, JsonHttpResult<ApiResponse>>> (
            HttpContext httpContext,
            IStatsCoreService core,
            IAedsEncoder aeds) =>
        {
            if (httpContext.User.Identity?.IsAuthenticated != true)
            {
                return ToErrorResult(new ErrorDetail(ErrorCode.Unauthorized, "未登录"));
            }

            if (!httpContext.User.IsInRole("admin"))
            {
                return ToErrorResult(new ErrorDetail(ErrorCode.Forbidden, "权限不足"));
            }

            var result = await core.GetAdminStatsAsync();
            return ToBinaryResult(result, aeds, AedsFrameType.AdminStats, static value => PodBinaryCodec.EncodeSiteStats(value));
        }).AllowAnonymous();
    }

    private static Results<FileContentHttpResult, JsonHttpResult<ApiResponse>> ToBinaryResult<T>(
        in Result<T> result,
        IAedsEncoder aeds,
        AedsFrameType frameType,
        Func<T, byte[]> encodePayload,
        string? nullValueMessage = null)
    {
        if (!result.IsSuccess)
        {
            return ToErrorResult(result.Error);
        }

        if (result.Value is null)
        {
            return ToErrorResult(new ErrorDetail(ErrorCode.InfraFailure, nullValueMessage ?? "二进制载荷为空"));
        }

        return ToBinaryFrame(aeds, frameType, encodePayload(result.Value));
    }

    private static Results<FileContentHttpResult, JsonHttpResult<ApiResponse>> ToBinaryFrame(
        IAedsEncoder aeds,
        AedsFrameType frameType,
        byte[] payload)
    {
        byte[] frame = AedsBinaryWriter.WriteFrame(aeds, frameType, payload);
        return TypedResults.File(frame, BinaryContentType);
    }

    private static JsonHttpResult<ApiResponse> ToErrorResult(in ErrorDetail error)
    {
        int statusCode = error.Code switch
        {
            ErrorCode.Validation => 400,
            ErrorCode.Unauthorized => 401,
            ErrorCode.Forbidden => 403,
            ErrorCode.NotFound => 404,
            ErrorCode.Conflict => 409,
            ErrorCode.InfraFailure => 500,
            _ => 500
        };

        string message = string.IsNullOrWhiteSpace(error.Message)
            ? "请求失败"
            : error.Message;

        return TypedResults.Json(ApiResponse.Fail(message, statusCode), statusCode: statusCode);
    }
}
