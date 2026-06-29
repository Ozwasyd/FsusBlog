using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Spa;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace FsusBlog.Server.Infrastructure.PublicAot;

internal sealed record class PublicAotDocumentModel(
    PublicPageKind Kind,
    string RawTemplate,
    string PreparedTemplate,
    string Title,
    string SiteTitle,
    string Description,
    string CanonicalUrl,
    string ShellHtml,
    string BootstrapPayload,
    string HydrationPropsPayload,
    string IslandsPayload,
    string SpaEntryScript,
    string HeadLinks)
{
    public FullAppTakeoverAssetSet FullAppTakeover { get; init; } = FullAppTakeoverAssetSet.Empty;

    public PublicAotArticleSeoMetadata? ArticleSeo { get; init; }
}

internal sealed record class PublicAotArticleSeoMetadata(
    string Headline,
    string Description,
    string Url,
    DateTime? DatePublished,
    DateTime? DateModified,
    string AuthorName,
    string ImageUrl,
    string PublisherName,
    string PublisherLogoUrl);

// Design reference: docs/api/design.md "AOT sentinel 与 data-fsus-aot-head".
internal static class PublicAotDocumentComposer
{
    private const string StableSpaEntryAlias = "/assets/fsus-spa-entry.js";
    private const string AotHeadStartSentinel = "<!--fsus:aot:head-start-->";
    private const string AotHeadEndSentinel = "<!--fsus:aot:head-end-->";
    private const string AotAppSentinel = "<!--fsus:aot:app-->";
    private const string AotPayloadsSentinel = "<!--fsus:aot:payloads-->";
    private const string AotSpaBootSentinel = "<!--fsus:aot:spa-boot-->";
    private static readonly Regex BodyTagRegex = new(
        "<body\\b(?<attrs>[^>]*)>",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);

    internal static string BuildSeoHeadTags(
        PublicPageKind kind,
        string title,
        string siteTitle,
        string description,
        string canonicalUrl,
        PublicAotArticleSeoMetadata? articleSeo = null)
    {
        string ogType = kind == PublicPageKind.ArticleDetail ? "article" : "website";
        string fullTitle = string.IsNullOrWhiteSpace(siteTitle) ? title : $"{title} - {siteTitle}";
        string siteRoot = ResolveSiteRoot(canonicalUrl);
        string jsonLd = BuildJsonLd(kind, title, fullTitle, siteTitle, description, canonicalUrl, siteRoot, articleSeo);
        return $"""
<meta name="description" content="{Encode(description)}" data-fsus-aot-head />
<meta property="og:title" content="{Encode(fullTitle)}" data-fsus-aot-head />
<meta property="og:description" content="{Encode(description)}" data-fsus-aot-head />
<meta property="og:type" content="{Encode(ogType)}" data-fsus-aot-head />
<meta property="og:url" content="{Encode(canonicalUrl)}" data-fsus-aot-head />
<meta name="twitter:card" content="summary_large_image" data-fsus-aot-head />
<meta name="twitter:title" content="{Encode(fullTitle)}" data-fsus-aot-head />
<meta name="twitter:description" content="{Encode(description)}" data-fsus-aot-head />
<link rel="canonical" href="{Encode(canonicalUrl)}" data-fsus-aot-head />
<link rel="alternate" type="application/rss+xml" title="{Encode(siteTitle)} RSS" href="/feed/rss.xml" data-fsus-aot-head />
<link rel="alternate" type="application/atom+xml" title="{Encode(siteTitle)} Atom" href="/feed/atom.xml" data-fsus-aot-head />
<link rel="alternate" type="application/feed+json" title="{Encode(siteTitle)} JSON Feed" href="/feed/feed.json" data-fsus-aot-head />
<script type="application/ld+json" data-fsus-aot-head>{jsonLd}</script>
""";
    }

    private static string BuildJsonLd(
        PublicPageKind kind,
        string title,
        string fullTitle,
        string siteTitle,
        string description,
        string canonicalUrl,
        string siteRoot,
        PublicAotArticleSeoMetadata? articleSeo)
    {
        using var buffer = new PooledByteBufferWriter(1024);
        using (var writer = new Utf8JsonWriter(buffer, new JsonWriterOptions { Encoder = JavaScriptEncoder.Default }))
        {
            writer.WriteStartObject();
            writer.WriteString("@context", "https://schema.org");
            writer.WritePropertyName("@graph");
            writer.WriteStartArray();
            WriteSiteJsonLd(writer, siteTitle, siteRoot);
            WriteBreadcrumbJsonLd(writer, kind, fullTitle, canonicalUrl, siteRoot);
            if (kind == PublicPageKind.ArticleDetail)
            {
                WriteBlogPostingJsonLd(writer, title, fullTitle, description, canonicalUrl, siteRoot, siteTitle, articleSeo);
            }
            else
            {
                WritePageJsonLd(writer, fullTitle, description, canonicalUrl);
            }

            writer.WriteEndArray();
            writer.WriteEndObject();
        }

        return Encoding.UTF8.GetString(buffer.WrittenSpan);
    }

