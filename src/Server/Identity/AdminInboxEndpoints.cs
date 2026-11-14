using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;

namespace FsusBlog.V2.Server.Administration;

internal static class AdminInboxEndpoints
{
    internal static void Map(WebApplication app, AdminPasskeyStore store, string session)
    {
        app.MapGet(WireRoutes.AdminInboxQueue, async (HttpContext ctx, CancellationToken ct) =>
        {
            var filter = Query(ctx.Request.Query, "status", 7) switch
            {
                null => -1, "open" => 0, "pending" => 1, "closed" => 2,
                _ => throw new BusinessException(Rejection.Invalid, "Invalid administrator inbox filter.")
            };
            var page = await store.ReadInbox(ctx.Request.Cookies[session], filter, Query(ctx.Request.Query, "cursor", 64), ct);
            return Results.Bytes(Wire.EncodeAdminInboxPage(page), Aeds.ContentType);
        }).RequireRateLimiting("command");

        app.MapGet(WireRoutes.AdminInboxThread, async (long id, HttpContext ctx, CancellationToken ct) =>
        {
            if (id <= 0) throw new BusinessException(Rejection.NotFound, "Administrator inbox conversation not found.");
            var thread = await store.ReadInboxThread(ctx.Request.Cookies[session], id, Query(ctx.Request.Query, "before", 64), ct);
            return Results.Bytes(Wire.EncodeAdminInboxThread(thread), Aeds.ContentType);
        }).RequireRateLimiting("command");
    }

    private static string? Query(IQueryCollection query, string key, int max)
    {
        if (!query.TryGetValue(key, out var values)) return null;
        return values.Count == 1 && values[0] is { Length: > 0 } value && value.Length <= max ? value :
            throw new BusinessException(Rejection.Invalid, "Invalid administrator inbox query.");
    }
}
