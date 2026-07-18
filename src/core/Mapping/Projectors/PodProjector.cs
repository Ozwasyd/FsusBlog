using System.Buffers;
using System.Runtime.InteropServices;

using FsusBlog.Core.Mapping.Codecs;
using FsusBlog.Shared.Contracts.Envelopes;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Primitives;

namespace FsusBlog.Core.Mapping.Projectors;

public static class PodProjector
{
    public static ArticleListItemPod ProjectArticleList(
        int id,
        int views,
        DateTime createTime,
        int categoryId,
        string categoryName,
        string title,
        string? summary,
        bool? isDeleted,
        out ReadOnlyMemory<byte> payload)
    {
        var bytes = new ArrayBufferWriter<byte>(256);
        Utf8SliceRef summarySlice = PodUtf8Codec.AppendSlice(summary, bytes);

        MutableArticleListItemPod tmp = new()
        {
            Id = id,
            Views = views,
            CreateTimeUnixMs = PodTimeCodec.ToUnixMs(createTime),
            Category = ProjectCategoryView(categoryId, categoryName),
            Title = PodUtf8Codec.ToFixed256(title),
            Summary = summarySlice,
            IsDeleted = isDeleted == true ? (byte)1 : (byte)0,
            HasIsDeleted = isDeleted.HasValue ? (byte)1 : (byte)0,
            Reserved0 = 0,
            Reserved1 = 0
        };

        payload = bytes.WrittenMemory;
        return Cast<MutableArticleListItemPod, ArticleListItemPod>(tmp);
    }

    public static ArticleDetailPod ProjectArticleDetail(
        int id,
        int views,
        DateTime createTime,
        int categoryId,
        string categoryName,
        string title,
        string content,
        string? summary,
        out ReadOnlyMemory<byte> payload)
    {
        var bytes = new ArrayBufferWriter<byte>(512);
        Utf8SliceRef summarySlice = PodUtf8Codec.AppendSlice(summary, bytes);
        Utf8SliceRef contentSlice = PodUtf8Codec.AppendSlice(content, bytes);

        MutableArticleDetailPod tmp = new()
        {
            Id = id,
            Views = views,
            CreateTimeUnixMs = PodTimeCodec.ToUnixMs(createTime),
            Reserved0 = 0,
            Category = ProjectCategoryView(categoryId, categoryName),
            Title = PodUtf8Codec.ToFixed256(title),
            Summary = summarySlice,
            Content = contentSlice
        };

        payload = bytes.WrittenMemory;
        return Cast<MutableArticleDetailPod, ArticleDetailPod>(tmp);
    }

    public static TagPod ProjectTag(int id, string name)
        => Cast<MutableTagPod, TagPod>(new MutableTagPod { Id = id, Name = PodUtf8Codec.ToFixed128(name) });

    public static PopularArticlePod ProjectPopularArticle(int id, string title, int views)
        => Cast<MutablePopularArticlePod, PopularArticlePod>(new MutablePopularArticlePod
        {
            Id = id,
            Views = views,
            Title = PodUtf8Codec.ToFixed256(title)
        });

    public static FeaturedArticlePod ProjectFeaturedArticle(
        int id,
        string title,
        string? coverImageUrl,
        int views,
        DateTime createTime,
        int categoryId,
        string categoryName,
        out ReadOnlyMemory<byte> payload)
    {
        var bytes = new ArrayBufferWriter<byte>(256);
        Utf8SliceRef coverSlice = PodUtf8Codec.AppendSlice(coverImageUrl, bytes);

        MutableFeaturedArticlePod tmp = new()
        {
            Id = id,
            Views = views,
            CreateTimeUnixMs = PodTimeCodec.ToUnixMs(createTime),
            Category = ProjectCategoryView(categoryId, categoryName),
            Title = PodUtf8Codec.ToFixed256(title),
            CoverImageUrl = coverSlice
        };

        payload = bytes.WrittenMemory;
        return Cast<MutableFeaturedArticlePod, FeaturedArticlePod>(tmp);
    }

    public static CommentItemPod ProjectCommentItem(long id, DateTime createTime, string authorMode, string displayName, string content, out ReadOnlyMemory<byte> payload)
    {
        var bytes = new ArrayBufferWriter<byte>(256);
        Utf8SliceRef contentSlice = PodUtf8Codec.AppendSlice(content, bytes);

        MutableCommentItemPod tmp = new()
        {
            Id = id,
            CreateTimeUnixMs = PodTimeCodec.ToUnixMs(createTime),
            Content = contentSlice
        };

        payload = bytes.WrittenMemory;
        return Cast<MutableCommentItemPod, CommentItemPod>(tmp);
    }

