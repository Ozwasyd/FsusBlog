using System.Buffers;
using System.Buffers.Binary;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Codecs;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Primitives;

internal static partial class PodBinaryCodecBatchProfiler
{
    private const int ArticlePageCursorEnvelopeMagic = 0x41535046;
    private const int ArticlePageCursorEnvelopeVersion = 1;
    private const uint ArticleDetailV4PayloadMagic = 0x41524434;
    private const int ArticleDetailV4PayloadVersion = 4;
    private const int RightsFlagEnabled = 1 << 0;
    private const int RightsFlagAllowCodeCopy = 1 << 1;
    private const int RightsFlagShowPublicBadge = 1 << 2;
    private const int RightsFlagProofBindingEnabled = 1 << 3;
    private const int RightsFlagHasCopyrightYear = 1 << 4;
    private const int RightsFlagHasCopyrightHolder = 1 << 5;
    private const int RightsFlagHasRightsStatement = 1 << 6;
    private const int RightsFlagHasAttributionTemplate = 1 << 7;
    private const int RightsFlagHasCanonicalUrl = 1 << 8;
    private const int RightsFlagHasProofUrl = 1 << 9;
    private const int RightsFlagHasProofStatus = 1 << 10;

    private static byte[] EncodeArticlePageList(
        CorePageResult<ArticleListCoreModel> page,
        bool exactCapacities,
        out CollectionShape shape)
    {
        int tagCount = exactCapacities
            ? page.Items.Sum(static item => item.Tags.Count)
            : 0;
        int blobByteCount = exactCapacities
            ? page.Items.Sum(static item =>
                PodUtf8Codec.GetSliceByteCount(item.Category.Name)
                + PodUtf8Codec.GetSliceByteCount(item.Title)
                + PodUtf8Codec.GetSliceByteCount(item.Summary)
                + item.Tags.Sum(static tag => PodUtf8Codec.GetSliceByteCount(tag.Name)))
            : Math.Max(256, page.Items.Count * 128);
        using var destination = new PooledByteBufferWriter(1024);
        var blob = new List<byte>(blobByteCount);
        var tagRecords = exactCapacities
            ? new List<PageTagRecord>(tagCount)
            : [];
        var itemRecords = new List<PageItemRecord>(page.Items.Count);
        foreach (ArticleListCoreModel item in page.Items)
        {
            int tagStart = tagRecords.Count;
            foreach (TagCoreModel tag in item.Tags)
            {
                tagRecords.Add(new PageTagRecord(tag.Id, PodUtf8Codec.AppendSlice(tag.Name, blob)));
            }

            itemRecords.Add(new PageItemRecord(
                item,
                PodUtf8Codec.AppendSlice(item.Category.Name, blob),
                PodUtf8Codec.AppendSlice(item.Title, blob),
                PodUtf8Codec.AppendSlice(item.Summary, blob),
                tagStart,
                item.Tags.Count));
        }

        var writer = new ReferenceWriter(destination);
        WriteArticlePageHeader(ref writer, page, tagRecords.Count, blob.Count);
        destination.Write(CollectionsMarshal.AsSpan(blob));
        foreach (PageItemRecord record in itemRecords)
        {
            WriteArticlePageItem(ref writer, record.Item, record.CategoryName, record.Title, record.Summary, record.TagStart, record.TagCount);
        }

        foreach (PageTagRecord record in tagRecords)
        {
            writer.WriteInt32(record.Id);
            writer.WriteSlice(record.Name);
        }

        int wasteBytes = checked(
            blob.Capacity - blob.Count
            + (tagRecords.Capacity - tagRecords.Count) * Unsafe.SizeOf<PageTagRecord>()
            + (itemRecords.Capacity - itemRecords.Count) * Unsafe.SizeOf<PageItemRecord>());
        shape = new CollectionShape(
            3,
            0,
            wasteBytes,
            blob.Capacity,
            tagRecords.Capacity,
            itemRecords.Capacity);
        return destination.ToArray();
    }

