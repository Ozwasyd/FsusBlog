using System.Buffers.Binary;
using System.Runtime.InteropServices;
using FsusBlog.Core.Mapping.Codecs;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Mapping.Projectors;
using FsusBlog.Shared.Contracts.Models;

namespace FsusBlog.Core.Cache;

public static class PodBinaryCodec
{
    public static byte[] EncodeArticlePage(CorePageResult<ArticleListCoreModel> page)
    {
        var writer = new BinaryPodWriter();
        writer.WriteInt32(page.Total);
        writer.WriteInt32(page.Items.Count);

        foreach (ArticleListCoreModel item in page.Items)
        {
            WriteArticleListItem(ref writer, item);
        }

        return writer.ToArray();
    }

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

    public static byte[] EncodeArticleDetail(ArticleDetailCoreModel item)
    {
        var writer = new BinaryPodWriter();
        writer.WritePod(item.Pod);
        writer.WriteInt32(item.Tags.Count);
        foreach (TagCoreModel tag in item.Tags)
        {
            writer.WritePod(PodProjector.ProjectTag(tag.Id, tag.Name));
        }

        _ = PodProjector.ProjectArticleDetail(
            item.Id,
            item.Views,
            item.CreateTime,
            item.Category.Id,
            item.Category.Name,
            item.Title,
            item.Content,
            item.Summary,
            out byte[] payload);

        writer.WriteBytes(payload);
        writer.WriteByte(item.IsDeleted ? (byte)1 : (byte)0);
        return writer.ToArray();
    }

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

        byte[] payload = payloadSpan.ToArray();
        string title = PodUtf8Codec.FromFixed256(pod.Title);
        string categoryName = PodUtf8Codec.FromFixed128(pod.Category.Name);
        string summary = PodProjector.ReadSlice(pod.Summary, payload);
        string content = PodProjector.ReadSlice(pod.Content, payload);
        DateTime createTime = PodTimeCodec.FromUnixMs(pod.CreateTimeUnixMs);
        var category = new ArticleCategoryCoreModel(pod.Category.Id, categoryName);

