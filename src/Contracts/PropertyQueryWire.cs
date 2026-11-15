namespace FsusBlog.V2.Contracts;

public sealed record PropertyFilterField(Guid Id, long Revision, string MachineKey, string Label, PropertyFieldKind Kind,
    bool Enabled, bool Deprecated, IReadOnlyList<PropertyFieldOption> Options);
public sealed record PropertyFilterCatalog(long SchemaRevision, string NextKey, IReadOnlyList<PropertyFilterField> Fields);
public sealed record PropertyArticleQuery(long SchemaRevision, Guid DefinitionId, long DefinitionRevision,
    PropertyFieldValue Value, string Cursor);
public enum PropertyComparison { Equal = 0, LessThan = 1, AtMost = 2, GreaterThan = 3, AtLeast = 4, IsPresent = 5 }
public sealed record PropertyCondition(Guid DefinitionId, long DefinitionRevision, PropertyComparison Comparison, PropertyFieldValue Value);
public sealed record PropertyArticleQueryGroup(long SchemaRevision, IReadOnlyList<PropertyCondition> Conditions, string Cursor);
public sealed record PropertyArticleRow(int Id, long Revision, string Title);
public sealed record PropertyArticlePage(string NextCursor, IReadOnlyList<PropertyArticleRow> Rows);

public static partial class Wire
{
    public static byte[] EncodePropertyFilterCatalog(PropertyFilterCatalog catalog)
    {
        var writer = new Writer();
        writer.I64(catalog.SchemaRevision);
        writer.Text(catalog.NextKey, WireLimits.PropertyKeyBytes);
        writer.I32(catalog.Fields.Count);
        foreach (var field in catalog.Fields)
        {
            writer.Uuid(field.Id);
            writer.I64(field.Revision);
            writer.Text(field.MachineKey, WireLimits.PropertyKeyBytes);
            writer.Text(field.Label, WireLimits.PropertyLabelBytes);
            writer.I32((int)field.Kind);
            writer.Bool(field.Enabled);
            writer.Bool(field.Deprecated);
            WriteOptions(writer, field.Options);
        }
        return Aeds.Encode(FrameType.PropertyFilterCatalog, writer.Written);
    }

    public static PropertyFilterCatalog DecodePropertyFilterCatalog(ReadOnlySpan<byte> frame)
    {
        var reader = new Reader(Aeds.Decode(frame, FrameType.PropertyFilterCatalog));
        var revision = reader.I64();
        var next = reader.Text(WireLimits.PropertyKeyBytes);
        var count = reader.I32();
        if (revision < 0 || count < 0 || count > WireLimits.PropertyPageSize) throw InvalidProperty();
        var fields = new PropertyFilterField[count];
        for (var i = 0; i < count; i++)
            fields[i] = new(reader.Uuid(), reader.I64(), reader.Text(WireLimits.PropertyKeyBytes),
                reader.Text(WireLimits.PropertyLabelBytes), ReadKind(ref reader), reader.Bool(), reader.Bool(), ReadOptions(ref reader));
        reader.Finish();
        return new(revision, next, fields);
    }

    public static byte[] EncodePropertyArticleQuery(PropertyArticleQuery input)
    {
        Validate(input);
        var writer = new Writer();
        writer.I64(input.SchemaRevision);
        writer.Uuid(input.DefinitionId);
        writer.I64(input.DefinitionRevision);
        WriteValue(writer, input.Value);
        writer.Text(input.Cursor, WireLimits.PropertyQueryCursorChars);
        return Aeds.Encode(FrameType.PropertyArticleQuery, writer.Written);
    }

    public static PropertyArticleQuery DecodePropertyArticleQuery(ReadOnlySpan<byte> frame)
    {
        return ReadPropertyArticleQuery(Aeds.Decode(frame, FrameType.PropertyArticleQuery));
    }

    private static PropertyArticleQuery ReadPropertyArticleQuery(ReadOnlySpan<byte> payload)
    {
        var reader = new Reader(payload);
        var input = new PropertyArticleQuery(reader.I64(), reader.Uuid(), reader.I64(), ReadValue(ref reader),
            reader.Text(WireLimits.PropertyQueryCursorChars));
        reader.Finish();
        Validate(input);
        return input;
    }

    public static byte[] EncodePropertyArticleQueryGroup(PropertyArticleQueryGroup input)
    {
        Validate(input);
        var writer = new Writer();
        writer.I64(input.SchemaRevision);
        writer.I32(input.Conditions.Count);
        foreach (var condition in input.Conditions)
        {
            writer.Uuid(condition.DefinitionId);
            writer.I64(condition.DefinitionRevision);
            writer.I32((int)condition.Comparison);
            WriteValue(writer, condition.Value);
        }
        writer.Text(input.Cursor, WireLimits.PropertyQueryCursorChars);
        return Aeds.Encode(FrameType.PropertyArticleQueryGroup, writer.Written);
    }

