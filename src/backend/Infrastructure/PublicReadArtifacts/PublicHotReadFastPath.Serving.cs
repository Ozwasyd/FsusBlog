using System.Buffers.Binary;
using System.Collections.Frozen;
using System.Diagnostics.Metrics;
using System.IO.Compression;
using System.IO.Pipelines;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Middlewares;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.Extensions.Primitives;

namespace FsusBlog.Server.Infrastructure.PublicReadArtifacts;

// Design reference: docs/api/design.md "pathKey 与 routeKey 映射" and "L0 artifact HTTP 语义".
public static partial class PublicHotReadFastPath
{
    private const string ArticlePrefix = "/api/binary/article";
    private const string CategoryPath = "/api/binary/category.aeds";
    private const string CategoryPathWithoutSuffix = "/api/binary/category";
    private const string TagPath = "/api/binary/tag.aeds";
    private const string TagPathWithoutSuffix = "/api/binary/tag";
    private const string BinaryContentType = "application/octet-stream";
    private const string HtmlMediaType = "text/html";
    private const string HtmlContentType = "text/html; charset=utf-8";
    private const string ServerSsrAotSource = "server-ssr";
    private static readonly Task s_completed = Task.CompletedTask;
    private static readonly ILocaleResolver s_localeResolver = new LocaleResolver();
    private static readonly string[] s_sensitiveApiPrefixes =
    [
        "/api/binary/auth",
        "/api/binary/admin",
        "/api/binary/author",
        "/api/binary/manage",
        "/api/binary/internal",
        "/api/binary/billing",
        "/api/binary/audit",
        "/api/auth",
        "/api/admin",
        "/api/author",
        "/api/manage",
        "/api/internal",
        "/api/billing",
        "/api/audit"
    ];

    public static Task TryServeAsync(
        HttpContext ctx,
        RequestDelegate next,
        PublicHotReadStore store,
        PublicHotReadOptions options,
        PublicHotReadCounters counters,
        bool isDevelopment = false)
    {
        if (!options.Enabled)
        {
            return next(ctx);
        }

        if (!TryCreateRequestFeature(ctx, out PublicHotReadRequestFeature? feature))
        {
            return next(ctx);
        }

        return TryServeClassifiedAsync(ctx, next, store, options, counters, feature!, isDevelopment);
    }

    internal static bool TryCreateRequestFeature(
        HttpContext ctx,
        out PublicHotReadRequestFeature? feature)
        => TryCreateRequestFeatureWithBypass(ctx, out feature, out _, out _);

    internal static bool TryCreateRequestFeatureWithBypass(
        HttpContext ctx,
        out PublicHotReadRequestFeature? feature,
        out bool sensitivePrefixBypass,
        out bool credentialBypass)
    {
        feature = null;
        sensitivePrefixBypass = false;
        credentialBypass = false;
        string? path = ctx.Request.Path.Value;
        if (path is null)
        {
            return false;
        }

        if (IsSensitiveApiPath(path))
        {
            sensitivePrefixBypass = true;
            return false;
        }

        ReadOnlySpan<char> span = path.AsSpan();
        bool allowlistedBinaryCandidate = IsCategoryPath(path)
            || IsTagPath(path)
            || string.Equals(path, ArticlePrefix, StringComparison.Ordinal)
            || path.StartsWith(ArticlePrefix + "/", StringComparison.Ordinal);
        bool rejectedPath = ContainsRejectedPathChar(span);
        bool classified = TryClassifyRoute(span, path, out PublicHotReadRoute route);
        PublicHotReadRoutePolicy routePolicy = classified
            && PublicHotReadRouteSecurityCatalog.TryGet(route.Kind, out PublicHotReadRoutePolicy matchedPolicy)
                ? matchedPolicy
                : PublicHotReadRouteSecurityCatalog.s_rejectedCandidate;
        bool isPublicHtmlRoute = route.Kind == PublicHotReadRouteKind.PublicHtml;

        if (IsDynamicRelatedReadingPath(span)
            || IsDynamicArticleSearchPath(span)
            || (!classified && !allowlistedBinaryCandidate))
        {
            return false;
        }

        if (HasCredentialBearingInput(ctx))
        {
            credentialBypass = true;
            return false;
        }

        if (!HttpMethods.IsGet(ctx.Request.Method)
            && !HttpMethods.IsHead(ctx.Request.Method))
        {
            return false;
        }

        if (ctx.Request.Headers.ContainsKey("Origin"))
        {
            return false;
        }

        bool fallbackToEndpoint = isPublicHtmlRoute && rejectedPath;
        feature = new PublicHotReadRequestFeature(
            route,
            classified,
            rejectedPath,
            fallbackToEndpoint,
            ResolveRiskRouteKey(route, path),
            routePolicy,
            classificationCount: 1);
        RuntimeCacheEvidenceObservation.Current?.RecordCacheEvent(
            "public-hot-read-classification",
            $"{ctx.Request.Method}:{path}",
            "hit");
        return true;
    }

