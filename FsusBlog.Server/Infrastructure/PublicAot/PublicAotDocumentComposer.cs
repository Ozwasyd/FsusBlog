using System.Net;
using System.Text.Encodings.Web;
using System.Text.RegularExpressions;

namespace FsusBlog.Server.Infrastructure.PublicAot;

internal readonly record struct PublicAotDocumentModel(
    PublicPageKind Kind,
    string RawTemplate,
    string PreparedTemplate,
    string Title,
    string SiteTitle,
    string Description,
    string CanonicalUrl,
    string ShellHtml,
    string BootstrapJson,
    string HydrationPropsJson,
    string IslandsJson);

internal static class PublicAotDocumentComposer
{
    internal static string BuildSeoHeadTags(
        PublicPageKind kind,
        string title,
        string siteTitle,
        string description,
        string canonicalUrl)
    {
        string ogType = kind == PublicPageKind.ArticleDetail ? "article" : "website";
        string fullTitle = string.IsNullOrWhiteSpace(siteTitle) ? title : $"{title} - {siteTitle}";

        return $"""
<meta name="description" content="{Encode(description)}" />
<meta property="og:title" content="{Encode(fullTitle)}" />
<meta property="og:description" content="{Encode(description)}" />
<meta property="og:type" content="{Encode(ogType)}" />
<meta property="og:url" content="{Encode(canonicalUrl)}" />
<link rel="canonical" href="{Encode(canonicalUrl)}" />
""";
    }

    internal static string BuildNoScriptBlock(string title, string description) =>
        $"""
<noscript>
  <section class="max-w-3xl mx-auto px-6 sm:px-8 py-8 text-zinc-700">
    <h1 class="text-xl font-bold text-zinc-950">{Encode(title)}</h1>
    <p class="mt-3 text-sm leading-7">{Encode(description)}</p>
  </section>
</noscript>
""";

    internal static string PreparePublicDocumentTemplate(string template)
    {
        string result = StripImmediateSpaEntryScript(template);
        result = StripModulePreloadLinks(result);
        return result;
    }

    internal static string ComposeDocument(PublicAotDocumentModel model)
    {
        string html = model.PreparedTemplate
            .Replace("<body>", "<body data-fsus-public-first-paint=\"true\" data-fsus-public-shell=\"true\">", StringComparison.Ordinal)
            .Replace(
                "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />",
                $"<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />\n    {BuildSeoHeadTags(model.Kind, model.Title, model.SiteTitle, model.Description, model.CanonicalUrl)}",
                StringComparison.Ordinal)
            .Replace("<title>Loading...</title>", $"<title>{Encode(model.Title)}{BuildTitleSuffix(model.Title, model.SiteTitle)}</title>", StringComparison.Ordinal)
            .Replace("<div id=\"app\"></div>", $"<div id=\"app\">{model.ShellHtml}</div>", StringComparison.Ordinal);

        const string bodyClose = "</body>";
        string bootstrapScript = $"<script id=\"fsus-aot-bootstrap\" type=\"application/json\">{EncodeJson(model.BootstrapJson)}</script>";
        string hydrationScript = string.IsNullOrWhiteSpace(model.HydrationPropsJson)
            ? string.Empty
            : $"<script id=\"fsus-aot-hydration-props\" type=\"application/json\">{EncodeJson(model.HydrationPropsJson)}</script>";
        string islandsScript = string.IsNullOrWhiteSpace(model.IslandsJson)
            ? string.Empty
            : $"<script id=\"fsus-aot-islands\" type=\"application/json\">{EncodeJson(model.IslandsJson)}</script>";
        string noScript = BuildNoScriptBlock(model.Title, model.Description);
        string deferredSpaBoot = BuildDeferredSpaBootScript(model.RawTemplate);

        return html.Contains(bodyClose, StringComparison.Ordinal)
            ? html.Replace(bodyClose, $"{noScript}\n    {bootstrapScript}\n    {hydrationScript}\n    {islandsScript}\n    {deferredSpaBoot}\n    {bodyClose}", StringComparison.Ordinal)
            : html + noScript + bootstrapScript + hydrationScript + islandsScript + deferredSpaBoot;
    }

    internal static string BuildDeferredSpaBootScript(string template)
    {
        string entryScriptSrc = TryExtractSpaEntryScriptSrc(template);
        if (string.IsNullOrWhiteSpace(entryScriptSrc))
        {
            return string.Empty;
        }

        string encodedSrc = JavaScriptEncoder.Default.Encode(entryScriptSrc);
        return $@"<script id=""fsus-spa-boot"" data-fsus-spa-entry=""{Encode(entryScriptSrc)}"">
  (() => {{
    const entrySrc = ""{encodedSrc}"";
    const mark = (name) => {{
      try {{
        if (window.performance && typeof window.performance.mark === 'function') {{
          window.performance.mark('fsus:start:' + name);
        }}
      }} catch {{
      }}
    }};

    let preloadWarmed = false;
    let injectScheduled = false;
    let forcedInjectTimer = 0;

    const warmPreload = () => {{
      if (preloadWarmed) {{
        return;
      }}
      preloadWarmed = true;

      if (!document.querySelector('link[rel=""modulepreload""][href=""' + entrySrc + '""]')) {{
        const preload = document.createElement('link');
        preload.rel = 'modulepreload';
        preload.crossOrigin = 'anonymous';
        preload.href = entrySrc;
        preload.fetchPriority = 'low';
        preload.dataset.fsusSpaPreload = 'deferred';
        (document.head || document.body).appendChild(preload);
      }}
      mark('server-spa-preload');
    }};

    const loadSpaEntry = () => {{
      injectScheduled = false;
      if (document.querySelector('script[data-fsus-spa-entry][src=""' + entrySrc + '""]') ||
          document.querySelector('script[type=""module""][src=""' + entrySrc + '""]')) {{
        return;
      }}

      mark('server-spa-entry-injected');
      const script = document.createElement('script');
      script.type = 'module';
      script.crossOrigin = 'anonymous';
      script.src = entrySrc;
      script.dataset.fsusSpaEntry = 'deferred';
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
        warmPreload();
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

    private static string EncodeJson(string json)
        => WebUtility.HtmlEncode(json);

    private static string Encode(string? value)
        => WebUtility.HtmlEncode(value ?? string.Empty);
}
