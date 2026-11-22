using System.Globalization;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Core.Extensions;
using FsusBlog.V2.Server.Security;
using static FsusBlog.V2.Server.Administration.AdminActionRoutes;

namespace FsusBlog.V2.Server.Administration;

internal static class AdminAppearanceEndpoints
{
    internal static void Map(AdminActionRoutes actions, AdminAppearanceStore store, AppearanceRegistry registry)
    {
        actions.App.MapQueryGet(WireRoutes.AdminAppearanceState, async (HttpContext ctx, CancellationToken ct) =>
            Frame(await store.ReadAppearance(actions.Session(ctx), registry, ct)));
        actions.App.MapQueryGet(WireRoutes.AdminAppearanceCatalog, async (HttpContext ctx, CancellationToken ct) =>
            Frame(await store.AppearanceCatalog(actions.Session(ctx), registry, ct)));
        actions.App.MapQueryGet(WireRoutes.AdminAppearanceFontDetail, async (HttpContext ctx, CancellationToken ct) =>
        {
            ctx.Response.Headers.CacheControl = "no-store";
            var query = ctx.Request.Query;
            var digest = query.Count == 1 && query.TryGetValue("digest", out var digests) && digests.Count == 1 ? digests[0] : null;
            return Frame(await store.AppearanceFontDetail(actions.Session(ctx), registry, digest, ct));
        });
        actions.App.MapQueryGet(WireRoutes.AdminAppearanceHistory, async (HttpContext ctx, CancellationToken ct) =>
        {
            ctx.Response.Headers.CacheControl = "no-store";
            var query = ctx.Request.Query;
            if (query.Keys.Any(key => key is not ("before" or "limit"))) throw HistoryQueryError();
            var before = HistoryCoordinate(query, "before");
            var limit = HistoryCoordinate(query, "limit") ?? WireLimits.AdminAppearanceHistoryPageSize;
            if (limit > WireLimits.AdminAppearanceHistoryMaximumItems) throw HistoryQueryError();
            return Frame(await store.AppearanceHistory(actions.Session(ctx), before, (int)limit, ct));
        });
        actions.Complete(WireRoutes.AdminAppearanceStepUpComplete, store.CompleteAppearanceStepUp);

        actions.App.MapPost(WireRoutes.AdminAppearanceStepUpBegin, async (HttpContext ctx, CancellationToken ct) =>
        {
            var (_, command) = await Decode(ctx, ct);
            return Frame(await store.BeginAppearanceStepUp(actions.Session(ctx), registry, command, ct));
        }).RequireRateLimiting(actions.PasskeyLimit);

        actions.App.MapCommandPost(WireRoutes.AdminAppearancePow, (HttpContext ctx, ScopedPow pow, CancellationToken ct) =>
            ScopedPow.Protect(ctx, async () =>
            {
                var (frame, command) = await Decode(ctx, ct);
                return await store.IssueAppearancePow(actions.Session(ctx), registry, command, frame, pow, ctx, ct);
            }, PowScope.AdminAppearance));

        actions.App.MapCommandPost(WireRoutes.AdminAppearanceApply, (HttpContext ctx, ScopedPow pow, CancellationToken ct) =>
            ScopedPow.Protect(ctx, async () =>
            {
                var (frame, command) = await Decode(ctx, ct);
                var proof = Proof(ctx);
                await store.ApplyAppearance(actions.Session(ctx), registry, command, frame, proof, pow, ctx, ct);
                return Wire.EncodeEmptySuccess();
            }, PowScope.AdminAppearance));

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

}