    internal static bool TryCreateRequestFeatureForTests(
        HttpContext ctx,
        out PublicHotReadRequestFeature? feature)
        => TryCreateRequestFeature(ctx, out feature);

    internal static bool TryCreateRequestFeatureForTests(
        HttpContext ctx,
        out PublicHotReadRequestFeature? feature,
        out bool sensitivePrefixBypass)
        => TryCreateRequestFeatureWithBypass(ctx, out feature, out sensitivePrefixBypass, out _);

    internal static bool TryCreateRequestFeatureForTests(
        HttpContext ctx,
        out PublicHotReadRequestFeature? feature,
        out bool sensitivePrefixBypass,
        out bool credentialBypass)
        => TryCreateRequestFeatureWithBypass(ctx, out feature, out sensitivePrefixBypass, out credentialBypass);

    internal static bool IsSensitiveApiPathForTests(string path)
        => IsSensitiveApiPath(path);

    internal static Task TryServeClassifiedAsync(
        HttpContext ctx,
        RequestDelegate next,
        PublicHotReadStore store,
        PublicHotReadOptions options,
        PublicHotReadCounters counters,
        PublicHotReadRequestFeature feature,
        bool isDevelopment = false)
    {
        string path = ctx.Request.Path.Value!;
        PublicHotReadRoute route = feature.Route;
        bool classified = feature.Classified;
        bool isPublicHtmlRoute = route.Kind == PublicHotReadRouteKind.PublicHtml;

        if (feature.FallbackToEndpoint)
        {
            return next(ctx);
        }

        if (feature.RejectedPath)
        {
            counters.Rejected();
            return WriteStatus(ctx, StatusCodes.Status404NotFound, isDevelopment);
        }

        if (!HttpMethods.IsGet(ctx.Request.Method) && !HttpMethods.IsHead(ctx.Request.Method))
        {
            if (isPublicHtmlRoute)
            {
                return next(ctx);
            }

            if (IsTaxonomyCollectionPath(path))
            {
                return next(ctx);
            }

            return WriteStatus(ctx, StatusCodes.Status405MethodNotAllowed, isDevelopment);
        }

        // Public HTML artifacts are indexed by canonical route key, so the
        // classifier intentionally recognizes a trailing-slash request. Do
        // not let that shortcut bypass the application-wide canonical 301.
        if (isPublicHtmlRoute
            && PublicWebRuntime.TryBuildTrailingSlashRedirect(
                ctx.Request,
                out string redirectLocation))
        {
            ctx.Response.StatusCode = StatusCodes.Status301MovedPermanently;
            ctx.Response.Headers.Location = redirectLocation;
            ctx.Response.ContentLength = 0;
            return s_completed;
        }

        if (ctx.Request.Headers.ContainsKey("Range"))
        {
            ctx.Response.Headers.ContentRange = "bytes */0";
            return WriteStatus(ctx, StatusCodes.Status416RangeNotSatisfiable, isDevelopment);
        }

        if (ctx.Request.ContentLength.GetValueOrDefault() > 0 || ctx.Request.QueryString.HasValue)
        {
            if (isPublicHtmlRoute)
            {
                return next(ctx);
            }

            if (route.Kind == PublicHotReadRouteKind.ArticleList
                && ctx.Request.ContentLength.GetValueOrDefault() == 0
                && ctx.Request.Query.Count > 0
                && ctx.Request.Query.Keys.All(static key => key is "cursor" or "keyword" or "sort"))
            {
                return next(ctx);
            }

            WriteLegacyRouteHint(ctx, path);
            return WriteStatus(ctx, StatusCodes.Status400BadRequest, isDevelopment);
        }

        if (!AcceptsArtifact(ctx, feature.IsHtml))
        {
            return WriteStatus(ctx, StatusCodes.Status406NotAcceptable, isDevelopment);
        }

        bool rebuildAlreadyPending = store.CoalescedRefreshPending;
        if (store.TryGetRequestSnapshot(out PublicHotReadSnapshot snapshot, out string snapshotState))
        {
            bool lastGood = string.Equals(snapshotState, "last-good", StringComparison.Ordinal)
                || string.Equals(snapshotState, "sticky", StringComparison.Ordinal);
            if (classified)
            {
                bool lastGoodWhileRebuild = string.Equals(snapshotState, "last-good", StringComparison.Ordinal)
                    && rebuildAlreadyPending;
                return route.Kind switch
                {
                    PublicHotReadRouteKind.Category => ServeCategory(ctx, next, snapshot, counters, options, isDevelopment, lastGood, lastGoodWhileRebuild),
                    PublicHotReadRouteKind.Tag => ServeTag(ctx, next, snapshot, counters, options, isDevelopment, lastGood, lastGoodWhileRebuild),
                    PublicHotReadRouteKind.ArticleDetail => ServeArticle(ctx, next, snapshot, counters, route.ArticleId, options, isDevelopment, lastGood, lastGoodWhileRebuild),
                    PublicHotReadRouteKind.ArticleList => ServeList(ctx, next, snapshot, counters, route.ListKey, options, isDevelopment, lastGood, lastGoodWhileRebuild),
                    PublicHotReadRouteKind.ArticleHot => ServeList(ctx, next, snapshot, counters, route.ListKey, options, isDevelopment, lastGood, lastGoodWhileRebuild),
                    PublicHotReadRouteKind.ArticleFeatured => ServeList(ctx, next, snapshot, counters, route.ListKey, options, isDevelopment, lastGood, lastGoodWhileRebuild),
                    PublicHotReadRouteKind.ArticleHtml => ServeHtml(ctx, next, snapshot, counters, route.HtmlRouteKey, options, isDevelopment, lastGood, lastGoodWhileRebuild),
                    PublicHotReadRouteKind.PublicHtml => ServePublicHtml(ctx, next, snapshot, counters, route.HtmlRouteKey, options, isDevelopment, lastGood, lastGoodWhileRebuild),
                    _ => WriteRejected(ctx, counters, isDevelopment)
                };
            }

            return WriteRejected(ctx, counters, isDevelopment);
        }

        if (!store.IsReadyFast && !options.FailOpenWhenNotReady)
        {
            if (isPublicHtmlRoute)
            {
                return next(ctx);
            }

            ctx.Response.Headers["Retry-After"] = "1";
            return WriteStatus(ctx, StatusCodes.Status503ServiceUnavailable, isDevelopment);
        }

        if (!string.Equals(snapshotState, "not-ready", StringComparison.Ordinal))
        {
            counters.SanityFallback();
        }

        return next(ctx);
    }

