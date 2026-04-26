using FsusBlog.Core.Mapping.Codecs;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Shared.Contracts.Models;
using System.Buffers;

namespace FsusBlog.Core.Cache;

public static partial class PodBinaryCodec
{
    public static void WriteSiteStats(SiteStatsCoreModel stats, IBufferWriter<byte> destination)
    {
        var writer = new BinaryPodWriter(destination);
        writer.WritePod(stats.Pod);

        writer.WriteInt32(stats.PopularArticles.Count);
        foreach (PopularArticleCoreModel item in stats.PopularArticles)
        {
            writer.WritePod(item.Pod);
        }
    }

    public static byte[] EncodeSiteStats(SiteStatsCoreModel stats)
        => EncodeToArray(512 + stats.PopularArticles.Count * 300, writer => WriteSiteStats(stats, writer));

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

        stats = new SiteStatsCoreModel(
            pod,
            pod.TotalArticles,
            pod.TotalComments,
            pod.TrashCount,
            pod.TotalVisits,
            pod.RegisteredVisits,
            pod.AnonymousVisits,
            popular,
            [],
            []);

        return reader.IsConsumed;
    }
}
