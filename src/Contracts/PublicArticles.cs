using System.Buffers.Binary;
using System.Text;

using static FsusBlog.V2.Contracts.WireLayouts;

namespace FsusBlog.V2.Contracts;

public sealed record Article(
    int Id,
    long Revision,
    long Publication,
    int RevisionNo,
    int PublicationNo,
    string Title,
    string Body,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt,
    DateTimeOffset PublishedAt,
    string? Summary = null);

/// <summary>Current public article payloads selected by the binary HTTP endpoints.</summary>
public static class PublicArticles
{
    private static readonly UTF8Encoding Utf8 = new(false, true);

    public static byte[] EncodeDetail(Article article)
    {
        ValidateArticle(article);
        var title = Utf8.GetBytes(article.Title);
        if (Utf8.GetByteCount(article.Body) > WireLimits.BodyBytes)
            throw new ProtocolException("Public article body exceeds its byte limit");
        var body = Utf8.GetBytes(article.Body);
        var summary = SummaryBytes(article);
        const int recordOffset = ArticleDetailHeaderSize;
        const int tagOffset = recordOffset + ArticleDetailV5RecordSize;
        const int blobOffset = tagOffset + ArticleRightsRecordSize;
        var blobLength = checked(title.Length + body.Length + summary.Length);
        var bytes = Allocate(checked(blobOffset + blobLength));
        var header = bytes.AsSpan(0, ArticleDetailHeaderSize);
        I32(header, 0, ArticleDetailV5Magic);
        I32(header, 4, ArticleDetailV5Version);
        I32(header, 12, recordOffset);
        I32(header, 16, ArticleDetailV5RecordSize);
        I32(header, 20, tagOffset);
        I32(header, 28, tagOffset);
        I32(header, 32, ArticleRightsRecordSize);
        I32(header, 36, blobOffset);
        I32(header, 40, blobLength);

        var record = bytes.AsSpan(recordOffset, ArticleDetailV5RecordSize);
        var blob = bytes.AsSpan(blobOffset);
        var offset = 0;
        WriteCommon(record, article);
        I32(record, ArticleDetailStatusOffset, ArticlePublishedStatus);
        I64(record, ArticleDetailPublishedAtOffset, article.PublishedAt.ToUnixTimeMilliseconds());
        I64(record, ArticleDetailUpdatedAtOffset, article.UpdatedAt.ToUnixTimeMilliseconds());
        WriteCoordinates(record[ArticleDetailCoordinatesOffset..], article);
        WriteText(record, ArticleDetailTitleOffset, blob, title, ref offset);
        WriteText(record, ArticleDetailBodyOffset, blob, body, ref offset);
        WriteText(record, ArticleDetailSummaryOffset, blob, summary, ref offset);
        WriteSlice(record, ArticleDetailCoverOffset, offset, 0);
        WriteSlice(record, ArticleDetailCategoryOffset, offset, 0);
        // The detail format requires the rights record even when no rights snapshot is attached.
        var rights = bytes.AsSpan(tagOffset, ArticleRightsRecordSize);
        for (var slot = 32; slot < ArticleRightsRecordSize; slot += 8)
            WriteSlice(rights, slot, offset, 0);
        return Aeds.Encode(FrameType.ArticleDetail, bytes);
    }

    public static byte[] EncodeList(IReadOnlyList<Article> articles, int total, string? nextCursor = null)
    {
        ValidateTotal(articles, total);
        if (nextCursor is not null &&
            (nextCursor.Length is 0 or > ArticleListCursorMaxBytes ||
             nextCursor.Any(static c => !char.IsAsciiLetterOrDigit(c) && c is not '-' and not '_')))
            throw new ProtocolException("Invalid public article cursor");

        var cursor = Encoding.ASCII.GetBytes(nextCursor ?? string.Empty);
        var text = articles.Select(article =>
        {
            ValidateArticle(article);
            return (Title: Utf8.GetBytes(article.Title), Summary: SummaryBytes(article));
        }).ToArray();
        var blobLength = text.Sum(static item => item.Title.Length + item.Summary.Length);
        var blobMetaOffset = ArticleListCursorOffset + cursor.Length;
        var blobOffset = blobMetaOffset + 12;
        var recordsOffset = checked(blobOffset + blobLength);
        var bytes = Allocate(checked(recordsOffset + articles.Count * ArticleListRecordSizeCurrent));
        I32(bytes, 0, ArticleListCursorMagic);
        I32(bytes, 4, ArticleListCursorVersion);
        bytes[ArticleListCursorFlagOffset] = nextCursor is null ? (byte)0 : (byte)1;
        I32(bytes, ArticleListTotalOffset, total);
        I32(bytes, ArticleListCursorLengthOffset, cursor.Length);
        cursor.CopyTo(bytes.AsSpan(ArticleListCursorOffset));
        I32(bytes, blobMetaOffset, articles.Count);
        I32(bytes, blobMetaOffset + 8, blobLength);

        var blob = bytes.AsSpan(blobOffset, blobLength);
        var textOffset = 0;
        for (var index = 0; index < articles.Count; index++)
        {
            var article = articles[index];
            var record = bytes.AsSpan(recordsOffset + index * ArticleListRecordSizeCurrent, ArticleListRecordSizeCurrent);
            WriteCommon(record, article);
            WriteSlice(record, ArticleListCategoryOffset, textOffset, 0);
            WriteText(record, ArticleListTitleOffset, blob, text[index].Title, ref textOffset);
            WriteText(record, ArticleListSummaryOffset, blob, text[index].Summary, ref textOffset);
            record[ArticleListDeletedOffset + 1] = 1;
            I32(record, ArticleListStatusOffset, ArticlePublishedStatus);
            I64(record, ArticleListPublishedAtOffset, article.PublishedAt.ToUnixTimeMilliseconds());
            WriteCoordinates(record[ArticleListCoordinatesOffset..], article);
        }
        return Aeds.Encode(FrameType.ArticleList, bytes);
    }

