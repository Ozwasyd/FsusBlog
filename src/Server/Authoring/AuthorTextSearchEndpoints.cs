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
            var frame = await readFrame(context, WireLimits.MaxAuthorTextRankedQueryFrameBytes, ct);
            var token = context.Request.Cookies[cookie];
            var expected = SiteSessions.Requested(context);
            var payload = await store.WithSession(token, true, async (db, tx, actor) =>
            {
                var digest = Store.TokenDigest(token)!;
                SiteSessions.RequireCurrent(actor.Id, digest, expected);
                Aeds.Decode(frame, out var type);
                var ranked = type == FrameType.AuthorTextRankedQuery ? Wire.DecodeAuthorTextRankedQuery(frame) : null;
                var legacyInput = ranked is null ? AuthorTextProfile.Parse(Wire.DecodeAuthorTextSearchQuery(frame)) : null;
                var rankedInput = ranked is null ? null : AuthorTextProfile.ParseRanked(ranked.Query);
                if (!await CurrentSchema.HasAuthorTextIndexAsync(db, tx, ct))
                    throw new BusinessException(Rejection.NotFound, "The private article index is not installed.");

                // Serialize under the account/session and exact result article locks.
                // WithSession rechecks expiry and commits before sending any response.
                byte[] encoded;
                if (ranked is null)
                {
                    var page = await AuthorTextIndex.Read(db, tx, actor, legacyInput!, ct);
                    encoded = Wire.EncodeAuthorTextSearchPage(page);
                }
                else
                {
                    (AuthorTextRankKey Position, byte[] Generation)? after = ranked.Cursor.Length == 0
                        ? null : cursors.Decode(ranked.Cursor, actor, digest, ranked.Query);
                    var page = await AuthorTextIndex.ReadRanked(db, tx, actor, rankedInput!, after?.Position, after?.Generation, ct);
                    var next = page.More ? cursors.Encode(page.Rows[^1].Key, page.Generation!, actor, digest, ranked.Query) : "";
                    encoded = Wire.EncodeAuthorTextRankedPage(new(page.Ready, next, page.Rows.Select(row => row.Match).ToArray()));
                }
                ct.ThrowIfCancellationRequested();
                SiteSessions.RequireCurrent(actor.Id, digest, expected);
                return encoded;
            }, ct);
            return Results.Bytes(payload, Aeds.ContentType);
        }).RequireRateLimiting("command");
    }
}
