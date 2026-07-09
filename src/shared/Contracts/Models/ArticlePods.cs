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
    public readonly byte IsDeleted;
    public readonly byte HasIsDeleted;
    public readonly ushort Reserved0;
    public readonly uint Reserved1;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct ArticleDetailPod
{
    public readonly int Id;
    public readonly int Views;
    public readonly long CreateTimeUnixMs;
    public readonly int Reserved0;
    public readonly ArticleCategoryViewPod Category;
    public readonly Utf8Fixed256 Title;
    public readonly Utf8SliceRef Summary;
    public readonly Utf8SliceRef Content;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct ArticleDetailV3HeaderPod
{
    public readonly uint Magic;
    public readonly int Version;
    public readonly uint Flags;
    public readonly int ArticleRecordOffset;
    public readonly int ArticleRecordLength;
    public readonly int TagOffset;
    public readonly int TagCount;
    public readonly int RightsRecordOffset;
    public readonly int RightsRecordLength;
    public readonly int BlobOffset;
    public readonly int BlobLength;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct ArticleDetailV3RecordPod
{
    public readonly int Id;
    public readonly int Views;
    public readonly long CreateTimeUnixMs;
    public readonly int CategoryId;
    public readonly int Status;
    public readonly long ScheduledPublishAtUnixMs;
    public readonly long PublishedAtUnixMs;
    public readonly byte IsDeleted;
    public readonly byte Reserved0;
    public readonly ushort Reserved1;
    public readonly Utf8SliceRef Title;
    public readonly Utf8SliceRef Content;
    public readonly Utf8SliceRef Summary;
    public readonly Utf8SliceRef CoverImageUrl;
    public readonly Utf8SliceRef CategoryName;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct ArticleDetailTagV3RecordPod
{
    public readonly int Id;
    public readonly Utf8SliceRef Name;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct ArticleRightsV3RecordPod
{
    public readonly long SnapshotId;
    public readonly long ArticleRevisionId;
    public readonly int RevisionNo;
    public readonly int Flags;
    public readonly int CopyrightYear;
    public readonly int MaxExcerptChars;
    public readonly Utf8SliceRef LicenseType;
    public readonly Utf8SliceRef CopyrightHolder;
    public readonly Utf8SliceRef RightsStatement;
    public readonly Utf8SliceRef AttributionTemplate;
    public readonly Utf8SliceRef CopyPolicy;
    public readonly Utf8SliceRef CanonicalUrl;
    public readonly Utf8SliceRef PolicyHash;
    public readonly Utf8SliceRef ContentCanonicalHash;
    public readonly Utf8SliceRef ProofUrl;
    public readonly Utf8SliceRef ProofStatus;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct FeaturedArticlePod
{
    public readonly int Id;
    public readonly int Views;
    public readonly long CreateTimeUnixMs;
    public readonly ArticleCategoryViewPod Category;
    public readonly Utf8Fixed256 Title;
    public readonly Utf8SliceRef CoverImageUrl;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct RelatedReadingHeaderPod
{
    public readonly int RelatedCount;
    public readonly byte HasPrevious;
    public readonly byte HasNext;
    public readonly ushort Reserved0;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct RelatedReadingItemPod
{
    public readonly int Id;
    public readonly long CreateTimeUnixMs;
    public readonly byte HasSummary;
    public readonly byte Reserved0;
    public readonly ushort Reserved1;
    public readonly Utf8SliceRef Title;
    public readonly Utf8SliceRef Summary;
    public readonly Utf8SliceRef Reason;
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
public readonly struct ArticleWriteRequestPod
{
    public readonly int CategoryId;
    public readonly int TagCount;
    public readonly Utf8SliceRef Title;
    public readonly Utf8SliceRef Content;
    public readonly Utf8SliceRef Summary;
    public readonly Utf8SliceRef CoverImageUrl;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct ArticleRightsWriteRequestPod
{
    public readonly Utf8SliceRef LicenseType;
    public readonly Utf8SliceRef CopyrightHolder;
    public readonly Utf8SliceRef RightsStatement;
    public readonly Utf8SliceRef AttributionTemplate;
    public readonly Utf8SliceRef CopyPolicy;
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
public readonly struct ArticleFeaturedListPod
{
    public readonly PodEnvelopeHeader Envelope;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct ArticleTagListPod
{
    public readonly PodEnvelopeHeader Envelope;
}
