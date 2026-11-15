namespace FsusBlog.V2.Contracts;

public sealed record AuthorTextPropertyTextQuery(AuthorTextQualifiedQuery Search, Guid DefinitionId, long DefinitionRevision);

public static partial class Wire
{
    public static byte[] EncodeAuthorTextPropertyTextQuery(AuthorTextPropertyTextQuery value)
    {
        ValidateAuthorTextPropertyTextQuery(value);
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
        ValidateAuthorTextPropertyTextQuery(value);
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

    private static void ValidateAuthorTextPropertyTextQuery(AuthorTextPropertyTextQuery value)
    {
        if (!ValidAuthorTextPropertySelector(value.DefinitionId, value.DefinitionRevision, value.Search.SchemaRevision))
            throw InvalidAuthorTextPropertyText();
        ValidateAuthorTextQualifiedQuery(value.Search, requireQualifier: false, propertyFacet: true);
    }

    private static void ValidateAuthorTextPropertyTextPage(AuthorTextFacetedPage page)
    {
        if (page.Rows.Any(row => row.Field != 5)) throw InvalidAuthorTextPropertyText();
    }

    private static ProtocolException InvalidAuthorTextPropertyText() => new("Invalid author text property search.");
}
