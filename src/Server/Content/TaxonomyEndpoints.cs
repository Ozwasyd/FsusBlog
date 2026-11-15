using System.Globalization;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;

namespace FsusBlog.V2.Server.Content;

internal static class TaxonomyEndpoints
{
    private const string Binary = "application/octet-stream";
    private const string Html = "text/html; charset=utf-8";
    private static readonly string[] ReadMethods = [HttpMethods.Get, HttpMethods.Head];

    internal static void Map(WebApplication app, Func<HttpContext, PublicSnapshot> snapshot,
        Action<HttpContext, PublicSnapshot> requireCurrent,
        Func<HttpContext, string, int, string?> query, Func<HttpContext, string?> cursor, string cookie,
        Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame)
    {
        app.MapMethods(WireRoutes.CategoryList, ReadMethods, (HttpContext ctx) => Summary(ctx, false));
        app.MapMethods(WireRoutes.TagList, ReadMethods, (HttpContext ctx) => Summary(ctx, true));
        app.MapMethods(WireRoutes.CategoryMetadata, ReadMethods, (HttpContext ctx, int id) => Metadata(ctx, snapshot(ctx), false, id));
        app.MapMethods(WireRoutes.TagMetadata, ReadMethods, (HttpContext ctx, int id) => Metadata(ctx, snapshot(ctx), true, id));
        app.MapMethods(WireRoutes.TagMetadataByName, ReadMethods, (HttpContext ctx) =>
        {
            var current = snapshot(ctx);
            var id = current.Taxonomy.TagByName(query(ctx, "name", 256)) ?? throw Missing(true);
            return Metadata(ctx, current, true, id);
        });
        app.MapMethods(WireRoutes.CategoryArticles, ReadMethods, (HttpContext ctx, int id, int page, int size) =>
            List(ctx, false, id, page, size)).RequireRateLimiting("query");
        app.MapMethods(WireRoutes.TagArticles, ReadMethods, (HttpContext ctx, int id, int page, int size) =>
            List(ctx, true, id, page, size)).RequireRateLimiting("query");

        app.MapGet(WireRoutes.DraftTaxonomy, async (HttpContext ctx, int id, Store store, CancellationToken ct) =>
        {
            if (id <= 0 || !long.TryParse(query(ctx, "revision", 19), NumberStyles.None, CultureInfo.InvariantCulture, out var revision) || revision <= 0)
                throw new BusinessException(Rejection.Invalid, "A valid draft revision is required.");

            var taxonomy = await store.WithSession(ctx.Request.Cookies[cookie], true, async (db, tx, actor) =>
            {
                var draft = await Store.Find(db, tx, actor, id, true, ct);
                if (draft.Revision != revision)
                    throw new BusinessException(Rejection.Conflict, "The article changed. Reload its current revision.");
                return await TaxonomyStore.ReadDraft(db, tx, id, revision, ct);
            }, ct);
            return Results.Bytes(Wire.EncodeDraftTaxonomy(taxonomy), Binary);
        }).RequireRateLimiting("command");

        app.MapPost(WireRoutes.TaxonomyAssignment, async (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            var input = Wire.DecodeTaxonomyAssignment(await readFrame(ctx, WireLimits.TaxonomyAssignmentFrameBytes, ct));
            ClientMutationHeader.Require(ctx, input.IdempotencyKey);
            input = input with { TagIds = input.TagIds.Order().ToArray() };

            var taxonomy = await store.WithSession(ctx.Request.Cookies[cookie], true,
                (db, tx, actor) => Store.AssignTaxonomy(db, tx, actor, input, ct), ct);
            return Results.Bytes(Wire.EncodeDraftTaxonomy(taxonomy), Binary);
        }).RequireRateLimiting("command");

        app.MapMethods("/category/{id:int}", ReadMethods, (HttpContext ctx, int id) => Metadata(ctx, snapshot(ctx), false, id, asHtml: true));
        app.MapMethods("/tag/{id:int}", ReadMethods, (HttpContext ctx, int id) => Metadata(ctx, snapshot(ctx), true, id, asHtml: true));
        app.MapMethods("/tag/{name}", ReadMethods, (HttpContext ctx, string name) =>
        {
            // ASP.NET decodes the URI path before routing but intentionally leaves encoded slashes intact.
            if (name.Contains('/') || name.Contains('\\') || name.Contains("%2f", StringComparison.OrdinalIgnoreCase) ||
                name.Contains("%5c", StringComparison.OrdinalIgnoreCase) || name.All(char.IsAsciiDigit))
                throw Missing(true);
            var current = snapshot(ctx);
            var id = current.Taxonomy.TagByName(name) ?? throw Missing(true);
            var location = $"/tag/{id.ToString(CultureInfo.InvariantCulture)}{ctx.Request.QueryString}";
            return Send(ctx, current, Results.Redirect(location, permanent: true));
        });

        Task Summary(HttpContext ctx, bool tag)
        {
            var current = snapshot(ctx);
            return Send(ctx, current, Results.Bytes(tag ? current.Taxonomy.Tags : current.Taxonomy.Categories, Binary));
        }

        Task Metadata(HttpContext ctx, PublicSnapshot current, bool tag, int id, bool asHtml = false)
        {
            var page = current.Taxonomy.ById(tag, id) ?? throw Missing(tag);
            return Send(ctx, current, asHtml ? Results.Bytes(page.Html, Html) : Results.Bytes(page.Wire, Binary));
        }

        Task List(HttpContext ctx, bool tag, int id, int page, int size)
        {
            var current = snapshot(ctx);
            if (current.Taxonomy.ById(tag, id) is null) throw Missing(tag);
            var scope = string.Create(CultureInfo.InvariantCulture, $"{(tag ? "tag" : "category")}:{id}");
            bool Match(Article article) => tag ? article.Tags?.Any(value => value.Id == id) is true : article.Category?.Id == id;
            var bytes = current.List(scope, page, size, query(ctx, "keyword", 256),
                query(ctx, "sort", 20), cursor(ctx), ctx.RequestAborted, Match);
            return Send(ctx, current, Results.Bytes(bytes, Binary));
        }

        Task Send(HttpContext ctx, PublicSnapshot current, IResult result)
        {
            requireCurrent(ctx, current);
            return result.ExecuteAsync(ctx);
        }
    }

    private static BusinessException Missing(bool tag) =>
        new(Rejection.NotFound, tag ? "Tag not found." : "Category not found.");
}
