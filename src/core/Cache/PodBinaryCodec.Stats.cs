using FsusBlog.Core.Mapping.Codecs;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Mapping.Projectors;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Primitives;
using System.Buffers;
using System.Runtime.InteropServices;

namespace FsusBlog.Core.Cache;

public static partial class PodBinaryCodec
{
    public static void WriteSiteStats(SiteStatsCoreModel stats, IBufferWriter<byte> destination)
    {
        var blob = new List<byte>(1024);
        var popularTitles = new List<Utf8SliceRef>(stats.PopularArticles.Count);
        foreach (PopularArticleCoreModel item in stats.PopularArticles)
        {
            popularTitles.Add(PodUtf8Codec.AppendSlice(item.Title, blob));
        }

        var recentRecords = BuildRecentCommentRecords(stats.RecentComments, blob);
        var regionNames = new List<Utf8SliceRef>(stats.RegionDistributions.Count);
        foreach (RegionDistributionCoreModel item in stats.RegionDistributions)
        {
            regionNames.Add(PodUtf8Codec.AppendSlice(item.Region, blob));
        }

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(stats.Pod);
        writer.WriteBytes(CollectionsMarshal.AsSpan(blob));

        writer.WriteInt32(stats.PopularArticles.Count);
        for (int i = 0; i < stats.PopularArticles.Count; i++)
        {
            writer.WriteInt32(stats.PopularArticles[i].Id);
            writer.WriteInt32(stats.PopularArticles[i].Views);
            writer.WriteSliceRef(popularTitles[i]);
        }

        writer.WriteInt32(recentRecords.Count);
        foreach (RecentCommentRecord item in recentRecords)
        {
            WriteRecentCommentRecord(ref writer, item);
        }

        writer.WriteInt32(stats.RegionDistributions.Count);
        for (int i = 0; i < stats.RegionDistributions.Count; i++)
        {
            writer.WriteInt32(stats.RegionDistributions[i].Count);
            writer.WriteSliceRef(regionNames[i]);
        }
    }

    public static byte[] EncodeSiteStats(SiteStatsCoreModel stats)
        => EncodeToArray(512 + stats.PopularArticles.Count * 24 + stats.RecentComments.Count * 48 + stats.RegionDistributions.Count * 16, writer => WriteSiteStats(stats, writer));

    public static bool TryDecodeSiteStats(ReadOnlyMemory<byte> bytes, out SiteStatsCoreModel stats)
    {
        var reader = new BinaryPodReader(bytes.Span);
        if (!reader.TryReadPod(out SiteStatsPod pod) || !reader.TryReadBytes(out ReadOnlySpan<byte> blob))
        {
            stats = default;
            return false;
        }

        if (!reader.TryReadInt32(out int popularCount) || popularCount < 0)
        {
            stats = default;
            return false;
        }

        var popular = new List<PopularArticleCoreModel>(popularCount);
        for (int i = 0; i < popularCount; i++)
        {
            if (!reader.TryReadInt32(out int id) ||
                !reader.TryReadInt32(out int views) ||
                !reader.TryReadSliceRef(out Utf8SliceRef titleSlice))
            {
                stats = default;
                return false;
            }

            string title = PodUtf8Codec.ReadSlice(titleSlice, blob);
            popular.Add(new PopularArticleCoreModel(PodProjector.ProjectPopularArticle(id, title, views), id, title, views));
        }

        if (!reader.TryReadInt32(out int recentCount) || recentCount < 0)
        {
            stats = default;
            return false;
        }

        var recent = new List<RecentCommentCoreModel>(recentCount);
        for (int i = 0; i < recentCount; i++)
        {
            if (!TryReadRecentCommentRecord(ref reader, blob, out RecentCommentCoreModel recentItem))
            {
                stats = default;
                return false;
            }

            recent.Add(recentItem);
        }

        if (!reader.TryReadInt32(out int regionCount) || regionCount < 0)
        {
            stats = default;
            return false;
        }

        var regions = new List<RegionDistributionCoreModel>(regionCount);
        for (int i = 0; i < regionCount; i++)
        {
            if (!reader.TryReadInt32(out int count) ||
                !reader.TryReadSliceRef(out Utf8SliceRef regionSlice))
            {
                stats = default;
                return false;
            }

            string region = PodUtf8Codec.ReadSlice(regionSlice, blob);
            RegionDistributionPod regionPod = PodProjector.ProjectRegionDistribution(region, count);
            regions.Add(new RegionDistributionCoreModel(regionPod, region, count));
        }

        stats = new SiteStatsCoreModel(
            pod,
            pod.TotalArticles,
            pod.TotalComments,
            pod.TrashCount,
            pod.TotalReads,
            pod.HumanVerifiedReads,
            pod.UniqueViewerKeyEstimate,
            pod.ArticleReads,
            pod.SiteReads,
            popular,
            recent,
            regions);

        return reader.IsConsumed;
    }

