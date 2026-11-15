namespace FsusBlog.V2.Contracts;

public enum AuthorTextPropertySortDirection { Ascending = 0, Descending = 1 }
public sealed record AuthorTextPropertyFacetSelector(Guid DefinitionId, long DefinitionRevision);
public sealed record AuthorTextPropertySortQuery(AuthorTextQualifiedQuery Search, bool IncludeHeading, Guid DefinitionId,
    long DefinitionRevision, AuthorTextPropertySortDirection Direction, AuthorTextPropertyFacetSelector? Facet);
public sealed record AuthorTextPropertySortPage(AuthorTextFacetedPage Search, AuthorTextPropertyFacet? Facet);

public static partial class Wire
{
    public static byte[] EncodeAuthorTextPropertySortQuery(AuthorTextPropertySortQuery value)
    {
        ValidateAuthorTextPropertySortQuery(value);
        var writer = new Writer();
        WriteAuthorTextQualifiedQuery(writer, value.Search);
        writer.Bool(value.IncludeHeading);
        writer.Uuid(value.DefinitionId);
        writer.I64(value.DefinitionRevision);
        writer.Bool(value.Direction == AuthorTextPropertySortDirection.Descending);
        writer.Bool(value.Facet is not null);
        if (value.Facet is { } facet)
        {
            writer.Uuid(facet.DefinitionId);
            writer.I64(facet.DefinitionRevision);
        }
        return Aeds.Encode(FrameType.AuthorTextPropertySortQuery, writer.Written);
    }

    public static AuthorTextPropertySortQuery DecodeAuthorTextPropertySortQuery(ReadOnlySpan<byte> frame)
    {
        if (frame.Length > WireLimits.MaxAuthorTextPropertySortQueryFrameBytes) throw InvalidAuthorTextPropertySort();
        var reader = new Reader(Aeds.Decode(frame, FrameType.AuthorTextPropertySortQuery));
        var search = ReadAuthorTextQualifiedQuery(ref reader);
        var includeHeading = reader.Bool();
        var definition = reader.Uuid();
        var revision = reader.I64();
        var direction = reader.Bool() ? AuthorTextPropertySortDirection.Descending : AuthorTextPropertySortDirection.Ascending;
        var facet = reader.Bool() ? new AuthorTextPropertyFacetSelector(reader.Uuid(), reader.I64()) : null;
        reader.Finish();
        var value = new AuthorTextPropertySortQuery(search, includeHeading, definition, revision, direction, facet);
        ValidateAuthorTextPropertySortQuery(value);
        return value;
    }

    public static byte[] EncodeAuthorTextPropertySortPage(AuthorTextPropertySortPage value, bool includeHeading = true)
    {
        if (!value.Search.Ready && value.Facet is not null) throw InvalidAuthorTextPropertySort();
        var writer = new Writer();
        WriteAuthorTextFacetedPage(writer, value.Search, AuthorTextPropertyFacetMaxField(includeHeading));
        if (value.Search.Ready)
        {
            writer.Bool(value.Facet is not null);
            if (value.Facet is { } facet) WriteAuthorTextPropertyFacet(writer, facet, value.Search.Total);
        }
        return Aeds.Encode(FrameType.AuthorTextPropertySortPage, writer.Written);
    }

    public static AuthorTextPropertySortPage DecodeAuthorTextPropertySortPage(ReadOnlySpan<byte> frame, bool includeHeading = true,
        bool? expectFacet = null)
    {
        var reader = new Reader(Aeds.Decode(frame, FrameType.AuthorTextPropertySortPage));
        var search = ReadAuthorTextFacetedPage(ref reader, AuthorTextPropertyFacetMaxField(includeHeading));
        var facet = search.Ready && reader.Bool() ? ReadAuthorTextPropertyFacet(ref reader, search.Total) : null;
        reader.Finish();
        if (search.Ready && expectFacet.HasValue && expectFacet.Value != (facet is not null))
            throw InvalidAuthorTextPropertySort();
        return new(search, facet);
    }

    private static void ValidateAuthorTextPropertySortQuery(AuthorTextPropertySortQuery value)
    {
        var schema = value.Search.SchemaRevision;
        if (!ValidAuthorTextPropertySelector(value.DefinitionId, value.DefinitionRevision, schema) ||
            value.Direction is not (AuthorTextPropertySortDirection.Ascending or AuthorTextPropertySortDirection.Descending) ||
            (value.Facet is { } facet && !ValidAuthorTextPropertySelector(facet.DefinitionId, facet.DefinitionRevision, schema)))
            throw InvalidAuthorTextPropertySort();
        ValidateAuthorTextQualifiedQuery(value.Search, requireQualifier: false, propertyFacet: true);
    }

    private static ProtocolException InvalidAuthorTextPropertySort() => new("Invalid author text property sort.");
}
