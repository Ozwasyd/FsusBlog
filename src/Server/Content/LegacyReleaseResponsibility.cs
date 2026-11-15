using FsusBlog.V2.Server.Operations;
using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Server.Content;

internal static class LegacyReleaseResponsibility
{
    private const string ContentType = "application/json; charset=utf-8";
    private static readonly byte[] Missing = """
        {"manifestVersion":1,"code":"article_responsibility_not_found","message":"Integrity verification manifest not found."}
        """u8.ToArray();

    internal static async Task MapAsync(WebApplication app, Publications publications, InstanceLease lease)
    {
        var database = app.Services.GetRequiredService<NpgsqlDataSource>();
        var stopping = app.Lifetime.ApplicationStopping;
        await using var connection = await database.OpenConnectionAsync(stopping);
        if (!await CurrentSchema.HasLegacyReleaseOriginAsync(connection, null, stopping)) return;

        app.MapGet("/integrity/article/{articleId:int}/responsibility", (HttpContext context, int articleId) =>
            ReadAsync(context, database, publications, lease, articleId, null)).RequireRateLimiting("query");
        app.MapGet("/integrity/article/{articleId:int}/revisions/{revisionNo:int}/responsibility",
            (HttpContext context, int articleId, int revisionNo) =>
                ReadAsync(context, database, publications, lease, articleId, revisionNo)).RequireRateLimiting("query");
    }

    private static async Task ReadAsync(HttpContext context, NpgsqlDataSource database, Publications publications,
        InstanceLease lease, int articleId, int? revisionNo)
    {
        var response = context.Response;
        response.Headers.CacheControl = "no-store";
        response.Headers.Vary = "Accept-Encoding";
        if (articleId <= 0 || revisionNo is <= 0)
        {
            await NotFoundAsync(context);
            return;
        }

        var snapshot = publications.Snapshot ?? throw new PublicUnavailableException();
        if (snapshot.Article(articleId) is not { } article)
        {
            await NotFoundAsync(context);
            return;
        }

        using var budget = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted, lease.Stopped);
        budget.CancelAfter(TimeSpan.FromSeconds(1));
        var ct = budget.Token;
        byte[]? manifest;
        try
        {
            await using var connection = await database.OpenConnectionAsync(ct);
            // Historical data remains public only while the article has a current public publication.
            // Match the snapshot and database coordinates to fence a concurrent publication change.
            await using var read = Store.Sql(connection, null, """
                select (
                    select pg_catalog.convert_to(origin.manifest::text, 'UTF8')
                    from public.legacy_release_origin origin
                    where origin.article_id=active.article_id and (
                        ($4=0 and (origin.revision,origin.publication_id)=(active.revision,active.publication_id))
                        or ($4>0 and origin.revision=$4 and origin.revision<=active.revision))
                )
                from public.article_publication active
                join public.article a on a.id=active.article_id and a.published_revision=active.revision and not a.deleted
                where (active.article_id,active.revision,active.publication_id)=($1,$2,$3)
                """, articleId, article.Revision, article.Publication, (long)(revisionNo ?? 0));
            manifest = await read.ExecuteScalarAsync(ct) as byte[];
        }
        catch (OperationCanceledException) when (!context.RequestAborted.IsCancellationRequested)
        {
            throw new PublicUnavailableException();
        }

        if (!ReferenceEquals(snapshot, publications.Snapshot)) throw new PublicUnavailableException();
        if (manifest is null)
        {
            await NotFoundAsync(context);
            return;
        }

        await PublicResponse.Write(context, manifest, ContentType);
    }

    private static Task NotFoundAsync(HttpContext context)
    {
        context.Response.StatusCode = StatusCodes.Status404NotFound;
        return PublicResponse.Write(context, Missing, ContentType);
    }
}
