namespace FsusBlog.V2.Contracts;

public sealed record PropertyProjectionCatalog(long SchemaRevision, string NextKey, IReadOnlyList<PropertyProjectionCatalogField> Fields);
public sealed record PropertyProjectionCatalogField(PropertyFilterField Field, bool SearchEligible, bool Sortable);

public static partial class Wire
{
    public static byte[] EncodePropertyProjectionCatalog(PropertyProjectionCatalog catalog)
    {
        ValidatePropertyProjectionCatalog(catalog);
        var writer = new Writer();
        WritePropertyCatalogHeader(writer, catalog.SchemaRevision, catalog.NextKey, catalog.Fields.Count);
        foreach (var projected in catalog.Fields)
        {
            WritePropertyFilterField(writer, projected.Field);
            writer.Bool(projected.SearchEligible);
            writer.Bool(projected.Sortable);
        }
        return Aeds.Encode(FrameType.PropertyProjectionCatalog, writer.Written);
    }

    public static PropertyProjectionCatalog DecodePropertyProjectionCatalog(ReadOnlySpan<byte> frame)
    {
        var reader = new Reader(Aeds.Decode(frame, FrameType.PropertyProjectionCatalog));
        var (revision, next, count) = ReadPropertyCatalogHeader(ref reader);
        var fields = new PropertyProjectionCatalogField[count];
        for (var i = 0; i < fields.Length; i++)
            fields[i] = new(ReadPropertyFilterField(ref reader), reader.Bool(), reader.Bool());
        reader.Finish();
        var catalog = new PropertyProjectionCatalog(revision, next, fields);
        ValidatePropertyProjectionCatalog(catalog);
        return catalog;
    }

    private static void ValidatePropertyProjectionCatalog(PropertyProjectionCatalog catalog)
    {
        if (catalog.SchemaRevision < 0 || catalog.Fields.Count > WireLimits.PropertyPageSize)
            throw InvalidProperty();
        var previous = "";
        var seen = new HashSet<Guid>();
        foreach (var projected in catalog.Fields)
        {
            var field = projected.Field;
            if (field.Id == Guid.Empty || !seen.Add(field.Id) || field.Revision <= 0 || field.Revision > catalog.SchemaRevision ||
                string.CompareOrdinal(field.MachineKey, previous) <= 0 || field.Label.Length == 0 || !Enum.IsDefined(field.Kind) ||
                (field.Deprecated && (field.Enabled || projected.SearchEligible || projected.Sortable)))
                throw InvalidProperty();
            previous = field.MachineKey;
        }
        if (catalog.NextKey.Length != 0 && (catalog.Fields.Count != WireLimits.PropertyPageSize || catalog.NextKey != previous))
            throw InvalidProperty();
    }
}
