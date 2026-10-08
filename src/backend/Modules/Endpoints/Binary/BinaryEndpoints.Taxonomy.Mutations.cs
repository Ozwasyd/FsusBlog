using System.Runtime.ExceptionServices;

using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;

using SqlSugar;

namespace FsusBlog.Server.Modules.Endpoints.Binary;

public static partial class BinaryEndpoints
{
    internal enum CategoryMutationOutcome
    {
        Created, Deleted, InUse, NotFound, WriteFailed
    }

    // This is the actual business mutation/enqueue return value, not a common
    // cache/AOT/HotRead generation or a runtime qualification receipt.
    internal sealed record CategoryMutationReceipt(
        CategoryMutationOutcome Outcome,
        int CategoryId,
        string MutationId,
        PublicHotArtifactEnqueueResult? Delivery);

    internal sealed class CategoryMutationDispatchException(
        CategoryMutationReceipt committedMutation,
        Exception innerException)
        : InvalidOperationException("category_mutation_committed_dispatch_failed", innerException)
    {
        internal CategoryMutationReceipt CommittedMutation { get; } = committedMutation;
    }

    internal static async Task<CategoryMutationReceipt> AwaitCategoryMutationForPublicEndpointAsync(
        Task<CategoryMutationReceipt> mutation)
    {
        try
        {
            return await mutation;
        }
        catch (CategoryMutationDispatchException exception)
        {
            // Internal canary callers retain custody; the existing public error
            // pipeline must still see the original cancellation/error type.
            ExceptionDispatchInfo.Capture(exception.InnerException!).Throw();
            throw;
        }
    }

    internal static async Task<CategoryMutationReceipt> CreateCategoryAndDispatchAsync(
        ISqlSugarClient db,
        ICacheInvalidationStore cacheInvalidation,
        ICacheInvalidationDispatcher invalidationDispatcher,
        PublicHotArtifactUpdateQueue publicHotUpdates,
        string name,
        string? description,
        CancellationToken cancellationToken)
    {
        int categoryId = await CreateCategoryAsync(db, name, description, cancellationToken);
        var receipt = new CategoryMutationReceipt(
            categoryId > 0 ? CategoryMutationOutcome.Created : CategoryMutationOutcome.WriteFailed,
            categoryId,
            $"taxonomy:{Guid.CreateVersion7():N}",
            Delivery: null);
        if (categoryId <= 0)
        {
            return receipt;
        }

        using var auditScope = AuditLogScope.Push(
            AuditSourceCatalog.Category,
            AuditTypeCatalog.Audit,
            new KeyValuePair<string, object?>("AuditAction", "category.create"),
            new KeyValuePair<string, object?>("CategoryName", name));
        return await DispatchCategoryMutationAsync(
            receipt, cacheInvalidation, invalidationDispatcher, publicHotUpdates,
            "taxonomy-category-created");
    }

    internal static async Task<CategoryMutationReceipt> DeleteCategoryAndDispatchAsync(
        ISqlSugarClient db,
        ICacheInvalidationStore cacheInvalidation,
        ICacheInvalidationDispatcher invalidationDispatcher,
        PublicHotArtifactUpdateQueue publicHotUpdates,
        int categoryId,
        CancellationToken cancellationToken)
    {
        bool hasArticles = await db.Queryable<Article>().AnyAsync(
            article => article.CategoryId == categoryId && !article.IsDeleted && article.Status != ArticleStatus.Deleted,
            cancellationToken);
        if (hasArticles)
        {
            return new(CategoryMutationOutcome.InUse, categoryId, string.Empty, Delivery: null);
        }

        int deleteCount = await db.Deleteable<Category>().In(categoryId).ExecuteCommandAsync(cancellationToken);
        if (deleteCount <= 0)
        {
            return new(CategoryMutationOutcome.NotFound, categoryId, string.Empty, Delivery: null);
        }

        var receipt = new CategoryMutationReceipt(
            CategoryMutationOutcome.Deleted, categoryId, $"taxonomy:{Guid.CreateVersion7():N}", Delivery: null);
        using var auditScope = AuditLogScope.Push(
            AuditSourceCatalog.Category,
            AuditTypeCatalog.Audit,
            new KeyValuePair<string, object?>("AuditAction", "category.delete"),
            new KeyValuePair<string, object?>("CategoryId", categoryId));
        return await DispatchCategoryMutationAsync(
            receipt, cacheInvalidation, invalidationDispatcher, publicHotUpdates,
            "taxonomy-category-deleted");
    }

    private static async Task<CategoryMutationReceipt> DispatchCategoryMutationAsync(
        CategoryMutationReceipt receipt,
        ICacheInvalidationStore cacheInvalidation,
        ICacheInvalidationDispatcher invalidationDispatcher,
        PublicHotArtifactUpdateQueue publicHotUpdates,
        string reason)
    {
        try
        {
            // Once the database committed, finish the existing invalidation and
            // durable enqueue even if the initiating HTTP request disconnects.
            await cacheInvalidation.RemoveAsync(
                CachePolicyId.TaxonomyExactMetadataFrame,
                TaxonomyExactMetadataCache.ForCategory(receipt.CategoryId), CancellationToken.None);
            await invalidationDispatcher.InvalidateCategoryTagAsync(receipt.MutationId, CancellationToken.None);
            PublicHotArtifactEnqueueResult delivery = await publicHotUpdates.EnqueueAsync(
                PublicHotArtifactDeliveryClass.RequiredTaxonomy, null, reason,
                cancellationToken: CancellationToken.None);
            return receipt with
            {
                Delivery = delivery
            };
        }
        catch (Exception exception)
        {
            // Retain exact entity custody for cleanup after a post-commit failure.
            // A null enqueue receipt cannot establish a durable obligation.
            throw new CategoryMutationDispatchException(receipt, exception);
        }
    }
}