        item = new ArticleDetailCoreModel(pod, pod.Id, title, content, summary, pod.Views, createTime, category, tags, pod.Category.Id, isDeleted == 1);
        return reader.IsConsumed;
    }

    public static byte[] EncodeArticleSearch(IReadOnlyList<ArticleListCoreModel> items)
    {
        var writer = new BinaryPodWriter();
        writer.WriteInt32(items.Count);
        foreach (ArticleListCoreModel item in items)
        {
            WriteArticleListItem(ref writer, item);
        }

        return writer.ToArray();
    }

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

    public static byte[] EncodePopularArticles(IReadOnlyList<PopularArticleCoreModel> items)
    {
        var writer = new BinaryPodWriter();
        writer.WriteInt32(items.Count);

        foreach (PopularArticleCoreModel item in items)
        {
            writer.WritePod(item.Pod);
        }

        return writer.ToArray();
    }

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

    public static byte[] EncodeCommentCursor(CoreCursorResult<CommentQueryCoreModel> cursor)
    {
        var writer = new BinaryPodWriter();
        writer.WriteInt64(cursor.NextCursor ?? 0);
        writer.WriteByte(cursor.HasMore ? (byte)1 : (byte)0);
        writer.WriteInt32(cursor.Data.Count);

        foreach (CommentQueryCoreModel item in cursor.Data)
        {
            writer.WritePod(item.Pod);
            _ = PodProjector.ProjectCommentItem(item.Id, item.CreateTime, item.UserName, item.Content, out byte[] payload);
            writer.WriteBytes(payload);
        }

        return writer.ToArray();
    }

    public static bool TryDecodeCommentCursor(ReadOnlyMemory<byte> bytes, out CoreCursorResult<CommentQueryCoreModel> cursor)
    {
        var reader = new BinaryPodReader(bytes.Span);
        if (!reader.TryReadInt64(out long nextCursor) || !reader.TryReadByte(out byte hasMore) || !reader.TryReadInt32(out int count) || count < 0)
        {
            cursor = default;
            return false;
        }

        var data = new List<CommentQueryCoreModel>(count);
        for (int i = 0; i < count; i++)
        {
            if (!reader.TryReadPod(out CommentItemPod pod) || !reader.TryReadBytes(out ReadOnlySpan<byte> payloadSpan))
            {
                cursor = default;
                return false;
            }

            byte[] payload = payloadSpan.ToArray();
            string userName = PodUtf8Codec.FromFixed64(pod.UserName);
            string content = PodProjector.ReadSlice(pod.Content, payload);
            DateTime createTime = PodTimeCodec.FromUnixMs(pod.CreateTimeUnixMs);
            data.Add(new CommentQueryCoreModel(pod, pod.Id, content, createTime, userName));
        }

        cursor = new CoreCursorResult<CommentQueryCoreModel>(data, nextCursor == 0 ? null : nextCursor, hasMore == 1);
        return reader.IsConsumed;
    }

    public static byte[] EncodeUserCommentCursor(CoreCursorResult<UserCommentCoreModel> cursor)
    {
        var writer = new BinaryPodWriter();
        writer.WriteInt64(cursor.NextCursor ?? 0);
        writer.WriteByte(cursor.HasMore ? (byte)1 : (byte)0);
        writer.WriteInt32(cursor.Data.Count);

        foreach (UserCommentCoreModel item in cursor.Data)
        {
            writer.WritePod(item.Pod);
            _ = PodProjector.ProjectUserComment(item.Id, item.ArticleId, item.CreateTime, item.Content, item.ArticleTitle, out byte[] payload);
            writer.WriteBytes(payload);
        }

        return writer.ToArray();
    }

    public static bool TryDecodeUserCommentCursor(ReadOnlyMemory<byte> bytes, out CoreCursorResult<UserCommentCoreModel> cursor)
    {
        var reader = new BinaryPodReader(bytes.Span);
        if (!reader.TryReadInt64(out long nextCursor) || !reader.TryReadByte(out byte hasMore) || !reader.TryReadInt32(out int count) || count < 0)
        {
            cursor = default;
            return false;
        }

        var data = new List<UserCommentCoreModel>(count);
        for (int i = 0; i < count; i++)
        {
            if (!reader.TryReadPod(out UserCommentPod pod) || !reader.TryReadBytes(out ReadOnlySpan<byte> payloadSpan))
            {
                cursor = default;
                return false;
            }

            byte[] payload = payloadSpan.ToArray();
            string content = PodProjector.ReadSlice(pod.Content, payload);
            string articleTitle = PodUtf8Codec.FromFixed256(pod.ArticleTitle);
            DateTime createTime = PodTimeCodec.FromUnixMs(pod.CreateTimeUnixMs);
            data.Add(new UserCommentCoreModel(pod, pod.Id, content, createTime, pod.ArticleId, articleTitle));
        }

        cursor = new CoreCursorResult<UserCommentCoreModel>(data, nextCursor == 0 ? null : nextCursor, hasMore == 1);
        return reader.IsConsumed;
    }

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

    private static void WriteArticleListItem(ref BinaryPodWriter writer, ArticleListCoreModel item)
    {
        writer.WritePod(item.Pod);
        writer.WriteInt32(item.Tags.Count);
        foreach (TagCoreModel tag in item.Tags)
        {
            writer.WritePod(PodProjector.ProjectTag(tag.Id, tag.Name));
        }

        _ = PodProjector.ProjectArticleList(
            item.Id,
            item.Views,
            item.CreateTime,
            item.Category.Id,
            item.Category.Name,
            item.Title,
            item.Summary,
            item.Snippet,
            item.IsDeleted,
            out byte[] payload);

        writer.WriteBytes(payload);
    }

    private static bool TryReadArticleListItem(ref BinaryPodReader reader, out ArticleListCoreModel item)
    {
        if (!reader.TryReadPod(out ArticleListItemPod pod) || !reader.TryReadInt32(out int tagCount) || tagCount < 0)
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

        if (!reader.TryReadBytes(out ReadOnlySpan<byte> payloadSpan))
        {
            item = default;
            return false;
        }

        byte[] payload = payloadSpan.ToArray();
        string title = PodUtf8Codec.FromFixed256(pod.Title);
        string categoryName = PodUtf8Codec.FromFixed128(pod.Category.Name);
        string summary = PodProjector.ReadSlice(pod.Summary, payload);
        string snippet = PodProjector.ReadSlice(pod.Snippet, payload);
        DateTime createTime = PodTimeCodec.FromUnixMs(pod.CreateTimeUnixMs);
        bool? isDeleted = pod.HasIsDeleted == 1 ? pod.IsDeleted == 1 : null;

        item = new ArticleListCoreModel(
            pod,
            pod.Id,
            title,
            summary,
            snippet,
            pod.Views,
            createTime,
            new ArticleCategoryCoreModel(pod.Category.Id, categoryName),
            tags,
            isDeleted);

        return true;
    }

    private ref struct BinaryPodReader(ReadOnlySpan<byte> source)
    {
        private ReadOnlySpan<byte> _source = source;
        private int _offset;

        public bool IsConsumed => _offset == _source.Length;

        public bool TryReadInt32(out int value)
        {
            if (_offset + sizeof(int) > _source.Length)
            {
                value = 0;
                return false;
            }

            value = BinaryPrimitives.ReadInt32LittleEndian(_source.Slice(_offset, sizeof(int)));
            _offset += sizeof(int);
            return true;
        }

        public bool TryReadInt64(out long value)
        {
            if (_offset + sizeof(long) > _source.Length)
            {
                value = 0;
                return false;
            }

            value = BinaryPrimitives.ReadInt64LittleEndian(_source.Slice(_offset, sizeof(long)));
            _offset += sizeof(long);
            return true;
        }

        public bool TryReadByte(out byte value)
        {
            if (_offset + 1 > _source.Length)
            {
                value = 0;
                return false;
            }

            value = _source[_offset];
            _offset++;
            return true;
        }

        public bool TryReadBytes(out ReadOnlySpan<byte> value)
        {
            if (!TryReadInt32(out int length) || length < 0 || _offset + length > _source.Length)
            {
                value = default;
                return false;
            }

            value = _source.Slice(_offset, length);
            _offset += length;
            return true;
        }

        public bool TryReadPod<T>(out T value)
            where T : unmanaged
        {
            int size = Marshal.SizeOf<T>();
            if (_offset + size > _source.Length)
            {
                value = default;
                return false;
            }

            value = MemoryMarshal.Read<T>(_source.Slice(_offset, size));
            _offset += size;
            return true;
        }
    }

    private struct BinaryPodWriter
    {
        private List<byte> _bytes;

        public BinaryPodWriter()
        {
            _bytes = [];
        }

        public void WriteInt32(int value)
        {
            Span<byte> buffer = stackalloc byte[sizeof(int)];
            BinaryPrimitives.WriteInt32LittleEndian(buffer, value);
            _bytes.AddRange(buffer);
        }

        public void WriteInt64(long value)
        {
            Span<byte> buffer = stackalloc byte[sizeof(long)];
            BinaryPrimitives.WriteInt64LittleEndian(buffer, value);
            _bytes.AddRange(buffer);
        }

        public void WriteByte(byte value) => _bytes.Add(value);

        public void WriteBytes(ReadOnlySpan<byte> value)
        {
            WriteInt32(value.Length);
            for (int i = 0; i < value.Length; i++)
            {
                _bytes.Add(value[i]);
            }
        }

        public void WritePod<T>(in T value)
            where T : unmanaged
        {
            Span<T> one = stackalloc T[1];
            one[0] = value;
            ReadOnlySpan<byte> bytes = MemoryMarshal.AsBytes(one);
            for (int i = 0; i < bytes.Length; i++)
            {
                _bytes.Add(bytes[i]);
            }
        }

        public byte[] ToArray() => [.. _bytes];
    }
}
