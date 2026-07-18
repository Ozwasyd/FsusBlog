using System.Buffers;
using System.Collections.Concurrent;
using System.IO.Pipelines;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Helpers.Initializer;
using FsusBlog.Server.Infrastructure.Middlewares;
using FsusBlog.Server.Infrastructure.NotificationStream;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Infrastructure.Spa;
using FsusBlog.Server.Infrastructure.Storage;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services;

using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Primitives;

namespace FsusBlog.Server.Infrastructure.Bootstrap;

public static partial class WebApplicationCompositionExtensions
{
    private static async Task WriteSpaHtmlResponseAsync(
        HttpContext ctx,
        IWebHostEnvironment env,
        ReadOnlyMemory<byte> templateBytes,
        ReadOnlyMemory<byte> headInjection,
        CancellationToken cancellationToken)
    {
        EnsureHtmlCspHeader(ctx, env);
        SpaHtmlByteTemplate template = GetSpaHtmlByteTemplate(templateBytes);
        ReadOnlyMemory<byte> nonceBytes = GetEncodedNonceBytes(ctx);
        int contentLength = template.GetLength(nonceBytes.Length, headInjection.Length);

        ctx.Response.ContentType = HtmlContentType;

        ArrayBufferWriter<byte> output = new(Math.Max(contentLength, 0));
        template.Write(output, nonceBytes.Span, headInjection.Span);
        if (!TrySelectSpaHtmlResponseVariant(
                ctx.Request.Headers.AcceptEncoding,
                output.WrittenMemory,
                out PublicAotHtmlArtifactVariant variant))
        {
            ctx.Response.StatusCode = StatusCodes.Status406NotAcceptable;
            ctx.Response.ContentLength = 0;
            ctx.Response.Headers.Remove("Content-Encoding");
            return;
        }

        ctx.Response.ContentLength = variant.Bytes.Length;
        if (string.IsNullOrWhiteSpace(variant.ContentEncoding))
        {
            ctx.Response.Headers.Remove("Content-Encoding");
        }
        else
        {
            ctx.Response.Headers["Content-Encoding"] = variant.ContentEncoding;
        }

        if (HttpMethods.IsHead(ctx.Request.Method) || variant.Bytes.IsEmpty)
        {
            return;
        }

        ValueTask<FlushResult> write = ctx.Response.BodyWriter.WriteAsync(variant.Bytes, cancellationToken);
        if (!write.IsCompletedSuccessfully)
        {
            await write;
        }
    }

    private static bool TrySelectSpaHtmlResponseVariant(
        StringValues acceptEncoding,
        ReadOnlyMemory<byte> identityBytes,
        out PublicAotHtmlArtifactVariant variant)
    {
        var document = new PublicAotHtmlArtifact(
            identityBytes,
            string.Empty,
            s_emptyBytes,
            string.Empty,
            s_emptyBytes,
            string.Empty,
            HtmlContentType,
            PublicAotHtmlArtifactOptions.DefaultCacheControl,
            string.Empty,
            string.Empty,
            CspNonceTemplate: null);
        return PublicAotHtmlResponseNegotiation.TrySelectVariant(acceptEncoding, document, out variant);
    }

    private static void EnsureAcceptEncodingVary(IHeaderDictionary headers)
    {
        string existing = headers.Vary.ToString();
        if (string.IsNullOrWhiteSpace(existing))
        {
            headers["Vary"] = "Accept-Encoding";
            return;
        }

        foreach (string segment in existing.Split(','))
        {
            if (string.Equals(segment.Trim(), "Accept-Encoding", StringComparison.OrdinalIgnoreCase))
            {
                return;
            }
        }

        headers["Vary"] = string.Concat(existing, ", Accept-Encoding");
    }