    public static void WriteRecentCommentStats(IReadOnlyList<RecentCommentCoreModel> comments, IBufferWriter<byte> destination)
    {
        var blob = new List<byte>(Math.Max(256, comments.Count * 128));
        var records = BuildRecentCommentRecords(comments, blob);
        var writer = new BinaryPodWriter(destination);
        writer.WriteInt32(comments.Count);
        writer.WriteBytes(CollectionsMarshal.AsSpan(blob));
        foreach (RecentCommentRecord item in records)
        {
            WriteRecentCommentRecord(ref writer, item);
        }
    }

    public static byte[] EncodeRecentCommentStats(IReadOnlyList<RecentCommentCoreModel> comments)
        => EncodeToArray(64 + comments.Count * 64, writer => WriteRecentCommentStats(comments, writer));

    public static bool TryDecodeRecentCommentStats(ReadOnlyMemory<byte> bytes, out List<RecentCommentCoreModel> comments)
    {
        var reader = new BinaryPodReader(bytes.Span);
        if (!reader.TryReadInt32(out int count) || count < 0 || !reader.TryReadBytes(out ReadOnlySpan<byte> blob))
        {
            comments = [];
            return false;
        }

        comments = new List<RecentCommentCoreModel>(count);
        for (int i = 0; i < count; i++)
        {
            if (!TryReadRecentCommentRecord(ref reader, blob, out RecentCommentCoreModel item))
            {
                comments = [];
                return false;
            }

            comments.Add(item);
        }

        return reader.IsConsumed;
    }

    public static void WriteRegionStats(IReadOnlyList<RegionDistributionCoreModel> regions, IBufferWriter<byte> destination)
    {
        var blob = new List<byte>(Math.Max(128, regions.Count * 32));
        var names = new List<Utf8SliceRef>(regions.Count);
        foreach (RegionDistributionCoreModel item in regions)
        {
            names.Add(PodUtf8Codec.AppendSlice(item.Region, blob));
        }

        var writer = new BinaryPodWriter(destination);
        writer.WriteInt32(regions.Count);
        writer.WriteBytes(CollectionsMarshal.AsSpan(blob));
        for (int i = 0; i < regions.Count; i++)
        {
            writer.WriteInt32(regions[i].Count);
            writer.WriteSliceRef(names[i]);
        }
    }

    public static byte[] EncodeRegionStats(IReadOnlyList<RegionDistributionCoreModel> regions)
        => EncodeToArray(64 + regions.Count * 16, writer => WriteRegionStats(regions, writer));

    public static bool TryDecodeRegionStats(ReadOnlyMemory<byte> bytes, out List<RegionDistributionCoreModel> regions)
    {
        var reader = new BinaryPodReader(bytes.Span);
        if (!reader.TryReadInt32(out int count) || count < 0 || !reader.TryReadBytes(out ReadOnlySpan<byte> blob))
        {
            regions = [];
            return false;
        }

        regions = new List<RegionDistributionCoreModel>(count);
        for (int i = 0; i < count; i++)
        {
            if (!reader.TryReadInt32(out int regionCount) || !reader.TryReadSliceRef(out Utf8SliceRef regionName))
            {
                regions = [];
                return false;
            }

            string region = PodUtf8Codec.ReadSlice(regionName, blob);
            RegionDistributionPod pod = PodProjector.ProjectRegionDistribution(region, regionCount);
            regions.Add(new RegionDistributionCoreModel(pod, region, regionCount));
        }

        return reader.IsConsumed;
    }