    private static void WriteSiteJsonLd(Utf8JsonWriter writer, string siteTitle, string siteRoot)
    {
        writer.WriteStartObject();
        writer.WriteString("@type", "WebSite");
        writer.WriteString("name", siteTitle);
        writer.WriteString("url", siteRoot);
        writer.WritePropertyName("potentialAction");
        writer.WriteStartObject();
        writer.WriteString("@type", "SearchAction");
        writer.WriteString("target", $"{siteRoot.TrimEnd('/')}/search?q={{search_term_string}}");
        writer.WriteString("query-input", "required name=search_term_string");
        writer.WriteEndObject();
        writer.WriteEndObject();
    }

    private static void WriteBreadcrumbJsonLd(
        Utf8JsonWriter writer,
        PublicPageKind kind,
        string fullTitle,
        string canonicalUrl,
        string siteRoot)
    {
        writer.WriteStartObject();
        writer.WriteString("@type", "BreadcrumbList");
        writer.WritePropertyName("itemListElement");
        writer.WriteStartArray();
        writer.WriteStartObject();
        writer.WriteString("@type", "ListItem");
        writer.WriteNumber("position", 1);
        writer.WriteString("name", "Home");
        writer.WriteString("item", siteRoot);
        writer.WriteEndObject();

        if (kind != PublicPageKind.Home)
        {
            writer.WriteStartObject();
            writer.WriteString("@type", "ListItem");
            writer.WriteNumber("position", 2);
            writer.WriteString("name", fullTitle);
            writer.WriteString("item", canonicalUrl);
            writer.WriteEndObject();
        }

        writer.WriteEndArray();
        writer.WriteEndObject();
    }

    private static void WritePageJsonLd(Utf8JsonWriter writer, string fullTitle, string description, string canonicalUrl)
    {
        writer.WriteStartObject();
        writer.WriteString("@type", "WebSite");
        writer.WriteString("name", fullTitle);
        writer.WriteString("url", canonicalUrl);
        writer.WriteString("description", description);
        writer.WriteEndObject();
    }

    private static void WriteBlogPostingJsonLd(
        Utf8JsonWriter writer,
        string title,
        string fullTitle,
        string description,
        string canonicalUrl,
        string siteRoot,
        string siteTitle,
        PublicAotArticleSeoMetadata? articleSeo)
    {
        string headline = NullIfEmpty(articleSeo?.Headline) ?? title;
        string articleDescription = NullIfEmpty(articleSeo?.Description) ?? description;
        string articleUrl = NullIfEmpty(articleSeo?.Url) ?? canonicalUrl;
        string publisherName = NullIfEmpty(articleSeo?.PublisherName) ?? siteTitle;
        string publisherLogoUrl = MakeAbsoluteUrl(siteRoot, articleSeo?.PublisherLogoUrl ?? string.Empty);

        writer.WriteStartObject();
        writer.WriteString("@type", "BlogPosting");
        writer.WriteString("name", fullTitle);
        writer.WriteString("headline", headline);
        writer.WriteString("description", articleDescription);
        writer.WriteString("url", articleUrl);
        writer.WritePropertyName("mainEntityOfPage");
        writer.WriteStartObject();
        writer.WriteString("@type", "WebPage");
        writer.WriteString("@id", articleUrl);
        writer.WriteEndObject();

        if (articleSeo?.DatePublished is { } publishedAt)
        {
            writer.WriteString("datePublished", publishedAt.ToUniversalTime().ToString("O", System.Globalization.CultureInfo.InvariantCulture));
        }

        if (articleSeo?.DateModified is { } modifiedAt)
        {
            writer.WriteString("dateModified", modifiedAt.ToUniversalTime().ToString("O", System.Globalization.CultureInfo.InvariantCulture));
        }

        if (!string.IsNullOrWhiteSpace(articleSeo?.AuthorName))
        {
            writer.WritePropertyName("author");
            writer.WriteStartObject();
            writer.WriteString("@type", "Person");
            writer.WriteString("name", articleSeo.AuthorName.Trim());
            writer.WriteEndObject();
        }

        string imageUrl = MakeAbsoluteUrl(siteRoot, articleSeo?.ImageUrl ?? string.Empty);
        if (!string.IsNullOrWhiteSpace(imageUrl))
        {
            writer.WriteString("image", imageUrl);
        }

        if (!string.IsNullOrWhiteSpace(publisherName))
        {
            writer.WritePropertyName("publisher");
            writer.WriteStartObject();
            writer.WriteString("@type", "Organization");
            writer.WriteString("name", publisherName);
            if (!string.IsNullOrWhiteSpace(publisherLogoUrl))
            {
                writer.WritePropertyName("logo");
                writer.WriteStartObject();
                writer.WriteString("@type", "ImageObject");
                writer.WriteString("url", publisherLogoUrl);
                writer.WriteEndObject();
            }

            writer.WriteEndObject();
        }

        writer.WriteEndObject();
    }

