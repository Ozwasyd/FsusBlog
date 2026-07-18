using System.Buffers;
using System.Buffers.Binary;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;

using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Codecs;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Mapping.Projectors;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Primitives;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PodBinaryCodecBatchAllocationTests
{
    [Fact]
    public void ArticlePage_OptimizedWriter_IsByteIdenticalAcrossRequiredScenarioMatrix()
    {
        foreach (int itemCount in new[] { 0, 1, 10, 50, 100 })
        {
            foreach (int tagCount in new[] { 0, 2, 8 })
            {
                foreach (TextProfile profile in TextProfiles())
                {
                    CorePageResult<ArticleListCoreModel> page = BuildArticlePage(itemCount, tagCount, profile);

                    byte[] expected = LegacyReference.EncodeArticlePage(page);
                    byte[] actual = PodBinaryCodec.EncodeArticlePage(page);

                    Assert.Equal(expected, actual);
                    Assert.True(PodBinaryCodec.TryDecodeArticlePage(actual, out CorePageResult<ArticleListCoreModel> decoded));
                    Assert.Equal(itemCount, decoded.Items.Count);
                }
            }
        }
    }

    [Fact]
    public void ArticlePage_RandomizedUtf8Distribution_IsByteIdenticalToLegacyWriter()
    {
        var random = new Random(1154);
        for (int iteration = 0; iteration < 96; iteration++)
        {
            int itemCount = random.Next(0, 101);
            int tagCount = random.Next(0, 9);
            var profile = new TextProfile(
                $"random-{iteration}",
                RandomText(random, random.Next(0, 49)),
                RandomText(random, random.Next(0, 512)),
                RandomText(random, random.Next(0, 17)));
            CorePageResult<ArticleListCoreModel> page = BuildArticlePage(itemCount, tagCount, profile);

            Assert.Equal(LegacyReference.EncodeArticlePage(page), PodBinaryCodec.EncodeArticlePage(page));
        }
    }

    [Fact]
    public void ArticleDetail_DirectBlobWriter_IsByteIdenticalToLegacyWriter()
    {
        foreach (ArticleDetailCoreModel detail in new[]
                 {
                     BuildArticleDetail("short", "small body", 0),
                     BuildArticleDetail("threshold-minus-one", new string('x', PodBinaryCodec.ArticleDetailDirectCharThreshold - 1), 2),
                     BuildArticleDetail("threshold", new string('x', PodBinaryCodec.ArticleDetailDirectCharThreshold), 2),
                     BuildArticleDetail("混合 Mixed 标题", new string('字', 9_000), 8),
                     BuildArticleDetail("large", new string('x', 128 * 1024), 32)
                 })
        {
            byte[] expected = LegacyReference.EncodeArticleDetail(detail);
            byte[] actual = PodBinaryCodec.EncodeArticleDetail(detail);

            Assert.Equal(expected, actual);
            Assert.True(PodBinaryCodec.TryDecodeArticleDetail(actual, out ArticleDetailCoreModel decoded));
            Assert.Equal(detail.Content, decoded.Content);
            Assert.Equal(detail.Tags.Count, decoded.Tags.Count);
        }
    }

    [Fact]
    public void ArticleWriters_ConcurrentEncode_ReturnStableBytes()
    {
        CorePageResult<ArticleListCoreModel> page = BuildArticlePage(100, 8, TextProfiles()[^1]);
        ArticleDetailCoreModel detail = BuildArticleDetail("并发 detail", new string('文', 32_000), 32);
        byte[] expectedPage = LegacyReference.EncodeArticlePage(page);
        byte[] expectedDetail = LegacyReference.EncodeArticleDetail(detail);

        Parallel.For(0, 64, _ =>
        {
            Assert.Equal(expectedPage, PodBinaryCodec.EncodeArticlePage(page));
            Assert.Equal(expectedDetail, PodBinaryCodec.EncodeArticleDetail(detail));
        });
    }

    [Fact]
    public void ArticlePage_InvalidUtf8_FailsBeforeDestinationMutation()
    {
        CorePageResult<ArticleListCoreModel> validPage = BuildArticlePage(
            1,
            2,
            new TextProfile("invalid", "title", "summary", "category"));
        ArticleListCoreModel invalidItem = validPage.Items[0] with
        {
            Title = "\uD800"
        };
        CorePageResult<ArticleListCoreModel> page = validPage with
        {
            Items = new[] { invalidItem }
        };
        var destination = new ArrayBufferWriter<byte>();

        Assert.Throws<EncoderFallbackException>(() => PodBinaryCodec.WriteArticlePage(page, destination));
        Assert.Equal(0, destination.WrittenCount);
    }

    [Fact]
    public void ArticlePage_PooledScratch_ReturnsBothBuffersWhenDestinationThrows()
    {
        CorePageResult<ArticleListCoreModel> page = BuildArticlePage(100, 8, TextProfiles()[1]);
        var itemPool = new TrackingArrayPool<PodBinaryCodec.ArticlePageItemSlicePlan>();
        var tagPool = new TrackingArrayPool<Utf8SliceRef>();

        Assert.Throws<InvalidOperationException>(() => PodBinaryCodec.WriteArticlePageWithScratchPolicy(
            page,
            new ThrowingBufferWriter(),
            stackScratchByteBudget: 0,
            itemPool,
            tagPool));

        Assert.Equal(1, itemPool.RentCount);
        Assert.Equal(1, itemPool.ReturnCount);
        Assert.Equal(1, tagPool.RentCount);
        Assert.Equal(1, tagPool.ReturnCount);
        Assert.False(itemPool.LastClearArray);
        Assert.False(tagPool.LastClearArray);
    }

    [Fact]
    public void ArticlePage_SecondPoolRentFailure_ReturnsFirstBufferExactlyOnce()
    {
        CorePageResult<ArticleListCoreModel> page = BuildArticlePage(100, 8, TextProfiles()[1]);
        var itemPool = new TrackingArrayPool<PodBinaryCodec.ArticlePageItemSlicePlan>();
        var tagPool = new ThrowingArrayPool<Utf8SliceRef>();

        Assert.Throws<InvalidOperationException>(() => PodBinaryCodec.WriteArticlePageWithScratchPolicy(
            page,
            new ArrayBufferWriter<byte>(),
            stackScratchByteBudget: 0,
            itemPool,
            tagPool));

        Assert.Equal(1, itemPool.RentCount);
        Assert.Equal(1, itemPool.ReturnCount);
        Assert.Equal(1, tagPool.RentCount);
        Assert.Equal(0, tagPool.ReturnCount);
    }

    [Fact]
    public void Utf8PlanningHelpers_RejectFixedAndSliceOverflowAndLengthDrift()
    {
        Assert.Equal(7, PodUtf8Codec.GetSliceByteCount("字🙂"));
        Assert.Throws<ArgumentException>(() => PodUtf8Codec.ToFixed128(new string('界', 43)));
        Assert.Throws<OverflowException>(() => PodUtf8Codec.CreateSliceRef(int.MaxValue, 1));

        var destination = new ArrayBufferWriter<byte>();
        Assert.Throws<InvalidOperationException>(() => PodUtf8Codec.WriteSliceBytes("字", destination, 4));
        Assert.Equal(0, destination.WrittenCount);
    }

    private static TextProfile[] TextProfiles()
        =>
        [
            new("ascii-short", "title", "summary", "category"),
            new("cjk-short", "标题", "摘要", "分类"),
            new("mixed-short", "Title-标题", "Summary-摘要", "Category-分类"),
            new("ascii-medium", new string('t', 64), new string('s', 192), new string('c', 24)),
            new("cjk-medium", new string('题', 64), new string('摘', 192), new string('类', 24)),
            new("mixed-medium", string.Concat(Enumerable.Repeat("Ab标题", 24)), string.Concat(Enumerable.Repeat("Cd摘要", 96)), "Mixed分类Mixed分类"),
            new("ascii-long", new string('t', 192), new string('s', 1024), new string('c', 48)),
            new("cjk-long", new string('题', 64), new string('摘', 1024), new string('类', 32)),
            new("mixed-long", string.Concat(Enumerable.Repeat("Long标题🙂", 16)), string.Concat(Enumerable.Repeat("Body摘要界", 256)), string.Concat(Enumerable.Repeat("Cat分类", 8)))
        ];

    private static CorePageResult<ArticleListCoreModel> BuildArticlePage(
        int itemCount,
        int tagsPerItem,
        TextProfile profile)
    {
        ArticleListCoreModel[] items = Enumerable.Range(1, itemCount)
            .Select(index =>
            {
                DateTime created = DateTime.UnixEpoch.AddMinutes(index);
                string title = $"{profile.Title}-{index}";
                string summary = $"{profile.Summary}-{index}";
                string category = $"{profile.Category}-{index % 7}";
                TagCoreModel[] tags = Enumerable.Range(1, tagsPerItem)
                    .Select(tag => new TagCoreModel(tag, $"{profile.Category}-tag-{tag}-{index}"))
                    .ToArray();
                ArticleListItemPod pod = PodProjector.ProjectArticleList(
                    index,
                    index * 11,
                    created,
                    index % 7 + 1,
                    category,
                    title,
                    summary,
                    false,
                    out _);
                return new ArticleListCoreModel(
                    pod,
                    index,
                    title,
                    summary,
                    null,
                    null,
                    index * 11,
                    created,
                    new ArticleCategoryCoreModel(index % 7 + 1, category),
                    tags,
                    index % 3 == 0 ? null : false,
                    Status: index % 4,
                    ScheduledPublishAt: index % 5 == 0 ? created.AddHours(1) : null,
                    PublishedAt: index % 2 == 0 ? created.AddHours(2) : null);
            })
            .ToArray();
        return new CorePageResult<ArticleListCoreModel>(
            items,
            itemCount + 10,
            NextCursor: itemCount == 0 ? null : $"{PodTimeCodec.ToUnixMs(items[^1].CreateTime)}:{items[^1].Id}",
            HasMore: itemCount > 0);
    }

    private static ArticleDetailCoreModel BuildArticleDetail(string title, string content, int tagCount)
    {
        DateTime created = DateTime.UnixEpoch.AddDays(7);
        ArticleDetailPod pod = PodProjector.ProjectArticleDetail(
            42,
            99,
            created,
            7,
            "性能分类",
            title,
            content,
            "摘要 summary",
            out _);
        var rights = new ArticleRightsCoreModel(
            SnapshotId: 901,
            ArticleRevisionId: 801,
            RevisionNo: 7,
            Enabled: true,
            LicenseType: "CC-BY-4.0",
            CopyrightHolder: "Fésus",
            CopyrightYear: 2026,
            RightsStatement: "Line one\n第二行",
            AttributionTemplate: "{title} — {holder}",
            CopyPolicy: "append-attribution",
            MaxExcerptChars: 300,
            AllowCodeCopy: true,
            ShowPublicBadge: false,
            ProofBindingEnabled: true,
            CanonicalUrl: "https://example.test/article/42",
            PolicyHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ContentCanonicalHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            ProofUrl: "https://example.test/proofs/rights/901",
            ProofStatus: "ready");
        return new ArticleDetailCoreModel(
            pod,
            42,
            title,
            content,
            "摘要 summary",
            "/covers/42.webp",
            99,
            content.Length,
            Math.Max(1, content.Length / 300),
            true,
            created,
            new ArticleCategoryCoreModel(7, "性能分类"),
            Enumerable.Range(1, tagCount).Select(index => new TagCoreModel(index, $"标签-{index}")).ToArray(),
            7,
            false,
            Status: 2,
            ScheduledPublishAt: null,
            PublishedAt: created.AddHours(1),
            UpdatedAt: created.AddHours(2),
            Rights: rights);
    }

    private static string RandomText(Random random, int scalarCount)
    {
        string[] tokens = ["a", "Z", "9", "字", "界", "🙂", "-", "_"];
        var builder = new StringBuilder(scalarCount * 2);
        for (int i = 0; i < scalarCount; i++)
        {
            builder.Append(tokens[random.Next(tokens.Length)]);
        }

        return builder.ToString();
    }

    private readonly record struct TextProfile(string Name, string Title, string Summary, string Category);

    private sealed class TrackingArrayPool<T> : ArrayPool<T>
    {
        public int RentCount
        {
            get; private set;
        }
        public int ReturnCount
        {
            get; private set;
        }
        public bool LastClearArray
        {
            get; private set;
        }

        public override T[] Rent(int minimumLength)
        {
            RentCount++;
            return new T[Math.Max(1, minimumLength)];
        }

        public override void Return(T[] array, bool clearArray = false)
        {
            ReturnCount++;
            LastClearArray = clearArray;
            if (clearArray)
            {
                array.AsSpan().Clear();
            }
        }
    }

    private sealed class ThrowingArrayPool<T> : ArrayPool<T>
    {
        public int RentCount
        {
            get; private set;
        }
        public int ReturnCount
        {
            get; private set;
        }

        public override T[] Rent(int minimumLength)
        {
            RentCount++;
            throw new InvalidOperationException("synthetic pool rent failure");
        }

        public override void Return(T[] array, bool clearArray = false)
        {
            ReturnCount++;
        }
    }

    private sealed class ThrowingBufferWriter : IBufferWriter<byte>
    {
        public void Advance(int count) => throw new InvalidOperationException("synthetic destination failure");
        public Memory<byte> GetMemory(int sizeHint = 0) => throw new InvalidOperationException("synthetic destination failure");
        public Span<byte> GetSpan(int sizeHint = 0) => throw new InvalidOperationException("synthetic destination failure");
    }

    private static class LegacyReference
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

        public static byte[] EncodeArticlePage(CorePageResult<ArticleListCoreModel> page)
        {
            var destination = new ArrayBufferWriter<byte>();
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
                    PodUtf8Codec.AppendSlice(item.Summary, blob),
                    tagStart,
                    item.Tags.Count));
            }

            var writer = new ReferenceWriter(destination);
            writer.WriteInt32(ArticlePageCursorEnvelopeMagic);
            writer.WriteInt32(ArticlePageCursorEnvelopeVersion);
            writer.WriteInt64(ParseCursor(page.NextCursor));
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
                writer.WriteSlice(record.CategoryName);
                writer.WriteSlice(record.Title);
                writer.WriteSlice(record.Summary);
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

            foreach ((int id, Utf8SliceRef name) in tagRecords)
            {
                writer.WriteInt32(id);
                writer.WriteSlice(name);
            }

            return destination.WrittenSpan.ToArray();
        }

        public static byte[] EncodeArticleDetail(ArticleDetailCoreModel item)
        {
            var destination = new ArrayBufferWriter<byte>();
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
            return destination.WrittenSpan.ToArray();
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
            if (rights.Enabled)
                flags |= RightsFlagEnabled;
            if (rights.AllowCodeCopy)
                flags |= RightsFlagAllowCodeCopy;
            if (rights.ShowPublicBadge)
                flags |= RightsFlagShowPublicBadge;
            if (rights.ProofBindingEnabled)
                flags |= RightsFlagProofBindingEnabled;
            if (rights.CopyrightYear.HasValue)
                flags |= RightsFlagHasCopyrightYear;
            if (!string.IsNullOrEmpty(rights.CopyrightHolder))
                flags |= RightsFlagHasCopyrightHolder;
            if (!string.IsNullOrEmpty(rights.RightsStatement))
                flags |= RightsFlagHasRightsStatement;
            if (!string.IsNullOrEmpty(rights.AttributionTemplate))
                flags |= RightsFlagHasAttributionTemplate;
            if (!string.IsNullOrEmpty(rights.CanonicalUrl))
                flags |= RightsFlagHasCanonicalUrl;
            if (!string.IsNullOrEmpty(rights.ProofUrl))
                flags |= RightsFlagHasProofUrl;
            if (!string.IsNullOrEmpty(rights.ProofStatus))
                flags |= RightsFlagHasProofStatus;
            return flags;
        }

        private static TTo Cast<TFrom, TTo>(TFrom value)
            where TFrom : unmanaged
            where TTo : unmanaged
        {
            Assert.Equal(Unsafe.SizeOf<TFrom>(), Unsafe.SizeOf<TTo>());
            Span<TFrom> source = stackalloc TFrom[1];
            source[0] = value;
            return MemoryMarshal.Read<TTo>(MemoryMarshal.AsBytes(source));
        }

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

            public void WriteBytes(ReadOnlySpan<byte> value)
            {
                WriteInt32(value.Length);
                destination.Write(value);
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
}
