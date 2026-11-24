using System.Globalization;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Core.Extensions;
using FsusBlog.V2.Server.Content;
using FsusBlog.V2.Server.Security;
using static FsusBlog.V2.Server.Administration.AdminActionRoutes;

namespace FsusBlog.V2.Server.Administration;

internal static class AdminArticleRollbackEndpoints
{
    internal const string Setting = "FSUSBLOG_ADMIN_ARTICLE_ROLLBACK";

    internal static void Map(AdminActionRoutes actions, AdminArticleRollbackStore rollback, AdminArticleArchiveStore archive)
    {
        MapAction<AdminArticleRollbackIntent, AdminArticleRollbackReceipt>(
            WireRoutes.AdminArticleRollbackAvailability, WireRoutes.AdminArticleRollbackStepUpBegin,
            WireRoutes.AdminArticleRollbackStepUpComplete, WireRoutes.AdminArticleRollbackExecute,
            WireLimits.MaxAdminArticleRollbackFrameBytes, Wire.DecodeAdminArticleRollbackIntent, intent => intent.IdempotencyKey,
            rollback.CheckArticleRollbackAvailability, rollback.BeginArticleRollbackStepUp, rollback.CompleteArticleRollbackStepUp,
            rollback.ExecuteArticleRollback, Wire.EncodeAdminArticleRollbackReceipt);
        actions.App.MapQueryGet(WireRoutes.AdminArticleRollbackPreview, async (HttpContext ctx, CancellationToken ct) =>
        {
            var (article, source) = (PositiveCoordinate(ctx, "articleId"), PositiveCoordinate(ctx, "sourceRevision"));
            if (article > int.MaxValue) throw InvalidCoordinate();
            return Frame(Wire.EncodeAdminArticleRollbackPreview(await rollback.PreviewArticleRollback(actions.Session(ctx), (int)article, source, ct)));
        });

        MapAction<AdminArticleDraftRollbackIntent, AdminArticleDraftRollbackReceipt>(
            WireRoutes.AdminArticleDraftRollbackAvailability, WireRoutes.AdminArticleDraftRollbackStepUpBegin,
            WireRoutes.AdminArticleDraftRollbackStepUpComplete, WireRoutes.AdminArticleDraftRollbackExecute,
            WireLimits.MaxAdminArticleDraftRollbackFrameBytes, Wire.DecodeAdminArticleDraftRollbackIntent, intent => intent.IdempotencyKey,
            rollback.CheckArticleDraftRollbackAvailability, rollback.BeginArticleDraftRollbackStepUp, rollback.CompleteArticleDraftRollbackStepUp,
            rollback.ExecuteArticleDraftRollback, Wire.EncodeAdminArticleDraftRollbackReceipt);

        MapAction<AdminArticleArchiveIntent, AdminArticleArchiveReceipt>(
            WireRoutes.AdminArticleArchiveAvailability, WireRoutes.AdminArticleArchiveStepUpBegin,
            WireRoutes.AdminArticleArchiveStepUpComplete, WireRoutes.AdminArticleArchiveExecute,
            WireLimits.MaxAdminArticleArchiveFrameBytes, Wire.DecodeAdminArticleArchiveIntent, intent => intent.IdempotencyKey,
            archive.CheckArticleArchiveAvailability, archive.BeginArticleArchiveStepUp, archive.CompleteArticleArchiveStepUp,
            archive.ExecuteArticleArchive, Wire.EncodeAdminArticleArchiveReceipt);
        actions.App.MapQueryGet(WireRoutes.AdminArticleArchivePage, async (HttpContext ctx, CancellationToken ct) =>
        {
            var before = ctx.Request.Query.ContainsKey("before") ? PositiveCoordinate(ctx, "before") : 0;
            if (before > int.MaxValue) throw InvalidCoordinate();
            return Frame(Wire.EncodeAdminArticleArchivePage(await archive.ListArchivedArticles(actions.Session(ctx), (int)before, ct)));
        });
        actions.App.MapQueryGet(WireRoutes.AdminArticleArchivePreview, async (HttpContext ctx, CancellationToken ct) =>
        {
            var (article, revision, privateRelease) = (PositiveCoordinate(ctx, "articleId"), PositiveCoordinate(ctx, "revision"), PositiveCoordinate(ctx, "privateReleaseId"));
            if (article > int.MaxValue) throw InvalidCoordinate();
            return Frame(await archive.PreviewArchivedArticle(actions.Session(ctx), (int)article, revision, privateRelease, ct));
        });

        void MapAction<TIntent, TReceipt>(string available, string begin, string complete, string execute,
            int maximum, IntentDecoder<TIntent> decode, Func<TIntent, Guid> idempotencyKey,
            Func<string?, CancellationToken, Task> checkAvailability,
            Func<string?, TIntent, CancellationToken, Task<byte[]>> beginStepUp,
            Func<string?, PasskeyLoginRequest, CancellationToken, Task<byte[]>> completeStepUp,
            Func<string?, string?, TIntent, Action, CancellationToken, Task<TReceipt>> apply,
            Func<TReceipt, byte[]> encode)
        {
            Task<TIntent> ReadIntent(HttpContext ctx, CancellationToken ct) =>
                actions.ReadIntent(ctx, maximum, decode, idempotencyKey, required: false, ct);
            actions.Availability(available, checkAvailability);
            actions.Begin(begin, ReadIntent, beginStepUp);
            actions.Complete(complete, completeStepUp);
            actions.App.MapCommandPost(execute, async (HttpContext ctx, Publications publications, CancellationToken ct) =>
            {
                var intent = await ReadIntent(ctx, ct);
                var receipt = await publications.AdministrativePublication(
                    invalidate => apply(actions.Session(ctx), Proof(ctx), intent, invalidate, ct), ct);
                return Frame(encode(receipt));
            });
        }
    }
}

