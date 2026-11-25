namespace FsusBlog.V2.Contracts;

public sealed record AuthorTextSearchRow(int Id, long Revision, string Title, int Field, string Snippet,
    int HighlightStart, int HighlightEnd, int SourceStart, int SourceEnd, int SourceByteStart, int SourceByteEnd,
    byte[] SourceDigest);
public sealed record AuthorTextSearchPage(bool Ready, bool More, IReadOnlyList<AuthorTextSearchRow> Rows);
public sealed record AuthorTextRankedQuery(string Query, string Cursor);
public sealed record AuthorTextQualifiedQuery(string Query, string Cursor, long? UpdatedFromUnixMs, long? UpdatedUntilUnixMs,
    long SchemaRevision, IReadOnlyList<PropertyCondition> Conditions);
public sealed record AuthorTextRankedPage(bool Ready, string NextCursor, IReadOnlyList<AuthorTextSearchRow> Rows);
public sealed record AuthorTextTaxonomyFacet(int Id, string Name, int Count);
public sealed record AuthorTextFacetedPage(bool Ready, string NextCursor, int Total, IReadOnlyList<int> StateCounts,
    bool MoreCategories, IReadOnlyList<AuthorTextTaxonomyFacet> Categories, bool MoreTags, IReadOnlyList<AuthorTextTaxonomyFacet> Tags,
    IReadOnlyList<AuthorTextSearchRow> Rows);

public sealed record AuthorTextPropertyFacetQuery(AuthorTextQualifiedQuery Search, bool IncludeHeading, Guid DefinitionId,
    long DefinitionRevision);
public sealed record AuthorTextPropertyFacetPage(AuthorTextFacetedPage Search, AuthorTextPropertyFacet? Facet);
public sealed record AuthorTextPropertyFacet(Guid DefinitionId, long DefinitionRevision, PropertyFieldKind Kind,
    int Missing, int Null, int Empty, IReadOnlyList<AuthorTextPropertyFacetBucket> Buckets);
public sealed record AuthorTextPropertyFacetBucket(PropertyFieldValue Value, int Count);

public enum AuthorTextPropertySortDirection { Ascending = 0, Descending = 1 }
public sealed record AuthorTextPropertyFacetSelector(Guid DefinitionId, long DefinitionRevision);
public sealed record AuthorTextPropertySortSelector(Guid DefinitionId, long DefinitionRevision, AuthorTextPropertySortDirection Direction);
public sealed record AuthorTextPropertySortQuery(AuthorTextQualifiedQuery Search, bool IncludeHeading, Guid DefinitionId,
    long DefinitionRevision, AuthorTextPropertySortDirection Direction, AuthorTextPropertyFacetSelector? Facet);
public sealed record AuthorTextPropertySortPage(AuthorTextFacetedPage Search, AuthorTextPropertyFacet? Facet);

public sealed record AuthorTextPropertyTextQuery(AuthorTextQualifiedQuery Search, Guid DefinitionId, long DefinitionRevision);
public sealed record AuthorTextPropertyTextQualifiedQuery(AuthorTextQualifiedQuery Search, Guid DefinitionId, long DefinitionRevision,
    AuthorTextPropertyFacetSelector? Facet, AuthorTextPropertySortSelector? Sort);
public sealed record AuthorTextPropertyTextMixedQuery(AuthorTextQualifiedQuery Search, Guid DefinitionId, long DefinitionRevision,
    bool IncludeHeading, AuthorTextPropertyFacetSelector? Facet, AuthorTextPropertySortSelector? Sort);

public static partial class Wire
{
    private static ProtocolException AuthorTextFrameLimit() => new("Author text search query exceeds its frame limit.");

    public static byte[] EncodeAuthorTextSearchQuery(string value) =>
        EncodeRecord(FrameType.AuthorTextSearchQuery, value, ValidateAuthorTextQuery,
            static (writer, query) => writer.Text(query, AuthorTextSearchQueryBytes));

    public static string DecodeAuthorTextSearchQuery(ReadOnlySpan<byte> frame) =>
        DecodeRecord<string>(FrameType.AuthorTextSearchQuery, frame, MaxAuthorTextSearchQueryFrameBytes,
            AuthorTextFrameLimit, static (ref Reader reader) => reader.Text(AuthorTextSearchQueryBytes), ValidateAuthorTextQuery);

    public static byte[] EncodeAuthorTextSearchPage(AuthorTextSearchPage value)
    {
        ValidateAuthorTextPage(value.Ready, value.More, value.Rows.Count);
        return EncodeFrame(FrameType.AuthorTextSearchPage, writer =>
        {
            var previousId = 0;
            writer.Bool(value.Ready).Bool(value.More).Items(value.Rows, (w, row) =>
            {
                ValidateAuthorTextRow(row, previousId);
                WriteAuthorTextRow(w, row);
                previousId = row.Id;
            });
        });
    }

    public static AuthorTextSearchPage DecodeAuthorTextSearchPage(ReadOnlySpan<byte> frame) =>
        DecodeFrame(FrameType.AuthorTextSearchPage, frame, static (ref Reader reader) =>
        {
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
            return new AuthorTextSearchPage(ready, more, rows);
        });

