using System.Buffers;
using System.Data.Common;
using System.Security.Cryptography;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
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
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Distribution;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Outputs;

using SqlSugar;

namespace FsusBlog.Server.Modules.Endpoints.Binary;

public static partial class BinaryEndpoints
{
    private const int ArticleListDefaultPage = 1;
    private const int ArticleListDefaultSize = 10;
    private const int ArticleListMaxSize = 100;

    private static void MapBinaryArticleEndpoints(IEndpointRouteBuilder group)
    {
        group.MapGet("/article/list/home/{page:int}/{size:int}.aeds", static (
            int page,
            int size,
            string? cursor,
            string? keyword,
            string? sort,
            IArticleEndpointService articles,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
            ServePublicArticleListAsync(page, size, categoryId: null, tagId: null, cursor, keyword, sort, articles, aeds, cancellationToken))
        .AllowAnonymous()
        .RequireRateLimiting("public_read")
        .WithRiskAction(RiskActionNames.PublicRead, "article.list")
        .WithMetadata(new FsusOpenApiQueryParameterMetadata("cursor", "query://string", Required: false, Nullable: true))
        .WithMetadata(new FsusOpenApiQueryParameterMetadata("keyword", "query://string", Required: false, Nullable: true))
        .WithMetadata(new FsusOpenApiQueryParameterMetadata("sort", "query://string", Required: false, Nullable: true))
        .AddEndpointFilterWithMetadata<RiskAwarePublicReadFilter>();

        group.MapGet("/article/list/archive/{page:int}/{size:int}.aeds", static (
            int page,
            int size,
            string? cursor,
            string? keyword,
            string? sort,
            IArticleEndpointService articles,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
            ServePublicArticleListAsync(page, size, categoryId: null, tagId: null, cursor, keyword, sort, articles, aeds, cancellationToken))
        .AllowAnonymous()
        .RequireRateLimiting("public_read")
        .WithRiskAction(RiskActionNames.PublicRead, "article.list")
        .WithMetadata(new FsusOpenApiQueryParameterMetadata("cursor", "query://string", Required: false, Nullable: true))
        .WithMetadata(new FsusOpenApiQueryParameterMetadata("keyword", "query://string", Required: false, Nullable: true))
        .WithMetadata(new FsusOpenApiQueryParameterMetadata("sort", "query://string", Required: false, Nullable: true))
        .AddEndpointFilterWithMetadata<RiskAwarePublicReadFilter>();

        group.MapGet("/article/list/category/{categoryId:int}/{page:int}/{size:int}.aeds", static (
            int categoryId,
            int page,
            int size,
            string? cursor,
            string? keyword,
            string? sort,
            IArticleEndpointService articles,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
            ServePublicArticleListAsync(page, size, categoryId, tagId: null, cursor, keyword, sort, articles, aeds, cancellationToken))
        .AllowAnonymous()
        .RequireRateLimiting("public_read")
        .WithRiskAction(RiskActionNames.PublicRead, "article.list")
        .WithMetadata(new FsusOpenApiQueryParameterMetadata("cursor", "query://string", Required: false, Nullable: true))
        .WithMetadata(new FsusOpenApiQueryParameterMetadata("keyword", "query://string", Required: false, Nullable: true))
        .WithMetadata(new FsusOpenApiQueryParameterMetadata("sort", "query://string", Required: false, Nullable: true))
        .AddEndpointFilterWithMetadata<RiskAwarePublicReadFilter>();

        group.MapGet("/article/list/tag/{tagId:int}/{page:int}/{size:int}.aeds", static (
            int tagId,
            int page,
            int size,
            string? cursor,
            string? keyword,
            string? sort,
            IArticleEndpointService articles,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
            ServePublicArticleListAsync(page, size, categoryId: null, tagId, cursor, keyword, sort, articles, aeds, cancellationToken))
        .AllowAnonymous()
        .RequireRateLimiting("public_read")
        .WithRiskAction(RiskActionNames.PublicRead, "article.list")
        .WithMetadata(new FsusOpenApiQueryParameterMetadata("cursor", "query://string", Required: false, Nullable: true))
        .WithMetadata(new FsusOpenApiQueryParameterMetadata("keyword", "query://string", Required: false, Nullable: true))
        .WithMetadata(new FsusOpenApiQueryParameterMetadata("sort", "query://string", Required: false, Nullable: true))
        .AddEndpointFilterWithMetadata<RiskAwarePublicReadFilter>();

        group.MapGet("/article/search/query.aeds", static async Task<IResult> (
            string? q,
            HttpContext httpContext,
            FsusBlog.Core.Services.Abstractions.IArticleCoreService articles,
            ICacheStringReader cache,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            Result<IReadOnlyList<ArticleListCoreModel>> result = await articles.SearchArticlesAsync(
                new FsusBlog.Core.Services.Articles.ArticleSearchQuery(q ?? string.Empty),
                cancellationToken);
            if (!result.IsSuccess)
            {
                return BinaryResults.FromError(result.Error, aeds);
            }

            string? searchVersion = await cache.GetStringAsync(CachePolicyId.ArticleSearchVersion, "main", cancellationToken);
            if (!string.IsNullOrWhiteSpace(searchVersion))
            {
                httpContext.Response.Headers["X-Fsus-Search-Index-Generation"] = searchVersion;
            }

            return BinaryResults.FromResult(
                result,
                aeds,
                AedsFrameType.ArticleSearch,
                static (value, writer) => PodBinaryCodec.WriteArticleSearch(value, writer));
        })
        .AllowAnonymous()
        .RequireRateLimiting("public_read")
        .WithRiskAction(RiskActionNames.PublicRead, "article.search")
        .WithMetadata(new FsusOpenApiQueryParameterMetadata("q", "query://string", Required: true, Nullable: false))
        .AddEndpointFilterWithMetadata<RiskAwarePublicReadFilter>();

        group.MapGet("/article/{articleId:int}/related.aeds", static async Task<IResult> (
            int articleId,
            RelatedReadingService service,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            OwnedAedsFrameReadLease? frame = await service.BuildFrameAsync(articleId, cancellationToken);
            return frame is null
                ? BinaryResults.FromError(ErrorDetail.Create(ErrorCode.NotFound, "article_not_found"), aeds)
                : BinaryResults.PreencodedFrame(frame);
        })
        .AllowAnonymous()
        .RequireRateLimiting("public_read")
        .WithRiskAction(RiskActionNames.PublicRead, "article.related")
        .AddEndpointFilterWithMetadata<RiskAwarePublicReadFilter>()
        .CacheOutput(static builder => builder
            .Expire(TimeSpan.FromMinutes(1))
            .Tag(
                CacheTag.ArticleList.ToOutputCacheTag(),
                CacheTag.Category.ToOutputCacheTag(),
                CacheTag.Tag.ToOutputCacheTag()));

        group.MapGet("/article/{id}.aeds", static async Task<IResult> (
            int id,
            IArticleEndpointService articles,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            ArticleDetailArtifactPayload artifact = await articles.GetPublicArtifactBackedDetailAsync(id, cancellationToken);
            if (!artifact.PreencodedFrame.IsEmpty)
            {
                return BinaryResults.PreencodedFrame(artifact.PreencodedFrame);
            }

            var result = await articles.GetByIdAsync(id, canReadPrivate: false, cancellationToken);
            if (!result.IsSuccess || result.Value is null)
            {
                return BinaryResults.FromError(result.Error.Code == ErrorCode.None
                    ? ErrorDetail.Create(ErrorCode.NotFound, "文章不存在")
                    : result.Error,
                    aeds);
            }

            return BinaryResults.Frame(aeds, AedsFrameType.ArticleDetail, writer => PodBinaryCodec.WriteArticleDetail(result.Value.Value, writer));
        })
        .AllowAnonymous()
        .RequireRateLimiting("public_read")
        .WithRiskAction(RiskActionNames.PublicRead, "article.detail")
        .AddEndpointFilterWithMetadata<RiskAwarePublicReadFilter>()
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
                return BinaryResults.PreencodedFrame(payloadResult.CachedFrame!);
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
                return BinaryResults.PreencodedFrame(payloadResult.CachedFrame!);
            }

            return BinaryResults.FromResult(
                payloadResult.Result,
                aeds,
                AedsFrameType.ArticleHot,
                static (value, writer) => PodBinaryCodec.WritePopularArticles(value, writer),
                "热门文章数据为空");
        })
        .RequireAdminPermission(AdminPermissions.ArticleWrite);

        group.MapGet("/admin/article/featured", static async Task<IResult> (
            int? size,
            IArticleEndpointService articles,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            int count = Math.Clamp(size ?? 3, 1, 10);
            var payload = await articles.GetFeaturedArticlesAsync(count, cancellationToken);
            if (payload.HasCachedFrame)
            {
                return BinaryResults.PreencodedFrame(payload.CachedFrame!);
            }

            return BinaryResults.FromResult(
                payload.Result,
                aeds,
                AedsFrameType.ArticleFeatured,
                static (value, writer) => PodBinaryCodec.WriteFeaturedArticles(value, writer),
                "精选文章数据为空");
        })
        .RequireAdminPermission(AdminPermissions.ArticleWrite);

        group.MapPost("/admin/article", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IArticleEndpointService articles,
            IConfiguration configuration,
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

            if (!(configuration.GetValue<bool?>("Articles:MutationIdempotencyEnabled") ?? true))
            {
                return BinaryResults.FromError(
                    ErrorDetail.Create(ErrorCode.InfraFailure, "article_mutation_idempotency_disabled"),
                    aeds,
                    StatusCodes.Status503ServiceUnavailable);
            }
            if (!httpContext.Request.Headers.TryGetValue("X-Fsus-Client-Mutation-Id", out var rawMutationId))
            {
                return BinaryResults.FromError(
                    ErrorDetail.Create(ErrorCode.Validation, "article_client_mutation_id_required"),
                    aeds);
            }

            string clientMutationId = rawMutationId.ToString();
            if (!Guid.TryParseExact(clientMutationId, "D", out Guid parsedMutationId)
                || !string.Equals(clientMutationId, parsedMutationId.ToString("D"), StringComparison.Ordinal))
            {
                return BinaryResults.FromError(
                    ErrorDetail.Create(ErrorCode.Validation, "article_client_mutation_id_invalid"),
                    aeds);
            }
            if (!httpContext.User.TryGetAdminPrincipalId(out long adminPrincipalId))
            {
                return BinaryResults.FromError(
                    ErrorDetail.Create(ErrorCode.Unauthorized, "admin_principal_required"),
                    aeds,
                    StatusCodes.Status401Unauthorized);
            }

            string requestHash = Convert.ToHexString(SHA256.HashData(payload.Payload.Span));
            Result<ArticleMutationResult> result = await articles.CreateAsync(
                adminPrincipalId,
                clientMutationId,
                requestHash,
                request,
                cancellationToken);

            return result.IsSuccess
                ? BinaryResults.Frame(aeds, AedsFrameType.MutationId, writer => PodBinaryCodec.WriteArticleMutationResult(result.Value, writer))
                : BinaryResults.FromError(result.Error, aeds);
        })
        .RequireAdminPermission(AdminPermissions.ArticleWrite)
        .AddEndpointFilterWithMetadata<RequiresPowFilter>();

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

            Result<ArticleMutationResult> result = await articles.UpdateAsync(id, request, cancellationToken);

            return result.IsSuccess
                ? BinaryResults.Frame(aeds, AedsFrameType.MutationId, writer => PodBinaryCodec.WriteArticleMutationResult(result.Value, writer))
                : BinaryResults.FromError(result.Error, aeds);
        })
        .RequireAdminPermission(AdminPermissions.ArticleWrite)
        .AddEndpointFilterWithMetadata<RequiresPowFilter>();

        group.MapDelete("/admin/article/trash", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IArticleEndpointService articles,
            IAdminPrincipalService adminPrincipals,
            IAuditEventService auditEvents,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var stepUp = await RequireAdminSensitiveStepUpAsync(httpContext, adminPrincipals);
            if (stepUp is not null)
            {
                await RecordArticleTrashClearAuditAsync(
                    httpContext,
                    auditEvents,
                    destroyedCount: 0,
                    success: false,
                    reasonCode: BuildArticleTrashClearStepUpReason(stepUp.Value.StatusCode),
                    cancellationToken);
                return BinaryResults.FromError(stepUp.Value.Error, aeds, stepUp.Value.StatusCode);
            }

            int count = await articles.ClearTrashAsync(cancellationToken);
            if (count < 0)
            {
                await RecordArticleTrashClearAuditAsync(
                    httpContext,
                    auditEvents,
                    destroyedCount: 0,
                    success: false,
                    reasonCode: "clear_trash_failed",
                    cancellationToken);
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.InfraFailure, "清空回收站失败：数据库操作异常"), aeds);
            }

            await RecordArticleTrashClearAuditAsync(
                httpContext,
                auditEvents,
                count,
                success: true,
                reasonCode: null,
                cancellationToken);
            return BinaryResults.Frame(aeds, AedsFrameType.TrashClearResponse, writer => PodBinaryCodec.WriteTrashClearResponse(new TrashClearResponseDto(count), writer));
        })
        .RequireAdminPermission(AdminPermissions.ArticleWrite)
        .RequireRateLimiting("fixed_ip")
        .WithAdminSensitiveStepUp()
        .AddEndpointFilterWithMetadata<RequiresPowFilter>();

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
        .WithAdminSensitiveStepUp()
        .AddEndpointFilterWithMetadata<RequiresPowFilter>();

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

            Result result = await articles.RestoreAsync(id, cancellationToken);
            return result.IsSuccess
                ? BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess)
                : BinaryResults.FromError(result.Error, aeds);
        })
        .RequireAdminPermission(AdminPermissions.ArticleWrite)
        .RequireRateLimiting("fixed_ip")
        .WithAdminSensitiveStepUp()
        .AddEndpointFilterWithMetadata<RequiresPowFilter>();

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
        .WithAdminSensitiveStepUp()
        .AddEndpointFilterWithMetadata<RequiresPowFilter>();
    }

    private static long ResolveAdminPrincipalId(HttpContext httpContext)
        => TryResolveAdminSessionContext(httpContext, out long adminPrincipalId, out _)
            ? adminPrincipalId
            : 0;

    private static Task RecordArticleTrashClearAuditAsync(
        HttpContext httpContext,
        IAuditEventService auditEvents,
        int destroyedCount,
        bool success,
        string? reasonCode,
        CancellationToken cancellationToken)
    {
        long adminPrincipalId = ResolveAdminPrincipalId(httpContext);
        string? actorId = adminPrincipalId > 0
            ? adminPrincipalId.ToString(System.Globalization.CultureInfo.InvariantCulture)
            : null;
        string? actorRole = adminPrincipalId > 0
            ? $"admin:{adminPrincipalId.ToString(System.Globalization.CultureInfo.InvariantCulture)}"
            : null;
        string outcome = success ? AuditOutcomeCatalog.Success : AuditOutcomeCatalog.Failure;

        return auditEvents.RecordHighValueAsync(new AuditEvent(
            AuditSourceCatalog.Article,
            AuditTypeCatalog.Audit,
            AuditActionCatalog.ArticleTrashCleared,
            outcome,
            success ? AuditSeverityCatalog.Critical : AuditSeverityCatalog.Error,
            success ? "管理员清空文章回收站" : "管理员清空文章回收站失败",
            ActorType: AuditActorTypeCatalog.Admin,
            ActorId: actorId,
            ActorRole: actorRole,
            TargetType: "article_trash",
            TargetId: "article_trash",
            ReasonCode: reasonCode,
            Context: new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["DestroyedCount"] = destroyedCount,
                ["outcome"] = outcome,
                ["TraceIdentifier"] = httpContext.TraceIdentifier
            }), cancellationToken);
    }

    private static string BuildArticleTrashClearStepUpReason(int statusCode)
        => statusCode switch
        {
            StatusCodes.Status403Forbidden => "origin_not_allowed",
            StatusCodes.Status428PreconditionRequired => "mfa_proof_required",
            StatusCodes.Status401Unauthorized => "unauthorized",
            _ => "admin_step_up_failed"
        };

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

    private static async Task<IResult> ServePublicArticleListAsync(
        int page,
        int size,
        int? categoryId,
        int? tagId,
        string? cursor,
        string? keyword,
        string? sort,
        IArticleEndpointService articles,
        IAedsEncoder aeds,
        CancellationToken cancellationToken)
    {
        if (!TryBindArticleListPagination(page, size, out int pageValue, out int sizeValue, out ErrorDetail paginationError))
        {
            return BinaryResults.FromError(paginationError, aeds);
        }

        ArticleEndpointPayload<CorePageResult<ArticleListCoreModel>> payload = await articles.GetPageListAsync(
            pageValue,
            sizeValue,
            categoryId,
            tagId,
            isDeleted: false,
            canReadDeleted: false,
            status: null,
            canReadPrivate: false,
            keyword,
            sort,
            cursor,
            cancellationToken);
        if (payload.HasCachedFrame)
        {
            return BinaryResults.PreencodedFrame(payload.CachedFrame!);
        }

        return BinaryResults.FromResult(
            payload.Result,
            aeds,
            AedsFrameType.ArticleList,
            static (value, writer) => PodBinaryCodec.WriteArticlePage(value, writer));
    }
}