    private static Dictionary<string, object?> BuildBreadcrumbJsonLd(
        PublicPageKind kind,
        string fullTitle,
        string canonicalUrl,
        string siteRoot)
    {
        var items = new List<Dictionary<string, object?>>(2)
        {
            new(StringComparer.Ordinal)
            {
                ["@type"] = "ListItem",
                ["position"] = 1,
                ["name"] = "Home",
                ["item"] = siteRoot
            }
        };

        if (kind != PublicPageKind.Home)
        {
            items.Add(new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["@type"] = "ListItem",
                ["position"] = 2,
                ["name"] = fullTitle,
                ["item"] = canonicalUrl
            });
        }

        return new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["@type"] = "BreadcrumbList",
            ["itemListElement"] = items
        };
    }

    private static Dictionary<string, object?> BuildBlogPostingJsonLd(
        string title,
        string fullTitle,
        string description,
        string canonicalUrl,
        string siteRoot,
        string siteTitle,
        PublicAotArticleSeoMetadata? articleSeo)
    {
        string headline = NullIfEmpty(articleSeo?.Headline) ?? title;
        string articleDescription = NullIfEmpty(articleSeo?.Description) ?? description;
        string articleUrl = NullIfEmpty(articleSeo?.Url) ?? canonicalUrl;
        string publisherName = NullIfEmpty(articleSeo?.PublisherName) ?? siteTitle;
        string publisherLogoUrl = MakeAbsoluteUrl(siteRoot, articleSeo?.PublisherLogoUrl ?? string.Empty);
        var node = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["@type"] = "BlogPosting",
            ["name"] = fullTitle,
            ["headline"] = headline,
            ["description"] = articleDescription,
            ["url"] = articleUrl,
            ["mainEntityOfPage"] = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["@type"] = "WebPage",
                ["@id"] = articleUrl
            }
        };

        if (articleSeo?.DatePublished is { } publishedAt)
        {
            node["datePublished"] = publishedAt.ToUniversalTime().ToString("O", System.Globalization.CultureInfo.InvariantCulture);
        }

        if (articleSeo?.DateModified is { } modifiedAt)
        {
            node["dateModified"] = modifiedAt.ToUniversalTime().ToString("O", System.Globalization.CultureInfo.InvariantCulture);
        }

        if (!string.IsNullOrWhiteSpace(articleSeo?.AuthorName))
        {
            node["author"] = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["@type"] = "Person",
                ["name"] = articleSeo.AuthorName.Trim()
            };
        }

        string imageUrl = MakeAbsoluteUrl(siteRoot, articleSeo?.ImageUrl ?? string.Empty);
        if (!string.IsNullOrWhiteSpace(imageUrl))
        {
            node["image"] = imageUrl;
        }

        if (!string.IsNullOrWhiteSpace(publisherName))
        {
            var publisher = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["@type"] = "Organization",
                ["name"] = publisherName
            };
            if (!string.IsNullOrWhiteSpace(publisherLogoUrl))
            {
                publisher["logo"] = new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["@type"] = "ImageObject",
                    ["url"] = publisherLogoUrl
                };
            }

            node["publisher"] = publisher;
        }

        return node;
    }

    private static string? NullIfEmpty(string? value)
        => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    private static string MakeAbsoluteUrl(string siteRoot, string value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return string.Empty;
        }

        string trimmed = value.Trim();
        if (Uri.TryCreate(trimmed, UriKind.Absolute, out Uri? absolute) &&
            (absolute.Scheme == Uri.UriSchemeHttp || absolute.Scheme == Uri.UriSchemeHttps))
        {
            return absolute.ToString();
        }

        if (!Uri.TryCreate(siteRoot, UriKind.Absolute, out Uri? root))
        {
            return trimmed;
        }

        return new Uri(root, trimmed.StartsWith("/", StringComparison.Ordinal) ? trimmed : "/" + trimmed).ToString();
    }

    private static string ResolveSiteRoot(string canonicalUrl)
    {
        if (Uri.TryCreate(canonicalUrl, UriKind.Absolute, out Uri? uri))
        {
            return uri.GetLeftPart(UriPartial.Authority) + "/";
        }

        return "/";
    }

    internal static string PreparePublicDocumentTemplate(string template)
    {
        string result = StripImmediateSpaEntryScript(template);
        result = StripModulePreloadLinks(result);
        return result;
    }

    internal static string ComposeDocument(PublicAotDocumentModel model)
    {
        ValidateSentinels(model.PreparedTemplate);

        string html = EnsureBodyAttributes(model.PreparedTemplate);
        html = ReplaceBetween(
            html,
            AotHeadStartSentinel,
            AotHeadEndSentinel,
            BuildAotManagedHead(model),
            "head");
        html = html.Replace(AotAppSentinel, model.ShellHtml, StringComparison.Ordinal);

        if (!string.IsNullOrWhiteSpace(model.HeadLinks))
        {
            html = InsertBeforeHeadClose(html, model.HeadLinks);
        }

        const string bodyClose = "</body>";
        string bootstrapScript = BuildBinaryPayloadScript("fsus-aot-bootstrap", model.BootstrapPayload);
        string hydrationScript = string.IsNullOrWhiteSpace(model.HydrationPropsPayload)
            ? string.Empty
            : BuildBinaryPayloadSidecarMarker("fsus-aot-hydration-props", model.HydrationPropsPayload);
        string deferredSpaBoot = BuildDeferredSpaBootScript(
            model.RawTemplate,
            model.SpaEntryScript,
            model.FullAppTakeover.ModulePreloads,
            model.FullAppTakeover.Stylesheets);

        string payloadScripts = string.Join(
            "\n    ",
            new[] { bootstrapScript, hydrationScript }.Where(static script => !string.IsNullOrWhiteSpace(script)));

        html = html.Replace(AotPayloadsSentinel, payloadScripts, StringComparison.Ordinal);
        html = html.Replace(AotSpaBootSentinel, deferredSpaBoot, StringComparison.Ordinal);

        return html.Contains(bodyClose, StringComparison.Ordinal)
            ? html
            : html + payloadScripts + deferredSpaBoot;
    }

    private static string BuildAotManagedHead(PublicAotDocumentModel model)
        => $"""
{BuildThemeBootstrapScript()}
    <title>{Encode(model.Title)}{BuildTitleSuffix(model.Title, model.SiteTitle)}</title>
    {BuildSeoHeadTags(model.Kind, model.Title, model.SiteTitle, model.Description, model.CanonicalUrl, model.ArticleSeo)}
""";

    private static void ValidateSentinels(string template)
    {
        RequireSentinel(template, AotHeadStartSentinel, "head-start");
        RequireSentinel(template, AotHeadEndSentinel, "head-end");
        RequireSentinel(template, AotAppSentinel, "app");
        RequireSentinel(template, AotPayloadsSentinel, "payloads");
        RequireSentinel(template, AotSpaBootSentinel, "spa-boot");
    }

    private static void RequireSentinel(string template, string sentinel, string name)
    {
        if (!template.Contains(sentinel, StringComparison.Ordinal))
        {
            throw new InvalidOperationException($"public_aot_template_sentinel_missing:{name}");
        }
    }

    private static string ReplaceBetween(string html, string startSentinel, string endSentinel, string replacement, string name)
    {
        int start = html.IndexOf(startSentinel, StringComparison.Ordinal);
        int end = html.IndexOf(endSentinel, start + startSentinel.Length, StringComparison.Ordinal);
        if (start < 0 || end < 0)
        {
            throw new InvalidOperationException($"public_aot_template_sentinel_missing:{name}");
        }

        int afterEnd = end + endSentinel.Length;
        return string.Concat(html.AsSpan(0, start), replacement, html.AsSpan(afterEnd));
    }

    private static string InsertBeforeHeadClose(string html, string content)
    {
        int index = html.IndexOf("</head>", StringComparison.OrdinalIgnoreCase);
        return index < 0
            ? string.Concat(html, "\n", content)
            : string.Concat(html.AsSpan(0, index), content, "\n  ", html.AsSpan(index));
    }

    private static string EnsureBodyAttributes(string html)
    {
        return BodyTagRegex.Replace(
            html,
            match =>
            {
                string attrs = match.Groups["attrs"].Value;
                return string.Concat(
                    "<body",
                    attrs,
                    HasAttribute(attrs, "data-fsusblog-public-first-paint") ? string.Empty : " data-fsusblog-public-first-paint=\"true\"",
                    HasAttribute(attrs, "data-fsusblog-public-shell") ? string.Empty : " data-fsusblog-public-shell=\"true\"",
                    ">");
            },
            1);
    }

    private static bool HasAttribute(string attrs, string attributeName)
    {
        ReadOnlySpan<char> source = attrs.AsSpan();
        ReadOnlySpan<char> name = attributeName.AsSpan();
        int searchStart = 0;
        while (searchStart < source.Length)
        {
            int relative = source[searchStart..].IndexOf(name, StringComparison.OrdinalIgnoreCase);
            if (relative < 0)
            {
                return false;
            }

            int start = searchStart + relative;
            int afterName = start + name.Length;
            bool validStart = start == 0 || !IsAttributeNameChar(source[start - 1]);
            if (validStart)
            {
                int cursor = afterName;
                while (cursor < source.Length && char.IsWhiteSpace(source[cursor]))
                {
                    cursor++;
                }

                if (cursor < source.Length && source[cursor] == '=')
                {
                    return true;
                }
            }

            searchStart = Math.Max(afterName, start + 1);
        }

        return false;
    }

    private static bool IsAttributeNameChar(char value)
        => char.IsLetterOrDigit(value) || value is '-' or '_' or ':' or '.';

    internal static string BuildThemeBootstrapScript() =>
        """
<script id="fsus-theme-bootstrap">
  (() => {
    window.__FSUSBLOG_CSP_NONCE__ = document.currentScript?.nonce || '';
    const root = document.documentElement;
    const readStoredMode = () => {
      try {
        const stored = window.localStorage.getItem('fsus:theme-mode');
        return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
      } catch {
        return 'system';
      }
    };
    const mode = readStoredMode();
    const resolved = mode === 'system'
      ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : mode;
    root.dataset.themeMode = mode;
    root.dataset.themeResolved = resolved;
    root.classList.toggle('dark', resolved === 'dark');
    root.classList.toggle('light', resolved === 'light');
  })();
</script>
""";

    internal static string BuildDeferredSpaBootScript(
        string template,
        string? entryScriptOverride = null,
        IReadOnlyList<string>? takeoverModulePreloads = null,
        IReadOnlyList<string>? takeoverStylesheets = null)
    {
        string templateEntryScriptSrc = TryExtractSpaEntryScriptSrc(template);
        string entryScriptSrc = ResolveDeferredSpaEntryScript(templateEntryScriptSrc, entryScriptOverride);
        if (string.IsNullOrWhiteSpace(entryScriptSrc))
        {
            return string.Empty;
        }

        string encodedSrc = JavaScriptEncoder.Default.Encode(entryScriptSrc);
        string encodedModulePreloads = BuildJavaScriptStringArray(takeoverModulePreloads);
        string encodedStylesheets = BuildJavaScriptStringArray(takeoverStylesheets);
        return $@"<script id=""fsus-spa-boot"" data-fsusblog-spa-entry=""{Encode(entryScriptSrc)}"">
  (() => {{
    const entrySrc = ""{encodedSrc}"";
    const takeoverModulePreloads = {encodedModulePreloads};
    const takeoverStylesheets = {encodedStylesheets};
    const mark = (name) => {{
      try {{
        if (window.performance && typeof window.performance.mark === 'function') {{
          window.performance.mark('fsus:start:' + name);
        }}
      }} catch {{
      }}
    }};

        const readBinaryPayloadText = (id) => {{
            const script = document.getElementById(id);
            const text = script?.textContent?.trim();
            return text && text.length > 0 ? text : null;
        }};

        window.__FSUS_PUBLIC_AOT_BOOTSTRAP_RAW__ = readBinaryPayloadText('fsus-aot-bootstrap');
        window.__FSUS_PUBLIC_HYDRATION_RAW__ = readBinaryPayloadText('fsus-aot-hydration-props');

    let preloadWarmed = false;
    let injectScheduled = false;
    let forcedInjectTimer = 0;

    const appendHeadLink = (selector, configure) => {{
      if (document.querySelector(selector)) {{
        return;
      }}

      const link = document.createElement('link');
      configure(link);
      (document.head || document.body).appendChild(link);
    }};

    const warmPreload = () => {{
      if (preloadWarmed) {{
        return;
      }}
      preloadWarmed = true;

      [entrySrc, ...takeoverModulePreloads].forEach((href) => {{
        if (!href) {{
          return;
        }}

        appendHeadLink('link[rel=""modulepreload""][href=""' + href + '""]', (preload) => {{
          preload.rel = 'modulepreload';
          preload.crossOrigin = 'anonymous';
          preload.href = href;
          preload.fetchPriority = 'low';
          preload.dataset.fsusblogSpaPreload = 'deferred';
        }});
      }});
      mark('server-spa-preload');
    }};

    const activateTakeoverStyles = () => {{
      takeoverStylesheets.forEach((href) => {{
        if (!href) {{
          return;
        }}

        appendHeadLink('link[rel=""stylesheet""][href=""' + href + '""]', (stylesheet) => {{
          stylesheet.rel = 'stylesheet';
          stylesheet.href = href;
          stylesheet.dataset.fsusblogSpaStyle = 'deferred';
        }});
      }});
    }};

    const loadSpaEntry = () => {{
      injectScheduled = false;
      if (document.querySelector('script[data-fsusblog-spa-entry][src=""' + entrySrc + '""]') ||
          document.querySelector('script[type=""module""][src=""' + entrySrc + '""]')) {{
        return;
      }}

      mark('server-spa-entry-injected');
      warmPreload();
      activateTakeoverStyles();
      const script = document.createElement('script');
      script.type = 'module';
      script.crossOrigin = 'anonymous';
      script.src = entrySrc;
      script.dataset.fsusblogSpaEntry = 'deferred';
      document.body.appendChild(script);
    }};

    const scheduleInject = () => {{
      if (injectScheduled) {{
        return;
      }}
      injectScheduled = true;

      if ('requestIdleCallback' in window) {{
        window.requestIdleCallback((deadline) => {{
          if (!deadline.didTimeout && deadline.timeRemaining() < 8) {{
            window.setTimeout(loadSpaEntry, 96);
            return;
          }}
          loadSpaEntry();
        }}, {{ timeout: 1200 }});
        return;
      }}

      window.setTimeout(loadSpaEntry, 96);
    }};

    const scheduleForcedInject = () => {{
      if (forcedInjectTimer) {{
        return;
      }}

      forcedInjectTimer = window.setTimeout(() => {{
        warmPreload();
        loadSpaEntry();
      }}, 1800);
    }};

    const onIntent = () => {{
      warmPreload();
      scheduleInject();
    }};

    window.addEventListener('pointerdown', onIntent, {{ once: true, passive: true }});
    window.addEventListener('touchstart', onIntent, {{ once: true, passive: true }});
    window.addEventListener('keydown', onIntent, {{ once: true }});
    window.addEventListener('scroll', onIntent, {{ once: true, passive: true }});

    const kickoff = () => {{
      window.requestAnimationFrame(() => {{
        scheduleInject();
        scheduleForcedInject();
      }});
    }};

    if (document.readyState === 'interactive' || document.readyState === 'complete') {{
      kickoff();
      return;
    }}

    document.addEventListener('DOMContentLoaded', kickoff, {{ once: true }});
  }})();
</script>";
    }

    internal static string EnsureShellRoot(string html, PublicPageKind kind)
    {
        if (html.Contains("id=\"fsus-aot-shell\"", StringComparison.Ordinal))
        {
            return EnsureHydrationKindAttribute(html, kind);
        }

        string hydrationKind = ResolveHydrationKind(kind);
        string hydrationAttribute = string.IsNullOrWhiteSpace(hydrationKind)
            ? string.Empty
            : $" data-public-hydration-kind=\"{Encode(hydrationKind)}\"";

        return $"""
<div id="fsus-aot-shell" data-aot-page="{Encode(kind.ToString())}"{hydrationAttribute} class="fsus-aot-shell">
{html}
</div>
""";
    }

    internal static string EnsureHydrationKindAttribute(string html, PublicPageKind kind)
    {
        string hydrationKind = ResolveHydrationKind(kind);
        if (string.IsNullOrWhiteSpace(hydrationKind) ||
            html.Contains("data-public-hydration-kind=", StringComparison.OrdinalIgnoreCase))
        {
            return html;
        }

        const string marker = "id=\"fsus-aot-shell\"";
        int markerIndex = html.IndexOf(marker, StringComparison.Ordinal);
        if (markerIndex < 0)
        {
            return html;
        }

        int insertIndex = markerIndex + marker.Length;
        return html.Insert(insertIndex, $" data-public-hydration-kind=\"{Encode(hydrationKind)}\"");
    }

    internal static string ResolveHydrationKind(PublicPageKind kind)
        => PublicAotPageCatalog.TryGet(kind, out PublicAotPageDescriptor? descriptor)
            ? descriptor.HydrationKind
            : string.Empty;

    internal static string ExtractAttributeValue(string tag, string attributeName)
    {
        string doubleQuotedToken = $"{attributeName}=\"";
        int attrIndex = tag.IndexOf(doubleQuotedToken, StringComparison.OrdinalIgnoreCase);
        if (attrIndex >= 0)
        {
            int start = attrIndex + doubleQuotedToken.Length;
            int end = tag.IndexOf('"', start);
            return end > start ? tag[start..end] : string.Empty;
        }

        string singleQuotedToken = $"{attributeName}='";
        attrIndex = tag.IndexOf(singleQuotedToken, StringComparison.OrdinalIgnoreCase);
        if (attrIndex < 0)
        {
            return string.Empty;
        }

        int valueStart = attrIndex + singleQuotedToken.Length;
        int valueEnd = tag.IndexOf('\'', valueStart);
        return valueEnd > valueStart ? tag[valueStart..valueEnd] : string.Empty;
    }

    private static string StripImmediateSpaEntryScript(string template)
    {
        int scriptIndex = template.IndexOf("<script", StringComparison.OrdinalIgnoreCase);
        while (scriptIndex >= 0)
        {
            int scriptEnd = template.IndexOf("</script>", scriptIndex, StringComparison.OrdinalIgnoreCase);
            if (scriptEnd < 0)
            {
                break;
            }

            int closeEnd = scriptEnd + "</script>".Length;
            string scriptTag = template[scriptIndex..closeEnd];
            bool isModuleScript = scriptTag.Contains("type=\"module\"", StringComparison.OrdinalIgnoreCase);
            string src = ExtractAttributeValue(scriptTag, "src");

            if (isModuleScript && IsImmediateTemplateModuleScriptSrc(src))
            {
                template = template.Remove(scriptIndex, closeEnd - scriptIndex);
                scriptIndex = template.IndexOf("<script", scriptIndex, StringComparison.OrdinalIgnoreCase);
                continue;
            }

            scriptIndex = template.IndexOf("<script", closeEnd, StringComparison.OrdinalIgnoreCase);
        }

        return template;
    }

    private static string StripModulePreloadLinks(string template)
    {
        const string marker = "<link";
        int linkIndex = template.IndexOf(marker, StringComparison.OrdinalIgnoreCase);
        while (linkIndex >= 0)
        {
            int linkEnd = template.IndexOf('>', linkIndex);
            if (linkEnd < 0)
            {
                break;
            }

            string linkTag = template.Substring(linkIndex, linkEnd - linkIndex + 1);
            bool isModulePreload = linkTag.Contains("rel=\"modulepreload\"", StringComparison.OrdinalIgnoreCase)
                || linkTag.Contains("rel='modulepreload'", StringComparison.OrdinalIgnoreCase);
            if (isModulePreload)
            {
                template = template.Remove(linkIndex, linkEnd - linkIndex + 1);
                linkIndex = template.IndexOf(marker, linkIndex, StringComparison.OrdinalIgnoreCase);
                continue;
            }

            linkIndex = template.IndexOf(marker, linkEnd + 1, StringComparison.OrdinalIgnoreCase);
        }

        return template;
    }

    private static string TryExtractSpaEntryScriptSrc(string template)
    {
        int scriptIndex = template.IndexOf("<script", StringComparison.OrdinalIgnoreCase);
        while (scriptIndex >= 0)
        {
            int scriptEnd = template.IndexOf("</script>", scriptIndex, StringComparison.OrdinalIgnoreCase);
            if (scriptEnd < 0)
            {
                break;
            }

            int closeEnd = scriptEnd + "</script>".Length;
            string scriptTag = template[scriptIndex..closeEnd];
            if (scriptTag.Contains("type=\"module\"", StringComparison.OrdinalIgnoreCase))
            {
                string src = ExtractAttributeValue(scriptTag, "src");
                if (IsSpaEntryScriptSrc(src))
                {
                    if (IsViteProductionEntryScriptSrc(src))
                    {
                        return StableSpaEntryAlias;
                    }

                    return src;
                }
            }

            scriptIndex = template.IndexOf("<script", closeEnd, StringComparison.OrdinalIgnoreCase);
        }

        return string.Empty;
    }

    private static string ResolveDeferredSpaEntryScript(string templateEntryScriptSrc, string? entryScriptOverride)
    {
        if (IsDevelopmentSourceEntryScriptSrc(templateEntryScriptSrc))
        {
            return templateEntryScriptSrc;
        }

        return string.IsNullOrWhiteSpace(entryScriptOverride)
            ? templateEntryScriptSrc
            : entryScriptOverride;
    }

    private static bool IsImmediateTemplateModuleScriptSrc(string? src)
        => IsSpaEntryScriptSrc(src) || IsPreThemeScriptSrc(src);

    private static bool IsSpaEntryScriptSrc(string? src)
    {
        if (string.IsNullOrWhiteSpace(src))
        {
            return false;
        }

        return IsDevelopmentSourceEntryScriptSrc(src)
            || src.Equals(StableSpaEntryAlias, StringComparison.OrdinalIgnoreCase)
            || src.Equals(StableSpaEntryAlias.TrimStart('/'), StringComparison.OrdinalIgnoreCase)
            || IsViteProductionEntryScriptSrc(src);
    }

    private static bool IsDevelopmentSourceEntryScriptSrc(string? src)
    {
        if (string.IsNullOrWhiteSpace(src))
        {
            return false;
        }

        string value = NormalizeAssetPath(src);
        return value.Equals("/src/bootstrap/entry.ts", StringComparison.OrdinalIgnoreCase)
            || value.Equals("/src/main.ts", StringComparison.OrdinalIgnoreCase)
            || value.EndsWith("/entry.ts", StringComparison.OrdinalIgnoreCase)
            || value.EndsWith("/main.ts", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsPreThemeScriptSrc(string? src)
    {
        if (string.IsNullOrWhiteSpace(src))
        {
            return false;
        }

        string value = NormalizeAssetPath(src);
        return value.Equals("/src/bootstrap/preTheme.ts", StringComparison.OrdinalIgnoreCase)
            || value.EndsWith("/preTheme.ts", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsViteProductionEntryScriptSrc(string src)
    {
        string value = NormalizeAssetPath(src);
        return value.Equals("/assets/index.js", StringComparison.OrdinalIgnoreCase)
            || value.StartsWith("/assets/index-", StringComparison.OrdinalIgnoreCase);
    }

    private static string NormalizeAssetPath(string src)
    {
        string value = src.Trim().Replace('\\', '/');
        return value.StartsWith("/", StringComparison.Ordinal) ? value : "/" + value;
    }

    private static string BuildTitleSuffix(string title, string siteTitle)
    {
        if (string.IsNullOrWhiteSpace(siteTitle) || string.Equals(title, siteTitle, StringComparison.Ordinal))
        {
            return string.Empty;
        }

        return $" - {Encode(siteTitle)}";
    }

    private static string BuildBinaryPayloadScript(string id, string payload)
        => $"<script id=\"{Encode(id)}\" type=\"application/octet-stream\">{Encode(RequirePublicAotPayload(payload))}</script>";

    private static string BuildBinaryPayloadSidecarMarker(string id, string payload)
        => $"<script id=\"{Encode(id)}\" type=\"application/octet-stream\" data-aeds-src=\"{Encode(BuildPayloadSidecarUrl(payload))}\"></script>";

    internal static string BuildPayloadSidecarUrl(string payload)
    {
        string normalized = RequirePublicAotPayload(payload);
        string hash = Sha256Hex(DecodePayloadFrameBytes(normalized));
        return $"/aot-cache/payloads/{hash[..2]}/{hash}.aeds";
    }

    internal static byte[] DecodePayloadFrameBytes(string payload)
    {
        string normalized = RequirePublicAotPayload(payload);
        string base64 = normalized.Replace('-', '+').Replace('_', '/');
        base64 = base64.PadRight((base64.Length + 3) / 4 * 4, '=');
        return Convert.FromBase64String(base64);
    }

    private static string RequirePublicAotPayload(string payload)
    {
        if (string.IsNullOrWhiteSpace(payload))
        {
            return PublicAotBinaryPayload.EncodeObject(new Dictionary<string, object?>(StringComparer.Ordinal));
        }

        if (IsAedsBase64UrlPayload(payload))
        {
            return payload.Trim();
        }

        throw new InvalidOperationException("public_aot_payload_must_be_aeds");
    }

    private static bool IsAedsBase64UrlPayload(string payload)
    {
        string value = payload.Trim();
        if (value.Length < 32 || value.Contains('{', StringComparison.Ordinal) || value.Contains('[', StringComparison.Ordinal))
        {
            return false;
        }

        try
        {
            string normalized = value.Replace('-', '+').Replace('_', '/');
            normalized = normalized.PadRight((normalized.Length + 3) / 4 * 4, '=');
            byte[] frame = Convert.FromBase64String(normalized);
            var decoded = new AedsEncoder().TryDecode(frame);
            return decoded.IsSuccess
                && decoded.Value.FrameType == AedsFrameType.PublicAotBootstrap;
        }
        catch (FormatException)
        {
            return false;
        }
    }

    private static string Sha256Hex(ReadOnlySpan<byte> value)
        => Convert.ToHexStringLower(SHA256.HashData(value));

    private static string BuildJavaScriptStringArray(IReadOnlyList<string>? values)
    {
        if (values is null || values.Count == 0)
        {
            return "[]";
        }

        var builder = new System.Text.StringBuilder(values.Count * 32);
        builder.Append('[');
        bool first = true;
        foreach (string value in values.Where(static item => !string.IsNullOrWhiteSpace(item)).Distinct(StringComparer.Ordinal))
        {
            if (!first)
            {
                builder.Append(',');
            }

            first = false;
            builder.Append('"');
            builder.Append(JavaScriptEncoder.Default.Encode(value));
            builder.Append('"');
        }

        builder.Append(']');
        return builder.ToString();
    }

    private static string Encode(string? value)
        => WebUtility.HtmlEncode(value ?? string.Empty);
}
