using System.Text;

using FsusBlog.Core.Mapping.Codecs;
using FsusBlog.Shared.Contracts.Primitives;
using FsusBlog.Shared.Contracts.Validation;

namespace FsusBlog.Core.Cache;

/// <summary>Identifies whether a selective result was decoded directly from the current wire layout.</summary>
public enum AedsProjectionDecodePath
{
    Projection = 1
}

/// <summary>Contains the fields required to render one public article-list card.</summary>
public sealed record PublicArticleListCardProjection(
    int Id,
    DateTime CreateTime,
    int CategoryId,
    string CategoryName,
    string Title,
    string Summary,
    IReadOnlyList<PublicArticleListTagProjection> Tags);

/// <summary>Contains one tag selected for a public article-list card.</summary>
public sealed record PublicArticleListTagProjection(int Id, string Name);

/// <summary>Contains a validated page of public article-list card projections.</summary>
public sealed record PublicArticleListProjectionPage(
    IReadOnlyList<PublicArticleListCardProjection> Items,
    int Total,
    string? NextCursor,
    bool HasMore,
    AedsProjectionDecodePath DecodePath);

/// <summary>Provides selective AEDS payload readers in addition to the canonical codecs.</summary>
public static partial class PodBinaryCodec
{
    private const int PublicArticleListCardTagLimit = 5;

    /// <summary>
    /// Validates an ArticleList payload and decodes only public card fields for supported layouts.
    /// </summary>
    public static bool TryDecodePublicArticleListCardProjection(
        ReadOnlyMemory<byte> bytes,
        out PublicArticleListProjectionPage page)
    {
        var reader = new BinaryPodReader(bytes.Span);
        string? nextCursor = null;
        bool hasMore = false;
        if (!reader.TryReadInt32(out int total))
        {
            page = default!;
            return false;
        }

        if (total != AedsArticleListWire.CursorMagic
            || !reader.TryReadInt32(out int version)
            || version != ArticlePageCursorEnvelopeVersion)
        {
            page = default!;
            return false;
        }

        if (!reader.TryReadByte(out byte hasMoreByte)
            || hasMoreByte > 1
            || !reader.TryReadInt32(out total)
            || !reader.TryReadBytes(out ReadOnlySpan<byte> cursorBytes)
            || cursorBytes.Length > 512
            || !TryDecodeArticleListCursorUtf8(cursorBytes, out nextCursor))
        {
            page = default!;
            return false;
        }
        hasMore = hasMoreByte == 1;
        if (hasMore != !string.IsNullOrWhiteSpace(nextCursor))
        {
            page = default!;
            return false;
        }

        if (!reader.TryReadInt32(out int count)
            || !reader.TryReadInt32(out int tagRecordCount)
            || count < 0
            || tagRecordCount < 0
            || !reader.TryReadBytes(out ReadOnlySpan<byte> blob))
        {
            page = default!;
            return false;
        }

        const int ItemRecordSize = AedsArticleListWire.RecordBytes;
        if (total < 0 || (long)reader.Remaining != (long)count * ItemRecordSize
            + (long)tagRecordCount * AedsArticleListWire.TagRecordBytes)
        {
            page = default!;
            return false;
        }

        var records = new ArticleListProjectionRecord[count];
        for (int index = 0; index < count; index++)
        {
            if (!reader.TryReadSpan(ItemRecordSize, out ReadOnlySpan<byte> record)
                || !TryReadProjectionRecord(record, tagRecordCount, out records[index]))
            {
                page = default!;
                return false;
            }
        }

        var tags = new PublicArticleListTagProjection[tagRecordCount];
        for (int index = 0; index < tagRecordCount; index++)
        {
            if (!reader.TryReadInt32(out int id)
                || !reader.TryReadSliceRef(out Utf8SliceRef name)
                || !TryReadStrictSlice(name, blob, out string decodedName))
            {
                page = default!;
                return false;
            }
            tags[index] = new PublicArticleListTagProjection(id, decodedName);
        }
        if (!reader.IsConsumed)
        {
            page = default!;
            return false;
        }

        var items = new PublicArticleListCardProjection[count];
        for (int index = 0; index < count; index++)
        {
            ArticleListProjectionRecord record = records[index];
            if (!TryReadStrictSlice(record.CategoryName, blob, out string categoryName)
                || !TryReadStrictSlice(record.Title, blob, out string title)
                || !TryReadStrictSlice(record.Summary, blob, out string summary))
            {
                page = default!;
                return false;
            }

            int projectedTagCount = Math.Min(record.TagCount, PublicArticleListCardTagLimit);
            var projectedTags = new PublicArticleListTagProjection[projectedTagCount];
            Array.Copy(tags, record.TagStart, projectedTags, 0, projectedTagCount);
            items[index] = new PublicArticleListCardProjection(
                record.Id,
                PodTimeCodec.FromUnixMs(record.CreateTimeUnixMs),
                record.CategoryId,
                categoryName,
                title,
                summary,
                projectedTags);
        }

        page = new PublicArticleListProjectionPage(
            items,
            total,
            nextCursor,
            hasMore,
            AedsProjectionDecodePath.Projection);
        return true;
    }