    private static string ResolveRiskRouteKey(in PublicHotReadRoute route, string path)
        => route.Kind switch
        {
            PublicHotReadRouteKind.Category => "taxonomy.category",
            PublicHotReadRouteKind.Tag => "taxonomy.tag",
            PublicHotReadRouteKind.ArticleDetail => "article.detail",
            PublicHotReadRouteKind.PublicHtml when path.Length == 1 => "public.html.home",
            PublicHotReadRouteKind.PublicHtml => "public.html.fallback",
            PublicHotReadRouteKind.ArticleHtml => "public.hot-read.html",
            _ => "public.hot-read.binary"
        };

    private static bool IsCategoryPath(string path)
        => string.Equals(path, CategoryPath, StringComparison.Ordinal)
            || string.Equals(path, CategoryPathWithoutSuffix, StringComparison.Ordinal);

    private static bool IsTagPath(string path)
        => string.Equals(path, TagPath, StringComparison.Ordinal)
            || string.Equals(path, TagPathWithoutSuffix, StringComparison.Ordinal);

    private static bool IsArticleHtmlPath(ReadOnlySpan<char> path)
        => path.StartsWith("/api/binary/article/html/", StringComparison.Ordinal);

    private static bool IsDynamicRelatedReadingPath(ReadOnlySpan<char> path)
    {
        const string Prefix = "/api/binary/article/";
        ReadOnlySpan<char> suffix = "/related.aeds".AsSpan();
        if (!path.StartsWith(Prefix, StringComparison.Ordinal)
            || !path.EndsWith(suffix, StringComparison.Ordinal))
        {
            return false;
        }

        ReadOnlySpan<char> articleId = path[Prefix.Length..^suffix.Length];
        return TryParsePositiveInt(articleId, out _);
    }

    // Search is a live index query (required ?q=), not a HotRead artifact. Capture
    // would reject the query string with HTTP 400 and never reach BinaryEndpoints.
    private static bool IsDynamicArticleSearchPath(ReadOnlySpan<char> path)
        => path.Equals("/api/binary/article/search/query.aeds".AsSpan(), StringComparison.Ordinal);

    private static bool IsPublicHtmlCandidatePath(ReadOnlySpan<char> path)
    {
        path = TrimPublicHtmlPath(path);
        return path.Equals("/".AsSpan(), StringComparison.Ordinal)
            || PublicAotPageCatalog.TryGetByStaticPath(path, out _)
            || path.StartsWith(PublicRouteIdentityRegistry.ArticlePathPrefix.AsSpan(), StringComparison.Ordinal)
            || path.StartsWith(PublicRouteIdentityRegistry.CategoryPathPrefix.AsSpan(), StringComparison.Ordinal)
            || path.StartsWith(PublicRouteIdentityRegistry.TagPathPrefix.AsSpan(), StringComparison.Ordinal);
    }

    private static bool AcceptsArtifact(HttpContext ctx, bool html)
    {
        StringValues accept = ctx.Request.Headers.Accept;
        if (TryAcceptArtifactCommon(accept, html, out bool accepted))
        {
            return accepted;
        }

        return HttpAcceptNegotiation.Accepts(accept, html ? HtmlMediaType : BinaryContentType);
    }

    internal static bool AcceptsArtifactForTests(StringValues accept, bool html)
        => TryAcceptArtifactCommon(accept, html, out bool accepted)
            ? accepted
            : HttpAcceptNegotiation.Accepts(accept, html ? HtmlMediaType : BinaryContentType);