    public static byte[] EncodeAuthorTextRankedQuery(AuthorTextRankedQuery value) => EncodeAuthorTextCursorQuery(value, FrameType.AuthorTextRankedQuery);
    public static AuthorTextRankedQuery DecodeAuthorTextRankedQuery(ReadOnlySpan<byte> frame) => DecodeAuthorTextCursorQuery(frame, FrameType.AuthorTextRankedQuery);
    public static byte[] EncodeAuthorTextFacetedQuery(AuthorTextRankedQuery value) => EncodeAuthorTextCursorQuery(value, FrameType.AuthorTextFacetedQuery);
    public static AuthorTextRankedQuery DecodeAuthorTextFacetedQuery(ReadOnlySpan<byte> frame) => DecodeAuthorTextCursorQuery(frame, FrameType.AuthorTextFacetedQuery);
    public static byte[] EncodeAuthorTextQualifiedQuery(AuthorTextQualifiedQuery value) => EncodeAuthorTextQualifiedQuery(value, FrameType.AuthorTextQualifiedQuery);
    public static AuthorTextQualifiedQuery DecodeAuthorTextQualifiedQuery(ReadOnlySpan<byte> frame) => DecodeAuthorTextQualifiedQuery(frame, FrameType.AuthorTextQualifiedQuery);
    public static byte[] EncodeAuthorTextSummaryQuery(AuthorTextQualifiedQuery value) => EncodeAuthorTextQualifiedQuery(value, FrameType.AuthorTextSummaryQuery);
    public static AuthorTextQualifiedQuery DecodeAuthorTextSummaryQuery(ReadOnlySpan<byte> frame) => DecodeAuthorTextQualifiedQuery(frame, FrameType.AuthorTextSummaryQuery);
    public static byte[] EncodeAuthorTextHeadingQuery(AuthorTextQualifiedQuery value) => EncodeAuthorTextQualifiedQuery(value, FrameType.AuthorTextHeadingQuery);
    public static AuthorTextQualifiedQuery DecodeAuthorTextHeadingQuery(ReadOnlySpan<byte> frame) => DecodeAuthorTextQualifiedQuery(frame, FrameType.AuthorTextHeadingQuery);

    private static byte[] EncodeAuthorTextQualifiedQuery(AuthorTextQualifiedQuery value, FrameType type)
    {
        ValidateAuthorTextQualifiedQuery(value, requireQualifier: type == FrameType.AuthorTextQualifiedQuery);
        return EncodeFrame(type, writer => WriteAuthorTextQualifiedQuery(writer, value));
    }

    private static void WriteAuthorTextQualifiedQuery(Writer writer, AuthorTextQualifiedQuery value)
    {
        writer.Text(value.Query, AuthorTextSearchQueryBytes).Text(value.Cursor, AuthorTextRankedCursorChars)
            .Optional(value.UpdatedFromUnixMs, static (w, from) => w.I64(from))
            .Optional(value.UpdatedUntilUnixMs, static (w, until) => w.I64(until))
            .I64(value.SchemaRevision);
        WritePropertyConditions(writer, value.Conditions);
    }

    private static AuthorTextQualifiedQuery DecodeAuthorTextQualifiedQuery(ReadOnlySpan<byte> frame, FrameType type) =>
        DecodeRecord<AuthorTextQualifiedQuery>(type, frame, MaxAuthorTextQualifiedQueryFrameBytes, AuthorTextFrameLimit,
            ReadAuthorTextQualifiedQuery, value => ValidateAuthorTextQualifiedQuery(value, requireQualifier: type == FrameType.AuthorTextQualifiedQuery));

    private static AuthorTextQualifiedQuery ReadAuthorTextQualifiedQuery(ref Reader reader) =>
        new(reader.Text(AuthorTextSearchQueryBytes), reader.Text(AuthorTextRankedCursorChars),
            reader.OptionalValue(static (ref Reader r) => r.I64()),
            reader.OptionalValue(static (ref Reader r) => r.I64()),
            reader.I64(), ReadPropertyConditions(ref reader, allowEmpty: true));

    private static void ValidateAuthorTextQualifiedQuery(AuthorTextQualifiedQuery value, bool requireQualifier,
        bool propertyFacet = false)
    {
        ValidateAuthorTextQuery(value.Query);
        ValidateAuthorTextCursor(value.Cursor);
        var conditionSchema = propertyFacet && value.Conditions.Count == 0 ? 0 : value.SchemaRevision;
        ValidatePropertyConditions(conditionSchema, value.Conditions, allowEmpty: true);
        if (value.UpdatedFromUnixMs is { } from && !IsValidUnixMs(from) ||
            value.UpdatedUntilUnixMs is { } until && !IsValidUnixMs(until) ||
            value.UpdatedFromUnixMs >= value.UpdatedUntilUnixMs ||
            (requireQualifier && value.UpdatedFromUnixMs is null && value.UpdatedUntilUnixMs is null && value.Conditions.Count == 0))
            throw new ProtocolException("Invalid qualified author text search.");
    }

    private static byte[] EncodeAuthorTextCursorQuery(AuthorTextRankedQuery value, FrameType type)
    {
        ValidateAuthorTextQuery(value.Query);
        ValidateAuthorTextCursor(value.Cursor);
        return EncodeFrame(type, writer => writer.Text(value.Query, AuthorTextSearchQueryBytes).Text(value.Cursor, AuthorTextRankedCursorChars));
    }

    private static AuthorTextRankedQuery DecodeAuthorTextCursorQuery(ReadOnlySpan<byte> frame, FrameType type)
    {
        var value = DecodeFrame(type, frame, MaxAuthorTextRankedQueryFrameBytes, AuthorTextFrameLimit,
            static (ref Reader reader) => new AuthorTextRankedQuery(reader.Text(AuthorTextSearchQueryBytes),
                reader.Text(AuthorTextRankedCursorChars)));
        ValidateAuthorTextQuery(value.Query);
        ValidateAuthorTextCursor(value.Cursor);
        return value;
    }

