using System.Globalization;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Content;
using FsusBlog.V2.Server.Security;

namespace FsusBlog.V2.Server.Administration;

internal static class AdminSitePageEditorEndpoints
{
    internal static void Map(WebApplication app, Uri origin, AdminPasskeyStore store, string session, string passkeyLimit,
        Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame)
    {
        var actions = new AdminActionRoutes(app, origin.GetLeftPart(UriPartial.Authority), session, readFrame);
        app.MapGet(WireRoutes.AdminSitePageRevision, async (HttpContext ctx, SitePages pages, string slug, CancellationToken ct) =>
            Frame(Wire.EncodeAdminSitePageRevision(await store.CurrentSitePage(ctx.Request.Cookies[session], pages, slug, ct))))
            .RequireRateLimiting("query");

        app.MapPost(WireRoutes.AdminSitePageStepUpBegin, async (HttpContext ctx, SitePages pages, CancellationToken ct) =>
        {
            var frame = await actions.Read(ctx, WireLimits.AdminSitePagePublishFrameBytes, ct);
            var intent = Wire.DecodeAdminSitePagePublish(frame);
            return Frame(await store.BeginSitePageStepUp(ctx.Request.Cookies[session], pages, intent, ct));
        }).RequireRateLimiting(passkeyLimit);
        actions.Complete(WireRoutes.AdminSitePageStepUpComplete, passkeyLimit, store.CompleteSitePageStepUp);

        app.MapPost(WireRoutes.AdminSitePagePow, (HttpContext ctx, SitePages pages, ScopedPow pow, CancellationToken ct) =>
            ScopedPow.Protect(ctx, async () =>
            {
                var frame = await actions.Read(ctx, WireLimits.AdminSitePagePublishFrameBytes, ct);
                var intent = Wire.DecodeAdminSitePagePublish(frame);
                return await store.IssueSitePagePow(ctx.Request.Cookies[session], pages, intent, frame, pow, ctx, ct);
            }, PowScope.AdminSitePagePublish)).RequireRateLimiting("command");

        app.MapPost(WireRoutes.AdminSitePagePublish, (HttpContext ctx, SitePages pages, ScopedPow pow, CancellationToken ct) =>
            Publish(ctx, pages, pow, legacy: false, ct)).RequireRateLimiting("command");
        app.MapPut(WireRoutes.AdminLegacySitePageUpdate, (HttpContext ctx, SitePages pages, ScopedPow pow, CancellationToken ct) =>
            Publish(ctx, pages, pow, legacy: true, ct)).RequireRateLimiting("command");

        async Task<IResult> Publish(HttpContext ctx, SitePages pages, ScopedPow pow, bool legacy, CancellationToken ct)
        {
            try
            {
                return await ScopedPow.Protect(ctx, async () =>
                {
                    var frame = await actions.Read(ctx, legacy ? SitePageWire.MaxUpdateFrameBytes : WireLimits.AdminSitePagePublishFrameBytes, ct);
                    var intent = legacy ? LegacyIntent(ctx, frame) : Wire.DecodeAdminSitePagePublish(frame);
                    if (legacy) frame = Wire.EncodeAdminSitePagePublish(intent);
                    var proof = AdminActionRoutes.Proof(ctx);
                    await store.PublishSitePage(ctx.Request.Cookies[session], pages, intent, frame, proof, pow, ctx, ct);
                    return Wire.EncodeEmptySuccess();
                }, PowScope.AdminSitePagePublish);
            }
            catch (BusinessException problem) when (legacy && problem.Rejection == Rejection.Conflict)
            {
                const int status = StatusCodes.Status412PreconditionFailed;
                return new AedsError(status, Wire.EncodeError(status, problem.Message, traceId: ctx.TraceIdentifier));
            }
        }
    }

    private static AdminSitePagePublish LegacyIntent(HttpContext ctx, byte[] frame)
    {
        var update = SitePageWire.DecodeUpdate(frame);
        var tags = ctx.Request.Headers.IfMatch;
        if (tags.Count == 0)
            throw new BadHttpRequestException("A current site page ETag is required.", StatusCodes.Status428PreconditionRequired);
        var tag = tags.Count == 1 ? tags[0].AsSpan() : default;
        var prefix = $"\"{update.Slug}.";
        if (tag.Length <= prefix.Length + WireLimits.AdminSitePageDigestBytes + 2 ||
            !tag.StartsWith(prefix, StringComparison.Ordinal) || tag[^1] != '"')
            throw new ProtocolException("Invalid site page ETag");

        var suffix = tag[prefix.Length..^1];
        var separator = suffix.Length - WireLimits.AdminSitePageDigestBytes - 1;
        var revisionText = suffix[..separator];
        if (suffix[separator] != '.' || (revisionText.Length > 1 && revisionText[0] == '0') ||
            !long.TryParse(revisionText, NumberStyles.None, CultureInfo.InvariantCulture, out var revision))
            throw new ProtocolException("Invalid site page ETag");
        return new(update.Slug, revision, suffix[(separator + 1)..].ToString(), update.Markdown);
    }

    private static IResult Frame(byte[] frame) => Results.Bytes(frame, Aeds.ContentType);
}
