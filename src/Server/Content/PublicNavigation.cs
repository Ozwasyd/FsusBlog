namespace FsusBlog.V2.Server.Content;

// This embedded app-owned contract is also imported by the public Vue shell.
internal static class PublicNavigation
{
    private static readonly IReadOnlyList<PublicNavigationItem> Items = Read();

    internal static string Render(string? publicPath, string locale = SiteLocale.Default) => string.Concat(Items.Select(item =>
        $"<a href=\"{HtmlEncoder.Default.Encode(item.Href)}\"{(item.Href == publicPath ? " aria-current=\"page\"" : "")}>{SiteLocale.Html(locale, "nav." + item.Key)}</a>"));

    private static IReadOnlyList<PublicNavigationItem> Read()
    {
        using var stream = typeof(PublicNavigation).Assembly.GetManifestResourceStream("FsusBlog.PublicNavigation.json")
            ?? throw new InvalidOperationException("Public navigation resource is missing.");
        var items = JsonSerializer.Deserialize(stream, PublicNavigationJsonContext.Default.PublicNavigationItemArray)
            ?? throw new InvalidOperationException("Public navigation is missing.");
        if (items.Length != 3 || items.Any(item => item is null || string.IsNullOrWhiteSpace(item.Key) ||
                string.IsNullOrEmpty(item.Href) ||
                !item.Href.StartsWith('/') || item.Href.StartsWith("//", StringComparison.Ordinal) ||
                item.Href.Any(character => char.IsWhiteSpace(character) || char.IsControl(character) || character is '\\' or '?' or '#')) ||
            items.Select(item => item.Key).Distinct(StringComparer.Ordinal).Count() != items.Length ||
            items.Select(item => item.Href).Distinct(StringComparer.Ordinal).Count() != items.Length)
            throw new InvalidOperationException("Public navigation is invalid.");
        return Array.AsReadOnly(items);
    }
}

internal sealed record PublicNavigationItem(string Key, string Href);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(PublicNavigationItem[]))]
internal partial class PublicNavigationJsonContext : JsonSerializerContext;