    public static byte[] EncodeAuthorTextRankedPage(AuthorTextRankedPage value)
    {
        ValidateAuthorTextCursor(value.NextCursor);
        ValidateAuthorTextPage(value.Ready, value.NextCursor.Length != 0, value.Rows.Count);
        return EncodeFrame(FrameType.AuthorTextRankedPage, writer =>
        {
            writer.Bool(value.Ready).Text(value.NextCursor, AuthorTextRankedCursorChars);
            WriteAuthorTextRankedRows(writer, value.Rows);
        });
    }

    public static AuthorTextRankedPage DecodeAuthorTextRankedPage(ReadOnlySpan<byte> frame) =>
        DecodeFrame(FrameType.AuthorTextRankedPage, frame, static (ref Reader reader) =>
        {
            var ready = reader.Bool();
            var next = reader.Text(AuthorTextRankedCursorChars);
            var count = reader.I32();
            ValidateAuthorTextCursor(next);
            ValidateAuthorTextPage(ready, next.Length != 0, count);
            return new AuthorTextRankedPage(ready, next, ReadAuthorTextRankedRows(ref reader, count));
        });

    public static byte[] EncodeAuthorTextFacetedPage(AuthorTextFacetedPage page) => EncodeAuthorTextFacetedPage(page, FrameType.AuthorTextFacetedPage);
    public static AuthorTextFacetedPage DecodeAuthorTextFacetedPage(ReadOnlySpan<byte> frame) => DecodeAuthorTextFacetedPage(frame, FrameType.AuthorTextFacetedPage);
    public static byte[] EncodeAuthorTextSummaryPage(AuthorTextFacetedPage page) => EncodeAuthorTextFacetedPage(page, FrameType.AuthorTextSummaryPage);
    public static AuthorTextFacetedPage DecodeAuthorTextSummaryPage(ReadOnlySpan<byte> frame) => DecodeAuthorTextFacetedPage(frame, FrameType.AuthorTextSummaryPage);
    public static byte[] EncodeAuthorTextHeadingPage(AuthorTextFacetedPage page) => EncodeAuthorTextFacetedPage(page, FrameType.AuthorTextHeadingPage);
    public static AuthorTextFacetedPage DecodeAuthorTextHeadingPage(ReadOnlySpan<byte> frame) => DecodeAuthorTextFacetedPage(frame, FrameType.AuthorTextHeadingPage);

    private static int AuthorTextMaxField(FrameType type) => type switch
    {
        FrameType.AuthorTextPropertyTextPage or FrameType.AuthorTextPropertyTextQualifiedPage or FrameType.AuthorTextPropertyTextMixedPage => 5,
        FrameType.AuthorTextHeadingPage => 4,
        FrameType.AuthorTextSummaryPage => 3,
        _ => 2,
    };

    private static byte[] EncodeAuthorTextFacetedPage(AuthorTextFacetedPage page, FrameType type) =>
        EncodeFrame(type, writer => WriteAuthorTextFacetedPage(writer, page, AuthorTextMaxField(type)));

    private static void WriteAuthorTextFacetedPage(Writer writer, AuthorTextFacetedPage page, int maxField)
    {
        ValidateAuthorTextFacetedPage(page.Ready, page.NextCursor, page.Total, page.StateCounts, page.Rows.Count);
        writer.Bool(page.Ready).Text(page.NextCursor, AuthorTextRankedCursorChars).I32(page.Total);
        foreach (var count in page.StateCounts) writer.I32(count);
        WriteAuthorTextFacets(writer, page.MoreCategories, page.Categories, page.Total);
        WriteAuthorTextFacets(writer, page.MoreTags, page.Tags, page.Total);
        WriteAuthorTextRankedRows(writer, page.Rows, maxField);
    }

    private static AuthorTextFacetedPage DecodeAuthorTextFacetedPage(ReadOnlySpan<byte> frame, FrameType type) =>
        DecodeFrame(type, frame, (ref Reader reader) => ReadAuthorTextFacetedPage(ref reader, AuthorTextMaxField(type)));

    private static AuthorTextFacetedPage ReadAuthorTextFacetedPage(ref Reader reader, int maxField)
    {
        var ready = reader.Bool();
        var next = reader.Text(AuthorTextRankedCursorChars);
        var total = reader.I32();
        var states = new int[AuthorTextSearchStateCount];
        for (var i = 0; i < states.Length; i++) states[i] = reader.I32();
        var moreCategories = reader.Bool();
        var categories = ReadAuthorTextFacets(ref reader, moreCategories, total);
        var moreTags = reader.Bool();
        var tags = ReadAuthorTextFacets(ref reader, moreTags, total);
        var count = reader.I32();
        ValidateAuthorTextFacetedPage(ready, next, total, states, count);
        return new(ready, next, total, states, moreCategories, categories, moreTags, tags,
            ReadAuthorTextRankedRows(ref reader, count, maxField));
    }

    private static void ValidateAuthorTextFacetedPage(bool ready, string next, int total, IReadOnlyList<int> states, int rows)
    {
        ValidateAuthorTextCursor(next);
        ValidateAuthorTextPage(ready, next.Length != 0, rows);
        Check(total >= rows && (ready || total == 0) && (next.Length == 0 || total > AuthorTextSearchRows) &&
            states.Count == AuthorTextSearchStateCount && states.All(count => count >= 0) &&
            states.Sum(count => (long)count) == total, "Invalid faceted author text search page.");
    }

    private static void WriteAuthorTextFacets(Writer writer, bool more, IReadOnlyList<AuthorTextTaxonomyFacet> facets, int total)
    {
        ValidateAuthorTextFacetCount(more, facets.Count);
        ValidateAuthorTextFacets(facets, total);
        writer.Bool(more).Items(facets, static (w, facet) => w.I32(facet.Id).Text(facet.Name, TaxonomyNameBytes).I32(facet.Count));
    }