    private static SpaHtmlByteTemplate GetSpaHtmlByteTemplate(ReadOnlyMemory<byte> templateBytes)
    {
        if (templateBytes.Length == 0)
        {
            return SpaHtmlByteTemplate.Empty;
        }

        Span<byte> digest = stackalloc byte[32];
        SHA256.HashData(templateBytes.Span, digest);
        string key = Convert.ToHexStringLower(digest);
        if (s_spaHtmlByteTemplates.TryGetValue(key, out SpaHtmlByteTemplate? cached))
        {
            return cached;
        }

        if (s_spaHtmlByteTemplates.Count >= DefaultSpaTemplateCacheMaxEntries)
        {
            s_spaHtmlByteTemplates.Clear();
        }

        return s_spaHtmlByteTemplates.GetOrAdd(
            key,
            static (_, bytes) => SpaHtmlByteTemplate.Create(bytes.Span),
            templateBytes);
    }

    private static ReadOnlyMemory<byte> GetEncodedNonceBytes(HttpContext ctx)
    {
        string nonce = EnsureCspNonce(ctx);
        string encodedNonce = System.Net.WebUtility.HtmlEncode(nonce);
        return Encoding.UTF8.GetBytes(encodedNonce);
    }

    private static ReadOnlyMemory<byte> GetCachedRoutePreloadHeadInjection(
        string assetVersion,
        string routeKey,
        IReadOnlyList<string> preloads)
    {
        if (preloads.Count == 0)
        {
            return s_emptyBytes;
        }

        var key = new HeadInjectionCacheKey(
            NormalizeHeadInjectionCacheSegment(assetVersion, "missing-manifest"),
            NormalizeHeadInjectionCacheSegment(routeKey, "/"),
            HeadInjectionKindRoutePreload);
        CachedHeadInjection cached = GetOrAddHeadInjection(
            key,
            preloads.Count,
            () => BuildRoutePreloadHeadInjection(preloads));
        return cached.Bytes;
    }

    private static ReadOnlyMemory<byte> GetCachedPublicAssetHeadInjection(string routeKey, SpaAssetSet publicAssetSet)
    {
        int assetCount = publicAssetSet.ModulePreloads.Count + publicAssetSet.Stylesheets.Count;
        if (assetCount == 0)
        {
            return s_emptyBytes;
        }

        var key = new HeadInjectionCacheKey(
            NormalizeHeadInjectionCacheSegment(publicAssetSet.FrontendAssetVersion, "missing-manifest"),
            NormalizeHeadInjectionCacheSegment(routeKey, "/"),
            HeadInjectionKindPublicAssetSet);
        CachedHeadInjection cached = GetOrAddHeadInjection(
            key,
            assetCount,
            () => BuildPublicAssetHeadInjection(publicAssetSet));
        return cached.Bytes;
    }

    private static CachedHeadInjection GetOrAddHeadInjection(
        HeadInjectionCacheKey key,
        int assetCount,
        Func<ReadOnlyMemory<byte>> build)
    {
        if (s_spaHeadInjectionCache.TryGetValue(key, out CachedHeadInjection cached))
        {
            Interlocked.Increment(ref s_spaHeadInjectionHitCount);
            return cached;
        }

        if (s_spaHeadInjectionCache.Count >= DefaultSpaHeadInjectionCacheMaxEntries)
        {
            s_spaHeadInjectionCache.Clear();
        }

        return s_spaHeadInjectionCache.GetOrAdd(
            key,
            static (cacheKey, state) =>
            {
                Interlocked.Increment(ref s_spaHeadInjectionBuildCount);
                return new CachedHeadInjection(state.Build(), state.AssetCount, cacheKey.AssetVersion);
            },
            (Build: build, AssetCount: assetCount));
    }

    private static string NormalizeHeadInjectionCacheSegment(string value, string fallback)
    {
        string normalized = value.Trim();
        return normalized.Length == 0 ? fallback : normalized;
    }

    internal static void ResetSpaHeadInjectionCacheForTests()
    {
        s_spaHeadInjectionCache.Clear();
        Interlocked.Exchange(ref s_spaHeadInjectionBuildCount, 0);
        Interlocked.Exchange(ref s_spaHeadInjectionHitCount, 0);
    }

    internal static SpaHeadInjectionCacheStats GetSpaHeadInjectionCacheStatsForTests()
        => new(
            s_spaHeadInjectionCache.Count,
            Volatile.Read(ref s_spaHeadInjectionBuildCount),
            Volatile.Read(ref s_spaHeadInjectionHitCount));