    private static bool TryAcceptArtifactCommon(StringValues values, bool html, out bool accepted)
    {
        accepted = false;
        if (values.Count == 0)
        {
            accepted = true;
            return true;
        }

        if (values.Count != 1)
        {
            return false;
        }

        ReadOnlySpan<char> header = (values[0] ?? string.Empty).AsSpan().Trim();
        if (header.IsEmpty || header.Equals("*/*", StringComparison.OrdinalIgnoreCase))
        {
            accepted = true;
            return true;
        }

        ReadOnlySpan<char> mediaType = html ? HtmlMediaType.AsSpan() : BinaryContentType.AsSpan();
        if (header.Equals(mediaType, StringComparison.OrdinalIgnoreCase)
            || EqualsCommaPair(header, mediaType, "*/*".AsSpan()))
        {
            accepted = true;
            return true;
        }

        return false;
    }

    private static bool EqualsCommaPair(ReadOnlySpan<char> value, ReadOnlySpan<char> first, ReadOnlySpan<char> second)
    {
        int comma = value.IndexOf(',');
        return comma > 0
            && value[..comma].Trim().Equals(first, StringComparison.OrdinalIgnoreCase)
            && value[(comma + 1)..].Trim().Equals(second, StringComparison.OrdinalIgnoreCase);
    }

