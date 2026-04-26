using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Responses;
using FsusBlog.Server.Services;
using Microsoft.AspNetCore.Http.HttpResults;
using System.Text.Json;

namespace FsusBlog.Server.Modules.Endpoints.Binary;

public static class BinaryEndpoints
{
    private static readonly JsonSerializerOptions UploadJsonOptions = new(JsonSerializerDefaults.Web);

    public static void MapBinaryEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("api/binary").WithTags("Binary-POD");
        Int64CursorCodec cursorCodec = Int64CursorCodec.Instance;

        group.MapGet("/article", static async Task<Results<BinaryFrameResult, JsonHttpResult<ApiResponse>>> (
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
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Forbidden, "权限不足"));
            }

            var result = await core.GetPageListAsync(pageValue, sizeValue, categoryId, tagId, deleted);
            return BinaryResults.FromResult(result, aeds, AedsFrameType.ArticleList, static (value, writer) => PodBinaryCodec.WriteArticlePage(value, writer));
        }).AllowAnonymous();

        group.MapGet("/article/{id:int}", static async Task<Results<BinaryFrameResult, JsonHttpResult<ApiResponse>>> (
            int id,
            HttpContext httpContext,
            IArticleCoreService core,
            IUnifiedCache cache,
            IAedsEncoder aeds) =>
        {
            var result = await core.GetByIdAsync(id);
            if (!result.IsSuccess || result.Value is null)
            {
                return BinaryResults.FromError(result.Error.Code == ErrorCode.None
                    ? ErrorDetail.Create(ErrorCode.NotFound, "文章不存在")
                    : result.Error);
            }

            var detail = result.Value.Value;
            string identity = BuildArticleViewerIdentity(httpContext, id);
            if (await cache.TryAcquireLeaseAsync(CachePolicyId.ArticleViewLock, identity, "1", TimeSpan.FromHours(1)))
            {
                await core.IncreaseViewCountAsync(id);
                detail = detail with { Views = detail.Views + 1 };
            }

            return BinaryResults.Frame(aeds, AedsFrameType.ArticleDetail, writer => PodBinaryCodec.WriteArticleDetail(detail, writer));
        }).AllowAnonymous();

        group.MapGet("/article/hot", static async Task<Results<BinaryFrameResult, JsonHttpResult<ApiResponse>>> (
            int? size,
            IArticleCoreService core,
            IAedsEncoder aeds) =>
        {
            int count = Math.Clamp(size ?? 10, 1, 50);
            var result = await core.GetHotArticlesAsync(count);
            return BinaryResults.FromResult(
                result,
                aeds,
                AedsFrameType.ArticleHot,
                static (value, writer) => PodBinaryCodec.WritePopularArticles(value, writer),
                "热门文章数据为空");
        }).AllowAnonymous();

        group.MapGet("/comment/{articleId:int}", async Task<Results<BinaryFrameResult, JsonHttpResult<ApiResponse>>> (
            int articleId,
            HttpContext httpContext,
            CommentService commentService,
            IAedsEncoder aeds) =>
        {
            CursorBindResult<long> bind = CursorPageBinder.Bind(httpContext.Request, CommentCursorPolicies.Threads, cursorCodec);
            if (!bind.IsSuccess)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, bind.ErrorMessage ?? "游标参数非法"));
            }

            var result = await commentService.GetCommentThreadsByCursorAsync(articleId, bind.Request);
            return BinaryResults.Frame(aeds, AedsFrameType.CommentArticleCursor, writer => PodBinaryCodec.WriteCommentThreadCursor(result, writer));
        }).AllowAnonymous();

        group.MapGet("/comment/{articleId:int}/thread/{rootId:long}", async Task<Results<BinaryFrameResult, JsonHttpResult<ApiResponse>>> (
            int articleId,
            long rootId,
            HttpContext httpContext,
            CommentService commentService,
            IAedsEncoder aeds) =>
        {
            CursorBindResult<long> bind = CursorPageBinder.Bind(httpContext.Request, CommentCursorPolicies.Replies, cursorCodec);
            if (!bind.IsSuccess)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, bind.ErrorMessage ?? "游标参数非法"));
            }

            var result = await commentService.GetThreadRepliesByCursorAsync(articleId, rootId, bind.Request);
            return BinaryResults.Frame(aeds, AedsFrameType.CommentThreadReplyCursor, writer => PodBinaryCodec.WriteCommentReplyCursor(rootId, result, writer));
        }).AllowAnonymous();

        group.MapGet("/comment/me", async Task<Results<BinaryFrameResult, JsonHttpResult<ApiResponse>>> (
            HttpContext httpContext,
            ICommentCoreService core,
            IAedsEncoder aeds) =>
        {
            int userId = httpContext.User.GetUserId();
            if (userId <= 0)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Unauthorized, "未找到用户信息"));
            }

            CursorBindResult<long> bind = CursorPageBinder.Bind(httpContext.Request, CommentCursorPolicies.UserComments, cursorCodec);
            if (!bind.IsSuccess)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, bind.ErrorMessage ?? "游标参数非法"));
            }

            var result = await core.GetUserCommentsAsync(userId, bind.Request.Cursor, bind.Request.Limit);
            return BinaryResults.FromResult(result, aeds, AedsFrameType.CommentUserCursor, static (value, writer) => PodBinaryCodec.WriteUserCommentCursor(value, writer));
        }).RequireAuthorization();

        group.MapGet("/stats", static async Task<Results<BinaryFrameResult, JsonHttpResult<ApiResponse>>> (
            IStatsCoreService core,
            IAedsEncoder aeds) =>
        {
            var result = await core.GetAdminStatsAsync();
            return BinaryResults.FromResult(result, aeds, AedsFrameType.AdminStats, static (value, writer) => PodBinaryCodec.WriteSiteStats(value, writer));
        }).RequireAuthorization(policy => policy.RequireRole("admin"));

        var uploadGroup = group.MapGroup("/upload")
            .RequireAuthorization(policy => policy.RequireRole("admin"))
            .AddEndpointFilter<RequiresPowFilter>();

        uploadGroup.MapPost("/init", static async Task<Results<BinaryFrameResult, JsonHttpResult<ApiResponse>>> (
            UploadInitRequestDto dto,
            IFileService fileService,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var result = await fileService.InitUploadSessionAsync(dto, cancellationToken);
            return BinaryResults.FromResult(result, aeds, AedsFrameType.UploadInit, static value => JsonSerializer.SerializeToUtf8Bytes(value, UploadJsonOptions));
        });

        uploadGroup.MapGet("/{uploadId}/status", static async Task<Results<BinaryFrameResult, JsonHttpResult<ApiResponse>>> (
            string uploadId,
            IFileService fileService,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var result = await fileService.GetUploadStatusAsync(uploadId, cancellationToken);
            return BinaryResults.FromResult(result, aeds, AedsFrameType.UploadStatus, static value => JsonSerializer.SerializeToUtf8Bytes(value, UploadJsonOptions));
        });

        uploadGroup.MapGet("/{uploadId}/status/parts", static async Task<Results<BinaryFrameResult, JsonHttpResult<ApiResponse>>> (
            string uploadId,
            IFileService fileService,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var result = await fileService.GetUploadPartMapAsync(uploadId, cancellationToken);
            return BinaryResults.FromResult(result, aeds, AedsFrameType.UploadPartMap, static value => JsonSerializer.SerializeToUtf8Bytes(value, UploadJsonOptions));
        });

        uploadGroup.MapPut("/{uploadId}/part", static async Task<Results<BinaryFrameResult, JsonHttpResult<ApiResponse>>> (
            string uploadId,
            HttpContext httpContext,
            IFileService fileService,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            IFormCollection form = await httpContext.Request.ReadFormAsync(cancellationToken);
            IFormFile? file = form.Files.GetFile("file");
            if (file is null)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "上传分片为空"));
            }

            if (!int.TryParse(form["partNumber"], out int partNumber))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "分片索引非法"));
            }

            if (!long.TryParse(form["offset"], out long offset))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "分片偏移非法"));
            }

            string? payloadHash = form["payloadHash"].FirstOrDefault();
            var result = await fileService.UploadPartAsync(uploadId, partNumber, offset, file, payloadHash, cancellationToken);
            return BinaryResults.FromResult(result, aeds, AedsFrameType.UploadPartAck, static value => JsonSerializer.SerializeToUtf8Bytes(value, UploadJsonOptions));
        })
        .DisableAntiforgery();

        uploadGroup.MapPost("/{uploadId}/complete", static async Task<Results<BinaryFrameResult, JsonHttpResult<ApiResponse>>> (
            string uploadId,
            UploadCompleteRequestDto dto,
            IFileService fileService,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var result = await fileService.CompleteUploadAsync(uploadId, dto.Sha256, cancellationToken);
            return BinaryResults.FromResult(result, aeds, AedsFrameType.UploadComplete, static value => JsonSerializer.SerializeToUtf8Bytes(value, UploadJsonOptions));
        });

        uploadGroup.MapDelete("/{uploadId}", static async Task<Results<BinaryFrameResult, JsonHttpResult<ApiResponse>>> (
            string uploadId,
            IFileService fileService,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var result = await fileService.AbortUploadAsync(uploadId, cancellationToken);
            return BinaryResults.FromResult(result, aeds, AedsFrameType.UploadStatus, _ => JsonSerializer.SerializeToUtf8Bytes(new UploadStatusDto
            {
                UploadId = uploadId,
                Status = "aborted",
                TotalBytes = 0,
                UploadedBytes = 0,
                ChunkSize = 0,
                TotalParts = 0,
                UploadedPartCount = 0,
                NextPartHint = 0,
                ExpiresAt = DateTime.UtcNow
            }, UploadJsonOptions));
        });
    }

    private static string BuildArticleViewerIdentity(HttpContext context, int articleId)
    {
        string? deviceFingerprint = GetDeviceFingerprint(context);
        if (!string.IsNullOrWhiteSpace(deviceFingerprint))
        {
            return $"article:{articleId}:viewer:fp:{deviceFingerprint}";
        }

        return $"article:{articleId}:viewer:ip:{context.GetClientIp()}";
    }

    private static string? GetDeviceFingerprint(HttpContext context)
    {
        if (!context.Request.Headers.TryGetValue("X-Fsus-Device-Fp", out var raw))
        {
            return null;
        }

        string? value = raw.ToString();
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        return value.Length <= 128 ? value : value[..128];
    }

}
