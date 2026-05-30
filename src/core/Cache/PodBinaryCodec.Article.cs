using FsusBlog.Core.Mapping.Codecs;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Mapping.Projectors;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Outputs;
using FsusBlog.Shared.Contracts.Primitives;
using System.Buffers;
using System.Runtime.InteropServices;
using System.Text;

namespace FsusBlog.Core.Cache;

public static partial class PodBinaryCodec
{
    public static void WriteArticleWriteRequest(ArticleWriteRequestCoreModel request, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(Math.Max(512, request.Title.Length + request.Content.Length + (request.Summary?.Length ?? 0) + (request.CoverImageUrl?.Length ?? 0)));
        var mutable = new MutableArticleWriteRequestPod
        {
            CategoryId = request.CategoryId,
            TagCount = request.TagIds.Count,
            Title = PodUtf8Codec.AppendSlice(request.Title, payload),
            Content = PodUtf8Codec.AppendSlice(request.Content, payload),
            Summary = PodUtf8Codec.AppendSlice(request.Summary ?? string.Empty, payload),
            CoverImageUrl = PodUtf8Codec.AppendSlice(request.CoverImageUrl ?? string.Empty, payload)
        };

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(Cast<MutableArticleWriteRequestPod, ArticleWriteRequestPod>(mutable));
        foreach (int tagId in request.TagIds)
        {
            writer.WriteInt32(tagId);
        }

        writer.WriteBytes(payload.WrittenSpan);
        writer.WriteInt32(request.Status);
        writer.WriteInt64(ToUnixMsOrZero(request.ScheduledPublishAt));
    }

    public static byte[] EncodeArticleWriteRequest(ArticleWriteRequestCoreModel request)
        => EncodeToArray(512 + request.Content.Length + request.TagIds.Count * sizeof(int), writer => WriteArticleWriteRequest(request, writer));

