using FsusBlog.Core.Mapping.Codecs;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Mapping.Projectors;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Outputs;
using FsusBlog.Shared.Contracts.Primitives;
using System.Buffers;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;

namespace FsusBlog.Core.Cache;

public static partial class PodBinaryCodec
{
    private const int ArticlePageCursorEnvelopeMagic = 0x41535046; // FSPA
    private const int ArticlePageCursorEnvelopeVersion = 1;
    private const uint ArticleDetailV3PayloadMagic = 0x41524433; // ARD3
    private const int ArticleDetailV3PayloadVersion = 3;
    private const uint ArticleDetailV4PayloadMagic = 0x41524434; // ARD4
    private const int ArticleDetailV4PayloadVersion = 4;
    private const int ArticleWriteRequestVersion = 3;
    private const int RightsFlagEnabled = 1 << 0;
    private const int RightsFlagAllowCodeCopy = 1 << 1;
    private const int RightsFlagShowPublicBadge = 1 << 2;
    private const int RightsFlagProofBindingEnabled = 1 << 3;
    private const int RightsFlagHasCopyrightYear = 1 << 4;
    private const int ArticleDetailRightsFlagEnabled = 1 << 0;
    private const int ArticleDetailRightsFlagAllowCodeCopy = 1 << 1;
    private const int ArticleDetailRightsFlagShowPublicBadge = 1 << 2;
    private const int ArticleDetailRightsFlagProofBindingEnabled = 1 << 3;
    private const int ArticleDetailRightsFlagHasCopyrightYear = 1 << 4;
    private const int ArticleDetailRightsFlagHasCopyrightHolder = 1 << 5;
    private const int ArticleDetailRightsFlagHasRightsStatement = 1 << 6;
    private const int ArticleDetailRightsFlagHasAttributionTemplate = 1 << 7;
    private const int ArticleDetailRightsFlagHasCanonicalUrl = 1 << 8;
    private const int ArticleDetailRightsFlagHasProofUrl = 1 << 9;
    private const int ArticleDetailRightsFlagHasProofStatus = 1 << 10;