    internal static ReadOnlyMemory<byte> GetRoutePreloadHeadInjectionForTests(
        string assetVersion,
        string routeKey,
        IReadOnlyList<string> preloads)
        => GetCachedRoutePreloadHeadInjection(assetVersion, routeKey, preloads);

    internal static ReadOnlyMemory<byte> GetPublicAssetHeadInjectionForTests(string routeKey, SpaAssetSet publicAssetSet)
        => GetCachedPublicAssetHeadInjection(routeKey, publicAssetSet);

    internal static ReadOnlyMemory<byte> GetSeoBrandHeadInjectionForTests(SeoConfigReadModel seo)
        => BuildSeoBrandHeadInjection(seo);

    internal static ReadOnlyMemory<byte> GetSearchNoIndexHeadInjectionForTests()
        => s_searchNoIndexHeadInjection;

    internal static async Task<string> RenderSpaHtmlForTestsAsync(
        string templateHtml,
        ReadOnlyMemory<byte> headInjection,
        string nonce)
    {
        SpaHtmlByteTemplate template = GetSpaHtmlByteTemplate(Encoding.UTF8.GetBytes(templateHtml));
        string encodedNonce = System.Net.WebUtility.HtmlEncode(nonce);
        await using var output = new MemoryStream();
        PipeWriter writer = PipeWriter.Create(output);
        template.Write(writer, Encoding.UTF8.GetBytes(encodedNonce), headInjection.Span);
        await writer.FlushAsync();
        await writer.CompleteAsync();
        return Encoding.UTF8.GetString(output.ToArray());
    }

    internal static Task WriteSpaHtmlResponseForTestsAsync(
        HttpContext ctx,
        IWebHostEnvironment env,
        string templateHtml,
        ReadOnlyMemory<byte> headInjection)
        => WriteSpaHtmlResponseAsync(
            ctx,
            env,
            Encoding.UTF8.GetBytes(templateHtml),
            headInjection,
            CancellationToken.None);

    internal static Task WritePublicAotHtmlEntryForTestsAsync(
        HttpContext ctx,
        IWebHostEnvironment env,
        PublicAotCacheEntry entry,
        string state = "fresh")
        => WritePublicAotHtmlEntryAsync(
            ctx,
            env,
            entry,
            entry.Source.ToHeaderValue(),
            entry.RendererVersion,
            "none",
            state,
            "prod-manifest",
            CancellationToken.None);

    internal static Task WriteDynamicManifestForTestsAsync(HttpContext ctx, SeoConfigReadModel seo)
        => WriteDynamicManifestAsync(ctx, seo);

    private static ReadOnlyMemory<byte> BuildRoutePreloadHeadInjection(IReadOnlyList<string> preloads)
    {
        if (preloads.Count == 0)
        {
            return s_emptyBytes;
        }

        var sb = new StringBuilder(preloads.Count * 64);
        foreach (string asset in preloads)
        {
            if (asset.EndsWith(".js", StringComparison.OrdinalIgnoreCase))
            {
                sb.Append("<link rel=\"modulepreload\" href=\"");
                sb.Append(asset);
                sb.AppendLine("\">");
            }
            else if (asset.EndsWith(".css", StringComparison.OrdinalIgnoreCase))
            {
                sb.Append("<link rel=\"stylesheet\" href=\"");
                sb.Append(asset);
                sb.AppendLine("\">");
            }
        }

        return sb.Length == 0 ? s_emptyBytes : Encoding.UTF8.GetBytes(sb.ToString());
    }

    private static ReadOnlyMemory<byte> BuildSeoBrandHeadInjection(SeoConfigReadModel seo)
    {
        var sb = new StringBuilder(512);
        AppendMeta(sb, "theme-color", seo.ThemeColor);
        AppendLink(sb, "icon", seo.FaviconSvgUrl, "image/svg+xml");
        AppendLink(sb, "icon", seo.FaviconIcoUrl, "image/x-icon");
        AppendLink(sb, "icon", seo.FaviconPngUrl, "image/png");
        AppendLink(sb, "apple-touch-icon", seo.AppleTouchIconUrl, null);
        AppendMetaProperty(sb, "og:image", seo.OgImage);
        AppendMeta(sb, "twitter:image", seo.OgImage);
        return sb.Length == 0 ? s_emptyBytes : Encoding.UTF8.GetBytes(sb.ToString());
    }

