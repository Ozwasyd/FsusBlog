using System.Buffers.Binary;
using System.Text;
using static FsusBlog.V2.Contracts.WireLayouts;

namespace FsusBlog.V2.Contracts;

public sealed record SiteSeo
{
    public string Title { get; init; } = "";
    public string Description { get; init; } = "";
    public string Keywords { get; init; } = "";
    public string Author { get; init; } = "";
    public string OgImage { get; init; } = "";
    public string BaseUrl { get; init; } = "";
    public string FaviconSvgUrl { get; init; } = "";
    public string FaviconIcoUrl { get; init; } = "";
    public string FaviconPngUrl { get; init; } = "";
    public string AppleTouchIconUrl { get; init; } = "";
    public string ManifestName { get; init; } = "";
    public string ManifestShortName { get; init; } = "";
    public string PwaIcon192Url { get; init; } = "";
    public string PwaIcon512Url { get; init; } = "";
    public string PwaMaskableIconUrl { get; init; } = "";
    public string ThemeColor { get; init; } = "";
    public string BackgroundColor { get; init; } = "";
    public string SiteLogoUrl { get; init; } = "";
    public string SiteLogoDarkUrl { get; init; } = "";
    public string SiteWordmarkUrl { get; init; } = "";
    public string AdminLogoUrl { get; init; } = "";
    public string AdminCollapsedIconUrl { get; init; } = "";
    public string LoginLogoUrl { get; init; } = "";
    public string LoginIconUrl { get; init; } = "";
}

public sealed record SiteCompliance
{
    public bool Enabled { get; init; }
    public string RegionMode { get; init; } = "global";
    public int? CopyrightStartYear { get; init; }
    public string CopyrightOwner { get; init; } = "";
    public string CopyrightText { get; init; } = "";
    public string ContentLicenseName { get; init; } = "";
    public string ContentLicenseUrl { get; init; } = "";
    public string IcpRecordNumber { get; init; } = "";
    public string IcpRecordUrl { get; init; } = "";
    public string PoliceRecordNumber { get; init; } = "";
    public string PoliceRecordUrl { get; init; } = "";
    public string PoliceBadgeIconUrl { get; init; } = "";
    public string OperatorName { get; init; } = "";
    public string ContactEmail { get; init; } = "";
}

public static class SiteConfigWire
{
    private static readonly UTF8Encoding Utf8 = new(false, true);

    public static byte[] EncodeSeo(SiteSeo config)
    {
        var payload = WithBlob(config.Description, SeoConfigDescriptionOffset, SeoConfigPodBytes, nameof(config.Description));
        Fixed(payload, config.Title, SeoConfigTitleOffset, SeoConfigDescriptionOffset);
        Fixed(payload, config.Keywords, SeoConfigKeywordsOffset, SeoConfigAuthorOffset);
        Fixed(payload, config.Author, SeoConfigAuthorOffset, SeoConfigOgImageOffset);
        Fixed(payload, config.OgImage, SeoConfigOgImageOffset, SeoConfigBaseUrlOffset);
        Fixed(payload, config.BaseUrl, SeoConfigBaseUrlOffset, SeoConfigFaviconSvgUrlOffset);
        Fixed(payload, config.FaviconSvgUrl, SeoConfigFaviconSvgUrlOffset, SeoConfigFaviconIcoUrlOffset);
        Fixed(payload, config.FaviconIcoUrl, SeoConfigFaviconIcoUrlOffset, SeoConfigFaviconPngUrlOffset);
        Fixed(payload, config.FaviconPngUrl, SeoConfigFaviconPngUrlOffset, SeoConfigAppleTouchIconUrlOffset);
        Fixed(payload, config.AppleTouchIconUrl, SeoConfigAppleTouchIconUrlOffset, SeoConfigManifestNameOffset);
        Fixed(payload, config.ManifestName, SeoConfigManifestNameOffset, SeoConfigManifestShortNameOffset);
        Fixed(payload, config.ManifestShortName, SeoConfigManifestShortNameOffset, SeoConfigPwaIcon192UrlOffset);
        Fixed(payload, config.PwaIcon192Url, SeoConfigPwaIcon192UrlOffset, SeoConfigPwaIcon512UrlOffset);
        Fixed(payload, config.PwaIcon512Url, SeoConfigPwaIcon512UrlOffset, SeoConfigPwaMaskableIconUrlOffset);
        Fixed(payload, config.PwaMaskableIconUrl, SeoConfigPwaMaskableIconUrlOffset, SeoConfigThemeColorOffset);
        Fixed(payload, config.ThemeColor, SeoConfigThemeColorOffset, SeoConfigBackgroundColorOffset);
        Fixed(payload, config.BackgroundColor, SeoConfigBackgroundColorOffset, SeoConfigSiteLogoUrlOffset);
        Fixed(payload, config.SiteLogoUrl, SeoConfigSiteLogoUrlOffset, SeoConfigSiteLogoDarkUrlOffset);
        Fixed(payload, config.SiteLogoDarkUrl, SeoConfigSiteLogoDarkUrlOffset, SeoConfigSiteWordmarkUrlOffset);
        Fixed(payload, config.SiteWordmarkUrl, SeoConfigSiteWordmarkUrlOffset, SeoConfigAdminLogoUrlOffset);
        Fixed(payload, config.AdminLogoUrl, SeoConfigAdminLogoUrlOffset, SeoConfigAdminCollapsedIconUrlOffset);
        Fixed(payload, config.AdminCollapsedIconUrl, SeoConfigAdminCollapsedIconUrlOffset, SeoConfigLoginLogoUrlOffset);
        Fixed(payload, config.LoginLogoUrl, SeoConfigLoginLogoUrlOffset, SeoConfigLoginIconUrlOffset);
        Fixed(payload, config.LoginIconUrl, SeoConfigLoginIconUrlOffset, SeoConfigPodBytes);
        return Aeds.Encode(FrameType.SeoConfig, payload);
    }

