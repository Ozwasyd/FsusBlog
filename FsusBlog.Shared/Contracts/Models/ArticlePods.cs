using System.Runtime.InteropServices;
using FsusBlog.Shared.Contracts.Envelopes;
using FsusBlog.Shared.Contracts.Primitives;

namespace FsusBlog.Shared.Contracts.Models;

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct ArticleCategoryViewPod
{
    public readonly int Id;
    public readonly Utf8Fixed128 Name;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct TagPod
{
    public readonly int Id;
    public readonly Utf8Fixed128 Name;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct TagWithCountPod
{
    public readonly int Id;
    public readonly Utf8Fixed128 Name;
    public readonly int ArticleCount;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct CategoryPod
{
    public readonly int Id;
    public readonly Utf8Fixed128 Name;
    public readonly int ArticleCount;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct ArticleListItemPod
{
    public readonly int Id;
    public readonly int Views;
    public readonly long CreateTimeUnixMs;
    public readonly ArticleCategoryViewPod Category;
    public readonly Utf8Fixed256 Title;
    public readonly Utf8SliceRef Summary;
    public readonly Utf8SliceRef Snippet;
    public readonly byte IsDeleted;
    public readonly byte HasIsDeleted;
    public readonly ushort Reserved;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct ArticleDetailPod
{
    public readonly int Id;
    public readonly int Views;
    public readonly long CreateTimeUnixMs;
    public readonly ArticleCategoryViewPod Category;
    public readonly Utf8Fixed256 Title;
    public readonly Utf8SliceRef Summary;
    public readonly Utf8SliceRef Content;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct ArticleNoticePod
{
    public readonly int ArticleId;
    public readonly long EventTimeUnixMs;
    public readonly Utf8Fixed64 Action;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct ArticleMutationResponsePod
{
    public readonly int Id;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct TrashClearResponsePod
{
    public readonly int Count;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct ArticleListPagePod
{
    public readonly PagedPodEnvelope Envelope;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct ArticleHotListPod
{
    public readonly PodEnvelopeHeader Envelope;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct ArticleTagListPod
{
    public readonly PodEnvelopeHeader Envelope;
}
