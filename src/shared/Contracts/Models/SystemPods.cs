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
