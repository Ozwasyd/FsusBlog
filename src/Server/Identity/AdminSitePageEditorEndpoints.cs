using System.Globalization;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Content;
using FsusBlog.V2.Server.Security;
using static FsusBlog.V2.Server.Administration.AdminActionRoutes;

namespace FsusBlog.V2.Server.Administration;

internal static class AdminSitePageEditorEndpoints
{
    internal static void Map(AdminActionRoutes actions, AdminSitePageStore store)
    {
        actions.App.MapQueryGet(WireRoutes.AdminSitePageRevision, async (HttpContext ctx, SitePages pages, string slug, CancellationToken ct) =>
            Frame(Wire.EncodeAdminSitePageRevision(await store.CurrentSitePage(actions.Session(ctx), pages, slug, ct))));

        actions.App.MapPost(WireRoutes.AdminSitePageStepUpBegin, async (HttpContext ctx, SitePages pages, CancellationToken ct) =>
        {
            var frame = await actions.Read(ctx, WireLimits.AdminSitePagePublishFrameBytes, ct);
            var intent = Wire.DecodeAdminSitePagePublish(frame);
            return Frame(await store.BeginSitePageStepUp(actions.Session(ctx), pages, intent, ct));
        }).RequireRateLimiting(actions.PasskeyLimit);
        actions.Complete(WireRoutes.AdminSitePageStepUpComplete, store.CompleteSitePageStepUp);

        actions.App.MapCommandPost(WireRoutes.AdminSitePagePow, (HttpContext ctx, SitePages pages, ScopedPow pow, CancellationToken ct) =>
            ScopedPow.Protect(ctx, async () =>
            {
                var frame = await actions.Read(ctx, WireLimits.AdminSitePagePublishFrameBytes, ct);
                var intent = Wire.DecodeAdminSitePagePublish(frame);
                return await store.IssueSitePagePow(actions.Session(ctx), pages, intent, frame, pow, ctx, ct);
            }, PowScope.AdminSitePagePublish));

        actions.App.MapCommandPost(WireRoutes.AdminSitePagePublish, (HttpContext ctx, SitePages pages, ScopedPow pow, CancellationToken ct) =>
            Publish(ctx, pages, pow, legacy: false, ct));
        actions.App.MapCommandPut(WireRoutes.AdminLegacySitePageUpdate, (HttpContext ctx, SitePages pages, ScopedPow pow, CancellationToken ct) =>
            Publish(ctx, pages, pow, legacy: true, ct));

        async Task<IResult> Publish(HttpContext ctx, SitePages pages, ScopedPow pow, bool legacy, CancellationToken ct)
        {
            try
            {
                return await ScopedPow.Protect(ctx, async () =>
                {
                    var frame = await actions.Read(ctx, legacy ? SitePageWire.MaxUpdateFrameBytes : WireLimits.AdminSitePagePublishFrameBytes, ct);
                    var intent = legacy ? LegacyIntent(ctx, frame) : Wire.DecodeAdminSitePagePublish(frame);
                    if (legacy) frame = Wire.EncodeAdminSitePagePublish(intent);
                    var proof = Proof(ctx);
                    await store.PublishSitePage(actions.Session(ctx), pages, intent, frame, proof, pow, ctx, ct);
                    var publications = ctx.RequestServices.GetService<Publications>();
                    if (publications is not null)
                    {
                        try { await publications.Refresh(ct); }
                        catch when (!ct.IsCancellationRequested) { }
                    }
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
}
