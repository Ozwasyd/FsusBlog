namespace FsusBlog.V2.Contracts;

public sealed record AuthorTextPropertyTextQuery(AuthorTextQualifiedQuery Search, Guid DefinitionId, long DefinitionRevision);
public sealed record AuthorTextPropertyTextQualifiedQuery(AuthorTextQualifiedQuery Search, Guid DefinitionId, long DefinitionRevision,
    AuthorTextPropertyFacetSelector? Facet, AuthorTextPropertySortSelector? Sort);

public static partial class Wire
{
    public static byte[] EncodeAuthorTextPropertyTextQuery(AuthorTextPropertyTextQuery value)
    {
        ValidateAuthorTextPropertyTextSelection(value.Search, value.DefinitionId, value.DefinitionRevision);
        var writer = new Writer();
        WriteAuthorTextQualifiedQuery(writer, value.Search);
        writer.Uuid(value.DefinitionId);
        writer.I64(value.DefinitionRevision);
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
        WriteAuthorTextQualifiedQuery(writer, value.Search);
        writer.Uuid(value.DefinitionId);
        writer.I64(value.DefinitionRevision);
        writer.Bool(value.Facet is not null);
        if (value.Facet is { } facet)
        {
            writer.Uuid(facet.DefinitionId);
            writer.I64(facet.DefinitionRevision);
        }
        writer.Bool(value.Sort is not null);
        if (value.Sort is { } sort)
        {
            writer.Uuid(sort.DefinitionId);
            writer.I64(sort.DefinitionRevision);
            writer.Bool(sort.Direction == AuthorTextPropertySortDirection.Descending);
        }
        return Aeds.Encode(FrameType.AuthorTextPropertyTextQualifiedQuery, writer.Written);
    }

    public static AuthorTextPropertyTextQualifiedQuery DecodeAuthorTextPropertyTextQualifiedQuery(ReadOnlySpan<byte> frame)
    {
        if (frame.Length > WireLimits.MaxAuthorTextPropertyTextQualifiedQueryFrameBytes) throw InvalidAuthorTextPropertyText();
        var reader = new Reader(Aeds.Decode(frame, FrameType.AuthorTextPropertyTextQualifiedQuery));
        var search = ReadAuthorTextQualifiedQuery(ref reader);
        var definition = reader.Uuid();
        var revision = reader.I64();
        var facet = reader.Bool() ? new AuthorTextPropertyFacetSelector(reader.Uuid(), reader.I64()) : null;
        var sort = reader.Bool() ? new AuthorTextPropertySortSelector(reader.Uuid(), reader.I64(),
            reader.Bool() ? AuthorTextPropertySortDirection.Descending : AuthorTextPropertySortDirection.Ascending) : null;
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

    private static void ValidateAuthorTextPropertyTextSelection(AuthorTextQualifiedQuery search, Guid definition, long revision)
    {
        if (!ValidAuthorTextPropertySelector(definition, revision, search.SchemaRevision)) throw InvalidAuthorTextPropertyText();
        ValidateAuthorTextQualifiedQuery(search, requireQualifier: false, propertyFacet: true);
    }

    private static void ValidateAuthorTextPropertyTextQualifiedQuery(AuthorTextPropertyTextQualifiedQuery value)
    {
        ValidateAuthorTextPropertyTextSelection(value.Search, value.DefinitionId, value.DefinitionRevision);
        var schema = value.Search.SchemaRevision;
        if (value.Facet is null && value.Sort is null ||
            value.Facet is { } facet && !ValidAuthorTextPropertySelector(facet.DefinitionId, facet.DefinitionRevision, schema) ||
            value.Sort is { } sort && (!ValidAuthorTextPropertySelector(sort.DefinitionId, sort.DefinitionRevision, schema) ||
                sort.Direction is not (AuthorTextPropertySortDirection.Ascending or AuthorTextPropertySortDirection.Descending)))
            throw InvalidAuthorTextPropertyText();
    }

    private static void ValidateAuthorTextPropertyTextPage(AuthorTextFacetedPage page)
    {
        if (page.Rows.Any(row => row.Field != 5)) throw InvalidAuthorTextPropertyText();
    }

    private static ProtocolException InvalidAuthorTextPropertyText() => new("Invalid author text property search.");
}