    private static AuthorTextTaxonomyFacet[] ReadAuthorTextFacets(ref Reader reader, bool more, int total)
    {
        var count = reader.I32();
        ValidateAuthorTextFacetCount(more, count);
        var facets = new AuthorTextTaxonomyFacet[count];
        for (var i = 0; i < facets.Length; i++) facets[i] = new(reader.I32(), reader.Text(TaxonomyNameBytes), reader.I32());
        ValidateAuthorTextFacets(facets, total);
        return facets;
    }

    private static void ValidateAuthorTextFacetCount(bool more, int count) =>
        Check(count is >= 0 and <= AuthorTextSearchFacetRows && (!more || count == AuthorTextSearchFacetRows),
            "Invalid author text search facet count.");

    private static void ValidateAuthorTextFacets(IReadOnlyList<AuthorTextTaxonomyFacet> facets, int total)
    {
        var ids = new HashSet<int>();
        AuthorTextTaxonomyFacet? previous = null;
        foreach (var facet in facets)
        {
            Check(facet.Id > 0 && facet.Count > 0 && facet.Count <= total && ids.Add(facet.Id) &&
                facet.Name.Length != 0 && !facet.Name.Contains('\0') && AuthorTextByteCount(facet.Name) <= TaxonomyNameBytes &&
                (previous is null || facet.Count < previous.Count || (facet.Count == previous.Count && facet.Id > previous.Id)),
                "Invalid author text search facet.");
            previous = facet;
        }
    }

    private static void WriteAuthorTextRankedRows(Writer writer, IReadOnlyList<AuthorTextSearchRow> rows, int maxField = 2)
    {
        var ids = new HashSet<int>();
        writer.Items(rows, (w, row) => { ValidateAuthorTextRankedRow(row, ids, maxField); WriteAuthorTextRow(w, row); });
    }

    private static AuthorTextSearchRow[] ReadAuthorTextRankedRows(ref Reader reader, int count, int maxField = 2)
    {
        var rows = new AuthorTextSearchRow[count];
        var ids = new HashSet<int>();
        for (var i = 0; i < rows.Length; i++) ValidateAuthorTextRankedRow(rows[i] = ReadAuthorTextRow(ref reader), ids, maxField);
        return rows;
    }

    private static void WriteAuthorTextRow(Writer writer, AuthorTextSearchRow row) =>
        writer.I32(row.Id).I64(row.Revision).Text(row.Title, TitleBytes).I32(row.Field)
            .Text(row.Snippet, AuthorTextSearchSnippetBytes).I32(row.HighlightStart).I32(row.HighlightEnd)
            .I32(row.SourceStart).I32(row.SourceEnd).I32(row.SourceByteStart).I32(row.SourceByteEnd)
            .FixedBytes(row.SourceDigest);

    private static AuthorTextSearchRow ReadAuthorTextRow(ref Reader reader) =>
        new(reader.I32(), reader.I64(), reader.Text(TitleBytes), reader.I32(),
            reader.Text(AuthorTextSearchSnippetBytes), reader.I32(), reader.I32(), reader.I32(), reader.I32(),
            reader.I32(), reader.I32(), reader.FixedBytes(AuthorTextSearchSourceDigestBytes).ToArray());

    private static void ValidateAuthorTextCursor(string cursor) =>
        Check(cursor.Length <= AuthorTextRankedCursorChars && IsBase64Url(cursor), "Invalid author text search cursor.");

    private static void ValidateAuthorTextRankedRow(AuthorTextSearchRow row, HashSet<int> ids, int maxField)
    {
        ValidateAuthorTextRow(row, previousId: 0, maxField: maxField);
        Check(ids.Add(row.Id), "Invalid author text search row.");
    }

    private static void ValidateAuthorTextQuery(string query) =>
        Check(query.Length <= AuthorTextSearchQueryChars && AuthorTextByteCount(query) <= AuthorTextSearchQueryBytes,
            "Author text search query exceeds its text limit.");

    private static void ValidateAuthorTextPage(bool ready, bool more, int count) =>
        Check(count is >= 0 and <= AuthorTextSearchRows && (ready || (!more && count == 0)) &&
            (!more || count == AuthorTextSearchRows), "Invalid author text search page.");

    private static void ValidateAuthorTextRow(AuthorTextSearchRow row, int previousId, int maxField = 2)
    {
        var (sourceChars, sourceBytes) = row.Field switch
        {
            1 => (TitleBytes, TitleBytes),
            2 or 4 => (BodyBytes, BodyBytes),
            3 => (ArticleSummaryReadChars, ArticleSummaryReadBytes),
            5 => (AuthorTextPropertyTextSourceChars, PropertyValueBytes),
            _ => throw new ProtocolException("Invalid author text search row."),
        };
        if (row.Field > maxField || row.Id <= 0 || row.Revision <= 0 || (previousId != 0 && row.Id >= previousId) ||
            (row.Field == 3 && row.Snippet.Length > sourceChars) ||
            AuthorTextByteCount(row.Title) > TitleBytes || AuthorTextByteCount(row.Snippet) > AuthorTextSearchSnippetBytes ||
            row.HighlightStart < 0 || row.HighlightEnd <= row.HighlightStart || row.HighlightEnd > row.Snippet.Length ||
            char.IsLowSurrogate(row.Snippet[row.HighlightStart]) ||
            (row.HighlightEnd != row.Snippet.Length && char.IsLowSurrogate(row.Snippet[row.HighlightEnd])) ||
            row.SourceStart < 0 || row.SourceEnd <= row.SourceStart || row.SourceEnd > sourceChars ||
            row.SourceByteStart < row.SourceStart || row.SourceByteEnd <= row.SourceByteStart || row.SourceByteEnd > sourceBytes ||
            row.SourceEnd - row.SourceStart != row.HighlightEnd - row.HighlightStart ||
            row.SourceByteEnd - row.SourceByteStart != AuthorTextByteCount(row.Snippet.AsSpan(row.HighlightStart, row.HighlightEnd - row.HighlightStart)) ||
            row.SourceDigest.Length != AuthorTextSearchSourceDigestBytes)
            throw new ProtocolException("Invalid author text search row.");
    }