    private static byte[] EncodeArticlePageDirect(CorePageResult<ArticleListCoreModel> page)
    {
        int tagRecordCount = 0;
        int blobLength = 0;
        foreach (ArticleListCoreModel item in page.Items)
        {
            tagRecordCount = checked(tagRecordCount + item.Tags.Count);
            foreach (TagCoreModel tag in item.Tags)
            {
                blobLength = checked(blobLength + PodUtf8Codec.GetSliceByteCount(tag.Name));
            }

            blobLength = checked(blobLength + PodUtf8Codec.GetSliceByteCount(item.Category.Name));
            blobLength = checked(blobLength + PodUtf8Codec.GetSliceByteCount(item.Title));
            blobLength = checked(blobLength + PodUtf8Codec.GetSliceByteCount(item.Summary));
        }

        using var destination = new PooledByteBufferWriter(1024);
        var writer = new ReferenceWriter(destination);
        WriteArticlePageHeader(ref writer, page, tagRecordCount, blobLength);
        foreach (ArticleListCoreModel item in page.Items)
        {
            foreach (TagCoreModel tag in item.Tags)
            {
                PodUtf8Codec.WriteSliceBytes(tag.Name, destination, PodUtf8Codec.GetSliceByteCount(tag.Name));
            }

            PodUtf8Codec.WriteSliceBytes(item.Category.Name, destination, PodUtf8Codec.GetSliceByteCount(item.Category.Name));
            PodUtf8Codec.WriteSliceBytes(item.Title, destination, PodUtf8Codec.GetSliceByteCount(item.Title));
            PodUtf8Codec.WriteSliceBytes(item.Summary, destination, PodUtf8Codec.GetSliceByteCount(item.Summary));
        }

        int blobOffset = 0;
        int tagStart = 0;
        foreach (ArticleListCoreModel item in page.Items)
        {
            foreach (TagCoreModel tag in item.Tags)
            {
                blobOffset = checked(blobOffset + PodUtf8Codec.GetSliceByteCount(tag.Name));
            }

            Utf8SliceRef category = SliceAt(ref blobOffset, item.Category.Name);
            Utf8SliceRef title = SliceAt(ref blobOffset, item.Title);
            Utf8SliceRef summary = SliceAt(ref blobOffset, item.Summary);
            WriteArticlePageItem(ref writer, item, category, title, summary, tagStart, item.Tags.Count);
            tagStart = checked(tagStart + item.Tags.Count);
        }

        blobOffset = 0;
        foreach (ArticleListCoreModel item in page.Items)
        {
            foreach (TagCoreModel tag in item.Tags)
            {
                writer.WriteInt32(tag.Id);
                writer.WriteSlice(SliceAt(ref blobOffset, tag.Name));
            }

            blobOffset = checked(blobOffset + PodUtf8Codec.GetSliceByteCount(item.Category.Name));
            blobOffset = checked(blobOffset + PodUtf8Codec.GetSliceByteCount(item.Title));
            blobOffset = checked(blobOffset + PodUtf8Codec.GetSliceByteCount(item.Summary));
        }

        return destination.ToArray();
    }

    private static byte[] EncodeArticlePagePooled(CorePageResult<ArticleListCoreModel> page)
    {
        using var destination = new PooledByteBufferWriter(1024);
        PodBinaryCodec.WriteArticlePageWithScratchPolicy(
            page,
            destination,
            stackScratchByteBudget: 0,
            ArrayPool<PodBinaryCodec.ArticlePageItemSlicePlan>.Shared,
            ArrayPool<Utf8SliceRef>.Shared);
        return destination.ToArray();
    }

    private static byte[] EncodeArticlePageAdaptive(CorePageResult<ArticleListCoreModel> page)
    {
        using var destination = new PooledByteBufferWriter(1024);
        PodBinaryCodec.WriteArticlePage(page, destination);
        return destination.ToArray();
    }

    private static byte[] EncodeArticleDetailAdaptive(ArticleDetailCoreModel detail)
    {
        using var destination = new PooledByteBufferWriter(
            2048 + detail.Content.Length + detail.Tags.Count * 32);
        PodBinaryCodec.WriteArticleDetail(detail, destination);
        return destination.ToArray();
    }

