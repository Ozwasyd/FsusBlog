using System.Runtime.InteropServices;

using FsusBlog.Shared.Contracts.Primitives;

namespace FsusBlog.Shared.Contracts.Models;

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>SeoConfig</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct SeoConfigPod
{
    public readonly Utf8Fixed256 Title;
    public readonly Utf8SliceRef Description;
    public readonly Utf8Fixed256 Keywords;
    public readonly Utf8Fixed64 Author;
    public readonly Utf8Fixed256 OgImage;
    public readonly Utf8Fixed256 BaseUrl;
    public readonly Utf8Fixed256 FaviconSvgUrl;
    public readonly Utf8Fixed256 FaviconIcoUrl;
    public readonly Utf8Fixed256 FaviconPngUrl;
    public readonly Utf8Fixed256 AppleTouchIconUrl;
    public readonly Utf8Fixed128 ManifestName;
    public readonly Utf8Fixed128 ManifestShortName;
    public readonly Utf8Fixed256 PwaIcon192Url;
    public readonly Utf8Fixed256 PwaIcon512Url;
    public readonly Utf8Fixed256 PwaMaskableIconUrl;
    public readonly Utf8Fixed32 ThemeColor;
    public readonly Utf8Fixed32 BackgroundColor;
    public readonly Utf8Fixed256 SiteLogoUrl;
    public readonly Utf8Fixed256 SiteLogoDarkUrl;
    public readonly Utf8Fixed256 SiteWordmarkUrl;
    public readonly Utf8Fixed256 AdminLogoUrl;
    public readonly Utf8Fixed256 AdminCollapsedIconUrl;
    public readonly Utf8Fixed256 LoginLogoUrl;
    public readonly Utf8Fixed256 LoginIconUrl;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>PageContent</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct PageContentPod
{
    public readonly Utf8Fixed128 Slug;
    public readonly Utf8SliceRef Content;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>SiteComplianceConfig</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct SiteComplianceConfigPod
{
    public readonly byte Enabled;
    public readonly Utf8Fixed32 RegionMode;
    public readonly int CopyrightStartYear;
    public readonly Utf8Fixed128 CopyrightOwner;
    public readonly Utf8SliceRef CopyrightText;
    public readonly Utf8Fixed128 ContentLicenseName;
    public readonly Utf8Fixed256 ContentLicenseUrl;
    public readonly Utf8Fixed64 IcpRecordNumber;
    public readonly Utf8Fixed256 IcpRecordUrl;
    public readonly Utf8Fixed64 PoliceRecordNumber;
    public readonly Utf8Fixed256 PoliceRecordUrl;
    public readonly Utf8Fixed256 PoliceBadgeIconUrl;
    public readonly Utf8Fixed128 OperatorName;
    public readonly Utf8Fixed128 ContactEmail;
}
