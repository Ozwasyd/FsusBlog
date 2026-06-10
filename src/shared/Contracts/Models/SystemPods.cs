using System.Runtime.InteropServices;
using FsusBlog.Shared.Contracts.Primitives;

namespace FsusBlog.Shared.Contracts.Models;

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct SeoConfigPod
{
    public readonly Utf8Fixed256 Title;
    public readonly Utf8SliceRef Description;
    public readonly Utf8Fixed256 Keywords;
    public readonly Utf8Fixed64 Author;
    public readonly Utf8Fixed256 OgImage;
    public readonly Utf8Fixed256 BaseUrl;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct PageContentPod
{
    public readonly Utf8Fixed128 Slug;
    public readonly Utf8SliceRef Content;
}

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