    private static int AuthorTextByteCount(ReadOnlySpan<char> value)
    {
        try { return Utf8.GetByteCount(value); }
        catch (EncoderFallbackException) { throw new ProtocolException("Invalid author text search Unicode."); }
    }

    public static byte[] EncodeAuthorTextPropertyFacetQuery(AuthorTextPropertyFacetQuery value)
    {
        ValidateAuthorTextPropertyFacetQuery(value);
        return EncodeFrame(FrameType.AuthorTextPropertyFacetQuery, writer =>
        {
            WriteAuthorTextQualifiedQuery(writer, value.Search);
            writer.Bool(value.IncludeHeading).Uuid(value.DefinitionId).I64(value.DefinitionRevision);
        });
    }

    public static AuthorTextPropertyFacetQuery DecodeAuthorTextPropertyFacetQuery(ReadOnlySpan<byte> frame) =>
        DecodeRecord<AuthorTextPropertyFacetQuery>(FrameType.AuthorTextPropertyFacetQuery, frame, MaxAuthorTextPropertyFacetQueryFrameBytes,
            InvalidAuthorTextPropertyFacet, static (ref Reader reader) => new(
                ReadAuthorTextQualifiedQuery(ref reader), reader.Bool(), reader.Uuid(), reader.I64()),
            ValidateAuthorTextPropertyFacetQuery);

    public static byte[] EncodeAuthorTextPropertyFacetPage(AuthorTextPropertyFacetPage value, bool includeHeading = true)
    {
        if (value.Search.Ready != (value.Facet is not null)) throw InvalidAuthorTextPropertyFacet();
        return EncodeFrame(FrameType.AuthorTextPropertyFacetPage, writer =>
        {
            WriteAuthorTextFacetedPage(writer, value.Search, AuthorTextPropertyFacetMaxField(includeHeading));
            if (value.Facet is { } facet) WriteAuthorTextPropertyFacet(writer, facet, value.Search.Total);
        });
    }

    public static AuthorTextPropertyFacetPage DecodeAuthorTextPropertyFacetPage(ReadOnlySpan<byte> frame, bool includeHeading = true) =>
        DecodeFrame(FrameType.AuthorTextPropertyFacetPage, frame, (ref Reader reader) =>
        {
            var search = ReadAuthorTextFacetedPage(ref reader, AuthorTextPropertyFacetMaxField(includeHeading));
            return new AuthorTextPropertyFacetPage(search, search.Ready ? ReadAuthorTextPropertyFacet(ref reader, search.Total) : null);
        });

    private static void WriteAuthorTextPropertyFacet(Writer writer, AuthorTextPropertyFacet facet, int total)
    {
        ValidateAuthorTextPropertyFacet(facet, total);
        writer.Uuid(facet.DefinitionId).I64(facet.DefinitionRevision).I32((int)facet.Kind)
            .I32(facet.Missing).I32(facet.Null).I32(facet.Empty).Items(facet.Buckets, static (w, bucket) =>
            {
                switch (bucket.Value)
                {
                    case PropertyFieldValue.Boolean boolean: w.Bool(boolean.Value); break;
                    case PropertyFieldValue.SingleSelect selection: w.Uuid(selection.Value); break;
                    default: throw InvalidAuthorTextPropertyFacet();
                }
                w.I32(bucket.Count);
            });
    }

    private static AuthorTextPropertyFacet ReadAuthorTextPropertyFacet(ref Reader reader, int total)
    {
        var definitionId = reader.Uuid();
        var definitionRevision = reader.I64();
        var kind = (PropertyFieldKind)reader.I32();
        var missing = reader.I32();
        var nil = reader.I32();
        var empty = reader.I32();
        var count = reader.I32();
        var boolean = IsAuthorTextPropertyFacetBoolean(kind);
        if (!IsAuthorTextPropertyFacetBucketCountValid(boolean, count)) throw InvalidAuthorTextPropertyFacet();
        var buckets = new AuthorTextPropertyFacetBucket[count];
        for (var i = 0; i < buckets.Length; i++)
            buckets[i] = new(boolean ? new PropertyFieldValue.Boolean(reader.Bool()) : new PropertyFieldValue.SingleSelect(reader.Uuid()), reader.I32());
        var facet = new AuthorTextPropertyFacet(definitionId, definitionRevision, kind, missing, nil, empty, buckets);
        ValidateAuthorTextPropertyFacet(facet, total);
        return facet;
    }

    private static void ValidateAuthorTextPropertyFacetQuery(AuthorTextPropertyFacetQuery value)
    {
        if (!ValidPropertyDefinitionCoordinates(value.DefinitionId, value.DefinitionRevision, value.Search.SchemaRevision))
            throw InvalidAuthorTextPropertyFacet();
        ValidateAuthorTextQualifiedQuery(value.Search, requireQualifier: false, propertyFacet: true);
    }