    private static ReadOnlyMemory<byte> CombineHeadInjections(ReadOnlyMemory<byte> first, ReadOnlyMemory<byte> second)
    {
        if (first.IsEmpty)
        {
            return second;
        }

        if (second.IsEmpty)
        {
            return first;
        }

        byte[] bytes = new byte[first.Length + second.Length];
        first.Span.CopyTo(bytes);
        second.Span.CopyTo(bytes.AsSpan(first.Length));
        return bytes;
    }

    private static void AppendMeta(StringBuilder sb, string name, string content)
    {
        if (string.IsNullOrWhiteSpace(content))
        {
            return;
        }

        sb.Append("    <meta name=\"")
            .Append(WebUtility.HtmlEncode(name))
            .Append("\" content=\"")
            .Append(WebUtility.HtmlEncode(content))
            .AppendLine("\" data-fsusblog-seo=\"runtime\" />");
    }

    private static void AppendMetaProperty(StringBuilder sb, string property, string content)
    {
        if (string.IsNullOrWhiteSpace(content))
        {
            return;
        }

        sb.Append("    <meta property=\"")
            .Append(WebUtility.HtmlEncode(property))
            .Append("\" content=\"")
            .Append(WebUtility.HtmlEncode(content))
            .AppendLine("\" data-fsusblog-seo=\"runtime\" />");
    }

    private static void AppendLink(StringBuilder sb, string rel, string href, string? type)
    {
        if (string.IsNullOrWhiteSpace(href))
        {
            return;
        }

        sb.Append("    <link rel=\"")
            .Append(WebUtility.HtmlEncode(rel))
            .Append('"');
        if (!string.IsNullOrWhiteSpace(type))
        {
            sb.Append(" type=\"")
                .Append(WebUtility.HtmlEncode(type))
                .Append('"');
        }

        sb.Append(" href=\"")
            .Append(WebUtility.HtmlEncode(href))
            .AppendLine("\" data-fsusblog-seo=\"runtime\" />");
    }

    private static ReadOnlyMemory<byte> BuildPublicAssetHeadInjection(SpaAssetSet publicAssetSet)
    {
        int assetCount = publicAssetSet.ModulePreloads.Count + publicAssetSet.Stylesheets.Count;
        if (assetCount == 0)
        {
            return s_emptyBytes;
        }

        var sb = new StringBuilder(assetCount * 72);
        foreach (string asset in publicAssetSet.ModulePreloads)
        {
            sb.Append("<link rel=\"modulepreload\" crossorigin href=\"");
            sb.Append(asset);
            sb.AppendLine("\">");
        }

        foreach (string asset in publicAssetSet.Stylesheets)
        {
            sb.Append("<link rel=\"stylesheet\" href=\"");
            sb.Append(asset);
            sb.AppendLine("\">");
        }

        return Encoding.UTF8.GetBytes(sb.ToString());
    }

