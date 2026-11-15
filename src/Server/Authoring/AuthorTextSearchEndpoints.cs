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
        app.MapPost(WireRoutes.AuthorTextSearch, async (HttpContext context, Store store, CancellationToken ct) =>
        {
            var frame = await readFrame(context, WireLimits.MaxAuthorTextPropertyFacetQueryFrameBytes, ct);
            var token = context.Request.Cookies[cookie];
            var expected = SiteSessions.Requested(context);
            var payload = await store.WithSession(token, true, async (db, tx, actor) =>
            {
                var digest = Store.TokenDigest(token)!;
                SiteSessions.RequireCurrent(actor.Id, digest, expected);
                Aeds.Decode(frame, out var type);
                if (type != FrameType.AuthorTextPropertyFacetQuery && frame.Length > WireLimits.MaxAuthorTextQualifiedQueryFrameBytes)
                    throw new BadHttpRequestException("Request too large.", 413);
                // Serialize under the account/session and exact result article locks.
                // WithSession rechecks expiry and commits before sending any response.
                byte[] encoded;
                if (type == FrameType.AuthorTextSearchQuery)
                {
                    var input = AuthorTextProfile.Parse(Wire.DecodeAuthorTextSearchQuery(frame));
                    await RequireIndex();
                    var page = await AuthorTextIndex.Read(db, tx, actor, input, ct);
                    encoded = Wire.EncodeAuthorTextSearchPage(page);
                }
                else
                {
                    var propertyFacet = type == FrameType.AuthorTextPropertyFacetQuery ? Wire.DecodeAuthorTextPropertyFacetQuery(frame) : null;
                    var includeHeading = type == FrameType.AuthorTextHeadingQuery || propertyFacet?.IncludeHeading == true;
                    var includeSummary = includeHeading || propertyFacet is not null || type == FrameType.AuthorTextSummaryQuery;
                    var qualified = type switch
                    {
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
                        await RequireIndex();
                        var page = qualified is null
                            ? await AuthorTextIndex.ReadFaceted(db, tx, actor, input, after?.Position, after?.Generation, ct)
                            : await AuthorTextIndex.ReadQualified(db, tx, actor, input, qualified.UpdatedFromUnixMs,
                                qualified.UpdatedUntilUnixMs, qualified.SchemaRevision, qualified.Conditions, after?.Position,
                                after?.Generation, ct, includeSummary: includeSummary, includeHeading: includeHeading,
                                facet: propertyFacet is null ? null : new(propertyFacet.DefinitionId, propertyFacet.DefinitionRevision));
                        var next = Next(page.More, page.Rows, page.Generation);
                        var response = new FsusBlog.V2.Contracts.AuthorTextFacetedPage(page.Ready, next, page.Total, page.StateCounts,
                            page.MoreCategories, page.Categories, page.MoreTags, page.Tags, page.Rows.Select(row => row.Match).ToArray());
                        encoded = type switch
                        {
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
