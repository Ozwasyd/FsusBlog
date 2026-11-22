using System.Globalization;
using System.Net.Mail;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Xml;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;

namespace FsusBlog.V2.Server.Content;

internal sealed class PublicSiteConfiguration
{
    internal const string OriginKey = "FSUSBLOG_PUBLIC_ORIGIN";
    internal const string SeoKey = "FSUSBLOG_PUBLIC_SEO";
    internal const string ComplianceKey = "FSUSBLOG_PUBLIC_COMPLIANCE";
    internal const string EditorSetting = "FSUSBLOG_SITE_CONFIG_EDITOR";
    internal const string ManifestPath = "/manifest.webmanifest";
    internal const string ManifestContentType = "application/manifest+json; charset=utf-8";
    internal const string DefaultTitle = "Fsu's Blog";
    internal const string DefaultDescription = "Public articles from Fsu's Blog.";
    internal const string DefaultAuthor = "Fsu";
    private static readonly UTF8Encoding Utf8 = new(false, true);

    internal sealed record Snapshot(
        long Revision,
        string Digest,
        SiteSeo Seo,
        SiteCompliance Compliance,
        byte[] SeoFrame,
        byte[] ComplianceFrame,
        byte[] ManifestBytes);

    internal string? Origin { get; }
    internal Snapshot Baseline { get; }
    private volatile Snapshot _current;

    internal Snapshot Current => _current;
    internal long Revision => _current.Revision;
    internal string Digest => _current.Digest;
    internal SiteSeo Seo => _current.Seo;
    internal SiteCompliance Compliance => _current.Compliance;

    private PublicSiteConfiguration(string? origin, SiteSeo seo, SiteCompliance compliance)
    {
        Origin = origin;
        Baseline = CreateSnapshot(0, seo, compliance);
        _current = Baseline;
    }

    internal static Snapshot CreateSnapshot(long revision, SiteSeo seo, SiteCompliance compliance)
    {
        var seoFrame = SiteConfigWire.EncodeSeo(seo);
        var complianceFrame = SiteConfigWire.EncodeCompliance(compliance);
        var digest = ComputeDigest(seoFrame, complianceFrame);
        var manifestBytes = BuildManifest(seo);
        return new(revision, digest, seo, compliance, seoFrame, complianceFrame, manifestBytes);
    }

