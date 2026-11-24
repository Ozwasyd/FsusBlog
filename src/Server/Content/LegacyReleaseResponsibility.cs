using Microsoft.Net.Http.Headers;

namespace FsusBlog.V2.Server.Content;

internal static class LegacyReleaseResponsibility
{
    private const string ContentType = "application/json; charset=utf-8";
    private static readonly byte[] Missing = """
        {"manifestVersion":1,"code":"article_responsibility_not_found","message":"Integrity verification manifest not found."}
        """u8.ToArray();

    private static readonly byte[] MissingArchive = """
        {"manifestVersion":1,"code":"legacy_publication_proof_archive_not_found","message":"Historical publication proof archive not found."}
        """u8.ToArray();

    private static readonly byte[] MissingRightsArchive = """
        {"manifestVersion":1,"code":"legacy_rights_proof_archive_not_found","message":"Historical article rights proof archive not found."}
        """u8.ToArray();

    internal static bool IsHistoricalRoute(PathString path) => path.StartsWithSegments("/integrity/article") &&
        path.Value!.TrimEnd('/').EndsWith("/archive.json", StringComparison.OrdinalIgnoreCase);

    internal static async Task MapAsync(WebApplication app, Publications publications, InstanceLease lease)
    {
        var database = app.Services.GetRequiredService<NpgsqlDataSource>();
        var stopping = app.Lifetime.ApplicationStopping;
        await using var connection = await database.OpenConnectionAsync(stopping);
        if (!await CurrentSchema.HasLegacyReleaseOriginAsync(connection, null, stopping)) return;

        var archive = LegacyHistoricalProof.ReadConfiguration(app.Configuration);
        app.MapQueryGet("/integrity/article/{articleId:int}/revisions/{revisionNo:int}/archive.json",
            (HttpContext context, int articleId, int revisionNo) =>
                ReadAsync(context, database, publications, lease, articleId, revisionNo, historical: true, archive));

        app.MapQueryGet("/integrity/article/{articleId:int}/revisions/{revisionNo:int}/rights/archive.json",
            (HttpContext context, int articleId, int revisionNo) =>
                ReadAsync(context, database, publications, lease, articleId, revisionNo, historical: true, archive, rights: true));

        app.MapQueryGet("/integrity/article/{articleId:int}/responsibility", (HttpContext context, int articleId) =>
            ReadAsync(context, database, publications, lease, articleId, null, archive: archive));
        app.MapQueryGet("/integrity/article/{articleId:int}/revisions/{revisionNo:int}/responsibility",
            (HttpContext context, int articleId, int revisionNo) =>
                ReadAsync(context, database, publications, lease, articleId, revisionNo, archive: archive));
    }