    private static PoolShape MeasurePoolShape(int itemCount, int tagCount)
    {
        if (itemCount == 0 && tagCount == 0)
        {
            return new PoolShape(0);
        }

        PodBinaryCodec.ArticlePageItemSlicePlan[] items = ArrayPool<PodBinaryCodec.ArticlePageItemSlicePlan>.Shared.Rent(itemCount);
        Utf8SliceRef[] tags = ArrayPool<Utf8SliceRef>.Shared.Rent(tagCount);
        try
        {
            int wasteBytes = checked(
                (items.Length - itemCount) * Unsafe.SizeOf<PodBinaryCodec.ArticlePageItemSlicePlan>()
                + (tags.Length - tagCount) * Unsafe.SizeOf<Utf8SliceRef>());
            return new PoolShape(wasteBytes);
        }
        finally
        {
            ArrayPool<PodBinaryCodec.ArticlePageItemSlicePlan>.Shared.Return(items, clearArray: false);
            ArrayPool<Utf8SliceRef>.Shared.Return(tags, clearArray: false);
        }
    }

    private static void WriteArticlePageHeader(
        ref ReferenceWriter writer,
        CorePageResult<ArticleListCoreModel> page,
        int tagCount,
        int blobLength)
    {
        writer.WriteInt32(ArticlePageCursorEnvelopeMagic);
        writer.WriteInt32(ArticlePageCursorEnvelopeVersion);
        writer.WriteInt64(ParseCursor(page.NextCursor));
        writer.WriteByte(page.HasMore ? (byte)1 : (byte)0);
        writer.WriteInt32(page.Total);
        writer.WriteInt32(page.Items.Count);
        writer.WriteInt32(tagCount);
        writer.WriteInt32(blobLength);
    }

    private static void WriteArticlePageItem(
        ref ReferenceWriter writer,
        ArticleListCoreModel item,
        Utf8SliceRef category,
        Utf8SliceRef title,
        Utf8SliceRef summary,
        int tagStart,
        int tagCount)
    {
        writer.WriteInt32(item.Id);
        writer.WriteInt32(item.Views);
        writer.WriteInt64(PodTimeCodec.ToUnixMs(item.CreateTime));
        writer.WriteInt32(item.Category.Id);
        writer.WriteSlice(category);
        writer.WriteSlice(title);
        writer.WriteSlice(summary);
        writer.WriteInt32(tagStart);
        writer.WriteInt32(tagCount);
        writer.WriteByte(item.IsDeleted == true ? (byte)1 : (byte)0);
        writer.WriteByte(item.IsDeleted.HasValue ? (byte)1 : (byte)0);
        writer.WriteByte(0);
        writer.WriteByte(0);
        writer.WriteInt32(item.Status);
        writer.WriteInt64(ToUnixMsOrZero(item.ScheduledPublishAt));
        writer.WriteInt64(ToUnixMsOrZero(item.PublishedAt));
    }

    private static Utf8SliceRef SliceAt(ref int offset, string? value)
    {
        int length = PodUtf8Codec.GetSliceByteCount(value);
        Utf8SliceRef slice = PodUtf8Codec.CreateSliceRef(offset, length);
        offset = checked(offset + length);
        return slice;
    }

    private static byte[] EncodeArticleDetailLegacy(ArticleDetailCoreModel item)
    {
        using var destination = new PooledByteBufferWriter(2048 + item.Content.Length + item.Tags.Count * 32);
        var blob = new List<byte>(Math.Max(
            512,
            item.Content.Length
            + item.Title.Length
            + (item.Summary?.Length ?? 0)
            + (item.CoverImageUrl?.Length ?? 0)));
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
            Summary = PodUtf8Codec.AppendSlice(item.Summary, blob),
            CoverImageUrl = PodUtf8Codec.AppendSlice(item.CoverImageUrl, blob),
            CategoryName = PodUtf8Codec.AppendSlice(item.Category.Name, blob)
        };
        var tags = new List<ArticleDetailTagV3RecordPod>(item.Tags.Count);
        foreach (TagCoreModel tag in item.Tags)
        {
            tags.Add(Cast<MutableArticleDetailTagV3RecordPod, ArticleDetailTagV3RecordPod>(
                new MutableArticleDetailTagV3RecordPod
                {
                    Id = tag.Id,
                    Name = PodUtf8Codec.AppendSlice(tag.Name, blob)
                }));
        }

