using System.Runtime.InteropServices;
using FsusBlog.Shared.Contracts.Envelopes;
using FsusBlog.Shared.Contracts.Primitives;

namespace FsusBlog.Shared.Contracts.Models;

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct PopularArticlePod
{
    public readonly int Id;
    public readonly int Views;
    public readonly Utf8Fixed256 Title;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct RecentCommentPod
{
    public readonly long CreateTimeUnixMs;
    public readonly Utf8Fixed64 AuthorDisplayName;
    public readonly Utf8Fixed32 AuthorMode;
    public readonly Utf8SliceRef AuthorBadge;
    public readonly Utf8SliceRef AuthorScopeLabel;
    public readonly Utf8SliceRef ReservedPrivacyClass;
    public readonly Utf8SliceRef Content;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct RegionDistributionPod
{
    public readonly int Count;
    public readonly Utf8Fixed128 Region;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct SiteStatsPod
{
    public readonly int TotalArticles;
    public readonly int TotalComments;
    public readonly int TrashCount;
    public readonly int TotalReads;
    public readonly int HumanVerifiedReads;
    public readonly int UniqueViewerKeyEstimate;
    public readonly int ArticleReads;
    public readonly int SiteReads;
    public readonly PodEnvelopeHeader PopularArticles;
    public readonly PodEnvelopeHeader RecentComments;
    public readonly PodEnvelopeHeader RegionDistributions;
}