internal static class AdminArticleTrashRestore
{
    internal static void Map(AdminActionRoutes actions, AdminArticleTrashRestoreStore store)
    {
        Task<AdminArticleTrashRestoreIntent> Intent(HttpContext ctx, CancellationToken ct) =>
            actions.ReadIntent(ctx, WireLimits.AdminArticleTrashRestoreIntentFrameBytes, Wire.DecodeAdminArticleTrashRestoreIntent,
                intent => intent.IdempotencyKey, required: true, ct);
        actions.Availability(WireRoutes.AdminArticleTrashRestoreAvailability, store.CheckTrashRestoreAvailability);
        actions.Complete(WireRoutes.AdminArticleTrashRestoreComplete, store.CompleteTrashRestoreStepUp);
        actions.Begin(WireRoutes.AdminArticleTrashRestoreBegin, Intent, store.BeginTrashRestoreStepUp);
        actions.App.MapCommandPost(WireRoutes.AdminArticleTrashRestoreExecute, async (HttpContext ctx, CancellationToken ct) =>
            Frame(Wire.EncodeAdminArticleTrashRestoreReceipt(
                await store.RestoreFromTrash(actions.Session(ctx), Proof(ctx), await Intent(ctx, ct), ct))));
    }
}

internal static class AdminArticleTrashPublication
{
    internal static void Map(AdminActionRoutes actions, AdminArticleTrashPublicationStore store)
    {
        var media = actions.App.Services.GetService<PublishedMediaStore>();
        Task<AdminArticleTrashPublicationIntent> Intent(HttpContext ctx, CancellationToken ct) =>
            actions.ReadIntent(ctx, WireLimits.MaxAdminArticleArchiveFrameBytes, Wire.DecodeAdminArticleTrashPublicationIntent,
                intent => intent.IdempotencyKey, required: true, ct);
        actions.Availability(WireRoutes.AdminArticleTrashPublicationAvailability, store.CheckTrashPublicationAvailability);
        actions.App.MapCommandGet(WireRoutes.AdminArticleTrashPublicationPreview, async (HttpContext ctx, CancellationToken ct) =>
        {
            var (article, revision) = (PositiveCoordinate(ctx, "articleId"), PositiveCoordinate(ctx, "revision"));
            if (article > int.MaxValue) throw new BusinessException(Rejection.Invalid, "Invalid article ID.");
            return Frame(Wire.EncodeAdminArticleTrashPublicationPreview(await store.PreviewTrashPublication(actions.Session(ctx), (int)article, revision, ct)));
        });
        actions.Complete(WireRoutes.AdminArticleTrashPublicationComplete, store.CompleteTrashPublicationStepUp);
        actions.Begin(WireRoutes.AdminArticleTrashPublicationBegin, Intent, store.BeginTrashPublicationStepUp);
        actions.App.MapCommandPost(WireRoutes.AdminArticleTrashPublicationExecute, async (HttpContext ctx, Publications publications, CancellationToken ct) =>
        {
            var intent = await Intent(ctx, ct);
            return Frame(Wire.EncodeAdminArticleTrashPublicationReceipt(await publications.AdministrativePublication(
                invalidate => store.RestoreTrashPublication(actions.Session(ctx), Proof(ctx), intent, media, invalidate, ct), ct)));
        });
    }
}

internal static class AdminTagMetadataEndpoints
{
    internal const string Setting = "FSUSBLOG_ADMIN_TAG_METADATA";
    internal const string CategorySetting = "FSUSBLOG_ADMIN_CATEGORY_METADATA";

