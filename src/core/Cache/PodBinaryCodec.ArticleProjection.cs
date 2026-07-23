using System.Text;

using FsusBlog.Core.Mapping.Codecs;
using FsusBlog.Shared.Contracts.Primitives;

namespace FsusBlog.Core.Cache;

/// <summary>Identifies whether a selective result was decoded directly or through canonical compatibility.</summary>
public enum AedsProjectionDecodePath
{
    Projection = 1,
    CanonicalFallback = 2
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

        if (total == AedsArticleListAccessProfile.CursorMagic)
        {
            if (!reader.TryReadInt32(out int version))
            {
                page = default!;
                return false;
            }

            if (version == ArticlePageCursorEnvelopeLegacyVersion)
            {
                if (!reader.TryReadInt64(out long nextCursorUnixMs)
                    || !reader.TryReadByte(out byte hasMoreByte)
                    || hasMoreByte > 1
                    || !reader.TryReadInt32(out total))
                {
                    page = default!;
                    return false;
                }
                hasMore = hasMoreByte == 1;
                nextCursor = nextCursorUnixMs > 0
                    ? nextCursorUnixMs.ToString(System.Globalization.CultureInfo.InvariantCulture)
                    : null;
            }
            else if (version == ArticlePageCursorEnvelopeVersion)
            {
                if (!reader.TryReadByte(out byte hasMoreByte)
                    || hasMoreByte > 1
                    || !reader.TryReadInt32(out total)
                    || !reader.TryReadBytes(out ReadOnlySpan<byte> cursorBytes)
                    || cursorBytes.Length > 64
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
            }
            else
            {
                page = default!;
                return false;
            }
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

        int tagBytes;
        int itemRecordBytes;
        try
        {
            tagBytes = checked(tagRecordCount * AedsArticleListAccessProfile.TagRecordBytes);
            itemRecordBytes = reader.Remaining - tagBytes;
        }
        catch (OverflowException)
        {
            page = default!;
            return false;
        }
        int itemRecordSize = count == 0 ? 100 : itemRecordBytes / count;
        if (itemRecordBytes < 0
            || count > 0 && itemRecordBytes % count != 0
            || reader.Remaining != count * itemRecordSize + tagBytes)
        {
            page = default!;
            return false;
        }

        if (AedsArticleListAccessProfile.FallbackPublicCardRecordBytes.Contains(itemRecordSize))
        {
            if (!TryDecodeArticlePage(bytes, out var canonical))
            {
                page = default!;
                return false;
            }
            page = new PublicArticleListProjectionPage(
                canonical.Items.Select(static item => new PublicArticleListCardProjection(
                    item.Id,
                    item.CreateTime,
                    item.Category.Id,
                    item.Category.Name,
                    item.Title,
                    item.Summary ?? string.Empty,
                    item.Tags.Take(PublicArticleListCardTagLimit)
                        .Select(static tag => new PublicArticleListTagProjection(tag.Id, tag.Name))
                        .ToArray())).ToArray(),
                canonical.Total,
                canonical.NextCursor,
                canonical.HasMore,
                AedsProjectionDecodePath.CanonicalFallback);
            return true;
        }
        if (!AedsArticleListAccessProfile.SupportedPublicCardRecordBytes.Contains(itemRecordSize))
        {
            page = default!;
            return false;
        }

        var records = new ArticleListProjectionRecord[count];
        for (int index = 0; index < count; index++)
        {
            if (!reader.TryReadSpan(itemRecordSize, out ReadOnlySpan<byte> record)
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

        if (hasMore && nextCursor is not null && nextCursor.IndexOf(':', StringComparison.Ordinal) < 0
            && long.TryParse(nextCursor, out long legacyUnixMs) && items.Length > 0)
        {
            nextCursor = string.Create(
                System.Globalization.CultureInfo.InvariantCulture,
                $"{legacyUnixMs}:{items[^1].Id}");
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
        if (record.Length is not (76 or 100))
        {
            projection = default;
            return false;
        }
        int tagStart = System.Buffers.Binary.BinaryPrimitives.ReadInt32LittleEndian(
            record[AedsArticleListAccessProfile.TagStartOffset..]);
        int tagCount = System.Buffers.Binary.BinaryPrimitives.ReadInt32LittleEndian(
            record[AedsArticleListAccessProfile.TagCountOffset..]);
        if (tagStart < 0 || tagCount < 0 || tagStart > tagRecordCount || tagCount > tagRecordCount - tagStart
            || record[AedsArticleListAccessProfile.IsDeletedOffset] > 1
            || record[AedsArticleListAccessProfile.HasIsDeletedOffset] > 1
            || record[AedsArticleListAccessProfile.Reserved0Offset] != 0
            || record[AedsArticleListAccessProfile.Reserved1Offset] != 0)
        {
            projection = default;
            return false;
        }

        projection = new ArticleListProjectionRecord(
            System.Buffers.Binary.BinaryPrimitives.ReadInt32LittleEndian(record[AedsArticleListAccessProfile.IdOffset..]),
            System.Buffers.Binary.BinaryPrimitives.ReadInt64LittleEndian(record[AedsArticleListAccessProfile.CreateTimeUnixMsOffset..]),
            System.Buffers.Binary.BinaryPrimitives.ReadInt32LittleEndian(record[AedsArticleListAccessProfile.CategoryIdOffset..]),
            ReadSlice(record, AedsArticleListAccessProfile.CategoryNameOffset),
            ReadSlice(record, AedsArticleListAccessProfile.TitleOffset),
            ReadSlice(record, AedsArticleListAccessProfile.SummaryOffset),
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
