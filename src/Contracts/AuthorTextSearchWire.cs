using System.Text;

namespace FsusBlog.V2.Contracts;

public sealed record AuthorTextSearchRow(int Id, long Revision, string Title, int Field, string Snippet,
    int HighlightStart, int HighlightEnd, int SourceStart, int SourceEnd, int SourceByteStart, int SourceByteEnd,
    byte[] SourceDigest);

public sealed record AuthorTextSearchPage(bool Ready, bool More, IReadOnlyList<AuthorTextSearchRow> Rows);
public sealed record AuthorTextRankedQuery(string Query, string Cursor);
public sealed record AuthorTextRankedPage(bool Ready, string NextCursor, IReadOnlyList<AuthorTextSearchRow> Rows);
public sealed record AuthorTextTaxonomyFacet(int Id, string Name, int Count);
public sealed record AuthorTextFacetedPage(bool Ready, string NextCursor, int Total, IReadOnlyList<int> StateCounts,
    bool MoreCategories, IReadOnlyList<AuthorTextTaxonomyFacet> Categories, bool MoreTags, IReadOnlyList<AuthorTextTaxonomyFacet> Tags,
    IReadOnlyList<AuthorTextSearchRow> Rows);

public static partial class Wire
{
    public static byte[] EncodeAuthorTextSearchQuery(string value)
    {
        ValidateAuthorTextQuery(value);
        var writer = new Writer();
        writer.Text(value, WireLimits.AuthorTextSearchQueryBytes);
        return Aeds.Encode(FrameType.AuthorTextSearchQuery, writer.Written);
    }

    public static string DecodeAuthorTextSearchQuery(ReadOnlySpan<byte> frame)
    {
        if (frame.Length > WireLimits.MaxAuthorTextSearchQueryFrameBytes)
            throw new ProtocolException("Author text search query exceeds its frame limit.");
        var reader = new Reader(Aeds.Decode(frame, FrameType.AuthorTextSearchQuery));
        var query = reader.Text(WireLimits.AuthorTextSearchQueryBytes);
        reader.Finish();
        ValidateAuthorTextQuery(query);
        return query;
    }

    public static byte[] EncodeAuthorTextSearchPage(AuthorTextSearchPage value)
    {
        ValidateAuthorTextPage(value.Ready, value.More, value.Rows.Count);
        var writer = new Writer();
        writer.Bool(value.Ready);
        writer.Bool(value.More);
        writer.I32(value.Rows.Count);
        var previousId = 0;
        foreach (var row in value.Rows)
        {
            ValidateAuthorTextRow(row, previousId);
            WriteAuthorTextRow(writer, row);
            previousId = row.Id;
        }
        return Aeds.Encode(FrameType.AuthorTextSearchPage, writer.Written);
    }

    public static AuthorTextSearchPage DecodeAuthorTextSearchPage(ReadOnlySpan<byte> frame)
    {
        var reader = new Reader(Aeds.Decode(frame, FrameType.AuthorTextSearchPage));
        var ready = reader.Bool();
        var more = reader.Bool();
        var count = reader.I32();
        ValidateAuthorTextPage(ready, more, count);
        var rows = new AuthorTextSearchRow[count];
        var previousId = 0;
        for (var i = 0; i < rows.Length; i++)
        {
            var row = ReadAuthorTextRow(ref reader);
            ValidateAuthorTextRow(row, previousId);
            rows[i] = row;
            previousId = row.Id;
        }
        reader.Finish();
        return new(ready, more, rows);
    }

    public static byte[] EncodeAuthorTextRankedQuery(AuthorTextRankedQuery value) =>
        EncodeAuthorTextCursorQuery(value, FrameType.AuthorTextRankedQuery);

    public static AuthorTextRankedQuery DecodeAuthorTextRankedQuery(ReadOnlySpan<byte> frame) =>
        DecodeAuthorTextCursorQuery(frame, FrameType.AuthorTextRankedQuery);

    public static byte[] EncodeAuthorTextFacetedQuery(AuthorTextRankedQuery value) =>
        EncodeAuthorTextCursorQuery(value, FrameType.AuthorTextFacetedQuery);

