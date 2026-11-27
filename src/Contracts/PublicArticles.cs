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
    string? Summary = null,
    TaxonomyName? Category = null,
    IReadOnlyList<TaxonomyName>? Tags = null,
    PublishedArticleRights? Rights = null,
    string? CoverMediaDigest = null);

/// <summary>Current public article payloads selected by the binary HTTP endpoints.</summary>
public static class PublicArticles
{
    private static readonly UTF8Encoding Utf8 = new(false, true);

    public static byte[] EncodeDetail(Article article)
    {
        ValidateArticle(article);
        var title = Utf8.GetBytes(article.Title);
        var bodyLength = Utf8.GetByteCount(article.Body);
        if (bodyLength > WireLimits.BodyBytes)
            throw new ProtocolException("Public article body exceeds its byte limit");
        var cover = article.CoverMediaDigest is null ? [] : Utf8.GetBytes(PublishedArticleImage.FilePath(article.Id, article.Publication, article.CoverMediaDigest));
        var summary = SummaryBytes(article);
        var taxonomy = EncodeTaxonomy(article);
        const int recordOffset = ArticleDetailHeaderSize;
        const int tagOffset = recordOffset + ArticleDetailV5RecordSize;
        var rightsOffset = checked(tagOffset + taxonomy.Tags.Length * ArticleTagRecordSize);
        var blobOffset = rightsOffset + ArticleRightsRecordSize;
        var rightsText = article.Rights is { } snapshot ? RightsText(article, snapshot) : [];
        var blobLength = checked(title.Length + bodyLength + summary.Length + cover.Length + taxonomy.BlobLength + rightsText.Sum(text => text.Length));
        var frame = Allocate(checked(blobOffset + blobLength), Aeds.HeaderSize);
        var bytes = frame.AsSpan(Aeds.HeaderSize);
        var header = bytes[..ArticleDetailHeaderSize];
        I32(header, 0, ArticleDetailV5Magic);
        I32(header, 4, ArticleDetailV5Version);
        I32(header, 12, recordOffset);
        I32(header, 16, ArticleDetailV5RecordSize);
        I32(header, 20, tagOffset);
        I32(header, 24, taxonomy.Tags.Length);
        I32(header, 28, rightsOffset);
        I32(header, 32, ArticleRightsRecordSize);
        I32(header, 36, blobOffset);
        I32(header, 40, blobLength);

        var record = bytes.Slice(recordOffset, ArticleDetailV5RecordSize);
        var blob = bytes[blobOffset..];
        var offset = 0;
        WriteCommon(record, article);
        I32(record, ArticleDetailStatusOffset, ArticlePublishedStatus);
        I64(record, ArticleDetailPublishedAtOffset, article.PublishedAt.ToUnixTimeMilliseconds());
        I64(record, ArticleDetailUpdatedAtOffset, article.UpdatedAt.ToUnixTimeMilliseconds());
        WriteCoordinates(record[ArticleDetailCoordinatesOffset..], article);
        WriteText(record, ArticleDetailTitleOffset, blob, title, ref offset);
        WriteSlice(record, ArticleDetailBodyOffset, offset, bodyLength);
        offset += Utf8.GetBytes(article.Body, blob.Slice(offset, bodyLength));
        WriteText(record, ArticleDetailSummaryOffset, blob, summary, ref offset);
        WriteText(record, ArticleDetailCoverOffset, blob, cover, ref offset);
        WriteText(record, ArticleDetailCategoryOffset, blob, taxonomy.Category, ref offset);
        for (var i = 0; i < taxonomy.Tags.Length; i++)
            WriteTag(bytes.Slice(tagOffset + i * ArticleTagRecordSize, ArticleTagRecordSize),
                blob, taxonomy.Tags[i], ref offset);
        var rights = bytes.Slice(rightsOffset, ArticleRightsRecordSize);
        if (article.Rights is { } published)
        {
            var policy = published.Policy;
            I64(rights, 0, published.SnapshotId);
            I64(rights, 8, article.Revision);
            I32(rights, 16, article.RevisionNo);
            I32(rights, 20, (policy.Enabled ? 1 : 0) | (policy.AllowCodeCopy ? 2 : 0) | (policy.ShowPublicBadge ? 4 : 0) |
                (policy.ProofBindingEnabled ? 8 : 0) | (policy.CopyrightYear != 0 ? 16 : 0) |
                (policy.CopyrightHolder.Length != 0 ? 32 : 0) | (policy.RightsStatement.Length != 0 ? 64 : 0) |
                (policy.AttributionTemplate.Length != 0 ? 128 : 0));
            I32(rights, 24, policy.CopyrightYear);
            I32(rights, 28, policy.MaxExcerptChars);
        }
        for (int slot = 32, i = 0; slot < ArticleRightsRecordSize; slot += 8, i++)
        {
            if (i < rightsText.Length) WriteText(rights, slot, blob, rightsText[i], ref offset);
            else WriteSlice(rights, slot, offset, 0);
        }
        Aeds.WriteHeader(frame, FrameType.ArticleDetail, bytes);
        return frame;
    }