    private static void ValidateAuthorTextPropertyFacet(AuthorTextPropertyFacet facet, int total)
    {
        var boolean = IsAuthorTextPropertyFacetBoolean(facet.Kind);
        var remaining = (long)total - facet.Missing - facet.Null - facet.Empty;
        if (facet.DefinitionId == Guid.Empty || facet.DefinitionRevision <= 0 ||
            facet.Missing < 0 || facet.Null < 0 || facet.Empty < 0 || remaining < 0 ||
            (facet.Kind != PropertyFieldKind.MultiSelect && facet.Empty != 0) ||
            !IsAuthorTextPropertyFacetBucketCountValid(boolean, facet.Buckets.Count))
            throw InvalidAuthorTextPropertyFacet();

        long sum = 0;
        var previousOption = Guid.Empty;
        for (var i = 0; i < facet.Buckets.Count; i++)
        {
            var bucket = facet.Buckets[i];
            if (bucket.Count < 0 || bucket.Count > remaining) throw InvalidAuthorTextPropertyFacet();
            if (boolean)
            {
                if (bucket.Value is not PropertyFieldValue.Boolean value || value.Value != (i == 1))
                    throw InvalidAuthorTextPropertyFacet();
            }
            else
            {
                if (bucket.Value is not PropertyFieldValue.SingleSelect value || value.Value.CompareTo(previousOption) <= 0)
                    throw InvalidAuthorTextPropertyFacet();
                previousOption = value.Value;
            }
            sum += bucket.Count;
        }
        // Deprecated options are excluded, so single-select buckets can cover only part
        // of the present values. Multiple options can belong to the same article.
        if ((boolean && sum != remaining) || (facet.Kind == PropertyFieldKind.SingleSelect && sum > remaining))
            throw InvalidAuthorTextPropertyFacet();
    }

    private static bool IsAuthorTextPropertyFacetBoolean(PropertyFieldKind kind) => kind switch
    {
        PropertyFieldKind.Boolean => true,
        PropertyFieldKind.SingleSelect or PropertyFieldKind.MultiSelect => false,
        _ => throw InvalidAuthorTextPropertyFacet(),
    };

    private static bool IsAuthorTextPropertyFacetBucketCountValid(bool boolean, int count) =>
        boolean ? count == 2 : count is >= 0 and <= PropertyOptionCount;

    private static int AuthorTextPropertyFacetMaxField(bool includeHeading) =>
        AuthorTextMaxField(includeHeading ? FrameType.AuthorTextHeadingPage : FrameType.AuthorTextSummaryPage);

    private static ProtocolException InvalidAuthorTextPropertyFacet() => new("Invalid author text property facet.");

    public static byte[] EncodeAuthorTextPropertySortQuery(AuthorTextPropertySortQuery value)
    {
        ValidateAuthorTextPropertySortQuery(value);
        return EncodeFrame(FrameType.AuthorTextPropertySortQuery, writer =>
        {
            WriteAuthorTextQualifiedQuery(writer, value.Search);
            writer.Bool(value.IncludeHeading).Uuid(value.DefinitionId).I64(value.DefinitionRevision)
                .Bool(value.Direction == AuthorTextPropertySortDirection.Descending)
                .Optional(value.Facet, WriteAuthorTextPropertyFacetSelector);
        });
    }

    public static AuthorTextPropertySortQuery DecodeAuthorTextPropertySortQuery(ReadOnlySpan<byte> frame) =>
        DecodeRecord<AuthorTextPropertySortQuery>(FrameType.AuthorTextPropertySortQuery, frame, MaxAuthorTextPropertySortQueryFrameBytes,
            InvalidAuthorTextPropertySort, static (ref Reader reader) => new(
                ReadAuthorTextQualifiedQuery(ref reader), reader.Bool(), reader.Uuid(), reader.I64(),
                ReadAuthorTextPropertySortDirection(ref reader), reader.Optional(ReadAuthorTextPropertyFacetSelector)),
            ValidateAuthorTextPropertySortQuery);

    public static byte[] EncodeAuthorTextPropertySortPage(AuthorTextPropertySortPage value, bool includeHeading = true) =>
        EncodeAuthorTextOptionalPropertyFacetPage(value, FrameType.AuthorTextPropertySortPage, AuthorTextPropertyFacetMaxField(includeHeading));

    public static AuthorTextPropertySortPage DecodeAuthorTextPropertySortPage(ReadOnlySpan<byte> frame, bool includeHeading = true,
        bool? expectFacet = null) =>
        DecodeAuthorTextOptionalPropertyFacetPage(frame, FrameType.AuthorTextPropertySortPage, AuthorTextPropertyFacetMaxField(includeHeading), expectFacet);

    private static byte[] EncodeAuthorTextOptionalPropertyFacetPage(AuthorTextPropertySortPage value, FrameType type, int maxField)
    {
        if (!value.Search.Ready && value.Facet is not null) throw InvalidAuthorTextPropertySort();
        return EncodeFrame(type, writer =>
        {
            WriteAuthorTextFacetedPage(writer, value.Search, maxField);
            if (value.Search.Ready)
                writer.Optional(value.Facet, (w, facet) => WriteAuthorTextPropertyFacet(w, facet, value.Search.Total));
        });
    }

    private static AuthorTextPropertySortPage DecodeAuthorTextOptionalPropertyFacetPage(ReadOnlySpan<byte> frame, FrameType type,
        int maxField, bool? expectFacet) =>
        DecodeFrame(type, frame, (ref Reader reader) =>
        {
            var search = ReadAuthorTextFacetedPage(ref reader, maxField);
            var facet = search.Ready && reader.Bool() ? ReadAuthorTextPropertyFacet(ref reader, search.Total) : null;
            if (search.Ready && expectFacet.HasValue && expectFacet.Value != (facet is not null))
                throw InvalidAuthorTextPropertySort();
            return new AuthorTextPropertySortPage(search, facet);
        });