    public static byte[] EncodeSearch(IReadOnlyList<Article> articles, int total)
    {
        ValidateTotal(articles, total);
        var summaries = articles.Select(article =>
        {
            ValidateArticle(article);
            return SummaryBytes(article);
        }).ToArray();
        // FAS4 carries the returned count in its header. It has no separate unpaginated total.
        const int itemFixedBytes = ArticleSearchItemPodSize + 8 + ArticlePublicationCoordinateBytes;
        var bytes = Allocate(checked(12 + articles.Count * itemFixedBytes + summaries.Sum(static bytes => bytes.Length)));
        I32(bytes, 0, ArticleSearchV4Magic);
        I32(bytes, 4, ArticleSearchV4Version);
        I32(bytes, 8, articles.Count);
        var offset = 12;
        for (var index = 0; index < articles.Count; index++)
        {
            var article = articles[index];
            var summary = summaries[index];
            var record = bytes.AsSpan(offset, ArticleSearchItemPodSize);
            WriteCommon(record, article);
            Utf8.GetBytes(article.Title, record.Slice(ArticleSearchTitleOffset, ArticleSearchTitleBytes));
            WriteSlice(record, ArticleSearchSummaryOffset, 0, summary.Length);
            record[ArticleSearchDeletedOffset + 1] = 1;
            offset += ArticleSearchItemPodSize;
            I32(bytes, offset + 4, summary.Length);
            offset += 8;
            summary.CopyTo(bytes.AsSpan(offset));
            offset += summary.Length;
            WriteCoordinates(bytes.AsSpan(offset, ArticlePublicationCoordinateBytes), article);
            offset += ArticlePublicationCoordinateBytes;
        }
        return Aeds.Encode(FrameType.ArticleSearch, bytes);
    }

    private static byte[] SummaryBytes(Article article)
    {
        var summary = article.Summary ?? string.Empty;
        if (Utf8.GetByteCount(summary) > 2048)
            throw new ProtocolException("Public article summary exceeds its byte limit");
        return Utf8.GetBytes(summary);
    }

    private static void ValidateArticle(Article article)
    {
        if (article.Id <= 0 || article.Revision <= 0 || article.Publication <= 0 ||
            article.RevisionNo <= 0 || article.PublicationNo <= 0 ||
            article.PublishedAt.ToUnixTimeMilliseconds() == 0)
            throw new ProtocolException("Invalid public article publication coordinates");
        if (article.Title.Length == 0 || article.Title.Contains('\0') ||
            Utf8.GetByteCount(article.Title) > ArticleSearchTitleBytes)
            throw new ProtocolException("Invalid public article title");
    }

    private static void ValidateTotal(IReadOnlyList<Article> articles, int total)
    {
        if (total < articles.Count || articles.Count > WireLimits.MaxPayloadBytes / ArticleListRecordSizeCurrent)
            throw new ProtocolException("Invalid public article count");
    }

    private static byte[] Allocate(int length)
    {
        if (length > WireLimits.MaxPayloadBytes)
            throw new ProtocolException("Public article payload exceeds its byte limit");
        return new byte[length];
    }

    private static void WriteCommon(Span<byte> record, Article article)
    {
        I32(record, ArticleIdOffset, article.Id);
        I64(record, ArticleCreatedAtOffset, article.CreatedAt.ToUnixTimeMilliseconds());
    }

    private static void WriteCoordinates(Span<byte> field, Article article)
    {
        I64(field, 0, article.Revision);
        I32(field, 8, article.RevisionNo);
        I64(field, 12, article.Publication);
        I32(field, 20, article.PublicationNo);
    }

    private static void WriteText(Span<byte> record, int field, Span<byte> blob, ReadOnlySpan<byte> text, ref int offset)
    {
        WriteSlice(record, field, offset, text.Length);
        text.CopyTo(blob[offset..]);
        offset += text.Length;
    }

    private static void WriteSlice(Span<byte> record, int field, int offset, int length)
    {
        I32(record, field, offset);
        I32(record, field + 4, length);
    }

    private static void I32(Span<byte> bytes, int offset, int value) =>
        BinaryPrimitives.WriteInt32LittleEndian(bytes[offset..], value);

    private static void I64(Span<byte> bytes, int offset, long value) =>
        BinaryPrimitives.WriteInt64LittleEndian(bytes[offset..], value);
}