    public static AuthorTextRankedQuery DecodeAuthorTextFacetedQuery(ReadOnlySpan<byte> frame) =>
        DecodeAuthorTextCursorQuery(frame, FrameType.AuthorTextFacetedQuery);

    private static byte[] EncodeAuthorTextCursorQuery(AuthorTextRankedQuery value, FrameType type)
    {
        ValidateAuthorTextQuery(value.Query);
        ValidateAuthorTextCursor(value.Cursor);
        var writer = new Writer();
        writer.Text(value.Query, WireLimits.AuthorTextSearchQueryBytes);
        writer.Text(value.Cursor, WireLimits.AuthorTextRankedCursorChars);
        return Aeds.Encode(type, writer.Written);
    }

    private static AuthorTextRankedQuery DecodeAuthorTextCursorQuery(ReadOnlySpan<byte> frame, FrameType type)
    {
        if (frame.Length > WireLimits.MaxAuthorTextRankedQueryFrameBytes)
            throw new ProtocolException("Author text search query exceeds its frame limit.");
        var reader = new Reader(Aeds.Decode(frame, type));
        var query = reader.Text(WireLimits.AuthorTextSearchQueryBytes);
        var cursor = reader.Text(WireLimits.AuthorTextRankedCursorChars);
        reader.Finish();
        ValidateAuthorTextQuery(query);
        ValidateAuthorTextCursor(cursor);
        return new(query, cursor);
    }

    public static byte[] EncodeAuthorTextRankedPage(AuthorTextRankedPage value)
    {
        ValidateAuthorTextCursor(value.NextCursor);
        ValidateAuthorTextPage(value.Ready, value.NextCursor.Length != 0, value.Rows.Count);
        var writer = new Writer();
        writer.Bool(value.Ready);
        writer.Text(value.NextCursor, WireLimits.AuthorTextRankedCursorChars);
        WriteAuthorTextRankedRows(writer, value.Rows);
        return Aeds.Encode(FrameType.AuthorTextRankedPage, writer.Written);
    }

    public static AuthorTextRankedPage DecodeAuthorTextRankedPage(ReadOnlySpan<byte> frame)
    {
        var reader = new Reader(Aeds.Decode(frame, FrameType.AuthorTextRankedPage));
        var ready = reader.Bool();
        var next = reader.Text(WireLimits.AuthorTextRankedCursorChars);
        var count = reader.I32();
        ValidateAuthorTextCursor(next);
        ValidateAuthorTextPage(ready, next.Length != 0, count);
        var rows = ReadAuthorTextRankedRows(ref reader, count);
        reader.Finish();
        return new(ready, next, rows);
    }

    public static byte[] EncodeAuthorTextFacetedPage(AuthorTextFacetedPage page)
    {
        ValidateAuthorTextFacetedPage(page.Ready, page.NextCursor, page.Total, page.StateCounts, page.Rows.Count);
        var writer = new Writer();
        writer.Bool(page.Ready);
        writer.Text(page.NextCursor, WireLimits.AuthorTextRankedCursorChars);
        writer.I32(page.Total);
        foreach (var count in page.StateCounts) writer.I32(count);
        WriteAuthorTextFacets(writer, page.MoreCategories, page.Categories, page.Total);
        WriteAuthorTextFacets(writer, page.MoreTags, page.Tags, page.Total);
        WriteAuthorTextRankedRows(writer, page.Rows);
        return Aeds.Encode(FrameType.AuthorTextFacetedPage, writer.Written);
    }

    public static AuthorTextFacetedPage DecodeAuthorTextFacetedPage(ReadOnlySpan<byte> frame)
    {
        var reader = new Reader(Aeds.Decode(frame, FrameType.AuthorTextFacetedPage));
        var ready = reader.Bool();
        var next = reader.Text(WireLimits.AuthorTextRankedCursorChars);
        var total = reader.I32();
        var states = new int[WireLimits.AuthorTextSearchStateCount];
        for (var i = 0; i < states.Length; i++) states[i] = reader.I32();
        var moreCategories = reader.Bool();
        var categories = ReadAuthorTextFacets(ref reader, moreCategories, total);
        var moreTags = reader.Bool();
        var tags = ReadAuthorTextFacets(ref reader, moreTags, total);
        var count = reader.I32();
        ValidateAuthorTextFacetedPage(ready, next, total, states, count);
        var rows = ReadAuthorTextRankedRows(ref reader, count);
        reader.Finish();
        return new(ready, next, total, states, moreCategories, categories, moreTags, tags, rows);
    }