    private static void ValidateAuthorTextPropertySortQuery(AuthorTextPropertySortQuery value)
    {
        var schema = value.Search.SchemaRevision;
        if (!ValidPropertyDefinitionCoordinates(value.DefinitionId, value.DefinitionRevision, schema) ||
            value.Direction is not (AuthorTextPropertySortDirection.Ascending or AuthorTextPropertySortDirection.Descending) ||
            (value.Facet is { } facet && !ValidPropertyDefinitionCoordinates(facet.DefinitionId, facet.DefinitionRevision, schema)))
            throw InvalidAuthorTextPropertySort();
        ValidateAuthorTextQualifiedQuery(value.Search, requireQualifier: false, propertyFacet: true);
    }

    private static ProtocolException InvalidAuthorTextPropertySort() => new("Invalid author text property sort.");

    public static byte[] EncodeAuthorTextPropertyTextQuery(AuthorTextPropertyTextQuery value)
    {
        ValidateAuthorTextPropertyTextSelection(value.Search, value.DefinitionId, value.DefinitionRevision);
        return EncodeFrame(FrameType.AuthorTextPropertyTextQuery,
            writer => WriteAuthorTextPropertyTextSelection(writer, value.Search, value.DefinitionId, value.DefinitionRevision));
    }

    public static AuthorTextPropertyTextQuery DecodeAuthorTextPropertyTextQuery(ReadOnlySpan<byte> frame) =>
        DecodeRecord<AuthorTextPropertyTextQuery>(FrameType.AuthorTextPropertyTextQuery, frame, MaxAuthorTextPropertyTextQueryFrameBytes,
            InvalidAuthorTextPropertyText, static (ref Reader reader) => new(
                ReadAuthorTextQualifiedQuery(ref reader), reader.Uuid(), reader.I64()),
            static value => ValidateAuthorTextPropertyTextSelection(value.Search, value.DefinitionId, value.DefinitionRevision));

    public static byte[] EncodeAuthorTextPropertyTextPage(AuthorTextFacetedPage page)
    {
        ValidateAuthorTextPropertyTextPage(page);
        return EncodeAuthorTextFacetedPage(page, FrameType.AuthorTextPropertyTextPage);
    }

    public static AuthorTextFacetedPage DecodeAuthorTextPropertyTextPage(ReadOnlySpan<byte> frame)
    {
        var page = DecodeAuthorTextFacetedPage(frame, FrameType.AuthorTextPropertyTextPage);
        ValidateAuthorTextPropertyTextPage(page);
        return page;
    }

    public static byte[] EncodeAuthorTextPropertyTextQualifiedQuery(AuthorTextPropertyTextQualifiedQuery value) =>
        EncodeRecord(FrameType.AuthorTextPropertyTextQualifiedQuery, value, ValidateAuthorTextPropertyTextQualifiedQuery,
            static (writer, record) =>
            {
                WriteAuthorTextPropertyTextSelection(writer, record.Search, record.DefinitionId, record.DefinitionRevision);
                WriteAuthorTextPropertySelectors(writer, record.Facet, record.Sort);
            });

    public static AuthorTextPropertyTextQualifiedQuery DecodeAuthorTextPropertyTextQualifiedQuery(ReadOnlySpan<byte> frame) =>
        DecodeRecord<AuthorTextPropertyTextQualifiedQuery>(FrameType.AuthorTextPropertyTextQualifiedQuery, frame,
            MaxAuthorTextPropertyTextQualifiedQueryFrameBytes, InvalidAuthorTextPropertyText, static (ref Reader reader) =>
            {
                var (search, definition, revision) = (ReadAuthorTextQualifiedQuery(ref reader), reader.Uuid(), reader.I64());
                var (facet, sort) = ReadAuthorTextPropertySelectors(ref reader);
                return new(search, definition, revision, facet, sort);
            }, ValidateAuthorTextPropertyTextQualifiedQuery);

    public static byte[] EncodeAuthorTextPropertyTextQualifiedPage(AuthorTextPropertySortPage value)
    {
        ValidateAuthorTextPropertyTextPage(value.Search);
        const FrameType type = FrameType.AuthorTextPropertyTextQualifiedPage;
        return EncodeAuthorTextOptionalPropertyFacetPage(value, type, AuthorTextMaxField(type));
    }

    public static AuthorTextPropertySortPage DecodeAuthorTextPropertyTextQualifiedPage(ReadOnlySpan<byte> frame, bool expectFacet)
    {
        const FrameType type = FrameType.AuthorTextPropertyTextQualifiedPage;
        var value = DecodeAuthorTextOptionalPropertyFacetPage(frame, type, AuthorTextMaxField(type), expectFacet);
        ValidateAuthorTextPropertyTextPage(value.Search);
        return value;
    }

    public static byte[] EncodeAuthorTextPropertyTextMixedQuery(AuthorTextPropertyTextMixedQuery value) =>
        EncodeRecord(FrameType.AuthorTextPropertyTextMixedQuery, value, ValidateAuthorTextPropertyTextMixedQuery,
            static (writer, record) =>
            {
                WriteAuthorTextPropertyTextSelection(writer, record.Search, record.DefinitionId, record.DefinitionRevision);
                writer.Bool(record.IncludeHeading);
                WriteAuthorTextPropertySelectors(writer, record.Facet, record.Sort);
            });