        var rightsRecord = new MutableArticleRightsV3RecordPod
        {
            SnapshotId = rights.SnapshotId,
            ArticleRevisionId = rights.ArticleRevisionId,
            RevisionNo = rights.RevisionNo,
            Flags = BuildRightsFlags(rights),
            CopyrightYear = rights.CopyrightYear.GetValueOrDefault(),
            MaxExcerptChars = rights.MaxExcerptChars,
            LicenseType = PodUtf8Codec.AppendSlice(rights.LicenseType, blob),
            CopyrightHolder = PodUtf8Codec.AppendSlice(rights.CopyrightHolder, blob),
            RightsStatement = PodUtf8Codec.AppendSlice(rights.RightsStatement, blob),
            AttributionTemplate = PodUtf8Codec.AppendSlice(rights.AttributionTemplate, blob),
            CopyPolicy = PodUtf8Codec.AppendSlice(rights.CopyPolicy, blob),
            CanonicalUrl = PodUtf8Codec.AppendSlice(rights.CanonicalUrl, blob),
            PolicyHash = PodUtf8Codec.AppendSlice(rights.PolicyHash, blob),
            ContentCanonicalHash = PodUtf8Codec.AppendSlice(rights.ContentCanonicalHash, blob),
            ProofUrl = PodUtf8Codec.AppendSlice(rights.ProofUrl, blob),
            ProofStatus = PodUtf8Codec.AppendSlice(rights.ProofStatus, blob)
        };
        int headerSize = Unsafe.SizeOf<ArticleDetailV4HeaderPod>();
        int articleSize = Unsafe.SizeOf<ArticleDetailV4RecordPod>();
        int tagSize = Unsafe.SizeOf<ArticleDetailTagV3RecordPod>();
        int rightsSize = Unsafe.SizeOf<ArticleRightsV3RecordPod>();
        var header = new MutableArticleDetailV4HeaderPod
        {
            Magic = ArticleDetailV4PayloadMagic,
            Version = ArticleDetailV4PayloadVersion,
            ArticleRecordOffset = headerSize,
            ArticleRecordLength = articleSize,
            TagOffset = headerSize + articleSize,
            TagCount = tags.Count,
            RightsRecordOffset = headerSize + articleSize + tags.Count * tagSize,
            RightsRecordLength = rightsSize,
            BlobOffset = headerSize + articleSize + tags.Count * tagSize + rightsSize,
            BlobLength = blob.Count
        };
        var writer = new ReferenceWriter(destination);
        writer.WritePod(Cast<MutableArticleDetailV4HeaderPod, ArticleDetailV4HeaderPod>(header));
        writer.WritePod(Cast<MutableArticleDetailV4RecordPod, ArticleDetailV4RecordPod>(article));
        foreach (ArticleDetailTagV3RecordPod tag in tags)
        {
            writer.WritePod(tag);
        }