    public static PropertyArticleQueryGroup DecodePropertyArticleQueryGroup(ReadOnlySpan<byte> frame)
    {
        var payload = Aeds.Decode(frame, out var type);
        if (type == FrameType.PropertyArticleQuery)
        {
            var exact = ReadPropertyArticleQuery(payload);
            return new(exact.SchemaRevision,
                [new(exact.DefinitionId, exact.DefinitionRevision, PropertyComparison.Equal, exact.Value)], exact.Cursor);
        }
        if (type != FrameType.PropertyArticleQueryGroup) throw InvalidProperty();
        var reader = new Reader(payload);
        var revision = reader.I64();
        var count = reader.I32();
        if (count is < 1 or > WireLimits.PropertyQueryConditionCount) throw InvalidProperty();
        var conditions = new PropertyCondition[count];
        for (var i = 0; i < count; i++)
            conditions[i] = new(reader.Uuid(), reader.I64(), (PropertyComparison)reader.I32(), ReadValue(ref reader));
        var input = new PropertyArticleQueryGroup(revision, conditions, reader.Text(WireLimits.PropertyQueryCursorChars));
        reader.Finish();
        Validate(input);
        return input;
    }

    public static byte[] EncodePropertyArticlePage(PropertyArticlePage page)
    {
        var writer = new Writer();
        writer.Text(page.NextCursor, WireLimits.PropertyQueryCursorChars);
        writer.I32(page.Rows.Count);
        foreach (var row in page.Rows)
        {
            writer.I32(row.Id);
            writer.I64(row.Revision);
            writer.Text(row.Title, WireLimits.TitleBytes);
        }
        return Aeds.Encode(FrameType.PropertyArticlePage, writer.Written);
    }

    public static PropertyArticlePage DecodePropertyArticlePage(ReadOnlySpan<byte> frame)
    {
        var reader = new Reader(Aeds.Decode(frame, FrameType.PropertyArticlePage));
        var next = reader.Text(WireLimits.PropertyQueryCursorChars);
        var count = reader.I32();
        if (count < 0 || count > WireLimits.PropertyPageSize) throw InvalidProperty();
        var rows = new PropertyArticleRow[count];
        for (var i = 0; i < count; i++)
            rows[i] = new(reader.I32(), reader.I64(), reader.Text(WireLimits.TitleBytes));
        reader.Finish();
        return new(next, rows);
    }

    internal static void Validate(PropertyFilterabilityCommand input)
    {
        if (input.DefinitionId == Guid.Empty || input.RequestId == Guid.Empty || input.SchemaRevision <= 0 ||
            input.DefinitionRevision <= 0 || input.DefinitionRevision > input.SchemaRevision) throw InvalidProperty();
    }

    private static void Validate(PropertyArticleQuery input)
    {
        if (!ValidCondition(input.SchemaRevision, input.DefinitionId, input.DefinitionRevision, input.Value) ||
            !ValidCursor(input.Cursor)) throw InvalidProperty();
    }

    private static void Validate(PropertyArticleQueryGroup input)
    {
        if (input.Conditions.Count is < 1 or > WireLimits.PropertyQueryConditionCount || !ValidCursor(input.Cursor))
            throw InvalidProperty();
        var unique = new HashSet<(Guid, PropertyComparison)>();
        foreach (var condition in input.Conditions)
            if (!ValidCondition(input.SchemaRevision, condition.DefinitionId, condition.DefinitionRevision, condition.Value) ||
                !ValidComparison(condition.Comparison, condition.Value) || !unique.Add((condition.DefinitionId, condition.Comparison)))
                throw InvalidProperty();
    }

    private static bool ValidComparison(PropertyComparison comparison, PropertyFieldValue value) => comparison switch
    {
        PropertyComparison.Equal => true,
        // The existing zero-payload field tag encodes an operand-free comparison.
        PropertyComparison.IsPresent => value is PropertyFieldValue.Missing,
        PropertyComparison.LessThan or PropertyComparison.AtMost or PropertyComparison.GreaterThan or PropertyComparison.AtLeast
            => value is PropertyFieldValue.Number or PropertyFieldValue.Date,
        _ => false,
    };

    private static bool ValidCondition(long schema, Guid definition, long revision, PropertyFieldValue value) =>
        definition != Guid.Empty && revision > 0 && revision <= schema && value is not PropertyFieldValue.Unavailable;

    private static bool ValidCursor(string cursor) => cursor.Length == 0 || cursor.Length == WireLimits.PropertyQueryCursorChars &&
        cursor.All(character => char.IsAsciiLetterOrDigit(character) || character is '-' or '_');
}