    private static byte[][] RightsText(Article article, PublishedArticleRights snapshot)
    {
        var policy = snapshot.Policy;
        Wire.Validate(policy);
        if (snapshot.SnapshotId <= 0 || !policy.Present || policy.Id != article.Id || policy.Revision != article.Revision)
            throw new ProtocolException("Invalid public rights snapshot binding");
        return [Utf8.GetBytes(policy.LicenseType), Utf8.GetBytes(policy.CopyrightHolder), Utf8.GetBytes(policy.RightsStatement),
            Utf8.GetBytes(policy.AttributionTemplate), Utf8.GetBytes(policy.CopyPolicy)];
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
            return (Title: Utf8.GetBytes(article.Title), Summary: SummaryBytes(article), Taxonomy: EncodeTaxonomy(article));
        }).ToArray();
        var blobLength = text.Sum(static item => item.Title.Length + item.Summary.Length + item.Taxonomy.BlobLength);
        var tagCount = text.Sum(static item => item.Taxonomy.Tags.Length);
        var blobMetaOffset = ArticleListCursorOffset + cursor.Length;
        var blobOffset = blobMetaOffset + 12;
        var recordsOffset = checked(blobOffset + blobLength);
        var tagsOffset = checked(recordsOffset + articles.Count * ArticleListRecordSizeCurrent);
        var bytes = Allocate(checked(tagsOffset + tagCount * ArticleTagRecordSize));
        I32(bytes, 0, ArticleListCursorMagic);
        I32(bytes, 4, ArticleListCursorVersion);
        bytes[ArticleListCursorFlagOffset] = nextCursor is null ? (byte)0 : (byte)1;
        I32(bytes, ArticleListTotalOffset, total);
        I32(bytes, ArticleListCursorLengthOffset, cursor.Length);
        cursor.CopyTo(bytes.AsSpan(ArticleListCursorOffset));
        I32(bytes, blobMetaOffset, articles.Count);
        I32(bytes, blobMetaOffset + 4, tagCount);
        I32(bytes, blobMetaOffset + 8, blobLength);

        var blob = bytes.AsSpan(blobOffset, blobLength);
        var textOffset = 0;
        var nextTag = 0;
        for (var index = 0; index < articles.Count; index++)
        {
            var article = articles[index];
            var record = bytes.AsSpan(recordsOffset + index * ArticleListRecordSizeCurrent, ArticleListRecordSizeCurrent);
            WriteCommon(record, article);
            var taxonomy = text[index].Taxonomy;
            I32(record, ArticleListTagStartOffset, nextTag);
            I32(record, ArticleListTagCountOffset, taxonomy.Tags.Length);
            foreach (var tag in taxonomy.Tags)
            {
                WriteTag(bytes.AsSpan(tagsOffset + nextTag * ArticleTagRecordSize, ArticleTagRecordSize), blob, tag, ref textOffset);
                nextTag++;
            }
            WriteText(record, ArticleListCategoryOffset, blob, taxonomy.Category, ref textOffset);
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
        var fields = articles.Select(article =>
        {
            ValidateArticle(article);
            return (Summary: SummaryBytes(article), Taxonomy: EncodeTaxonomy(article));
        }).ToArray();
        // FAS4 carries the returned count in its header. It has no separate unpaginated total.
        const int itemFixedBytes = ArticleSearchItemPodSize + 8 + ArticlePublicationCoordinateBytes;
        var bytes = Allocate(checked(12 + articles.Count * itemFixedBytes + fields.Sum(static field =>
            field.Summary.Length + field.Taxonomy.Tags.Length * ArticleSearchTagPodSize)));
        I32(bytes, 0, ArticleSearchV4Magic);
        I32(bytes, 4, ArticleSearchV4Version);
        I32(bytes, 8, articles.Count);
        var offset = 12;
        for (var index = 0; index < articles.Count; index++)
        {
            var article = articles[index];
            var (summary, taxonomy) = fields[index];
            var record = bytes.AsSpan(offset, ArticleSearchItemPodSize);
            WriteCommon(record, article);
            Utf8.GetBytes(article.Title, record.Slice(ArticleSearchTitleOffset, ArticleSearchTitleBytes));
            WriteFixedName(record.Slice(ArticleSearchCategoryOffset, ArticleSearchCategoryBytes), taxonomy.Category);
            WriteSlice(record, ArticleSearchSummaryOffset, 0, summary.Length);
            record[ArticleSearchDeletedOffset + 1] = 1;
            offset += ArticleSearchItemPodSize;
            I32(bytes, offset, taxonomy.Tags.Length);
            offset += 4;
            foreach (var tag in taxonomy.Tags)
            {
                var tagRecord = bytes.AsSpan(offset, ArticleSearchTagPodSize);
                I32(tagRecord, 0, tag.Id);
                WriteFixedName(tagRecord.Slice(4), tag.Text);
                offset += ArticleSearchTagPodSize;
            }
            I32(bytes, offset, summary.Length);
            offset += 4;
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

    private static EncodedTaxonomy EncodeTaxonomy(Article article) => new(
        article.Category is { } category ? TaxonomyWire.NameBytes(category.Id, category.Name) : [],
        article.Tags?.Select(tag => (tag.Id, TaxonomyWire.NameBytes(tag.Id, tag.Name))).ToArray() ?? []);

    private static void WriteTag(Span<byte> record, Span<byte> blob, (int Id, byte[] Text) tag, ref int offset)
    {
        I32(record, 0, tag.Id);
        WriteText(record, 4, blob, tag.Text, ref offset);
    }

    private static void WriteFixedName(Span<byte> field, byte[] text)
    {
        var length = Math.Min(text.Length, field.Length);
        while (length < text.Length && (text[length] & 0xc0) == 0x80)
            length--;
        text.AsSpan(0, length).CopyTo(field);
    }

    private sealed record EncodedTaxonomy(byte[] Category, (int Id, byte[] Text)[] Tags)
    {
        internal int BlobLength => checked(Category.Length + Tags.Sum(tag => tag.Text.Length));
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

    private static byte[] Allocate(int length, int prefix = 0)
    {
        if (length > WireLimits.MaxPayloadBytes)
            throw new ProtocolException("Public article payload exceeds its byte limit");
        return new byte[prefix + length];
    }

    private static void WriteCommon(Span<byte> record, Article article)
    {
        I32(record, ArticleIdOffset, article.Id);
        I32(record, ArticleCategoryIdOffset, article.Category?.Id ?? 0);
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
