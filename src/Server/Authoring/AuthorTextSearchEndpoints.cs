using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Sessions;
using FsusBlogV2.Storage;

namespace FsusBlog.V2.Server.Authoring;

internal static class AuthorTextSearchEndpoints
{
    internal static void Map(WebApplication app, string cookie, Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame)
    {
        var cursors = new AuthorTextCursor(TimeProvider.System);
        app.MapPost(WireRoutes.AuthorTextSearch, async (HttpContext context, Store store, AuthorTextRebuildWorker rebuild, CancellationToken ct) =>
        {
            var frame = await readFrame(context, WireLimits.MaxAuthorTextPropertyTextQualifiedQueryFrameBytes, ct);
            var token = context.Request.Cookies[cookie];
            var expected = SiteSessions.Requested(context);
            var payload = await store.WithSession(token, true, async (db, tx, actor) =>
            {
                var digest = Store.TokenDigest(token)!;
                SiteSessions.RequireCurrent(actor.Id, digest, expected);
                Aeds.Decode(frame, out var type);
                var maximum = type switch
                {
                    FrameType.AuthorTextPropertyTextQualifiedQuery => WireLimits.MaxAuthorTextPropertyTextQualifiedQueryFrameBytes,
                    FrameType.AuthorTextPropertyTextQuery => WireLimits.MaxAuthorTextPropertyTextQueryFrameBytes,
                    FrameType.AuthorTextPropertySortQuery => WireLimits.MaxAuthorTextPropertySortQueryFrameBytes,
                    FrameType.AuthorTextPropertyFacetQuery => WireLimits.MaxAuthorTextPropertyFacetQueryFrameBytes,
                    _ => WireLimits.MaxAuthorTextQualifiedQueryFrameBytes,
                };
                if (frame.Length > maximum) throw new BadHttpRequestException("Request too large.", 413);
                // Serialize under the account/session and exact result article locks.
                // WithSession rechecks expiry and commits before sending any response.
                byte[] encoded;
                if (type is FrameType.AuthorTextPropertyTextQuery or FrameType.AuthorTextPropertyTextQualifiedQuery)
                {
                    var qualifiedText = type == FrameType.AuthorTextPropertyTextQualifiedQuery
                        ? Wire.DecodeAuthorTextPropertyTextQualifiedQuery(frame) : null;
                    var query = qualifiedText is null ? Wire.DecodeAuthorTextPropertyTextQuery(frame) :
                        new AuthorTextPropertyTextQuery(qualifiedText.Search, qualifiedText.DefinitionId, qualifiedText.DefinitionRevision);
                    var search = query.Search;
                    var input = AuthorTextProfile.ParsePropertyText(search.Query);
                    if (!await CurrentSchema.HasAuthorTextPropertyIndexAsync(db, tx, ct))
                        throw new BusinessException(Rejection.NotFound, "Install or upgrade the private article index with author-search.");
                    var cursorSearch = search with { Cursor = "" };
                    var cursorQuery = Convert.ToHexStringLower(SHA256.HashData(qualifiedText is null
                        ? Wire.EncodeAuthorTextPropertyTextQuery(query with { Search = cursorSearch })
                        : Wire.EncodeAuthorTextPropertyTextQualifiedQuery(qualifiedText with { Search = cursorSearch })));
                    (AuthorTextRankKey Position, byte[] Generation)? after = search.Cursor.Length == 0
                        ? null : cursors.Decode(search.Cursor, actor, digest, cursorQuery, type);
                    var page = await AuthorTextIndex.ReadPropertyText(db, tx, actor, input, query, after?.Position, after?.Generation, ct,
                        facet: qualifiedText?.Facet is { } facet ? new(facet.DefinitionId, facet.DefinitionRevision) : null,
                        sort: qualifiedText?.Sort is { } sort ? new(sort.DefinitionId, sort.DefinitionRevision, sort.Direction) : null);
                    if (!page.Ready)
                        await rebuild.EnqueueProperty(db, tx, actor, query.DefinitionId, search.SchemaRevision, query.DefinitionRevision, ct);
                    var next = page.More ? cursors.Encode(page.Rows[^1].Key, page.Generation!, actor, digest, cursorQuery, type) : "";
                    var response = new FsusBlog.V2.Contracts.AuthorTextFacetedPage(page.Ready, next, page.Total, page.StateCounts,
                        page.MoreCategories, page.Categories, page.MoreTags, page.Tags, page.Rows.Select(row => row.Match).ToArray());
                    encoded = qualifiedText is null ? Wire.EncodeAuthorTextPropertyTextPage(response) :
                        Wire.EncodeAuthorTextPropertyTextQualifiedPage(new(response, page.PropertyFacet));
                }
                else if (type == FrameType.AuthorTextSearchQuery)
                {
                    var input = AuthorTextProfile.Parse(Wire.DecodeAuthorTextSearchQuery(frame));
                    await RequireIndex();
                    var page = await AuthorTextIndex.Read(db, tx, actor, input, ct);
                    if (!page.Ready) await rebuild.EnqueueBody(db, tx, actor, ct);
                    encoded = Wire.EncodeAuthorTextSearchPage(page);
                }
                else
                {
                    var propertyFacet = type == FrameType.AuthorTextPropertyFacetQuery ? Wire.DecodeAuthorTextPropertyFacetQuery(frame) : null;
                    var propertySort = type == FrameType.AuthorTextPropertySortQuery ? Wire.DecodeAuthorTextPropertySortQuery(frame) : null;
                    var includeHeading = type == FrameType.AuthorTextHeadingQuery || propertyFacet?.IncludeHeading == true || propertySort?.IncludeHeading == true;
                    var includeSummary = includeHeading || propertyFacet is not null || propertySort is not null || type == FrameType.AuthorTextSummaryQuery;
                    var qualified = type switch
                    {
                        FrameType.AuthorTextPropertySortQuery => propertySort!.Search,
                        FrameType.AuthorTextPropertyFacetQuery => propertyFacet!.Search,
                        FrameType.AuthorTextHeadingQuery => Wire.DecodeAuthorTextHeadingQuery(frame),
                        FrameType.AuthorTextSummaryQuery => Wire.DecodeAuthorTextSummaryQuery(frame),
                        FrameType.AuthorTextQualifiedQuery => Wire.DecodeAuthorTextQualifiedQuery(frame),
                        _ => null,
                    };
                    var faceted = qualified is not null || type == FrameType.AuthorTextFacetedQuery;
                    var request = qualified is not null ? new AuthorTextRankedQuery(qualified.Query, qualified.Cursor)
                        : faceted ? Wire.DecodeAuthorTextFacetedQuery(frame) : Wire.DecodeAuthorTextRankedQuery(frame);
                    // Re-encode the exact requested criteria without its cursor to bind both filters and text.
                    var cursorQuery = qualified is null ? request.Query : Convert.ToHexStringLower(SHA256.HashData(type switch
                    {
                        FrameType.AuthorTextPropertySortQuery => Wire.EncodeAuthorTextPropertySortQuery(propertySort! with { Search = qualified with { Cursor = "" } }),
                        FrameType.AuthorTextPropertyFacetQuery => Wire.EncodeAuthorTextPropertyFacetQuery(propertyFacet! with { Search = qualified with { Cursor = "" } }),
                        FrameType.AuthorTextHeadingQuery => Wire.EncodeAuthorTextHeadingQuery(qualified with { Cursor = "" }),
                        FrameType.AuthorTextSummaryQuery => Wire.EncodeAuthorTextSummaryQuery(qualified with { Cursor = "" }),
                        _ => Wire.EncodeAuthorTextQualifiedQuery(qualified with { Cursor = "" }),
                    }));
                    (AuthorTextRankKey Position, byte[] Generation)? after = request.Cursor.Length == 0
                        ? null : cursors.Decode(request.Cursor, actor, digest, cursorQuery, type);
                    if (faceted)
                    {
                        var input = includeHeading ? AuthorTextProfile.ParseHeading(request.Query) :
                            includeSummary ? AuthorTextProfile.ParseSummary(request.Query) : AuthorTextProfile.ParseFaceted(request.Query);
                        PropertyStore.FacetSelection? facet = propertySort?.Facet is { } sortFacet
                            ? new(sortFacet.DefinitionId, sortFacet.DefinitionRevision)
                            : propertyFacet is null ? null : new(propertyFacet.DefinitionId, propertyFacet.DefinitionRevision);
                        await RequireIndex();
                        var page = qualified is null
                            ? await AuthorTextIndex.ReadFaceted(db, tx, actor, input, after?.Position, after?.Generation, ct)
                            : await AuthorTextIndex.ReadQualified(db, tx, actor, input, qualified.UpdatedFromUnixMs,
                                qualified.UpdatedUntilUnixMs, qualified.SchemaRevision, qualified.Conditions, after?.Position,
                                after?.Generation, ct, includeSummary: includeSummary, includeHeading: includeHeading,
                                facet: facet, sort: propertySort is null ? null : new(propertySort.DefinitionId, propertySort.DefinitionRevision, propertySort.Direction));
                        if (!page.Ready) await rebuild.EnqueueBody(db, tx, actor, ct, includeSummary, includeHeading);
                        var next = Next(page.More, page.Rows, page.Generation);
                        var response = new FsusBlog.V2.Contracts.AuthorTextFacetedPage(page.Ready, next, page.Total, page.StateCounts,
                            page.MoreCategories, page.Categories, page.MoreTags, page.Tags, page.Rows.Select(row => row.Match).ToArray());
                        encoded = type switch
                        {
                            FrameType.AuthorTextPropertySortQuery => Wire.EncodeAuthorTextPropertySortPage(new(response, page.PropertyFacet), includeHeading),
                            FrameType.AuthorTextPropertyFacetQuery => Wire.EncodeAuthorTextPropertyFacetPage(new(response, page.PropertyFacet), includeHeading),
                            FrameType.AuthorTextHeadingQuery => Wire.EncodeAuthorTextHeadingPage(response),
                            FrameType.AuthorTextSummaryQuery => Wire.EncodeAuthorTextSummaryPage(response),
                            _ => Wire.EncodeAuthorTextFacetedPage(response),
                        };
                    }
                    else
                    {
                        var input = AuthorTextProfile.ParseRanked(request.Query);
                        await RequireIndex();
                        var page = await AuthorTextIndex.ReadRanked(db, tx, actor, input, after?.Position, after?.Generation, ct);
                        if (!page.Ready) await rebuild.EnqueueBody(db, tx, actor, ct);
                        var next = Next(page.More, page.Rows, page.Generation);
                        encoded = Wire.EncodeAuthorTextRankedPage(new(page.Ready, next, page.Rows.Select(row => row.Match).ToArray()));
                    }

                    string Next(bool more, IReadOnlyList<AuthorTextRankedRow> rows, byte[]? generation) =>
                        more ? cursors.Encode(rows[^1].Key, generation!, actor, digest, cursorQuery, type) : "";
                }
                ct.ThrowIfCancellationRequested();
                SiteSessions.RequireCurrent(actor.Id, digest, expected);
                return encoded;

                async Task RequireIndex()
                {
                    if (!await CurrentSchema.HasAuthorTextHeadingIndexAsync(db, tx, ct))
                        throw new BusinessException(Rejection.NotFound, "Install or upgrade the private article index with author-search.");
                }
            }, ct);
            return Results.Bytes(payload, Aeds.ContentType);
        }).RequireRateLimiting("command");
    }
}
