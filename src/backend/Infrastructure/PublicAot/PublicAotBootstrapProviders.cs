using FsusBlog.Core.Common;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Server.Services.Distribution;
using SqlSugar;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public abstract class PublicAotBootstrapProviderBase(ISystemService systemService) : IPublicAotBootstrapProvider
{
    public abstract PublicPageKind Kind { get; }

    public abstract Task<Result<PublicPageSnapshot>> BuildSnapshotAsync(
        PublicAotRouteMatch match,
        CancellationToken cancellationToken = default);

    protected async Task<SeoConfigReadModel> LoadSeoAsync()
        => await systemService.GetSeoConfigAsync();

    protected static PublicAotSeoSnapshot ToSeoSnapshot(SeoConfigReadModel seo)
        => new(seo.Title, seo.Description, NormalizeBaseUrl(seo.BaseUrl));

    protected static string? NormalizeBaseUrl(string? value)
        => string.IsNullOrWhiteSpace(value) ? null : value.Trim().TrimEnd('/');

    protected static PublicAotArticleSummarySnapshot ToArticleSummarySnapshot(ArticleListItemReadModel item)
        => new(
            item.Id,
            item.Title,
            item.Summary ?? item.Snippet ?? string.Empty,
            item.Views,
            item.CreateTime,
            new PublicAotArticleCategorySnapshot(
                item.CategoryId,
                string.IsNullOrWhiteSpace(item.CategoryName) ? "未分类" : item.CategoryName),
            item.Tags.Select(static tag => new PublicAotArticleTagSnapshot(tag.Id, tag.Name)).ToArray());
}

public sealed class PublicAotHomeBootstrapProvider(
    IArticleService articleService,
    ISystemService systemService) : PublicAotBootstrapProviderBase(systemService)
{
    public override PublicPageKind Kind => PublicPageKind.Home;

    public override async Task<Result<PublicPageSnapshot>> BuildSnapshotAsync(PublicAotRouteMatch match, CancellationToken cancellationToken = default)
    {
        const int pageSize = 10;
        SeoConfigReadModel seo = await LoadSeoAsync();
        ArticleListPageReadModel page = await articleService.GetPageListAsync(1, pageSize, null, null, false);
        return Result<PublicPageSnapshot>.Success(new PublicHomePageSnapshot(
            ToSeoSnapshot(seo),
            Page: 1,
            pageSize,
            page.Total,
            page.Items.Select(ToArticleSummarySnapshot).ToArray()));
    }
}