        writer.WritePod(Cast<MutableArticleRightsV3RecordPod, ArticleRightsV3RecordPod>(rightsRecord));
        destination.Write(CollectionsMarshal.AsSpan(blob));
        return destination.ToArray();
    }

    private static long ParseCursor(string? cursor)
    {
        if (string.IsNullOrWhiteSpace(cursor))
        {
            return 0;
        }

        int separator = cursor.IndexOf(':', StringComparison.Ordinal);
        string value = separator > 0 ? cursor[..separator] : cursor;
        return long.TryParse(value, out long parsed) ? parsed : 0;
    }

    private static long ToUnixMsOrZero(DateTime? value)
        => value.HasValue ? PodTimeCodec.ToUnixMs(value.Value) : 0;

    private static int BuildRightsFlags(ArticleRightsCoreModel rights)
    {
        int flags = 0;
        if (rights.Enabled) flags |= RightsFlagEnabled;
        if (rights.AllowCodeCopy) flags |= RightsFlagAllowCodeCopy;
        if (rights.ShowPublicBadge) flags |= RightsFlagShowPublicBadge;
        if (rights.ProofBindingEnabled) flags |= RightsFlagProofBindingEnabled;
        if (rights.CopyrightYear.HasValue) flags |= RightsFlagHasCopyrightYear;
        if (!string.IsNullOrEmpty(rights.CopyrightHolder)) flags |= RightsFlagHasCopyrightHolder;
        if (!string.IsNullOrEmpty(rights.RightsStatement)) flags |= RightsFlagHasRightsStatement;
        if (!string.IsNullOrEmpty(rights.AttributionTemplate)) flags |= RightsFlagHasAttributionTemplate;
        if (!string.IsNullOrEmpty(rights.CanonicalUrl)) flags |= RightsFlagHasCanonicalUrl;
        if (!string.IsNullOrEmpty(rights.ProofUrl)) flags |= RightsFlagHasProofUrl;
        if (!string.IsNullOrEmpty(rights.ProofStatus)) flags |= RightsFlagHasProofStatus;
        return flags;
    }

    private static TTo Cast<TFrom, TTo>(TFrom value)
        where TFrom : unmanaged
        where TTo : unmanaged
    {
        if (Unsafe.SizeOf<TFrom>() != Unsafe.SizeOf<TTo>())
        {
            throw new InvalidOperationException($"POD size mismatch: {typeof(TFrom).Name} -> {typeof(TTo).Name}");
        }

        Span<TFrom> source = stackalloc TFrom[1];
        source[0] = value;
        return MemoryMarshal.Read<TTo>(MemoryMarshal.AsBytes(source));
    }

    private readonly record struct PageTagRecord(int Id, Utf8SliceRef Name);

    private readonly record struct PageItemRecord(
        ArticleListCoreModel Item,
        Utf8SliceRef CategoryName,
        Utf8SliceRef Title,
        Utf8SliceRef Summary,
        int TagStart,
        int TagCount);

    private struct ReferenceWriter(IBufferWriter<byte> destination)
    {
        public void WriteInt32(int value)
        {
            Span<byte> span = destination.GetSpan(4);
            BinaryPrimitives.WriteInt32LittleEndian(span, value);
            destination.Advance(4);
        }

        public void WriteInt64(long value)
        {
            Span<byte> span = destination.GetSpan(8);
            BinaryPrimitives.WriteInt64LittleEndian(span, value);
            destination.Advance(8);
        }

        public void WriteByte(byte value)
        {
            destination.GetSpan(1)[0] = value;
            destination.Advance(1);
        }

        public void WriteSlice(Utf8SliceRef value)
        {
            WriteInt32(value.Offset);
            WriteInt32(value.Length);
        }

        public void WritePod<T>(T value) where T : unmanaged
        {
            Span<byte> span = destination.GetSpan(Unsafe.SizeOf<T>());
            MemoryMarshal.Write(span, in value);
            destination.Advance(Unsafe.SizeOf<T>());
        }
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
        public Utf8SliceRef Title;
        public Utf8SliceRef Content;
        public Utf8SliceRef Summary;
        public Utf8SliceRef CoverImageUrl;
        public Utf8SliceRef CategoryName;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableArticleDetailTagV3RecordPod
    {
        public int Id;
        public Utf8SliceRef Name;
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
        public Utf8SliceRef LicenseType;
        public Utf8SliceRef CopyrightHolder;
        public Utf8SliceRef RightsStatement;
        public Utf8SliceRef AttributionTemplate;
        public Utf8SliceRef CopyPolicy;
        public Utf8SliceRef CanonicalUrl;
        public Utf8SliceRef PolicyHash;
        public Utf8SliceRef ContentCanonicalHash;
        public Utf8SliceRef ProofUrl;
        public Utf8SliceRef ProofStatus;
    }
}
