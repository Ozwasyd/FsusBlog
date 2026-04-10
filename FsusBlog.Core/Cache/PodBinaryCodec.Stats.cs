using FsusBlog.Core.Mapping.Codecs;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Mapping.Projectors;
using FsusBlog.Shared.Contracts.Models;

namespace FsusBlog.Core.Cache;

public static partial class PodBinaryCodec
{
    public static byte[] EncodeSiteStats(SiteStatsCoreModel stats)
    {
        var writer = new BinaryPodWriter();
        writer.WritePod(stats.Pod);

        writer.WriteInt32(stats.PopularArticles.Count);
        foreach (PopularArticleCoreModel item in stats.PopularArticles)
        {
            writer.WritePod(item.Pod);
        }

        writer.WriteInt32(stats.RecentComments.Count);
        foreach (RecentCommentCoreModel item in stats.RecentComments)
        {
            writer.WritePod(item.Pod);
            _ = PodProjector.ProjectRecentComment(item.UserId, item.CreateTime, item.UserName, item.Content, out byte[] payload);
            writer.WriteBytes(payload);
        }

        writer.WriteInt32(stats.RegionDistributions.Count);
        foreach (RegionDistributionCoreModel item in stats.RegionDistributions)
        {
            writer.WritePod(item.Pod);
        }

        return writer.ToArray();
    }

    public static bool TryDecodeSiteStats(ReadOnlyMemory<byte> bytes, out SiteStatsCoreModel stats)
    {
        var reader = new BinaryPodReader(bytes.Span);
        if (!reader.TryReadPod(out SiteStatsPod pod))
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
            if (!reader.TryReadPod(out PopularArticlePod itemPod))
            {
                stats = default;
                return false;
            }

            popular.Add(new PopularArticleCoreModel(itemPod, itemPod.Id, PodUtf8Codec.FromFixed256(itemPod.Title), itemPod.Views));
        }

        if (!reader.TryReadInt32(out int recentCount) || recentCount < 0)
        {
            stats = default;
            return false;
        }

        var recent = new List<RecentCommentCoreModel>(recentCount);
        for (int i = 0; i < recentCount; i++)
        {
            if (!reader.TryReadPod(out RecentCommentPod itemPod) || !reader.TryReadBytes(out ReadOnlySpan<byte> payloadSpan))
            {
                stats = default;
                return false;
            }

            byte[] payload = payloadSpan.ToArray();
            string userName = PodUtf8Codec.FromFixed64(itemPod.UserName);
            string content = PodProjector.ReadSlice(itemPod.Content, payload);
            DateTime createTime = PodTimeCodec.FromUnixMs(itemPod.CreateTimeUnixMs);
            int? userId = itemPod.HasUserId == 1 ? itemPod.UserId : null;
            recent.Add(new RecentCommentCoreModel(itemPod, userId, userName, content, createTime));
        }

        if (!reader.TryReadInt32(out int regionCount) || regionCount < 0)
        {
            stats = default;
            return false;
        }

        var regions = new List<RegionDistributionCoreModel>(regionCount);
        for (int i = 0; i < regionCount; i++)
        {
            if (!reader.TryReadPod(out RegionDistributionPod itemPod))
            {
                stats = default;
                return false;
            }

            regions.Add(new RegionDistributionCoreModel(itemPod, PodUtf8Codec.FromFixed128(itemPod.Region), itemPod.Count));
        }

        stats = new SiteStatsCoreModel(
            pod,
            pod.TotalArticles,
            pod.TotalComments,
            pod.TrashCount,
            pod.TotalVisits,
            pod.RegisteredVisits,
            pod.AnonymousVisits,
            popular,
            recent,
            regions);

        return reader.IsConsumed;
    }
}