    internal static byte[] ComputeDigestBytes(byte[] seoFrame, byte[] complianceFrame)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        hash.AppendData(seoFrame);
        hash.AppendData(complianceFrame);
        return hash.GetHashAndReset();
    }

    internal static string ComputeDigest(byte[] seoFrame, byte[] complianceFrame) =>
        Convert.ToHexStringLower(ComputeDigestBytes(seoFrame, complianceFrame));

    internal void ApplyOverride(Snapshot snapshot) =>
        _current = snapshot.Revision == 0 ? Baseline : snapshot;

    internal AdminSiteConfigState ToAdminState(Snapshot? snapshot = null)
    {
        var snap = snapshot ?? _current;
        var seo = snap.Seo;
        var compliance = snap.Compliance;
        return new(
            snap.Revision, snap.Digest, Origin ?? "",
            seo.Title, seo.Description, seo.Author, seo.OgImage,
            seo.FaviconSvgUrl, seo.FaviconIcoUrl, seo.FaviconPngUrl, seo.AppleTouchIconUrl,
            seo.ManifestName, seo.ManifestShortName,
            seo.PwaIcon192Url, seo.PwaIcon512Url, seo.PwaMaskableIconUrl,
            seo.ThemeColor, seo.BackgroundColor,
            seo.SiteLogoUrl, seo.SiteLogoDarkUrl, seo.SiteWordmarkUrl,
            compliance.Enabled, compliance.RegionMode, compliance.CopyrightStartYear ?? 0,
            compliance.CopyrightOwner, compliance.CopyrightText,
            compliance.ContentLicenseName, compliance.ContentLicenseUrl,
            compliance.IcpRecordNumber, compliance.IcpRecordUrl,
            compliance.PoliceRecordNumber, compliance.PoliceRecordUrl, compliance.PoliceBadgeIconUrl,
            compliance.OperatorName, compliance.ContactEmail);
    }

    internal (SiteSeo Seo, SiteCompliance Compliance) ValidateOverride(AdminSiteConfigCommand command)
    {
        try
        {
            var title = TextValue("Title", command.Title, 256, fallback: "", required: true);
            var description = TextValue("Description", command.Description, 4096, allowWhitespaceControls: true);
            var author = TextValue("Author", command.Author, 64, fallback: "", required: true);
            var licenseName = TextValue("ContentLicenseName", command.ContentLicenseName, 128);
            var icpNumber = TextValue("IcpRecordNumber", command.IcpRecordNumber, 64);
            var policeNumber = TextValue("PoliceRecordNumber", command.PoliceRecordNumber, 64);

            var seo = new SiteSeo
            {
                Title = title,
                Description = description,
                Author = author,
                BaseUrl = Origin ?? "",
                OgImage = UrlValue("OgImage", command.OgImage, asset: true),
                FaviconSvgUrl = UrlValue("FaviconSvgUrl", command.FaviconSvgUrl, asset: true),
                FaviconIcoUrl = UrlValue("FaviconIcoUrl", command.FaviconIcoUrl, asset: true),
                FaviconPngUrl = UrlValue("FaviconPngUrl", command.FaviconPngUrl, asset: true),
                AppleTouchIconUrl = UrlValue("AppleTouchIconUrl", command.AppleTouchIconUrl, asset: true),
                ManifestName = TextValue("ManifestName", command.ManifestName, 128),
                ManifestShortName = TextValue("ManifestShortName", command.ManifestShortName, 128),
                PwaIcon192Url = UrlValue("PwaIcon192Url", command.PwaIcon192Url, asset: true),
                PwaIcon512Url = UrlValue("PwaIcon512Url", command.PwaIcon512Url, asset: true),
                PwaMaskableIconUrl = UrlValue("PwaMaskableIconUrl", command.PwaMaskableIconUrl, asset: true),
                ThemeColor = ColorValue("ThemeColor", command.ThemeColor),
                BackgroundColor = ColorValue("BackgroundColor", command.BackgroundColor),
                SiteLogoUrl = UrlValue("SiteLogoUrl", command.SiteLogoUrl, asset: true),
                SiteLogoDarkUrl = UrlValue("SiteLogoDarkUrl", command.SiteLogoDarkUrl, asset: true),
                SiteWordmarkUrl = UrlValue("SiteWordmarkUrl", command.SiteWordmarkUrl, asset: true)
            };

            var compliance = new SiteCompliance
            {
                Enabled = command.ComplianceEnabled,
                RegionMode = RegionValue("RegionMode", command.RegionMode),
                CopyrightOwner = TextValue("CopyrightOwner", command.CopyrightOwner, 128),
                CopyrightStartYear = YearValue("CopyrightStartYear", command.CopyrightStartYear),
                CopyrightText = TextValue("CopyrightText", command.CopyrightText, 2048, allowWhitespaceControls: true),
                ContentLicenseName = licenseName,
                ContentLicenseUrl = UrlValue("ContentLicenseUrl", command.ContentLicenseUrl, label: licenseName),
                IcpRecordNumber = icpNumber,
                IcpRecordUrl = UrlValue("IcpRecordUrl", command.IcpRecordUrl, label: icpNumber,
                    fallback: icpNumber.Length == 0 ? "" : "https://beian.miit.gov.cn/"),
                PoliceRecordNumber = policeNumber,
                PoliceRecordUrl = UrlValue("PoliceRecordUrl", command.PoliceRecordUrl, label: policeNumber,
                    fallback: policeNumber.Length == 0 ? "" : "https://beian.mps.gov.cn/"),
                PoliceBadgeIconUrl = UrlValue("PoliceBadgeIconUrl", command.PoliceBadgeIconUrl, asset: true, label: policeNumber),
                OperatorName = TextValue("OperatorName", command.OperatorName, 128),
                ContactEmail = EmailValue("ContactEmail", command.ContactEmail)
            };

            return (seo, compliance);
        }
        catch (InvalidOperationException error)
        {
            throw new BusinessException(Rejection.Invalid, error.Message);
        }
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
            Author = Text(seo, "Author", 64, DefaultAuthor),
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
        app.MapMethods(WireRoutes.PublicSeo, methods, () => Results.Bytes(_current.SeoFrame, Aeds.ContentType));
        app.MapMethods(WireRoutes.PublicCompliance, methods, () => Results.Bytes(_current.ComplianceFrame, Aeds.ContentType));
        app.MapMethods(ManifestPath, methods, (HttpContext ctx) =>
        {
            ctx.Response.Headers.CacheControl = "no-store";
            return Results.Bytes(_current.ManifestBytes, ManifestContentType);
        });
    }

    internal static byte[] BuildManifest(SiteSeo seo)
    {
        var name = seo.ManifestName.Length > 0 ? seo.ManifestName : seo.Title;
        var shortName = seo.ManifestShortName.Length > 0 ? seo.ManifestShortName : name;
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            writer.WriteString("name", name);
            writer.WriteString("short_name", shortName);
            if (seo.Description.Length > 0)
                writer.WriteString("description", seo.Description);
            writer.WriteString("start_url", "/");
            writer.WriteString("scope", "/");
            writer.WriteString("display", "standalone");
            if (seo.ThemeColor.Length > 0)
                writer.WriteString("theme_color", seo.ThemeColor);
            if (seo.BackgroundColor.Length > 0)
                writer.WriteString("background_color", seo.BackgroundColor);
            writer.WriteStartArray("icons");
            WriteIcon(writer, seo.PwaIcon192Url, "192x192", "any");
            WriteIcon(writer, seo.PwaIcon512Url, "512x512", "any");
            WriteIcon(writer, seo.PwaMaskableIconUrl, "512x512", "maskable");
            writer.WriteEndArray();
            writer.WriteEndObject();
        }
        return stream.ToArray();

        static void WriteIcon(Utf8JsonWriter writer, string url, string sizes, string purpose)
        {
            if (url.Length == 0) return;
            writer.WriteStartObject();
            writer.WriteString("src", url);
            writer.WriteString("sizes", sizes);
            writer.WriteString("type", InferIconType(url));
            writer.WriteString("purpose", purpose);
            writer.WriteEndObject();
        }

        static string InferIconType(string url)
        {
            if (url.EndsWith(".svg", StringComparison.OrdinalIgnoreCase)) return "image/svg+xml";
            if (url.EndsWith(".webp", StringComparison.OrdinalIgnoreCase)) return "image/webp";
            if (url.EndsWith(".ico", StringComparison.OrdinalIgnoreCase)) return "image/x-icon";
            return "image/png";
        }
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
        bool allowWhitespaceControls = false) =>
        TextValue(source.Path + ":" + key, source[key], maximumBytes, fallback, allowWhitespaceControls: allowWhitespaceControls);

    internal static string TextValue(string key, string? raw, int maximumBytes, string fallback = "",
        bool required = false, bool allowWhitespaceControls = false)
    {
        var text = raw?.Trim() ?? "";
        if (text.Length == 0)
        {
            if (required) throw Invalid(key, "non-empty plain text");
            return fallback;
        }
        if (text.Any(character => char.IsControl(character) && !(allowWhitespaceControls && character is ('\n' or '\r' or '\t'))))
            throw Invalid(key, "plain text");
        foreach (var rune in text.EnumerateRunes())
            if (rune.Value <= char.MaxValue && !XmlConvert.IsXmlChar((char)rune.Value))
                throw Invalid(key, "plain text");
        try
        {
            if (Utf8.GetByteCount(text) <= maximumBytes) return text;
        }
        catch (EncoderFallbackException) { }
        throw Invalid(key, $"valid UTF-8 text within {maximumBytes} bytes");
    }

    private static string Url(IConfigurationSection source, string key, bool asset = false, string? label = null, string fallback = "") =>
        UrlValue(source.Path + ":" + key, source[key], asset, label, fallback);

    internal static string UrlValue(string key, string? raw, bool asset = false, string? label = null, string fallback = "")
    {
        var url = TextValue(key, raw, 256, fallback);
        if (url.Length == 0) return url;
        if (label is "") throw Invalid(key, "a URL with its matching record number or label");
        if (url.Any(char.IsWhiteSpace) || url.Contains('\\')) throw Invalid(key, "a public HTTPS URL");
        if (asset && url.StartsWith("/assets/", StringComparison.Ordinal) && url.Length > "/assets/".Length &&
            url["/assets/".Length..].Split('/').All(segment => segment.Length > 0 && segment is not ("." or "..") &&
                segment.All(glyph => char.IsAsciiLetterOrDigit(glyph) || glyph is '-' or '_' or '.'))) return url;
        if (url.IndexOfAny(['@', '?', '#']) < 0 && Uri.TryCreate(url, UriKind.Absolute, out var parsed) && IsHttpsAuthority(parsed))
            return url;
        throw Invalid(key, asset ? "a public HTTPS URL or a clean /assets/ path" : "a public HTTPS URL");
    }

    private static bool IsHttpsAuthority(Uri uri) => uri.Scheme == Uri.UriSchemeHttps && uri.Port != 0 &&
        string.IsNullOrEmpty(uri.UserInfo) && uri.HostNameType is UriHostNameType.Dns or UriHostNameType.IPv4 or UriHostNameType.IPv6;

    private static string Color(IConfigurationSection source, string key) =>
        ColorValue(source.Path + ":" + key, source[key]);

    internal static string ColorValue(string key, string? raw)
    {
        var color = TextValue(key, raw, 7);
        if (color.Length == 0 || color.Length == 7 && color[0] == '#' && color.Skip(1).All(char.IsAsciiHexDigit)) return color;
        throw Invalid(key, "a six-digit hexadecimal color");
    }

    private static string Email(IConfigurationSection source) =>
        EmailValue(source.Path + ":ContactEmail", source["ContactEmail"]);

    internal static string EmailValue(string key, string? raw)
    {
        var text = TextValue(key, raw, 128);
        if (text.Length == 0 || MailAddress.TryCreate(text, out var mail) && mail.Address == text &&
            text.All(glyph => char.IsAsciiLetterOrDigit(glyph) || glyph is '.' or '-' or '_' or '+' or '@')) return text;
        throw Invalid(key, "one explicit public email address");
    }

    private static string Region(IConfigurationSection source) =>
        RegionValue(source.Path + ":RegionMode", source["RegionMode"]);

    internal static string RegionValue(string key, string? raw) => TextValue(key, raw, 32, "global").ToLowerInvariant() switch
    {
        "global" => "global", "mainland-cn" => "mainland-cn",
        _ => throw Invalid(key, "global or mainland-cn")
    };

    private static int? Year(IConfigurationSection source)
    {
        var value = Text(source, "CopyrightStartYear", 4);
        if (value.Length == 0) return null;
        if (int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var year) && year >= 1990 && year <= DateTime.UtcNow.Year)
            return year;
        throw Invalid(source.Path + ":CopyrightStartYear", "a year from 1990 through the current year");
    }

    internal static int? YearValue(string key, int raw)
    {
        if (raw == 0) return null;
        if (raw >= 1990 && raw <= DateTime.UtcNow.Year) return raw;
        throw Invalid(key, "a year from 1990 through the current year");
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
