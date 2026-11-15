namespace FsusBlog.V2.Contracts;

public sealed record AuthorTextPropertyFacetQuery(AuthorTextQualifiedQuery Search, bool IncludeHeading, Guid DefinitionId,
    long DefinitionRevision);
public sealed record AuthorTextPropertyFacetPage(AuthorTextFacetedPage Search, AuthorTextPropertyFacet? Facet);
public sealed record AuthorTextPropertyFacet(Guid DefinitionId, long DefinitionRevision, PropertyFieldKind Kind,
    int Missing, int Null, int Empty, IReadOnlyList<AuthorTextPropertyFacetBucket> Buckets);
public sealed record AuthorTextPropertyFacetBucket(PropertyFieldValue Value, int Count);

public static partial class Wire
{
    public static byte[] EncodeAuthorTextPropertyFacetQuery(AuthorTextPropertyFacetQuery value)
    {
        ValidateAuthorTextPropertyFacetQuery(value);
        var writer = new Writer();
        WriteAuthorTextQualifiedQuery(writer, value.Search);
        writer.Bool(value.IncludeHeading);
        writer.Uuid(value.DefinitionId);
        writer.I64(value.DefinitionRevision);
        return Aeds.Encode(FrameType.AuthorTextPropertyFacetQuery, writer.Written);
    }

    public static AuthorTextPropertyFacetQuery DecodeAuthorTextPropertyFacetQuery(ReadOnlySpan<byte> frame)
    {
        if (frame.Length > WireLimits.MaxAuthorTextPropertyFacetQueryFrameBytes) throw InvalidAuthorTextPropertyFacet();
        var reader = new Reader(Aeds.Decode(frame, FrameType.AuthorTextPropertyFacetQuery));
        var search = ReadAuthorTextQualifiedQuery(ref reader);
        var value = new AuthorTextPropertyFacetQuery(search, reader.Bool(), reader.Uuid(), reader.I64());
        reader.Finish();
        ValidateAuthorTextPropertyFacetQuery(value);
        return value;
    }

    public static byte[] EncodeAuthorTextPropertyFacetPage(AuthorTextPropertyFacetPage value, bool includeHeading = true)
    {
        if (value.Search.Ready != (value.Facet is not null)) throw InvalidAuthorTextPropertyFacet();
        var writer = new Writer();
        WriteAuthorTextFacetedPage(writer, value.Search, AuthorTextPropertyFacetMaxField(includeHeading));
        if (value.Facet is { } facet) WriteAuthorTextPropertyFacet(writer, facet, value.Search.Total);
        return Aeds.Encode(FrameType.AuthorTextPropertyFacetPage, writer.Written);
    }

    private static void WriteAuthorTextPropertyFacet(Writer writer, AuthorTextPropertyFacet facet, int total)
    {
        ValidateAuthorTextPropertyFacet(facet, total);
        writer.Uuid(facet.DefinitionId);
        writer.I64(facet.DefinitionRevision);
        writer.I32((int)facet.Kind);
        writer.I32(facet.Missing);
        writer.I32(facet.Null);
        writer.I32(facet.Empty);
        writer.I32(facet.Buckets.Count);
        foreach (var bucket in facet.Buckets)
        {
            switch (bucket.Value)
            {
                case PropertyFieldValue.Boolean boolean:
                    writer.Bool(boolean.Value);
                    break;
                case PropertyFieldValue.SingleSelect selection:
                    writer.Uuid(selection.Value);
                    break;
                default:
                    throw InvalidAuthorTextPropertyFacet();
            }
            writer.I32(bucket.Count);
        }
    }

    public static AuthorTextPropertyFacetPage DecodeAuthorTextPropertyFacetPage(ReadOnlySpan<byte> frame, bool includeHeading = true)
    {
        var reader = new Reader(Aeds.Decode(frame, FrameType.AuthorTextPropertyFacetPage));
        var search = ReadAuthorTextFacetedPage(ref reader, AuthorTextPropertyFacetMaxField(includeHeading));
        var facet = search.Ready ? ReadAuthorTextPropertyFacet(ref reader, search.Total) : null;
        reader.Finish();
        return new(search, facet);
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
        {
            PropertyFieldValue value = boolean
                ? new PropertyFieldValue.Boolean(reader.Bool())
                : new PropertyFieldValue.SingleSelect(reader.Uuid());
            buckets[i] = new(value, reader.I32());
        }
        var facet = new AuthorTextPropertyFacet(definitionId, definitionRevision, kind, missing, nil, empty, buckets);
        ValidateAuthorTextPropertyFacet(facet, total);
        return facet;
    }

    private static void ValidateAuthorTextPropertyFacetQuery(AuthorTextPropertyFacetQuery value)
    {
        if (!ValidAuthorTextPropertySelector(value.DefinitionId, value.DefinitionRevision, value.Search.SchemaRevision))
            throw InvalidAuthorTextPropertyFacet();
        ValidateAuthorTextQualifiedQuery(value.Search, requireQualifier: false, propertyFacet: true);
    }

    private static bool ValidAuthorTextPropertySelector(Guid definition, long revision, long schema) =>
        definition != Guid.Empty && revision > 0 && revision <= schema;

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
        boolean ? count == 2 : count is >= 0 and <= WireLimits.PropertyOptionCount;

    private static int AuthorTextPropertyFacetMaxField(bool includeHeading) =>
        AuthorTextMaxField(includeHeading ? FrameType.AuthorTextHeadingPage : FrameType.AuthorTextSummaryPage);

    private static ProtocolException InvalidAuthorTextPropertyFacet() => new("Invalid author text property facet.");
}
