using System.Globalization;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Analytics;
using FsusBlog.V2.Server.Operations;

namespace FsusBlog.V2.Server.Content;

internal static class PublicReadEndpoints
{
    private static readonly string[] ReadMethods = [HttpMethods.Get, HttpMethods.Head];

    internal static void Map(WebApplication app, SiteCapabilities capabilities, Publications publications, bool publicMediaEnabled)
    {
        app.MapGet(WireRoutes.PublicList, (HttpContext ctx, int page, int size) =>
            PublicList(ctx, publications, "home", page, size)).RequireRateLimiting("query");
        app.MapGet(WireRoutes.PublicArchive, (HttpContext ctx, int page, int size) =>
            PublicList(ctx, publications, "archive", page, size)).RequireRateLimiting("query");
        app.MapGet(WireRoutes.PublicArticle, (HttpContext ctx, int id) =>
            PublicDetail(ctx, publications, publicMediaEnabled, id, asHtml: false));
        app.MapGet(WireRoutes.PublicRelatedReading, (HttpContext ctx, int articleId) =>
        {
            var snapshot = ServerHttp.Snapshot(ctx, publications);
            var article = snapshot.Article(articleId);
            if (article is null) return ServerHttp.Error(ctx, 404, "Article not found.", "article_not_found");
            var publication = ServerHttp.Query(ctx, "publication", 19);
            if (publication is not null && publication != article.Publication.ToString(CultureInfo.InvariantCulture))
                return ServerHttp.Error(ctx, 409, "The article changed. Reload its latest publication.", "article_publication_changed");
            var frame = snapshot.RelatedReading.Read(articleId, ctx.RequestAborted);
            ServerHttp.RequireCurrentSnapshot(ctx, publications, snapshot);
            return frame is null
                ? ServerHttp.Error(ctx, 404, "Article not found.", "article_not_found")
                : ServerHttp.Frame(frame);
        }).RequireRateLimiting("query");
        app.MapGet(WireRoutes.PublicSearch, (HttpContext ctx) =>
        {
            var keyword = ServerHttp.Query(ctx, "q", 256)?.Trim();
            if (string.IsNullOrEmpty(keyword)) return ServerHttp.Error(ctx, 400, "A search term is required.");
            var sortText = ServerHttp.Query(ctx, "sort", 20);
            var sort = sortText switch
            {
                null or "relevance" => ArticleSearchSort.Relevance,
                "latest" => ArticleSearchSort.Latest,
                _ => (ArticleSearchSort)(-1)
            };
            if (!Enum.IsDefined(sort)) return ServerHttp.Error(ctx, 400, "Invalid search sort mode.");
            var pageText = ServerHttp.Query(ctx, "page", 10);
            var sizeText = ServerHttp.Query(ctx, "size", 10);
            var paginated = pageText is not null || sizeText is not null;
            var page = 1;
            var size = paginated ? 10 : 200;
            if (pageText is not null && (!int.TryParse(pageText, NumberStyles.None, CultureInfo.InvariantCulture, out page) ||
                page is < 1 or > 10_000 || pageText != page.ToString(CultureInfo.InvariantCulture)))
                return ServerHttp.Error(ctx, 400, "Invalid search page.");
            if (sizeText is not null && (!int.TryParse(sizeText, NumberStyles.None, CultureInfo.InvariantCulture, out size) ||
                size is < 1 or > 100 || sizeText != size.ToString(CultureInfo.InvariantCulture)))
                return ServerHttp.Error(ctx, 400, "Invalid search page size.");
            var snapshot = ServerHttp.Snapshot(ctx, publications);
            var result = snapshot.SearchPage(keyword, sort, page, size, ctx.RequestAborted);
            ServerHttp.RequireCurrentSnapshot(ctx, publications, snapshot);
            if (result is not { } hit) return ServerHttp.Error(ctx, 503, "The article search projection is unavailable.");
            var reportedTotal = paginated ? Math.Min(hit.Total, ArticleSearchIndex.MaxPaginatedResults) : hit.Total;
            ctx.Response.Headers[WireHeaders.SearchTotal] = reportedTotal.ToString(CultureInfo.InvariantCulture);
            return ServerHttp.Frame(hit.Bytes);
        }).RequireRateLimiting("query");

        if (capabilities.WideSearchCorpus)
            WideSearchCorpusEndpoints.Map(app, app.Services.GetRequiredService<PublicProjection>(), app.Services.GetRequiredService<InstanceLease>());

        if (app.Services.GetService<PublicHotArticles>() is { } hotArticles)
        {
            app.MapMethods(WireRoutes.PublicArticleHot, ReadMethods, (HttpContext ctx, string size) =>
            {
                if (size.Length > 9 || !int.TryParse(size, NumberStyles.None, CultureInfo.InvariantCulture, out var count) ||
                    count is < 1 or > WireLimits.PublicArticleHotMaxSize)
                    return ServerHttp.Error(ctx, 404, "Public article ranking size is unavailable.");
                var snapshot = ServerHttp.Snapshot(ctx, publications);
                var head = HttpMethods.IsHead(ctx.Request.Method);
                var generation = ServerHttp.Query(ctx, "generation", 20);
                if (head && generation is null) return ServerHttp.Error(ctx, 400, "A publication generation is required.");
                if (generation is not null && generation != snapshot.GenerationHeader)
                    return ServerHttp.Error(ctx, 409, "The public articles changed. Reload the ranking.");
                var ranking = hotArticles.Read(snapshot, count) ?? throw new PublicUnavailableException();
                ServerHttp.RequireCurrentSnapshot(ctx, publications, snapshot);
                ctx.Response.Headers.ETag = ranking.Tag;
                return head ? Results.NoContent() : ServerHttp.Frame(ranking.Bytes);
            });
        }

        app.MapGet(WireRoutes.PublicIndex, (HttpContext ctx) =>
        {
            var snapshot = ServerHttp.Snapshot(ctx, publications);
            var page = ServerHttp.Query(ctx, "page", 10);
            var generation = ServerHttp.Query(ctx, "generation", 20);
            if (generation is not null && generation != snapshot.GenerationHeader)
                return ServerHttp.Error(ctx, 409, "The search index changed. Reload it from page 1.");
            if (page is not null && (!int.TryParse(page, NumberStyles.None, CultureInfo.InvariantCulture, out var value) || (value > 1 && generation is null)))
                return ServerHttp.Error(ctx, 400, "Invalid search index page or missing generation.");
            ServerHttp.RequireCurrentSnapshot(ctx, publications, snapshot);
            ctx.Response.Headers[WireHeaders.SearchIndexPages] = snapshot.IndexPageCount.ToString(CultureInfo.InvariantCulture);
            return snapshot.Index(page is null ? 1 : int.Parse(page, CultureInfo.InvariantCulture)) is { } index
                ? ServerHttp.Frame(index) : ServerHttp.Error(ctx, 404, "Index page not found.");
        });

        app.MapMethods(WireRoutes.PublicSearchCorpus, ReadMethods, (HttpContext ctx) =>
        {
            var snapshot = ServerHttp.Snapshot(ctx, publications);
            var generation = ServerHttp.Query(ctx, "generation", 20);
            var pageText = ServerHttp.Query(ctx, "page", 10);
            var page = 1;
            if (pageText is not null && (!int.TryParse(pageText, NumberStyles.None, CultureInfo.InvariantCulture, out page) || page < 1))
                return ServerHttp.Error(ctx, 400, "Invalid search corpus page.");
            var head = HttpMethods.IsHead(ctx.Request.Method);
            if ((head || page > 1) && generation is null)
                return ServerHttp.Error(ctx, 400, "A search generation is required.");
            if (generation is not null && generation != snapshot.GenerationHeader)
                return ServerHttp.Error(ctx, 409, "The search corpus changed. Reload it from page 1.");
            if (snapshot.CorpusPageCount == 0)
                return ServerHttp.Error(ctx, 503, "The search corpus is unavailable.");
            ServerHttp.RequireCurrentSnapshot(ctx, publications, snapshot);
            ctx.Response.Headers[WireHeaders.SearchIndexPages] = snapshot.CorpusPageCount.ToString(CultureInfo.InvariantCulture);
            if (head) return Results.NoContent();
            if (page > 1 && ctx.Request.Headers.Accept.ToString() == SearchCorpusPatch.Accept &&
                ServerHttp.Query(ctx, "baseGeneration", 19) is { } baseGeneration && ctx.Request.Headers.IfNoneMatch is { Count: 1 } validators &&
                snapshot.CorpusPatch(page, baseGeneration, validators[0]) is { } patch)
                return new CurrentSearchCorpusPatch(snapshot, publications, snapshot.CorpusTag(page).Tag.ToString()[1..^1], patch);
            return snapshot.Corpus(page) is { } bytes
                ? Results.Bytes(bytes, ServerHttp.BinaryContentType, entityTag: snapshot.CorpusTag(page))
                : ServerHttp.Error(ctx, 404, "Search corpus page not found.");
        });
    }