    private static void ValidateAuthorTextFacetedPage(bool ready, string next, int total, IReadOnlyList<int> states, int rows)
    {
        ValidateAuthorTextCursor(next);
        ValidateAuthorTextPage(ready, next.Length != 0, rows);
        if (total < rows || (!ready && total != 0) || (next.Length != 0 && total <= WireLimits.AuthorTextSearchRows) ||
            states.Count != WireLimits.AuthorTextSearchStateCount || states.Any(count => count < 0) ||
            states.Sum(count => (long)count) != total)
            throw new ProtocolException("Invalid faceted author text search page.");
    }

    private static void WriteAuthorTextFacets(Writer writer, bool more, IReadOnlyList<AuthorTextTaxonomyFacet> facets, int total)
    {
        ValidateAuthorTextFacetCount(more, facets.Count);
        ValidateAuthorTextFacets(facets, total);
        writer.Bool(more);
        writer.I32(facets.Count);
        foreach (var facet in facets)
        {
            writer.I32(facet.Id);
            writer.Text(facet.Name, WireLimits.TaxonomyNameBytes);
            writer.I32(facet.Count);
        }
    }

    private static AuthorTextTaxonomyFacet[] ReadAuthorTextFacets(ref Reader reader, bool more, int total)
    {
        var count = reader.I32();
        ValidateAuthorTextFacetCount(more, count);
        var facets = new AuthorTextTaxonomyFacet[count];
        for (var i = 0; i < facets.Length; i++)
            facets[i] = new(reader.I32(), reader.Text(WireLimits.TaxonomyNameBytes), reader.I32());
        ValidateAuthorTextFacets(facets, total);
        return facets;
    }

    private static void ValidateAuthorTextFacetCount(bool more, int count)
    {
        if (count is < 0 or > WireLimits.AuthorTextSearchFacetRows || (more && count != WireLimits.AuthorTextSearchFacetRows))
            throw new ProtocolException("Invalid author text search facet count.");
    }

    private static void ValidateAuthorTextFacets(IReadOnlyList<AuthorTextTaxonomyFacet> facets, int total)
    {
        var ids = new HashSet<int>();
        AuthorTextTaxonomyFacet? previous = null;
        foreach (var facet in facets)
        {
            if (facet.Id <= 0 || facet.Count <= 0 || facet.Count > total || !ids.Add(facet.Id) ||
                facet.Name.Length == 0 || facet.Name.Contains('\0') || AuthorTextByteCount(facet.Name) > WireLimits.TaxonomyNameBytes ||
                (previous is not null && (facet.Count > previous.Count || (facet.Count == previous.Count && facet.Id <= previous.Id))))
                throw new ProtocolException("Invalid author text search facet.");
            previous = facet;
        }
    }

    private static void WriteAuthorTextRankedRows(Writer writer, IReadOnlyList<AuthorTextSearchRow> rows)
    {
        writer.I32(rows.Count);
        var ids = new HashSet<int>();
        foreach (var row in rows)
        {
            ValidateAuthorTextRankedRow(row, ids);
            WriteAuthorTextRow(writer, row);
        }
    }

    private static AuthorTextSearchRow[] ReadAuthorTextRankedRows(ref Reader reader, int count)
    {
        var rows = new AuthorTextSearchRow[count];
        var ids = new HashSet<int>();
        for (var i = 0; i < rows.Length; i++)
        {
            var row = ReadAuthorTextRow(ref reader);
            ValidateAuthorTextRankedRow(row, ids);
            rows[i] = row;
        }
        return rows;
    }