public sealed class PublicAotArticleDetailBootstrapProvider(
    RelatedReadingService relatedReadingService,
    ISystemService systemService,
    ISqlSugarClient db) : PublicAotBootstrapProviderBase(systemService)
{
    public override PublicPageKind Kind => PublicPageKind.ArticleDetail;

    public override async Task<Result<PublicPageSnapshot>> BuildSnapshotAsync(PublicAotRouteMatch match, CancellationToken cancellationToken = default)
    {
        int articleId = PublicRouteIdentity.ParseArticleRouteKey(match.RouteKey);
        if (articleId <= 0)
        {
            return Result<PublicPageSnapshot>.Failure(ErrorCode.Validation, "public_aot_article_id_invalid");
        }

        DateTime utcNow = DateTime.UtcNow;
        ArticleDetailAotProjection? article = await LoadPublicArticleForAotAsync(articleId, utcNow, cancellationToken);
        if (article is null)
        {
            return Result<PublicPageSnapshot>.Failure(ErrorCode.NotFound, "public_aot_article_not_found");
        }

        SeoConfigReadModel seo = await LoadSeoAsync();
        RelatedReadingResponse? relatedReading = await relatedReadingService.BuildAsync(articleId, cancellationToken);
        return Result<PublicPageSnapshot>.Success(new PublicArticlePageSnapshot(
            ToSeoSnapshot(seo),
            article.Id,
            article.Title,
            article.Content,
            article.Summary ?? string.Empty,
            article.Views,
            string.IsNullOrWhiteSpace(seo.Author) ? seo.Title : seo.Author,
            article.CreateTime,
            new PublicAotArticleCategorySnapshot(article.CategoryId, article.CategoryName),
            article.Tags,
            ToRelatedReadingSnapshot(relatedReading)));
    }

    private async Task<ArticleDetailAotProjection?> LoadPublicArticleForAotAsync(
        int articleId,
        DateTime utcNow,
        CancellationToken cancellationToken)
    {
        ArticleDetailAotProjection? projection = await db.Queryable<Article>()
            .LeftJoin<Category>((a, category) => a.CategoryId == category.Id)
            .LeftJoin<ArticleBody>((a, category, body) => a.Id == body.ArticleId)
            .Where(a => a.Id == articleId
                && a.IsDeleted == false
                && a.Status == ArticleStatus.Published
                && (a.PublishedAt == null || a.PublishedAt <= utcNow)
                && (a.ScheduledPublishAt == null || a.ScheduledPublishAt <= utcNow))
            .Select((a, category, body) => new ArticleDetailAotProjection
            {
                Id = a.Id,
                Title = a.Title,
                Content = body.MarkdownContent,
                Summary = a.Summary,
                Views = a.Views,
                CreateTime = a.CreateTime,
                CategoryId = a.CategoryId,
                CategoryName = category.Name
            })
            .FirstAsync(cancellationToken);
        if (projection is null)
        {
            return null;
        }

        List<ArticleTagAotProjection> tags = await db.Queryable<ArticleTag>()
            .InnerJoin<Tag>((articleTag, tag) => articleTag.TagId == tag.Id)
            .Where((articleTag, tag) => articleTag.ArticleId == articleId)
            .OrderBy((articleTag, tag) => tag.Id)
            .Select((articleTag, tag) => new ArticleTagAotProjection
            {
                Id = tag.Id,
                Name = tag.Name
            })
            .ToListAsync(cancellationToken);
        projection.Tags = tags
            .Select(static tag => new PublicAotArticleTagSnapshot(tag.Id, tag.Name))
            .ToArray();
        projection.Content = string.IsNullOrWhiteSpace(projection.Content) ? projection.Summary ?? string.Empty : projection.Content;
        projection.Summary ??= string.Empty;
        projection.CategoryName = string.IsNullOrWhiteSpace(projection.CategoryName) ? "未分类" : projection.CategoryName;
        return projection;
    }

    private static PublicAotRelatedReadingSnapshot? ToRelatedReadingSnapshot(RelatedReadingResponse? response)
        => response is null
            ? null
            : new PublicAotRelatedReadingSnapshot(
                response.Related.Select(ToRelatedReadingItemSnapshot).ToArray(),
                response.Previous is null ? null : ToRelatedReadingItemSnapshot(response.Previous),
                response.Next is null ? null : ToRelatedReadingItemSnapshot(response.Next));

    private static PublicAotRelatedReadingItemSnapshot ToRelatedReadingItemSnapshot(RelatedReadingItem item)
        => new(item.Id, item.Title, item.Summary, item.CreateTime, item.Reason);

    private sealed class ArticleDetailAotProjection
    {
        public int Id { get; init; }
        public string Title { get; init; } = string.Empty;
        public string Content { get; set; } = string.Empty;
        public string? Summary { get; set; }
        public int Views { get; init; }
        public DateTime CreateTime { get; init; }
        public int CategoryId { get; init; }
        public string CategoryName { get; set; } = string.Empty;
        public IReadOnlyList<PublicAotArticleTagSnapshot> Tags { get; set; } = [];
    }

    private sealed class ArticleTagAotProjection
    {
        public int Id { get; init; }
        public string Name { get; init; } = string.Empty;
    }
}

public sealed class PublicAotFilterBootstrapProvider(
    IArticleService articleService,
    ISystemService systemService,
    ISqlSugarClient db) : PublicAotBootstrapProviderBase(systemService)
{
    public override PublicPageKind Kind => PublicPageKind.Filter;

    public override async Task<Result<PublicPageSnapshot>> BuildSnapshotAsync(PublicAotRouteMatch match, CancellationToken cancellationToken = default)
    {
        const int pageIndex = 1;
        const int pageSize = 10;
        SeoConfigReadModel seo = await LoadSeoAsync();
        FilterIdentity identity = await ResolveFilterIdentityAsync(match.RouteKey, cancellationToken);
        ArticleListPageReadModel page = !identity.IsInvalidTarget
            ? await articleService.GetPageListAsync(pageIndex, pageSize, identity.CategoryId, identity.TagId, false)
            : new ArticleListPageReadModel { Items = [], Total = 0 };
        string title = ResolveFilterTitle(identity);

        return Result<PublicPageSnapshot>.Success(new PublicFilterPageSnapshot(
            ToSeoSnapshot(seo),
            match.RouteKey,
            identity.FilterType,
            identity.FilterKey,
            identity.FilterId,
            identity.FilterName,
            identity.IsInvalidTarget,
            pageIndex,
            pageSize,
            page.Total,
            page.Items.Select(ToArticleSummarySnapshot).ToArray(),
            title));
    }

    private async Task<FilterIdentity> ResolveFilterIdentityAsync(string routeKey, CancellationToken cancellationToken)
    {
        PublicRouteIdentity.ParsedFilterRouteIdentity parsed = PublicRouteIdentity.ParseFilterRouteKey(routeKey);

        if (parsed.CategoryId is >= 0 && string.Equals(parsed.FilterType, "category", StringComparison.Ordinal))
        {
            string? name = parsed.CategoryId > 0
                ? await db.Queryable<Category>().Where(category => category.Id == parsed.CategoryId).Select(category => category.Name).FirstAsync(cancellationToken)
                : null;
            return new FilterIdentity(parsed.FilterType, parsed.FilterKey, parsed.FilterId, name, parsed.CategoryId, null, string.IsNullOrWhiteSpace(name));
        }

        if (parsed.TagId is >= 0 && string.Equals(parsed.FilterType, "tag", StringComparison.Ordinal) && string.IsNullOrWhiteSpace(parsed.FilterName))
        {
            string? name = parsed.TagId > 0
                ? await db.Queryable<Tag>().Where(tag => tag.Id == parsed.TagId).Select(tag => tag.Name).FirstAsync(cancellationToken)
                : null;
            return new FilterIdentity(parsed.FilterType, parsed.FilterKey, parsed.FilterId, name, null, parsed.TagId, string.IsNullOrWhiteSpace(name));
        }

        if (string.Equals(parsed.FilterType, "tag", StringComparison.Ordinal) && !string.IsNullOrWhiteSpace(parsed.FilterName))
        {
            int? tagId = string.IsNullOrWhiteSpace(parsed.FilterName)
                ? null
                : await db.Queryable<Tag>().Where(tag => tag.Name == parsed.FilterName).Select(tag => (int?)tag.Id).FirstAsync(cancellationToken);
            return new FilterIdentity(parsed.FilterType, parsed.FilterKey, tagId ?? 0, parsed.FilterName, null, tagId, tagId is not > 0);
        }

        return new FilterIdentity(parsed.FilterType, parsed.FilterKey, parsed.FilterId, parsed.FilterName, parsed.CategoryId, parsed.TagId, true);
    }

    private static string ResolveFilterTitle(FilterIdentity identity)
        => identity.FilterType switch
        {
            "category" when !string.IsNullOrWhiteSpace(identity.FilterName) => identity.FilterName!,
            "category" => "未发现分类",
            "tag" when !string.IsNullOrWhiteSpace(identity.FilterName) => identity.FilterName!,
            "tag" => "未发现标签",
            _ => "筛选"
        };

    private sealed record FilterIdentity(
        string FilterType,
        string FilterKey,
        int FilterId,
        string? FilterName,
        int? CategoryId,
        int? TagId,
        bool IsInvalidTarget);
}