    private static async Task ReadAsync(HttpContext context, NpgsqlDataSource database, Publications publications,
        InstanceLease lease, int articleId, int? revisionNo,
        bool historical = false, LegacyHistoricalProof? archive = null, bool rights = false)
    {
        var response = context.Response;
        response.Headers.CacheControl = "no-store";
        response.Headers.Vary = "Accept-Encoding";
        if (articleId <= 0 || revisionNo is <= 0 || historical && archive is null)
        {
            await NotFoundAsync(context, historical, rights);
            return;
        }

        var snapshot = publications.Snapshot ?? throw new PublicUnavailableException();
        if (snapshot.Article(articleId) is not { } article)
        {
            await NotFoundAsync(context, historical, rights);
            return;
        }

        using var budget = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted, lease.Stopped);
        budget.CancelAfter(TimeSpan.FromSeconds(1));
        var ct = budget.Token;
        byte[]? manifest = null;
        byte[]? proofArchive = null;
        var selectedRevision = 0;
        try
        {
            await using var connection = await database.OpenConnectionAsync(ct);
            // Fence the manifest and all advertised proof links against the same current public coordinate.
            await using var read = Store.Sql(connection, null, """
                select case when not $5 and octet_length(origin.manifest::text)<=131072
                            then pg_catalog.convert_to(origin.manifest::text, 'UTF8') end,
                       case when octet_length(observed.document::text)<=1048576
                            then pg_catalog.convert_to(observed.document::text, 'UTF8') end,
                       origin.revision
                from public.article_publication active
                join public.article a on a.id=active.article_id and a.published_revision=active.revision and not a.deleted
                join public.legacy_release_origin origin on origin.article_id=active.article_id and (
                    ($4=0 and (origin.revision,origin.publication_id)=(active.revision,active.publication_id))
                    or ($4>0 and origin.revision=$4 and origin.revision<=active.revision))
                left join lateral (
                    select jsonb_build_object(
                        'publicationId',origin.publication_id,'revisionId',origin.source_revision_id,
                        'publishProof',origin.evidence->'publishProof','rightsProof',origin.evidence->'rightsProof',
                        'entries',(select jsonb_agg(entry.value)
                            from public.legacy_release_origin item
                            cross join lateral (values (item.evidence #> '{publishProof,transparency,sourceRow}'),
                                (item.evidence #> '{rightsProof,transparency,sourceRow}')) entry(value)
                            where item.plan_sha256=origin.plan_sha256 and item.projection_sha256=origin.projection_sha256
                              and (item.article_id<>origin.article_id or item.revision<=active.revision) and entry.value is not null))
                        as document
                    where $6 and origin.evidence ?| array['publishProof','rightsProof']
                ) observed on true
                where (active.article_id,active.revision,active.publication_id)=($1,$2,$3)
                """, articleId, article.Revision, article.Publication, (long)(revisionNo ?? 0), historical, archive is not null);
            await using var row = await read.ExecuteReaderAsync(ct);
            if (await row.ReadAsync(ct))
            {
                if (!row.IsDBNull(0)) manifest = row.GetFieldValue<byte[]>(0);
                if (!row.IsDBNull(1) && row.GetInt64(2) is > 0 and <= int.MaxValue)
                {
                    proofArchive = row.GetFieldValue<byte[]>(1);
                    selectedRevision = (int)row.GetInt64(2);
                }
            }
        }
        catch (OperationCanceledException) when (!context.RequestAborted.IsCancellationRequested)
        {
            throw new PublicUnavailableException();
        }

        if (historical && proofArchive is not null) manifest = archive!.Verify(proofArchive, articleId, selectedRevision, rights);
        var publicationLink = !historical && manifest is not null && proofArchive is not null &&
            archive!.CanLink(proofArchive, articleId, selectedRevision, rights: false);
        var rightsLink = publicationLink && archive!.CanLink(proofArchive!, articleId, selectedRevision, rights: true);
        if (!ReferenceEquals(snapshot, publications.Snapshot)) throw new PublicUnavailableException();
        if (manifest is null)
        {
            await NotFoundAsync(context, historical, rights);
            return;
        }

        if (publicationLink || rightsLink)
        {
            var path = FormattableString.Invariant($"/integrity/article/{articleId}/revisions/{selectedRevision}");
            if (publicationLink)
                response.Headers.Append(HeaderNames.Link, $"<{path}/archive.json>; rel=\"related\"; type=\"application/json\"; title=\"Historical V1 publication proof\"");
            if (rightsLink)
                response.Headers.Append(HeaderNames.Link, $"<{path}/rights/archive.json>; rel=\"related\"; type=\"application/json\"; title=\"Historical V1 rights proof\"");
        }
        await PublicResponse.Write(context, manifest, ContentType);
    }

    private static Task NotFoundAsync(HttpContext context, bool historical, bool rights)
    {
        context.Response.StatusCode = StatusCodes.Status404NotFound;
        return PublicResponse.Write(context, rights ? MissingRightsArchive : historical ? MissingArchive : Missing, ContentType);
    }
}
