using System.Collections.Frozen;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Encodings.Web;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using Microsoft.Win32.SafeHandles;

namespace FsusBlog.V2.Server.Content;

internal sealed class SitePages
{
    private const string Html = "text/html; charset=utf-8";
    private const string Unconfigured = "页面内容正在准备中，请稍后再试。";
    private static readonly string[] ReadMethods = [HttpMethods.Get, HttpMethods.Head];
    private static readonly UTF8Encoding Utf8 = new(false, true);
    private static readonly (string Slug, string Title)[] Definitions =
        [("about", "关于"), ("privacy", "隐私政策"), ("guidelines", "用户守则"), ("copyright", "版权声明")];

    private sealed record Page(byte[] Html, byte[] Frame, bool Configured);

    private readonly FrozenDictionary<string, Page> current;
    internal IReadOnlyList<string> ConfiguredPaths { get; }

    internal int ConfiguredMask { get; }

    internal byte[] ConfiguredPage(string slug)
    {
        if (slug.Length > WireLayouts.PageContentSlugBytes || !slug.All(char.IsAsciiLetter) ||
            !current.TryGetValue(slug, out var page) || !page.Configured)
            throw new BusinessException(Rejection.NotFound, "Site page not found.");
        return page.Frame;
    }

    internal SitePages(IConfiguration configuration, WebPages renderer)
    {
        var configuredRoot = configuration["FSUSBLOG_SITE_PAGES"];
        var root = string.IsNullOrWhiteSpace(configuredRoot) ? null : CheckRoot(configuredRoot);
        current = Definitions.ToFrozenDictionary(spec => spec.Slug,
            spec => Build(spec, root, renderer), StringComparer.OrdinalIgnoreCase);
        for (var index = 0; index < Definitions.Length; index++)
            if (current[Definitions[index].Slug].Configured) ConfiguredMask |= 1 << index;
        ConfiguredPaths = Definitions.Where(spec => current[spec.Slug].Configured)
            .Select(spec => "/" + spec.Slug).ToArray();
    }

    internal void Map(WebApplication app)
    {
        foreach (var (slug, page) in current)
        {
            app.MapMethods("/" + slug, ReadMethods, (HttpContext context) =>
            {
                SetHeaders(context, page);
                return Results.Bytes(page.Html, Html);
            });
        }

        app.MapMethods(WireRoutes.PublicSitePage, ReadMethods, (HttpContext context, string slug) =>
        {
            if (slug.Length > WireLayouts.PageContentSlugBytes || !slug.All(char.IsAsciiLetter) ||
                !current.TryGetValue(slug, out var page))
                throw new BusinessException(Rejection.NotFound, "Site page not found.");
            SetHeaders(context, page);
            return Results.Bytes(page.Frame, Aeds.ContentType);
        });
    }

    private static Page Build((string Slug, string Title) spec, string? root, WebPages renderer)
    {
        var markdown = root is null ? Unconfigured : Read(Path.Combine(root, spec.Slug + ".md"));
        var title = HtmlEncoder.Default.Encode(spec.Title);
        var state = root is null ? "unconfigured" : "published";
        var content = $"<main><article data-site-page=\"{spec.Slug}\" data-state=\"{state}\"><header><h1>{title}</h1></header>" +
            $"<div data-site-page-body>{PublicArticleHtml.RenderMarkdown(markdown)}</div></article></main>";
        return new(renderer.Page(content, spec.Title, language: "zh-CN", noIndex: root is null, publicPath: "/" + spec.Slug),
            SitePageWire.Encode(spec.Slug, markdown), root is not null);
    }

    private static void SetHeaders(HttpContext context, Page page)
    {
        context.Response.Headers.CacheControl = "no-store";
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

    private static string Read(string path)
    {
        if ((File.GetAttributes(path) & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0)
            throw new InvalidOperationException("Site page inputs must be regular files within the release directory.");
        using var contents = OpenInput(path);
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

    private static FileStream OpenInput(string path)
    {
        // O_NONBLOCK avoids waiting on a special file. O_NOFOLLOW checks the final name at open.
        const int macOpen = 0x1000000 | 0x100 | 0x4; // O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK
        const int linuxOpen = 0x80000 | 0x20000 | 0x800;
        var flags = OperatingSystem.IsMacOS() ? macOpen : OperatingSystem.IsLinux() ? linuxOpen : 0;
        if (flags == 0) return File.OpenRead(path);
        var descriptor = OpenNative(path, flags);
        if (descriptor < 0) throw new IOException("Could not open a site page input.", Marshal.GetLastPInvokeError());
        var handle = new SafeFileHandle(descriptor, ownsHandle: true);
        try { return new FileStream(handle, FileAccess.Read); }
        catch { handle.Dispose(); throw; }
    }

    [DllImport("libc", EntryPoint = "open", SetLastError = true)]
    private static extern int OpenNative([MarshalAs(UnmanagedType.LPUTF8Str)] string path, int flags);
}
