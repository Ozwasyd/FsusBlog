using System.Text.RegularExpressions;

namespace FsusBlog.V2.Server;

internal sealed record PageShellCapabilities(
    string PublicSearchMode = "auto",
    bool PluginPreview = false,
    bool DocumentExportTasks = false,
    bool PdfExport = false,
    bool PublicHotArticles = false,
    bool ArticleReadProof = false)
{
    internal static PageShellCapabilities From(SiteCapabilities capabilities) => new(
        PublicSearchMode: capabilities.PublicSearchMode,
        PluginPreview: capabilities.PluginPreview is not null,
        DocumentExportTasks: capabilities.DocumentExportTasks,
        PdfExport: capabilities.PdfExport is not null,
        PublicHotArticles: capabilities.PublicHotArticles,
        ArticleReadProof: capabilities.ArticleReadProof);
}

internal sealed partial class WebPages(string template, PublicSiteConfiguration? site = null, AppearanceAssets? appearance = null)
{
    internal const string ContentSlot = "<!--fsus-public-content-->";
    private const string HeadClose = "</head>";
    private const string DefaultTitleTag = "<title>Fsu's Blog</title>";
    private const string DefaultHtmlLangTag = "<html lang=\"en\">";
    private static readonly string[] ServerManagedMetaNames =
    [
        "fsus-public-search-mode",
        "fsus-author-plugin-preview",
        "fsus-document-export-tasks",
        "fsus-pdf-export",
        "fsus-public-hot-articles",
        "fsus-article-read-proof",
        "fsus-public-origin",
        "fsus-locale",
        "fsus-site-title"
    ];

    internal PublicSiteConfiguration? SiteConfig => site;
    internal long SiteConfigRevision => site?.Revision ?? 0;
    internal string SiteTitle => site?.Seo.Title ?? PublicSiteConfiguration.DefaultTitle;

    internal static string ResolveWebDist(IConfiguration configuration, IHostEnvironment environment)
    {
        var configuredDist = configuration["FSUSBLOG_WEB_DIST"];
        var dist = Path.GetFullPath(configuredDist ?? "src/Web/dist");
        if (string.IsNullOrEmpty(configuredDist) && environment.IsDevelopment() &&
            !File.Exists(Path.Combine(dist, "index.html")))
        {
            foreach (var candidate in new[] { "src/Web", "../Web/dist", "../Web" })
            {
                var resolved = Path.GetFullPath(candidate);
                if (File.Exists(Path.Combine(resolved, "index.html")))
                {
                    dist = resolved;
                    break;
                }
            }
        }
        return dist;
    }

    internal static async Task<string> LoadTemplateAsync(string dist, SiteCapabilities capabilities, CancellationToken ct = default)
    {
        var rawHtml = await File.ReadAllTextAsync(Path.Combine(dist, "index.html"), ct);
        return PrepareTemplate(rawHtml, PageShellCapabilities.From(capabilities));
    }

    internal static WebPages Create(string rawHtml, PageShellCapabilities capabilities,
        PublicSiteConfiguration? site = null, AppearanceAssets? appearance = null) =>
        new(PrepareTemplate(rawHtml, capabilities), site, appearance);