    private static Task WriteRejected(HttpContext ctx, PublicHotReadCounters counters, bool isDevelopment)
    {
        counters.Rejected();
        return WriteStatus(ctx, StatusCodes.Status404NotFound, isDevelopment);
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static bool ContainsRejectedPathChar(ReadOnlySpan<char> path)
        => path.IndexOf('%') >= 0
            || path.IndexOf('\\') >= 0
            || path.IndexOf("..", StringComparison.Ordinal) >= 0
            || path.IndexOf("//", StringComparison.Ordinal) >= 0;

    private static Task ServeArticle(
        HttpContext ctx,
        RequestDelegate next,
        PublicHotReadSnapshot snapshot,
        PublicHotReadCounters counters,
        int articleId,
        PublicHotReadOptions options,
        bool isDevelopment,
        bool lastGood,
        bool lastGoodWhileRebuild)
    {
        if (!snapshot.TryGetArticle(articleId, out PublicBinaryArtifact artifact))
        {
            counters.ArticleMiss();
            return next(ctx);
        }

        string artifactKey = options.EnableDiagnosticHeaders
            ? articleId.ToString(System.Globalization.CultureInfo.InvariantCulture)
            : string.Empty;
        return WriteBinaryFrame(
            ctx,
            next,
            artifact,
            PublicArtifactIntegrityContext.ForArticle(articleId),
            counters,
            options,
            "article",
            artifactKey,
            isDevelopment,
            lastGood,
            lastGoodWhileRebuild);
    }

    private static Task ServeList(
        HttpContext ctx,
        RequestDelegate next,
        PublicHotReadSnapshot snapshot,
        PublicHotReadCounters counters,
        in PublicListKey key,
        PublicHotReadOptions options,
        bool isDevelopment,
        bool lastGood,
        bool lastGoodWhileRebuild)
    {
        bool isCursorArticleList = key.Kind is PublicListKind.Home
            or PublicListKind.Archive
            or PublicListKind.Category
            or PublicListKind.Tag;
        if (isCursorArticleList
            && (key.Page > 1 || ctx.Request.Query.ContainsKey("cursor")))
        {
            return next(ctx);
        }

        if (!snapshot.TryGetList(key, out PublicBinaryArtifact artifact))
        {
            counters.ListMiss();
            return WriteServingMiss(ctx, snapshot.ClassifyListMiss(key), isDevelopment);
        }

        string artifactKey = options.EnableDiagnosticHeaders ? key.ToString() : string.Empty;
        return WriteBinaryFrame(
            ctx,
            next,
            artifact,
            PublicArtifactIntegrityContext.ForList(key),
            counters,
            options,
            PublicListArtifactKind(key.Kind),
            artifactKey,
            isDevelopment,
            lastGood,
            lastGoodWhileRebuild);
    }

    private static Task ServeCategory(
        HttpContext ctx,
        RequestDelegate next,
        PublicHotReadSnapshot snapshot,
        PublicHotReadCounters counters,
        PublicHotReadOptions options,
        bool isDevelopment,
        bool lastGood,
        bool lastGoodWhileRebuild)
    {
        if (!snapshot.TryGetCategory(out PublicBinaryArtifact artifact))
        {
            counters.ListMiss();
            // Taxonomy collections are always-built critical artifacts. A Ready
            // snapshot miss is not-resident/rebuild, never authoritative 404.
            return WriteServingMiss(ctx, PublicHotReadServingMiss.NotResident, isDevelopment);
        }

        return WriteBinaryFrame(
            ctx,
            next,
            artifact,
            PublicArtifactIntegrityContext.ForCategory(),
            counters,
            options,
            "category",
            "all",
            isDevelopment,
            lastGood,
            lastGoodWhileRebuild);
    }

    private static Task ServeTag(
        HttpContext ctx,
        RequestDelegate next,
        PublicHotReadSnapshot snapshot,
        PublicHotReadCounters counters,
        PublicHotReadOptions options,
        bool isDevelopment,
        bool lastGood,
        bool lastGoodWhileRebuild)
    {
        if (!snapshot.TryGetTag(out PublicBinaryArtifact artifact))
        {
            counters.ListMiss();
            return WriteServingMiss(ctx, PublicHotReadServingMiss.NotResident, isDevelopment);
        }

        return WriteBinaryFrame(
            ctx,
            next,
            artifact,
            PublicArtifactIntegrityContext.ForTag(),
            counters,
            options,
            "tag",
            "all",
            isDevelopment,
            lastGood,
            lastGoodWhileRebuild);
    }

    private static Task ServeHtml(
        HttpContext ctx,
        RequestDelegate next,
        PublicHotReadSnapshot snapshot,
        PublicHotReadCounters counters,
        string routeKey,
        PublicHotReadOptions options,
        bool isDevelopment,
        bool lastGood,
        bool lastGoodWhileRebuild)
    {
        if (!snapshot.TryGetHtml(routeKey, out PublicHtmlArtifact html))
        {
            counters.HtmlMiss();
            // Diagnostic HTML is another Serving miss→404 site: htmlRemovedPaths
            // and a complete fresh snapshot miss are 404; last-good without the
            // route is rebuild-pending 503, not authoritative not-found.
            return WriteServingMiss(ctx, snapshot.ClassifyHtmlMiss(routeKey, lastGood), isDevelopment);
        }

        if (!PublicHotReadArtifactIntegrity.IsValid(
                html,
                PublicArtifactIntegrityContext.ForHtml(routeKey)))
        {
            counters.SanityFallback();
            counters.Rejected();
            return next(ctx);
        }

        RecordSnapshotServeHit(counters, lastGood, lastGoodWhileRebuild);
        counters.HtmlHit(html.Bytes.Length);
        if (html.RequiresCspNonceMutation)
        {
            return ServeHtmlWithNonce(ctx, html, options, snapshot.Version, routeKey, isDevelopment);
        }

        HttpResponse response = ctx.Response;
        response.StatusCode = StatusCodes.Status200OK;
        response.ContentType = string.IsNullOrWhiteSpace(html.ContentType) ? HtmlContentType : html.ContentType;
        response.ContentLength = html.Bytes.Length;
        ApplyStaticPublicSecurityHeaders(response, isDevelopment);
        response.Headers["Cache-Control"] = string.IsNullOrWhiteSpace(html.CacheControl) ? "public,max-age=60" : html.CacheControl;
        response.Headers["Accept-Ranges"] = "none";
        SetPublicAotIdentityHeaders(response, html);
        if (!string.IsNullOrWhiteSpace(html.ETag))
        {
            response.Headers["ETag"] = html.ETag;
        }
        WriteDiagnosticHeaders(response, options, snapshot.Version, "html", routeKey);
        if (HttpEntityTagPreconditions.MatchesIfNoneMatch(ctx.Request.Headers.IfNoneMatch, html.ETag))
        {
            response.StatusCode = StatusCodes.Status304NotModified;
            response.ContentLength = 0;
            return s_completed;
        }

        if (HttpMethods.IsHead(ctx.Request.Method))
        {
            return s_completed;
        }

        ValueTask<FlushResult> write = response.BodyWriter.WriteAsync(html.Bytes, ctx.RequestAborted);
        return write.IsCompletedSuccessfully ? s_completed : AwaitWrite(write);
    }

    private static Task ServeHtmlWithNonce(
        HttpContext ctx,
        PublicHtmlArtifact html,
        PublicHotReadOptions options,
        long snapshotVersion,
        string routeKey,
        bool isDevelopment)
    {
        CspNonceUtf8Template template = html.CspNonceTemplate
            ?? throw new InvalidOperationException("nonce HTML artifact is missing its compiled template");
        HttpResponse response = ctx.Response;
        string nonce = PublicWebRuntime.EnsureCspNonce(ctx);
        response.ContentType = string.IsNullOrWhiteSpace(html.ContentType) ? HtmlContentType : html.ContentType;
        ApplyStaticPublicSecurityHeaders(response, isDevelopment, nonce);
        response.Headers["Cache-Control"] = "private,no-store";
        response.Headers["Accept-Ranges"] = "none";
        SetPublicAotIdentityHeaders(response, html);
        response.Headers.Remove("Content-Encoding");
        response.Headers.Remove("ETag");
        WriteDiagnosticHeaders(response, options, snapshotVersion, "html", routeKey);
        if (!PublicAotHtmlResponseNegotiation.AcceptsIdentity(ctx.Request.Headers.AcceptEncoding))
        {
            response.StatusCode = StatusCodes.Status406NotAcceptable;
            response.ContentLength = 0;
            return s_completed;
        }

        response.StatusCode = StatusCodes.Status200OK;
        response.ContentLength = template.GetRenderedLength(nonce.Length);

        if (HttpMethods.IsHead(ctx.Request.Method) || response.ContentLength == 0)
        {
            return s_completed;
        }

        return CspNonceHtmlResponseWriter.WriteBodyAsync(response, template, nonce, ctx.RequestAborted);
    }

    private static void ApplyStaticPublicSecurityHeaders(HttpResponse response, bool isDevelopment, string? nonce = null)
    {
        response.Headers["X-Content-Type-Options"] = "nosniff";
        response.Headers["Referrer-Policy"] = "strict-origin-when-cross-origin";
        response.Headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=(), browsing-topics=()";
        response.Headers["X-Frame-Options"] = "DENY";
        response.Headers["Cross-Origin-Embedder-Policy"] = "credentialless";
        response.Headers["Cross-Origin-Opener-Policy"] = "same-origin";
        response.Headers["Cross-Origin-Resource-Policy"] = "same-origin";
        response.Headers["Content-Security-Policy"] = string.IsNullOrWhiteSpace(nonce)
            ? PublicWebRuntime.BuildStaticCsp(isDevelopment)
            : PublicWebRuntime.BuildHtmlCsp(isDevelopment, nonce);
    }

    private static Task ServePublicHtml(
        HttpContext ctx,
        RequestDelegate next,
        PublicHotReadSnapshot snapshot,
        PublicHotReadCounters counters,
        string routeKey,
        PublicHotReadOptions options,
        bool isDevelopment,
        bool lastGood,
        bool lastGoodWhileRebuild)
    {
        LocaleResolutionResult resolution = PublicLocaleRequest.Resolve(ctx, s_localeResolver);
        string localizedRouteKey = PublicHotReadRouteKeys.LocalizeHtmlPath(
            routeKey,
            resolution.Locale.Code);
        if (string.IsNullOrEmpty(localizedRouteKey)
            || !snapshot.TryGetHtml(localizedRouteKey, out PublicHtmlArtifact html)
            || !string.Equals(html.Locale, resolution.Locale.Code, StringComparison.Ordinal))
        {
            counters.HtmlMiss();
            return next(ctx);
        }

        return ServeHtml(ctx, next, snapshot, counters, localizedRouteKey, options, isDevelopment, lastGood, lastGoodWhileRebuild);
    }

    internal static Task WriteBinaryFrame(
        HttpContext ctx,
        RequestDelegate next,
        PublicBinaryArtifact artifact,
        in PublicArtifactIntegrityContext integrityContext,
        PublicHotReadCounters counters,
        PublicHotReadOptions options,
        string artifactKind,
        string artifactKey,
        bool isDevelopment,
        bool lastGood,
        bool lastGoodWhileRebuild)
    {
        if (!TrySelectBinaryVariant(ctx.Request, artifact, out PublicBinaryArtifactVariant variant))
        {
            return WriteStatus(ctx, StatusCodes.Status406NotAcceptable, isDevelopment);
        }
        if (!PublicHotReadArtifactIntegrity.IsValid(variant, artifact, integrityContext))
        {
            counters.SanityFallback();
            counters.Rejected();
            return next(ctx);
        }
        RecordSnapshotServeHit(counters, lastGood, lastGoodWhileRebuild);
        if (string.Equals(artifactKind, "article", StringComparison.Ordinal))
        {
            counters.ArticleHit(artifact.Frame.Length);
        }
        else
        {
            counters.ListHit(artifact.Frame.Length);
        }
        counters.VariantSelected(variant.ContentEncoding);

        ReadOnlyMemory<byte> frame = variant.Frame;
        HttpResponse response = ctx.Response;
        response.StatusCode = StatusCodes.Status200OK;
        response.ContentType = BinaryContentType;
        response.ContentLength = frame.Length;
        response.Headers["X-Fsus-Frame-Version"] = AedsFrameHeader.CurrentVersion.ToString(System.Globalization.CultureInfo.InvariantCulture);
        response.Headers["X-Content-Type-Options"] = "nosniff";
        response.Headers["Vary"] = "Accept-Encoding";
        response.Headers["Cache-Control"] = string.IsNullOrWhiteSpace(artifact.CacheControl)
            ? (string.IsNullOrWhiteSpace(options.CacheControl) ? "public,max-age=60" : options.CacheControl)
            : artifact.CacheControl;
        response.Headers["Accept-Ranges"] = "none";
        if (!string.IsNullOrWhiteSpace(variant.ETag))
        {
            response.Headers["ETag"] = variant.ETag;
        }
        else
        {
            response.Headers.Remove("ETag");
        }
        response.Headers.Remove("Last-Modified");
        if (string.IsNullOrWhiteSpace(variant.ContentEncoding))
        {
            response.Headers.Remove("Content-Encoding");
        }
        else
        {
            response.Headers["Content-Encoding"] = variant.ContentEncoding;
        }

        response.Headers["X-Fsus-Frame-Encoding"] = string.IsNullOrWhiteSpace(variant.ContentEncoding)
            ? "identity"
            : variant.ContentEncoding;
        WriteDiagnosticHeaders(response, options, artifact.Version, artifactKind, artifactKey);
        if (HttpEntityTagPreconditions.MatchesIfNoneMatch(ctx.Request.Headers.IfNoneMatch, variant.ETag))
        {
            response.StatusCode = StatusCodes.Status304NotModified;
            response.ContentLength = 0;
            return s_completed;
        }

        if (HttpMethods.IsHead(ctx.Request.Method))
        {
            return s_completed;
        }

        ValueTask<FlushResult> write = response.BodyWriter.WriteAsync(frame, ctx.RequestAborted);
        return write.IsCompletedSuccessfully ? s_completed : AwaitWrite(write);
    }

    private static void RecordSnapshotServeHit(
        PublicHotReadCounters counters,
        bool lastGood,
        bool lastGoodWhileRebuild)
    {
        if (lastGood)
        {
            counters.LastGoodHit();
            if (lastGoodWhileRebuild)
            {
                counters.LastGoodWhileRebuild();
            }
        }
        else
        {
            RuntimeCacheEvidenceObservation.Current?.MarkLayerSource("l0-allow");
            counters.FreshL0Hit();
        }
    }

    private static bool TrySelectBinaryVariant(
        HttpRequest request,
        PublicBinaryArtifact artifact,
        out PublicBinaryArtifactVariant variant)
        => TrySelectBinaryVariant(request.Headers.AcceptEncoding, artifact, out variant);

    internal static bool TrySelectBinaryVariantForTests(
        StringValues acceptEncoding,
        PublicBinaryArtifact artifact,
        out PublicBinaryArtifactVariant variant)
        => TrySelectBinaryVariant(acceptEncoding, artifact, out variant);

    private static bool TrySelectBinaryVariant(
        StringValues acceptEncoding,
        PublicBinaryArtifact artifact,
        out PublicBinaryArtifactVariant variant)
    {
        if (TrySelectCommonBinaryVariant(acceptEncoding, artifact, out variant))
        {
            return true;
        }

        BinaryEncodingQuality quality = ParseAcceptEncoding(acceptEncoding);
        double identity = quality.Identity;
        double gzip = quality.Gzip;
        double br = quality.Brotli;

        variant = default;
        double best = -1;
        if (identity > 0 && !artifact.Frame.IsEmpty)
        {
            variant = new PublicBinaryArtifactVariant(artifact.Frame, artifact.ETag, string.Empty, artifact.FrameIntegrityTag);
            best = identity;
        }

        if (gzip > best && gzip > 0 && !artifact.GzipFrame.IsEmpty)
        {
            variant = new PublicBinaryArtifactVariant(artifact.GzipFrame, artifact.GzipETag, "gzip", artifact.GzipIntegrityTag);
            best = gzip;
        }

        if (br >= best && br > 0 && !artifact.BrotliFrame.IsEmpty)
        {
            variant = new PublicBinaryArtifactVariant(artifact.BrotliFrame, artifact.BrotliETag, "br", artifact.BrotliIntegrityTag);
            best = br;
        }

        return best > 0 && !variant.Frame.IsEmpty;
    }

    private static bool TrySelectCommonBinaryVariant(
        StringValues values,
        PublicBinaryArtifact artifact,
        out PublicBinaryArtifactVariant variant)
    {
        variant = default;
        if (values.Count == 0)
        {
            return TrySelectIdentity(artifact, out variant);
        }

        if (values.Count != 1)
        {
            return false;
        }

        ReadOnlySpan<char> header = (values[0] ?? string.Empty).AsSpan().Trim();
        if (header.IsEmpty)
        {
            return TrySelectIdentity(artifact, out variant);
        }

        if (header.IndexOf(';') >= 0)
        {
            return false;
        }

        if (header.Equals("br", StringComparison.OrdinalIgnoreCase))
        {
            return TrySelectBrotliGzipIdentity(artifact, out variant);
        }

        if (header.Equals("gzip", StringComparison.OrdinalIgnoreCase))
        {
            return TrySelectGzipIdentity(artifact, out variant);
        }

        if (EqualsCommaPair(header, "gzip".AsSpan(), "br".AsSpan())
            || EqualsCommaPair(header, "br".AsSpan(), "gzip".AsSpan())
            || EqualsCommaTriple(header, "gzip".AsSpan(), "deflate".AsSpan(), "br".AsSpan()))
        {
            return TrySelectBrotliGzipIdentity(artifact, out variant);
        }

        return false;
    }

    private static bool TrySelectBrotliGzipIdentity(PublicBinaryArtifact artifact, out PublicBinaryArtifactVariant variant)
    {
        if (!artifact.BrotliFrame.IsEmpty)
        {
            variant = new PublicBinaryArtifactVariant(artifact.BrotliFrame, artifact.BrotliETag, "br", artifact.BrotliIntegrityTag);
            return true;
        }

        return TrySelectGzipIdentity(artifact, out variant);
    }

    private static bool TrySelectGzipIdentity(PublicBinaryArtifact artifact, out PublicBinaryArtifactVariant variant)
    {
        if (!artifact.GzipFrame.IsEmpty)
        {
            variant = new PublicBinaryArtifactVariant(artifact.GzipFrame, artifact.GzipETag, "gzip", artifact.GzipIntegrityTag);
            return true;
        }

        return TrySelectIdentity(artifact, out variant);
    }

    private static bool TrySelectIdentity(PublicBinaryArtifact artifact, out PublicBinaryArtifactVariant variant)
    {
        variant = default;
        if (artifact.Frame.IsEmpty)
        {
            return false;
        }

        variant = new PublicBinaryArtifactVariant(artifact.Frame, artifact.ETag, string.Empty, artifact.FrameIntegrityTag);
        return true;
    }

    private static bool EqualsCommaTriple(
        ReadOnlySpan<char> value,
        ReadOnlySpan<char> first,
        ReadOnlySpan<char> second,
        ReadOnlySpan<char> third)
    {
        int firstComma = value.IndexOf(',');
        if (firstComma <= 0 || !value[..firstComma].Trim().Equals(first, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        ReadOnlySpan<char> rest = value[(firstComma + 1)..];
        int secondComma = rest.IndexOf(',');
        return secondComma > 0
            && rest[..secondComma].Trim().Equals(second, StringComparison.OrdinalIgnoreCase)
            && rest[(secondComma + 1)..].Trim().Equals(third, StringComparison.OrdinalIgnoreCase);
    }

    private readonly record struct BinaryEncodingQuality(double Identity, double Gzip, double Brotli);

    private static BinaryEncodingQuality ParseAcceptEncoding(StringValues values)
    {
        if (values.Count == 0)
        {
            return new BinaryEncodingQuality(1, 0, 0);
        }

        bool saw = false;
        double identity = -1;
        double gzip = -1;
        double br = -1;
        double wildcard = -1;
        for (int i = 0; i < values.Count; i++)
        {
            ReadOnlySpan<char> header = (values[i] ?? string.Empty).AsSpan();
            while (true)
            {
                int comma = header.IndexOf(',');
                ReadOnlySpan<char> segment = comma >= 0 ? header[..comma] : header;
                ReadEncodingSegment(segment, ref saw, ref identity, ref gzip, ref br, ref wildcard);
                if (comma < 0)
                {
                    break;
                }

                header = header[(comma + 1)..];
            }
        }

        if (!saw)
        {
            return new BinaryEncodingQuality(1, 0, 0);
        }

        if (identity < 0)
        {
            identity = wildcard >= 0 ? wildcard : 1;
        }

        if (gzip < 0)
        {
            gzip = wildcard >= 0 ? wildcard : 0;
        }

        if (br < 0)
        {
            br = wildcard >= 0 ? wildcard : 0;
        }

        return new BinaryEncodingQuality(identity, gzip, br);
    }

    private static void ReadEncodingSegment(
        ReadOnlySpan<char> segment,
        ref bool saw,
        ref double identity,
        ref double gzip,
        ref double br,
        ref double wildcard)
    {
        segment = segment.Trim();
        if (segment.IsEmpty)
        {
            return;
        }

        saw = true;
        int semicolon = segment.IndexOf(';');
        ReadOnlySpan<char> name = (semicolon >= 0 ? segment[..semicolon] : segment).Trim();
        double quality = semicolon >= 0 ? ParseQuality(segment[(semicolon + 1)..]) : 1;
        if (name.Equals("identity", StringComparison.OrdinalIgnoreCase))
        {
            identity = quality;
        }
        else if (name.Equals("gzip", StringComparison.OrdinalIgnoreCase))
        {
            gzip = quality;
        }
        else if (name.Equals("br", StringComparison.OrdinalIgnoreCase))
        {
            br = quality;
        }
        else if (name.Equals("*", StringComparison.OrdinalIgnoreCase))
        {
            wildcard = quality;
        }
    }

    private static double ParseQuality(ReadOnlySpan<char> parameters)
    {
        while (!parameters.IsEmpty)
        {
            int semicolon = parameters.IndexOf(';');
            ReadOnlySpan<char> parameter = (semicolon >= 0 ? parameters[..semicolon] : parameters).Trim();
            if (parameter.StartsWith("q=", StringComparison.OrdinalIgnoreCase)
                && double.TryParse(
                    parameter[2..],
                    System.Globalization.NumberStyles.AllowDecimalPoint,
                    System.Globalization.CultureInfo.InvariantCulture,
                    out double quality))
            {
                return Math.Clamp(quality, 0, 1);
            }

            if (semicolon < 0)
            {
                break;
            }

            parameters = parameters[(semicolon + 1)..];
        }

        return 1;
    }

}
