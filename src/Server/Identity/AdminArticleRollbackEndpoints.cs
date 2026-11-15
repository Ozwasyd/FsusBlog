using System.Globalization;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Passkeys;

namespace FsusBlog.V2.Server.Administration;

internal static class AdminArticleRollbackEndpoints
{
    internal const string Setting = "FSUSBLOG_ADMIN_ARTICLE_ROLLBACK";

    internal static void Map(WebApplication app, Uri origin, AdminPasskeyStore store, string session, string limit,
        Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame)
    {
        var authority = origin.GetLeftPart(UriPartial.Authority);
        app.MapGet(WireRoutes.AdminArticleRollbackAvailability, async (HttpContext ctx, CancellationToken ct) =>
        {
            await store.CheckArticleRollbackAvailability(ctx.Request.Cookies[session], ct);
            return Results.NoContent();
        }).RequireRateLimiting("command");
        app.MapGet(WireRoutes.AdminArticleRollbackPreview, async (HttpContext ctx, CancellationToken ct) =>
        {
            var article = PositiveCoordinate(ctx, "articleId");
            var source = PositiveCoordinate(ctx, "sourceRevision");
            if (article > int.MaxValue) throw InvalidCoordinate();
            var result = await store.PreviewArticleRollback(ctx.Request.Cookies[session], (int)article, source, ct);
            return Frame(Wire.EncodeAdminArticleRollbackPreview(result));
        }).RequireRateLimiting("query");
        app.MapPost(WireRoutes.AdminArticleRollbackStepUpBegin, async (HttpContext ctx, CancellationToken ct) =>
        {
            AdminModerationEndpoints.RequireOrigin(ctx, authority);
            var input = await ReadIntent(ctx, ct);
            return Frame(await store.BeginArticleRollbackStepUp(ctx.Request.Cookies[session], input, ct));
        }).RequireRateLimiting(limit);
        app.MapPost(WireRoutes.AdminArticleRollbackStepUpComplete, async (HttpContext ctx, CancellationToken ct) =>
        {
            AdminModerationEndpoints.RequireOrigin(ctx, authority);
            var assertion = PasskeyWire.ReadLogin(await readFrame(ctx, WireLimits.MaxPasskeyFrameBytes, ct), discoverable: false);
            return Frame(await store.CompleteArticleRollbackStepUp(ctx.Request.Cookies[session], assertion, ct));
        }).RequireRateLimiting(limit);
        app.MapPost(WireRoutes.AdminArticleRollbackExecute, async (HttpContext ctx, Publications publications, CancellationToken ct) =>
        {
            AdminModerationEndpoints.RequireOrigin(ctx, authority);
            var input = await ReadIntent(ctx, ct);
            var proof = ctx.Request.Headers[WireHeaders.MfaProof] is { Count: 1 } value ? value[0] : null;
            var receipt = await publications.AdministrativePublication(
                invalidate => store.ExecuteArticleRollback(ctx.Request.Cookies[session], proof, input, invalidate, ct), ct);
            return Frame(Wire.EncodeAdminArticleRollbackReceipt(receipt));
        }).RequireRateLimiting("command");

        app.MapGet(WireRoutes.AdminArticleDraftRollbackAvailability, async (HttpContext ctx, CancellationToken ct) =>
        {
            await store.CheckArticleDraftRollbackAvailability(ctx.Request.Cookies[session], ct);
            return Results.NoContent();
        }).RequireRateLimiting("command");
        app.MapPost(WireRoutes.AdminArticleDraftRollbackStepUpBegin, async (HttpContext ctx, CancellationToken ct) =>
        {
            AdminModerationEndpoints.RequireOrigin(ctx, authority);
            var input = await ReadDraftIntent(ctx, ct);
            return Frame(await store.BeginArticleDraftRollbackStepUp(ctx.Request.Cookies[session], input, ct));
        }).RequireRateLimiting(limit);
        app.MapPost(WireRoutes.AdminArticleDraftRollbackStepUpComplete, async (HttpContext ctx, CancellationToken ct) =>
        {
            AdminModerationEndpoints.RequireOrigin(ctx, authority);
            var assertion = PasskeyWire.ReadLogin(await readFrame(ctx, WireLimits.MaxPasskeyFrameBytes, ct), discoverable: false);
            return Frame(await store.CompleteArticleDraftRollbackStepUp(ctx.Request.Cookies[session], assertion, ct));
        }).RequireRateLimiting(limit);
        app.MapPost(WireRoutes.AdminArticleDraftRollbackExecute, async (HttpContext ctx, Publications publications, CancellationToken ct) =>
        {
            AdminModerationEndpoints.RequireOrigin(ctx, authority);
            var input = await ReadDraftIntent(ctx, ct);
            var proof = ctx.Request.Headers[WireHeaders.MfaProof] is { Count: 1 } value ? value[0] : null;
            var receipt = await publications.AdministrativePublication(
                invalidate => store.ExecuteArticleDraftRollback(ctx.Request.Cookies[session], proof, input, invalidate, ct), ct);
            return Frame(Wire.EncodeAdminArticleDraftRollbackReceipt(receipt));
        }).RequireRateLimiting("command");

        async Task<AdminArticleRollbackIntent> ReadIntent(HttpContext ctx, CancellationToken ct)
        {
            var intent = Wire.DecodeAdminArticleRollbackIntent(await readFrame(ctx, WireLimits.MaxAdminArticleRollbackFrameBytes, ct));
            RequireCommandHeader(ctx, intent.IdempotencyKey);
            return intent;
        }

        async Task<AdminArticleDraftRollbackIntent> ReadDraftIntent(HttpContext ctx, CancellationToken ct)
        {
            var intent = Wire.DecodeAdminArticleDraftRollbackIntent(await readFrame(ctx, WireLimits.MaxAdminArticleDraftRollbackFrameBytes, ct));
            RequireCommandHeader(ctx, intent.IdempotencyKey);
            return intent;
        }
    }

    private static void RequireCommandHeader(HttpContext ctx, Guid expected)
    {
        if (ctx.Request.Headers.TryGetValue(WireHeaders.ClientMutationId, out var header) &&
            (header.Count != 1 || !Guid.TryParseExact(header[0], "D", out var id) || id != expected))
            throw new BusinessException(Rejection.Invalid, "Command key does not match its request header.");
    }

    private static long PositiveCoordinate(HttpContext ctx, string key)
    {
        if (ctx.Request.Query[key] is { Count: 1 } values && values[0] is { Length: >= 1 and <= 19 } text &&
            long.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var coordinate) && coordinate > 0 &&
            coordinate.ToString(CultureInfo.InvariantCulture) == text)
            return coordinate;
        throw InvalidCoordinate();
    }

    private static BusinessException InvalidCoordinate() =>
        new(Rejection.Invalid, "Use an exact article ID and historical revision.");

    private static IResult Frame(byte[] frame) => Results.Bytes(frame, Aeds.ContentType);
}
