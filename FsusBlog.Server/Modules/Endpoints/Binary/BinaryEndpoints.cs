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
            int page,
            int size,
            int? categoryId,
            int? tagId,
            bool isDeleted,
            IArticleCoreService core,
            IAedsEncoder aeds) =>
        {
            var result = await core.GetPageListAsync(page, size, categoryId, tagId, isDeleted);
            if (!result.IsSuccess)
            {
                return ToErrorResult(result.Error);
            }

            byte[] payload = PodBinaryCodec.EncodeArticlePage(result.Value);
            byte[] frame = AedsBinaryWriter.WriteFrame(aeds, AedsFrameType.ArticleList, payload);
            return TypedResults.File(frame, BinaryContentType);
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

            byte[] payload = PodBinaryCodec.EncodeArticleDetail(result.Value.Value);
            byte[] frame = AedsBinaryWriter.WriteFrame(aeds, AedsFrameType.ArticleDetail, payload);
            return TypedResults.File(frame, BinaryContentType);
        }).AllowAnonymous();

        group.MapGet("/article/hot", static async Task<Results<FileContentHttpResult, JsonHttpResult<ApiResponse>>> (
            int? size,
            IArticleCoreService core,
            IAedsEncoder aeds) =>
        {
            int count = Math.Clamp(size ?? 10, 1, 50);
            var result = await core.GetHotArticlesAsync(count);
            if (!result.IsSuccess)
            {
                return ToErrorResult(result.Error);
            }
            if (result.Value is null)
            {
                return ToErrorResult(new ErrorDetail(ErrorCode.InfraFailure, "热门文章数据为空"));
            }

            byte[] payload = PodBinaryCodec.EncodePopularArticles(result.Value);
            byte[] frame = AedsBinaryWriter.WriteFrame(aeds, AedsFrameType.ArticleHot, payload);
            return TypedResults.File(frame, BinaryContentType);
        }).AllowAnonymous();

        group.MapGet("/article/search", static async Task<Results<FileContentHttpResult, JsonHttpResult<ApiResponse>>> (
            string keyword,
            IArticleCoreService core,
            IAedsEncoder aeds) =>
        {
            var result = await core.SearchArticlesAsync(keyword);
            if (!result.IsSuccess)
            {
                return ToErrorResult(result.Error);
            }
            if (result.Value is null)
            {
                return ToErrorResult(new ErrorDetail(ErrorCode.InfraFailure, "搜索数据为空"));
            }

            byte[] payload = PodBinaryCodec.EncodeArticleSearch(result.Value);
            byte[] frame = AedsBinaryWriter.WriteFrame(aeds, AedsFrameType.ArticleSearch, payload);
            return TypedResults.File(frame, BinaryContentType);
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
            if (!result.IsSuccess)
            {
                return ToErrorResult(result.Error);
            }

            byte[] payload = PodBinaryCodec.EncodeCommentCursor(result.Value);
            byte[] frame = aeds.Encode(AedsFrameType.CommentArticleCursor, payload);
            return TypedResults.File(frame, BinaryContentType);
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
            if (!result.IsSuccess)
            {
                return ToErrorResult(result.Error);
            }

            byte[] payload = PodBinaryCodec.EncodeUserCommentCursor(result.Value);
            byte[] frame = aeds.Encode(AedsFrameType.CommentUserCursor, payload);
            return TypedResults.File(frame, BinaryContentType);
        }).RequireAuthorization();

        group.MapGet("/stats", static async Task<Results<FileContentHttpResult, JsonHttpResult<ApiResponse>>> (
            IStatsCoreService core,
            IAedsEncoder aeds) =>
        {
            var result = await core.GetAdminStatsAsync();
            if (!result.IsSuccess)
            {
                return ToErrorResult(result.Error);
            }

            byte[] payload = PodBinaryCodec.EncodeSiteStats(result.Value);
            byte[] frame = aeds.Encode(AedsFrameType.AdminStats, payload);
            return TypedResults.File(frame, BinaryContentType);
        }).RequireAuthorization();
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
