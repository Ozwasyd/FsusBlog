using System.Globalization;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Core.Extensions;
using FsusBlog.V2.Server.Security;

namespace FsusBlog.V2.Server.Administration;

internal static class AdminAppearanceEndpoints
{
    internal static void Map(WebApplication app, Uri origin, AdminPasskeyStore store, string session, string passkeyLimit,
        Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame, AppearanceRegistry registry)
    {
        var actions = new AdminActionRoutes(app, origin.GetLeftPart(UriPartial.Authority), session, readFrame);
        app.MapGet(WireRoutes.AdminAppearanceState, async (HttpContext ctx, CancellationToken ct) =>
            Frame(await store.ReadAppearance(ctx.Request.Cookies[session], registry, ct))).RequireRateLimiting("query");
        app.MapGet(WireRoutes.AdminAppearanceCatalog, async (HttpContext ctx, CancellationToken ct) =>
            Frame(await store.AppearanceCatalog(ctx.Request.Cookies[session], registry, ct))).RequireRateLimiting("query");
        app.MapGet(WireRoutes.AdminAppearanceFontDetail, async (HttpContext ctx, CancellationToken ct) =>
        {
            ctx.Response.Headers.CacheControl = "no-store";
            var query = ctx.Request.Query;
            var digest = query.Count == 1 && query.TryGetValue("digest", out var digests) && digests.Count == 1 ? digests[0] : null;
            return Frame(await store.AppearanceFontDetail(ctx.Request.Cookies[session], registry, digest, ct));
        }).RequireRateLimiting("query");
        app.MapGet(WireRoutes.AdminAppearanceHistory, async (HttpContext ctx, CancellationToken ct) =>
        {
            ctx.Response.Headers.CacheControl = "no-store";
            var query = ctx.Request.Query;
            if (query.Keys.Any(key => key is not ("before" or "limit"))) throw HistoryQueryError();
            var before = HistoryCoordinate(query, "before");
            var limit = HistoryCoordinate(query, "limit") ?? WireLimits.AdminAppearanceHistoryPageSize;
            if (limit > WireLimits.AdminAppearanceHistoryMaximumItems) throw HistoryQueryError();
            return Frame(await store.AppearanceHistory(ctx.Request.Cookies[session], before, (int)limit, ct));
        }).RequireRateLimiting("query");
        actions.Complete(WireRoutes.AdminAppearanceStepUpComplete, passkeyLimit, store.CompleteAppearanceStepUp);

        app.MapPost(WireRoutes.AdminAppearanceStepUpBegin, async (HttpContext ctx, CancellationToken ct) =>
        {
            var (_, command) = await Decode(ctx, ct);
            return Frame(await store.BeginAppearanceStepUp(ctx.Request.Cookies[session], registry, command, ct));
        }).RequireRateLimiting(passkeyLimit);

        app.MapPost(WireRoutes.AdminAppearancePow, (HttpContext ctx, ScopedPow pow, CancellationToken ct) =>
            ScopedPow.Protect(ctx, async () =>
            {
                var (frame, command) = await Decode(ctx, ct);
                return await store.IssueAppearancePow(ctx.Request.Cookies[session], registry, command, frame, pow, ctx, ct);
            }, PowScope.AdminAppearance)).RequireRateLimiting("command");

        app.MapPost(WireRoutes.AdminAppearanceApply, (HttpContext ctx, ScopedPow pow, CancellationToken ct) =>
            ScopedPow.Protect(ctx, async () =>
            {
                var (frame, command) = await Decode(ctx, ct);
                var proof = AdminActionRoutes.Proof(ctx);
                await store.ApplyAppearance(ctx.Request.Cookies[session], registry, command, frame, proof, pow, ctx, ct);
                return Wire.EncodeEmptySuccess();
            }, PowScope.AdminAppearance)).RequireRateLimiting("command");

        async Task<(byte[], AdminAppearanceCommand)> Decode(HttpContext ctx, CancellationToken ct)
        {
            var body = await actions.Read(ctx, WireLimits.AdminAppearanceCommandFrameBytes, ct);
            return (body, Wire.DecodeAdminAppearanceCommand(body));
        }
    }

    private static long? HistoryCoordinate(IQueryCollection query, string key)
    {
        if (!query.TryGetValue(key, out var values)) return null;
        if (values is { Count: 1 } && values[0] is { Length: >= 1 and <= 19 } text &&
            long.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var coordinate) && coordinate > 0 &&
            coordinate.ToString(CultureInfo.InvariantCulture) == text) return coordinate;
        throw HistoryQueryError();
    }

    private static BusinessException HistoryQueryError() =>
        new(Rejection.Invalid, "Use an exact appearance revision and a history page size from 1 to 50.");

    private static IResult Frame(byte[] frame) => Results.Bytes(frame, Aeds.ContentType);
}
