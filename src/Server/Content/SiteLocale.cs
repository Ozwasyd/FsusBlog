using System.Globalization;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace FsusBlog.V2.Server.Content;

internal static class SiteLocale
{
    internal const string Default = "zh-CN";
    private static readonly Dictionary<string, Dictionary<string, string>> Catalog = Read();

    internal static string Text(string locale, string key) => Catalog[locale][key];
    internal static string Html(string locale, string key) => HtmlEncoder.Default.Encode(Text(locale, key));

    internal static string Select(HttpContext context)
    {
        context.Response.Headers.Append("Vary", "Cookie, Accept-Language");
        var locale = Resolve(context.Request.Cookies["fsus_locale"], context.Request.Headers.AcceptLanguage.ToString());
        context.Response.Headers.ContentLanguage = locale;
        return locale;
    }

    internal static string Resolve(string? cookie, string acceptLanguage)
    {
        if (cookie is Default or "en") return cookie;
        var selected = Default;
        decimal best = -1;
        foreach (var entry in acceptLanguage.Split(','))
        {
            var parts = entry.Trim().Split(';');
            var tag = parts[0].Trim();
            var candidate = tag.Equals("en", StringComparison.OrdinalIgnoreCase) || tag.StartsWith("en-", StringComparison.OrdinalIgnoreCase)
                ? "en" : tag.Equals("zh", StringComparison.OrdinalIgnoreCase) || tag.StartsWith("zh-", StringComparison.OrdinalIgnoreCase) ? Default : null;
            if (candidate is null) continue;
            decimal quality = 1;
            if (parts.Length > 1)
            {
                var parameter = parts[1].Trim();
                if (!parameter.StartsWith("q=", StringComparison.OrdinalIgnoreCase) ||
                    !decimal.TryParse(parameter.AsSpan(2), NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out quality) || quality is < 0 or > 1)
                    continue;
            }
            if (quality > 0 && quality > best) { selected = candidate; best = quality; }
        }
        return selected;
    }

    internal static string Selector(string locale) => $"""
        <select class="site-locale-select" aria-label="{Html(locale, "nav.language")}" disabled>
        <option lang="zh-CN" value="zh-CN"{(locale == Default ? " selected" : "")}>中文</option><option lang="en" value="en"{(locale == "en" ? " selected" : "")}>EN</option>
        </select>
        """;

    private static Dictionary<string, Dictionary<string, string>> Read()
    {
        using var stream = typeof(SiteLocale).Assembly.GetManifestResourceStream("FsusBlog.SiteLocales.json")
            ?? throw new InvalidOperationException("Site locale resource is missing.");
        var catalog = JsonSerializer.Deserialize(stream, SiteLocaleJsonContext.Default.DictionaryStringDictionaryStringString)
            ?? throw new InvalidOperationException("Site locale catalog is missing.");
        string[] required = ["nav.primary", "nav.home", "nav.archive", "nav.about", "nav.search", "nav.login", "nav.skip", "nav.language",
            "policy.about", "policy.privacy", "policy.guidelines", "policy.copyright", "page.emptyArticles", "page.archive", "page.search", "page.login", "login.subtitle", "login.noScript", "page.loadingArticles", "reading.articleMissing", "reading.latestPosts"];
        if (catalog.Count != 2 || new[] { Default, "en" }.Any(locale => !catalog.TryGetValue(locale, out var words) ||
            required.Any(key => !words.TryGetValue(key, out var word) || string.IsNullOrWhiteSpace(word))))
            throw new InvalidOperationException("Site locale catalog is invalid.");
        return catalog;
    }
}

[JsonSerializable(typeof(Dictionary<string, Dictionary<string, string>>))]
internal partial class SiteLocaleJsonContext : JsonSerializerContext;