    public static bool TryDecodeArticleWriteRequest(ReadOnlyMemory<byte> source, out ArticleWriteRequestCoreModel request)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out ArticleWriteRequestPod pod) || pod.TagCount < 0)
        {
            request = default;
            return false;
        }

        var tagIds = new List<int>(pod.TagCount);
        for (int i = 0; i < pod.TagCount; i++)
        {
            if (!reader.TryReadInt32(out int tagId))
            {
                request = default;
                return false;
            }

            tagIds.Add(tagId);
        }

        if (!reader.TryReadBytes(out ReadOnlySpan<byte> payloadSpan))
        {
            request = default;
            return false;
        }

        int status = 2;
        DateTime? scheduledPublishAt = null;
        if (reader.Remaining > 0)
        {
            if (reader.Remaining != sizeof(int) + sizeof(long) ||
                !reader.TryReadInt32(out status) ||
                !reader.TryReadInt64(out long scheduledPublishAtUnixMs))
            {
                request = default;
                return false;
            }

            scheduledPublishAt = FromUnixMsOrNull(scheduledPublishAtUnixMs);
        }

        request = new ArticleWriteRequestCoreModel(
            PodProjector.ReadSlice(pod.Title, payloadSpan),
            PodProjector.ReadSlice(pod.Content, payloadSpan),
            PodProjector.ReadSlice(pod.Summary, payloadSpan),
            PodProjector.ReadSlice(pod.CoverImageUrl, payloadSpan),
            pod.CategoryId,
            tagIds,
            status,
            scheduledPublishAt);
        return reader.IsConsumed;
    }

    public static void WritePublicAotBundle(PublicAotShellBundleContract bundle, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(4096);
        var entries = new List<PublicAotEntryPod>(bundle.Entries.Count);
        foreach (PublicAotShellEntryContract entry in bundle.Entries)
        {
            var mutable = new MutablePublicAotEntryPod
            {
                PageId = (int)entry.PageId,
                ArticleId = entry.ArticleId.GetValueOrDefault(),
                HasArticleId = entry.ArticleId.HasValue ? (byte)1 : (byte)0,
                Reserved0 = 0,
                Reserved1 = 0,
                RouteKey = PodUtf8Codec.AppendSlice(entry.RouteKey, payload),
                Html = PodUtf8Codec.AppendSlice(entry.Html, payload),
                BootstrapPayload = PodUtf8Codec.AppendSlice(entry.BootstrapPayload ?? string.Empty, payload),
                HydrationPropsPayload = PodUtf8Codec.AppendSlice(entry.HydrationPropsPayload ?? string.Empty, payload),
                RendererVersion = PodUtf8Codec.AppendSlice(entry.RendererVersion ?? string.Empty, payload),
                IslandsPayload = PodUtf8Codec.AppendSlice(entry.IslandsPayload ?? string.Empty, payload),
                Title = PodUtf8Codec.AppendSlice(entry.Title ?? string.Empty, payload),
                BaseUrl = PodUtf8Codec.AppendSlice(entry.BaseUrl ?? string.Empty, payload)
            };
            entries.Add(Cast<MutablePublicAotEntryPod, PublicAotEntryPod>(mutable));
        }

        var bundlePod = new MutablePublicAotBundlePod
        {
            GeneratedAtUnixMs = bundle.GeneratedAtUtc.ToUnixTimeMilliseconds(),
            EntryCount = entries.Count,
            Reserved = 0
        };

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(Cast<MutablePublicAotBundlePod, PublicAotBundlePod>(bundlePod));
        foreach (PublicAotEntryPod entry in entries)
        {
            writer.WritePod(entry);
        }

        writer.WriteBytes(payload.WrittenSpan);
    }

    public static byte[] EncodePublicAotBundle(PublicAotShellBundleContract bundle)
        => EncodeToArray(4096 + bundle.Entries.Sum(static entry => entry.Html.Length), writer => WritePublicAotBundle(bundle, writer));

    public static bool TryDecodePublicAotBundle(ReadOnlyMemory<byte> source, out PublicAotShellBundleContract bundle)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out PublicAotBundlePod header) || header.EntryCount < 0)
        {
            bundle = new PublicAotShellBundleContract();
            return false;
        }

        var pods = new List<PublicAotEntryPod>(header.EntryCount);
        for (int i = 0; i < header.EntryCount; i++)
        {
            if (!reader.TryReadPod(out PublicAotEntryPod entry) || entry.HasArticleId > 1)
            {
                bundle = new PublicAotShellBundleContract();
                return false;
            }

            pods.Add(entry);
        }

        if (!reader.TryReadBytes(out ReadOnlySpan<byte> payloadSpan))
        {
            bundle = new PublicAotShellBundleContract();
            return false;
        }

        var entries = new List<PublicAotShellEntryContract>(pods.Count);
        foreach (PublicAotEntryPod pod in pods)
        {
            entries.Add(new PublicAotShellEntryContract
            {
                PageId = (PublicPageId)pod.PageId,
                ArticleId = pod.HasArticleId == 1 ? pod.ArticleId : null,
                RouteKey = PodProjector.ReadSlice(pod.RouteKey, payloadSpan),
                Html = PodProjector.ReadSlice(pod.Html, payloadSpan),
                BootstrapPayload = NullIfEmpty(PodProjector.ReadSlice(pod.BootstrapPayload, payloadSpan)),
                HydrationPropsPayload = NullIfEmpty(PodProjector.ReadSlice(pod.HydrationPropsPayload, payloadSpan)),
                RendererVersion = NullIfEmpty(PodProjector.ReadSlice(pod.RendererVersion, payloadSpan)),
                IslandsPayload = NullIfEmpty(PodProjector.ReadSlice(pod.IslandsPayload, payloadSpan)),
                Title = NullIfEmpty(PodProjector.ReadSlice(pod.Title, payloadSpan)),
                BaseUrl = NullIfEmpty(PodProjector.ReadSlice(pod.BaseUrl, payloadSpan))
            });
        }

        bundle = new PublicAotShellBundleContract
        {
            GeneratedAtUtc = DateTimeOffset.FromUnixTimeMilliseconds(header.GeneratedAtUnixMs),
            Entries = entries
        };
        return reader.IsConsumed;
    }

    private static string? NullIfEmpty(string value) => value.Length == 0 ? null : value;

    public static void WriteArticlePage(CorePageResult<ArticleListCoreModel> page, IBufferWriter<byte> destination)
    {
        var blob = new List<byte>(Math.Max(256, page.Items.Count * 128));
        var tagRecords = new List<(int Id, Utf8SliceRef Name)>();
        var itemRecords = new List<(ArticleListCoreModel Item, Utf8SliceRef CategoryName, Utf8SliceRef Title, Utf8SliceRef Summary, int TagStart, int TagCount)>(page.Items.Count);
        foreach (ArticleListCoreModel item in page.Items)
        {
            int tagStart = tagRecords.Count;
            foreach (TagCoreModel tag in item.Tags)
            {
                tagRecords.Add((tag.Id, PodUtf8Codec.AppendSlice(tag.Name, blob)));
            }

            itemRecords.Add((
                item,
                PodUtf8Codec.AppendSlice(item.Category.Name, blob),
                PodUtf8Codec.AppendSlice(item.Title, blob),
                PodUtf8Codec.AppendSlice(item.Summary ?? string.Empty, blob),
                tagStart,
                item.Tags.Count));
        }

        var writer = new BinaryPodWriter(destination);
        writer.WriteInt32(page.Total);
        writer.WriteInt32(page.Items.Count);
        writer.WriteInt32(tagRecords.Count);
        writer.WriteBytes(CollectionsMarshal.AsSpan(blob));

        foreach (var record in itemRecords)
        {
            writer.WriteInt32(record.Item.Id);
            writer.WriteInt32(record.Item.Views);
            writer.WriteInt64(PodTimeCodec.ToUnixMs(record.Item.CreateTime));
            writer.WriteInt32(record.Item.Category.Id);
            writer.WriteSliceRef(record.CategoryName);
            writer.WriteSliceRef(record.Title);
            writer.WriteSliceRef(record.Summary);
            writer.WriteInt32(record.TagStart);
            writer.WriteInt32(record.TagCount);
            writer.WriteByte(record.Item.IsDeleted == true ? (byte)1 : (byte)0);
            writer.WriteByte(record.Item.IsDeleted.HasValue ? (byte)1 : (byte)0);
            writer.WriteByte(0);
            writer.WriteByte(0);
            writer.WriteInt32(record.Item.Status);
            writer.WriteInt64(ToUnixMsOrZero(record.Item.ScheduledPublishAt));
            writer.WriteInt64(ToUnixMsOrZero(record.Item.PublishedAt));
        }

        foreach (var tag in tagRecords)
        {
            writer.WriteInt32(tag.Id);
            writer.WriteSliceRef(tag.Name);
        }
    }

    public static byte[] EncodeArticlePage(CorePageResult<ArticleListCoreModel> page)
        => EncodeToArray(1024, writer => WriteArticlePage(page, writer));

    public static bool TryDecodeArticlePage(ReadOnlyMemory<byte> bytes, out CorePageResult<ArticleListCoreModel> page)
    {
        var reader = new BinaryPodReader(bytes.Span);
        if (!reader.TryReadInt32(out int total) ||
            !reader.TryReadInt32(out int count) ||
            !reader.TryReadInt32(out int tagRecordCount) ||
            count < 0 ||
            tagRecordCount < 0 ||
            !reader.TryReadBytes(out ReadOnlySpan<byte> blob))
        {
            page = default;
            return false;
        }

        int itemRecordBytes = reader.Remaining - tagRecordCount * 12;
        int itemRecordSize = count == 0 ? 76 : itemRecordBytes / count;
        if (itemRecordBytes < 0 ||
            count > 0 && itemRecordBytes % count != 0 ||
            itemRecordSize is not 56 and not 76 ||
            reader.Remaining != count * itemRecordSize + tagRecordCount * 12)
        {
            page = default;
            return false;
        }

        var pending = new List<(int Id, int Views, long CreateTimeUnixMs, int CategoryId, Utf8SliceRef CategoryName, Utf8SliceRef Title, Utf8SliceRef Summary, int TagStart, int TagCount, bool? IsDeleted, int Status, DateTime? ScheduledPublishAt, DateTime? PublishedAt)>(count);
        for (int i = 0; i < count; i++)
        {
            if (!reader.TryReadInt32(out int id) ||
                !reader.TryReadInt32(out int views) ||
                !reader.TryReadInt64(out long createTimeUnixMs) ||
                !reader.TryReadInt32(out int categoryId) ||
                !reader.TryReadSliceRef(out Utf8SliceRef categoryName) ||
                !reader.TryReadSliceRef(out Utf8SliceRef title) ||
                !reader.TryReadSliceRef(out Utf8SliceRef summary) ||
                !reader.TryReadInt32(out int tagStart) ||
                !reader.TryReadInt32(out int tagCount) ||
                !reader.TryReadByte(out byte isDeleted) ||
                !reader.TryReadByte(out byte hasIsDeleted) ||
                !reader.TryReadByte(out _) ||
                !reader.TryReadByte(out _) ||
                tagStart < 0 ||
                tagCount < 0 ||
                tagStart + tagCount > tagRecordCount ||
                isDeleted > 1 ||
                hasIsDeleted > 1)
            {
                page = default;
                return false;
            }

            int status = 2;
            DateTime? scheduledPublishAt = null;
            DateTime? publishedAt = null;
            if (itemRecordSize == 76)
            {
                if (!reader.TryReadInt32(out status) ||
                    !reader.TryReadInt64(out long scheduledPublishAtUnixMs) ||
                    !reader.TryReadInt64(out long publishedAtUnixMs))
                {
                    page = default;
                    return false;
                }

                scheduledPublishAt = FromUnixMsOrNull(scheduledPublishAtUnixMs);
                publishedAt = FromUnixMsOrNull(publishedAtUnixMs);
            }

            pending.Add((id, views, createTimeUnixMs, categoryId, categoryName, title, summary, tagStart, tagCount, hasIsDeleted == 1 ? isDeleted == 1 : null, status, scheduledPublishAt, publishedAt));
        }

        var tagRecords = new List<TagCoreModel>(tagRecordCount);
        for (int i = 0; i < tagRecordCount; i++)
        {
            if (!reader.TryReadInt32(out int tagId) || !reader.TryReadSliceRef(out Utf8SliceRef tagName))
            {
                page = default;
                return false;
            }

            tagRecords.Add(new TagCoreModel(tagId, PodUtf8Codec.ReadSlice(tagName, blob)));
        }

        var items = new List<ArticleListCoreModel>(count);
        foreach (var record in pending)
        {
            string title = PodUtf8Codec.ReadSlice(record.Title, blob);
            string summary = PodUtf8Codec.ReadSlice(record.Summary, blob);
            string categoryName = PodUtf8Codec.ReadSlice(record.CategoryName, blob);
            var tags = tagRecords.GetRange(record.TagStart, record.TagCount);
            var pod = PodProjector.ProjectArticleList(record.Id, record.Views, PodTimeCodec.FromUnixMs(record.CreateTimeUnixMs), record.CategoryId, categoryName, title, summary, record.IsDeleted, out _);
            items.Add(new ArticleListCoreModel(
                pod,
                record.Id,
                title,
                summary,
                null,
                null,
                record.Views,
                PodTimeCodec.FromUnixMs(record.CreateTimeUnixMs),
                new ArticleCategoryCoreModel(record.CategoryId, categoryName),
                tags,
                record.IsDeleted,
                record.Status,
                record.ScheduledPublishAt,
                record.PublishedAt));
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
        writer.WriteBytes(Encoding.UTF8.GetBytes(item.CoverImageUrl ?? string.Empty));
        writer.WriteByte(item.IsDeleted ? (byte)1 : (byte)0);
        writer.WriteInt32(item.Status);
        writer.WriteInt64(ToUnixMsOrZero(item.ScheduledPublishAt));
        writer.WriteInt64(ToUnixMsOrZero(item.PublishedAt));
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

        if (!reader.TryReadBytes(out ReadOnlySpan<byte> payloadSpan))
        {
            item = default;
            return false;
        }

        string? coverImageUrl = null;
        if (reader.Remaining == 1)
        {
            if (!reader.TryReadByte(out byte isDeletedOnly))
            {
                item = default;
                return false;
            }

            return BuildArticleDetail(pod, tags, payloadSpan, coverImageUrl, isDeletedOnly, 2, null, null, out item)
                && reader.IsConsumed;
        }

        if (!reader.TryReadBytes(out ReadOnlySpan<byte> coverImageUrlSpan) || !reader.TryReadByte(out byte isDeleted))
        {
            item = default;
            return false;
        }

        coverImageUrl = coverImageUrlSpan.IsEmpty ? null : Encoding.UTF8.GetString(coverImageUrlSpan);
        if (!TryReadArticlePublicationTail(ref reader, out int status, out DateTime? scheduledPublishAt, out DateTime? publishedAt))
        {
            item = default;
            return false;
        }

        return BuildArticleDetail(pod, tags, payloadSpan, coverImageUrl, isDeleted, status, scheduledPublishAt, publishedAt, out item)
            && reader.IsConsumed;
    }

    private static bool TryReadArticlePublicationTail(
        ref BinaryPodReader reader,
        out int status,
        out DateTime? scheduledPublishAt,
        out DateTime? publishedAt)
    {
        status = 2;
        scheduledPublishAt = null;
        publishedAt = null;
        if (reader.Remaining == 0)
        {
            return true;
        }

        if (reader.Remaining != sizeof(int) + sizeof(long) + sizeof(long) ||
            !reader.TryReadInt32(out status) ||
            !reader.TryReadInt64(out long scheduledPublishAtUnixMs) ||
            !reader.TryReadInt64(out long publishedAtUnixMs))
        {
            return false;
        }

        scheduledPublishAt = FromUnixMsOrNull(scheduledPublishAtUnixMs);
        publishedAt = FromUnixMsOrNull(publishedAtUnixMs);
        return true;
    }

    private static bool BuildArticleDetail(
        ArticleDetailPod pod,
        List<TagCoreModel> tags,
        ReadOnlySpan<byte> payloadSpan,
        string? coverImageUrl,
        byte isDeleted,
        int status,
        DateTime? scheduledPublishAt,
        DateTime? publishedAt,
        out ArticleDetailCoreModel item)
    {
        if (isDeleted > 1)
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
            coverImageUrl,
            pod.Views,
            wordCount,
            estimatedReadingMinutes,
            showReadingNotice,
            createTime,
            category,
            tags,
            pod.Category.Id,
            isDeleted == 1,
            status,
            scheduledPublishAt,
            publishedAt);
        return true;
    }

    private static long ToUnixMsOrZero(DateTime? value)
        => value.HasValue ? PodTimeCodec.ToUnixMs(value.Value) : 0;

    private static DateTime? FromUnixMsOrNull(long value)
        => value > 0 ? PodTimeCodec.FromUnixMs(value) : null;

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableArticleWriteRequestPod
    {
        public int CategoryId;
        public int TagCount;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Title;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Content;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Summary;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef CoverImageUrl;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutablePublicAotBundlePod
    {
        public long GeneratedAtUnixMs;
        public int EntryCount;
        public int Reserved;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutablePublicAotEntryPod
    {
        public int PageId;
        public int ArticleId;
        public byte HasArticleId;
        public byte Reserved0;
        public ushort Reserved1;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef RouteKey;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Html;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef BootstrapPayload;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef HydrationPropsPayload;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef RendererVersion;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef IslandsPayload;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Title;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef BaseUrl;
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
        var blob = new List<byte>(Math.Max(128, items.Count * 64));
        var slices = new List<Utf8SliceRef>(items.Count);
        foreach (PopularArticleCoreModel item in items)
        {
            slices.Add(PodUtf8Codec.AppendSlice(item.Title, blob));
        }

        var writer = new BinaryPodWriter(destination);
        writer.WriteInt32(items.Count);
        writer.WriteBytes(CollectionsMarshal.AsSpan(blob));

        for (int i = 0; i < items.Count; i++)
        {
            writer.WriteInt32(items[i].Id);
            writer.WriteInt32(items[i].Views);
            writer.WriteSliceRef(slices[i]);
        }
    }

    public static byte[] EncodePopularArticles(IReadOnlyList<PopularArticleCoreModel> items)
        => EncodeToArray(128 + items.Count * 32, writer => WritePopularArticles(items, writer));

    public static bool TryDecodePopularArticles(ReadOnlyMemory<byte> bytes, out IReadOnlyList<PopularArticleCoreModel> items)
    {
        var reader = new BinaryPodReader(bytes.Span);
        if (!reader.TryReadInt32(out int count) || count < 0 || !reader.TryReadBytes(out ReadOnlySpan<byte> blob))
        {
            items = Array.Empty<PopularArticleCoreModel>();
            return false;
        }

        var list = new List<PopularArticleCoreModel>(count);
        for (int i = 0; i < count; i++)
        {
            if (!reader.TryReadInt32(out int id) || !reader.TryReadInt32(out int views) || !reader.TryReadSliceRef(out Utf8SliceRef titleSlice))
            {
                items = Array.Empty<PopularArticleCoreModel>();
                return false;
            }

            string title = PodUtf8Codec.ReadSlice(titleSlice, blob);
            list.Add(new PopularArticleCoreModel(PodProjector.ProjectPopularArticle(id, title, views), id, title, views));
        }

        items = list;
        return reader.IsConsumed;
    }

    public static void WriteFeaturedArticles(IReadOnlyList<FeaturedArticleSummaryDto> items, IBufferWriter<byte> destination)
    {
        var writer = new BinaryPodWriter(destination);
        writer.WriteInt32(items.Count);

        foreach (FeaturedArticleSummaryDto item in items)
        {
            FeaturedArticlePod pod = PodProjector.ProjectFeaturedArticle(
                item.Id,
                item.Title,
                item.CoverImageUrl,
                item.Views,
                item.CreateTime,
                item.Category.Id,
                item.Category.Name,
                out ReadOnlyMemory<byte> payload);

            writer.WritePod(pod);
            writer.WriteBytes(payload.Span);
        }
    }

    public static byte[] EncodeFeaturedArticles(IReadOnlyList<FeaturedArticleSummaryDto> items)
        => EncodeToArray(512 + items.Count * 512, writer => WriteFeaturedArticles(items, writer));

    public static void WriteFeaturedArticleCoreList(IReadOnlyList<FeaturedArticleCoreModel> items, IBufferWriter<byte> destination)
    {
        var writer = new BinaryPodWriter(destination);
        writer.WriteInt32(items.Count);

        foreach (FeaturedArticleCoreModel item in items)
        {
            FeaturedArticlePod pod = PodProjector.ProjectFeaturedArticle(
                item.Id,
                item.Title,
                item.CoverImageUrl,
                item.Views,
                item.CreateTime,
                item.Category.Id,
                item.Category.Name,
                out ReadOnlyMemory<byte> payload);

            writer.WritePod(pod);
            writer.WriteBytes(payload.Span);
        }
    }

    public static byte[] EncodeFeaturedArticleCoreList(IReadOnlyList<FeaturedArticleCoreModel> items)
        => EncodeToArray(512 + items.Count * 512, writer => WriteFeaturedArticleCoreList(items, writer));

    public static bool TryDecodeFeaturedArticleCoreList(ReadOnlyMemory<byte> bytes, out IReadOnlyList<FeaturedArticleCoreModel> items)
    {
        var reader = new BinaryPodReader(bytes.Span);
        if (!reader.TryReadInt32(out int count) || count < 0)
        {
            items = Array.Empty<FeaturedArticleCoreModel>();
            return false;
        }

        var list = new List<FeaturedArticleCoreModel>(count);
        for (int i = 0; i < count; i++)
        {
            if (!reader.TryReadPod(out FeaturedArticlePod pod) || !reader.TryReadBytes(out ReadOnlySpan<byte> payload))
            {
                items = Array.Empty<FeaturedArticleCoreModel>();
                return false;
            }

            list.Add(new FeaturedArticleCoreModel(
                pod.Id,
                PodUtf8Codec.FromFixed256(pod.Title),
                PodProjector.ReadSlice(pod.CoverImageUrl, payload),
                pod.Views,
                PodTimeCodec.FromUnixMs(pod.CreateTimeUnixMs),
                new ArticleCategoryCoreModel(pod.Category.Id, PodUtf8Codec.FromFixed128(pod.Category.Name))));
        }

        items = list;
        return reader.IsConsumed;
    }

    public static bool TryDecodeFeaturedArticles(ReadOnlyMemory<byte> bytes, out IReadOnlyList<FeaturedArticleSummaryDto> items)
    {
        var reader = new BinaryPodReader(bytes.Span);
        if (!reader.TryReadInt32(out int count) || count < 0)
        {
            items = Array.Empty<FeaturedArticleSummaryDto>();
            return false;
        }

        var list = new List<FeaturedArticleSummaryDto>(count);
        for (int i = 0; i < count; i++)
        {
            if (!reader.TryReadPod(out FeaturedArticlePod pod) || !reader.TryReadBytes(out ReadOnlySpan<byte> payload))
            {
                items = Array.Empty<FeaturedArticleSummaryDto>();
                return false;
            }

            list.Add(new FeaturedArticleSummaryDto(
                pod.Id,
                PodUtf8Codec.FromFixed256(pod.Title),
                PodProjector.ReadSlice(pod.CoverImageUrl, payload),
                pod.Views,
                PodTimeCodec.FromUnixMs(pod.CreateTimeUnixMs),
                new ArticleCategoryView(pod.Category.Id, PodUtf8Codec.FromFixed128(pod.Category.Name))));
        }

        items = list;
        return reader.IsConsumed;
    }

    public static void WriteTrashClearResponse(TrashClearResponseDto value, IBufferWriter<byte> destination)
    {
        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CreateTrashClearResponsePod(value.Count));
    }

    public static byte[] EncodeTrashClearResponse(TrashClearResponseDto value)
        => EncodeToArray(Marshal.SizeOf<TrashClearResponsePod>(), writer => WriteTrashClearResponse(value, writer));

    public static bool TryDecodeTrashClearResponse(ReadOnlyMemory<byte> bytes, out TrashClearResponseDto value)
    {
        var reader = new BinaryPodReader(bytes.Span);
        if (!reader.TryReadPod(out TrashClearResponsePod pod) || !reader.IsConsumed)
        {
            value = default;
            return false;
        }

        value = new TrashClearResponseDto(pod.Count);
        return true;
    }

    private static TrashClearResponsePod CreateTrashClearResponsePod(int count)
    {
        Span<byte> bytes = stackalloc byte[Marshal.SizeOf<TrashClearResponsePod>()];
        MemoryMarshal.Write(bytes, in count);
        return MemoryMarshal.Read<TrashClearResponsePod>(bytes);
    }
}
