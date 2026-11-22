using System.Collections.Concurrent;
using System.Collections.Frozen;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Platform;
using FsusBlog.V2.Server.Operations;
using Microsoft.Net.Http.Headers;
using Microsoft.Win32.SafeHandles;
using Npgsql;

namespace FsusBlog.V2.Server.Content;

internal sealed class SitePages
{
    private const string Html = "text/html; charset=utf-8";
    internal const string EditorSetting = "FSUSBLOG_SITE_PAGE_EDITOR";
    private const string Unconfigured = "页面内容正在准备中，请稍后再试。";
    private static readonly string[] ReadMethods = [HttpMethods.Get, HttpMethods.Head];
    private static readonly UTF8Encoding Utf8 = new(false, true);
    private static readonly (string Slug, string Title)[] Definitions =
        [("about", "关于"), ("privacy", "隐私政策"), ("guidelines", "用户守则"), ("copyright", "版权声明")];

    private sealed record Page(AdminSitePageRevision Revision, AdminSitePageRevision EditorBaseline, long SiteConfigRevision, byte[] Html, byte[] Frame, bool Configured,
        EntityTagHeaderValue HtmlTag, EntityTagHeaderValue FrameTag, byte[] EnglishHtml, EntityTagHeaderValue EnglishHtmlTag);

    private readonly FrozenDictionary<string, Page> current;
    private readonly ConcurrentDictionary<string, Page> published = new(StringComparer.Ordinal);
    private readonly WebPages renderer;
    private readonly NpgsqlDataSource source;
    private readonly InstanceLease lease;
    private int liveConfiguredMask;
    internal IReadOnlyList<string> ConfiguredPaths { get; }

    internal int ConfiguredMask { get; }
    internal bool EditorEnabled { get; }

    internal IReadOnlyList<string> CurrentConfiguredPaths()
    {
        var mask = Volatile.Read(ref liveConfiguredMask);
        if (mask == 0) return [];
        var paths = new List<string>(Definitions.Length);
        for (var index = 0; index < Definitions.Length; index++)
            if ((mask & (1 << index)) != 0) paths.Add("/" + Definitions[index].Slug);
        return paths;
    }

