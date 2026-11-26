using Microsoft.Net.Http.Headers;
using System.Collections.Concurrent;
using Microsoft.Win32.SafeHandles;

namespace FsusBlog.V2.Server.Content;

internal sealed class SitePages
{
    private const string Html = "text/html; charset=utf-8";
    internal const string EditorSetting = "FSUSBLOG_SITE_PAGE_EDITOR";
    private const string Unconfigured = "页面内容正在准备中，请稍后再试。";
    private static readonly string[] ReadMethods = [HttpMethods.Get, HttpMethods.Head];
    private static readonly UTF8Encoding Utf8 = new(false, true);
    private static readonly string[] Slugs = ["about", "privacy", "guidelines", "copyright"];

    private sealed record Page(AdminSitePageRevision Revision, AdminSitePageRevision EditorBaseline, long SiteConfigRevision, byte[] Html, byte[] Frame, bool Configured,
        EntityTagHeaderValue HtmlTag, EntityTagHeaderValue FrameTag, byte[] EnglishHtml, EntityTagHeaderValue EnglishHtmlTag);

    private readonly FrozenDictionary<string, Page> current;
    private readonly ConcurrentDictionary<string, Page> published = new(StringComparer.Ordinal);
    private readonly WebPages renderer;
    private readonly NpgsqlDataSource source;
    private readonly InstanceLease lease;
    private int liveConfiguredMask;

    internal int ConfiguredMask { get; }
    internal bool EditorEnabled { get; }

    internal IReadOnlyList<string> CurrentConfiguredPaths()
    {
        var mask = Volatile.Read(ref liveConfiguredMask);
        if (mask == 0) return [];
        var paths = new List<string>(Slugs.Length);
        for (var index = 0; index < Slugs.Length; index++)
            if ((mask & (1 << index)) != 0) paths.Add("/" + Slugs[index]);
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
            for (var index = 0; index < Slugs.Length; index++)
                if (string.Equals(Slugs[index], slug, StringComparison.OrdinalIgnoreCase))
                    mask |= 1 << index;
        }
        Volatile.Write(ref liveConfiguredMask, mask);
        return mask;
    }

    internal void MarkPublished(string slug)
    {
        for (var index = 0; index < Slugs.Length; index++)
            if (string.Equals(Slugs[index], slug, StringComparison.OrdinalIgnoreCase))
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
        var root = string.IsNullOrWhiteSpace(configuredRoot) ? null : CheckRoot(configuredRoot);
        using (var anchored = root is not null && NativeUnixFile.Supported ? NativeUnixFile.OpenDirectory(root) : null)
            current = Slugs.ToFrozenDictionary(slug => slug, slug =>
            {
                var markdown = root is null ? Unconfigured : Read(root, anchored, slug + ".md");
                var publicRevision = new AdminSitePageRevision(slug, 0, SitePagePublicationStore.Digest(markdown), markdown);
                var editorBaseline = root is null
                    ? new AdminSitePageRevision(slug, 0, SitePagePublicationStore.Digest(string.Empty), string.Empty)
                    : publicRevision;
                return Build(publicRevision, editorBaseline, root is not null);
            }, StringComparer.OrdinalIgnoreCase);
        for (var index = 0; index < Slugs.Length; index++)
            if (current[Slugs[index]].Configured) ConfiguredMask |= 1 << index;
        liveConfiguredMask = ConfiguredMask;
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
        if (!EditorEnabled) return ReadBaseline();
        await using var db = await source.OpenConnectionAsync(ct);
        await using var tx = await InstanceLease.BeginProtected(db, lease, ct);
        var revision = await SitePagePublicationStore.Read(db, tx, baseline.EditorBaseline, ct);
        await InstanceLease.CommitProtected(tx, lease, ct);
        if (revision.Revision == 0) return ReadBaseline();
        MarkPublished(revision.Slug);
        if (published.TryGetValue(revision.Slug, out var ready) &&
            ready.Revision.Revision == revision.Revision && ready.SiteConfigRevision == siteConfigRevision)
            return ready;
        var page = Build(revision, baseline.EditorBaseline, configured: true);
        published.AddOrUpdate(revision.Slug, page, (_, previous) =>
            previous.Revision.Revision > revision.Revision ||
            (previous.Revision.Revision == revision.Revision && previous.SiteConfigRevision > page.SiteConfigRevision)
                ? previous : page);
        return page;

        Page ReadBaseline()
        {
            if (baseline.SiteConfigRevision == siteConfigRevision) return baseline;
            var slug = baseline.Revision.Slug;
            if (published.TryGetValue(slug, out var cached) && cached.Revision.Revision == 0 && cached.SiteConfigRevision == siteConfigRevision)
                return cached;
            var refreshed = Build(baseline.Revision, baseline.EditorBaseline, baseline.Configured);
            published[slug] = refreshed;
            return refreshed;
        }
    }

    private Page Build(AdminSitePageRevision revision, AdminSitePageRevision editorBaseline, bool configured)
    {
        var slug = revision.Slug;
        var siteConfigRevision = renderer.SiteConfigRevision;
        var frame = SitePageWire.Encode(slug, revision.Markdown);
        var state = configured ? "published" : "unconfigured";
        var body = PublicArticleHtml.RenderMarkdown(revision.Markdown);
        byte[] HtmlFor(string locale)
        {
            var title = SiteLocale.Text(locale, "policy." + slug);
            var content = $"<article class=\"reading-column editorial-page article-body\" data-fsus-surface=\"reading\" data-site-page=\"{slug}\" data-state=\"{state}\"><header class=\"editorial-rule\"><h1>{HtmlEncoder.Default.Encode(title)}</h1></header>" +
                $"<div class=\"blog-markdown\" data-site-page-body lang=\"zh-CN\">{body}</div></article>";
            return renderer.PublicPage(content, title, noIndex: !configured, publicPath: "/" + slug, contentDriven: true, locale: locale);
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
