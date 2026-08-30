using System.Buffers;
using System.Data.Common;
using System.Diagnostics;
using System.Text;

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
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Services.Taxonomy;
using FsusBlog.Shared.Contracts.Outputs;

using SqlSugar;

namespace FsusBlog.Server.Modules.Endpoints.Binary;

public static partial class BinaryEndpoints
{
    private static void MapBinaryTaxonomyEndpoints(IEndpointRouteBuilder group)
    {
        group.MapGet("/category", ReadCategoryAsync)
        .AllowAnonymous()
        .RequireRateLimiting("public_read")
        .WithRiskAction(RiskActionNames.PublicRead, "taxonomy.category")
        .AddEndpointFilter<RiskAwarePublicReadFilter>();

        group.MapGet("/tag", static async Task<IResult> (
            ISqlSugarClient db,
            ICacheStringReader cache,
            IOwnedFrameCache ownedFrameCache,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            string identity = await ResolveTaxonomyFrameIdentityAsync(cache);
            OwnedFrameCacheReadResult frame = await ownedFrameCache.TryGetOwnedFrameAsync(
                CachePolicyId.TagFrame,
                identity,
                AedsFrameType.TagList,
                cancellationToken);
            if (frame.Hit && frame.Lease is not null)
            {
                FsusObservability.RecordTaxonomyFrameCache("tag", hit: true);
                return BinaryResults.PreencodedFrame(frame.Lease);
            }

            FsusObservability.RecordTaxonomyFrameCache("tag", hit: false);
            Stopwatch stopwatch = Stopwatch.StartNew();
            var query = db.Queryable<Tag>()
                .LeftJoin<TagPublicArticleCount>((t, count) => t.Id == count.TagId)
                .OrderBy(t => t.Id)
                .Select((t, count) => new
                {
                    t.Id,
                    t.Name,
                    ArticleCount = SqlFunc.MappingColumn<long>("COALESCE(count.article_count, 0)")
                });

            var sqlObj = query.ToSql();
            var result = new List<TagWithCountDto>();

            using (var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(sqlObj.Key, sqlObj.Value))
            {
                int fId = reader.GetOrdinal("Id");
                int fName = reader.GetOrdinal("Name");
                int fCount = reader.GetOrdinal("ArticleCount");

                while (await reader.ReadAsync())
                {
                    result.Add(new TagWithCountDto(
                        reader.GetInt32(fId),
                        reader.IsDBNull(fName) ? string.Empty : reader.GetString(fName),
                        (int)reader.GetInt64(fCount)));
                }
            }

            OwnedAedsFrame ownedFrame = BuildCachedFrame(
                AedsFrameType.TagList,
                writer => PodBinaryCodec.WriteTagWithCountList(result, writer));
            IResult response = await StoreAndReturnOwnedFrameAsync(
                ownedFrameCache,
                CachePolicyId.TagFrame,
                identity,
                ownedFrame,
                TimeSpan.FromMinutes(10),
                cancellationToken);
            FsusObservability.RecordTaxonomyFrameColdMiss("tag", stopwatch.Elapsed);
            return response;
        })
        .AllowAnonymous()
        .RequireRateLimiting("public_read")
        .WithRiskAction(RiskActionNames.PublicRead, "taxonomy.tag")
        .AddEndpointFilter<RiskAwarePublicReadFilter>();

        group.MapPost("/category", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            ISqlSugarClient db,
            IHttpCacheInvalidator httpCacheInvalidator,
            ITaxonomyCountProjectionService taxonomyProjection,
            PublicHotArtifactUpdateQueue publicHotUpdates,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            TaxonomyMetadataMutationPayload request = await ReadTaxonomyMetadataMutationAsync(
                httpContext,
                aeds,
                AedsFrameType.CategoryWriteRequest,
                cancellationToken);
            if (!request.IsSuccess)
            {
                return BinaryResults.FromError(request.Error, aeds);
            }

            string trimmedName = request.Name.Trim();
            if (string.IsNullOrWhiteSpace(trimmedName))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "分类名称不能为空"), aeds);
            }

            if (!TryNormalizeTaxonomyDescription(request.Description, out string? normalizedDescription))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "分类描述不能超过 500 个 Unicode 字符"), aeds);
            }

            bool exists = await db.Queryable<Category>().AnyAsync(c => c.Name == trimmedName);
            if (exists)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, $"分类“{trimmedName}”已存在"), aeds);
            }

            int newId = await CreateCategoryAsync(db, trimmedName, normalizedDescription, cancellationToken);
            if (newId <= 0)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.InfraFailure, "由于数据库写入异常，分类创建失败"), aeds);
            }

            using var _ = AuditLogScope.Push(
                AuditSourceCatalog.Category,
                AuditTypeCatalog.Audit,
                new KeyValuePair<string, object?>("AuditAction", "category.create"),
                new KeyValuePair<string, object?>("CategoryName", trimmedName));
            await taxonomyProjection.BumpFrameVersionAsync("taxonomy-category-created", CancellationToken.None);
            await httpCacheInvalidator.InvalidateAsync(CacheTag.Category, CacheTag.ArticleList);
            PublicHotArtifactEnqueueResult delivery = await publicHotUpdates.EnqueueAsync(
                PublicHotArtifactDeliveryClass.RequiredTaxonomy,
                null,
                "taxonomy-category-created",
                cancellationToken: CancellationToken.None);
            if (!IsRequiredTaxonomyDeliveryDurable(delivery))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.InfraFailure, "分类已创建，但 PublicHot 重建交付未确认"), aeds);
            }
            return BinaryResults.Frame(aeds, AedsFrameType.MutationId, writer => PodBinaryCodec.WriteMutationId(newId, writer));
        })
        .RequireAdminPermission(AdminPermissions.ArticleWrite)
        .AddEndpointFilterWithMetadata<RequiresPowFilter>();

        group.MapPut("/category/{id:int}", static async Task<BinaryFrameResult> (
            int id,
            HttpContext httpContext,
            ISqlSugarClient db,
            IHttpCacheInvalidator httpCacheInvalidator,
            ITaxonomyCountProjectionService taxonomyProjection,
            PublicHotArtifactUpdateQueue publicHotUpdates,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            TaxonomyMetadataMutationPayload request = await ReadTaxonomyMetadataMutationAsync(
                httpContext,
                aeds,
                AedsFrameType.CategoryWriteRequest,
                cancellationToken);
            if (!request.IsSuccess)
            {
                return BinaryResults.FromError(request.Error, aeds);
            }

            string trimmedName = request.Name.Trim();
            if (string.IsNullOrWhiteSpace(trimmedName))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "分类名称不能为空"), aeds);
            }

            if (!TryNormalizeTaxonomyDescription(request.Description, out string? normalizedDescription))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "分类描述不能超过 500 个 Unicode 字符"), aeds);
            }

            bool exists = await db.Queryable<Category>()
                .Where(c => c.Name == trimmedName && c.Id != id)
                .AnyAsync();
            if (exists)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, $"该分类名称“{trimmedName}”已被其他分类占用"), aeds);
            }

            int updateCount = await UpdateCategoryAndEnqueueProjectionAsync(
                db,
                id,
                trimmedName,
                normalizedDescription,
                preserveDescription: request.IsLegacy,
                cancellationToken);
            if (updateCount <= 0)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.NotFound, "操作失败：未找到对应的分类记录"), aeds);
            }

            using var _ = AuditLogScope.Push(
                AuditSourceCatalog.Category,
                AuditTypeCatalog.Audit,
                new KeyValuePair<string, object?>("AuditAction", "category.update"),
                new KeyValuePair<string, object?>("CategoryId", id),
                new KeyValuePair<string, object?>("CategoryName", trimmedName));
            await taxonomyProjection.BumpFrameVersionAsync("taxonomy-category-updated", CancellationToken.None);
            await httpCacheInvalidator.InvalidateAsync(CacheTag.Category, CacheTag.ArticleList);
            PublicHotArtifactEnqueueResult delivery = await publicHotUpdates.EnqueueAsync(
                PublicHotArtifactDeliveryClass.RequiredTaxonomy,
                null,
                "taxonomy-category-updated",
                cancellationToken: CancellationToken.None);
            if (!IsRequiredTaxonomyDeliveryDurable(delivery))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.InfraFailure, "分类已更新，但 PublicHot 重建交付未确认"), aeds);
            }
            return BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess);
        })
        .RequireAdminPermission(AdminPermissions.ArticleWrite)
        .AddEndpointFilterWithMetadata<RequiresPowFilter>();

        group.MapDelete("/category/{id:int}", static async Task<BinaryFrameResult> (
            int id,
            ISqlSugarClient db,
            IHttpCacheInvalidator httpCacheInvalidator,
            ITaxonomyCountProjectionService taxonomyProjection,
            PublicHotArtifactUpdateQueue publicHotUpdates,
            CancellationToken cancellationToken,
            IAedsEncoder aeds) =>
        {
            bool hasArticles = await db.Queryable<Article>().AnyAsync(a => a.CategoryId == id && !a.IsDeleted && a.Status != ArticleStatus.Deleted);
            if (hasArticles)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "无法删除：该分类下仍有关联文章，请先迁移文章到其他分类"), aeds);
            }

            int deleteCount = await db.Deleteable<Category>().In(id).ExecuteCommandAsync();
            if (deleteCount <= 0)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.NotFound, "操作失败：目标分类不存在或已被删除"), aeds);
            }

            using var _ = AuditLogScope.Push(
                AuditSourceCatalog.Category,
                AuditTypeCatalog.Audit,
                new KeyValuePair<string, object?>("AuditAction", "category.delete"),
                new KeyValuePair<string, object?>("CategoryId", id));
            await taxonomyProjection.BumpFrameVersionAsync("taxonomy-category-deleted", CancellationToken.None);
            await httpCacheInvalidator.InvalidateAsync(CacheTag.Category, CacheTag.ArticleList);
            PublicHotArtifactEnqueueResult delivery = await publicHotUpdates.EnqueueAsync(
                PublicHotArtifactDeliveryClass.RequiredTaxonomy,
                null,
                "taxonomy-category-deleted",
                cancellationToken: CancellationToken.None);
            if (!IsRequiredTaxonomyDeliveryDurable(delivery))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.InfraFailure, "分类已删除，但 PublicHot 重建交付未确认"), aeds);
            }
            return BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess);
        })
        .RequireAdminPermission(AdminPermissions.ArticleWrite)
        .AddEndpointFilterWithMetadata<RequiresPowFilter>();

        group.MapPost("/tag", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            ISqlSugarClient db,
            IHttpCacheInvalidator httpCacheInvalidator,
            ITaxonomyCountProjectionService taxonomyProjection,
            PublicHotArtifactUpdateQueue publicHotUpdates,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            TaxonomyMetadataMutationPayload request = await ReadTaxonomyMetadataMutationAsync(
                httpContext,
                aeds,
                AedsFrameType.TagWriteRequest,
                cancellationToken);
            if (!request.IsSuccess)
            {
                return BinaryResults.FromError(request.Error, aeds);
            }

            string trimmedName = PublicTagUrlIdentity.NormalizeDisplayName(request.Name);
            if (string.IsNullOrWhiteSpace(trimmedName))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "标签名称不能为空"), aeds);
            }

            if (!TryNormalizeTaxonomyDescription(request.Description, out string? normalizedDescription))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "标签描述不能超过 500 个 Unicode 字符"), aeds);
            }

            bool exists = await db.Queryable<Tag>().AnyAsync(t => t.Name == trimmedName)
                || await IsTagUrlNameReservedAsync(db, trimmedName, exceptTagId: null, cancellationToken);
            if (exists)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, $"标签 [{trimmedName}] 已存在"), aeds);
            }

            int newId = await CreateTagAsync(db, trimmedName, normalizedDescription, cancellationToken);
            if (newId <= 0)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.InfraFailure, "标签创建失败，数据库写入异常"), aeds);
            }

            using var _ = AuditLogScope.Push(
                AuditSourceCatalog.Tag,
                AuditTypeCatalog.Audit,
                new KeyValuePair<string, object?>("AuditAction", "tag.create"),
                new KeyValuePair<string, object?>("TagName", trimmedName));
            await taxonomyProjection.BumpFrameVersionAsync("taxonomy-tag-created", CancellationToken.None);
            await httpCacheInvalidator.InvalidateAsync(CacheTag.Tag, CacheTag.ArticleList);
            PublicHotArtifactEnqueueResult delivery = await publicHotUpdates.EnqueueAsync(
                PublicHotArtifactDeliveryClass.RequiredTaxonomy,
                null,
                "taxonomy-tag-created",
                cancellationToken: CancellationToken.None);
            if (!IsRequiredTaxonomyDeliveryDurable(delivery))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.InfraFailure, "标签已创建，但 PublicHot 重建交付未确认"), aeds);
            }
            return BinaryResults.Frame(aeds, AedsFrameType.MutationId, writer => PodBinaryCodec.WriteMutationId(newId, writer));
        })
        .RequireAdminPermission(AdminPermissions.ArticleWrite)
        .AddEndpointFilterWithMetadata<RequiresPowFilter>();

        group.MapPut("/tag/{id:int}", static async Task<BinaryFrameResult> (
            int id,
            HttpContext httpContext,
            ISqlSugarClient db,
            IHttpCacheInvalidator httpCacheInvalidator,
            ITaxonomyCountProjectionService taxonomyProjection,
            PublicHotArtifactUpdateQueue publicHotUpdates,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            TaxonomyMetadataMutationPayload request = await ReadTaxonomyMetadataMutationAsync(
                httpContext,
                aeds,
                AedsFrameType.TagWriteRequest,
                cancellationToken);
            if (!request.IsSuccess)
            {
                return BinaryResults.FromError(request.Error, aeds);
            }

            string trimmedName = PublicTagUrlIdentity.NormalizeDisplayName(request.Name);
            if (string.IsNullOrWhiteSpace(trimmedName))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "标签名称不能为空"), aeds);
            }

            if (!TryNormalizeTaxonomyDescription(request.Description, out string? normalizedDescription))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "标签描述不能超过 500 个 Unicode 字符"), aeds);
            }

            bool exists = await db.Queryable<Tag>()
                .Where(t => t.Name == trimmedName && t.Id != id)
                .AnyAsync()
                || await IsTagUrlNameReservedAsync(db, trimmedName, id, cancellationToken);
            if (exists)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, $"标签名称 [{trimmedName}] 已被其他记录占用"), aeds);
            }

            int updateCount = await UpdateTagAndEnqueueProjectionAsync(
                db,
                id,
                trimmedName,
                normalizedDescription,
                preserveDescription: request.IsLegacy,
                cancellationToken);
            if (updateCount <= 0)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.NotFound, "目标标签不存在"), aeds);
            }

            using var _ = AuditLogScope.Push(
                AuditSourceCatalog.Tag,
                AuditTypeCatalog.Audit,
                new KeyValuePair<string, object?>("AuditAction", "tag.update"),
                new KeyValuePair<string, object?>("TagId", id),
                new KeyValuePair<string, object?>("TagName", trimmedName));
            await taxonomyProjection.BumpFrameVersionAsync("taxonomy-tag-updated", CancellationToken.None);
            await httpCacheInvalidator.InvalidateAsync(CacheTag.Tag, CacheTag.ArticleList);
            PublicHotArtifactEnqueueResult delivery = await publicHotUpdates.EnqueueAsync(
                PublicHotArtifactDeliveryClass.RequiredTaxonomy,
                null,
                "taxonomy-tag-updated",
                cancellationToken: CancellationToken.None);
            if (!IsRequiredTaxonomyDeliveryDurable(delivery))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.InfraFailure, "标签已更新，但 PublicHot 重建交付未确认"), aeds);
            }
            return BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess);
        })
        .RequireAdminPermission(AdminPermissions.ArticleWrite)
        .AddEndpointFilterWithMetadata<RequiresPowFilter>();

        group.MapDelete("/tag/{id:int}", static async Task<BinaryFrameResult> (
            int id,
            ISqlSugarClient db,
            IHttpCacheInvalidator httpCacheInvalidator,
            ITaxonomyCountProjectionService taxonomyProjection,
            PublicHotArtifactUpdateQueue publicHotUpdates,
            CancellationToken cancellationToken,
            IAedsEncoder aeds) =>
        {
            TagDeleteOutcome outcome = await DeleteTagIfUnlinkedAsync(db, id);
            if (outcome == TagDeleteOutcome.HasArticleLinks)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "无法删除：该标签仍有关联文章，请先查看引用文章并移除标签"), aeds);
            }

            if (outcome == TagDeleteOutcome.NotFound)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.NotFound, "操作失败：目标标签不存在或已被删除"), aeds);
            }

            using var _ = AuditLogScope.Push(
                AuditSourceCatalog.Tag,
                AuditTypeCatalog.Audit,
                new KeyValuePair<string, object?>("AuditAction", "tag.delete"),
                new KeyValuePair<string, object?>("TagId", id));
            await taxonomyProjection.BumpFrameVersionAsync("taxonomy-tag-deleted", CancellationToken.None);
            await httpCacheInvalidator.InvalidateAsync(CacheTag.Tag, CacheTag.ArticleList);
            PublicHotArtifactEnqueueResult delivery = await publicHotUpdates.EnqueueAsync(
                PublicHotArtifactDeliveryClass.RequiredTaxonomy,
                null,
                "taxonomy-tag-deleted",
                cancellationToken: CancellationToken.None);
            if (!IsRequiredTaxonomyDeliveryDurable(delivery))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.InfraFailure, "标签已删除，但 PublicHot 重建交付未确认"), aeds);
            }
            return BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess);
        })
        .RequireAdminPermission(AdminPermissions.ArticleWrite)
        .AddEndpointFilterWithMetadata<RequiresPowFilter>();
    }

    internal static async Task<IResult> ReadCategoryAsync(
        ISqlSugarClient db,
        ICacheStringReader cache,
        IOwnedFrameCache ownedFrameCache,
        IAedsEncoder aeds,
        CancellationToken cancellationToken = default)
    {
        string identity = await ResolveTaxonomyFrameIdentityAsync(cache);
        OwnedFrameCacheReadResult frame = await ownedFrameCache.TryGetOwnedFrameAsync(
            CachePolicyId.CategoryFrame,
            identity,
            AedsFrameType.CategoryList,
            cancellationToken);
        if (frame.Hit && frame.Lease is not null)
        {
            FsusObservability.RecordTaxonomyFrameCache("category", hit: true);
            return BinaryResults.PreencodedFrame(frame.Lease);
        }

        FsusObservability.RecordTaxonomyFrameCache("category", hit: false);
        Stopwatch stopwatch = Stopwatch.StartNew();
        var query = db.Queryable<Category>()
            .LeftJoin<CategoryPublicArticleCount>((c, count) => c.Id == count.CategoryId)
            .OrderBy(c => c.Id)
            .Select((c, count) => new
            {
                c.Id,
                c.Name,
                ArticleCount = SqlFunc.MappingColumn<long>("COALESCE(count.article_count, 0)")
            });

        var sqlObj = query.ToSql();
        var result = new List<CategoryListItemResponse>();

        using (var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(sqlObj.Key, sqlObj.Value))
        {
            int fId = reader.GetOrdinal("Id");
            int fName = reader.GetOrdinal("Name");
            int fCount = reader.GetOrdinal("ArticleCount");

            while (await reader.ReadAsync())
            {
                result.Add(ArticleProjection.ToCategoryResponse(
                    reader.GetInt32(fId),
                    reader.IsDBNull(fName) ? string.Empty : reader.GetString(fName),
                    (int)reader.GetInt64(fCount)));
            }
        }

        OwnedAedsFrame ownedFrame = BuildCachedFrame(
            AedsFrameType.CategoryList,
            writer => PodBinaryCodec.WriteCategoryList(result, writer));
        IResult response = await StoreAndReturnOwnedFrameAsync(
            ownedFrameCache,
            CachePolicyId.CategoryFrame,
            identity,
            ownedFrame,
            TimeSpan.FromMinutes(10),
            cancellationToken);
        FsusObservability.RecordTaxonomyFrameColdMiss("category", stopwatch.Elapsed);
        return response;
    }

    private static async Task<string> ResolveTaxonomyFrameIdentityAsync(ICacheStringReader cache)
    {
        string? raw = await cache.GetStringAsync(CachePolicyId.TaxonomyFrameVersion, "main");
        return long.TryParse(raw, out long version) && version > 0
            ? $"v:{version}:all"
            : "v:0:all";
    }

    internal static async Task<TagDeleteOutcome> DeleteTagIfUnlinkedAsync(ISqlSugarClient db, int id)
    {
        if (await db.Queryable<ArticleTag>().AnyAsync(at => at.TagId == id))
        {
            return TagDeleteOutcome.HasArticleLinks;
        }

        int deleted = await db.Deleteable<Tag>().In(id).ExecuteCommandAsync();
        return deleted > 0 ? TagDeleteOutcome.Deleted : TagDeleteOutcome.NotFound;
    }

    private static async Task<TaxonomyMetadataMutationPayload> ReadTaxonomyMetadataMutationAsync(
        HttpContext httpContext,
        IAedsEncoder aeds,
        AedsFrameType expectedFrameType,
        CancellationToken cancellationToken)
    {
        using BinaryRequestPayload payload = await ReadBinaryRequestPayloadAsync(
            httpContext,
            aeds,
            expectedFrameType,
            cancellationToken,
            maxFrameBytes: 4096);
        if (!payload.IsSuccess)
        {
            return TaxonomyMetadataMutationPayload.Failure(payload.Error);
        }

        if (!PodBinaryCodec.TryDecodeTaxonomyMetadataMutationRequest(
                payload.Payload,
                out TaxonomyMetadataMutationRequestCoreModel request,
                out bool isLegacy))
        {
            return TaxonomyMetadataMutationPayload.Failure(
                ErrorDetail.Create(ErrorCode.Validation, "分类或标签请求体非法"));
        }

        return TaxonomyMetadataMutationPayload.Success(request.Name, request.Description, isLegacy);
    }

    internal static bool TryNormalizeTaxonomyDescription(string? description, out string? normalized)
    {
        normalized = string.IsNullOrWhiteSpace(description) ? null : description.Trim();
        return normalized is null || normalized.EnumerateRunes().Count() <= 500;
    }

    internal static Task<int> CreateCategoryAsync(
        ISqlSugarClient db,
        string name,
        string? description,
        CancellationToken cancellationToken)
        => db.Insertable(new Category
        {
            Name = name,
            Description = description
        }).ExecuteReturnIdentityAsync(cancellationToken);

    internal static Task<int> CreateTagAsync(
        ISqlSugarClient db,
        string name,
        string? description,
        CancellationToken cancellationToken)
        => db.Insertable(new Tag
        {
            Name = name,
            Description = description
        }).ExecuteReturnIdentityAsync(cancellationToken);

    internal static async Task<int> UpdateCategoryAndEnqueueProjectionAsync(
        ISqlSugarClient db,
        int categoryId,
        string name,
        CancellationToken cancellationToken)
        => await UpdateCategoryAndEnqueueProjectionAsync(
            db,
            categoryId,
            name,
            description: null,
            preserveDescription: true,
            cancellationToken);

    internal static async Task<int> UpdateCategoryAndEnqueueProjectionAsync(
        ISqlSugarClient db,
        int categoryId,
        string name,
        string? description,
        bool preserveDescription,
        CancellationToken cancellationToken)
    {
        int updated = 0;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            List<int> affectedArticleIds = await db.Queryable<Article>()
                .ClearFilter()
                .Where(article => article.CategoryId == categoryId)
                .Select(article => article.Id)
                .ToListAsync(cancellationToken);
            updated = preserveDescription
                ? await db.Updateable<Category>()
                    .SetColumns(category => category.Name == name)
                    .Where(category => category.Id == categoryId)
                    .ExecuteCommandAsync(cancellationToken)
                : await db.Updateable<Category>()
                    .SetColumns(category => new Category
                    {
                        Name = name,
                        Description = description
                    })
                    .Where(category => category.Id == categoryId)
                    .ExecuteCommandAsync(cancellationToken);
            if (updated > 0)
            {
                await InsertTaxonomyProjectionOutboxAsync(
                    db,
                    affectedArticleIds,
                    ArticleMutationEventTypes.CategoryUpdated,
                    cancellationToken);
            }
        });
        if (!transaction.IsSuccess)
        {
            throw new InvalidOperationException($"category projection transaction failed: {transaction.ErrorMessage}");
        }

        return updated;
    }

    internal static async Task<int> UpdateTagAndEnqueueProjectionAsync(
        ISqlSugarClient db,
        int tagId,
        string name,
        CancellationToken cancellationToken)
        => await UpdateTagAndEnqueueProjectionAsync(
            db,
            tagId,
            name,
            description: null,
            preserveDescription: true,
            cancellationToken);

    internal static async Task<int> UpdateTagAndEnqueueProjectionAsync(
        ISqlSugarClient db,
        int tagId,
        string name,
        string? description,
        bool preserveDescription,
        CancellationToken cancellationToken)
    {
        int updated = 0;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            Tag? currentTag = await db.Queryable<Tag>()
                .Where(tag => tag.Id == tagId)
                .FirstAsync(cancellationToken);
            if (currentTag is null)
            {
                return;
            }

            List<int> affectedArticleIds = await db.Queryable<ArticleTag>()
                .Where(link => link.TagId == tagId)
                .Select(link => link.ArticleId)
                .ToListAsync(cancellationToken);
            string normalizedOldName = PublicTagUrlIdentity.NormalizeDisplayName(currentTag.Name);
            string normalizedNewName = PublicTagUrlIdentity.NormalizeDisplayName(name);
            string oldLookupKey = PublicTagUrlIdentity.NormalizeLookupKey(normalizedOldName);
            string newLookupKey = PublicTagUrlIdentity.NormalizeLookupKey(normalizedNewName);
            if (!string.Equals(oldLookupKey, newLookupKey, StringComparison.Ordinal))
            {
                TagUrlAlias? conflictingAlias = await db.Queryable<TagUrlAlias>()
                    .Where(alias => alias.NormalizedName == newLookupKey)
                    .FirstAsync(cancellationToken);
                if (conflictingAlias is not null && conflictingAlias.TagId != tagId)
                {
                    throw new InvalidOperationException("tag_url_identity_reserved");
                }

                if (conflictingAlias is not null)
                {
                    await db.Deleteable<TagUrlAlias>()
                        .Where(alias => alias.NormalizedName == newLookupKey && alias.TagId == tagId)
                        .ExecuteCommandAsync(cancellationToken);
                }

                TagUrlAlias? oldAlias = await db.Queryable<TagUrlAlias>()
                    .Where(alias => alias.NormalizedName == oldLookupKey)
                    .FirstAsync(cancellationToken);
                if (oldAlias is null)
                {
                    await db.Insertable(new TagUrlAlias
                    {
                        NormalizedName = oldLookupKey,
                        TagId = tagId,
                        OriginalName = normalizedOldName,
                        CreatedAtUtc = DateTime.UtcNow
                    }).ExecuteCommandAsync(cancellationToken);
                }
                else if (oldAlias.TagId != tagId)
                {
                    throw new InvalidOperationException("tag_url_identity_conflict");
                }
            }

            updated = preserveDescription
                ? await db.Updateable<Tag>()
                    .SetColumns(tag => tag.Name == normalizedNewName)
                    .Where(tag => tag.Id == tagId)
                    .ExecuteCommandAsync(cancellationToken)
                : await db.Updateable<Tag>()
                    .SetColumns(tag => new Tag
                    {
                        Name = normalizedNewName,
                        Description = description
                    })
                    .Where(tag => tag.Id == tagId)
                    .ExecuteCommandAsync(cancellationToken);
            if (updated > 0)
            {
                await InsertTaxonomyProjectionOutboxAsync(
                    db,
                    affectedArticleIds,
                    ArticleMutationEventTypes.TagUpdated,
                    cancellationToken);
            }
        });
        if (!transaction.IsSuccess)
        {
            throw new InvalidOperationException($"tag projection transaction failed: {transaction.ErrorMessage}");
        }

        return updated;
    }

    internal static async Task<bool> IsTagUrlNameReservedAsync(
        ISqlSugarClient db,
        string name,
        int? exceptTagId,
        CancellationToken cancellationToken)
    {
        string lookupKey = PublicTagUrlIdentity.NormalizeLookupKey(name);
        List<Tag> tags = await db.Queryable<Tag>().ToListAsync(cancellationToken);
        if (tags.Any(tag => tag.Id != exceptTagId
            && string.Equals(PublicTagUrlIdentity.NormalizeLookupKey(tag.Name), lookupKey, StringComparison.Ordinal)))
        {
            return true;
        }

        ISugarQueryable<TagUrlAlias> query = db.Queryable<TagUrlAlias>()
            .Where(alias => alias.NormalizedName == lookupKey);
        if (exceptTagId is int tagId)
        {
            query = query.Where(alias => alias.TagId != tagId);
        }

        return await query.AnyAsync(cancellationToken);
    }

    private static async Task<int> InsertTaxonomyProjectionOutboxAsync(
        ISqlSugarClient db,
        IReadOnlyCollection<int> articleIds,
        string eventType,
        CancellationToken cancellationToken)
    {
        DateTime now = DateTime.UtcNow;
        var events = new List<ArticleMutationOutboxEvent>();
        foreach (int articleId in articleIds.Where(static articleId => articleId > 0).Distinct().Order())
        {
            events.Add(await ArticleMutationOutboxProducer.CreateCurrentAsync(
                    db,
                    articleId,
                    eventType,
                    now,
                    cancellationToken)
                .ConfigureAwait(false));
        }
        if (events.Count == 0)
        {
            return 0;
        }

        int inserted = await db.Insertable(events).ExecuteCommandAsync(cancellationToken);
        if (inserted != events.Count)
        {
            throw new InvalidOperationException(
                $"taxonomy projection outbox insert persisted {inserted} of {events.Count} rows");
        }

        return inserted;
    }

    internal static bool IsRequiredTaxonomyDeliveryDurable(PublicHotArtifactEnqueueResult receipt)
        => receipt.Status switch
        {
            PublicHotArtifactDeliveryStatus.Accepted => true,
            PublicHotArtifactDeliveryStatus.PersistedDirty => true,
            PublicHotArtifactDeliveryStatus.Coalesced => true,
            PublicHotArtifactDeliveryStatus.Cancelled => false,
            PublicHotArtifactDeliveryStatus.Closed => false,
            PublicHotArtifactDeliveryStatus.Failed => false,
            _ => false
        };

    private readonly record struct TaxonomyMetadataMutationPayload(
        bool IsSuccess,
        string Name,
        string? Description,
        bool IsLegacy,
        ErrorDetail Error)
    {
        public static TaxonomyMetadataMutationPayload Success(string name, string? description, bool isLegacy)
            => new(true, name, description, isLegacy, ErrorDetail.None);

        public static TaxonomyMetadataMutationPayload Failure(ErrorDetail error)
            => new(false, string.Empty, null, false, error);
    }

    internal enum TagDeleteOutcome
    {
        Deleted,
        NotFound,
        HasArticleLinks
    }
}