    internal static void Map(AdminActionRoutes actions, AdminTagMetadataStore store, bool category = false)
    {
        var route = category ? WireRoutes.AdminCategoryMetadata : WireRoutes.AdminTagMetadata;
        var scope = category ? PowScope.AdminCategoryMetadata : PowScope.AdminTagMetadata;
        actions.Availability(category ? WireRoutes.AdminCategoryMetadataAvailability : WireRoutes.AdminTagMetadataAvailability,
            store.TagMetadataAvailable);
        actions.App.MapCommandGet(route, async (HttpContext ctx, int id, CancellationToken ct) => Frame(category
            ? Wire.EncodeAdminCategoryMetadata(await store.ReadCategoryMetadata(actions.Session(ctx), id, ct))
            : Wire.EncodeAdminTagMetadata(await store.ReadTagMetadata(actions.Session(ctx), id, ct))));
        actions.App.MapCommandPost(category ? WireRoutes.AdminCategoryMetadataPow : WireRoutes.AdminTagMetadataPow,
            (HttpContext ctx, int id, ScopedPow pow, CancellationToken ct) => Protect(ctx, id, pow, null, false, ct));
        actions.App.MapCommandPut(route, (HttpContext ctx, int id, ScopedPow pow, Publications publications, CancellationToken ct) =>
            Protect(ctx, id, pow, publications, false, ct));
        actions.App.MapCommandPost(category ? WireRoutes.AdminCategoryCreatePow : WireRoutes.AdminTagCreatePow,
            (HttpContext ctx, ScopedPow pow, CancellationToken ct) => Protect(ctx, 0, pow, null, true, ct));
        actions.App.MapCommandPost(category ? WireRoutes.AdminCategoryCreate : WireRoutes.AdminTagCreate,
            (HttpContext ctx, ScopedPow pow, Publications publications, CancellationToken ct) => Protect(ctx, 0, pow, publications, true, ct));
        actions.App.MapCommandPost(category ? WireRoutes.AdminCategoryDelete : WireRoutes.AdminTagDelete,
            async (HttpContext ctx, int id, Publications publications, CancellationToken ct) =>
            {
                actions.RequireOrigin(ctx);
                if (id <= 0)
                    throw new BusinessException(Rejection.Invalid, category ? "Invalid category ID." : "Invalid tag ID.");
                return Frame(await publications.AdministrativePublication(
                    invalidate => store.DeleteTaxonomy(actions.Session(ctx), id, category, invalidate, ct), ct));
            });

        Task<IResult> Protect(HttpContext ctx, int id, ScopedPow pow, Publications? publications, bool create, CancellationToken ct) =>
            ScopedPow.Protect(ctx, async () =>
            {
                var frame = await actions.Read(ctx, WireLimits.AdminTagMetadataFrameBytes, ct);
                var input = category ? Wire.DecodeAdminCategoryMetadataCommand(frame)
                    : create ? Wire.DecodeAdminTagCreateCommand(frame) : Wire.DecodeAdminTagMetadataCommand(frame);
                if (input.Id != id || (!create && id <= 0))
                    throw new BusinessException(Rejection.Invalid, category ? "Category ID does not match the request route." : "Tag ID does not match the request route.");
                Task<byte[]> Apply(Action? invalidate) => category
                    ? store.ChangeCategoryMetadata(actions.Session(ctx), input, frame, ctx, pow, invalidate, ct)
                    : store.ChangeTagMetadata(actions.Session(ctx), input, frame, ctx, pow, invalidate, ct);
                return publications is null ? await Apply(null) : await publications.AdministrativePublication(Apply, ct);
            }, scope);
    }
}

internal static class AdminSiteConfigEndpoints
{
    internal static void Map(AdminActionRoutes actions, AdminSiteConfigStore store, PublicSiteConfiguration config)
    {
        actions.App.MapQueryGet(WireRoutes.AdminSiteConfig, async (HttpContext ctx, CancellationToken ct) =>
            Frame(await store.ReadSiteConfig(actions.Session(ctx), config, ct)));
        actions.StepUpPow(WireRoutes.AdminSiteConfigStepUpBegin, WireRoutes.AdminSiteConfigStepUpComplete,
            WireRoutes.AdminSiteConfigPow, WireRoutes.AdminSiteConfigSave, WireLimits.AdminSiteConfigFrameBytes,
            Wire.DecodeAdminSiteConfigCommand, PowScope.AdminSiteConfig,
            (_, session, cmd, ct) => store.BeginSiteConfigStepUp(session, config, cmd, ct),
            store.CompleteSiteConfigStepUp,
            (ctx, session, cmd, frame, pow, ct) => store.IssueSiteConfigPow(session, config, cmd, frame, pow, ctx, ct),
            (ctx, session, cmd, frame, proof, pow, ct) => store.SaveSiteConfig(
                session, config, ctx.RequestServices.GetRequiredService<Publications>(), cmd, frame, proof, pow, ctx, ct));
    }
}