public sealed class PublicAotAboutBootstrapProvider : PublicAotBootstrapProviderBase
{
    private readonly ISystemService _systemService;

    public PublicAotAboutBootstrapProvider(ISystemService systemService) : base(systemService)
    {
        _systemService = systemService;
    }

    public override PublicPageKind Kind => PublicPageKind.About;

    public override async Task<Result<PublicPageSnapshot>> BuildSnapshotAsync(PublicAotRouteMatch match, CancellationToken cancellationToken = default)
    {
        SeoConfigReadModel seo = await LoadSeoAsync();
        PageContentReadModel about = await _systemService.GetPageContentAsync(PublicAotPageIdentity.GetCanonicalSlug(PublicPageKind.About));
        return Result<PublicPageSnapshot>.Success(new PublicAboutPageSnapshot(
            ToSeoSnapshot(seo),
            about.Content ?? string.Empty,
            about.Slug ?? string.Empty,
            "关于"));
    }
}

public sealed class PublicAotArchiveBootstrapProvider(
    ISystemService systemService,
    ISqlSugarClient db) : PublicAotBootstrapProviderBase(systemService)
{
    public override PublicPageKind Kind => PublicPageKind.Archive;

    public override async Task<Result<PublicPageSnapshot>> BuildSnapshotAsync(PublicAotRouteMatch match, CancellationToken cancellationToken = default)
    {
        SeoConfigReadModel seo = await LoadSeoAsync();
        IReadOnlyList<ArchiveArticleAotProjection> articles = await ListPublicArchiveArticlesAsync(cancellationToken);
        return Result<PublicPageSnapshot>.Success(new PublicArchivePageSnapshot(
            ToSeoSnapshot(seo),
            articles.Select(static article => new PublicArchiveArticleSnapshot(article.Id, article.Title, article.CreateTime)).ToArray(),
            "归档"));
    }

    private async Task<List<ArchiveArticleAotProjection>> ListPublicArchiveArticlesAsync(CancellationToken cancellationToken)
    {
        DateTime utcNow = DateTime.UtcNow;
        return await db.Queryable<Article>()
            .Where(article => article.IsDeleted == false
                && article.Status == ArticleStatus.Published
                && (article.PublishedAt == null || article.PublishedAt <= utcNow)
                && (article.ScheduledPublishAt == null || article.ScheduledPublishAt <= utcNow))
            .OrderBy(article => article.CreateTime, OrderByType.Desc)
            .OrderBy(article => article.Id, OrderByType.Desc)
            .Select(article => new ArchiveArticleAotProjection
            {
                Id = article.Id,
                Title = article.Title,
                CreateTime = article.CreateTime
            })
            .ToListAsync(cancellationToken);
    }

    private sealed class ArchiveArticleAotProjection
    {
        public int Id { get; init; }
        public string Title { get; init; } = string.Empty;
        public DateTime CreateTime { get; init; }
    }
}