    private static void WriteAuthorTextRow(Writer writer, AuthorTextSearchRow row)
    {
        writer.I32(row.Id);
        writer.I64(row.Revision);
        writer.Text(row.Title, WireLimits.TitleBytes);
        writer.I32(row.Field);
        writer.Text(row.Snippet, WireLimits.AuthorTextSearchSnippetBytes);
        writer.I32(row.HighlightStart);
        writer.I32(row.HighlightEnd);
        writer.I32(row.SourceStart);
        writer.I32(row.SourceEnd);
        writer.I32(row.SourceByteStart);
        writer.I32(row.SourceByteEnd);
        writer.FixedBytes(row.SourceDigest);
    }

    private static AuthorTextSearchRow ReadAuthorTextRow(ref Reader reader) =>
        new(reader.I32(), reader.I64(), reader.Text(WireLimits.TitleBytes), reader.I32(),
            reader.Text(WireLimits.AuthorTextSearchSnippetBytes), reader.I32(), reader.I32(), reader.I32(), reader.I32(),
            reader.I32(), reader.I32(), reader.FixedBytes(WireLimits.AuthorTextSearchSourceDigestBytes).ToArray());

    private static void ValidateAuthorTextCursor(string cursor)
    {
        if (cursor.Length > WireLimits.AuthorTextRankedCursorChars ||
            cursor.Any(character => !char.IsAsciiLetterOrDigit(character) && character is not '-' and not '_'))
            throw new ProtocolException("Invalid author text search cursor.");
    }

    private static void ValidateAuthorTextRankedRow(AuthorTextSearchRow row, HashSet<int> ids)
    {
        ValidateAuthorTextRow(row, previousId: 0);
        if (!ids.Add(row.Id)) throw new ProtocolException("Invalid author text search row.");
    }

    private static void ValidateAuthorTextQuery(string query)
    {
        if (query.Length > WireLimits.AuthorTextSearchQueryChars ||
            AuthorTextByteCount(query) > WireLimits.AuthorTextSearchQueryBytes)
            throw new ProtocolException("Author text search query exceeds its text limit.");
    }

    private static void ValidateAuthorTextPage(bool ready, bool more, int count)
    {
        if (count is < 0 or > WireLimits.AuthorTextSearchRows || (!ready && (more || count != 0)) ||
            (more && count != WireLimits.AuthorTextSearchRows))
            throw new ProtocolException("Invalid author text search page.");
    }

    private static void ValidateAuthorTextRow(AuthorTextSearchRow row, int previousId)
    {
        var sourceLimit = row.Field == 1 ? WireLimits.TitleBytes : WireLimits.BodyBytes;
        if (row.Id <= 0 || row.Revision <= 0 || (previousId != 0 && row.Id >= previousId) || row.Field is < 1 or > 2 ||
            AuthorTextByteCount(row.Title) > WireLimits.TitleBytes || AuthorTextByteCount(row.Snippet) > WireLimits.AuthorTextSearchSnippetBytes ||
            row.HighlightStart < 0 || row.HighlightEnd <= row.HighlightStart || row.HighlightEnd > row.Snippet.Length ||
            char.IsLowSurrogate(row.Snippet[row.HighlightStart]) ||
            (row.HighlightEnd != row.Snippet.Length && char.IsLowSurrogate(row.Snippet[row.HighlightEnd])) ||
            row.SourceStart < 0 || row.SourceEnd <= row.SourceStart || row.SourceEnd > sourceLimit ||
            row.SourceByteStart < row.SourceStart || row.SourceByteEnd <= row.SourceByteStart || row.SourceByteEnd > sourceLimit ||
            row.SourceEnd - row.SourceStart != row.HighlightEnd - row.HighlightStart ||
            row.SourceByteEnd - row.SourceByteStart != AuthorTextByteCount(row.Snippet.AsSpan(row.HighlightStart, row.HighlightEnd - row.HighlightStart)) ||
            row.SourceDigest.Length != WireLimits.AuthorTextSearchSourceDigestBytes)
            throw new ProtocolException("Invalid author text search row.");
    }

    private static int AuthorTextByteCount(ReadOnlySpan<char> value)
    {
        try { return Utf8.GetByteCount(value); }
        catch (EncoderFallbackException) { throw new ProtocolException("Invalid author text search Unicode."); }
    }
}
