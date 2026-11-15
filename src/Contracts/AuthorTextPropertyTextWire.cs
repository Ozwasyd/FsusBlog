namespace FsusBlog.V2.Contracts;

public sealed record AuthorTextPropertyTextQuery(AuthorTextQualifiedQuery Search, Guid DefinitionId, long DefinitionRevision);
public sealed record AuthorTextPropertyTextQualifiedQuery(AuthorTextQualifiedQuery Search, Guid DefinitionId, long DefinitionRevision,
    AuthorTextPropertyFacetSelector? Facet, AuthorTextPropertySortSelector? Sort);
public sealed record AuthorTextPropertyTextMixedQuery(AuthorTextQualifiedQuery Search, Guid DefinitionId, long DefinitionRevision,
    bool IncludeHeading, AuthorTextPropertyFacetSelector? Facet, AuthorTextPropertySortSelector? Sort);

public static partial class Wire
{
    public static byte[] EncodeAuthorTextPropertyTextQuery(AuthorTextPropertyTextQuery value)
    {
        ValidateAuthorTextPropertyTextSelection(value.Search, value.DefinitionId, value.DefinitionRevision);
        var writer = new Writer();
        WriteAuthorTextPropertyTextSelection(writer, value.Search, value.DefinitionId, value.DefinitionRevision);
        return Aeds.Encode(FrameType.AuthorTextPropertyTextQuery, writer.Written);
    }

    public static AuthorTextPropertyTextQuery DecodeAuthorTextPropertyTextQuery(ReadOnlySpan<byte> frame)
    {
        if (frame.Length > WireLimits.MaxAuthorTextPropertyTextQueryFrameBytes) throw InvalidAuthorTextPropertyText();
        var reader = new Reader(Aeds.Decode(frame, FrameType.AuthorTextPropertyTextQuery));
        var search = ReadAuthorTextQualifiedQuery(ref reader);
        var value = new AuthorTextPropertyTextQuery(search, reader.Uuid(), reader.I64());
        reader.Finish();
        ValidateAuthorTextPropertyTextSelection(value.Search, value.DefinitionId, value.DefinitionRevision);
        return value;
    }

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

    public static byte[] EncodeAuthorTextPropertyTextQualifiedQuery(AuthorTextPropertyTextQualifiedQuery value)
    {
        ValidateAuthorTextPropertyTextQualifiedQuery(value);
        var writer = new Writer();
        WriteAuthorTextPropertyTextSelection(writer, value.Search, value.DefinitionId, value.DefinitionRevision);
        WriteAuthorTextPropertySelectors(writer, value.Facet, value.Sort);
        return Aeds.Encode(FrameType.AuthorTextPropertyTextQualifiedQuery, writer.Written);
    }

    public static AuthorTextPropertyTextQualifiedQuery DecodeAuthorTextPropertyTextQualifiedQuery(ReadOnlySpan<byte> frame)
    {
        if (frame.Length > WireLimits.MaxAuthorTextPropertyTextQualifiedQueryFrameBytes) throw InvalidAuthorTextPropertyText();
        var reader = new Reader(Aeds.Decode(frame, FrameType.AuthorTextPropertyTextQualifiedQuery));
        var search = ReadAuthorTextQualifiedQuery(ref reader);
        var definition = reader.Uuid();
        var revision = reader.I64();
        var (facet, sort) = ReadAuthorTextPropertySelectors(ref reader);
        reader.Finish();
        var value = new AuthorTextPropertyTextQualifiedQuery(search, definition, revision, facet, sort);
        ValidateAuthorTextPropertyTextQualifiedQuery(value);
        return value;
    }

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

    public static byte[] EncodeAuthorTextPropertyTextMixedQuery(AuthorTextPropertyTextMixedQuery value)
    {
        ValidateAuthorTextPropertyTextSelection(value.Search, value.DefinitionId, value.DefinitionRevision);
        ValidateAuthorTextPropertySelectors(value.Search.SchemaRevision, value.Facet, value.Sort);
        var writer = new Writer();
        WriteAuthorTextPropertyTextSelection(writer, value.Search, value.DefinitionId, value.DefinitionRevision);
        writer.Bool(value.IncludeHeading);
        WriteAuthorTextPropertySelectors(writer, value.Facet, value.Sort);
        return Aeds.Encode(FrameType.AuthorTextPropertyTextMixedQuery, writer.Written);
    }

