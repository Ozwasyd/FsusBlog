using System.Globalization;
using System.Net.Mail;
using System.Text;
using System.Xml;
using FsusBlog.V2.Contracts;

namespace FsusBlog.V2.Server.Content;

internal sealed class PublicSiteConfiguration
{
    internal const string OriginKey = "FSUSBLOG_PUBLIC_ORIGIN";
    internal const string SeoKey = "FSUSBLOG_PUBLIC_SEO";
    internal const string ComplianceKey = "FSUSBLOG_PUBLIC_COMPLIANCE";
    internal const string DefaultTitle = "Fsu's Blog";
    internal const string DefaultDescription = "Public articles from Fsu's Blog.";
    private static readonly UTF8Encoding Utf8 = new(false, true);

    internal string? Origin { get; }
    internal SiteSeo Seo { get; }
    internal SiteCompliance Compliance { get; }
    private readonly byte[] _seo;
    private readonly byte[] _compliance;

    private PublicSiteConfiguration(string? origin, SiteSeo seo, SiteCompliance compliance)
    {
        Origin = origin;
        Seo = seo;
        Compliance = compliance;
        _seo = SiteConfigWire.EncodeSeo(seo);
        _compliance = SiteConfigWire.EncodeCompliance(compliance);
    }

    internal static PublicSiteConfiguration Read(IConfiguration root)
    {
        var origin = ParseOrigin(root[OriginKey]);
        var seo = root.GetSection(SeoKey);
        var compliance = root.GetSection(ComplianceKey);
        var seoTitle = Text(seo, "Title", 256, DefaultTitle);
        var licenseName = Text(compliance, "ContentLicenseName", 128);
        var icpNumber = Text(compliance, "IcpRecordNumber", 64);
        var policeNumber = Text(compliance, "PoliceRecordNumber", 64);
        return new(origin, new SiteSeo
        {
            Title = seoTitle,
            Description = Text(seo, "Description", 4096, DefaultDescription, allowWhitespaceControls: true),
            Author = Text(seo, "Author", 64, "Fsu"),
            BaseUrl = origin ?? "",
            OgImage = Url(seo, "OgImage", asset: true),
            FaviconSvgUrl = Url(seo, "FaviconSvgUrl", asset: true),
            FaviconIcoUrl = Url(seo, "FaviconIcoUrl", asset: true),
            FaviconPngUrl = Url(seo, "FaviconPngUrl", asset: true),
            AppleTouchIconUrl = Url(seo, "AppleTouchIconUrl", asset: true),
            ManifestName = Text(seo, "ManifestName", 128),
            ManifestShortName = Text(seo, "ManifestShortName", 128),
            PwaIcon192Url = Url(seo, "PwaIcon192Url", asset: true),
            PwaIcon512Url = Url(seo, "PwaIcon512Url", asset: true),
            PwaMaskableIconUrl = Url(seo, "PwaMaskableIconUrl", asset: true),
            ThemeColor = Color(seo, "ThemeColor"),
            BackgroundColor = Color(seo, "BackgroundColor"),
            SiteLogoUrl = Url(seo, "SiteLogoUrl", asset: true),
            SiteLogoDarkUrl = Url(seo, "SiteLogoDarkUrl", asset: true),
            SiteWordmarkUrl = Url(seo, "SiteWordmarkUrl", asset: true)
        }, new SiteCompliance
        {
            Enabled = Boolean(compliance, "Enabled"),
            RegionMode = Region(compliance),
            CopyrightOwner = Text(compliance, "CopyrightOwner", 128),
            CopyrightStartYear = Year(compliance),
            CopyrightText = Text(compliance, "CopyrightText", 2048, allowWhitespaceControls: true),
            ContentLicenseName = licenseName,
            ContentLicenseUrl = Url(compliance, "ContentLicenseUrl", label: licenseName),
            IcpRecordNumber = icpNumber,
            IcpRecordUrl = Url(compliance, "IcpRecordUrl", label: icpNumber,
                fallback: icpNumber.Length == 0 ? "" : "https://beian.miit.gov.cn/"),
            PoliceRecordNumber = policeNumber,
            PoliceRecordUrl = Url(compliance, "PoliceRecordUrl", label: policeNumber,
                fallback: policeNumber.Length == 0 ? "" : "https://beian.mps.gov.cn/"),
            PoliceBadgeIconUrl = Url(compliance, "PoliceBadgeIconUrl", asset: true, label: policeNumber),
            OperatorName = Text(compliance, "OperatorName", 128),
            ContactEmail = Email(compliance)
        });
    }

    internal void Map(WebApplication app)
    {
        string[] methods = [HttpMethods.Get, HttpMethods.Head];
        app.MapMethods(WireRoutes.PublicSeo, methods, () => Results.Bytes(_seo, Aeds.ContentType));
        app.MapMethods(WireRoutes.PublicCompliance, methods, () => Results.Bytes(_compliance, Aeds.ContentType));
    }

