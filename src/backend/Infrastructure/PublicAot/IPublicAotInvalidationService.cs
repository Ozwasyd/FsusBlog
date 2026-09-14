using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public interface IPublicAotInvalidationService
{
    Task InvalidateAllAsync(CancellationToken cancellationToken = default);
    Task InvalidatePageAsync(PublicPageId pageId, CancellationToken cancellationToken = default);
    Task InvalidateRouteAsync(PublicPageId pageId, string routeKey, CancellationToken cancellationToken = default);
    Task InvalidateArticleMutationAsync(
        int? articleId,
        IEnumerable<int>? categoryIds,
        IEnumerable<int>? tagIds,
        CancellationToken cancellationToken = default);
    Task InvalidateArticleMutationAsync(
        int? articleId,
        IEnumerable<int>? categoryIds,
        IEnumerable<int>? tagIds,
        string mutationId,
        CancellationToken cancellationToken)
        => InvalidateArticleMutationAsync(articleId, categoryIds, tagIds, cancellationToken);
    Task InvalidateArticleMutationBatchAsync(
        IEnumerable<int> articleIds,
        IEnumerable<int>? categoryIds,
        IEnumerable<int>? tagIds,
        CancellationToken cancellationToken = default);
    Task InvalidateArticleMutationBatchAsync(
        IEnumerable<int> articleIds,
        IEnumerable<int>? categoryIds,
        IEnumerable<int>? tagIds,
        string mutationId,
        CancellationToken cancellationToken)
        => InvalidateArticleMutationBatchAsync(articleIds, categoryIds, tagIds, cancellationToken);
    Task InvalidateSeoAsync(CancellationToken cancellationToken = default);
    Task InvalidateSeoArtifactsAsync(CancellationToken cancellationToken = default)
        => InvalidateSeoAsync(cancellationToken);
    Task InvalidateFilterRouteFamilyAsync(string filterRouteKey, CancellationToken cancellationToken = default);
    Task InvalidateFilterRouteFamilyAsync(
        string filterRouteKey,
        string mutationId,
        CancellationToken cancellationToken)
        => InvalidateFilterRouteFamilyAsync(filterRouteKey, cancellationToken);
    Task InvalidateAboutAsync(CancellationToken cancellationToken = default);
    Task InvalidateStaticPageAsync(PublicPageKind kind, CancellationToken cancellationToken = default);
    Task InvalidateStaticPageAsync(
        PublicPageKind kind,
        string mutationId,
        CancellationToken cancellationToken)
        => InvalidateStaticPageAsync(kind, cancellationToken);
}
