using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Sessions;
using FsusBlogV2.Storage;

namespace FsusBlog.V2.Server.Authoring;

internal static class AuthorTextSearchEndpoints
{
    internal static void Map(WebApplication app, string cookie, Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame)
    {
        app.MapPost(WireRoutes.AuthorTextSearch, async (HttpContext context, Store store, CancellationToken ct) =>
        {
            var frame = await readFrame(context, WireLimits.MaxAuthorTextSearchQueryFrameBytes, ct);
            var token = context.Request.Cookies[cookie];
            var expected = SiteSessions.Requested(context);
            var payload = await store.WithSession(token, true, async (db, tx, actor) =>
            {
                var digest = Store.TokenDigest(token)!;
                SiteSessions.RequireCurrent(actor.Id, digest, expected);
                var input = AuthorTextProfile.Parse(Wire.DecodeAuthorTextSearchQuery(frame));
                if (!await CurrentSchema.HasAuthorTextIndexAsync(db, tx, ct))
                    throw new BusinessException(Rejection.NotFound, "The private article index is not installed.");
                var page = await AuthorTextIndex.Read(db, tx, actor, input, ct);
                ct.ThrowIfCancellationRequested();
                SiteSessions.RequireCurrent(actor.Id, digest, expected);
                // Serialize under the account/session locks and the exact result article locks.
                // WithSession rechecks expiry and commits before any response can be sent.
                return Wire.EncodeAuthorTextSearchPage(page);
            }, ct);
            return Results.Bytes(payload, Aeds.ContentType);
        }).RequireRateLimiting("command");
    }
}