    public static AuthorTextPropertyTextMixedQuery DecodeAuthorTextPropertyTextMixedQuery(ReadOnlySpan<byte> frame) =>
        DecodeRecord<AuthorTextPropertyTextMixedQuery>(FrameType.AuthorTextPropertyTextMixedQuery, frame,
            MaxAuthorTextPropertyTextMixedQueryFrameBytes, InvalidAuthorTextPropertyText, static (ref Reader reader) =>
            {
                var (search, definition, revision, includeHeading) =
                    (ReadAuthorTextQualifiedQuery(ref reader), reader.Uuid(), reader.I64(), reader.Bool());
                var (facet, sort) = ReadAuthorTextPropertySelectors(ref reader);
                return new(search, definition, revision, includeHeading, facet, sort);
            }, ValidateAuthorTextPropertyTextMixedQuery);

    private static void ValidateAuthorTextPropertyTextMixedQuery(AuthorTextPropertyTextMixedQuery value)
    {
        ValidateAuthorTextPropertyTextSelection(value.Search, value.DefinitionId, value.DefinitionRevision);
        ValidateAuthorTextPropertySelectors(value.Search.SchemaRevision, value.Facet, value.Sort);
    }

    public static byte[] EncodeAuthorTextPropertyTextMixedPage(AuthorTextPropertySortPage value, bool includeHeading)
    {
        ValidateAuthorTextPropertyTextMixedRows(value.Search, includeHeading);
        const FrameType type = FrameType.AuthorTextPropertyTextMixedPage;
        return EncodeAuthorTextOptionalPropertyFacetPage(value, type, AuthorTextMaxField(type));
    }

    public static AuthorTextPropertySortPage DecodeAuthorTextPropertyTextMixedPage(ReadOnlySpan<byte> frame, bool includeHeading,
        bool expectFacet)
    {
        const FrameType type = FrameType.AuthorTextPropertyTextMixedPage;
        var value = DecodeAuthorTextOptionalPropertyFacetPage(frame, type, AuthorTextMaxField(type), expectFacet);
        ValidateAuthorTextPropertyTextMixedRows(value.Search, includeHeading);
        return value;
    }

    private static void WriteAuthorTextPropertyFacetSelector(Writer writer, AuthorTextPropertyFacetSelector facet) =>
        writer.Uuid(facet.DefinitionId).I64(facet.DefinitionRevision);

    private static AuthorTextPropertyFacetSelector ReadAuthorTextPropertyFacetSelector(ref Reader reader) =>
        new(reader.Uuid(), reader.I64());

    private static AuthorTextPropertySortDirection ReadAuthorTextPropertySortDirection(ref Reader reader) =>
        reader.Bool() ? AuthorTextPropertySortDirection.Descending : AuthorTextPropertySortDirection.Ascending;

    private static void WriteAuthorTextPropertyTextSelection(Writer writer, AuthorTextQualifiedQuery search, Guid definition, long revision)
    {
        WriteAuthorTextQualifiedQuery(writer, search);
        writer.Uuid(definition).I64(revision);
    }

    private static void WriteAuthorTextPropertySelectors(Writer writer, AuthorTextPropertyFacetSelector? facet,
        AuthorTextPropertySortSelector? sort) =>
        writer.Optional(facet, WriteAuthorTextPropertyFacetSelector)
            .Optional(sort, static (w, s) => w.Uuid(s.DefinitionId).I64(s.DefinitionRevision)
                .Bool(s.Direction == AuthorTextPropertySortDirection.Descending));

    private static (AuthorTextPropertyFacetSelector? Facet, AuthorTextPropertySortSelector? Sort)
        ReadAuthorTextPropertySelectors(ref Reader reader) =>
        (reader.Optional(ReadAuthorTextPropertyFacetSelector),
            reader.Optional(static (ref Reader r) => new AuthorTextPropertySortSelector(r.Uuid(), r.I64(), ReadAuthorTextPropertySortDirection(ref r))));

    private static void ValidateAuthorTextPropertyTextSelection(AuthorTextQualifiedQuery search, Guid definition, long revision)
    {
        Check(ValidPropertyDefinitionCoordinates(definition, revision, search.SchemaRevision), InvalidAuthorTextPropertyText);
        ValidateAuthorTextQualifiedQuery(search, requireQualifier: false, propertyFacet: true);
    }

    private static void ValidateAuthorTextPropertyTextQualifiedQuery(AuthorTextPropertyTextQualifiedQuery value)
    {
        ValidateAuthorTextPropertyTextSelection(value.Search, value.DefinitionId, value.DefinitionRevision);
        Check(value.Facet is not null || value.Sort is not null, InvalidAuthorTextPropertyText);
        ValidateAuthorTextPropertySelectors(value.Search.SchemaRevision, value.Facet, value.Sort);
    }

    private static void ValidateAuthorTextPropertySelectors(long schema, AuthorTextPropertyFacetSelector? facet,
        AuthorTextPropertySortSelector? sort) =>
        Check((facet is null || ValidPropertyDefinitionCoordinates(facet.DefinitionId, facet.DefinitionRevision, schema)) &&
            (sort is null || ValidPropertyDefinitionCoordinates(sort.DefinitionId, sort.DefinitionRevision, schema) &&
                sort.Direction is AuthorTextPropertySortDirection.Ascending or AuthorTextPropertySortDirection.Descending),
            InvalidAuthorTextPropertyText);

    private static void ValidateAuthorTextPropertyTextMixedRows(AuthorTextFacetedPage page, bool includeHeading) =>
        Check(includeHeading || page.Rows.All(row => row.Field != 4), InvalidAuthorTextPropertyText);

    private static void ValidateAuthorTextPropertyTextPage(AuthorTextFacetedPage page) =>
        Check(page.Rows.All(row => row.Field == 5), InvalidAuthorTextPropertyText);

    private static ProtocolException InvalidAuthorTextPropertyText() => new("Invalid author text property search.");
}