    public static UserCommentPod ProjectUserComment(
        long id,
        int articleId,
        DateTime createTime,
        string content,
        string articleTitle,
        long? rootId,
        int moderationStatus,
        string moderationStatusLabel,
        string visibilityState,
        string visibilityReasonCode,
        bool isPubliclyVisible,
        out ReadOnlyMemory<byte> payload)
    {
        var bytes = new ArrayBufferWriter<byte>(256);
        Utf8SliceRef contentSlice = PodUtf8Codec.AppendSlice(content, bytes);

        MutableUserCommentPod tmp = new()
        {
            Id = id,
            ArticleId = articleId,
            CreateTimeUnixMs = PodTimeCodec.ToUnixMs(createTime),
            Content = contentSlice,
            ArticleTitle = PodUtf8Codec.ToFixed256(articleTitle),
            RootId = rootId ?? 0,
            ModerationStatus = moderationStatus,
            IsPubliclyVisible = isPubliclyVisible ? (byte)1 : (byte)0,
            VisibilityState = PodUtf8Codec.ToFixed32(visibilityState),
            VisibilityReasonCode = PodUtf8Codec.ToFixed64(visibilityReasonCode),
            ModerationStatusLabel = PodUtf8Codec.ToFixed64(moderationStatusLabel)
        };

        payload = bytes.WrittenMemory;
        return Cast<MutableUserCommentPod, UserCommentPod>(tmp);
    }

    public static CommentThreadItemPod ProjectCommentThreadItem(
        long id,
        long rootId,
        bool isDeleted,
        DateTime createTime,
        string authorMode,
        string displayName,
        string content,
        int replyCount,
        bool hasMoreReplies,
        int previewReplyCount,
        out ReadOnlyMemory<byte> payload)
    {
        var bytes = new ArrayBufferWriter<byte>(256);
        Utf8SliceRef contentSlice = PodUtf8Codec.AppendSlice(content, bytes);

        MutableCommentThreadItemPod tmp = new()
        {
            Id = id,
            ParentId = 0,
            RootId = rootId,
            ReplyToUserId = 0,
            ReplyToCommentId = 0,
            Depth = 0,
            IsDeleted = isDeleted ? (byte)1 : (byte)0,
            HasReplyToUserId = 0,
            Reserved = 0,
            CreateTimeUnixMs = PodTimeCodec.ToUnixMs(createTime),
            Content = contentSlice,
            ReplyCount = replyCount,
            HasMoreReplies = hasMoreReplies ? (byte)1 : (byte)0,
            PreviewReplyCount = (byte)Math.Clamp(previewReplyCount, 0, 255),
            Reserved2 = 0
        };

        payload = bytes.WrittenMemory;
        return Cast<MutableCommentThreadItemPod, CommentThreadItemPod>(tmp);
    }

    public static CommentReplyItemPod ProjectCommentReplyItem(
        long id,
        long? parentId,
        long rootId,
        int? replyToUserId,
        long? replyToCommentId,
        int depth,
        bool isDeleted,
        DateTime createTime,
        string authorMode,
        string displayName,
        string? replyToDisplayName,
        string content,
        out ReadOnlyMemory<byte> payload)
    {
        var bytes = new ArrayBufferWriter<byte>(256);
        Utf8SliceRef contentSlice = PodUtf8Codec.AppendSlice(content, bytes);

        MutableCommentReplyItemPod tmp = new()
        {
            Id = id,
            ParentId = parentId ?? 0,
            RootId = rootId,
            ReplyToUserId = replyToUserId ?? 0,
            ReplyToCommentId = replyToCommentId ?? 0,
            Depth = depth,
            IsDeleted = isDeleted ? (byte)1 : (byte)0,
            HasReplyToUserId = replyToUserId.HasValue ? (byte)1 : (byte)0,
            Reserved = 0,
            CreateTimeUnixMs = PodTimeCodec.ToUnixMs(createTime),
            Content = contentSlice
        };

        payload = bytes.WrittenMemory;
        return Cast<MutableCommentReplyItemPod, CommentReplyItemPod>(tmp);
    }

