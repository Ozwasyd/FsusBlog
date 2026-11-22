namespace FsusBlog.V2.Contracts;

public static partial class Wire
{
    private static void Validate(AdminSiteConfigState value)
    {
        if (value.Revision < 0 || value.Digest.Length != WireLimits.AdminSiteConfigDigestBytes ||
            !IsLowerHex(value.Digest) || value.Origin.Contains('\0'))
            throw new ProtocolException("Invalid administrator site configuration state");
        ValidateSiteConfigFields(value.RegionMode, value.CopyrightStartYear,
            value.Title, value.Description, value.Author, value.OgImage, value.FaviconSvgUrl, value.FaviconIcoUrl,
            value.FaviconPngUrl, value.AppleTouchIconUrl, value.ManifestName, value.ManifestShortName,
            value.PwaIcon192Url, value.PwaIcon512Url, value.PwaMaskableIconUrl, value.ThemeColor,
            value.BackgroundColor, value.SiteLogoUrl, value.SiteLogoDarkUrl, value.SiteWordmarkUrl,
            value.CopyrightOwner, value.CopyrightText, value.ContentLicenseName, value.ContentLicenseUrl,
            value.IcpRecordNumber, value.IcpRecordUrl, value.PoliceRecordNumber, value.PoliceRecordUrl,
            value.PoliceBadgeIconUrl, value.OperatorName, value.ContactEmail);
    }

    private static void Validate(AdminSiteConfigCommand value)
    {
        if (value.ExpectedRevision < 0 || value.ExpectedDigest.Length != WireLimits.AdminSiteConfigDigestBytes ||
            !IsLowerHex(value.ExpectedDigest))
            throw new ProtocolException("Invalid administrator site configuration command");
        ValidateSiteConfigFields(value.RegionMode, value.CopyrightStartYear,
            value.Title, value.Description, value.Author, value.OgImage, value.FaviconSvgUrl, value.FaviconIcoUrl,
            value.FaviconPngUrl, value.AppleTouchIconUrl, value.ManifestName, value.ManifestShortName,
            value.PwaIcon192Url, value.PwaIcon512Url, value.PwaMaskableIconUrl, value.ThemeColor,
            value.BackgroundColor, value.SiteLogoUrl, value.SiteLogoDarkUrl, value.SiteWordmarkUrl,
            value.CopyrightOwner, value.CopyrightText, value.ContentLicenseName, value.ContentLicenseUrl,
            value.IcpRecordNumber, value.IcpRecordUrl, value.PoliceRecordNumber, value.PoliceRecordUrl,
            value.PoliceBadgeIconUrl, value.OperatorName, value.ContactEmail);
    }

    private static void ValidateSiteConfigFields(string regionMode, int copyrightStartYear, params ReadOnlySpan<string> texts)
    {
        if (regionMode is not ("global" or "mainland-cn"))
            throw new ProtocolException("Invalid site configuration region mode");
        if (copyrightStartYear is < 0 or > 9999)
            throw new ProtocolException("Invalid site configuration copyright year");
        foreach (var text in texts)
            if (text is null || text.Contains('\0'))
                throw new ProtocolException("Invalid site configuration text");
    }

    private static bool IsLowerHex(string value)
    {
        foreach (var ch in value)
            if (ch is not ((>= '0' and <= '9') or (>= 'a' and <= 'f')))
                return false;
        return true;
    }
}