    private static bool TryReadProjectionRecord(
        ReadOnlySpan<byte> record,
        int tagRecordCount,
        out ArticleListProjectionRecord projection)
    {
        if (record.Length != AedsArticleListWire.RecordBytes)
        {
            projection = default;
            return false;
        }
        int tagStart = System.Buffers.Binary.BinaryPrimitives.ReadInt32LittleEndian(
            record[AedsArticleListWire.TagStartOffset..]);
        int tagCount = System.Buffers.Binary.BinaryPrimitives.ReadInt32LittleEndian(
            record[AedsArticleListWire.TagCountOffset..]);
        if (tagStart < 0 || tagCount < 0 || tagStart > tagRecordCount || tagCount > tagRecordCount - tagStart
            || record[AedsArticleListWire.IsDeletedOffset] > 1
            || record[AedsArticleListWire.HasIsDeletedOffset] > 1
            || record[AedsArticleListWire.Reserved0Offset] != 0
            || record[AedsArticleListWire.Reserved1Offset] != 0)
        {
            projection = default;
            return false;
        }

        if (!ValidArticleVersionCoordinates(
            System.Buffers.Binary.BinaryPrimitives.ReadInt64LittleEndian(record[AedsArticleListWire.CurrentRevisionIdOffset..]),
            System.Buffers.Binary.BinaryPrimitives.ReadInt32LittleEndian(record[AedsArticleListWire.RevisionNoOffset..]),
            System.Buffers.Binary.BinaryPrimitives.ReadInt64LittleEndian(record[AedsArticleListWire.CurrentPublicationIdOffset..]),
            System.Buffers.Binary.BinaryPrimitives.ReadInt32LittleEndian(record[AedsArticleListWire.PublicationNoOffset..])))
        {
            projection = default;
            return false;
        }
        projection = new ArticleListProjectionRecord(
            System.Buffers.Binary.BinaryPrimitives.ReadInt32LittleEndian(record[AedsArticleListWire.IdOffset..]),
            System.Buffers.Binary.BinaryPrimitives.ReadInt64LittleEndian(record[AedsArticleListWire.CreateTimeUnixMsOffset..]),
            System.Buffers.Binary.BinaryPrimitives.ReadInt32LittleEndian(record[AedsArticleListWire.CategoryIdOffset..]),
            ReadSlice(record, AedsArticleListWire.CategoryNameOffset),
            ReadSlice(record, AedsArticleListWire.TitleOffset),
            ReadSlice(record, AedsArticleListWire.SummaryOffset),
            tagStart,
            tagCount);
        return true;
    }

    private static Utf8SliceRef ReadSlice(ReadOnlySpan<byte> record, int offset)
    {
        Span<int> values = stackalloc int[2];
        values[0] = System.Buffers.Binary.BinaryPrimitives.ReadInt32LittleEndian(record[offset..]);
        values[1] = System.Buffers.Binary.BinaryPrimitives.ReadInt32LittleEndian(record[(offset + sizeof(int))..]);
        return System.Runtime.InteropServices.MemoryMarshal.Read<Utf8SliceRef>(
            System.Runtime.InteropServices.MemoryMarshal.AsBytes(values));
    }

    private static bool TryReadStrictSlice(Utf8SliceRef slice, ReadOnlySpan<byte> blob, out string value)
    {
        if (slice.Offset < 0 || slice.Length < 0 || slice.Offset > blob.Length || slice.Length > blob.Length - slice.Offset)
        {
            value = string.Empty;
            return false;
        }
        try
        {
            value = s_strictUtf8.GetString(blob.Slice(slice.Offset, slice.Length));
            return true;
        }
        catch (DecoderFallbackException)
        {
            value = string.Empty;
            return false;
        }
    }

    private readonly record struct ArticleListProjectionRecord(
        int Id,
        long CreateTimeUnixMs,
        int CategoryId,
        Utf8SliceRef CategoryName,
        Utf8SliceRef Title,
        Utf8SliceRef Summary,
        int TagStart,
        int TagCount);
}
