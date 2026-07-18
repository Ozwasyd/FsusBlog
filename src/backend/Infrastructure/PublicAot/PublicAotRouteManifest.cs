using FsusBlog.Server.Entities;
using FsusBlog.Shared.Contracts.Outputs;
using SqlSugar;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public sealed record PublicAotRouteDescriptor(
    PublicPageId PageId,
    PublicPageKind Kind,
    string RouteKey,
    string Path,
    string CanonicalPath,
    IReadOnlyList<string> DependencyKeys,
    int Priority);

public sealed record PublicAotRouteManifestResponse(
    string Scope,
    DateTimeOffset GeneratedAtUtc,
    IReadOnlyList<PublicAotRouteDescriptor> Routes);

public sealed record PublicAotRouteManifestScope(
    string Scope,
    DateTimeOffset? ChangedSinceUtc,
    int? Limit)
{
    public bool IsHot => string.Equals(Scope, "hot", StringComparison.OrdinalIgnoreCase);
    public bool IsChanged => ChangedSinceUtc.HasValue;
    public bool IsAll => string.Equals(Scope, "all", StringComparison.OrdinalIgnoreCase);

    public static PublicAotRouteManifestScope All { get; } = new("all", null, null);

    public static PublicAotRouteManifestScope FromQuery(string? scope, string? changedSince)
    {
        string normalizedScope = string.IsNullOrWhiteSpace(scope)
            ? "all"
            : scope.Trim().ToLowerInvariant();

        DateTimeOffset? changedSinceUtc = null;
        if (!string.IsNullOrWhiteSpace(changedSince) &&
            DateTimeOffset.TryParse(changedSince, out DateTimeOffset parsed))
        {
            changedSinceUtc = parsed.ToUniversalTime();
            normalizedScope = "changed";
        }

        return normalizedScope switch
        {
            "hot" => new("hot", null, 64),
            "changed" or "changed-since" => new("changed", changedSinceUtc, null),
            _ => All
        };
    }
}

public interface IPublicAotRouteManifestProvider
{
    Task<IReadOnlyList<PublicAotRouteDescriptor>> ListRoutesAsync(
        PublicAotRouteManifestScope scope,
        CancellationToken cancellationToken = default);
}

