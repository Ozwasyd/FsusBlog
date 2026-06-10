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
    Task InvalidateArticleMutationBatchAsync(
        IEnumerable<int> articleIds,
        IEnumerable<int>? categoryIds,
        IEnumerable<int>? tagIds,
        CancellationToken cancellationToken = default);
    Task InvalidateSeoAsync(CancellationToken cancellationToken = default);
    Task InvalidateAboutAsync(CancellationToken cancellationToken = default);
    Task InvalidateStaticPageAsync(PublicPageKind kind, CancellationToken cancellationToken = default);
}
