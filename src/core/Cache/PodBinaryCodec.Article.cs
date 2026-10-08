using System.Buffers;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;

using FsusBlog.Contracts.Articles;
using FsusBlog.Core.Mapping.Codecs;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Mapping.Projectors;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Outputs;
using FsusBlog.Shared.Contracts.Primitives;
using FsusBlog.Shared.Contracts.Validation;

namespace FsusBlog.Core.Cache;

/// <summary>
/// Provides binary serialization and decoding operations for article contracts.
/// </summary>
public static partial class PodBinaryCodec
{
    /// <summary>
    /// Writes an article mutation result with the rights snapshot coordinates bound by the write.
    /// </summary>
    public static void WriteArticleMutationResult(
        ArticleMutationResult response,
        IBufferWriter<byte> destination)
    {
        var writer = new BinaryPodWriter(destination);
        writer.WritePod(Cast<MutableArticleMutationResultPod, ArticleMutationResultPod>(new MutableArticleMutationResultPod
        {
            ArticleId = response.ArticleId,
            RevisionId = response.RevisionId,
            RevisionNo = response.RevisionNo,
            ReleaseId = response.ReleaseId,
            ReleaseNo = response.ReleaseNo,
            Status = response.Status,
            RightsSnapshotId = response.RightsSnapshotId,
            RightsRevisionNo = response.RightsRevisionNo,
            IdempotencyReplay = response.IdempotencyReplay ? (byte)1 : (byte)0,
            ErrorCode = response.ErrorCode,
            Outcome = (byte)response.Outcome,
            Reserved = 0
        }));
    }

