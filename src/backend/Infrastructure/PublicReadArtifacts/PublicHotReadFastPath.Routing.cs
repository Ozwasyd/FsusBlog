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
using FsusBlog.Server.Infrastructure.Middlewares;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Primitives;

namespace FsusBlog.Server.Infrastructure.PublicReadArtifacts;


public static partial class PublicHotReadFastPath
{
    private static bool IsTaxonomyCollectionPath(string path)
        => path.Equals(CategoryPathWithoutSuffix, StringComparison.OrdinalIgnoreCase)
           || path.Equals(TagPathWithoutSuffix, StringComparison.OrdinalIgnoreCase);

    private static Task WriteStatus(HttpContext ctx, int statusCode, bool isDevelopment)
    {
        ctx.Response.StatusCode = statusCode;
        ctx.Response.ContentLength = 0;
        ApplyStaticPublicSecurityHeaders(ctx.Response, isDevelopment);
        ctx.Response.Headers["Cache-Control"] = "no-store";
        ctx.Response.Headers["Pragma"] = "no-cache";
        ctx.Response.Headers["Expires"] = "0";
        ctx.Response.Headers["Accept-Ranges"] = "none";
        return s_completed;
    }

    private static void WriteDiagnosticHeaders(
        HttpResponse response,
        PublicHotReadOptions options,
        long version,
        string artifactKind,
        string artifactKey)
    {
        if (!options.EnableDiagnosticHeaders)
        {
            return;
        }

        response.Headers["X-Fsus-HotRead-Version"] = version.ToString(System.Globalization.CultureInfo.InvariantCulture);
        response.Headers["X-Fsus-HotRead-Artifact"] = artifactKind;
        response.Headers["X-Fsus-HotRead-Key"] = artifactKey;
    }

    private static void SetPublicAotIdentityHeaders(HttpResponse response, PublicHtmlArtifact html)
    {
        response.Headers["X-Fsus-Public-Aot-Source"] = ServerSsrAotSource;
        response.Headers["X-Fsus-Public-Aot-State"] = "fresh";
        response.Headers["X-Fsus-Public-Aot-Backfill"] = "none";
        response.Headers["X-Fsus-Public-Aot-Version"] = html.RendererVersion;
        response.Headers["X-Fsus-Public-Aot-Frontend-Asset-Version"] = html.FrontendAssetVersion;
        response.Headers["Content-Language"] = html.Locale;
        AppendVary(response.Headers, "Accept-Language");
        AppendVary(response.Headers, "Cookie");
    }

    private static void AppendVary(IHeaderDictionary headers, string value)
    {
        string existing = headers.Vary.ToString();
        if (existing.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Any(segment => string.Equals(segment, value, StringComparison.OrdinalIgnoreCase)))
        {
            return;
        }

        headers["Vary"] = string.IsNullOrWhiteSpace(existing)
            ? value
            : string.Concat(existing, ", ", value);
    }

    private static string PublicListArtifactKind(PublicListKind kind)
        => kind switch
        {
            PublicListKind.Home => "list-home",
            PublicListKind.Category => "list-category",
            PublicListKind.Tag => "list-tag",
            PublicListKind.Archive => "list-archive",
            PublicListKind.Hot => "hot",
            PublicListKind.Featured => "featured",
            _ => "list"
        };

    private static bool IsSensitiveApiPath(string path)
    {
        foreach (string prefix in s_sensitiveApiPrefixes)
        {
            if (string.Equals(path, prefix, StringComparison.OrdinalIgnoreCase)
                || (path.Length > prefix.Length
                    && path[prefix.Length] == '/'
                    && path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)))
            {
                return true;
            }
        }

