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
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Taxonomy;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Outputs;
using SqlSugar;
using System.Buffers;
using System.Data.Common;
using System.Diagnostics;

namespace FsusBlog.Server.Modules.Endpoints.Binary;

public static partial class BinaryEndpoints
{
    private static void MapBinaryTaxonomyEndpoints(IEndpointRouteBuilder group)
    {
        group.MapGet("/category", static async Task<IResult> (
            ISqlSugarClient db,
            IUnifiedCache cache,
            IAedsEncoder aeds) =>
        {
            string identity = await ResolveTaxonomyFrameIdentityAsync(cache);
            CacheReadResult<ReadOnlyMemory<byte>> frame = await cache.TryGetRawReadonlyAsync(CachePolicyId.CategoryFrame, identity);
            if (frame.Hit && frame.Value.Length > 0)
            {
                FsusObservability.RecordTaxonomyFrameCache("category", hit: true);
                return BinaryResults.PreencodedFrame(frame.Value);
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

            byte[] payload = PodBinaryCodec.EncodeCategoryList(result);
            byte[] encodedFrame = aeds.Encode(AedsFrameType.CategoryList, payload);
            await cache.SetRawAsync(CachePolicyId.CategoryFrame, identity, encodedFrame, TimeSpan.FromMinutes(10));
            FsusObservability.RecordTaxonomyFrameColdMiss("category", stopwatch.Elapsed);
            return BinaryResults.PreencodedFrame(encodedFrame);
        })
        .AllowAnonymous()
        .RequireRateLimiting("public_read")
        .WithRiskAction(RiskActionNames.PublicRead, "taxonomy.category")
        .AddEndpointFilter<RiskAwarePublicReadFilter>();

        group.MapGet("/tag", static async Task<IResult> (
            ISqlSugarClient db,
            IUnifiedCache cache,
            IAedsEncoder aeds) =>
        {
            string identity = await ResolveTaxonomyFrameIdentityAsync(cache);
            CacheReadResult<ReadOnlyMemory<byte>> frame = await cache.TryGetRawReadonlyAsync(CachePolicyId.TagFrame, identity);
            if (frame.Hit && frame.Value.Length > 0)
            {
                FsusObservability.RecordTaxonomyFrameCache("tag", hit: true);
                return BinaryResults.PreencodedFrame(frame.Value);
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

            byte[] payload = PodBinaryCodec.EncodeTagWithCountList(result);
            byte[] encodedFrame = aeds.Encode(AedsFrameType.TagList, payload);
            await cache.SetRawAsync(CachePolicyId.TagFrame, identity, encodedFrame, TimeSpan.FromMinutes(10));
            FsusObservability.RecordTaxonomyFrameColdMiss("tag", stopwatch.Elapsed);
            return BinaryResults.PreencodedFrame(encodedFrame);
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
            var nameResult = await ReadNameMutationAsync(httpContext, aeds, AedsFrameType.CategoryWriteRequest, cancellationToken);
            if (!nameResult.IsSuccess)
            {
                return BinaryResults.FromError(nameResult.Error, aeds);
            }

            string trimmedName = nameResult.Name.Trim();
            if (string.IsNullOrWhiteSpace(trimmedName))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "分类名称不能为空"), aeds);
            }

            bool exists = await db.Queryable<Category>().AnyAsync(c => c.Name == trimmedName);
            if (exists)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, $"分类“{trimmedName}”已存在"), aeds);
            }

            int newId = await db.Insertable(new Category { Name = trimmedName }).ExecuteReturnIdentityAsync();
            if (newId <= 0)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.InfraFailure, "由于数据库写入异常，分类创建失败"), aeds);
            }

            using var _ = AuditLogScope.Push(
                AuditSourceCatalog.Category,
                AuditTypeCatalog.Audit,
                new KeyValuePair<string, object?>("AuditAction", "category.create"),
                new KeyValuePair<string, object?>("CategoryName", trimmedName));
            await taxonomyProjection.BumpFrameVersionAsync("taxonomy-category-created", cancellationToken);
            await httpCacheInvalidator.InvalidateAsync(CacheTag.Category, CacheTag.ArticleList);
            publicHotUpdates.TryEnqueue(null, "taxonomy-category-created");
            return BinaryResults.Frame(aeds, AedsFrameType.MutationId, writer => PodBinaryCodec.WriteMutationId(newId, writer));
        })
        .RequireAdminPermission(AdminPermissions.ArticleWrite)
        .AddEndpointFilter<RequiresPowFilter>();

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
            var nameResult = await ReadNameMutationAsync(httpContext, aeds, AedsFrameType.CategoryWriteRequest, cancellationToken);
            if (!nameResult.IsSuccess)
            {
                return BinaryResults.FromError(nameResult.Error, aeds);
            }

            string trimmedName = nameResult.Name.Trim();
            if (string.IsNullOrWhiteSpace(trimmedName))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "分类名称不能为空"), aeds);
            }

            bool exists = await db.Queryable<Category>()
                .Where(c => c.Name == trimmedName && c.Id != id)
                .AnyAsync();
            if (exists)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, $"该分类名称“{trimmedName}”已被其他分类占用"), aeds);
            }

            int updateCount = await db.Updateable<Category>()
                .SetColumns(c => c.Name == trimmedName)
                .Where(c => c.Id == id)
                .ExecuteCommandAsync();
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
            await taxonomyProjection.BumpFrameVersionAsync("taxonomy-category-updated", cancellationToken);
            await httpCacheInvalidator.InvalidateAsync(CacheTag.Category, CacheTag.ArticleList);
            publicHotUpdates.TryEnqueue(null, "taxonomy-category-updated");
            return BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess);
        })
        .RequireAdminPermission(AdminPermissions.ArticleWrite)
        .AddEndpointFilter<RequiresPowFilter>();

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
            await taxonomyProjection.BumpFrameVersionAsync("taxonomy-category-deleted", cancellationToken);
            await httpCacheInvalidator.InvalidateAsync(CacheTag.Category, CacheTag.ArticleList);
            publicHotUpdates.TryEnqueue(null, "taxonomy-category-deleted");
            return BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess);
        })
        .RequireAdminPermission(AdminPermissions.ArticleWrite)
        .AddEndpointFilter<RequiresPowFilter>();

        group.MapPost("/tag", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            ISqlSugarClient db,
            IHttpCacheInvalidator httpCacheInvalidator,
            ITaxonomyCountProjectionService taxonomyProjection,
            PublicHotArtifactUpdateQueue publicHotUpdates,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var nameResult = await ReadNameMutationAsync(httpContext, aeds, AedsFrameType.TagWriteRequest, cancellationToken);
            if (!nameResult.IsSuccess)
            {
                return BinaryResults.FromError(nameResult.Error, aeds);
            }

            string trimmedName = nameResult.Name.Trim();
            if (string.IsNullOrWhiteSpace(trimmedName))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "标签名称不能为空"), aeds);
            }

            bool exists = await db.Queryable<Tag>().AnyAsync(t => t.Name == trimmedName);
            if (exists)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, $"标签 [{trimmedName}] 已存在"), aeds);
            }

            int newId = await db.Insertable(new Tag { Name = trimmedName }).ExecuteReturnIdentityAsync();
            if (newId <= 0)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.InfraFailure, "标签创建失败，数据库写入异常"), aeds);
            }

            using var _ = AuditLogScope.Push(
                AuditSourceCatalog.Tag,
                AuditTypeCatalog.Audit,
                new KeyValuePair<string, object?>("AuditAction", "tag.create"),
                new KeyValuePair<string, object?>("TagName", trimmedName));
            await taxonomyProjection.BumpFrameVersionAsync("taxonomy-tag-created", cancellationToken);
            await httpCacheInvalidator.InvalidateAsync(CacheTag.Tag, CacheTag.ArticleList);
            publicHotUpdates.TryEnqueue(null, "taxonomy-tag-created");
            return BinaryResults.Frame(aeds, AedsFrameType.MutationId, writer => PodBinaryCodec.WriteMutationId(newId, writer));
        })
        .RequireAdminPermission(AdminPermissions.ArticleWrite)
        .AddEndpointFilter<RequiresPowFilter>();

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
            var nameResult = await ReadNameMutationAsync(httpContext, aeds, AedsFrameType.TagWriteRequest, cancellationToken);
            if (!nameResult.IsSuccess)
            {
                return BinaryResults.FromError(nameResult.Error, aeds);
            }

            string trimmedName = nameResult.Name.Trim();
            if (string.IsNullOrWhiteSpace(trimmedName))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "标签名称不能为空"), aeds);
            }

            bool exists = await db.Queryable<Tag>()
                .Where(t => t.Name == trimmedName && t.Id != id)
                .AnyAsync();
            if (exists)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, $"标签名称 [{trimmedName}] 已被其他记录占用"), aeds);
            }

            int updateCount = await db.Updateable<Tag>()
                .SetColumns(t => t.Name == trimmedName)
                .Where(t => t.Id == id)
                .ExecuteCommandAsync();
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
            await taxonomyProjection.BumpFrameVersionAsync("taxonomy-tag-updated", cancellationToken);
            await httpCacheInvalidator.InvalidateAsync(CacheTag.Tag, CacheTag.ArticleList);
            publicHotUpdates.TryEnqueue(null, "taxonomy-tag-updated");
            return BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess);
        })
        .RequireAdminPermission(AdminPermissions.ArticleWrite)
        .AddEndpointFilter<RequiresPowFilter>();

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
            await taxonomyProjection.BumpFrameVersionAsync("taxonomy-tag-deleted", cancellationToken);
            await httpCacheInvalidator.InvalidateAsync(CacheTag.Tag, CacheTag.ArticleList);
            publicHotUpdates.TryEnqueue(null, "taxonomy-tag-deleted");
            return BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess);
        })
        .RequireAdminPermission(AdminPermissions.ArticleWrite)
        .AddEndpointFilter<RequiresPowFilter>();
    }

    private static async Task<string> ResolveTaxonomyFrameIdentityAsync(IUnifiedCache cache)
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

    internal enum TagDeleteOutcome
    {
        Deleted,
        NotFound,
        HasArticleLinks
    }
}