    public static CommentReplyPreviewItemPod ProjectCommentReplyPreviewItem(
        long id,
        bool isDeleted,
        DateTime createTime,
        string authorMode,
        string displayName,
        string? replyToDisplayName,
        string content,
        out ReadOnlyMemory<byte> payload)
    {
        var bytes = new ArrayBufferWriter<byte>(192);
        Utf8SliceRef contentSlice = PodUtf8Codec.AppendSlice(content, bytes);

        MutableCommentReplyPreviewItemPod tmp = new()
        {
            Id = id,
            IsDeleted = isDeleted ? (byte)1 : (byte)0,
            Reserved0 = 0,
            Reserved1 = 0,
            CreateTimeUnixMs = PodTimeCodec.ToUnixMs(createTime),
            Content = contentSlice
        };

        payload = bytes.WrittenMemory;
        return Cast<MutableCommentReplyPreviewItemPod, CommentReplyPreviewItemPod>(tmp);
    }

    public static RecentCommentPod ProjectRecentComment(
        DateTime createTime,
        string authorDisplayName,
        string authorMode,
        string? authorBadge,
        string? authorScopeLabel,
        string content,
        out ReadOnlyMemory<byte> payload)
    {
        var bytes = new ArrayBufferWriter<byte>(256);
        Utf8SliceRef authorBadgeSlice = PodUtf8Codec.AppendSlice(authorBadge, bytes);
        Utf8SliceRef authorScopeLabelSlice = PodUtf8Codec.AppendSlice(authorScopeLabel, bytes);
        Utf8SliceRef contentSlice = PodUtf8Codec.AppendSlice(content, bytes);

        MutableRecentCommentPod tmp = new()
        {
            CreateTimeUnixMs = PodTimeCodec.ToUnixMs(createTime),
            AuthorDisplayName = PodUtf8Codec.ToFixed64(authorDisplayName),
            AuthorMode = PodUtf8Codec.ToFixed32(authorMode),
            AuthorBadge = authorBadgeSlice,
            AuthorScopeLabel = authorScopeLabelSlice,
            ReservedPrivacyClass = default,
            Content = contentSlice
        };

        payload = bytes.WrittenMemory;
        return Cast<MutableRecentCommentPod, RecentCommentPod>(tmp);
    }

    public static RegionDistributionPod ProjectRegionDistribution(string region, int count)
        => Cast<MutableRegionDistributionPod, RegionDistributionPod>(new MutableRegionDistributionPod
        {
            Count = count,
            Region = PodUtf8Codec.ToFixed128(region)
        });

    public static SiteStatsPod ProjectSiteStats(
        int totalArticles,
        int totalComments,
        int trashCount,
        int totalReads,
        int humanVerifiedReads,
        int uniqueViewerKeyEstimate,
        int articleReads,
        int siteReads,
        int popularCount,
        int recentCount,
        int regionCount)
    {
        MutableSiteStatsPod tmp = new()
        {
            TotalArticles = totalArticles,
            TotalComments = totalComments,
            TrashCount = trashCount,
            TotalReads = totalReads,
            HumanVerifiedReads = humanVerifiedReads,
            UniqueViewerKeyEstimate = uniqueViewerKeyEstimate,
            ArticleReads = articleReads,
            SiteReads = siteReads,
            PopularArticles = MakeHeader(popularCount),
            RecentComments = MakeHeader(recentCount),
            RegionDistributions = MakeHeader(regionCount)
        };

        return Cast<MutableSiteStatsPod, SiteStatsPod>(tmp);
    }

    public static string ReadSlice(in Utf8SliceRef slice, ReadOnlySpan<byte> payload) => PodUtf8Codec.ReadSlice(slice, payload);

    public static string ReadSlice(in Utf8SliceRef slice, byte[] payload) => PodUtf8Codec.ReadSlice(slice, payload);

    private static ArticleCategoryViewPod ProjectCategoryView(int id, string name)
        => Cast<MutableCategoryViewPod, ArticleCategoryViewPod>(new MutableCategoryViewPod { Id = id, Name = PodUtf8Codec.ToFixed128(name) });

    private static PodEnvelopeHeader MakeHeader(int count)
        => Cast<MutableHeader, PodEnvelopeHeader>(new MutableHeader { Version = 1, Count = count, PayloadLength = 0, Reserved = 0 });