internal static class AdminSitePages
{
    internal const string LegacyPrefix = "/api/binary/system/admin/page";

    internal static bool IsLegacyRoute(PathString path)
    {
        if (path == WireRoutes.AdminLegacySitePageUpdate || path == WireRoutes.AdminLegacySitePageUpdate + "/")
            return true;
        if (!path.StartsWithSegments(LegacyPrefix, out var remaining) || remaining.Value is not { Length: > 1 } segment)
            return false;
        // Routing accepts an optional trailing slash. Guard both forms on the public origin.
        var slug = segment.AsSpan(1).TrimEnd('/');
        return !slug.IsEmpty && !slug.Contains('/');
    }

    internal static void Map(WebApplication app, AdminSitePageStore store, string session)
    {
        app.MapCommandGet(WireRoutes.AdminSitePages, async (HttpContext ctx, SitePages pages, CancellationToken ct) =>
        {
            var frame = await store.SitePagesOverview(ctx.Request.Cookies[session], pages, ct);
            if (pages.EditorEnabled) ctx.Response.Headers[WireHeaders.AdminSitePageEditor] = "1";
            return Frame(frame);
        });
        app.MapCommandGet(WireRoutes.AdminSitePage, async (HttpContext ctx, SitePages pages, string slug, CancellationToken ct) =>
            Frame(await store.SitePage(ctx.Request.Cookies[session], pages, slug, ct)));
        app.MapCommandGet(LegacyPrefix + "/{slug}", async (HttpContext ctx, SitePages pages, string slug, CancellationToken ct) =>
        {
            var token = ctx.Request.Cookies[session];
            if (!pages.EditorEnabled) return Frame(await store.SitePage(token, pages, slug, ct));
            var page = await store.CurrentSitePage(token, pages, slug, ct);
            ctx.Response.Headers.ETag = FormattableString.Invariant($"\"{page.Slug}.{page.Revision}.{page.Digest}\"");
            return Frame(SitePageWire.Encode(page.Slug, page.Markdown));
        });
    }
}

internal static class AdminSitePageEditorEndpoints
{
    internal static void Map(AdminActionRoutes actions, AdminSitePageStore store)
    {
        actions.App.MapQueryGet(WireRoutes.AdminSitePageRevision, async (HttpContext ctx, SitePages pages, string slug, CancellationToken ct) =>
            Frame(Wire.EncodeAdminSitePageRevision(await store.CurrentSitePage(actions.Session(ctx), pages, slug, ct))));
        actions.App.MapPost(WireRoutes.AdminSitePageStepUpBegin, async (HttpContext ctx, SitePages pages, CancellationToken ct) =>
            Frame(await store.BeginSitePageStepUp(actions.Session(ctx), pages,
                Wire.DecodeAdminSitePagePublish(await actions.Read(ctx, WireLimits.AdminSitePagePublishFrameBytes, ct)), ct)))
            .RequireRateLimiting(actions.PasskeyLimit);
        actions.Complete(WireRoutes.AdminSitePageStepUpComplete, store.CompleteSitePageStepUp);
        actions.App.MapCommandPost(WireRoutes.AdminSitePagePow, (HttpContext ctx, SitePages pages, ScopedPow pow, CancellationToken ct) =>
            ScopedPow.Protect(ctx, async () =>
            {
                var frame = await actions.Read(ctx, WireLimits.AdminSitePagePublishFrameBytes, ct);
                return await store.IssueSitePagePow(actions.Session(ctx), pages, Wire.DecodeAdminSitePagePublish(frame), frame, pow, ctx, ct);
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
                    await store.PublishSitePage(actions.Session(ctx), pages, intent, frame, Proof(ctx), pow, ctx, ct);
                    if (ctx.RequestServices.GetService<Publications>() is { } publications)
                        try { await publications.Refresh(ct); } catch when (!ct.IsCancellationRequested) { }
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
        actions.StepUpPow(WireRoutes.AdminAppearanceStepUpBegin, WireRoutes.AdminAppearanceStepUpComplete,
            WireRoutes.AdminAppearancePow, WireRoutes.AdminAppearanceApply, WireLimits.AdminAppearanceCommandFrameBytes,
            Wire.DecodeAdminAppearanceCommand, PowScope.AdminAppearance,
            (_, session, cmd, ct) => store.BeginAppearanceStepUp(session, registry, cmd, ct),
            store.CompleteAppearanceStepUp,
            (ctx, session, cmd, frame, pow, ct) => store.IssueAppearancePow(session, registry, cmd, frame, pow, ctx, ct),
            (ctx, session, cmd, frame, proof, pow, ct) => store.ApplyAppearance(session, registry, cmd, frame, proof, pow, ctx, ct));
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