        return false;
    }

    private static bool HasCredentialBearingInput(HttpContext context)
    {
        IHeaderDictionary headers = context.Request.Headers;
        bool hasNonLocaleCookie = headers.ContainsKey("Cookie")
            && (context.Request.Cookies.Count == 0
                || context.Request.Cookies.Keys.Any(static key =>
                    !string.Equals(key, PublicLocaleRequest.CookieName, StringComparison.Ordinal)));
        if (context.User.Identity?.IsAuthenticated == true
            || headers.ContainsKey("Authorization")
            || hasNonLocaleCookie
            || headers.ContainsKey("RequestVerificationToken")
            || headers.ContainsKey("X-CSRF-TOKEN")
            || headers.ContainsKey("X-XSRF-TOKEN"))
        {
            return true;
        }

        foreach (string headerName in headers.Keys)
        {
            if (headerName.StartsWith("X-Fsus-", StringComparison.OrdinalIgnoreCase)
                && !AnonymousGatewayHeaderGuardMiddleware.IsAllowedHeader(headerName))
            {
                return true;
            }
        }

        return false;
    }

    private static void WriteLegacyRouteHint(HttpContext ctx, string path)
    {
        if (string.Equals(path, ArticlePrefix, StringComparison.Ordinal))
        {
            ctx.Response.Headers["X-Fsus-Required-Route"] = "/api/binary/article/list/home/{page}/{size}.aeds";
            return;
        }

        if (string.Equals(path, "/api/binary/article/hot", StringComparison.Ordinal))
        {
            ctx.Response.Headers["X-Fsus-Required-Route"] = "/api/binary/article/hot/{size}.aeds";
            return;
        }

        if (string.Equals(path, "/api/binary/article/featured", StringComparison.Ordinal))
        {
            ctx.Response.Headers["X-Fsus-Required-Route"] = "/api/binary/article/featured/{size}.aeds";
        }
    }

    private static async Task AwaitWrite(ValueTask<FlushResult> write)
        => _ = await write.ConfigureAwait(false);

    internal static bool TryClassifyRouteForTests(string path, out PublicHotReadRoute route)
        => TryClassifyRoute(path.AsSpan(), path, out route);

    private static bool TryClassifyRoute(ReadOnlySpan<char> path, string pathValue, out PublicHotReadRoute route)
    {
        route = default;
        if (TryClassifyPublicHtmlRoute(path, out route))
        {
            return true;
        }

        if (path.Equals(CategoryPath.AsSpan(), StringComparison.Ordinal)
            || path.Equals(CategoryPathWithoutSuffix.AsSpan(), StringComparison.Ordinal))
        {
            route = new PublicHotReadRoute(PublicHotReadRouteKind.Category);
            return true;
        }

        if (path.Equals(TagPath.AsSpan(), StringComparison.Ordinal)
            || path.Equals(TagPathWithoutSuffix.AsSpan(), StringComparison.Ordinal))
        {
            route = new PublicHotReadRoute(PublicHotReadRouteKind.Tag);
            return true;
        }

        const string ArticleRoutePrefix = "/api/binary/article/";
        if (!path.StartsWith(ArticleRoutePrefix, StringComparison.Ordinal))
        {
            return false;
        }

        ReadOnlySpan<char> rest = path[ArticleRoutePrefix.Length..];
        if (rest.StartsWith("list/".AsSpan(), StringComparison.Ordinal))
        {
            return TryClassifyArticleList(rest["list/".Length..], out route);
        }

        if (rest.StartsWith("hot/".AsSpan(), StringComparison.Ordinal))
        {
            return TryClassifySizeList(rest["hot/".Length..], PublicHotReadRouteKind.ArticleHot, PublicListKind.Hot, out route);
        }

        if (rest.StartsWith("featured/".AsSpan(), StringComparison.Ordinal))
        {
            return TryClassifySizeList(rest["featured/".Length..], PublicHotReadRouteKind.ArticleFeatured, PublicListKind.Featured, out route);
        }

        if (rest.StartsWith("html/".AsSpan(), StringComparison.Ordinal))
        {
            return TryClassifyHtml(rest["html/".Length..], pathValue, out route);
        }

        if (!rest.EndsWith(".aeds".AsSpan(), StringComparison.Ordinal)
            || !TryParsePositiveInt(rest[..^5], out int articleId))
        {
            return false;
        }

        route = new PublicHotReadRoute(PublicHotReadRouteKind.ArticleDetail, ArticleId: articleId);
        return true;
    }

    private static bool TryClassifyArticleList(ReadOnlySpan<char> rest, out PublicHotReadRoute route)
    {
        route = default;
        if (rest.StartsWith("home/".AsSpan(), StringComparison.Ordinal))
        {
            return TryClassifyPagedListTail(
                rest["home/".Length..],
                PublicHotReadRouteKind.ArticleList,
                PublicListKind.Home,
                0,
                out route);
        }

        if (rest.StartsWith("archive/".AsSpan(), StringComparison.Ordinal))
        {
            return TryClassifyPagedListTail(
                rest["archive/".Length..],
                PublicHotReadRouteKind.ArticleList,
                PublicListKind.Archive,
                0,
                out route);
        }

        if (rest.StartsWith("category/".AsSpan(), StringComparison.Ordinal))
        {
            return TryClassifyTargetedPagedListTail(
                rest["category/".Length..],
                PublicHotReadRouteKind.ArticleList,
                PublicListKind.Category,
                out route);
        }

        if (rest.StartsWith("tag/".AsSpan(), StringComparison.Ordinal))
        {
            return TryClassifyTargetedPagedListTail(
                rest["tag/".Length..],
                PublicHotReadRouteKind.ArticleList,
                PublicListKind.Tag,
                out route);
        }

        return false;
    }

    private static bool TryClassifySizeList(
        ReadOnlySpan<char> rest,
        PublicHotReadRouteKind routeKind,
        PublicListKind listKind,
        out PublicHotReadRoute route)
    {
        route = default;
        if (!rest.EndsWith(".aeds".AsSpan(), StringComparison.Ordinal)
            || !TryParseByteSize(rest[..^5], out byte size))
        {
            return false;
        }

        route = new PublicHotReadRoute(routeKind, ListKey: new PublicListKey(listKind, 0, 1, size));
        return true;
    }

    private static bool TryClassifyHtml(ReadOnlySpan<char> rest, string pathValue, out PublicHotReadRoute route)
    {
        route = default;
        if (!rest.EndsWith(".html".AsSpan(), StringComparison.Ordinal))
        {
            return false;
        }

        ReadOnlySpan<char> keySpan = rest[..^5];
        if (keySpan.IsEmpty
            || keySpan.IndexOf('/') >= 0
            || !PublicHotReadRouteKeys.IsSafePathKey(keySpan))
        {
            return false;
        }

        route = new PublicHotReadRoute(PublicHotReadRouteKind.ArticleHtml, HtmlRouteKey: pathValue);
        return true;
    }

    private static bool TryClassifyPublicHtmlRoute(ReadOnlySpan<char> path, out PublicHotReadRoute route)
    {
        route = default;
        bool hasNonCanonicalTagTrailingSlash = path.Length > PublicRouteIdentityRegistry.TagPathPrefix.Length
            && path.StartsWith(PublicRouteIdentityRegistry.TagPathPrefix.AsSpan(), StringComparison.OrdinalIgnoreCase)
            && path[^1] == '/';
        path = TrimPublicHtmlPath(path);

        if (PublicAotPageCatalog.TryGetByStaticPath(path, out PublicAotPageDescriptor descriptor)
            && !string.IsNullOrWhiteSpace(descriptor.FixedRouteKey))
        {
            route = new PublicHotReadRoute(
                PublicHotReadRouteKind.PublicHtml,
                HtmlRouteKey: PublicHotReadRouteKeys.HtmlPath(descriptor.FixedRouteKey));
            return true;
        }

        if (path.StartsWith(PublicRouteIdentityRegistry.ArticlePathPrefix.AsSpan(), StringComparison.Ordinal)
            && TryParseSinglePositiveIntPathTail(path[PublicRouteIdentityRegistry.ArticlePathPrefix.Length..], out int articleId))
        {
            route = new PublicHotReadRoute(
                PublicHotReadRouteKind.PublicHtml,
                ArticleId: articleId,
                HtmlRouteKey: PublicHotReadRouteKeys.HtmlPath(PublicRouteIdentity.BuildArticleRouteKey(articleId)));
            return true;
        }

        if (path.StartsWith(PublicRouteIdentityRegistry.CategoryPathPrefix.AsSpan(), StringComparison.Ordinal)
            && TryParseSinglePositiveIntPathTail(path[PublicRouteIdentityRegistry.CategoryPathPrefix.Length..], out int categoryId))
        {
            route = new PublicHotReadRoute(
                PublicHotReadRouteKind.PublicHtml,
                HtmlRouteKey: PublicHotReadRouteKeys.HtmlPath(PublicRouteIdentity.BuildCategoryRouteKey(categoryId)));
            return true;
        }

        if (!path.StartsWith(PublicRouteIdentityRegistry.TagPathPrefix.AsSpan(), StringComparison.Ordinal))
        {
            return false;
        }

        if (hasNonCanonicalTagTrailingSlash)
        {
            return false;
        }

        ReadOnlySpan<char> tagTail = path[PublicRouteIdentityRegistry.TagPathPrefix.Length..];
        if (TryParseSinglePositiveIntPathTail(tagTail, out int tagId))
        {
            route = new PublicHotReadRoute(
                PublicHotReadRouteKind.PublicHtml,
                HtmlRouteKey: PublicHotReadRouteKeys.HtmlPath(PublicRouteIdentity.BuildTagIdRouteKey(tagId)));
            return true;
        }

        // A non-numeric tag tail is a legacy name alias. It must reach the AOT
        // shell resolver so the request receives the single-hop 301 to /tag/{id};
        // serving a previously published name artifact here would incorrectly
        // turn the alias back into a second canonical 200 URL.
        return false;
    }

    private static ReadOnlySpan<char> TrimPublicHtmlPath(ReadOnlySpan<char> path)
    {
        while (path.Length > 1 && path[^1] == '/')
        {
            path = path[..^1];
        }

        return path;
    }

    private static bool TryParseSinglePositiveIntPathTail(ReadOnlySpan<char> tail, out int id)
    {
        id = 0;
        return tail.IndexOf('/') < 0 && TryParsePositiveInt(tail, out id);
    }

    private static bool TryClassifyPagedListTail(
        ReadOnlySpan<char> rest,
        PublicHotReadRouteKind routeKind,
        PublicListKind listKind,
        int targetId,
        out PublicHotReadRoute route)
    {
        route = default;
        if (!rest.EndsWith(".aeds".AsSpan(), StringComparison.Ordinal))
        {
            return false;
        }

        rest = rest[..^5];
        int slash = rest.IndexOf('/');
        if (slash <= 0 || slash == rest.Length - 1)
        {
            return false;
        }

        if (!TryParseUShort(rest[..slash], out ushort page)
            || !TryParseByteSize(rest[(slash + 1)..], out byte size))
        {
            return false;
        }

        route = new PublicHotReadRoute(routeKind, ListKey: new PublicListKey(listKind, targetId, page, size));
        return true;
    }

    private static bool TryClassifyTargetedPagedListTail(
        ReadOnlySpan<char> rest,
        PublicHotReadRouteKind routeKind,
        PublicListKind listKind,
        out PublicHotReadRoute route)
    {
        route = default;
        if (!rest.EndsWith(".aeds".AsSpan(), StringComparison.Ordinal))
        {
            return false;
        }

        rest = rest[..^5];
        int first = rest.IndexOf('/');
        if (first <= 0 || first == rest.Length - 1)
        {
            return false;
        }

        int secondRelative = rest[(first + 1)..].IndexOf('/');
        if (secondRelative <= 0)
        {
            return false;
        }

        int second = first + 1 + secondRelative;
        if (!TryParsePositiveInt(rest[..first], out int targetId)
            || !TryParseUShort(rest[(first + 1)..second], out ushort page)
            || !TryParseByteSize(rest[(second + 1)..], out byte size))
        {
            return false;
        }

        route = new PublicHotReadRoute(routeKind, ListKey: new PublicListKey(listKind, targetId, page, size));
        return true;
    }

    internal static bool TryMatchArticleDetail(ReadOnlySpan<char> path, out int articleId)
    {
        articleId = 0;
        if (!TryClassifyRoute(path, string.Empty, out PublicHotReadRoute route)
            || route.Kind != PublicHotReadRouteKind.ArticleDetail)
        {
            return false;
        }

        articleId = route.ArticleId;
        return true;
    }

    internal static bool TryMatchArticleList(ReadOnlySpan<char> path, out PublicListKey key)
    {
        key = default;
        if (!TryClassifyRoute(path, string.Empty, out PublicHotReadRoute route)
            || route.Kind != PublicHotReadRouteKind.ArticleList)
        {
            return false;
        }

        key = route.ListKey;
        return true;
    }

    internal static bool TryMatchArticleHot(ReadOnlySpan<char> path, out PublicListKey key)
    {
        key = default;
        if (!TryClassifyRoute(path, string.Empty, out PublicHotReadRoute route)
            || route.Kind != PublicHotReadRouteKind.ArticleHot)
        {
            return false;
        }

        key = route.ListKey;
        return true;
    }

    internal static bool TryMatchArticleFeatured(ReadOnlySpan<char> path, out PublicListKey key)
    {
        key = default;
        if (!TryClassifyRoute(path, string.Empty, out PublicHotReadRoute route)
            || route.Kind != PublicHotReadRouteKind.ArticleFeatured)
        {
            return false;
        }

        key = route.ListKey;
        return true;
    }

    internal static bool TryMatchArticleHtml(ReadOnlySpan<char> path, string pathValue, out string routeKey)
    {
        routeKey = string.Empty;
        if (!TryClassifyRoute(path, pathValue, out PublicHotReadRoute route)
            || route.Kind != PublicHotReadRouteKind.ArticleHtml)
        {
            return false;
        }

        routeKey = route.HtmlRouteKey;
        return true;
    }

    private static bool TryParsePositiveInt(ReadOnlySpan<char> value, out int parsed)
    {
        parsed = 0;
        if (value.IsEmpty || value.Length > 9)
        {
            return false;
        }

        int result = 0;
        for (int i = 0; i < value.Length; i++)
        {
            char c = value[i];
            if ((uint)(c - '0') > 9)
            {
                return false;
            }

            result = checked(result * 10 + (c - '0'));
        }

        parsed = result;
        return parsed > 0;
    }

    private static bool TryParseUShort(ReadOnlySpan<char> value, out ushort parsed)
    {
        parsed = 0;
        if (!TryParsePositiveInt(value, out int result) || result > ushort.MaxValue)
        {
            return false;
        }

        parsed = (ushort)result;
        return true;
    }

    private static bool TryParseByteSize(ReadOnlySpan<char> value, out byte parsed)
    {
        parsed = 0;
        if (!TryParsePositiveInt(value, out int result) || result > 100)
        {
            return false;
        }

        parsed = (byte)result;
        return true;
    }
}