    internal static Task PublicList(HttpContext ctx, Publications publications, string scope, int page, int size)
    {
        var snapshot = ServerHttp.Snapshot(ctx, publications);
        var bytes = snapshot.List(scope, page, size, ServerHttp.Query(ctx, "keyword", 256), ServerHttp.Query(ctx, "sort", 20),
            ServerHttp.ReadListCursor(ctx), ctx.RequestAborted);
        ServerHttp.RequireCurrentSnapshot(ctx, publications, snapshot);
        return PublicResponse.Write(ctx, bytes, ServerHttp.BinaryContentType);
    }

    internal static async Task PublicDetail(HttpContext ctx, Publications publications, bool publicMediaEnabled, int id, bool asHtml)
    {
        var snapshot = ServerHttp.Snapshot(ctx, publications);
        var article = await snapshot.Detail(id, ctx.RequestAborted);
        ServerHttp.RequireCurrentSnapshot(ctx, publications, snapshot);
        if (article is not null)
        {
            if (publicMediaEnabled && snapshot.HasPublishedImages(id))
                ctx.Response.Headers[WireHeaders.PublicArticleMediaPresent] = "1";
            await PublicResponse.Write(ctx,
                asHtml ? (SiteLocale.Select(ctx) == "en" ? article.EnglishHtml ?? article.Html : article.Html) : article.Wire,
                asHtml ? ServerHttp.HtmlContentType : ServerHttp.BinaryContentType);
            return;
        }
        var missing = asHtml
            ? Results.Text(SiteLocale.Text(SiteLocale.Select(ctx), "reading.articleMissing"), ServerHttp.TextContentType, statusCode: 404)
            : ServerHttp.Error(ctx, 404, "Article not found.");
        await missing.ExecuteAsync(ctx);
    }

    internal sealed record CurrentSearchCorpusPatch(PublicSnapshot Snapshot, Publications Publications, string TargetDigest, byte[] Bytes) : IResult
    {
        public Task ExecuteAsync(HttpContext context)
        {
            if (!ReferenceEquals(Snapshot, Publications.Snapshot))
            {
                context.Response.Headers.Remove(WireHeaders.SearchIndexGeneration);
                throw new PublicUnavailableException();
            }
            // Snapshot sets no-store. The full page's strong ETag never labels this representation.
            context.RequestAborted.ThrowIfCancellationRequested();
            context.Response.Headers[WireHeaders.SearchCorpusTargetDigest] = TargetDigest;
            return Results.Bytes(Bytes, SearchCorpusPatch.ContentType).ExecuteAsync(context);
        }
    }
}