    /// <summary>
    /// Attempts to decode an article mutation result and its bound rights snapshot coordinates.
    /// </summary>
    public static bool TryDecodeArticleMutationResult(
        ReadOnlyMemory<byte> source,
        out ArticleMutationResult response)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out ArticleMutationResultPod pod) || !reader.IsConsumed)
        {
            response = default;
            return false;
        }

        var outcome = (ArticleMutationOutcome)pod.Outcome;
        if (!Enum.IsDefined(outcome) || pod.Reserved != 0)
        {
            response = default;
            return false;
        }

        response = new ArticleMutationResult(
            pod.ArticleId,
            pod.RevisionId,
            pod.RevisionNo,
            pod.ReleaseId,
            pod.ReleaseNo,
            pod.Status,
            pod.RightsSnapshotId,
            pod.RightsRevisionNo,
            pod.IdempotencyReplay != 0,
            pod.ErrorCode,
            outcome);
        return true;
    }

    internal const int ArticlePageStackScratchByteBudget = 4 * 1024;
    internal const int ArticleDetailDirectCharThreshold = 8 * 1024;
    // COMPATIBILITY: The wire prefix is ASCII FSPA in little-endian storage order.
    private const int ArticlePageCursorEnvelopeMagic = AedsArticleListWire.CursorMagic;
    private const int ArticlePageCursorEnvelopeVersion = AedsArticleListWire.CursorVersion;
    // COMPATIBILITY: Existing payloads retain the ARD3 and ARD4 wire identifiers.
    private const uint ArticleDetailV3PayloadMagic = 0x41524433;
    private const int ArticleDetailV3PayloadVersion = 3;
    private const uint ArticleDetailV4PayloadMagic = 0x41524434;
    private const int ArticleDetailV4PayloadVersion = 4;
    private const uint ArticleDetailV5PayloadMagic = 0x41524435;
    private const int ArticleDetailV5PayloadVersion = 5;
    private const int LegacyArticleWriteRequestVersion = 3;
    private const int LegacyArticleWriteRequestVersion4 = 4;
    private const int ArticleWriteRequestVersion = 5;
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

    /// <summary>
    /// Writes the <c>ArticleWriteRequest</c> contract to the supplied binary destination.
    /// </summary>
    public static void WriteArticleWriteRequest(ArticleWriteRequestCoreModel request, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(Math.Max(512, request.Title.Length + request.Content.Length + (request.Summary?.Length ?? 0) + (request.CoverImageUrl?.Length ?? 0)));
        ArticleRightsMutationMode rightsMutation = ResolveArticleRightsMutation(request);
        ArticleRightsRequestCoreModel rights = ArticleProductionNormalizers.NormalizeWireArticleRights(request.Rights);
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
        writer.WriteInt32((int)rightsMutation);
        writer.WriteInt32(BuildRightsFlags(rights));
        writer.WriteInt32(rights.CopyrightYear.GetValueOrDefault());
        writer.WriteInt32(rights.MaxExcerptChars);
        writer.WritePod(Cast<MutableArticleRightsWriteRequestPod, ArticleRightsWriteRequestPod>(mutableRights));
        writer.WriteBytes(rightsPayload.WrittenSpan);
        writer.WriteInt64(request.BaseRevisionId.GetValueOrDefault());
    }

    /// <summary>
    /// Encodes the <c>ArticleWriteRequest</c> contract into a new binary payload.
    /// </summary>
    public static byte[] EncodeArticleWriteRequest(ArticleWriteRequestCoreModel request)
        => EncodeToArray(512 + request.Content.Length + request.TagIds.Count * sizeof(int), writer => WriteArticleWriteRequest(request, writer));

    /// <summary>
    /// Attempts to decode the <c>ArticleWriteRequest</c> contract from a binary payload.
    /// </summary>
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
        if (reader.Remaining == 0)
        {
            request = BuildArticleWriteRequest(
                pod,
                tagIds,
                payloadSpan,
                status,
                scheduledPublishAt,
                rights: null,
                ArticleRightsMutationMode.Preserve);
            return true;
        }

        if (!reader.TryReadInt32(out status) ||
            !reader.TryReadInt64(out long scheduledPublishAtUnixMs))
        {
            request = default;
            return false;
        }

        scheduledPublishAt = FromUnixMsOrNull(scheduledPublishAtUnixMs);
        if (reader.IsConsumed)
        {
            request = BuildArticleWriteRequest(
                pod,
                tagIds,
                payloadSpan,
                status,
                scheduledPublishAt,
                rights: null,
                ArticleRightsMutationMode.Preserve);
            return true;
        }

        if (!reader.TryReadInt32(out int version) ||
            version is not (LegacyArticleWriteRequestVersion or LegacyArticleWriteRequestVersion4 or ArticleWriteRequestVersion))
        {
            request = default;
            return false;
        }

        ArticleRightsMutationMode rightsMutation = ArticleRightsMutationMode.Replace;
        int rawRightsMutation = (int)rightsMutation;
        if (version is LegacyArticleWriteRequestVersion4 or ArticleWriteRequestVersion &&
            (!reader.TryReadInt32(out rawRightsMutation) ||
             !Enum.IsDefined(typeof(ArticleRightsMutationMode), rawRightsMutation)))
        {
            request = default;
            return false;
        }
        else if (version is LegacyArticleWriteRequestVersion4 or ArticleWriteRequestVersion)
        {
            rightsMutation = (ArticleRightsMutationMode)rawRightsMutation;
        }

        if (!reader.TryReadInt32(out int rightsFlags) ||
            !reader.TryReadInt32(out int copyrightYearValue) ||
            !reader.TryReadInt32(out int maxExcerptChars) ||
            !reader.TryReadPod(out ArticleRightsWriteRequestPod rightsPod) ||
            !reader.TryReadBytes(out ReadOnlySpan<byte> rightsPayloadSpan) ||
            maxExcerptChars < 0)
        {
            request = default;
            return false;
        }

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

        long? baseRevisionId = null;
        if (version == ArticleWriteRequestVersion)
        {
            if (!reader.TryReadInt64(out long rawBaseRevisionId) || rawBaseRevisionId < 0)
            {
                request = default;
                return false;
            }

            baseRevisionId = rawBaseRevisionId == 0 ? null : rawBaseRevisionId;
        }

        request = BuildArticleWriteRequest(
            pod,
            tagIds,
            payloadSpan,
            status,
            scheduledPublishAt,
            rightsMutation == ArticleRightsMutationMode.Replace ? rights : null,
            rightsMutation,
            baseRevisionId);
        return reader.IsConsumed;
    }

    private static ArticleWriteRequestCoreModel BuildArticleWriteRequest(
        in ArticleWriteRequestPod pod,
        IReadOnlyList<int> tagIds,
        ReadOnlySpan<byte> payloadSpan,
        int status,
        DateTime? scheduledPublishAt,
        ArticleRightsRequestCoreModel? rights,
        ArticleRightsMutationMode rightsMutation,
        long? baseRevisionId = null)
        => new(
            PodProjector.ReadSlice(pod.Title, payloadSpan),
            PodProjector.ReadSlice(pod.Content, payloadSpan),
            PodProjector.ReadSlice(pod.Summary, payloadSpan),
            PodProjector.ReadSlice(pod.CoverImageUrl, payloadSpan),
            pod.CategoryId,
            tagIds,
            status,
            scheduledPublishAt,
            rights,
            rightsMutation,
            baseRevisionId);

    private static ArticleRightsMutationMode ResolveArticleRightsMutation(ArticleWriteRequestCoreModel request)
        => request.RightsMutation == ArticleRightsMutationMode.Preserve && request.Rights.HasValue
            ? ArticleRightsMutationMode.Replace
            : request.RightsMutation;

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

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableArticleMutationResultPod
    {
        public int ArticleId;
        public long RevisionId;
        public int RevisionNo;
        public long ReleaseId;
        public int ReleaseNo;
        public int Status;
        public long RightsSnapshotId;
        public int RightsRevisionNo;
        public byte IdempotencyReplay;
        public byte ErrorCode;
        public byte Outcome;
        public byte Reserved;
    }

    private static Utf8SliceRef PlanUtf8Slice(string? value, ref int nextOffset)
    {
        int length = PodUtf8Codec.GetSliceByteCount(value);
        Utf8SliceRef slice = PodUtf8Codec.CreateSliceRef(nextOffset, length);
        nextOffset = checked(nextOffset + length);
        return slice;
    }

    private static void WritePlannedUtf8Slice(
        string? value,
        in Utf8SliceRef slice,
        IBufferWriter<byte> destination,
        ref int writtenBytes)
    {
        if (slice.Offset != writtenBytes)
        {
            throw new InvalidOperationException("UTF-8 blob plan is not contiguous.");
        }

        PodUtf8Codec.WriteSliceBytes(value, destination, slice.Length);
        writtenBytes = checked(writtenBytes + slice.Length);
    }

    /// <summary>
    /// Writes the <c>ArticlePage</c> contract to the supplied binary destination.
    /// </summary>
    public static void WriteArticlePage(CorePageResult<ArticleListCoreModel> page, IBufferWriter<byte> destination)
        => WriteArticlePageWithScratchPolicy(
            page,
            destination,
            ArticlePageStackScratchByteBudget,
            ArrayPool<ArticlePageItemSlicePlan>.Shared,
            ArrayPool<Utf8SliceRef>.Shared);

    internal static void WriteArticlePageWithScratchPolicy(
        CorePageResult<ArticleListCoreModel> page,
        IBufferWriter<byte> destination,
        int stackScratchByteBudget,
        ArrayPool<ArticlePageItemSlicePlan> itemPlanPool,
        ArrayPool<Utf8SliceRef> tagSlicePool)
    {
        ArgumentNullException.ThrowIfNull(destination);
        ArgumentNullException.ThrowIfNull(itemPlanPool);
        ArgumentNullException.ThrowIfNull(tagSlicePool);
        if (stackScratchByteBudget < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(stackScratchByteBudget));
        }

        int itemCount = page.Items.Count;
        int tagRecordCount = 0;
        int blobLength = 0;
        for (int itemIndex = 0; itemIndex < itemCount; itemIndex++)
        {
            ArticleListCoreModel item = page.Items[itemIndex];
            if (!ValidArticleVersionCoordinates(item.CurrentRevisionId, item.RevisionNo,
                item.CurrentPublicationId.GetValueOrDefault(), item.PublicationNo.GetValueOrDefault()))
            {
                throw new InvalidOperationException("Article page current version coordinates are invalid.");
            }
            tagRecordCount = checked(tagRecordCount + item.Tags.Count);
            foreach (TagCoreModel tag in item.Tags)
            {
                blobLength = checked(blobLength + PodUtf8Codec.GetSliceByteCount(tag.Name));
            }

            blobLength = checked(blobLength + PodUtf8Codec.GetSliceByteCount(item.Category.Name));
            blobLength = checked(blobLength + PodUtf8Codec.GetSliceByteCount(item.Title));
            blobLength = checked(blobLength + PodUtf8Codec.GetSliceByteCount(item.Summary));
        }

        int itemScratchBytes = checked(itemCount * Unsafe.SizeOf<ArticlePageItemSlicePlan>());
        int tagScratchBytes = checked(tagRecordCount * Unsafe.SizeOf<Utf8SliceRef>());
        bool useStackScratch = checked(itemScratchBytes + tagScratchBytes) <= stackScratchByteBudget;
        ArticlePageItemSlicePlan[]? rentedItemPlans = null;
        Utf8SliceRef[]? rentedTagSlices = null;
        // OWNERSHIP: Both optional rents are returned by the same finally, including second-rent failure.
        try
        {
            Span<ArticlePageItemSlicePlan> itemPlans = useStackScratch
                ? stackalloc ArticlePageItemSlicePlan[itemCount]
                : (rentedItemPlans = itemPlanPool.Rent(itemCount)).AsSpan(0, itemCount);
            Span<Utf8SliceRef> tagSlices = useStackScratch
                ? stackalloc Utf8SliceRef[tagRecordCount]
                : (rentedTagSlices = tagSlicePool.Rent(tagRecordCount)).AsSpan(0, tagRecordCount);

            string cursor = page.HasMore ? page.NextCursor ?? string.Empty : string.Empty;
            int cursorByteCount = Encoding.UTF8.GetByteCount(cursor);
            if ((page.HasMore && cursorByteCount == 0) || cursorByteCount > 512)
            {
                throw new InvalidOperationException("Article page cursor metadata is invalid.");
            }

            Span<byte> cursorBytes = stackalloc byte[cursorByteCount];
            Encoding.UTF8.GetBytes(cursor, cursorBytes);
            if (!TryDecodeArticleListCursorUtf8(cursorBytes, out _))
            {
                throw new InvalidOperationException("Article page cursor metadata is invalid.");
            }
            var writer = new BinaryPodWriter(destination);
            writer.WriteInt32(ArticlePageCursorEnvelopeMagic);
            writer.WriteInt32(ArticlePageCursorEnvelopeVersion);
            writer.WriteByte(page.HasMore ? (byte)1 : (byte)0);
            writer.WriteInt32(page.Total);
            writer.WriteBytes(cursorBytes);
            writer.WriteInt32(itemCount);
            writer.WriteInt32(tagRecordCount);
            writer.WriteInt32(blobLength);

            int blobOffset = 0;
            int tagIndex = 0;
            for (int itemIndex = 0; itemIndex < itemCount; itemIndex++)
            {
                ArticleListCoreModel item = page.Items[itemIndex];
                int tagStart = tagIndex;
                foreach (TagCoreModel tag in item.Tags)
                {
                    int length = PodUtf8Codec.GetSliceByteCount(tag.Name);
                    tagSlices[tagIndex++] = PodUtf8Codec.CreateSliceRef(blobOffset, length);
                    PodUtf8Codec.WriteSliceBytes(tag.Name, destination, length);
                    blobOffset = checked(blobOffset + length);
                }

                int categoryLength = PodUtf8Codec.GetSliceByteCount(item.Category.Name);
                Utf8SliceRef categoryName = PodUtf8Codec.CreateSliceRef(blobOffset, categoryLength);
                PodUtf8Codec.WriteSliceBytes(item.Category.Name, destination, categoryLength);
                blobOffset = checked(blobOffset + categoryLength);

                int titleLength = PodUtf8Codec.GetSliceByteCount(item.Title);
                Utf8SliceRef title = PodUtf8Codec.CreateSliceRef(blobOffset, titleLength);
                PodUtf8Codec.WriteSliceBytes(item.Title, destination, titleLength);
                blobOffset = checked(blobOffset + titleLength);

                int summaryLength = PodUtf8Codec.GetSliceByteCount(item.Summary);
                Utf8SliceRef summary = PodUtf8Codec.CreateSliceRef(blobOffset, summaryLength);
                PodUtf8Codec.WriteSliceBytes(item.Summary, destination, summaryLength);
                blobOffset = checked(blobOffset + summaryLength);

                itemPlans[itemIndex] = new ArticlePageItemSlicePlan(
                    categoryName,
                    title,
                    summary,
                    tagStart,
                    item.Tags.Count);
            }

            if (blobOffset != blobLength || tagIndex != tagRecordCount)
            {
                throw new InvalidOperationException("Article page codec input changed while its UTF-8 blob was being written.");
            }

            for (int itemIndex = 0; itemIndex < itemCount; itemIndex++)
            {
                ArticleListCoreModel item = page.Items[itemIndex];
                ArticlePageItemSlicePlan plan = itemPlans[itemIndex];
                writer.WriteInt32(item.Id);
                writer.WriteInt32(item.Views);
                writer.WriteInt64(PodTimeCodec.ToUnixMs(item.CreateTime));
                writer.WriteInt32(item.Category.Id);
                writer.WriteSliceRef(plan.CategoryName);
                writer.WriteSliceRef(plan.Title);
                writer.WriteSliceRef(plan.Summary);
                writer.WriteInt32(plan.TagStart);
                writer.WriteInt32(plan.TagCount);
                writer.WriteByte(item.IsDeleted == true ? (byte)1 : (byte)0);
                writer.WriteByte(item.IsDeleted.HasValue ? (byte)1 : (byte)0);
                writer.WriteByte(0);
                writer.WriteByte(0);
                writer.WriteInt32(item.Status);
                writer.WriteInt64(ToUnixMsOrZero(item.ScheduledPublishAt));
                writer.WriteInt64(ToUnixMsOrZero(item.PublishedAt));
                writer.WriteInt64(item.CurrentRevisionId);
                writer.WriteInt32(item.RevisionNo);
                writer.WriteInt64(item.CurrentPublicationId.GetValueOrDefault());
                writer.WriteInt32(item.PublicationNo.GetValueOrDefault());
            }

            tagIndex = 0;
            for (int itemIndex = 0; itemIndex < itemCount; itemIndex++)
            {
                foreach (TagCoreModel tag in page.Items[itemIndex].Tags)
                {
                    writer.WriteInt32(tag.Id);
                    writer.WriteSliceRef(tagSlices[tagIndex++]);
                }
            }

            if (tagIndex != tagRecordCount)
            {
                throw new InvalidOperationException("Article page tag collection changed while records were being written.");
            }
        }
        finally
        {
            if (rentedItemPlans is not null)
            {
                itemPlanPool.Return(rentedItemPlans, clearArray: false);
            }

            if (rentedTagSlices is not null)
            {
                tagSlicePool.Return(rentedTagSlices, clearArray: false);
            }
        }
    }

    /// <summary>
    /// Encodes the <c>ArticlePage</c> contract into a new binary payload.
    /// </summary>
    public static byte[] EncodeArticlePage(CorePageResult<ArticleListCoreModel> page)
        => EncodeToArray(1024, writer => WriteArticlePage(page, writer));

    /// <summary>
    /// Attempts to decode the <c>ArticlePage</c> contract from a binary payload.
    /// </summary>
    public static bool TryDecodeArticlePage(ReadOnlyMemory<byte> bytes, out CorePageResult<ArticleListCoreModel> page)
    {
        var reader = new BinaryPodReader(bytes.Span);
        string? nextCursor = null;
        bool hasMore = false;
        if (!reader.TryReadInt32(out int total))
        {
            page = default;
            return false;
        }

        if (total != ArticlePageCursorEnvelopeMagic
            || !reader.TryReadInt32(out int version)
            || version != ArticlePageCursorEnvelopeVersion)
        {
            page = default;
            return false;
        }

        if (!reader.TryReadByte(out byte hasMoreByte)
            || hasMoreByte > 1
            || !reader.TryReadInt32(out total)
            || !reader.TryReadBytes(out ReadOnlySpan<byte> cursorBytes)
            || cursorBytes.Length > 512)
        {
            page = default;
            return false;
        }

        hasMore = hasMoreByte == 1;
        if (!TryDecodeArticleListCursorUtf8(cursorBytes, out nextCursor)
            || hasMore != !string.IsNullOrWhiteSpace(nextCursor))
        {
            page = default;
            return false;
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

        if (total < 0 || (long)reader.Remaining != (long)count * AedsArticleListWire.RecordBytes
            + (long)tagRecordCount * AedsArticleListWire.TagRecordBytes)
        {
            page = default;
            return false;
        }

        var pending = new List<(int Id, int Views, long CreateTimeUnixMs, int CategoryId, Utf8SliceRef CategoryName, Utf8SliceRef Title, Utf8SliceRef Summary, int TagStart, int TagCount, bool? IsDeleted, int Status, DateTime? ScheduledPublishAt, DateTime? PublishedAt, long CurrentRevisionId, int RevisionNo, long? CurrentPublicationId, int? PublicationNo)>(count);
        for (int i = 0; i < count; i++)
        {
            if (!TryReadArticleListRecordHeader(ref reader, tagRecordCount, blob, out ArticleListRecordHeader header))
            {
                page = default;
                return false;
            }

            if (!reader.TryReadInt32(out int status) ||
                !reader.TryReadInt64(out long scheduledPublishAtUnixMs) ||
                !reader.TryReadInt64(out long publishedAtUnixMs) ||
                !reader.TryReadInt64(out long currentRevisionId) ||
                !reader.TryReadInt32(out int revisionNo) ||
                !reader.TryReadInt64(out long publicationId) ||
                !reader.TryReadInt32(out int decodedPublicationNo) ||
                !ValidArticleVersionCoordinates(currentRevisionId, revisionNo, publicationId, decodedPublicationNo))
            {
                page = default;
                return false;
            }
            DateTime? scheduledPublishAt = FromUnixMsOrNull(scheduledPublishAtUnixMs);
            DateTime? publishedAt = FromUnixMsOrNull(publishedAtUnixMs);
            long? currentPublicationId = publicationId == 0 ? null : publicationId;
            int? publicationNo = decodedPublicationNo == 0 ? null : decodedPublicationNo;

            pending.Add((header.Id, header.Views, header.CreateTimeUnixMs, header.CategoryId, header.CategoryName, header.Title, header.Summary, header.TagStart, header.TagCount, header.IsDeleted, status, scheduledPublishAt, publishedAt, currentRevisionId, revisionNo, currentPublicationId, publicationNo));
        }

        if (!TryReadArticleListTags(ref reader, tagRecordCount, blob, out List<TagCoreModel> tagRecords))
        {
            page = default;
            return false;
        }

        var items = new List<ArticleListCoreModel>(count);
        try
        {
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
                    record.PublishedAt,
                    record.CurrentRevisionId,
                    record.RevisionNo,
                    record.CurrentPublicationId,
                    record.PublicationNo));
            }
        }
        catch (DecoderFallbackException)
        {
            page = default;
            return false;
        }

        page = new CorePageResult<ArticleListCoreModel>(items, total, nextCursor, hasMore);
        return reader.IsConsumed;
    }

    private static bool ValidArticleVersionCoordinates(long revisionId, int revisionNo, long publicationId, int publicationNo)
        => revisionId > 0 && revisionNo > 0 && publicationId >= 0 && publicationNo >= 0
            && (publicationId == 0) == (publicationNo == 0);

    private static bool TryDecodeArticleListCursorUtf8(ReadOnlySpan<byte> cursorBytes, out string? cursor)
    {
        cursor = null;
        if (cursorBytes.IsEmpty)
        {
            return true;
        }

        try
        {
            cursor = s_strictUtf8.GetString(cursorBytes);
            return cursor.All(static character => char.IsAsciiLetterOrDigit(character) || character is '-' or '_');
        }
        catch (DecoderFallbackException)
        {
            return false;
        }
    }

    /// <summary>
    /// Writes the <c>ArticleDetail</c> contract to the supplied binary destination.
    /// </summary>
    public static void WriteArticleDetail(ArticleDetailCoreModel item, IBufferWriter<byte> destination)
    {
        ArgumentNullException.ThrowIfNull(destination);
        // PERF-INVARIANT: The measured tiny-content path stays list-based below this adaptive boundary.
        if (item.Content.Length < ArticleDetailDirectCharThreshold)
        {
            WriteArticleDetailWithLists(item, destination);
            return;
        }

        int plannedBlobLength = 0;
        ArticleRightsCoreModel rights = item.Rights;
        var article = new MutableArticleDetailV5RecordPod
        {
            Id = item.Id,
            Views = item.Views,
            CreateTimeUnixMs = PodTimeCodec.ToUnixMs(item.CreateTime),
            CategoryId = item.Category.Id,
            Status = item.Status,
            ScheduledPublishAtUnixMs = ToUnixMsOrZero(item.ScheduledPublishAt),
            PublishedAtUnixMs = ToUnixMsOrZero(item.PublishedAt),
            UpdatedAtUnixMs = ToUnixMsOrZero(item.UpdatedAt),
            CurrentRevisionId = item.CurrentRevisionId,
            RevisionNo = item.RevisionNo,
            CurrentPublicationId = item.CurrentPublicationId.GetValueOrDefault(),
            PublicationNo = item.PublicationNo.GetValueOrDefault(),
            IsDeleted = item.IsDeleted ? (byte)1 : (byte)0,
            Title = PlanUtf8Slice(item.Title, ref plannedBlobLength),
            Content = PlanUtf8Slice(item.Content, ref plannedBlobLength),
            Summary = PlanUtf8Slice(item.Summary, ref plannedBlobLength),
            CoverImageUrl = PlanUtf8Slice(item.CoverImageUrl, ref plannedBlobLength),
            CategoryName = PlanUtf8Slice(item.Category.Name, ref plannedBlobLength)
        };

        int tagBlobOffset = plannedBlobLength;
        foreach (TagCoreModel tag in item.Tags)
        {
            plannedBlobLength = checked(plannedBlobLength + PodUtf8Codec.GetSliceByteCount(tag.Name));
        }

        int rightsBlobOffset = plannedBlobLength;
        var rightsRecord = new MutableArticleRightsV3RecordPod
        {
            SnapshotId = rights.SnapshotId,
            ArticleRevisionId = rights.ArticleRevisionId,
            RevisionNo = rights.RevisionNo,
            Flags = BuildArticleDetailRightsFlags(rights),
            CopyrightYear = rights.CopyrightYear.GetValueOrDefault(),
            MaxExcerptChars = rights.MaxExcerptChars,
            LicenseType = PlanUtf8Slice(rights.LicenseType, ref plannedBlobLength),
            CopyrightHolder = PlanUtf8Slice(rights.CopyrightHolder, ref plannedBlobLength),
            RightsStatement = PlanUtf8Slice(rights.RightsStatement, ref plannedBlobLength),
            AttributionTemplate = PlanUtf8Slice(rights.AttributionTemplate, ref plannedBlobLength),
            CopyPolicy = PlanUtf8Slice(rights.CopyPolicy, ref plannedBlobLength),
            CanonicalUrl = PlanUtf8Slice(rights.CanonicalUrl, ref plannedBlobLength),
            PolicyHash = PlanUtf8Slice(rights.PolicyHash, ref plannedBlobLength),
            ContentCanonicalHash = PlanUtf8Slice(rights.ContentCanonicalHash, ref plannedBlobLength),
            ProofUrl = PlanUtf8Slice(rights.ProofUrl, ref plannedBlobLength),
            ProofStatus = PlanUtf8Slice(rights.ProofStatus, ref plannedBlobLength)
        };

        int headerSize = Unsafe.SizeOf<ArticleDetailV4HeaderPod>();
        int articleRecordSize = Unsafe.SizeOf<ArticleDetailV5RecordPod>();
        int tagRecordSize = Unsafe.SizeOf<ArticleDetailTagV3RecordPod>();
        int rightsRecordSize = Unsafe.SizeOf<ArticleRightsV3RecordPod>();
        int articleOffset = headerSize;
        int tagOffset = articleOffset + articleRecordSize;
        int rightsOffset = tagOffset + item.Tags.Count * tagRecordSize;
        int blobOffset = rightsOffset + rightsRecordSize;
        var header = new MutableArticleDetailV4HeaderPod
        {
            Magic = ArticleDetailV5PayloadMagic,
            Version = ArticleDetailV5PayloadVersion,
            Flags = 0,
            ArticleRecordOffset = articleOffset,
            ArticleRecordLength = articleRecordSize,
            TagOffset = tagOffset,
            TagCount = item.Tags.Count,
            RightsRecordOffset = rightsOffset,
            RightsRecordLength = rightsRecordSize,
            BlobOffset = blobOffset,
            BlobLength = plannedBlobLength
        };

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(Cast<MutableArticleDetailV4HeaderPod, ArticleDetailV4HeaderPod>(header));
        writer.WritePod(Cast<MutableArticleDetailV5RecordPod, ArticleDetailV5RecordPod>(article));
        int nextTagOffset = tagBlobOffset;
        foreach (TagCoreModel tag in item.Tags)
        {
            int length = PodUtf8Codec.GetSliceByteCount(tag.Name);
            var mutableTag = new MutableArticleDetailTagV3RecordPod
            {
                Id = tag.Id,
                Name = PodUtf8Codec.CreateSliceRef(nextTagOffset, length)
            };
            writer.WritePod(Cast<MutableArticleDetailTagV3RecordPod, ArticleDetailTagV3RecordPod>(mutableTag));
            nextTagOffset = checked(nextTagOffset + length);
        }

        if (nextTagOffset != rightsBlobOffset)
        {
            throw new InvalidOperationException("Article detail tag collection changed while records were being written.");
        }

        writer.WritePod(Cast<MutableArticleRightsV3RecordPod, ArticleRightsV3RecordPod>(rightsRecord));

        int writtenBlobBytes = 0;
        WritePlannedUtf8Slice(item.Title, article.Title, destination, ref writtenBlobBytes);
        WritePlannedUtf8Slice(item.Content, article.Content, destination, ref writtenBlobBytes);
        WritePlannedUtf8Slice(item.Summary, article.Summary, destination, ref writtenBlobBytes);
        WritePlannedUtf8Slice(item.CoverImageUrl, article.CoverImageUrl, destination, ref writtenBlobBytes);
        WritePlannedUtf8Slice(item.Category.Name, article.CategoryName, destination, ref writtenBlobBytes);
        foreach (TagCoreModel tag in item.Tags)
        {
            int length = PodUtf8Codec.GetSliceByteCount(tag.Name);
            Utf8SliceRef tagSlice = PodUtf8Codec.CreateSliceRef(writtenBlobBytes, length);
            WritePlannedUtf8Slice(tag.Name, tagSlice, destination, ref writtenBlobBytes);
        }

        WritePlannedUtf8Slice(rights.LicenseType, rightsRecord.LicenseType, destination, ref writtenBlobBytes);
        WritePlannedUtf8Slice(rights.CopyrightHolder, rightsRecord.CopyrightHolder, destination, ref writtenBlobBytes);
        WritePlannedUtf8Slice(rights.RightsStatement, rightsRecord.RightsStatement, destination, ref writtenBlobBytes);
        WritePlannedUtf8Slice(rights.AttributionTemplate, rightsRecord.AttributionTemplate, destination, ref writtenBlobBytes);
        WritePlannedUtf8Slice(rights.CopyPolicy, rightsRecord.CopyPolicy, destination, ref writtenBlobBytes);
        WritePlannedUtf8Slice(rights.CanonicalUrl, rightsRecord.CanonicalUrl, destination, ref writtenBlobBytes);
        WritePlannedUtf8Slice(rights.PolicyHash, rightsRecord.PolicyHash, destination, ref writtenBlobBytes);
        WritePlannedUtf8Slice(rights.ContentCanonicalHash, rightsRecord.ContentCanonicalHash, destination, ref writtenBlobBytes);
        WritePlannedUtf8Slice(rights.ProofUrl, rightsRecord.ProofUrl, destination, ref writtenBlobBytes);
        WritePlannedUtf8Slice(rights.ProofStatus, rightsRecord.ProofStatus, destination, ref writtenBlobBytes);

        if (writtenBlobBytes != plannedBlobLength)
        {
            throw new InvalidOperationException("Article detail UTF-8 blob length changed while it was being written.");
        }
    }

    private static void WriteArticleDetailWithLists(ArticleDetailCoreModel item, IBufferWriter<byte> destination)
    {
        var blob = new List<byte>(Math.Max(
            512,
            item.Content.Length
            + item.Title.Length
            + (item.Summary?.Length ?? 0)
            + (item.CoverImageUrl?.Length ?? 0)));
        ArticleRightsCoreModel rights = item.Rights;
        var article = new MutableArticleDetailV5RecordPod
        {
            Id = item.Id,
            Views = item.Views,
            CreateTimeUnixMs = PodTimeCodec.ToUnixMs(item.CreateTime),
            CategoryId = item.Category.Id,
            Status = item.Status,
            ScheduledPublishAtUnixMs = ToUnixMsOrZero(item.ScheduledPublishAt),
            PublishedAtUnixMs = ToUnixMsOrZero(item.PublishedAt),
            UpdatedAtUnixMs = ToUnixMsOrZero(item.UpdatedAt),
            CurrentRevisionId = item.CurrentRevisionId,
            RevisionNo = item.RevisionNo,
            CurrentPublicationId = item.CurrentPublicationId.GetValueOrDefault(),
            PublicationNo = item.PublicationNo.GetValueOrDefault(),
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
        int articleRecordSize = Unsafe.SizeOf<ArticleDetailV5RecordPod>();
        int tagRecordSize = Unsafe.SizeOf<ArticleDetailTagV3RecordPod>();
        int rightsRecordSize = Unsafe.SizeOf<ArticleRightsV3RecordPod>();
        int articleOffset = headerSize;
        int tagOffset = articleOffset + articleRecordSize;
        int rightsOffset = tagOffset + tags.Count * tagRecordSize;
        int blobOffset = rightsOffset + rightsRecordSize;
        var header = new MutableArticleDetailV4HeaderPod
        {
            Magic = ArticleDetailV5PayloadMagic,
            Version = ArticleDetailV5PayloadVersion,
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
        writer.WritePod(Cast<MutableArticleDetailV5RecordPod, ArticleDetailV5RecordPod>(article));
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

    /// <summary>
    /// Encodes the <c>ArticleDetail</c> contract into a new binary payload.
    /// </summary>
    public static byte[] EncodeArticleDetail(ArticleDetailCoreModel item)
        => EncodeToArray(2048 + item.Content.Length + item.Tags.Count * 32, writer => WriteArticleDetail(item, writer));

    /// <summary>
    /// Attempts to decode the <c>ArticleDetail</c> contract from a binary payload.
    /// </summary>
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
            BuildArticleRightsCoreModel(rightsPod, blob),
            article.CurrentRevisionId,
            article.RevisionNo,
            article.CurrentPublicationId > 0 ? article.CurrentPublicationId : null,
            article.PublicationNo > 0 ? article.PublicationNo : null);
        return true;
    }

    /// <summary>
    /// Writes the <c>RelatedReading</c> contract to the supplied binary destination.
    /// </summary>
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

    /// <summary>
    /// Encodes the <c>RelatedReading</c> contract into a new binary payload.
    /// </summary>
    public static byte[] EncodeRelatedReading(RelatedReadingResponse response)
        => EncodeToArray(256 + response.Related.Count * 128, writer => WriteRelatedReading(response, writer));

    /// <summary>
    /// Attempts to decode the <c>RelatedReading</c> contract from a binary payload.
    /// </summary>
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
           (magic == ArticleDetailV4PayloadMagic && version == ArticleDetailV4PayloadVersion) ||
           (magic == ArticleDetailV5PayloadMagic && version == ArticleDetailV5PayloadVersion);

    private static int ResolveArticleDetailRecordSize(int version)
        => version switch
        {
            ArticleDetailV5PayloadVersion => Unsafe.SizeOf<ArticleDetailV5RecordPod>(),
            ArticleDetailV4PayloadVersion => Unsafe.SizeOf<ArticleDetailV4RecordPod>(),
            _ => Unsafe.SizeOf<ArticleDetailV3RecordPod>()
        };

    private static bool TryReadArticleDetailRecord(
        ReadOnlySpan<byte> source,
        ReadOnlySpan<byte> blob,
        int version,
        out DecodedArticleDetailRecord decoded)
    {
        var reader = new BinaryPodReader(source);
        if (version == ArticleDetailV5PayloadVersion)
        {
            if (!reader.TryReadPod(out ArticleDetailV5RecordPod record) ||
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
                record.CurrentRevisionId, record.RevisionNo, record.CurrentPublicationId, record.PublicationNo,
                record.IsDeleted, record.Title, record.Content, record.Summary, record.CoverImageUrl, record.CategoryName);
            return true;
        }

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
                0, 0, 0, 0,
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
            0, 0, 0, 0,
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

    private static bool ValidateArticleDetailRecordSlices(ArticleDetailV5RecordPod record, ReadOnlySpan<byte> blob)
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
        long CurrentRevisionId,
        int RevisionNo,
        long CurrentPublicationId,
        int PublicationNo,
        byte IsDeleted,
        Utf8SliceRef Title,
        Utf8SliceRef Content,
        Utf8SliceRef Summary,
        Utf8SliceRef CoverImageUrl,
        Utf8SliceRef CategoryName);

    internal readonly record struct ArticlePageItemSlicePlan(
        Utf8SliceRef CategoryName,
        Utf8SliceRef Title,
        Utf8SliceRef Summary,
        int TagStart,
        int TagCount);

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
    private struct MutableArticleDetailV5RecordPod
    {
        public int Id;
        public int Views;
        public long CreateTimeUnixMs;
        public int CategoryId;
        public int Status;
        public long ScheduledPublishAtUnixMs;
        public long PublishedAtUnixMs;
        public long UpdatedAtUnixMs;
        public long CurrentRevisionId;
        public int RevisionNo;
        public long CurrentPublicationId;
        public int PublicationNo;
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

    /// <summary>
    /// Writes the <c>ArticleSearch</c> contract to the supplied binary destination.
    /// </summary>
    public static void WriteArticleSearch(IReadOnlyList<ArticleListCoreModel> items, IBufferWriter<byte> destination)
    {
        int tagCount = 0;
        foreach (ArticleListCoreModel item in items)
        {
            if (!ValidArticleVersionCoordinates(item.CurrentRevisionId, item.RevisionNo,
                item.CurrentPublicationId.GetValueOrDefault(), item.PublicationNo.GetValueOrDefault()))
            {
                throw new InvalidOperationException("Article search current version coordinates are invalid.");
            }
            tagCount = checked(tagCount + item.Tags.Count);
        }
        ArticlePageItemSlicePlan[]? rentedPlans = null;
        Utf8SliceRef[]? rentedTags = null;
        try
        {
            bool small = (long)items.Count * Unsafe.SizeOf<ArticlePageItemSlicePlan>()
                + (long)tagCount * Unsafe.SizeOf<Utf8SliceRef>() <= ArticlePageStackScratchByteBudget;
            Span<ArticlePageItemSlicePlan> plans = small ? stackalloc ArticlePageItemSlicePlan[items.Count]
                : (rentedPlans = ArrayPool<ArticlePageItemSlicePlan>.Shared.Rent(items.Count)).AsSpan(0, items.Count);
            Span<Utf8SliceRef> tags = small ? stackalloc Utf8SliceRef[tagCount]
                : (rentedTags = ArrayPool<Utf8SliceRef>.Shared.Rent(tagCount)).AsSpan(0, tagCount);
            int blobLength = 0;
            int tagIndex = 0;
            for (int index = 0; index < items.Count; index++)
            {
                ArticleListCoreModel item = items[index];
                Utf8SliceRef category = PlanUtf8Slice(item.Category.Name, ref blobLength);
                Utf8SliceRef title = PlanUtf8Slice(item.Title, ref blobLength);
                Utf8SliceRef summary = PlanUtf8Slice(item.Summary, ref blobLength);
                int tagStart = tagIndex;
                foreach (TagCoreModel tag in item.Tags)
                {
                    tags[tagIndex++] = PlanUtf8Slice(tag.Name, ref blobLength);
                }
                plans[index] = new ArticlePageItemSlicePlan(category, title, summary, tagStart, item.Tags.Count);
            }
            int tagOffset = checked(AedsArticleSearchWire.HeaderBytes + items.Count * AedsArticleSearchWire.RecordBytes);
            int blobOffset = checked(tagOffset + tagCount * AedsArticleSearchWire.TagRecordBytes);
            var writer = new BinaryPodWriter(destination);
            writer.WriteInt32(AedsArticleSearchWire.Magic);
            writer.WriteInt32(AedsArticleSearchWire.Version);
            writer.WriteInt32(items.Count);
            writer.WriteInt32(items.Count);
            writer.WriteInt32(tagOffset);
            writer.WriteInt32(blobOffset);
            for (int index = 0; index < items.Count; index++)
            {
                ArticleListCoreModel item = items[index];
                ArticlePageItemSlicePlan plan = plans[index];
                writer.WriteInt32(item.Id);
                writer.WriteInt32(item.Views);
                writer.WriteInt64(PodTimeCodec.ToUnixMs(item.CreateTime));
                writer.WriteInt32(item.Category.Id);
                writer.WriteSliceRef(plan.CategoryName);
                writer.WriteSliceRef(plan.Title);
                writer.WriteSliceRef(plan.Summary);
                writer.WriteInt32(plan.TagStart);
                writer.WriteInt32(plan.TagCount);
                writer.WriteInt64(item.CurrentRevisionId);
                writer.WriteInt32(item.RevisionNo);
                writer.WriteInt64(item.CurrentPublicationId.GetValueOrDefault());
                writer.WriteInt32(item.PublicationNo.GetValueOrDefault());
            }
            tagIndex = 0;
            foreach (ArticleListCoreModel item in items)
            {
                foreach (TagCoreModel tag in item.Tags)
                {
                    writer.WriteInt32(tag.Id);
                    writer.WriteSliceRef(tags[tagIndex++]);
                }
            }
            int written = 0;
            tagIndex = 0;
            for (int index = 0; index < items.Count; index++)
            {
                ArticleListCoreModel item = items[index];
                ArticlePageItemSlicePlan plan = plans[index];
                WritePlannedUtf8Slice(item.Category.Name, plan.CategoryName, destination, ref written);
                WritePlannedUtf8Slice(item.Title, plan.Title, destination, ref written);
                WritePlannedUtf8Slice(item.Summary, plan.Summary, destination, ref written);
                foreach (TagCoreModel tag in item.Tags)
                {
                    WritePlannedUtf8Slice(tag.Name, tags[tagIndex++], destination, ref written);
                }
            }
        }
        finally
        {
            if (rentedPlans is not null)
                ArrayPool<ArticlePageItemSlicePlan>.Shared.Return(rentedPlans);
            if (rentedTags is not null)
                ArrayPool<Utf8SliceRef>.Shared.Return(rentedTags);
        }
    }

    /// <summary>Encodes the current ArticleSearch payload.</summary>
    public static byte[] EncodeArticleSearch(IReadOnlyList<ArticleListCoreModel> items)
        => EncodeToArray(1024, writer => WriteArticleSearch(items, writer));

    /// <summary>Decodes only the current packed ArticleSearch layout.</summary>
    public static bool TryDecodeArticleSearch(ReadOnlyMemory<byte> bytes, out IReadOnlyList<ArticleListCoreModel> items)
    {
        items = Array.Empty<ArticleListCoreModel>();
        var reader = new BinaryPodReader(bytes.Span);
        if (!reader.TryReadInt32(out int magic) || magic != AedsArticleSearchWire.Magic
            || !reader.TryReadInt32(out int version) || version != AedsArticleSearchWire.Version
            || !reader.TryReadInt32(out int total) || total < 0
            || !reader.TryReadInt32(out int count) || count < 0 || total < count
            || !reader.TryReadInt32(out int tagOffset)
            || !reader.TryReadInt32(out int blobOffset)
            || (long)tagOffset != AedsArticleSearchWire.HeaderBytes + (long)count * AedsArticleSearchWire.RecordBytes
            || blobOffset < tagOffset || blobOffset > bytes.Length
            || (blobOffset - tagOffset) % AedsArticleSearchWire.TagRecordBytes != 0)
        {
            return false;
        }
        int tagCount = (blobOffset - tagOffset) / AedsArticleSearchWire.TagRecordBytes;
        ReadOnlySpan<byte> blob = bytes.Span[blobOffset..];
        var tagReader = new BinaryPodReader(bytes.Span[tagOffset..blobOffset]);
        if (!TryReadArticleListTags(ref tagReader, tagCount, blob, out List<TagCoreModel> tags))
            return false;
        int usedTags = 0;
        int blobEnd = 0;
        for (int index = 0; index < tagCount; index++)
        {
            ReadOnlySpan<byte> tag = bytes.Span.Slice(tagOffset + index * AedsArticleSearchWire.TagRecordBytes, AedsArticleSearchWire.TagRecordBytes);
            blobEnd = Math.Max(blobEnd, System.Buffers.Binary.BinaryPrimitives.ReadInt32LittleEndian(tag[4..])
                + System.Buffers.Binary.BinaryPrimitives.ReadInt32LittleEndian(tag[8..]));
        }
        var list = new List<ArticleListCoreModel>(count);
        for (int index = 0; index < count; index++)
        {
            if (!reader.TryReadInt32(out int id) || !reader.TryReadInt32(out int views)
                || !reader.TryReadInt64(out long created) || !reader.TryReadInt32(out int categoryId)
                || !reader.TryReadSliceRef(out Utf8SliceRef category) || !reader.TryReadSliceRef(out Utf8SliceRef title)
                || !reader.TryReadSliceRef(out Utf8SliceRef summary) || !reader.TryReadInt32(out int tagStart)
                || !reader.TryReadInt32(out int itemTagCount) || tagStart != usedTags || itemTagCount < 0
                || tagStart > tagCount || itemTagCount > tagCount - tagStart
                || !reader.TryReadInt64(out long revisionId) || !reader.TryReadInt32(out int revisionNo)
                || !reader.TryReadInt64(out long publicationId) || !reader.TryReadInt32(out int publicationNo)
                || !ValidArticleVersionCoordinates(revisionId, revisionNo, publicationId, publicationNo)
                || !TryReadStrictSlice(category, blob, out string categoryName)
                || !TryReadStrictSlice(title, blob, out string decodedTitle)
                || !TryReadStrictSlice(summary, blob, out string decodedSummary))
                return false;
            usedTags += itemTagCount;
            blobEnd = Math.Max(blobEnd, Math.Max(category.Offset + category.Length,
                Math.Max(title.Offset + title.Length, summary.Offset + summary.Length)));
            var pod = PodProjector.ProjectArticleList(id, views, PodTimeCodec.FromUnixMs(created), categoryId,
                categoryName, decodedTitle, decodedSummary, null, out _);
            list.Add(new ArticleListCoreModel(pod, id, decodedTitle, decodedSummary, null, null, views,
                PodTimeCodec.FromUnixMs(created), new ArticleCategoryCoreModel(categoryId, categoryName),
                tags.GetRange(tagStart, itemTagCount), IsDeleted: null, CurrentRevisionId: revisionId, RevisionNo: revisionNo,
                CurrentPublicationId: publicationId == 0 ? null : publicationId,
                PublicationNo: publicationNo == 0 ? null : publicationNo));
        }
        if (usedTags != tagCount || blobEnd != blob.Length)
            return false;
        items = list;
        return true;
    }

    /// <summary>
    /// Writes the <c>PopularArticles</c> contract to the supplied binary destination.
    /// </summary>
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

    /// <summary>
    /// Encodes the <c>PopularArticles</c> contract into a new binary payload.
    /// </summary>
    public static byte[] EncodePopularArticles(IReadOnlyList<PopularArticleCoreModel> items)
        => EncodeToArray(128 + items.Count * 32, writer => WritePopularArticles(items, writer));

    /// <summary>
    /// Attempts to decode the <c>PopularArticles</c> contract from a binary payload.
    /// </summary>
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

    /// <summary>
    /// Writes the <c>FeaturedArticles</c> contract to the supplied binary destination.
    /// </summary>
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

    /// <summary>
    /// Encodes the <c>FeaturedArticles</c> contract into a new binary payload.
    /// </summary>
    public static byte[] EncodeFeaturedArticles(IReadOnlyList<FeaturedArticleSummaryDto> items)
        => EncodeToArray(512 + items.Count * 512, writer => WriteFeaturedArticles(items, writer));

    /// <summary>
    /// Writes the <c>FeaturedArticleCoreList</c> contract to the supplied binary destination.
    /// </summary>
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

    /// <summary>
    /// Encodes the <c>FeaturedArticleCoreList</c> contract into a new binary payload.
    /// </summary>
    public static byte[] EncodeFeaturedArticleCoreList(IReadOnlyList<FeaturedArticleCoreModel> items)
        => EncodeToArray(512 + items.Count * 512, writer => WriteFeaturedArticleCoreList(items, writer));

    /// <summary>
    /// Attempts to decode the <c>FeaturedArticleCoreList</c> contract from a binary payload.
    /// </summary>
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

    /// <summary>
    /// Attempts to decode the <c>FeaturedArticles</c> contract from a binary payload.
    /// </summary>
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

    /// <summary>
    /// Writes the <c>TrashClearResponse</c> contract to the supplied binary destination.
    /// </summary>
    public static void WriteTrashClearResponse(TrashClearResponseDto value, IBufferWriter<byte> destination)
    {
        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CreateTrashClearResponsePod(value.Count));
    }

    /// <summary>
    /// Encodes the <c>TrashClearResponse</c> contract into a new binary payload.
    /// </summary>
    public static byte[] EncodeTrashClearResponse(TrashClearResponseDto value)
        => EncodeToArray(Marshal.SizeOf<TrashClearResponsePod>(), writer => WriteTrashClearResponse(value, writer));

    /// <summary>
    /// Attempts to decode the <c>TrashClearResponse</c> contract from a binary payload.
    /// </summary>
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
