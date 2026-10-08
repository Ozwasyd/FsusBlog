using System.Text;

using FsusBlog.Core.Mapping.Codecs;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Shared.Contracts.Primitives;

namespace FsusBlog.Core.Cache;

/// <summary>Contains canonical ArticleList record validation helpers.</summary>
public static partial class PodBinaryCodec
{
    private static bool TryReadArticleListRecordHeader(
        ref BinaryPodReader reader,
        int tagRecordCount,
        ReadOnlySpan<byte> blob,
        out ArticleListRecordHeader header)
    {
        header = default;
        if (!reader.TryReadInt32(out int id)
            || !reader.TryReadInt32(out int views)
            || !reader.TryReadInt64(out long createTimeUnixMs)
            || !reader.TryReadInt32(out int categoryId)
            || !reader.TryReadSliceRef(out Utf8SliceRef categoryName)
            || !reader.TryReadSliceRef(out Utf8SliceRef title)
            || !reader.TryReadSliceRef(out Utf8SliceRef summary)
            || !reader.TryReadInt32(out int tagStart)
            || !reader.TryReadInt32(out int tagCount)
            || !reader.TryReadByte(out byte isDeleted)
            || !reader.TryReadByte(out byte hasIsDeleted)
            || !reader.TryReadByte(out byte reserved0)
            || !reader.TryReadByte(out byte reserved1)
            || tagStart < 0
            || tagCount < 0
            || tagStart > tagRecordCount
            || tagCount > tagRecordCount - tagStart
            || isDeleted > 1
            || hasIsDeleted > 1
            || reserved0 != 0
            || reserved1 != 0
            || !IsSliceValid(categoryName, blob)
            || !IsSliceValid(title, blob)
            || !IsSliceValid(summary, blob))
        {
            return false;
        }

        header = new ArticleListRecordHeader(
            id,
            views,
            createTimeUnixMs,
            categoryId,
            categoryName,
            title,
            summary,
            tagStart,
            tagCount,
            hasIsDeleted == 1 ? isDeleted == 1 : null);
        return true;
    }

    private static bool TryReadArticleListTags(
        ref BinaryPodReader reader,
        int tagRecordCount,
        ReadOnlySpan<byte> blob,
        out List<TagCoreModel> tags)
    {
        tags = new List<TagCoreModel>(tagRecordCount);
        try
        {
            for (int index = 0; index < tagRecordCount; index++)
            {
                if (!reader.TryReadInt32(out int tagId)
                    || !reader.TryReadSliceRef(out Utf8SliceRef tagName)
                    || !IsSliceValid(tagName, blob))
                {
                    return false;
                }

                tags.Add(new TagCoreModel(tagId, PodUtf8Codec.ReadSlice(tagName, blob)));
            }
        }
        catch (DecoderFallbackException)
        {
            return false;
        }

        return true;
    }

    private readonly record struct ArticleListRecordHeader(
        int Id,
        int Views,
        long CreateTimeUnixMs,
        int CategoryId,
        Utf8SliceRef CategoryName,
        Utf8SliceRef Title,
        Utf8SliceRef Summary,
        int TagStart,
        int TagCount,
        bool? IsDeleted);
}