    private static CspNonceHtmlTemplate BuildCspNonceHtmlTemplate(string html)
    {
        bool needsCspMeta = !html.Contains("property=\"csp-nonce\"", StringComparison.OrdinalIgnoreCase)
            && !html.Contains("property='csp-nonce'", StringComparison.OrdinalIgnoreCase);
        if (!html.Contains("<script", StringComparison.OrdinalIgnoreCase)
            && !html.Contains("<style", StringComparison.OrdinalIgnoreCase)
            && (!needsCspMeta || !html.Contains("<head>", StringComparison.OrdinalIgnoreCase)))
        {
            return CspNonceHtmlTemplate.Unchanged;
        }

        var builder = new StringBuilder(html.Length + CspNonceTemplatePlaceholder.Length * 4 + 64);
        int position = 0;
        bool hasPlaceholders = false;
        while (position < html.Length)
        {
            int tagStart = html.IndexOf('<', position);
            if (tagStart < 0)
            {
                builder.Append(html, position, html.Length - position);
                break;
            }

            builder.Append(html, position, tagStart - position);
            int tagEnd = html.IndexOf('>', tagStart);
            if (tagEnd < 0)
            {
                builder.Append(html, tagStart, html.Length - tagStart);
                break;
            }

            if (IsTagStart(html, tagStart, "script") && !TagContainsNonce(html, tagStart, tagEnd))
            {
                AppendTagWithNonce(builder, html, tagStart, tagEnd, "script", CspNonceTemplatePlaceholder);
                hasPlaceholders = true;
            }
            else if (IsTagStart(html, tagStart, "style") && !TagContainsNonce(html, tagStart, tagEnd))
            {
                AppendTagWithNonce(builder, html, tagStart, tagEnd, "style", CspNonceTemplatePlaceholder);
                hasPlaceholders = true;
            }
            else
            {
                builder.Append(html, tagStart, tagEnd - tagStart + 1);
                if (needsCspMeta && IsExactHeadTag(html, tagStart, tagEnd))
                {
                    builder.Append('\n');
                    builder.Append("    <meta property=\"csp-nonce\" nonce=\"");
                    builder.Append(CspNonceTemplatePlaceholder);
                    builder.Append("\" />");
                    needsCspMeta = false;
                    hasPlaceholders = true;
                }
            }

            position = tagEnd + 1;
        }

        return hasPlaceholders
            ? new CspNonceHtmlTemplate(builder.ToString(), true)
            : CspNonceHtmlTemplate.Unchanged;
    }

