using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Infrastructure.Spa;
using System.Buffers.Binary;
using System.Net;
using System.Text.Encodings.Web;
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
}

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
        string canonicalUrl)
    {
        string ogType = kind == PublicPageKind.ArticleDetail ? "article" : "website";
        string fullTitle = string.IsNullOrWhiteSpace(siteTitle) ? title : $"{title} - {siteTitle}";

        string jsonLdType = kind == PublicPageKind.ArticleDetail ? "BlogPosting" : "WebSite";
        string siteRoot = ResolveSiteRoot(canonicalUrl);
        string breadcrumbCurrentName = kind == PublicPageKind.Home ? "Home" : fullTitle;
        string jsonLd = string.Concat(
            "{\"@context\":\"https://schema.org\",\"@graph\":[",
            "{\"@type\":\"WebSite\",",
            "\"name\":\"", JavaScriptEncoder.Default.Encode(siteTitle), "\",",
            "\"url\":\"", JavaScriptEncoder.Default.Encode(siteRoot), "\",",
            "\"potentialAction\":{\"@type\":\"SearchAction\",",
            "\"target\":\"", JavaScriptEncoder.Default.Encode(siteRoot.TrimEnd('/')), "/search?q={search_term_string}\",",
            "\"query-input\":\"required name=search_term_string\"}}",
            ",{\"@type\":\"BreadcrumbList\",\"itemListElement\":[",
            "{\"@type\":\"ListItem\",\"position\":1,\"name\":\"Home\",\"item\":\"", JavaScriptEncoder.Default.Encode(siteRoot), "\"}",
            kind == PublicPageKind.Home
                ? string.Empty
                : string.Concat(
                    ",{\"@type\":\"ListItem\",\"position\":2,\"name\":\"",
                    JavaScriptEncoder.Default.Encode(breadcrumbCurrentName),
                    "\",\"item\":\"",
                    JavaScriptEncoder.Default.Encode(canonicalUrl),
                    "\"}"),
            "]}",
            ",{\"@type\":\"", JavaScriptEncoder.Default.Encode(jsonLdType), "\",",
            "\"name\":\"", JavaScriptEncoder.Default.Encode(fullTitle), "\",",
            "\"url\":\"", JavaScriptEncoder.Default.Encode(canonicalUrl), "\",",
            "\"description\":\"", JavaScriptEncoder.Default.Encode(description), "\"}",
            "]}");
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
            : BuildBinaryPayloadScript("fsus-aot-hydration-props", model.HydrationPropsPayload);
        string islandsScript = string.IsNullOrWhiteSpace(model.IslandsPayload)
            ? string.Empty
            : BuildBinaryPayloadScript("fsus-aot-islands", model.IslandsPayload);
        string deferredSpaBoot = BuildDeferredSpaBootScript(
            model.RawTemplate,
            model.SpaEntryScript,
            model.FullAppTakeover.ModulePreloads,
            model.FullAppTakeover.Stylesheets);

        string payloadScripts = string.Join(
            "\n    ",
            new[] { bootstrapScript, hydrationScript, islandsScript }.Where(static script => !string.IsNullOrWhiteSpace(script)));

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
    {BuildSeoHeadTags(model.Kind, model.Title, model.SiteTitle, model.Description, model.CanonicalUrl)}
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
        string entryScriptSrc = string.IsNullOrWhiteSpace(entryScriptOverride)
            ? TryExtractSpaEntryScriptSrc(template)
            : entryScriptOverride;
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
      takeoverStylesheets.forEach((href) => {{
        if (!href) {{
          return;
        }}

        appendHeadLink('link[rel=""preload""][as=""style""][href=""' + href + '""]', (preload) => {{
          preload.rel = 'preload';
          preload.as = 'style';
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
            bool pointsToSpaEntry = scriptTag.Contains("src=\"/assets/", StringComparison.OrdinalIgnoreCase)
                || scriptTag.Contains("src='/assets/", StringComparison.OrdinalIgnoreCase)
                || scriptTag.Contains("src=\"assets/", StringComparison.OrdinalIgnoreCase)
                || scriptTag.Contains("src='assets/", StringComparison.OrdinalIgnoreCase)
                || scriptTag.Contains("src=\"/src/", StringComparison.OrdinalIgnoreCase)
                || scriptTag.Contains("src='/src/", StringComparison.OrdinalIgnoreCase)
                || scriptTag.Contains("src=\"src/", StringComparison.OrdinalIgnoreCase)
                || scriptTag.Contains("src='src/", StringComparison.OrdinalIgnoreCase);

            if (isModuleScript && pointsToSpaEntry)
            {
                return template.Remove(scriptIndex, closeEnd - scriptIndex);
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
                if (!string.IsNullOrWhiteSpace(src) &&
                    (src.StartsWith("/assets/", StringComparison.OrdinalIgnoreCase)
                     || src.StartsWith("assets/", StringComparison.OrdinalIgnoreCase)
                     || src.StartsWith("/src/", StringComparison.OrdinalIgnoreCase)
                     || src.StartsWith("src/", StringComparison.OrdinalIgnoreCase)))
                {
                    if (src.StartsWith("/assets/index-", StringComparison.OrdinalIgnoreCase)
                        || src.StartsWith("assets/index-", StringComparison.OrdinalIgnoreCase))
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
            return frame.Length >= AedsFrameHeader.Size
                && BinaryPrimitives.ReadUInt32LittleEndian(frame.AsSpan(0, 4)) == AedsEncoder.Magic
                && frame[4] == AedsFrameHeader.CurrentVersion
                && frame[5] == AedsFrameHeader.Size
                && BinaryPrimitives.ReadUInt16LittleEndian(frame.AsSpan(8, 2)) == (ushort)AedsFrameType.PublicAotBootstrap
                && BinaryPrimitives.ReadUInt32LittleEndian(frame.AsSpan(10, 4)) == frame.Length - AedsFrameHeader.Size;
        }
        catch (FormatException)
        {
            return false;
        }
    }

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