    private static List<RecentCommentRecord> BuildRecentCommentRecords(IReadOnlyList<RecentCommentCoreModel> comments, List<byte> blob)
    {
        var records = new List<RecentCommentRecord>(comments.Count);
        foreach (RecentCommentCoreModel item in comments)
        {
            records.Add(new RecentCommentRecord(
                PodTimeCodec.ToUnixMs(item.CreateTime),
                PodUtf8Codec.AppendSlice(item.AuthorDisplayName, blob),
                PodUtf8Codec.AppendSlice(item.AuthorMode, blob),
                PodUtf8Codec.AppendSlice(item.AuthorBadge, blob),
                PodUtf8Codec.AppendSlice(item.AuthorScopeLabel, blob),
                default,
                PodUtf8Codec.AppendSlice(item.Content, blob)));
        }

        return records;
    }

    private static void WriteRecentCommentRecord(ref BinaryPodWriter writer, RecentCommentRecord item)
    {
        writer.WriteInt64(item.CreateTimeUnixMs);
        writer.WriteSliceRef(item.AuthorDisplayName);
        writer.WriteSliceRef(item.AuthorMode);
        writer.WriteSliceRef(item.AuthorBadge);
        writer.WriteSliceRef(item.AuthorScopeLabel);
        writer.WriteSliceRef(item.ReservedPrivacyClass);
        writer.WriteSliceRef(item.Content);
    }

    private static bool TryReadRecentCommentRecord(ref BinaryPodReader reader, ReadOnlySpan<byte> blob, out RecentCommentCoreModel item)
    {
        if (!reader.TryReadInt64(out long createTimeUnixMs) ||
            !reader.TryReadSliceRef(out Utf8SliceRef authorDisplayNameSlice) ||
            !reader.TryReadSliceRef(out Utf8SliceRef authorModeSlice) ||
            !reader.TryReadSliceRef(out Utf8SliceRef authorBadgeSlice) ||
            !reader.TryReadSliceRef(out Utf8SliceRef authorScopeLabelSlice) ||
            !reader.TryReadSliceRef(out Utf8SliceRef reservedPrivacyClassSlice) ||
            !reader.TryReadSliceRef(out Utf8SliceRef contentSlice))
        {
            item = default;
            return false;
        }

        string authorDisplayName = PodUtf8Codec.ReadSlice(authorDisplayNameSlice, blob);
        string authorMode = PodUtf8Codec.ReadSlice(authorModeSlice, blob);
        string? authorBadge = EmptyToNull(PodUtf8Codec.ReadSlice(authorBadgeSlice, blob));
        string? authorScopeLabel = EmptyToNull(PodUtf8Codec.ReadSlice(authorScopeLabelSlice, blob));
        if (reservedPrivacyClassSlice.Length != 0)
        {
            item = default;
            return false;
        }
        string content = PodUtf8Codec.ReadSlice(contentSlice, blob);
        DateTime createTime = PodTimeCodec.FromUnixMs(createTimeUnixMs);
        RecentCommentPod pod = PodProjector.ProjectRecentComment(
            createTime,
            authorDisplayName,
            authorMode,
            authorBadge,
            authorScopeLabel,
            content,
            out _);
        item = new RecentCommentCoreModel(pod, authorDisplayName, authorMode, authorBadge, authorScopeLabel, content, createTime);
        return true;
    }

    private readonly record struct RecentCommentRecord(
        long CreateTimeUnixMs,
        Utf8SliceRef AuthorDisplayName,
        Utf8SliceRef AuthorMode,
        Utf8SliceRef AuthorBadge,
        Utf8SliceRef AuthorScopeLabel,
        Utf8SliceRef ReservedPrivacyClass,
        Utf8SliceRef Content);
}