public sealed class PublicAotRouteManifestProvider(
    ISqlSugarClient db,
    ILogger<PublicAotRouteManifestProvider> logger) : IPublicAotRouteManifestProvider
{
    private const string SeoDependency = "seo";
    private const string ArticleListDependency = "article:list";
    private const int PublicPageSize = 10;

    public async Task<IReadOnlyList<PublicAotRouteDescriptor>> ListRoutesAsync(
        PublicAotRouteManifestScope scope,
        CancellationToken cancellationToken = default)
    {
        List<PublicAotRouteDescriptor> routes =
        [
            CreateStaticRoute(PublicPageKind.Home, 0),
            CreateStaticRoute(PublicPageKind.About, 10),
            CreateStaticRoute(PublicPageKind.Privacy, 11),
            CreateStaticRoute(PublicPageKind.Guidelines, 12),
            CreateStaticRoute(PublicPageKind.Copyright, 13),
            CreateStaticRoute(PublicPageKind.Archive, 20)
        ];

        IReadOnlyList<ArticleRouteProjection> articles = await LoadPublicArticlesAsync(scope, cancellationToken).ConfigureAwait(false);
        if (articles.Count == 0)
        {
            return Deduplicate(routes);
        }

        Dictionary<int, int[]> tagIdsByArticle = await LoadTagIdsByArticleAsync(articles, cancellationToken).ConfigureAwait(false);
        if (scope.IsAll)
        {
            for (int page = 2; page <= CountPages(articles.Count); page++)
            {
                routes.Add(CreateStaticRoute(PublicPageKind.Home, 0, page));
            }
        }

        foreach (ArticleRouteProjection article in articles)
        {
            int[] tagIds = tagIdsByArticle.GetValueOrDefault(article.Id, []);
            routes.Add(CreateArticleRoute(article.Id, article.CategoryId, tagIds, 100));
        }

        foreach (IGrouping<int, ArticleRouteProjection> category in articles
                     .Where(static article => article.CategoryId > 0)
                     .GroupBy(static article => article.CategoryId)
                     .OrderBy(static group => group.Key))
        {
            int pageCount = scope.IsAll ? CountPages(category.Count()) : 1;
            for (int page = 1; page <= pageCount; page++)
            {
                routes.Add(CreateCategoryRoute(category.Key, 200, page));
            }
        }

        int[] tagIdsInScope = [.. tagIdsByArticle.Values.SelectMany(static ids => ids).Where(static id => id > 0).Distinct().Order()];
        Dictionary<int, string> tagNamesById = await LoadTagNamesAsync(tagIdsInScope, cancellationToken).ConfigureAwait(false);
        foreach (int tagId in tagIdsInScope)
        {
            string? tagName = tagNamesById.GetValueOrDefault(tagId);
            int matchingArticleCount = tagIdsByArticle.Count(pair => pair.Value.Contains(tagId));
            int pageCount = scope.IsAll ? CountPages(matchingArticleCount) : 1;
            for (int page = 1; page <= pageCount; page++)
            {
                routes.Add(CreateTagIdRoute(tagId, tagName, 210, page));
            }
        }

        logger.LogDebug("public_aot_route_manifest_built {Scope} {Count}", scope.Scope, routes.Count);
        return Deduplicate(routes);
    }

    internal static PublicAotRouteDescriptor CreateStaticRoute(PublicPageKind kind, int priority, int page = 1)
    {
        PublicAotPageDescriptor descriptor = PublicAotPageCatalog.GetRequired(kind);
        string routeKey = descriptor.FixedRouteKey ?? PublicAotPageIdentity.GetCanonicalSlug(kind);
        if (kind == PublicPageKind.Home)
        {
            routeKey = PublicRouteIdentity.BuildPaginatedRouteKey(routeKey, page);
        }
        string path = descriptor.CanonicalFixedPath ?? descriptor.StaticPath ?? "/";
        string canonicalPath = string.Concat(path, kind == PublicPageKind.Home
            ? PublicRouteIdentity.BuildPaginationQueryString(page)
            : string.Empty);
        return new PublicAotRouteDescriptor(
            descriptor.PageId,
            kind,
            routeKey,
            path,
            canonicalPath,
            [SeoDependency, ArticleListDependency],
            priority);
    }

    internal static PublicAotRouteDescriptor CreateArticleRoute(int articleId, int categoryId, IReadOnlyList<int> tagIds, int priority)
    {
        string routeKey = PublicRouteIdentity.BuildArticleRouteKey(articleId);
        string path = PublicRouteIdentity.BuildCanonicalPath(PublicPageId.ArticleDetail, routeKey, articleId);
        List<string> dependencies =
        [
            SeoDependency,
            ArticleListDependency,
            $"article:{articleId}"
        ];
        if (categoryId > 0)
        {
            dependencies.Add($"category:{categoryId}");
        }
        dependencies.AddRange(tagIds.Where(static id => id > 0).Distinct().Order().Select(static id => $"tag:{id}"));

        return new PublicAotRouteDescriptor(
            PublicPageId.ArticleDetail,
            PublicPageKind.ArticleDetail,
            routeKey,
            path,
            path,
            dependencies,
            priority);
    }

    internal static PublicAotRouteDescriptor CreateCategoryRoute(int categoryId, int priority, int page = 1)
    {
        string routeKey = PublicRouteIdentity.BuildPaginatedRouteKey(PublicRouteIdentity.BuildCategoryRouteKey(categoryId), page);
        string path = PublicRouteIdentity.BuildCanonicalPath(PublicPageId.Filter, routeKey, null);
        return new PublicAotRouteDescriptor(
            PublicPageId.Filter,
            PublicPageKind.Filter,
            routeKey,
            path,
            string.Concat(path, PublicRouteIdentity.BuildPaginationQueryString(page)),
            [SeoDependency, ArticleListDependency, $"category:{categoryId}"],
            priority);
    }

    internal static PublicAotRouteDescriptor CreateTagIdRoute(int tagId, string? tagName, int priority, int page = 1)
    {
        string routeKey = PublicRouteIdentity.BuildPaginatedRouteKey(PublicRouteIdentity.BuildTagIdRouteKey(tagId), page);
        string path = PublicRouteIdentity.BuildCanonicalPath(PublicPageId.Filter, routeKey, null);
        List<string> dependencies = [SeoDependency, ArticleListDependency, $"tag:{tagId}"];
        if (!string.IsNullOrWhiteSpace(tagName))
        {
            dependencies.Add($"tag-name:{tagName.Trim()}");
        }

        return new PublicAotRouteDescriptor(
            PublicPageId.Filter,
            PublicPageKind.Filter,
            routeKey,
            path,
            string.Concat(path, PublicRouteIdentity.BuildPaginationQueryString(page)),
            dependencies,
            priority);
    }

    private async Task<IReadOnlyList<ArticleRouteProjection>> LoadPublicArticlesAsync(
        PublicAotRouteManifestScope scope,
        CancellationToken cancellationToken)
    {
        DateTime utcNow = DateTime.UtcNow;
        ISugarQueryable<Article> query = db.Queryable<Article>()
            .Where(article => !article.IsDeleted
                && article.Status == ArticleStatus.Published
                && (article.PublishedAt == null || article.PublishedAt <= utcNow)
                && (article.ScheduledPublishAt == null || article.ScheduledPublishAt <= utcNow));

        if (scope.ChangedSinceUtc is { } changedSinceUtc)
        {
            DateTime since = changedSinceUtc.UtcDateTime;
            query = query.Where(article => article.CreateTime >= since
                || (article.PublishedAt != null && article.PublishedAt >= since)
                || (article.ScheduledPublishAt != null && article.ScheduledPublishAt >= since));
        }

        query = query
            .OrderBy(article => article.CreateTime, OrderByType.Desc)
            .OrderBy(article => article.Id, OrderByType.Desc);

        if (scope.IsHot && scope.Limit is > 0)
        {
            query = query.Take(scope.Limit.Value);
        }

        return await query
            .Select(static article => new ArticleRouteProjection
            {
                Id = article.Id,
                CategoryId = article.CategoryId,
                CreateTime = article.CreateTime
            })
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
    }

    private async Task<Dictionary<int, int[]>> LoadTagIdsByArticleAsync(
        IReadOnlyList<ArticleRouteProjection> articles,
        CancellationToken cancellationToken)
    {
        int[] articleIds = [.. articles.Select(static article => article.Id).Where(static id => id > 0).Distinct()];
        if (articleIds.Length == 0)
        {
            return [];
        }

        List<ArticleTag> articleTags = await db.Queryable<ArticleTag>()
            .Where(articleTag => articleIds.Contains(articleTag.ArticleId))
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        return articleTags
            .GroupBy(static articleTag => articleTag.ArticleId)
            .ToDictionary(
                static group => group.Key,
                static group => group.Select(static articleTag => articleTag.TagId).Where(static id => id > 0).Distinct().Order().ToArray());
    }

    private async Task<Dictionary<int, string>> LoadTagNamesAsync(int[] tagIds, CancellationToken cancellationToken)
    {
        if (tagIds.Length == 0)
        {
            return [];
        }

        List<TagNameProjection> tags = await db.Queryable<Tag>()
            .Where(tag => tagIds.Contains(tag.Id))
            .Select(static tag => new TagNameProjection { Id = tag.Id, Name = tag.Name })
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        return tags.ToDictionary(static tag => tag.Id, static tag => tag.Name);
    }

    private static IReadOnlyList<PublicAotRouteDescriptor> Deduplicate(IEnumerable<PublicAotRouteDescriptor> routes)
        => [.. routes
            .GroupBy(static route => $"{route.PageId}:{route.RouteKey}", StringComparer.Ordinal)
            .Select(static group => group.OrderBy(static route => route.Priority).First())
            .OrderBy(static route => route.Priority)
            .ThenBy(static route => route.PageId)
            .ThenBy(static route => route.RouteKey, StringComparer.Ordinal)];

    private static int CountPages(int total)
        => Math.Max(1, (int)Math.Ceiling(total / (double)PublicPageSize));

    private sealed class ArticleRouteProjection
    {
        public int Id
        {
            get; set;
        }
        public int CategoryId
        {
            get; set;
        }
        public DateTime CreateTime
        {
            get; set;
        }
    }

    private sealed class TagNameProjection
    {
        public int Id
        {
            get; set;
        }
        public string Name { get; set; } = string.Empty;
    }
}