    public static byte[] EncodeCompliance(SiteCompliance config)
    {
        if (config.RegionMode is not ("global" or "mainland-cn"))
            throw new ProtocolException("Unknown site compliance region");
        if (config.CopyrightStartYear is <= 0 or > 9999)
            throw new ProtocolException("Invalid site compliance copyright year");

        var payload = WithBlob(config.CopyrightText, SiteComplianceCopyrightTextOffset, SiteCompliancePodBytes, nameof(config.CopyrightText));
        payload[SiteComplianceEnabledOffset] = config.Enabled ? (byte)1 : (byte)0;
        BinaryPrimitives.WriteInt32LittleEndian(payload.AsSpan(SiteComplianceCopyrightStartYearOffset), config.CopyrightStartYear ?? 0);
        Fixed(payload, config.RegionMode, SiteComplianceRegionModeOffset, SiteComplianceCopyrightStartYearOffset);
        Fixed(payload, config.CopyrightOwner, SiteComplianceCopyrightOwnerOffset, SiteComplianceCopyrightTextOffset);
        Fixed(payload, config.ContentLicenseName, SiteComplianceContentLicenseNameOffset, SiteComplianceContentLicenseUrlOffset);
        Fixed(payload, config.ContentLicenseUrl, SiteComplianceContentLicenseUrlOffset, SiteComplianceIcpRecordNumberOffset);
        Fixed(payload, config.IcpRecordNumber, SiteComplianceIcpRecordNumberOffset, SiteComplianceIcpRecordUrlOffset);
        Fixed(payload, config.IcpRecordUrl, SiteComplianceIcpRecordUrlOffset, SiteCompliancePoliceRecordNumberOffset);
        Fixed(payload, config.PoliceRecordNumber, SiteCompliancePoliceRecordNumberOffset, SiteCompliancePoliceRecordUrlOffset);
        Fixed(payload, config.PoliceRecordUrl, SiteCompliancePoliceRecordUrlOffset, SiteCompliancePoliceBadgeIconUrlOffset);
        Fixed(payload, config.PoliceBadgeIconUrl, SiteCompliancePoliceBadgeIconUrlOffset, SiteComplianceOperatorNameOffset);
        Fixed(payload, config.OperatorName, SiteComplianceOperatorNameOffset, SiteComplianceContactEmailOffset);
        Fixed(payload, config.ContactEmail, SiteComplianceContactEmailOffset, SiteCompliancePodBytes);
        return Aeds.Encode(FrameType.SiteComplianceConfig, payload);
    }

    private static byte[] WithBlob(string text, int sliceOffset, int podBytes, string field)
    {
        var length = Length(text, WireLimits.SiteConfigBlobBytes, field);
        var payload = new byte[podBytes + sizeof(int) + length];
        BinaryPrimitives.WriteInt32LittleEndian(payload.AsSpan(sliceOffset + sizeof(int)), length);
        BinaryPrimitives.WriteInt32LittleEndian(payload.AsSpan(podBytes), length);
        Utf8.GetBytes(text, payload.AsSpan(podBytes + sizeof(int)));
        return payload;
    }

    private static void Fixed(byte[] payload, string text, int start, int end,
        [System.Runtime.CompilerServices.CallerArgumentExpression(nameof(text))] string field = "")
    {
        var width = end - start;
        _ = Length(text, width, field);
        Utf8.GetBytes(text, payload.AsSpan(start, width));
    }

    private static int Length(string text, int maximum, string field)
    {
        if (text is null || text.Length > maximum || text.Contains('\0'))
            throw new ProtocolException($"Invalid site config text for {field}");
        try
        {
            var length = Utf8.GetByteCount(text);
            if (length > maximum)
                throw new ProtocolException($"Site config {field} exceeds {maximum} UTF-8 bytes");
            return length;
        }
        catch (EncoderFallbackException)
        {
            throw new ProtocolException($"Invalid site config UTF-8 for {field}");
        }
    }
}