    internal static string PrepareTemplate(string rawHtml, PageShellCapabilities capabilities)
    {
        if (string.IsNullOrEmpty(rawHtml) || rawHtml.Contains('\0'))
            throw new InvalidOperationException("The v2 web build template is invalid.");

        var slotIndex = rawHtml.IndexOf(ContentSlot, StringComparison.Ordinal);
        if (slotIndex < 0)
            throw new InvalidOperationException("The v2 web build is missing the public content slot.");
        if (rawHtml.IndexOf(ContentSlot, slotIndex + ContentSlot.Length, StringComparison.Ordinal) >= 0)
            throw new InvalidOperationException("The v2 web build contains duplicate public content slots.");

        var headCloseIndex = rawHtml.IndexOf(HeadClose, StringComparison.Ordinal);
        if (headCloseIndex < 0)
            throw new InvalidOperationException("The v2 web build is missing a closing head tag.");
        if (rawHtml.IndexOf(HeadClose, headCloseIndex + HeadClose.Length, StringComparison.OrdinalIgnoreCase) >= 0)
            throw new InvalidOperationException("The v2 web build contains duplicate closing head tags.");
        if (headCloseIndex > slotIndex)
            throw new InvalidOperationException("The v2 web build has an invalid head/content slot order.");

        if (capabilities.PublicSearchMode is not ("auto" or "local" or "server"))
            throw new InvalidOperationException($"{SiteCapabilities.PublicSearchModeSetting} must be auto, local, or server.");

        var headSection = rawHtml[..headCloseIndex];
        var existingMetaNames = ReadHeadMetaNames(headSection);
        foreach (var managedName in ServerManagedMetaNames)
        {
            if (existingMetaNames.Contains(managedName))
                throw new InvalidOperationException($"The v2 web build template must not pre-define server marker '{managedName}'.");
        }
        if (headSection.Contains("/site-appearance/", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("The v2 web build template must not pre-define site appearance stylesheets.");

        var markers = new StringBuilder();
        if (capabilities.PublicSearchMode != "auto")
            markers.Append($"<meta name=\"fsus-public-search-mode\" content=\"{HtmlEncoder.Default.Encode(capabilities.PublicSearchMode)}\">");
        if (capabilities.PluginPreview)
            markers.Append(PluginPreviewEndpoints.Marker);
        if (capabilities.DocumentExportTasks)
            markers.Append(DocumentExportEndpoints.Marker);
        if (capabilities.PdfExport)
            markers.Append(PdfDocumentExport.PageMarker);
        if (capabilities.PublicHotArticles)
            markers.Append(PublicHotArticles.PageMarker);
        if (capabilities.ArticleReadProof)
            markers.Append(ArticleReadEndpoints.PageMarker);

        return markers.Length == 0
            ? rawHtml
            : string.Concat(rawHtml.AsSpan(0, headCloseIndex), markers.ToString(), rawHtml.AsSpan(headCloseIndex));
    }

    // Public renderers supply main content; private application shells still use Page/AdminPage.
    // data-fsus-public-content is the app-owned client capture boundary for site pages.
    internal byte[] PublicPage(string content = "", string? title = null, string? description = null,
        bool noIndex = false, string? publicPath = null, bool contentDriven = false, string locale = SiteLocale.Default)
    {
        var currentSeo = site?.Seo;
        var flow = contentDriven ? " data-content-flow=\"content-driven\"" : "";
        var searchLink = publicPath == "/search" ? "" : $"""<a href="/search">{SiteLocale.Html(locale, "nav.search")}</a>""";
        var shell = $"""
            <div class="public-initial">
            <a class="skip-link" href="#page-content">{SiteLocale.Html(locale, "nav.skip")}</a>
            <header class="public-initial-header"><div class="public-initial-bar">
            <div class="public-initial-brand-nav"><a class="public-initial-brand" href="/">{RenderBrandHtml(currentSeo)}</a>
            <nav aria-label="{SiteLocale.Html(locale, "nav.primary")}">{PublicNavigation.Render(publicPath, locale)}</nav></div>
            <div class="public-initial-actions">{searchLink}<a href="/login">{SiteLocale.Html(locale, "nav.login")}</a>{SiteLocale.Selector(locale)}</div>
            </div></header><main id="page-content" tabindex="-1" data-fsus-public-content{flow}>{content}</main></div>
            """;
        return RenderPage(shell, title, description, locale, noIndex, publicPath, useAppearance: true, locale: locale, publicOrigin: null, currentSeo: currentSeo);
    }

    private static string RenderBrandHtml(Contracts.SiteSeo? seo)
    {
        var encoder = HtmlEncoder.Default;
        var title = encoder.Encode(seo?.Title ?? PublicSiteConfiguration.DefaultTitle);
        var logo = seo?.SiteLogoUrl ?? "";
        var wordmark = seo?.SiteWordmarkUrl ?? "";
        if (wordmark.Length > 0)
        {
            var logoTag = logo.Length > 0
                ? $"<img class=\"site-brand-logo\" src=\"{encoder.Encode(logo)}\" alt=\"\" aria-hidden=\"true\" referrerpolicy=\"no-referrer\">"
                : "";
            return $"{logoTag}<img class=\"site-brand-wordmark\" src=\"{encoder.Encode(wordmark)}\" alt=\"{title}\" referrerpolicy=\"no-referrer\">";
        }
        if (logo.Length > 0)
            return $"<img class=\"site-brand-logo\" src=\"{encoder.Encode(logo)}\" alt=\"\" aria-hidden=\"true\" referrerpolicy=\"no-referrer\"><span>{title}</span>";
        return title;
    }

    internal byte[] PublicListingPage(string titleKey, string locale, string path) => PublicPage(
        $"<section class=\"reading-column editorial-page\"><h1 class=\"editorial-rule\">{SiteLocale.Html(locale, titleKey)}</h1>" +
        (path == "/archive" ? $"<p role=\"status\">{SiteLocale.Html(locale, "page.loadingArticles")}</p>" : "") + "</section>",
        title: SiteLocale.Text(locale, titleKey), noIndex: path == "/search", publicPath: path, locale: locale);

    // Anonymous first paint only. Vue owns capability checks and all credential controls.
    internal byte[] SiteLoginPage(string locale = SiteLocale.Default) => SiteAuthPage(locale, "page.login", "login.subtitle");

    internal byte[] ReaderRegistrationPage(string locale = SiteLocale.Default) => SiteAuthPage(locale, "page.register", "readerRegistration.subtitle");

    // Admin and authoring surfaces opt out of public appearance stylesheets and carry optional canonical public origin.
    internal byte[] AdminPage(string? publicOrigin = null) =>
        RenderPage(content: "", title: null, description: null, language: null, noIndex: true,
            publicPath: null, useAppearance: false, locale: null, publicOrigin: publicOrigin);

    internal byte[] Page(string content = "", string? title = null, string? description = null, string? language = null,
        bool noIndex = false, string? publicPath = null, bool useAppearance = true, string? locale = null) =>
        RenderPage(content, title, description, language, noIndex, publicPath, useAppearance, locale, publicOrigin: null);

    private byte[] SiteAuthPage(string locale, string title, string subtitle) => RenderPage($"""
        <header class="site-auth-header"><div class="site-auth-bar">
        <a class="site-auth-brand" href="/">{HtmlEncoder.Default.Encode(SiteTitle)}</a><div class="site-auth-actions">{SiteLocale.Selector(locale)}</div>
        </div></header>
        <main class="auth-page site-auth-main"><div class="auth-heading">
        <h1>{SiteLocale.Html(locale, title)}</h1><p>{SiteLocale.Html(locale, subtitle)}</p></div>
        <noscript>{SiteLocale.Html(locale, "login.noScript")}</noscript></main>
        """, title: SiteLocale.Text(locale, title), description: null, language: locale, noIndex: true,
        publicPath: null, useAppearance: true, locale: locale, publicOrigin: null);

    private byte[] RenderPage(string content, string? title, string? description, string? language,
        bool noIndex, string? publicPath, bool useAppearance, string? locale, string? publicOrigin, Contracts.SiteSeo? currentSeo = null)
    {
        var seo = currentSeo ?? site?.Seo;
        var currentTitle = seo?.Title ?? PublicSiteConfiguration.DefaultTitle;
        var encoder = HtmlEncoder.Default;
        var document = template;
        var titleText = title is null ? currentTitle : $"{title} · {currentTitle}";
        document = ReplaceFirst(document, DefaultTitleTag, $"<title>{encoder.Encode(titleText)}</title>");
        if (language is not null)
            document = ReplaceFirst(document, DefaultHtmlLangTag, $"<html lang=\"{encoder.Encode(language)}\">");

        var headCloseIndex = document.IndexOf(HeadClose, StringComparison.Ordinal);
        if (headCloseIndex >= 0)
        {
            var headSection = document[..headCloseIndex];
            var existingMetaNames = ReadHeadMetaNames(headSection);
            var head = new StringBuilder();

            if (useAppearance && appearance?.StylesheetLink is { } stylesheetLink &&
                !headSection.Contains(stylesheetLink, StringComparison.Ordinal))
                head.Append(stylesheetLink);

            if (locale is not null && existingMetaNames.Add("fsus-locale"))
                head.Append($"<meta name=\"fsus-locale\" content=\"{encoder.Encode(locale)}\">");

            var canonical = publicPath is not null && !noIndex && site?.Origin is { } origin ? origin + publicPath : null;
            if (publicPath is not null && !noIndex)
                description = string.IsNullOrWhiteSpace(description) ? seo?.Description : description;
            if (!string.IsNullOrWhiteSpace(description) && existingMetaNames.Add("description"))
                head.Append($"<meta name=\"description\" content=\"{encoder.Encode(description)}\">");

            if (noIndex && existingMetaNames.Add("robots"))
                head.Append("<meta name=\"robots\" content=\"noindex, follow\">");

            if (canonical is not null)
            {
                head.Append($"""
                    <link rel="canonical" href="{encoder.Encode(canonical)}">
                    <link rel="alternate" type="application/rss+xml" title="RSS" href="{DistributionSnapshot.RssPath}">
                    <link rel="alternate" type="application/atom+xml" title="Atom" href="{DistributionSnapshot.AtomPath}">
                    <link rel="alternate" type="application/feed+json" title="JSON Feed" href="{DistributionSnapshot.JsonPath}">
                    """).Append('\n');
            }

            if (site is not null && seo is not null)
            {
                if (existingMetaNames.Add("fsus-site-title"))
                    head.Append($"<meta name=\"fsus-site-title\" content=\"{encoder.Encode(currentTitle)}\">");
                if (publicPath is not null && !noIndex)
                {
                    head.Append($"<link rel=\"manifest\" href=\"{PublicSiteConfiguration.ManifestPath}\">");
                    Meta("author", seo.Author);
                    Meta("theme-color", seo.ThemeColor);
                    Meta("og:image", seo.OgImage, "property");
                    Link("icon", seo.FaviconSvgUrl, "image/svg+xml");
                    Link("icon", seo.FaviconIcoUrl, "image/x-icon");
                    Link("icon", seo.FaviconPngUrl, "image/png");
                    Link("apple-touch-icon", seo.AppleTouchIconUrl, null);
                }

                void Meta(string name, string value, string attribute = "name")
                {
                    if (value.Length > 0) head.Append($"<meta {attribute}=\"{name}\" content=\"{encoder.Encode(value)}\">");
                }

                void Link(string relation, string url, string? type)
                {
                    if (url.Length == 0) return;
                    var typed = type is null ? "" : $" type=\"{type}\"";
                    head.Append($"<link rel=\"{relation}\"{typed} href=\"{encoder.Encode(url)}\">");
                }
            }

            if (!string.IsNullOrWhiteSpace(publicOrigin))
            {
                if (publicOrigin.Contains('\0'))
                    throw new InvalidOperationException("Public origin contains an invalid character.");
                if (existingMetaNames.Add("fsus-public-origin"))
                    head.Append($"<meta name=\"fsus-public-origin\" content=\"{encoder.Encode(publicOrigin)}\">");
            }

            if (head.Length > 0)
                document = string.Concat(document.AsSpan(0, headCloseIndex), head.ToString(), document.AsSpan(headCloseIndex));
        }

        document = ReplaceFirst(document, ContentSlot, content);
        return Encoding.UTF8.GetBytes(document);
    }

    private static string ReplaceFirst(string text, string search, string replacement)
    {
        var index = text.IndexOf(search, StringComparison.Ordinal);
        return index < 0
            ? text
            : string.Concat(text.AsSpan(0, index), replacement, text.AsSpan(index + search.Length));
    }

    private static HashSet<string> ReadHeadMetaNames(string headSection)
    {
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (Match match in MetaNameRegex().Matches(headSection))
        {
            var value = match.Groups[1].Success ? match.Groups[1].Value
                : match.Groups[2].Success ? match.Groups[2].Value
                : match.Groups[3].Value;
            if (value.Length > 0) names.Add(value);
        }
        return names;
    }

    [GeneratedRegex(@"<meta\b[^>]*\bname\s*=\s*(?:""([^""]*)""|'([^']*)'|([^\s>]+))", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex MetaNameRegex();
}