    private static bool IsTagStart(string html, int tagStart, string tagName)
    {
        int nameStart = tagStart + 1;
        if (html.Length < nameStart + tagName.Length
            || !html.AsSpan(nameStart, tagName.Length).Equals(tagName, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        int nameEnd = nameStart + tagName.Length;
        return nameEnd >= html.Length
            || char.IsWhiteSpace(html[nameEnd])
            || html[nameEnd] == '>'
            || html[nameEnd] == '/';
    }

    private static bool IsExactHeadTag(string html, int tagStart, int tagEnd)
        => tagEnd - tagStart == 5
            && html.AsSpan(tagStart, 6).Equals("<head>", StringComparison.OrdinalIgnoreCase);

    private static bool TagContainsNonce(string html, int tagStart, int tagEnd)
        => html.AsSpan(tagStart, tagEnd - tagStart + 1).IndexOf("nonce=", StringComparison.OrdinalIgnoreCase) >= 0;

    private static void AppendTagWithNonce(
        StringBuilder builder,
        string html,
        int tagStart,
        int tagEnd,
        string tagName,
        string encodedNonce)
    {
        int insertAt = tagStart + 1 + tagName.Length;
        builder.Append(html, tagStart, insertAt - tagStart);
        builder.Append(" nonce=\"");
        builder.Append(encodedNonce);
        builder.Append('"');
        builder.Append(html, insertAt, tagEnd - insertAt + 1);
    }

    private sealed class SpaHtmlByteTemplate
    {
        public static SpaHtmlByteTemplate Empty
        {
            get;
        } = new(
            NoncePatchedByteTemplate.Empty,
            NoncePatchedByteTemplate.Empty);

        private readonly NoncePatchedByteTemplate _beforeHeadClose;
        private readonly NoncePatchedByteTemplate _headCloseAndAfter;

        private SpaHtmlByteTemplate(NoncePatchedByteTemplate beforeHeadClose, NoncePatchedByteTemplate headCloseAndAfter)
        {
            _beforeHeadClose = beforeHeadClose;
            _headCloseAndAfter = headCloseAndAfter;
        }

        public static SpaHtmlByteTemplate Create(ReadOnlySpan<byte> templateBytes)
        {
            if (templateBytes.IsEmpty)
            {
                return Empty;
            }

            string html = Encoding.UTF8.GetString(templateBytes);
            CspNonceHtmlTemplate cspTemplate = BuildCspNonceHtmlTemplate(html);
            string patchedHtml = cspTemplate.HasPlaceholders ? cspTemplate.Html : html;
            int headClose = patchedHtml.IndexOf("</head>", StringComparison.OrdinalIgnoreCase);
            if (headClose < 0)
            {
                return new SpaHtmlByteTemplate(
                    NoncePatchedByteTemplate.Create(patchedHtml),
                    NoncePatchedByteTemplate.Empty);
            }

            return new SpaHtmlByteTemplate(
                NoncePatchedByteTemplate.Create(patchedHtml[..headClose]),
                NoncePatchedByteTemplate.Create(patchedHtml[headClose..]));
        }

        public int GetLength(int nonceLength, int headInjectionLength)
            => _beforeHeadClose.GetLength(nonceLength)
                + headInjectionLength
                + _headCloseAndAfter.GetLength(nonceLength);

        public void Write(IBufferWriter<byte> writer, ReadOnlySpan<byte> nonce, ReadOnlySpan<byte> headInjection)
        {
            _beforeHeadClose.Write(writer, nonce);
            WriteBytes(writer, headInjection);
            _headCloseAndAfter.Write(writer, nonce);
        }
    }

    private sealed class NoncePatchedByteTemplate
    {
        public static NoncePatchedByteTemplate Empty { get; } = new([], 0, 0);

        private readonly byte[][] _segments;
        private readonly int _placeholderCount;
        private readonly int _lengthWithoutNonce;

        private NoncePatchedByteTemplate(byte[][] segments, int placeholderCount, int lengthWithoutNonce)
        {
            _segments = segments;
            _placeholderCount = placeholderCount;
            _lengthWithoutNonce = lengthWithoutNonce;
        }

        public static NoncePatchedByteTemplate Create(string source)
        {
            if (string.IsNullOrEmpty(source))
            {
                return Empty;
            }

            var segments = new List<byte[]>();
            int lengthWithoutNonce = 0;
            int placeholderCount = 0;
            int position = 0;
            while (position < source.Length)
            {
                int placeholder = source.IndexOf(CspNonceTemplatePlaceholder, position, StringComparison.Ordinal);
                if (placeholder < 0)
                {
                    byte[] segment = Encoding.UTF8.GetBytes(source[position..]);
                    segments.Add(segment);
                    lengthWithoutNonce += segment.Length;
                    break;
                }

                byte[] before = Encoding.UTF8.GetBytes(source[position..placeholder]);
                segments.Add(before);
                lengthWithoutNonce += before.Length;
                placeholderCount++;
                position = placeholder + CspNonceTemplatePlaceholder.Length;
            }

            if (source.EndsWith(CspNonceTemplatePlaceholder, StringComparison.Ordinal))
            {
                segments.Add([]);
            }

            return new NoncePatchedByteTemplate([.. segments], placeholderCount, lengthWithoutNonce);
        }

        public int GetLength(int nonceLength)
            => _lengthWithoutNonce + _placeholderCount * nonceLength;

        public void Write(IBufferWriter<byte> writer, ReadOnlySpan<byte> nonce)
        {
            for (int i = 0; i < _segments.Length; i++)
            {
                WriteBytes(writer, _segments[i]);
                if (i < _placeholderCount)
                {
                    WriteBytes(writer, nonce);
                }
            }
        }
    }

    private static void WriteBytes(IBufferWriter<byte> writer, ReadOnlySpan<byte> bytes)
    {
        if (bytes.IsEmpty)
        {
            return;
        }

        bytes.CopyTo(writer.GetSpan(bytes.Length));
        writer.Advance(bytes.Length);
    }

    private readonly record struct HeadInjectionCacheKey(
        string AssetVersion,
        string RouteKey,
        string Kind);

    private readonly record struct CachedHeadInjection(
        ReadOnlyMemory<byte> Bytes,
        int AssetCount,
        string AssetVersion);

    internal readonly record struct SpaHeadInjectionCacheStats(
        int EntryCount,
        long BuildCount,
        long HitCount);

    private sealed record CspNonceHtmlTemplate(string Html, bool HasPlaceholders)
    {
        public static CspNonceHtmlTemplate Unchanged { get; } = new(string.Empty, false);
    }
}