    // The canonical authority is also the binary base URL. No alternate origin key is accepted.
    internal static string? ParseOrigin(string? setting)
    {
        if (string.IsNullOrWhiteSpace(setting)) return null;
        const string scheme = "https://";
        var value = setting.Trim();
        var slash = value.Length >= scheme.Length ? value.IndexOf('/', scheme.Length) : -1;
        if (value.Length > 320 || value.Any(glyph => char.IsWhiteSpace(glyph) || char.IsControl(glyph)) ||
            value.IndexOfAny(['\\', '?', '#', '@', '%']) >= 0 || !value.StartsWith(scheme, StringComparison.OrdinalIgnoreCase) ||
            !Uri.TryCreate(value, UriKind.Absolute, out var origin) || !IsHttpsAuthority(origin) ||
            (slash >= 0 && slash != value.Length - 1))
            throw Invalid(OriginKey, "an HTTPS origin without credentials, path, query, or fragment");

        var host = origin.HostNameType == UriHostNameType.IPv6 ? $"[{origin.IdnHost.Trim('[', ']')}]" : origin.IdnHost;
        var normalized = origin.IsDefaultPort ? $"https://{host}" : $"https://{host}:{origin.Port.ToString(CultureInfo.InvariantCulture)}";
        if (Utf8.GetByteCount(normalized) > 256) throw Invalid(OriginKey, "an HTTPS origin within 256 UTF-8 bytes");
        return normalized;
    }

    private static string Text(IConfigurationSection source, string key, int maximumBytes, string fallback = "",
        bool allowWhitespaceControls = false)
    {
        var text = source[key]?.Trim() ?? "";
        if (text.Length == 0) return fallback;
        if (text.Any(character => char.IsControl(character) && !(allowWhitespaceControls && character is ('\n' or '\r' or '\t'))))
            throw Invalid(source.Path + ":" + key, "plain text");
        foreach (var rune in text.EnumerateRunes())
            if (rune.Value <= char.MaxValue && !XmlConvert.IsXmlChar((char)rune.Value))
                throw Invalid(source.Path + ":" + key, "plain text");
        try
        {
            if (Utf8.GetByteCount(text) <= maximumBytes) return text;
        }
        catch (EncoderFallbackException) { }
        throw Invalid(source.Path + ":" + key, $"valid UTF-8 text within {maximumBytes} bytes");
    }

    private static string Url(IConfigurationSection source, string key, bool asset = false, string? label = null, string fallback = "")
    {
        var url = Text(source, key, 256, fallback);
        if (url.Length == 0) return url;
        if (label is "") throw Invalid(source.Path + ":" + key, "a URL with its matching record number or label");
        if (url.Any(char.IsWhiteSpace) || url.Contains('\\')) throw Invalid(source.Path + ":" + key, "a public HTTPS URL");
        if (asset && url.StartsWith("/assets/", StringComparison.Ordinal) && url.Length > "/assets/".Length &&
            url["/assets/".Length..].Split('/').All(segment => segment.Length > 0 && segment is not ("." or "..") &&
                segment.All(glyph => char.IsAsciiLetterOrDigit(glyph) || glyph is '-' or '_' or '.'))) return url;
        if (url.IndexOfAny(['@', '?', '#']) < 0 && Uri.TryCreate(url, UriKind.Absolute, out var parsed) && IsHttpsAuthority(parsed))
            return url;
        throw Invalid(source.Path + ":" + key, asset ? "a public HTTPS URL or a clean /assets/ path" : "a public HTTPS URL");
    }

    private static bool IsHttpsAuthority(Uri uri) => uri.Scheme == Uri.UriSchemeHttps && uri.Port != 0 &&
        string.IsNullOrEmpty(uri.UserInfo) && uri.HostNameType is UriHostNameType.Dns or UriHostNameType.IPv4 or UriHostNameType.IPv6;

    private static string Color(IConfigurationSection source, string key)
    {
        var color = Text(source, key, 7);
        if (color.Length == 0 || color.Length == 7 && color[0] == '#' && color.Skip(1).All(char.IsAsciiHexDigit)) return color;
        throw Invalid(source.Path + ":" + key, "a six-digit hexadecimal color");
    }

    private static string Email(IConfigurationSection source)
    {
        var text = Text(source, "ContactEmail", 128);
        if (text.Length == 0 || MailAddress.TryCreate(text, out var mail) && mail.Address == text &&
            text.All(glyph => char.IsAsciiLetterOrDigit(glyph) || glyph is '.' or '-' or '_' or '+' or '@')) return text;
        throw Invalid(source.Path + ":ContactEmail", "one explicit public email address");
    }

    private static string Region(IConfigurationSection source) => Text(source, "RegionMode", 32, "global").ToLowerInvariant() switch
    {
        "global" => "global", "mainland-cn" => "mainland-cn",
        _ => throw Invalid(source.Path + ":RegionMode", "global or mainland-cn")
    };

    private static int? Year(IConfigurationSection source)
    {
        var value = Text(source, "CopyrightStartYear", 4);
        if (value.Length == 0) return null;
        if (int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var year) && year >= 1990 && year <= DateTime.UtcNow.Year)
            return year;
        throw Invalid(source.Path + ":CopyrightStartYear", "a year from 1990 through the current year");
    }

    private static bool Boolean(IConfigurationSection source, string key)
    {
        var value = Text(source, key, 5);
        if (value.Length == 0) return false;
        if (bool.TryParse(value, out var enabled)) return enabled;
        throw Invalid(source.Path + ":" + key, "true or false");
    }

    private static InvalidOperationException Invalid(string key, string expected) => new($"{key} requires {expected}.");
}