    public static AuthorTextPropertyTextMixedQuery DecodeAuthorTextPropertyTextMixedQuery(ReadOnlySpan<byte> frame)
    {
        if (frame.Length > WireLimits.MaxAuthorTextPropertyTextMixedQueryFrameBytes) throw InvalidAuthorTextPropertyText();
        var reader = new Reader(Aeds.Decode(frame, FrameType.AuthorTextPropertyTextMixedQuery));
        var search = ReadAuthorTextQualifiedQuery(ref reader);
        var definition = reader.Uuid();
        var revision = reader.I64();
        var includeHeading = reader.Bool();
        var (facet, sort) = ReadAuthorTextPropertySelectors(ref reader);
        reader.Finish();
        ValidateAuthorTextPropertyTextSelection(search, definition, revision);
        ValidateAuthorTextPropertySelectors(search.SchemaRevision, facet, sort);
        return new(search, definition, revision, includeHeading, facet, sort);
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

    private static void WriteAuthorTextPropertyTextSelection(Writer writer, AuthorTextQualifiedQuery search, Guid definition, long revision)
    {
        WriteAuthorTextQualifiedQuery(writer, search);
        writer.Uuid(definition);
        writer.I64(revision);
    }

    private static void WriteAuthorTextPropertySelectors(Writer writer, AuthorTextPropertyFacetSelector? facet,
        AuthorTextPropertySortSelector? sort)
    {
        writer.Bool(facet is not null);
        if (facet is not null)
        {
            writer.Uuid(facet.DefinitionId);
            writer.I64(facet.DefinitionRevision);
        }
        writer.Bool(sort is not null);
        if (sort is not null)
        {
            writer.Uuid(sort.DefinitionId);
            writer.I64(sort.DefinitionRevision);
            writer.Bool(sort.Direction == AuthorTextPropertySortDirection.Descending);
        }
    }

    private static (AuthorTextPropertyFacetSelector? Facet, AuthorTextPropertySortSelector? Sort)
        ReadAuthorTextPropertySelectors(ref Reader reader)
    {
        var facet = reader.Bool() ? new AuthorTextPropertyFacetSelector(reader.Uuid(), reader.I64()) : null;
        var sort = reader.Bool() ? new AuthorTextPropertySortSelector(reader.Uuid(), reader.I64(),
            reader.Bool() ? AuthorTextPropertySortDirection.Descending : AuthorTextPropertySortDirection.Ascending) : null;
        return (facet, sort);
    }

    private static void ValidateAuthorTextPropertyTextSelection(AuthorTextQualifiedQuery search, Guid definition, long revision)
    {
        if (!ValidAuthorTextPropertySelector(definition, revision, search.SchemaRevision)) throw InvalidAuthorTextPropertyText();
        ValidateAuthorTextQualifiedQuery(search, requireQualifier: false, propertyFacet: true);
    }

    private static void ValidateAuthorTextPropertyTextQualifiedQuery(AuthorTextPropertyTextQualifiedQuery value)
    {
        ValidateAuthorTextPropertyTextSelection(value.Search, value.DefinitionId, value.DefinitionRevision);
        if (value.Facet is null && value.Sort is null) throw InvalidAuthorTextPropertyText();
        ValidateAuthorTextPropertySelectors(value.Search.SchemaRevision, value.Facet, value.Sort);
    }

    private static void ValidateAuthorTextPropertySelectors(long schema, AuthorTextPropertyFacetSelector? facet,
        AuthorTextPropertySortSelector? sort)
    {
        if (facet is not null && !ValidAuthorTextPropertySelector(facet.DefinitionId, facet.DefinitionRevision, schema) ||
            sort is not null && (!ValidAuthorTextPropertySelector(sort.DefinitionId, sort.DefinitionRevision, schema) ||
                sort.Direction is not (AuthorTextPropertySortDirection.Ascending or AuthorTextPropertySortDirection.Descending)))
            throw InvalidAuthorTextPropertyText();
    }

    private static void ValidateAuthorTextPropertyTextMixedRows(AuthorTextFacetedPage page, bool includeHeading)
    {
        if (!includeHeading && page.Rows.Any(row => row.Field == 4)) throw InvalidAuthorTextPropertyText();
    }

    private static void ValidateAuthorTextPropertyTextPage(AuthorTextFacetedPage page)
    {
        if (page.Rows.Any(row => row.Field != 5)) throw InvalidAuthorTextPropertyText();
    }

    private static ProtocolException InvalidAuthorTextPropertyText() => new("Invalid author text property search.");
}
