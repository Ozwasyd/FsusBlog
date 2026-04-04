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
        string? snippet,
        bool? isDeleted,
        out byte[] payload)
    {
        List<byte> bytes = [];
        Utf8SliceRef summarySlice = PodUtf8Codec.AppendSlice(summary, bytes);
        Utf8SliceRef snippetSlice = PodUtf8Codec.AppendSlice(snippet, bytes);

        MutableArticleListItemPod tmp = new()
        {
            Id = id,
            Views = views,
            CreateTimeUnixMs = PodTimeCodec.ToUnixMs(createTime),
            Category = ProjectCategoryView(categoryId, categoryName),
            Title = PodUtf8Codec.ToFixed256(title),
            Summary = summarySlice,
            Snippet = snippetSlice,
            IsDeleted = isDeleted == true ? (byte)1 : (byte)0,
            HasIsDeleted = isDeleted.HasValue ? (byte)1 : (byte)0,
            Reserved = 0
        };

        payload = [.. bytes];
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
        out byte[] payload)
    {
        List<byte> bytes = [];
        Utf8SliceRef summarySlice = PodUtf8Codec.AppendSlice(summary, bytes);
        Utf8SliceRef contentSlice = PodUtf8Codec.AppendSlice(content, bytes);

        MutableArticleDetailPod tmp = new()
        {
            Id = id,
            Views = views,
            CreateTimeUnixMs = PodTimeCodec.ToUnixMs(createTime),
            Category = ProjectCategoryView(categoryId, categoryName),
            Title = PodUtf8Codec.ToFixed256(title),
            Summary = summarySlice,
            Content = contentSlice
        };

        payload = [.. bytes];
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

    public static CommentItemPod ProjectCommentItem(long id, DateTime createTime, string userName, string content, out byte[] payload)
    {
        List<byte> bytes = [];
        Utf8SliceRef contentSlice = PodUtf8Codec.AppendSlice(content, bytes);

        MutableCommentItemPod tmp = new()
        {
            Id = id,
            CreateTimeUnixMs = PodTimeCodec.ToUnixMs(createTime),
            UserName = PodUtf8Codec.ToFixed64(userName),
            Content = contentSlice
        };

        payload = [.. bytes];
        return Cast<MutableCommentItemPod, CommentItemPod>(tmp);
    }

    public static UserCommentPod ProjectUserComment(long id, int articleId, DateTime createTime, string content, string articleTitle, out byte[] payload)
    {
        List<byte> bytes = [];
        Utf8SliceRef contentSlice = PodUtf8Codec.AppendSlice(content, bytes);

        MutableUserCommentPod tmp = new()
        {
            Id = id,
            ArticleId = articleId,
            CreateTimeUnixMs = PodTimeCodec.ToUnixMs(createTime),
            Content = contentSlice,
            ArticleTitle = PodUtf8Codec.ToFixed256(articleTitle)
        };

        payload = [.. bytes];
        return Cast<MutableUserCommentPod, UserCommentPod>(tmp);
    }

    public static RecentCommentPod ProjectRecentComment(int? userId, DateTime createTime, string userName, string content, out byte[] payload)
    {
        List<byte> bytes = [];
        Utf8SliceRef contentSlice = PodUtf8Codec.AppendSlice(content, bytes);

        MutableRecentCommentPod tmp = new()
        {
            UserId = userId.GetValueOrDefault(),
            HasUserId = userId.HasValue ? (byte)1 : (byte)0,
            Reserved0 = 0,
            Reserved1 = 0,
            CreateTimeUnixMs = PodTimeCodec.ToUnixMs(createTime),
            UserName = PodUtf8Codec.ToFixed64(userName),
            Content = contentSlice
        };

        payload = [.. bytes];
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
        int totalVisits,
        int registeredVisits,
        int anonymousVisits,
        int popularCount,
        int recentCount,
        int regionCount)
    {
        MutableSiteStatsPod tmp = new()
        {
            TotalArticles = totalArticles,
            TotalComments = totalComments,
            TrashCount = trashCount,
            TotalVisits = totalVisits,
            RegisteredVisits = registeredVisits,
            AnonymousVisits = anonymousVisits,
            PopularArticles = MakeHeader(popularCount),
            RecentComments = MakeHeader(recentCount),
            RegionDistributions = MakeHeader(regionCount)
        };

        return Cast<MutableSiteStatsPod, SiteStatsPod>(tmp);
    }

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
    private struct MutableHeader { public int Version; public int Count; public int PayloadLength; public int Reserved; }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableCategoryViewPod { public int Id; public Utf8Fixed128 Name; }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableTagPod { public int Id; public Utf8Fixed128 Name; }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableArticleListItemPod
    {
        public int Id;
        public int Views;
        public long CreateTimeUnixMs;
        public ArticleCategoryViewPod Category;
        public Utf8Fixed256 Title;
        public Utf8SliceRef Summary;
        public Utf8SliceRef Snippet;
        public byte IsDeleted;
        public byte HasIsDeleted;
        public ushort Reserved;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableArticleDetailPod
    {
        public int Id;
        public int Views;
        public long CreateTimeUnixMs;
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
    private struct MutableCommentItemPod
    {
        public long Id;
        public long CreateTimeUnixMs;
        public Utf8Fixed64 UserName;
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
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableRecentCommentPod
    {
        public int UserId;
        public byte HasUserId;
        public byte Reserved0;
        public ushort Reserved1;
        public long CreateTimeUnixMs;
        public Utf8Fixed64 UserName;
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
        public int TotalVisits;
        public int RegisteredVisits;
        public int AnonymousVisits;
        public PodEnvelopeHeader PopularArticles;
        public PodEnvelopeHeader RecentComments;
        public PodEnvelopeHeader RegionDistributions;
    }
}
