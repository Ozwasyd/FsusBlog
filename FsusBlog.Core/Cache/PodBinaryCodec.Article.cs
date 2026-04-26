using FsusBlog.Core.Mapping.Codecs;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Mapping.Projectors;
using FsusBlog.Shared.Contracts.Models;
using System.Buffers;

namespace FsusBlog.Core.Cache;

public static partial class PodBinaryCodec
{
    public static void WriteArticlePage(CorePageResult<ArticleListCoreModel> page, IBufferWriter<byte> destination)
    {
        var writer = new BinaryPodWriter(destination);
        writer.WriteInt32(page.Total);
        writer.WriteInt32(page.Items.Count);

        foreach (ArticleListCoreModel item in page.Items)
        {
            WriteArticleListItem(ref writer, item);
        }
    }

    public static byte[] EncodeArticlePage(CorePageResult<ArticleListCoreModel> page)
        => EncodeToArray(1024, writer => WriteArticlePage(page, writer));

    public static bool TryDecodeArticlePage(ReadOnlyMemory<byte> bytes, out CorePageResult<ArticleListCoreModel> page)
    {
        var reader = new BinaryPodReader(bytes.Span);
        if (!reader.TryReadInt32(out int total) || !reader.TryReadInt32(out int count) || count < 0)
        {
            page = default;
            return false;
        }

        var items = new List<ArticleListCoreModel>(count);
        for (int i = 0; i < count; i++)
        {
            if (!TryReadArticleListItem(ref reader, out ArticleListCoreModel item))
            {
                page = default;
                return false;
            }

            items.Add(item);
        }

        page = new CorePageResult<ArticleListCoreModel>(items, total);
        return reader.IsConsumed;
    }

    public static void WriteArticleDetail(ArticleDetailCoreModel item, IBufferWriter<byte> destination)
    {
        ArticleDetailPod pod = PodProjector.ProjectArticleDetail(
            item.Id,
            item.Views,
            item.CreateTime,
            item.Category.Id,
            item.Category.Name,
            item.Title,
            item.Content,
            item.Summary,
            out ReadOnlyMemory<byte> payload);

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(pod);
        writer.WriteInt32(item.Tags.Count);
        foreach (TagCoreModel tag in item.Tags)
        {
            writer.WritePod(PodProjector.ProjectTag(tag.Id, tag.Name));
        }

        writer.WriteBytes(payload.Span);
        writer.WriteByte(item.IsDeleted ? (byte)1 : (byte)0);
    }

    public static byte[] EncodeArticleDetail(ArticleDetailCoreModel item)
        => EncodeToArray(2048 + item.Content.Length, writer => WriteArticleDetail(item, writer));

    public static bool TryDecodeArticleDetail(ReadOnlyMemory<byte> bytes, out ArticleDetailCoreModel item)
    {
        var reader = new BinaryPodReader(bytes.Span);
        if (!reader.TryReadPod(out ArticleDetailPod pod) || !reader.TryReadInt32(out int tagCount) || tagCount < 0)
        {
            item = default;
            return false;
        }

        var tags = new List<TagCoreModel>(tagCount);
        for (int i = 0; i < tagCount; i++)
        {
            if (!reader.TryReadPod(out TagPod tagPod))
            {
                item = default;
                return false;
            }

            tags.Add(new TagCoreModel(tagPod.Id, PodUtf8Codec.FromFixed128(tagPod.Name)));
        }

        if (!reader.TryReadBytes(out ReadOnlySpan<byte> payloadSpan) || !reader.TryReadByte(out byte isDeleted))
        {
            item = default;
            return false;
        }

        string title = PodUtf8Codec.FromFixed256(pod.Title);
        string categoryName = PodUtf8Codec.FromFixed128(pod.Category.Name);
        string summary = PodProjector.ReadSlice(pod.Summary, payloadSpan);
        string content = PodProjector.ReadSlice(pod.Content, payloadSpan);
        DateTime createTime = PodTimeCodec.FromUnixMs(pod.CreateTimeUnixMs);
        var category = new ArticleCategoryCoreModel(pod.Category.Id, categoryName);
        int wordCount = content.Count(static ch => !char.IsWhiteSpace(ch));
        int estimatedReadingMinutes = Math.Max(1, (wordCount + 299) / 300);
        bool showReadingNotice = wordCount > 5_000;

        item = new ArticleDetailCoreModel(
            pod,
            pod.Id,
            title,
            content,
            summary,
            pod.Views,
            wordCount,
            estimatedReadingMinutes,
            showReadingNotice,
            createTime,
            category,
            tags,
            pod.Category.Id,
            isDeleted == 1);
        return reader.IsConsumed;
    }

    public static void WriteArticleSearch(IReadOnlyList<ArticleListCoreModel> items, IBufferWriter<byte> destination)
    {
        var writer = new BinaryPodWriter(destination);
        writer.WriteInt32(items.Count);
        foreach (ArticleListCoreModel item in items)
        {
            WriteArticleListItem(ref writer, item);
        }
    }

    public static byte[] EncodeArticleSearch(IReadOnlyList<ArticleListCoreModel> items)
        => EncodeToArray(1024, writer => WriteArticleSearch(items, writer));

    public static bool TryDecodeArticleSearch(ReadOnlyMemory<byte> bytes, out IReadOnlyList<ArticleListCoreModel> items)
    {
        var reader = new BinaryPodReader(bytes.Span);
        if (!reader.TryReadInt32(out int count) || count < 0)
        {
            items = Array.Empty<ArticleListCoreModel>();
            return false;
        }

        var list = new List<ArticleListCoreModel>(count);
        for (int i = 0; i < count; i++)
        {
            if (!TryReadArticleListItem(ref reader, out ArticleListCoreModel item))
            {
                items = Array.Empty<ArticleListCoreModel>();
                return false;
            }

            list.Add(item);
        }

        items = list;
        return reader.IsConsumed;
    }

    public static void WritePopularArticles(IReadOnlyList<PopularArticleCoreModel> items, IBufferWriter<byte> destination)
    {
        var writer = new BinaryPodWriter(destination);
        writer.WriteInt32(items.Count);

        foreach (PopularArticleCoreModel item in items)
        {
            writer.WritePod(item.Pod);
        }
    }

    public static byte[] EncodePopularArticles(IReadOnlyList<PopularArticleCoreModel> items)
        => EncodeToArray(256 + items.Count * 300, writer => WritePopularArticles(items, writer));

    public static bool TryDecodePopularArticles(ReadOnlyMemory<byte> bytes, out IReadOnlyList<PopularArticleCoreModel> items)
    {
        var reader = new BinaryPodReader(bytes.Span);
        if (!reader.TryReadInt32(out int count) || count < 0)
        {
            items = Array.Empty<PopularArticleCoreModel>();
            return false;
        }

        var list = new List<PopularArticleCoreModel>(count);
        for (int i = 0; i < count; i++)
        {
            if (!reader.TryReadPod(out PopularArticlePod pod))
            {
                items = Array.Empty<PopularArticleCoreModel>();
                return false;
            }

            list.Add(new PopularArticleCoreModel(pod, pod.Id, PodUtf8Codec.FromFixed256(pod.Title), pod.Views));
        }

        items = list;
        return reader.IsConsumed;
    }
}