    public static void WriteArticleWriteRequest(ArticleWriteRequestCoreModel request, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(Math.Max(512, request.Title.Length + request.Content.Length + (request.Summary?.Length ?? 0) + (request.CoverImageUrl?.Length ?? 0)));
        ArticleRightsRequestCoreModel rights = NormalizeArticleRights(request.Rights);
        var rightsPayload = new ArrayBufferWriter<byte>(Math.Max(256,
            rights.LicenseType.Length
            + (rights.CopyrightHolder?.Length ?? 0)
            + (rights.RightsStatement?.Length ?? 0)
            + (rights.AttributionTemplate?.Length ?? 0)
            + rights.CopyPolicy.Length));
        var mutable = new MutableArticleWriteRequestPod
        {
            CategoryId = request.CategoryId,
            TagCount = request.TagIds.Count,
            Title = PodUtf8Codec.AppendSlice(request.Title, payload),
            Content = PodUtf8Codec.AppendSlice(request.Content, payload),
            Summary = PodUtf8Codec.AppendSlice(request.Summary ?? string.Empty, payload),
            CoverImageUrl = PodUtf8Codec.AppendSlice(request.CoverImageUrl ?? string.Empty, payload)
        };
        var mutableRights = new MutableArticleRightsWriteRequestPod
        {
            LicenseType = PodUtf8Codec.AppendSlice(rights.LicenseType, rightsPayload),
            CopyrightHolder = PodUtf8Codec.AppendSlice(rights.CopyrightHolder ?? string.Empty, rightsPayload),
            RightsStatement = PodUtf8Codec.AppendSlice(rights.RightsStatement ?? string.Empty, rightsPayload),
            AttributionTemplate = PodUtf8Codec.AppendSlice(rights.AttributionTemplate ?? string.Empty, rightsPayload),
            CopyPolicy = PodUtf8Codec.AppendSlice(rights.CopyPolicy, rightsPayload)
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
        writer.WriteInt32(ArticleWriteRequestVersion);
        writer.WriteInt32(BuildRightsFlags(rights));
        writer.WriteInt32(rights.CopyrightYear.GetValueOrDefault());
        writer.WriteInt32(rights.MaxExcerptChars);
        writer.WritePod(Cast<MutableArticleRightsWriteRequestPod, ArticleRightsWriteRequestPod>(mutableRights));
        writer.WriteBytes(rightsPayload.WrittenSpan);
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

        if (!reader.TryReadInt32(out int status) ||
            !reader.TryReadInt64(out long scheduledPublishAtUnixMs) ||
            !reader.TryReadInt32(out int version) ||
            version != ArticleWriteRequestVersion ||
            !reader.TryReadInt32(out int rightsFlags) ||
            !reader.TryReadInt32(out int copyrightYearValue) ||
            !reader.TryReadInt32(out int maxExcerptChars) ||
            !reader.TryReadPod(out ArticleRightsWriteRequestPod rightsPod) ||
            !reader.TryReadBytes(out ReadOnlySpan<byte> rightsPayloadSpan) ||
            maxExcerptChars < 0)
        {
            request = default;
            return false;
        }

        DateTime? scheduledPublishAt = FromUnixMsOrNull(scheduledPublishAtUnixMs);
        var rights = new ArticleRightsRequestCoreModel(
            Enabled: (rightsFlags & RightsFlagEnabled) != 0,
            LicenseType: PodProjector.ReadSlice(rightsPod.LicenseType, rightsPayloadSpan),
            CopyrightHolder: ReadOptionalRightsSlice(rightsPod.CopyrightHolder, rightsPayloadSpan),
            CopyrightYear: (rightsFlags & RightsFlagHasCopyrightYear) != 0 ? copyrightYearValue : null,
            RightsStatement: ReadOptionalRightsSlice(rightsPod.RightsStatement, rightsPayloadSpan),
            AttributionTemplate: ReadOptionalRightsSlice(rightsPod.AttributionTemplate, rightsPayloadSpan),
            CopyPolicy: PodProjector.ReadSlice(rightsPod.CopyPolicy, rightsPayloadSpan),
            MaxExcerptChars: maxExcerptChars,
            AllowCodeCopy: (rightsFlags & RightsFlagAllowCodeCopy) != 0,
            ShowPublicBadge: (rightsFlags & RightsFlagShowPublicBadge) != 0,
            ProofBindingEnabled: (rightsFlags & RightsFlagProofBindingEnabled) != 0);

        request = new ArticleWriteRequestCoreModel(
            PodProjector.ReadSlice(pod.Title, payloadSpan),
            PodProjector.ReadSlice(pod.Content, payloadSpan),
            PodProjector.ReadSlice(pod.Summary, payloadSpan),
            PodProjector.ReadSlice(pod.CoverImageUrl, payloadSpan),
            pod.CategoryId,
            tagIds,
            status,
            scheduledPublishAt,
            rights);
        return reader.IsConsumed;
    }

    private static ArticleRightsRequestCoreModel NormalizeArticleRights(ArticleRightsRequestCoreModel? rights)
    {
        if (!rights.HasValue)
        {
            return DefaultArticleRights();
        }

        ArticleRightsRequestCoreModel value = rights.Value;
        return value with
        {
            LicenseType = string.IsNullOrWhiteSpace(value.LicenseType) ? "all-rights-reserved" : value.LicenseType,
            CopyPolicy = string.IsNullOrWhiteSpace(value.CopyPolicy) ? "append-attribution" : value.CopyPolicy,
            MaxExcerptChars = value.MaxExcerptChars < 0 ? 0 : value.MaxExcerptChars
        };
    }

    private static ArticleRightsRequestCoreModel DefaultArticleRights()
        => new(
            Enabled: true,
            LicenseType: "all-rights-reserved",
            CopyrightHolder: null,
            CopyrightYear: null,
            RightsStatement: null,
            AttributionTemplate: null,
            CopyPolicy: "append-attribution",
            MaxExcerptChars: 300,
            AllowCodeCopy: true,
            ShowPublicBadge: true,
            ProofBindingEnabled: true);

    private static int BuildRightsFlags(ArticleRightsRequestCoreModel rights)
    {
        int flags = 0;
        if (rights.Enabled)
        {
            flags |= RightsFlagEnabled;
        }

        if (rights.AllowCodeCopy)
        {
            flags |= RightsFlagAllowCodeCopy;
        }

        if (rights.ShowPublicBadge)
        {
            flags |= RightsFlagShowPublicBadge;
        }

        if (rights.ProofBindingEnabled)
        {
            flags |= RightsFlagProofBindingEnabled;
        }

        if (rights.CopyrightYear.HasValue)
        {
            flags |= RightsFlagHasCopyrightYear;
        }

        return flags;
    }

    private static string? ReadOptionalRightsSlice(in Utf8SliceRef slice, ReadOnlySpan<byte> payload)
    {
        string value = PodProjector.ReadSlice(slice, payload);
        return value.Length == 0 ? null : value;
    }

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
        writer.WriteInt32(ArticlePageCursorEnvelopeMagic);
        writer.WriteInt32(ArticlePageCursorEnvelopeVersion);
        writer.WriteInt64(ParseArticleListCursorUnixMs(page.NextCursor));
        writer.WriteByte(page.HasMore ? (byte)1 : (byte)0);
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
        long nextCursorUnixMs = 0;
        bool hasMore = false;
        if (!reader.TryReadInt32(out int total))
        {
            page = default;
            return false;
        }

        if (total == ArticlePageCursorEnvelopeMagic)
        {
            if (!reader.TryReadInt32(out int version) ||
                version != ArticlePageCursorEnvelopeVersion ||
                !reader.TryReadInt64(out nextCursorUnixMs) ||
                !reader.TryReadByte(out byte hasMoreByte) ||
                hasMoreByte > 1 ||
                !reader.TryReadInt32(out total))
            {
                page = default;
                return false;
            }

            hasMore = hasMoreByte == 1;
        }

        if (
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

        string? nextCursor = hasMore && nextCursorUnixMs > 0 && items.Count > 0
            ? FormatArticleListCursor(nextCursorUnixMs, items[^1].Id)
            : null;
        page = new CorePageResult<ArticleListCoreModel>(items, total, nextCursor, hasMore);
        return reader.IsConsumed;
    }

    private static long ParseArticleListCursorUnixMs(string? cursor)
    {
        if (string.IsNullOrWhiteSpace(cursor))
        {
            return 0;
        }

        int separator = cursor.IndexOf(':', StringComparison.Ordinal);
        string value = separator > 0 ? cursor[..separator] : cursor;
        return long.TryParse(value, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out long parsed)
            ? parsed
            : 0;
    }

    private static string FormatArticleListCursor(long unixMs, int id)
        => string.Create(System.Globalization.CultureInfo.InvariantCulture, $"{unixMs}:{id}");

    public static void WriteArticleDetail(ArticleDetailCoreModel item, IBufferWriter<byte> destination)
    {
        var blob = new List<byte>(Math.Max(512, item.Content.Length + item.Title.Length + (item.Summary?.Length ?? 0) + (item.CoverImageUrl?.Length ?? 0)));
        ArticleRightsCoreModel rights = item.Rights;
        var article = new MutableArticleDetailV4RecordPod
        {
            Id = item.Id,
            Views = item.Views,
            CreateTimeUnixMs = PodTimeCodec.ToUnixMs(item.CreateTime),
            CategoryId = item.Category.Id,
            Status = item.Status,
            ScheduledPublishAtUnixMs = ToUnixMsOrZero(item.ScheduledPublishAt),
            PublishedAtUnixMs = ToUnixMsOrZero(item.PublishedAt),
            UpdatedAtUnixMs = ToUnixMsOrZero(item.UpdatedAt),
            IsDeleted = item.IsDeleted ? (byte)1 : (byte)0,
            Title = PodUtf8Codec.AppendSlice(item.Title, blob),
            Content = PodUtf8Codec.AppendSlice(item.Content, blob),
            Summary = PodUtf8Codec.AppendSlice(item.Summary ?? string.Empty, blob),
            CoverImageUrl = PodUtf8Codec.AppendSlice(item.CoverImageUrl ?? string.Empty, blob),
            CategoryName = PodUtf8Codec.AppendSlice(item.Category.Name, blob)
        };

        var tags = new List<ArticleDetailTagV3RecordPod>(item.Tags.Count);
        foreach (TagCoreModel tag in item.Tags)
        {
            var mutableTag = new MutableArticleDetailTagV3RecordPod
            {
                Id = tag.Id,
                Name = PodUtf8Codec.AppendSlice(tag.Name, blob)
            };
            tags.Add(Cast<MutableArticleDetailTagV3RecordPod, ArticleDetailTagV3RecordPod>(mutableTag));
        }

        var rightsRecord = new MutableArticleRightsV3RecordPod
        {
            SnapshotId = rights.SnapshotId,
            ArticleRevisionId = rights.ArticleRevisionId,
            RevisionNo = rights.RevisionNo,
            Flags = BuildArticleDetailRightsFlags(rights),
            CopyrightYear = rights.CopyrightYear.GetValueOrDefault(),
            MaxExcerptChars = rights.MaxExcerptChars,
            LicenseType = PodUtf8Codec.AppendSlice(rights.LicenseType, blob),
            CopyrightHolder = PodUtf8Codec.AppendSlice(rights.CopyrightHolder ?? string.Empty, blob),
            RightsStatement = PodUtf8Codec.AppendSlice(rights.RightsStatement ?? string.Empty, blob),
            AttributionTemplate = PodUtf8Codec.AppendSlice(rights.AttributionTemplate ?? string.Empty, blob),
            CopyPolicy = PodUtf8Codec.AppendSlice(rights.CopyPolicy, blob),
            CanonicalUrl = PodUtf8Codec.AppendSlice(rights.CanonicalUrl ?? string.Empty, blob),
            PolicyHash = PodUtf8Codec.AppendSlice(rights.PolicyHash, blob),
            ContentCanonicalHash = PodUtf8Codec.AppendSlice(rights.ContentCanonicalHash, blob),
            ProofUrl = PodUtf8Codec.AppendSlice(rights.ProofUrl ?? string.Empty, blob),
            ProofStatus = PodUtf8Codec.AppendSlice(rights.ProofStatus ?? string.Empty, blob)
        };

        int headerSize = Unsafe.SizeOf<ArticleDetailV4HeaderPod>();
        int articleRecordSize = Unsafe.SizeOf<ArticleDetailV4RecordPod>();
        int tagRecordSize = Unsafe.SizeOf<ArticleDetailTagV3RecordPod>();
        int rightsRecordSize = Unsafe.SizeOf<ArticleRightsV3RecordPod>();
        int articleOffset = headerSize;
        int tagOffset = articleOffset + articleRecordSize;
        int rightsOffset = tagOffset + tags.Count * tagRecordSize;
        int blobOffset = rightsOffset + rightsRecordSize;
        var header = new MutableArticleDetailV4HeaderPod
        {
            Magic = ArticleDetailV4PayloadMagic,
            Version = ArticleDetailV4PayloadVersion,
            Flags = 0,
            ArticleRecordOffset = articleOffset,
            ArticleRecordLength = articleRecordSize,
            TagOffset = tagOffset,
            TagCount = tags.Count,
            RightsRecordOffset = rightsOffset,
            RightsRecordLength = rightsRecordSize,
            BlobOffset = blobOffset,
            BlobLength = blob.Count
        };

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(Cast<MutableArticleDetailV4HeaderPod, ArticleDetailV4HeaderPod>(header));
        writer.WritePod(Cast<MutableArticleDetailV4RecordPod, ArticleDetailV4RecordPod>(article));
        foreach (ArticleDetailTagV3RecordPod tag in tags)
        {
            writer.WritePod(tag);
        }

        writer.WritePod(Cast<MutableArticleRightsV3RecordPod, ArticleRightsV3RecordPod>(rightsRecord));
        if (blob.Count > 0)
        {
            CollectionsMarshal.AsSpan(blob).CopyTo(destination.GetSpan(blob.Count));
            destination.Advance(blob.Count);
        }
    }

    public static byte[] EncodeArticleDetail(ArticleDetailCoreModel item)
        => EncodeToArray(2048 + item.Content.Length + item.Tags.Count * 32, writer => WriteArticleDetail(item, writer));

    public static bool TryDecodeArticleDetail(ReadOnlyMemory<byte> bytes, out ArticleDetailCoreModel item)
    {
        ReadOnlySpan<byte> source = bytes.Span;
        if (source.Length < Unsafe.SizeOf<ArticleDetailV3HeaderPod>())
        {
            item = default;
            return false;
        }

        var reader = new BinaryPodReader(source);
        if (!reader.TryReadPod(out ArticleDetailV3HeaderPod header) ||
            !IsSupportedArticleDetailPayload(header.Magic, header.Version) ||
            header.Flags != 0 ||
            header.TagCount < 0 ||
            header.ArticleRecordLength != ResolveArticleDetailRecordSize(header.Version) ||
            header.RightsRecordLength != Unsafe.SizeOf<ArticleRightsV3RecordPod>() ||
            header.ArticleRecordOffset != Unsafe.SizeOf<ArticleDetailV3HeaderPod>())
        {
            item = default;
            return false;
        }

        int articleOffset = header.ArticleRecordOffset;
        int articleLength = header.ArticleRecordLength;
        int tagOffset = header.TagOffset;
        int tagRecordSize = Unsafe.SizeOf<ArticleDetailTagV3RecordPod>();
        if (header.TagCount > source.Length / tagRecordSize)
        {
            item = default;
            return false;
        }

        int tagBytes = header.TagCount * tagRecordSize;
        int rightsOffset = header.RightsRecordOffset;
        int rightsLength = header.RightsRecordLength;
        int blobOffset = header.BlobOffset;
        int blobLength = header.BlobLength;

        if ((long)tagOffset != (long)articleOffset + articleLength ||
            (long)rightsOffset != (long)tagOffset + tagBytes ||
            (long)blobOffset != (long)rightsOffset + rightsLength ||
            (long)blobOffset + blobLength != source.Length ||
            !IsRangeWithin(articleOffset, articleLength, source.Length) ||
            !IsRangeWithin(tagOffset, tagBytes, source.Length) ||
            !IsRangeWithin(rightsOffset, rightsLength, source.Length) ||
            !IsRangeWithin(blobOffset, blobLength, source.Length))
        {
            item = default;
            return false;
        }

        ReadOnlySpan<byte> blob = source.Slice(blobOffset, blobLength);
        if (!TryReadArticleDetailRecord(
                source.Slice(articleOffset, articleLength),
                blob,
                header.Version,
                out DecodedArticleDetailRecord article))
        {
            item = default;
            return false;
        }

        var tags = new List<TagCoreModel>(header.TagCount);
        var tagReader = new BinaryPodReader(source.Slice(tagOffset, tagBytes));
        for (int i = 0; i < header.TagCount; i++)
        {
            if (!tagReader.TryReadPod(out ArticleDetailTagV3RecordPod tag) ||
                !IsSliceValid(tag.Name, blob))
            {
                item = default;
                return false;
            }

            tags.Add(new TagCoreModel(tag.Id, PodUtf8Codec.ReadSlice(tag.Name, blob)));
        }

        if (!tagReader.IsConsumed)
        {
            item = default;
            return false;
        }

        var rightsReader = new BinaryPodReader(source.Slice(rightsOffset, rightsLength));
        if (!rightsReader.TryReadPod(out ArticleRightsV3RecordPod rightsPod) ||
            !rightsReader.IsConsumed ||
            !ValidateArticleRightsRecordSlices(rightsPod, blob))
        {
            item = default;
            return false;
        }

        string title = PodUtf8Codec.ReadSlice(article.Title, blob);
        string content = PodUtf8Codec.ReadSlice(article.Content, blob);
        string summary = PodUtf8Codec.ReadSlice(article.Summary, blob);
        string coverImageUrl = PodUtf8Codec.ReadSlice(article.CoverImageUrl, blob);
        string categoryName = PodUtf8Codec.ReadSlice(article.CategoryName, blob);
        DateTime createTime = PodTimeCodec.FromUnixMs(article.CreateTimeUnixMs);
        var category = new ArticleCategoryCoreModel(article.CategoryId, categoryName);
        int wordCount = content.Count(static ch => !char.IsWhiteSpace(ch));
        var pod = PodProjector.ProjectArticleDetail(article.Id, article.Views, createTime, article.CategoryId, categoryName, title, content, summary, out _);

        item = new ArticleDetailCoreModel(
            pod,
            article.Id,
            title,
            content,
            summary,
            coverImageUrl.Length == 0 ? null : coverImageUrl,
            article.Views,
            wordCount,
            Math.Max(1, (wordCount + 299) / 300),
            wordCount > 5_000,
            createTime,
            category,
            tags,
            article.CategoryId,
            article.IsDeleted == 1,
            article.Status,
            FromUnixMsOrNull(article.ScheduledPublishAtUnixMs),
            FromUnixMsOrNull(article.PublishedAtUnixMs),
            FromUnixMsOrNull(article.UpdatedAtUnixMs),
            BuildArticleRightsCoreModel(rightsPod, blob));
        return true;
    }

    public static void WriteRelatedReading(RelatedReadingResponse response, IBufferWriter<byte> destination)
    {
        IReadOnlyList<RelatedReadingItem> related = response.Related;
        var blob = new List<byte>(Math.Max(128, related.Count * 96));
        var records = new List<RelatedReadingItemPod>(
            related.Count
            + (response.Previous is null ? 0 : 1)
            + (response.Next is null ? 0 : 1));

        foreach (RelatedReadingItem item in related)
        {
            records.Add(BuildRelatedReadingItemPod(item, blob));
        }

        if (response.Previous is not null)
        {
            records.Add(BuildRelatedReadingItemPod(response.Previous, blob));
        }

        if (response.Next is not null)
        {
            records.Add(BuildRelatedReadingItemPod(response.Next, blob));
        }

        var header = new MutableRelatedReadingHeaderPod
        {
            RelatedCount = related.Count,
            HasPrevious = response.Previous is null ? (byte)0 : (byte)1,
            HasNext = response.Next is null ? (byte)0 : (byte)1
        };

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(Cast<MutableRelatedReadingHeaderPod, RelatedReadingHeaderPod>(header));
        foreach (RelatedReadingItemPod record in records)
        {
            writer.WritePod(record);
        }

        writer.WriteBytes(CollectionsMarshal.AsSpan(blob));
    }

    public static byte[] EncodeRelatedReading(RelatedReadingResponse response)
        => EncodeToArray(256 + response.Related.Count * 128, writer => WriteRelatedReading(response, writer));

    public static bool TryDecodeRelatedReading(ReadOnlyMemory<byte> bytes, out RelatedReadingResponse response)
    {
        var reader = new BinaryPodReader(bytes.Span);
        if (!reader.TryReadPod(out RelatedReadingHeaderPod header) ||
            header.RelatedCount < 0 ||
            header.HasPrevious > 1 ||
            header.HasNext > 1)
        {
            response = new RelatedReadingResponse([], null, null);
            return false;
        }

        int recordCount = header.RelatedCount + header.HasPrevious + header.HasNext;
        var pods = new List<RelatedReadingItemPod>(recordCount);
        for (int i = 0; i < recordCount; i++)
        {
            if (!reader.TryReadPod(out RelatedReadingItemPod pod) || pod.HasSummary > 1)
            {
                response = new RelatedReadingResponse([], null, null);
                return false;
            }

            pods.Add(pod);
        }

        if (!reader.TryReadBytes(out ReadOnlySpan<byte> blob))
        {
            response = new RelatedReadingResponse([], null, null);
            return false;
        }

        var related = new List<RelatedReadingItem>(header.RelatedCount);
        for (int i = 0; i < header.RelatedCount; i++)
        {
            related.Add(BuildRelatedReadingItem(pods[i], blob));
        }

        int optionalIndex = header.RelatedCount;
        RelatedReadingItem? previous = null;
        if (header.HasPrevious == 1)
        {
            previous = BuildRelatedReadingItem(pods[optionalIndex], blob);
            optionalIndex++;
        }

        RelatedReadingItem? next = null;
        if (header.HasNext == 1)
        {
            next = BuildRelatedReadingItem(pods[optionalIndex], blob);
        }

        response = new RelatedReadingResponse(related, previous, next);
        return reader.IsConsumed;
    }

    private static RelatedReadingItemPod BuildRelatedReadingItemPod(RelatedReadingItem item, List<byte> blob)
    {
        var mutable = new MutableRelatedReadingItemPod
        {
            Id = item.Id,
            CreateTimeUnixMs = PodTimeCodec.ToUnixMs(item.CreateTime),
            HasSummary = item.Summary is null ? (byte)0 : (byte)1,
            Title = PodUtf8Codec.AppendSlice(item.Title ?? string.Empty, blob),
            Summary = item.Summary is null ? default : PodUtf8Codec.AppendSlice(item.Summary, blob),
            Reason = PodUtf8Codec.AppendSlice(item.Reason ?? string.Empty, blob)
        };

        return Cast<MutableRelatedReadingItemPod, RelatedReadingItemPod>(mutable);
    }

    private static RelatedReadingItem BuildRelatedReadingItem(RelatedReadingItemPod pod, ReadOnlySpan<byte> blob)
        => new(
            pod.Id,
            PodUtf8Codec.ReadSlice(pod.Title, blob),
            pod.HasSummary == 1 ? PodUtf8Codec.ReadSlice(pod.Summary, blob) : null,
            PodTimeCodec.FromUnixMs(pod.CreateTimeUnixMs),
            PodUtf8Codec.ReadSlice(pod.Reason, blob));

    private static int BuildArticleDetailRightsFlags(ArticleRightsCoreModel rights)
    {
        int flags = 0;
        if (rights.Enabled)
        {
            flags |= ArticleDetailRightsFlagEnabled;
        }

        if (rights.AllowCodeCopy)
        {
            flags |= ArticleDetailRightsFlagAllowCodeCopy;
        }

        if (rights.ShowPublicBadge)
        {
            flags |= ArticleDetailRightsFlagShowPublicBadge;
        }

        if (rights.ProofBindingEnabled)
        {
            flags |= ArticleDetailRightsFlagProofBindingEnabled;
        }

        if (rights.CopyrightYear.HasValue)
        {
            flags |= ArticleDetailRightsFlagHasCopyrightYear;
        }

        if (!string.IsNullOrEmpty(rights.CopyrightHolder))
        {
            flags |= ArticleDetailRightsFlagHasCopyrightHolder;
        }

        if (!string.IsNullOrEmpty(rights.RightsStatement))
        {
            flags |= ArticleDetailRightsFlagHasRightsStatement;
        }

        if (!string.IsNullOrEmpty(rights.AttributionTemplate))
        {
            flags |= ArticleDetailRightsFlagHasAttributionTemplate;
        }

        if (!string.IsNullOrEmpty(rights.CanonicalUrl))
        {
            flags |= ArticleDetailRightsFlagHasCanonicalUrl;
        }

        if (!string.IsNullOrEmpty(rights.ProofUrl))
        {
            flags |= ArticleDetailRightsFlagHasProofUrl;
        }

        if (!string.IsNullOrEmpty(rights.ProofStatus))
        {
            flags |= ArticleDetailRightsFlagHasProofStatus;
        }

        return flags;
    }

    private static bool IsSupportedArticleDetailPayload(uint magic, int version)
        => (magic == ArticleDetailV3PayloadMagic && version == ArticleDetailV3PayloadVersion) ||
           (magic == ArticleDetailV4PayloadMagic && version == ArticleDetailV4PayloadVersion);

    private static int ResolveArticleDetailRecordSize(int version)
        => version == ArticleDetailV4PayloadVersion
            ? Unsafe.SizeOf<ArticleDetailV4RecordPod>()
            : Unsafe.SizeOf<ArticleDetailV3RecordPod>();

    private static bool TryReadArticleDetailRecord(
        ReadOnlySpan<byte> source,
        ReadOnlySpan<byte> blob,
        int version,
        out DecodedArticleDetailRecord decoded)
    {
        var reader = new BinaryPodReader(source);
        if (version == ArticleDetailV4PayloadVersion)
        {
            if (!reader.TryReadPod(out ArticleDetailV4RecordPod record) ||
                !reader.IsConsumed ||
                record.IsDeleted > 1 ||
                !ValidateArticleDetailRecordSlices(record, blob))
            {
                decoded = default;
                return false;
            }

            decoded = new DecodedArticleDetailRecord(
                record.Id, record.Views, record.CreateTimeUnixMs, record.CategoryId, record.Status,
                record.ScheduledPublishAtUnixMs, record.PublishedAtUnixMs, record.UpdatedAtUnixMs,
                record.IsDeleted, record.Title, record.Content, record.Summary, record.CoverImageUrl, record.CategoryName);
            return true;
        }

        if (!reader.TryReadPod(out ArticleDetailV3RecordPod legacy) ||
            !reader.IsConsumed ||
            legacy.IsDeleted > 1 ||
            !ValidateArticleDetailRecordSlices(legacy, blob))
        {
            decoded = default;
            return false;
        }

        decoded = new DecodedArticleDetailRecord(
            legacy.Id, legacy.Views, legacy.CreateTimeUnixMs, legacy.CategoryId, legacy.Status,
            legacy.ScheduledPublishAtUnixMs, legacy.PublishedAtUnixMs, 0,
            legacy.IsDeleted, legacy.Title, legacy.Content, legacy.Summary, legacy.CoverImageUrl, legacy.CategoryName);
        return true;
    }

    private static bool ValidateArticleDetailRecordSlices(ArticleDetailV3RecordPod record, ReadOnlySpan<byte> blob)
        => IsSliceValid(record.Title, blob) &&
           IsSliceValid(record.Content, blob) &&
           IsSliceValid(record.Summary, blob) &&
           IsSliceValid(record.CoverImageUrl, blob) &&
           IsSliceValid(record.CategoryName, blob);

    private static bool ValidateArticleDetailRecordSlices(ArticleDetailV4RecordPod record, ReadOnlySpan<byte> blob)
        => IsSliceValid(record.Title, blob) &&
           IsSliceValid(record.Content, blob) &&
           IsSliceValid(record.Summary, blob) &&
           IsSliceValid(record.CoverImageUrl, blob) &&
           IsSliceValid(record.CategoryName, blob);

    private static bool ValidateArticleRightsRecordSlices(ArticleRightsV3RecordPod record, ReadOnlySpan<byte> blob)
    {
        const int KnownFlags =
            ArticleDetailRightsFlagEnabled |
            ArticleDetailRightsFlagAllowCodeCopy |
            ArticleDetailRightsFlagShowPublicBadge |
            ArticleDetailRightsFlagProofBindingEnabled |
            ArticleDetailRightsFlagHasCopyrightYear |
            ArticleDetailRightsFlagHasCopyrightHolder |
            ArticleDetailRightsFlagHasRightsStatement |
            ArticleDetailRightsFlagHasAttributionTemplate |
            ArticleDetailRightsFlagHasCanonicalUrl |
            ArticleDetailRightsFlagHasProofUrl |
            ArticleDetailRightsFlagHasProofStatus;

        return record.MaxExcerptChars >= 0 &&
            (record.Flags & ~KnownFlags) == 0 &&
            IsSliceValid(record.LicenseType, blob) &&
            IsSliceValid(record.CopyrightHolder, blob) &&
            IsSliceValid(record.RightsStatement, blob) &&
            IsSliceValid(record.AttributionTemplate, blob) &&
            IsSliceValid(record.CopyPolicy, blob) &&
            IsSliceValid(record.CanonicalUrl, blob) &&
            IsSliceValid(record.PolicyHash, blob) &&
            IsSliceValid(record.ContentCanonicalHash, blob) &&
            IsSliceValid(record.ProofUrl, blob) &&
            IsSliceValid(record.ProofStatus, blob);
    }

    private static ArticleRightsCoreModel BuildArticleRightsCoreModel(ArticleRightsV3RecordPod record, ReadOnlySpan<byte> blob)
        => new(
            record.SnapshotId,
            record.ArticleRevisionId,
            record.RevisionNo,
            (record.Flags & ArticleDetailRightsFlagEnabled) != 0,
            PodUtf8Codec.ReadSlice(record.LicenseType, blob),
            ReadOptionalArticleDetailRightsSlice(record.CopyrightHolder, blob, ArticleDetailRightsFlagHasCopyrightHolder, record.Flags),
            (record.Flags & ArticleDetailRightsFlagHasCopyrightYear) != 0 ? record.CopyrightYear : null,
            ReadOptionalArticleDetailRightsSlice(record.RightsStatement, blob, ArticleDetailRightsFlagHasRightsStatement, record.Flags),
            ReadOptionalArticleDetailRightsSlice(record.AttributionTemplate, blob, ArticleDetailRightsFlagHasAttributionTemplate, record.Flags),
            PodUtf8Codec.ReadSlice(record.CopyPolicy, blob),
            record.MaxExcerptChars,
            (record.Flags & ArticleDetailRightsFlagAllowCodeCopy) != 0,
            (record.Flags & ArticleDetailRightsFlagShowPublicBadge) != 0,
            (record.Flags & ArticleDetailRightsFlagProofBindingEnabled) != 0,
            ReadOptionalArticleDetailRightsSlice(record.CanonicalUrl, blob, ArticleDetailRightsFlagHasCanonicalUrl, record.Flags),
            PodUtf8Codec.ReadSlice(record.PolicyHash, blob),
            PodUtf8Codec.ReadSlice(record.ContentCanonicalHash, blob),
            ReadOptionalArticleDetailRightsSlice(record.ProofUrl, blob, ArticleDetailRightsFlagHasProofUrl, record.Flags),
            ReadOptionalArticleDetailRightsSlice(record.ProofStatus, blob, ArticleDetailRightsFlagHasProofStatus, record.Flags));

    private static string? ReadOptionalArticleDetailRightsSlice(Utf8SliceRef slice, ReadOnlySpan<byte> blob, int flag, int flags)
        => (flags & flag) == 0 ? null : PodUtf8Codec.ReadSlice(slice, blob);

    private static bool IsSliceValid(Utf8SliceRef slice, ReadOnlySpan<byte> blob)
        => IsRangeWithin(slice.Offset, slice.Length, blob.Length);

    private static bool IsRangeWithin(int offset, int length, int total)
        => offset >= 0 && length >= 0 && offset <= total && length <= total - offset;

    private readonly record struct DecodedArticleDetailRecord(
        int Id,
        int Views,
        long CreateTimeUnixMs,
        int CategoryId,
        int Status,
        long ScheduledPublishAtUnixMs,
        long PublishedAtUnixMs,
        long UpdatedAtUnixMs,
        byte IsDeleted,
        Utf8SliceRef Title,
        Utf8SliceRef Content,
        Utf8SliceRef Summary,
        Utf8SliceRef CoverImageUrl,
        Utf8SliceRef CategoryName);

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
    private struct MutableArticleRightsWriteRequestPod
    {
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef LicenseType;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef CopyrightHolder;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef RightsStatement;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef AttributionTemplate;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef CopyPolicy;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableArticleDetailV4HeaderPod
    {
        public uint Magic;
        public int Version;
        public uint Flags;
        public int ArticleRecordOffset;
        public int ArticleRecordLength;
        public int TagOffset;
        public int TagCount;
        public int RightsRecordOffset;
        public int RightsRecordLength;
        public int BlobOffset;
        public int BlobLength;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableArticleDetailV4RecordPod
    {
        public int Id;
        public int Views;
        public long CreateTimeUnixMs;
        public int CategoryId;
        public int Status;
        public long ScheduledPublishAtUnixMs;
        public long PublishedAtUnixMs;
        public long UpdatedAtUnixMs;
        public byte IsDeleted;
        public byte Reserved0;
        public ushort Reserved1;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Title;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Content;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Summary;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef CoverImageUrl;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef CategoryName;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableArticleDetailTagV3RecordPod
    {
        public int Id;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Name;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableArticleRightsV3RecordPod
    {
        public long SnapshotId;
        public long ArticleRevisionId;
        public int RevisionNo;
        public int Flags;
        public int CopyrightYear;
        public int MaxExcerptChars;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef LicenseType;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef CopyrightHolder;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef RightsStatement;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef AttributionTemplate;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef CopyPolicy;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef CanonicalUrl;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef PolicyHash;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef ContentCanonicalHash;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef ProofUrl;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef ProofStatus;
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

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableRelatedReadingHeaderPod
    {
        public int RelatedCount;
        public byte HasPrevious;
        public byte HasNext;
        public ushort Reserved0;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableRelatedReadingItemPod
    {
        public int Id;
        public long CreateTimeUnixMs;
        public byte HasSummary;
        public byte Reserved0;
        public ushort Reserved1;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Title;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Summary;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Reason;
    }
}