    private static TTo Cast<TFrom, TTo>(TFrom source)
        where TFrom : unmanaged
        where TTo : unmanaged
    {
        Span<TFrom> from = stackalloc TFrom[1];
        from[0] = source;
        ReadOnlySpan<byte> bytes = MemoryMarshal.AsBytes(from);
        return MemoryMarshal.Read<TTo>(bytes);
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableHeader
    {
        public int Version;
        public int Count;
        public int PayloadLength;
        public int Reserved;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableCategoryViewPod
    {
        public int Id;
        public Utf8Fixed128 Name;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableTagPod
    {
        public int Id;
        public Utf8Fixed128 Name;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableArticleListItemPod
    {
        public int Id;
        public int Views;
        public long CreateTimeUnixMs;
        public ArticleCategoryViewPod Category;
        public Utf8Fixed256 Title;
        public Utf8SliceRef Summary;
        public byte IsDeleted;
        public byte HasIsDeleted;
        public ushort Reserved0;
        public uint Reserved1;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableArticleDetailPod
    {
        public int Id;
        public int Views;
        public long CreateTimeUnixMs;
        public byte Reserved0;
        public byte Reserved1;
        public byte Reserved2;
        public byte Reserved3;
        public ArticleCategoryViewPod Category;
        public Utf8Fixed256 Title;
        public Utf8SliceRef Summary;
        public Utf8SliceRef Content;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutablePopularArticlePod
    {
        public int Id;
        public int Views;
        public Utf8Fixed256 Title;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableFeaturedArticlePod
    {
        public int Id;
        public int Views;
        public long CreateTimeUnixMs;
        public ArticleCategoryViewPod Category;
        public Utf8Fixed256 Title;
        public Utf8SliceRef CoverImageUrl;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableCommentItemPod
    {
        public long Id;
        public long CreateTimeUnixMs;
        public Utf8SliceRef Content;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableUserCommentPod
    {
        public long Id;
        public int ArticleId;
        public long CreateTimeUnixMs;
        public Utf8SliceRef Content;
        public Utf8Fixed256 ArticleTitle;
        public long RootId;
        public int ModerationStatus;
        public byte IsPubliclyVisible;
        public byte Reserved0;
        public byte Reserved1;
        public byte Reserved2;
        public Utf8Fixed32 VisibilityState;
        public Utf8Fixed64 VisibilityReasonCode;
        public Utf8Fixed64 ModerationStatusLabel;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableCommentThreadItemPod
    {
        public long Id;
        public long ParentId;
        public long RootId;
        public int ReplyToUserId;
        public long ReplyToCommentId;
        public int Depth;
        public byte IsDeleted;
        public byte HasReplyToUserId;
        public ushort Reserved;
        public long CreateTimeUnixMs;
        public Utf8SliceRef Content;
        public int ReplyCount;
        public byte HasMoreReplies;
        public byte PreviewReplyCount;
        public ushort Reserved2;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableCommentReplyItemPod
    {
        public long Id;
        public long ParentId;
        public long RootId;
        public int ReplyToUserId;
        public long ReplyToCommentId;
        public int Depth;
        public byte IsDeleted;
        public byte HasReplyToUserId;
        public ushort Reserved;
        public long CreateTimeUnixMs;
        public Utf8SliceRef Content;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableCommentReplyPreviewItemPod
    {
        public long Id;
        public byte IsDeleted;
        public byte Reserved0;
        public ushort Reserved1;
        public long CreateTimeUnixMs;
        public Utf8SliceRef Content;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableRecentCommentPod
    {
        public long CreateTimeUnixMs;
        public Utf8Fixed64 AuthorDisplayName;
        public Utf8Fixed32 AuthorMode;
        public Utf8SliceRef AuthorBadge;
        public Utf8SliceRef AuthorScopeLabel;
        public Utf8SliceRef ReservedPrivacyClass;
        public Utf8SliceRef Content;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableRegionDistributionPod
    {
        public int Count;
        public Utf8Fixed128 Region;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableSiteStatsPod
    {
        public int TotalArticles;
        public int TotalComments;
        public int TrashCount;
        public int TotalReads;
        public int HumanVerifiedReads;
        public int UniqueViewerKeyEstimate;
        public int ArticleReads;
        public int SiteReads;
        public PodEnvelopeHeader PopularArticles;
        public PodEnvelopeHeader RecentComments;
        public PodEnvelopeHeader RegionDistributions;
    }
}
