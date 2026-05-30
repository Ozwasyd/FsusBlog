using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Infrastructure.PublicAot;

internal static class PublicAotRendererPayloadMapper
{
    internal static IReadOnlyDictionary<string, object?> ToBuildEntryPayload(PublicAotRenderRequest request)
        => new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["pageKind"] = request.Match.Kind.ToString(),
            ["options"] = ToOptions(request)
        };

    internal static IReadOnlyDictionary<string, object?> ToBundlePayload(PublicAotShellBundleContract bundle)
        => new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["bundle"] = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["generatedAtUtc"] = bundle.GeneratedAtUtc,
                ["entries"] = bundle.Entries.Select(ToEntryPayload).ToArray()
            }
        };

    private static IReadOnlyDictionary<string, object?> ToOptions(PublicAotRenderRequest request)
    {
        Dictionary<string, object?> common = CreateCommonOptions(request.Snapshot.Seo);
        switch (request.Snapshot)
        {
            case PublicHomePageSnapshot home:
                common["page"] = home.Page;
                common["size"] = home.Size;
                common["response"] = new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["total"] = home.Total,
                    ["items"] = home.Items.Select(ToArticleSummaryPayload).ToArray()
                };
                return common;
            case PublicArticlePageSnapshot article:
                common["articleId"] = article.ArticleId;
                common["title"] = article.Title;
                common["content"] = article.Content;
                common["summary"] = article.Summary;
                common["views"] = article.Views;
                common["authorName"] = article.AuthorName;
                common["createTime"] = article.CreateTime;
                common["categoryId"] = article.Category.Id;
                common["categoryName"] = article.Category.Name;
                common["tags"] = article.Tags.Select(ToTagPayload).ToArray();
                common["relatedReading"] = article.RelatedReading is null ? null : ToRelatedReadingPayload(article.RelatedReading);
                return common;
            case PublicFilterPageSnapshot filter:
                common["routeKey"] = filter.RouteKey;
                common["filterType"] = filter.FilterType;
                common["filterKey"] = filter.FilterKey;
                common["filterId"] = filter.FilterId;
                common["filterName"] = filter.FilterName;
                common["isInvalidTarget"] = filter.IsInvalidTarget;
                common["pageIndex"] = filter.PageIndex;
                common["pageSize"] = filter.PageSize;
                common["total"] = filter.Total;
                common["articles"] = filter.Articles.Select(ToArticleSummaryPayload).ToArray();
                common["title"] = filter.Title;
                return common;
            case PublicAboutPageSnapshot about:
                common["content"] = about.Content;
                common["slug"] = about.Slug;
                common["title"] = about.Title;
                return common;
            case PublicArchivePageSnapshot archive:
                common["articles"] = archive.Articles.Select(static article => new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["id"] = article.Id,
                    ["title"] = article.Title,
                    ["createTime"] = article.CreateTime.ToUniversalTime().ToString("O", System.Globalization.CultureInfo.InvariantCulture)
                }).ToArray();
                common["title"] = archive.Title;
                return common;
            default:
                throw new InvalidOperationException($"public_aot_snapshot_unsupported:{request.Snapshot.Kind}");
        }
    }

    private static Dictionary<string, object?> CreateCommonOptions(PublicAotSeoSnapshot seo)
        => new(StringComparer.Ordinal)
        {
            ["siteTitle"] = seo.SiteTitle,
            ["siteDescription"] = seo.SiteDescription,
            ["baseUrl"] = seo.BaseUrl
        };

    private static Dictionary<string, object?> ToArticleSummaryPayload(PublicAotArticleSummarySnapshot article)
        => new(StringComparer.Ordinal)
        {
            ["id"] = article.Id,
            ["title"] = article.Title,
            ["summary"] = article.Summary,
            ["views"] = article.Views,
            ["createTime"] = article.CreateTime.ToUniversalTime().ToString("O", System.Globalization.CultureInfo.InvariantCulture),
            ["category"] = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["id"] = article.Category.Id,
                ["name"] = article.Category.Name
            },
            ["tags"] = article.Tags.Select(ToTagPayload).ToArray()
        };

    private static Dictionary<string, object?> ToTagPayload(PublicAotArticleTagSnapshot tag)
        => new(StringComparer.Ordinal)
        {
            ["id"] = tag.Id,
            ["name"] = tag.Name
        };

    private static Dictionary<string, object?> ToRelatedReadingPayload(PublicAotRelatedReadingSnapshot reading)
        => new(StringComparer.Ordinal)
        {
            ["related"] = reading.Related.Select(ToRelatedReadingItemPayload).ToArray(),
            ["previous"] = reading.Previous is null ? null : ToRelatedReadingItemPayload(reading.Previous),
            ["next"] = reading.Next is null ? null : ToRelatedReadingItemPayload(reading.Next)
        };

    private static Dictionary<string, object?> ToRelatedReadingItemPayload(PublicAotRelatedReadingItemSnapshot item)
        => new(StringComparer.Ordinal)
        {
            ["id"] = item.Id,
            ["title"] = item.Title,
            ["summary"] = item.Summary,
            ["createTime"] = item.CreateTime.ToUniversalTime().ToString("O", System.Globalization.CultureInfo.InvariantCulture),
            ["reason"] = item.Reason
        };

    private static Dictionary<string, object?> ToEntryPayload(PublicAotShellEntryContract entry)
        => new(StringComparer.Ordinal)
        {
            ["pageId"] = (int)entry.PageId,
            ["routeKey"] = entry.RouteKey,
            ["html"] = entry.Html,
            ["articleId"] = entry.ArticleId,
            ["bootstrapPayload"] = entry.BootstrapPayload,
            ["hydrationPropsPayload"] = entry.HydrationPropsPayload,
            ["rendererVersion"] = entry.RendererVersion,
            ["islandsPayload"] = entry.IslandsPayload,
            ["title"] = entry.Title,
            ["baseUrl"] = entry.BaseUrl
        };
}
