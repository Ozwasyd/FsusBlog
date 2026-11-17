using System.Collections.Concurrent;
using System.Collections.Frozen;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
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

    private sealed record Page(AdminSitePageRevision Revision, byte[] Html, byte[] Frame, bool Configured,
        EntityTagHeaderValue HtmlTag, EntityTagHeaderValue FrameTag);

    private readonly FrozenDictionary<string, Page> current;
    private readonly ConcurrentDictionary<string, Page> published = new(StringComparer.Ordinal);
    private readonly WebPages renderer;
    private readonly NpgsqlDataSource source;
    private readonly InstanceLease lease;
    internal IReadOnlyList<string> ConfiguredPaths { get; }

    internal int ConfiguredMask { get; }
    internal bool EditorEnabled { get; }

    private Page Find(string slug, bool configured = false)
    {
        if (slug.Length > WireLayouts.PageContentSlugBytes || !slug.All(char.IsAsciiLetter) ||
            !current.TryGetValue(slug, out var page) || (configured && !page.Configured))
            throw new BusinessException(Rejection.NotFound, "Site page not found.");
        return page;
    }

    internal async Task<byte[]> ConfiguredFrame(NpgsqlConnection db, NpgsqlTransaction tx, string slug, CancellationToken ct)
    {
        var baseline = Find(slug, configured: true);
        if (!EditorEnabled) return baseline.Frame;
        var revision = await SitePagePublicationStore.Read(db, tx, baseline.Revision, ct);
        return revision.Revision == 0 ? baseline.Frame : SitePageWire.Encode(revision.Slug, revision.Markdown);
    }

    internal AdminSitePageRevision EditorBaseline(string slug)
    {
        if (!EditorEnabled) throw new BusinessException(Rejection.NotFound, "The site page editor is unavailable.");
        return Find(slug, configured: true).Revision;
    }

    internal SitePages(IConfiguration configuration, WebPages renderer, NpgsqlDataSource source, InstanceLease lease, bool editorEnabled)
    {
        this.renderer = renderer;
        this.source = source;
        this.lease = lease;
        EditorEnabled = editorEnabled;
        var configuredRoot = configuration["FSUSBLOG_SITE_PAGES"];
        if (string.IsNullOrWhiteSpace(configuredRoot))
        {
            if (EditorEnabled) throw new InvalidOperationException("The site page editor requires the four deployment baseline files.");
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
        ConfiguredPaths = Definitions.Where(spec => current[spec.Slug].Configured)
            .Select(spec => "/" + spec.Slug).ToArray();

        FrozenDictionary<string, Page> BuildPages(string? root, SafeFileHandle? anchored) => Definitions.ToFrozenDictionary(
            spec => spec.Slug,
            spec =>
            {
                var markdown = root is null ? Unconfigured : Read(root, anchored, spec.Slug + ".md");
                return Build(spec, new(spec.Slug, 0, SitePagePublicationStore.Digest(markdown), markdown), root is not null);
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
                return Results.Bytes(page.Html, Html, entityTag: page.HtmlTag);
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
        if (!EditorEnabled) return baseline;
        await using var db = await source.OpenConnectionAsync(ct);
        await using var tx = await InstanceLease.BeginProtected(db, lease, ct);
        var revision = await SitePagePublicationStore.Read(db, tx, baseline.Revision, ct);
        await InstanceLease.CommitProtected(tx, lease, ct);
        if (revision.Revision == 0) return baseline;
        if (published.TryGetValue(revision.Slug, out var ready) && ready.Revision.Revision == revision.Revision)
            return ready;
        var page = Build(Definitions.Single(spec => spec.Slug == revision.Slug), revision, configured: true);
        published.AddOrUpdate(revision.Slug, page, (_, previous) => previous.Revision.Revision > revision.Revision ? previous : page);
        return page;
    }

    private Page Build((string Slug, string Title) spec, AdminSitePageRevision revision, bool configured)
    {
        var frame = SitePageWire.Encode(spec.Slug, revision.Markdown);
        var title = HtmlEncoder.Default.Encode(spec.Title);
        var state = configured ? "published" : "unconfigured";
        var content = $"<main><article data-site-page=\"{spec.Slug}\" data-state=\"{state}\"><header><h1>{title}</h1></header>" +
            $"<div data-site-page-body>{PublicArticleHtml.RenderMarkdown(revision.Markdown)}</div></article></main>";
        var html = renderer.Page(content, spec.Title, language: "zh-CN", noIndex: !configured, publicPath: "/" + spec.Slug);
        return new(revision, html, frame, configured, StrongTag(html), StrongTag(frame));
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