    internal async Task<int> ConfiguredMaskAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        var mask = ConfiguredMask;
        if (!EditorEnabled) return mask;
        await using var command = Store.Sql(db, tx, "select slug from public.site_page_content where revision > 0");
        await using var rows = await command.ExecuteReaderAsync(ct);
        while (await rows.ReadAsync(ct))
        {
            var slug = rows.GetString(0);
            for (var index = 0; index < Definitions.Length; index++)
                if (string.Equals(Definitions[index].Slug, slug, StringComparison.OrdinalIgnoreCase))
                    mask |= 1 << index;
        }
        Volatile.Write(ref liveConfiguredMask, mask);
        return mask;
    }

    internal void MarkPublished(string slug)
    {
        for (var index = 0; index < Definitions.Length; index++)
            if (string.Equals(Definitions[index].Slug, slug, StringComparison.OrdinalIgnoreCase))
                Interlocked.Or(ref liveConfiguredMask, 1 << index);
    }

    private Page Find(string slug, bool configured = false)
    {
        if (slug.Length > WireLayouts.PageContentSlugBytes || !slug.All(char.IsAsciiLetter) ||
            !current.TryGetValue(slug, out var page) || (configured && !page.Configured))
            throw new BusinessException(Rejection.NotFound, "Site page not found.");
        return page;
    }

    internal async Task<byte[]> ConfiguredFrame(NpgsqlConnection db, NpgsqlTransaction tx, string slug, CancellationToken ct)
    {
        var baseline = Find(slug, configured: !EditorEnabled);
        if (!EditorEnabled) return baseline.Frame;
        var revision = await SitePagePublicationStore.Read(db, tx, baseline.EditorBaseline, ct);
        if (revision.Revision == 0 && !baseline.Configured)
            throw new BusinessException(Rejection.NotFound, "Site page not found.");
        return revision.Revision == 0 ? baseline.Frame : SitePageWire.Encode(revision.Slug, revision.Markdown);
    }

    internal AdminSitePageRevision EditorBaseline(string slug)
    {
        if (!EditorEnabled) throw new BusinessException(Rejection.NotFound, "The site page editor is unavailable.");
        return Find(slug).EditorBaseline;
    }

    internal SitePages(string? configuredRoot, WebPages renderer, NpgsqlDataSource source, InstanceLease lease, bool editorEnabled)
    {
        this.renderer = renderer;
        this.source = source;
        this.lease = lease;
        EditorEnabled = editorEnabled;
        if (string.IsNullOrWhiteSpace(configuredRoot))
        {
            current = BuildPages(null, null);
        }
        else
        {
            var root = CheckRoot(configuredRoot);
            using var anchored = NativeUnixFile.Supported ? NativeUnixFile.OpenDirectory(root) : null;
            current = BuildPages(root, anchored);
        }
        for (var index = 0; index < Definitions.Length; index++)
            if (current[Definitions[index].Slug].Configured) ConfiguredMask |= 1 << index;
        liveConfiguredMask = ConfiguredMask;
        ConfiguredPaths = Definitions.Where(spec => current[spec.Slug].Configured)
            .Select(spec => "/" + spec.Slug).ToArray();

        FrozenDictionary<string, Page> BuildPages(string? root, SafeFileHandle? anchored) => Definitions.ToFrozenDictionary(
            spec => spec.Slug,
            spec =>
            {
                var markdown = root is null ? Unconfigured : Read(root, anchored, spec.Slug + ".md");
                var publicRevision = new AdminSitePageRevision(spec.Slug, 0, SitePagePublicationStore.Digest(markdown), markdown);
                var editorBaseline = root is null
                    ? new AdminSitePageRevision(spec.Slug, 0, SitePagePublicationStore.Digest(string.Empty), string.Empty)
                    : publicRevision;
                return Build(spec, publicRevision, editorBaseline, root is not null);
            }, StringComparer.OrdinalIgnoreCase);
    }

    internal void Map(WebApplication app)
    {
        foreach (var (slug, baseline) in current)
        {
            var pageRoute = app.MapMethods("/" + slug, ReadMethods, async (HttpContext context, CancellationToken ct) =>
            {
                context.Response.Headers.CacheControl = "no-store";
                var page = await PublicPage(baseline, ct);
                SetHeaders(context, page);
                var english = SiteLocale.Select(context) == "en";
                return Results.Bytes(english ? page.EnglishHtml : page.Html, Html, entityTag: english ? page.EnglishHtmlTag : page.HtmlTag);
            });
            if (EditorEnabled) pageRoute.RequireRateLimiting("query");
        }

        var frameRoute = app.MapMethods(WireRoutes.PublicSitePage, ReadMethods, async (HttpContext context, string slug, CancellationToken ct) =>
        {
            var page = await PublicPage(Find(slug), ct);
            SetHeaders(context, page);
            return Results.Bytes(page.Frame, Aeds.ContentType, entityTag: page.FrameTag);
        });
        if (EditorEnabled) frameRoute.RequireRateLimiting("query");
    }

    private async Task<Page> PublicPage(Page baseline, CancellationToken ct)
    {
        var siteConfigRevision = renderer.SiteConfigRevision;
        if (!EditorEnabled)
        {
            if (baseline.SiteConfigRevision == siteConfigRevision) return baseline;
            if (published.TryGetValue(baseline.Revision.Slug, out var cached) &&
                cached.Revision.Revision == 0 && cached.SiteConfigRevision == siteConfigRevision)
                return cached;
            var refreshed = Build(Definitions.Single(spec => spec.Slug == baseline.Revision.Slug), baseline.Revision, baseline.EditorBaseline, baseline.Configured);
            published[baseline.Revision.Slug] = refreshed;
            return refreshed;
        }
        await using var db = await source.OpenConnectionAsync(ct);
        await using var tx = await InstanceLease.BeginProtected(db, lease, ct);
        var revision = await SitePagePublicationStore.Read(db, tx, baseline.EditorBaseline, ct);
        await InstanceLease.CommitProtected(tx, lease, ct);
        if (revision.Revision == 0)
        {
            if (baseline.SiteConfigRevision == siteConfigRevision) return baseline;
            if (published.TryGetValue(baseline.Revision.Slug, out var cached0) &&
                cached0.Revision.Revision == 0 && cached0.SiteConfigRevision == siteConfigRevision)
                return cached0;
            var refreshed0 = Build(Definitions.Single(spec => spec.Slug == baseline.Revision.Slug), baseline.Revision, baseline.EditorBaseline, baseline.Configured);
            published[baseline.Revision.Slug] = refreshed0;
            return refreshed0;
        }
        MarkPublished(revision.Slug);
        if (published.TryGetValue(revision.Slug, out var ready) &&
            ready.Revision.Revision == revision.Revision && ready.SiteConfigRevision == siteConfigRevision)
            return ready;
        var page = Build(Definitions.Single(spec => spec.Slug == revision.Slug), revision, baseline.EditorBaseline, configured: true);
        published.AddOrUpdate(revision.Slug, page, (_, previous) =>
            previous.Revision.Revision > revision.Revision ||
            (previous.Revision.Revision == revision.Revision && previous.SiteConfigRevision > page.SiteConfigRevision)
                ? previous : page);
        return page;
    }

    private Page Build((string Slug, string Title) spec, AdminSitePageRevision revision, AdminSitePageRevision editorBaseline, bool configured)
    {
        var siteConfigRevision = renderer.SiteConfigRevision;
        var frame = SitePageWire.Encode(spec.Slug, revision.Markdown);
        var state = configured ? "published" : "unconfigured";
        var body = PublicArticleHtml.RenderMarkdown(revision.Markdown);
        byte[] HtmlFor(string locale)
        {
            var title = SiteLocale.Text(locale, "policy." + spec.Slug);
            var content = $"<article class=\"reading-column editorial-page article-body\" data-fsus-surface=\"reading\" data-site-page=\"{spec.Slug}\" data-state=\"{state}\"><header class=\"editorial-rule\"><h1>{HtmlEncoder.Default.Encode(title)}</h1></header>" +
                $"<div class=\"blog-markdown\" data-site-page-body lang=\"zh-CN\">{body}</div></article>";
            return renderer.PublicPage(content, title, noIndex: !configured, publicPath: "/" + spec.Slug, contentDriven: true, locale: locale);
        }
        var html = HtmlFor(SiteLocale.Default);
        var englishHtml = HtmlFor("en");
        return new(revision, editorBaseline, siteConfigRevision, html, frame, configured, StrongTag(html), StrongTag(frame), englishHtml, StrongTag(englishHtml));
    }

    private static EntityTagHeaderValue StrongTag(byte[] contents) => new("\"" + Convert.ToHexStringLower(SHA256.HashData(contents)) + "\"");

    private static void SetHeaders(HttpContext context, Page page)
    {
        context.Response.Headers.ContentLanguage = "zh-CN";
        if (!page.Configured) context.Response.Headers["X-Robots-Tag"] = "noindex, follow";
    }

    private static string CheckRoot(string configuredRoot)
    {
        if (!Path.IsPathFullyQualified(configuredRoot))
            throw new InvalidOperationException("FSUSBLOG_SITE_PAGES must be an absolute release directory.");

        var path = Path.GetFullPath(configuredRoot);
        for (var directory = new DirectoryInfo(path); directory is not null; directory = directory.Parent)
        {
            var attributes = File.GetAttributes(directory.FullName);
            if ((attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != FileAttributes.Directory)
                throw new InvalidOperationException("FSUSBLOG_SITE_PAGES must have real directories throughout its path.");
        }
        return path;
    }

    private static string Read(string root, SafeFileHandle? anchored, string name)
    {
        using var contents = OpenInput(root, anchored, name);
        if (!contents.CanSeek || contents.Length > WireLimits.PageContentBytes)
            throw new InvalidOperationException("Site page inputs must be regular and within the byte budget.");
        var buffer = new byte[WireLimits.PageContentBytes + 1];
        var count = contents.ReadAtLeast(buffer, buffer.Length, throwOnEndOfStream: false);
        if (count > WireLimits.PageContentBytes)
            throw new InvalidOperationException("Site page exceeds its byte limit.");
        var source = buffer.AsSpan(0, count);
        if (source.StartsWith("\ufeff"u8))
            source = source[3..];
        var markdown = Utf8.GetString(source);
        if (markdown.Length > WireLimits.PageContentChars || markdown.Contains('\0') || string.IsNullOrWhiteSpace(markdown))
            throw new InvalidOperationException("Site page must contain valid, nonempty Markdown within its character budget.");
        return markdown;
    }

    private static FileStream OpenInput(string root, SafeFileHandle? anchored, string name)
    {
        if (anchored is null)
        {
            if (OperatingSystem.IsLinux() || OperatingSystem.IsMacOS()) throw new PlatformNotSupportedException();
            var path = Path.Combine(root, name);
            if ((File.GetAttributes(path) & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0)
                throw new InvalidOperationException("Site page inputs must be regular files within the release directory.");
            return File.OpenRead(path);
        }
        var handle = NativeUnixFile.OpenFile(anchored, name, NativeUnixFile.FileReadFlags, out var error)
            ?? throw new IOException("Could not open a site page input.", error);
        try
        {
            if (!NativeUnixFile.IsRegular(handle)) throw new InvalidOperationException("Site page inputs must be regular files within the release directory.");
            return new FileStream(handle, FileAccess.Read);
        }
        catch { handle.Dispose(); throw; }
    }
}
