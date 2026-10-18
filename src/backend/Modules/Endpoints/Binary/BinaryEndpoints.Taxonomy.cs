using System.Buffers;
using System.Data.Common;
using System.Diagnostics;
using System.Text;

using FsusBlog.Server.Services.Articles;
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

        group.MapGet("/category/{id:int}.aeds", ReadCategoryExactMetadataAsync)
        .AllowAnonymous()
        .RequireRateLimiting("public_read")
        .WithRiskAction(RiskActionNames.PublicRead, "taxonomy.category")
        .AddEndpointFilter<RiskAwarePublicReadFilter>();

        group.MapGet("/tag/by-name.aeds", ReadTagExactMetadataByNameAsync)
        .AllowAnonymous()
        .RequireRateLimiting("public_read")
        .WithRiskAction(RiskActionNames.PublicRead, "taxonomy.tag")
        .AddEndpointFilter<RiskAwarePublicReadFilter>();

        group.MapGet("/tag/{id:int}.aeds", ReadTagExactMetadataAsync)
        .AllowAnonymous()
        .RequireRateLimiting("public_read")
        .WithRiskAction(RiskActionNames.PublicRead, "taxonomy.tag")
        .AddEndpointFilter<RiskAwarePublicReadFilter>();

        group.MapPost("/category", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            ISqlSugarClient db,
            ICacheInvalidationStore cacheInvalidation,
            ICacheInvalidationDispatcher invalidationDispatcher,
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
            await cacheInvalidation.RemoveAsync(CachePolicyId.TaxonomyExactMetadataFrame, TaxonomyExactMetadataCache.ForCategory(newId), CancellationToken.None);
            await invalidationDispatcher.InvalidateCategoryTagAsync(CancellationToken.None);
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
            ICacheInvalidationStore cacheInvalidation,
            ICacheInvalidationDispatcher invalidationDispatcher,
            PublicHotArtifactUpdateQueue publicHotUpdates,
            IPublicAotInvalidationService publicAotInvalidation,
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

            TaxonomyUpdateApplyResult apply = await UpdateCategoryAndEnqueueProjectionAsync(
                db,
                id,
                trimmedName,
                normalizedDescription,
                preserveDescription: request.IsLegacy,
                cancellationToken);
            if (apply.Outcome == TaxonomyUpdateOutcome.NotFound)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.NotFound, "操作失败：未找到对应的分类记录"), aeds);
            }

            if (apply.Outcome == TaxonomyUpdateOutcome.NoOp)
            {
                return BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess);
            }

            using var _ = AuditLogScope.Push(
                AuditSourceCatalog.Category,
                AuditTypeCatalog.Audit,
                new KeyValuePair<string, object?>("AuditAction", "category.update"),
                new KeyValuePair<string, object?>("CategoryId", id),
                new KeyValuePair<string, object?>("CategoryName", trimmedName));
            await DispatchTaxonomyUpdateSideEffectsAsync(
                apply,
                id,
                isCategory: true,
                cacheInvalidation,
                invalidationDispatcher,
                publicAotInvalidation,
                "taxonomy-category-updated",
                CancellationToken.None);
            if (apply.NameChanged)
            {
                PublicHotArtifactEnqueueResult delivery = await publicHotUpdates.EnqueueAsync(
                    PublicHotArtifactDeliveryClass.RequiredTaxonomy,
                    null,
                    "taxonomy-category-updated",
                    cancellationToken: CancellationToken.None);
                if (!IsRequiredTaxonomyDeliveryDurable(delivery))
                {
                    return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.InfraFailure, "分类已更新，但 PublicHot 重建交付未确认"), aeds);
                }
            }
            return BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess);
        })
        .RequireAdminPermission(AdminPermissions.ArticleWrite)
        .AddEndpointFilterWithMetadata<RequiresPowFilter>();

        group.MapDelete("/category/{id:int}", static async Task<BinaryFrameResult> (
            int id,
            ISqlSugarClient db,
            ICacheInvalidationStore cacheInvalidation,
            ICacheInvalidationDispatcher invalidationDispatcher,
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
            await cacheInvalidation.RemoveAsync(CachePolicyId.TaxonomyExactMetadataFrame, TaxonomyExactMetadataCache.ForCategory(id), CancellationToken.None);
            await invalidationDispatcher.InvalidateCategoryTagAsync(CancellationToken.None);
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
            ICacheInvalidationStore cacheInvalidation,
            ICacheInvalidationDispatcher invalidationDispatcher,
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
            await cacheInvalidation.RemoveAsync(CachePolicyId.TaxonomyExactMetadataFrame, TaxonomyExactMetadataCache.ForTag(newId), CancellationToken.None);
            await invalidationDispatcher.InvalidateCategoryTagAsync(CancellationToken.None);
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
            ICacheInvalidationStore cacheInvalidation,
            ICacheInvalidationDispatcher invalidationDispatcher,
            PublicHotArtifactUpdateQueue publicHotUpdates,
            IPublicAotInvalidationService publicAotInvalidation,
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

            TaxonomyUpdateApplyResult apply = await UpdateTagAndEnqueueProjectionAsync(
                db,
                id,
                trimmedName,
                normalizedDescription,
                preserveDescription: request.IsLegacy,
                cancellationToken);
            if (apply.Outcome == TaxonomyUpdateOutcome.NotFound)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.NotFound, "目标标签不存在"), aeds);
            }

            if (apply.Outcome == TaxonomyUpdateOutcome.NoOp)
            {
                return BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess);
            }

            using var _ = AuditLogScope.Push(
                AuditSourceCatalog.Tag,
                AuditTypeCatalog.Audit,
                new KeyValuePair<string, object?>("AuditAction", "tag.update"),
                new KeyValuePair<string, object?>("TagId", id),
                new KeyValuePair<string, object?>("TagName", trimmedName));
            await DispatchTaxonomyUpdateSideEffectsAsync(
                apply,
                id,
                isCategory: false,
                cacheInvalidation,
                invalidationDispatcher,
                publicAotInvalidation,
                "taxonomy-tag-updated",
                CancellationToken.None);
            if (apply.NameChanged)
            {
                PublicHotArtifactEnqueueResult delivery = await publicHotUpdates.EnqueueAsync(
                    PublicHotArtifactDeliveryClass.RequiredTaxonomy,
                    null,
                    "taxonomy-tag-updated",
                    cancellationToken: CancellationToken.None);
                if (!IsRequiredTaxonomyDeliveryDurable(delivery))
                {
                    return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.InfraFailure, "标签已更新，但 PublicHot 重建交付未确认"), aeds);
                }
            }
            return BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess);
        })
        .RequireAdminPermission(AdminPermissions.ArticleWrite)
        .AddEndpointFilterWithMetadata<RequiresPowFilter>();

        group.MapDelete("/tag/{id:int}", static async Task<BinaryFrameResult> (
            int id,
            ISqlSugarClient db,
            ICacheInvalidationStore cacheInvalidation,
            ICacheInvalidationDispatcher invalidationDispatcher,
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
            await cacheInvalidation.RemoveAsync(CachePolicyId.TaxonomyExactMetadataFrame, TaxonomyExactMetadataCache.ForTag(id), CancellationToken.None);
            await invalidationDispatcher.InvalidateCategoryTagAsync(CancellationToken.None);
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


    internal static async Task<IResult> ReadCategoryExactMetadataAsync(
        int id,
        ISqlSugarClient db,
        IOwnedFrameCache ownedFrameCache,
        IAedsEncoder aeds,
        CancellationToken cancellationToken = default)
    {
        if (id <= 0)
        {
            return TaxonomyExactMetadataNotFound(aeds, "分类不存在");
        }

        return await ReadTaxonomyExactMetadataAsync(
            TaxonomyExactMetadataCache.ForCategory(id),
            () => LoadCategoryExactMetadataAsync(db, id, cancellationToken),
            ownedFrameCache,
            aeds,
            "分类不存在",
            cancellationToken);
    }

    internal static async Task<IResult> ReadTagExactMetadataAsync(
        int id,
        ISqlSugarClient db,
        IOwnedFrameCache ownedFrameCache,
        IAedsEncoder aeds,
        CancellationToken cancellationToken = default)
    {
        if (id <= 0)
        {
            return TaxonomyExactMetadataNotFound(aeds, "标签不存在");
        }

        return await ReadTaxonomyExactMetadataAsync(
            TaxonomyExactMetadataCache.ForTag(id),
            () => LoadTagExactMetadataAsync(db, id, cancellationToken),
            ownedFrameCache,
            aeds,
            "标签不存在",
            cancellationToken);
    }

    internal static async Task<IResult> ReadTagExactMetadataByNameAsync(
        string? name,
        ISqlSugarClient db,
        IOwnedFrameCache ownedFrameCache,
        IAedsEncoder aeds,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return TaxonomyExactMetadataNotFound(aeds, "标签不存在");
        }

        int? tagId = await PublicTagUrlIdentity.ResolveCanonicalTagIdAsync(db, name, cancellationToken);
        if (tagId is not > 0)
        {
            return TaxonomyExactMetadataNotFound(aeds, "标签不存在");
        }

        return await ReadTagExactMetadataAsync(tagId.Value, db, ownedFrameCache, aeds, cancellationToken);
    }

    internal static async Task<IResult> ReadTaxonomyExactMetadataAsync(
        string identity,
        Func<Task<TaxonomyExactMetadataCoreModel?>> load,
        IOwnedFrameCache ownedFrameCache,
        IAedsEncoder aeds,
        string notFoundMessage,
        CancellationToken cancellationToken = default)
    {
        OwnedFrameCacheReadResult frame = await ownedFrameCache.TryGetOwnedFrameAsync(
            CachePolicyId.TaxonomyExactMetadataFrame,
            identity,
            AedsFrameType.TaxonomyExactMetadata,
            cancellationToken);
        if (frame.Hit && frame.Lease is not null)
        {
            return BinaryResults.PreencodedFrame(frame.Lease);
        }

        TaxonomyExactMetadataCoreModel? metadata = await load();
        if (metadata is null)
        {
            return TaxonomyExactMetadataNotFound(aeds, notFoundMessage);
        }

        TaxonomyExactMetadataCoreModel value = metadata.Value;
        OwnedAedsFrame ownedFrame = BuildCachedFrame(
            AedsFrameType.TaxonomyExactMetadata,
            writer => PodBinaryCodec.WriteTaxonomyExactMetadata(value, writer));
        return await StoreAndReturnOwnedFrameAsync(
            ownedFrameCache,
            CachePolicyId.TaxonomyExactMetadataFrame,
            identity,
            ownedFrame,
            TimeSpan.FromMinutes(10),
            cancellationToken);
    }

    internal static IResult TaxonomyExactMetadataNotFound(IAedsEncoder aeds, string message)
        => BinaryResults.FromError(ErrorDetail.Create(ErrorCode.NotFound, message), aeds);

    private static async Task<TaxonomyExactMetadataCoreModel?> LoadCategoryExactMetadataAsync(
        ISqlSugarClient db,
        int id,
        CancellationToken cancellationToken)
    {
        Category? category = await db.Queryable<Category>()
            .Where(item => item.Id == id)
            .FirstAsync(cancellationToken);
        if (category is null)
        {
            return null;
        }

        return new TaxonomyExactMetadataCoreModel(category.Id, category.Name ?? string.Empty, category.Description);
    }

    private static async Task<TaxonomyExactMetadataCoreModel?> LoadTagExactMetadataAsync(
        ISqlSugarClient db,
        int id,
        CancellationToken cancellationToken)
    {
        Tag? tag = await db.Queryable<Tag>()
            .Where(item => item.Id == id)
            .FirstAsync(cancellationToken);
        if (tag is null)
        {
            return null;
        }

        return new TaxonomyExactMetadataCoreModel(tag.Id, tag.Name ?? string.Empty, tag.Description);
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

    internal static async Task<TaxonomyUpdateApplyResult> UpdateCategoryAndEnqueueProjectionAsync(
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

    internal static async Task<TaxonomyUpdateApplyResult> UpdateCategoryAndEnqueueProjectionAsync(
        ISqlSugarClient db,
        int categoryId,
        string name,
        string? description,
        bool preserveDescription,
        CancellationToken cancellationToken)
    {
        TaxonomyUpdateApplyResult result = new(TaxonomyUpdateOutcome.NotFound, false, false);
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(db, cancellationToken).ConfigureAwait(false);
            Category? current = await db.Queryable<Category>()
                .Where(category => category.Id == categoryId)
                .FirstAsync(cancellationToken);
            if (current is null)
            {
                result = new(TaxonomyUpdateOutcome.NotFound, false, false);
                return;
            }

            TaxonomyFieldChange change = ClassifyTaxonomyFieldChange(
                current.Name ?? string.Empty,
                current.Description,
                name,
                description,
                preserveDescription,
                treatNameAsTag: false);
            if (change.IsNoOp)
            {
                result = new(TaxonomyUpdateOutcome.NoOp, false, false);
                return;
            }

            if (!change.NameChanged)
            {
                int descriptionUpdated = await db.Updateable<Category>()
                    .SetColumns(category => category.Description == description)
                    .Where(category => category.Id == categoryId)
                    .ExecuteCommandAsync(cancellationToken);
                result = descriptionUpdated > 0
                    ? new(TaxonomyUpdateOutcome.Updated, false, true)
                    : new(TaxonomyUpdateOutcome.NotFound, false, false);
                return;
            }

            List<int> affectedArticleIds = await db.Queryable<Article>()
                .ClearFilter()
                .Where(article => article.CategoryId == categoryId)
                .Select(article => article.Id)
                .ToListAsync(cancellationToken);
            int updated = preserveDescription
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
            if (updated <= 0)
            {
                result = new(TaxonomyUpdateOutcome.NotFound, false, false);
                return;
            }

            await InsertTaxonomyProjectionOutboxAsync(
                db,
                affectedArticleIds,
                ArticleMutationEventTypes.CategoryUpdated,
                cancellationToken);
            result = new(TaxonomyUpdateOutcome.Updated, true, change.DescriptionChanged);
        });
        if (!transaction.IsSuccess)
        {
            throw new InvalidOperationException($"category projection transaction failed: {transaction.ErrorMessage}");
        }

        return result;
    }

    internal static async Task<TaxonomyUpdateApplyResult> UpdateTagAndEnqueueProjectionAsync(
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

    internal static async Task<TaxonomyUpdateApplyResult> UpdateTagAndEnqueueProjectionAsync(
        ISqlSugarClient db,
        int tagId,
        string name,
        string? description,
        bool preserveDescription,
        CancellationToken cancellationToken)
    {
        TaxonomyUpdateApplyResult result = new(TaxonomyUpdateOutcome.NotFound, false, false);
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(db, cancellationToken).ConfigureAwait(false);
            Tag? currentTag = await db.Queryable<Tag>()
                .Where(tag => tag.Id == tagId)
                .FirstAsync(cancellationToken);
            if (currentTag is null)
            {
                result = new(TaxonomyUpdateOutcome.NotFound, false, false);
                return;
            }

            TaxonomyFieldChange change = ClassifyTaxonomyFieldChange(
                currentTag.Name ?? string.Empty,
                currentTag.Description,
                name,
                description,
                preserveDescription,
                treatNameAsTag: true);
            if (change.IsNoOp)
            {
                result = new(TaxonomyUpdateOutcome.NoOp, false, false);
                return;
            }

            if (!change.NameChanged)
            {
                int descriptionUpdated = await db.Updateable<Tag>()
                    .SetColumns(tag => tag.Description == description)
                    .Where(tag => tag.Id == tagId)
                    .ExecuteCommandAsync(cancellationToken);
                result = descriptionUpdated > 0
                    ? new(TaxonomyUpdateOutcome.Updated, false, true)
                    : new(TaxonomyUpdateOutcome.NotFound, false, false);
                return;
            }

            List<int> affectedArticleIds = await db.Queryable<ArticleTag>()
                .Where(link => link.TagId == tagId)
                .Select(link => link.ArticleId)
                .ToListAsync(cancellationToken);
            string normalizedOldName = PublicTagUrlIdentity.NormalizeDisplayName(currentTag.Name ?? string.Empty);
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

            int updated = preserveDescription
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
            if (updated <= 0)
            {
                result = new(TaxonomyUpdateOutcome.NotFound, false, false);
                return;
            }

            await InsertTaxonomyProjectionOutboxAsync(
                db,
                affectedArticleIds,
                ArticleMutationEventTypes.TagUpdated,
                cancellationToken);
            result = new(TaxonomyUpdateOutcome.Updated, true, change.DescriptionChanged);
        });
        if (!transaction.IsSuccess)
        {
            throw new InvalidOperationException($"tag projection transaction failed: {transaction.ErrorMessage}");
        }

        return result;
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

        foreach (ArticleMutationOutboxEvent outbox in events)
        {
            await ArticleSourceGenerationAuthority.RecordMutationAsync(db, outbox.EventId, cancellationToken).ConfigureAwait(false);
        }
        return inserted;
    }

    internal static TaxonomyFieldChange ClassifyTaxonomyFieldChange(
        string persistedName,
        string? persistedDescription,
        string incomingName,
        string? incomingDescription,
        bool preserveDescription,
        bool treatNameAsTag)
    {
        string normalizedPersistedName = treatNameAsTag
            ? PublicTagUrlIdentity.NormalizeDisplayName(persistedName)
            : persistedName.Trim();
        bool nameChanged = !string.Equals(normalizedPersistedName, incomingName, StringComparison.Ordinal);
        if (preserveDescription)
        {
            return new TaxonomyFieldChange(nameChanged, false);
        }

        _ = TryNormalizeTaxonomyDescription(persistedDescription, out string? normalizedPersistedDescription);
        bool descriptionChanged = !string.Equals(
            normalizedPersistedDescription,
            incomingDescription,
            StringComparison.Ordinal);
        return new TaxonomyFieldChange(nameChanged, descriptionChanged);
    }

    internal static async Task DispatchTaxonomyUpdateSideEffectsAsync(
        TaxonomyUpdateApplyResult apply,
        int id,
        bool isCategory,
        ICacheInvalidationStore cacheInvalidation,
        ICacheInvalidationDispatcher invalidationDispatcher,
        IPublicAotInvalidationService publicAotInvalidation,
        string bumpReason,
        CancellationToken cancellationToken)
    {
        if (apply.Outcome != TaxonomyUpdateOutcome.Updated)
        {
            return;
        }

        string exactIdentity = isCategory
            ? TaxonomyExactMetadataCache.ForCategory(id)
            : TaxonomyExactMetadataCache.ForTag(id);
        await cacheInvalidation.RemoveAsync(
            CachePolicyId.TaxonomyExactMetadataFrame,
            exactIdentity,
            cancellationToken);

        if (apply.NameChanged)
        {
            await invalidationDispatcher.InvalidateCategoryTagAsync(cancellationToken);
            return;
        }

        string filterRouteKey = isCategory
            ? PublicRouteIdentity.BuildCategoryRouteKey(id)
            : PublicRouteIdentity.BuildTagIdRouteKey(id);
        string mutationId = $"taxonomy-metadata:{Guid.CreateVersion7():N}";
        await publicAotInvalidation
            .InvalidateFilterRouteFamilyAsync(filterRouteKey, mutationId, cancellationToken);
        await invalidationDispatcher
            .InvalidateTaxonomyMetadataAsync(filterRouteKey, mutationId, cancellationToken);
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


    internal readonly record struct TaxonomyFieldChange(bool NameChanged, bool DescriptionChanged)
    {
        public bool IsNoOp => !NameChanged && !DescriptionChanged;

        public bool IsDescriptionOnly => DescriptionChanged && !NameChanged;
    }

    internal readonly record struct TaxonomyUpdateApplyResult(
        TaxonomyUpdateOutcome Outcome,
        bool NameChanged,
        bool DescriptionChanged)
    {
        public bool IsDescriptionOnly => DescriptionChanged && !NameChanged;
    }

    internal enum TaxonomyUpdateOutcome
    {
        NotFound,
        NoOp,
        Updated
    }

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
