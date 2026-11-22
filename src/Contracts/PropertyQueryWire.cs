using System.Buffers;
using System.Text;

namespace FsusBlog.V2.Contracts;

public sealed record PropertyFilterField(Guid Id, long Revision, string MachineKey, string Label, PropertyFieldKind Kind,
    bool Enabled, bool Deprecated, IReadOnlyList<PropertyFieldOption> Options);
public sealed record PropertyFilterCatalog(long SchemaRevision, string NextKey, IReadOnlyList<PropertyFilterField> Fields);
public sealed record PropertyArticleQuery(long SchemaRevision, Guid DefinitionId, long DefinitionRevision,
    PropertyFieldValue Value, string Cursor);
public enum PropertyComparison
{
    Equal = 0, LessThan = 1, AtMost = 2, GreaterThan = 3, AtLeast = 4, IsPresent = 5, MultiSelectAnyOf = 6, SingleSelectAnyOf = 7,
    ReferenceAnyOf = 8,
}
public sealed record PropertyCondition(Guid DefinitionId, long DefinitionRevision, PropertyComparison Comparison, PropertyFieldValue Value,
    bool AnyOf = false);
public sealed record PropertyArticleQueryGroup(long SchemaRevision, IReadOnlyList<PropertyCondition> Conditions, string Cursor,
    string Keyword = "");
public sealed record PropertyArticleRow(int Id, long Revision, string Title);
public sealed record PropertyArticlePage(string NextCursor, IReadOnlyList<PropertyArticleRow> Rows);

public static partial class Wire
{
    private const int PropertyAnyOf = 0x100;

    public static byte[] EncodePropertyFilterCatalog(PropertyFilterCatalog catalog)
    {
        var writer = new Writer();
        WritePropertyCatalogHeader(writer, catalog.SchemaRevision, catalog.NextKey, catalog.Fields.Count);
        foreach (var field in catalog.Fields) WritePropertyFilterField(writer, field);
        return Aeds.Encode(FrameType.PropertyFilterCatalog, writer.Written);
    }

    public static PropertyFilterCatalog DecodePropertyFilterCatalog(ReadOnlySpan<byte> frame)
    {
        var reader = new Reader(Aeds.Decode(frame, FrameType.PropertyFilterCatalog));
        var (revision, next, count) = ReadPropertyCatalogHeader(ref reader);
        var fields = new PropertyFilterField[count];
        for (var i = 0; i < count; i++) fields[i] = ReadPropertyFilterField(ref reader);
        reader.Finish();
        return new(revision, next, fields);
    }

    private static void WritePropertyCatalogHeader(Writer writer, long revision, string next, int count)
    {
        writer.I64(revision);
        writer.Text(next, WireLimits.PropertyKeyBytes);
        writer.I32(count);
    }

    private static (long Revision, string Next, int Count) ReadPropertyCatalogHeader(ref Reader reader)
    {
        var revision = reader.I64();
        var next = reader.Text(WireLimits.PropertyKeyBytes);
        var count = reader.I32();
        if (revision < 0 || count < 0 || count > WireLimits.PropertyPageSize) throw InvalidProperty();
        return (revision, next, count);
    }

    private static void WritePropertyFilterField(Writer writer, PropertyFilterField field)
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

    private static PropertyFilterField ReadPropertyFilterField(ref Reader reader) =>
        new(reader.Uuid(), reader.I64(), reader.Text(WireLimits.PropertyKeyBytes), reader.Text(WireLimits.PropertyLabelBytes),
            ReadKind(ref reader), reader.Bool(), reader.Bool(), ReadOptions(ref reader));

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
        var hasKeyword = input.Keyword.Length != 0;
        if (hasKeyword) writer.Text(input.Keyword, WireLimits.AuthorArticleKeywordChars * 4);
        WritePropertyConditions(writer, input.Conditions);
        writer.Text(input.Cursor, WireLimits.PropertyQueryCursorChars);
        return Aeds.Encode(hasKeyword ? FrameType.PropertyKeywordQuery : FrameType.PropertyArticleQueryGroup, writer.Written);
    }

    public static PropertyArticleQueryGroup DecodePropertyArticleQueryGroup(ReadOnlySpan<byte> frame)
    {
        var payload = Aeds.Decode(frame, out var type);
        var hasKeyword = type == FrameType.PropertyKeywordQuery;
        if (frame.Length > (hasKeyword ? WireLimits.PropertyKeywordQueryFrameBytes : WireLimits.PropertyQueryGroupFrameBytes))
            throw InvalidProperty();
        if (type == FrameType.PropertyArticleQuery)
        {
            var exact = ReadPropertyArticleQuery(payload);
            return new(exact.SchemaRevision,
                [new(exact.DefinitionId, exact.DefinitionRevision, PropertyComparison.Equal, exact.Value)], exact.Cursor);
        }
        if (type != FrameType.PropertyArticleQueryGroup && !hasKeyword) throw InvalidProperty();
        var reader = new Reader(payload);
        var revision = reader.I64();
        var keyword = hasKeyword ? reader.Text(WireLimits.AuthorArticleKeywordChars * 4) : "";
        if (hasKeyword && keyword.Length == 0) throw InvalidProperty();
        var conditions = ReadPropertyConditions(ref reader);
        var input = new PropertyArticleQueryGroup(revision, conditions, reader.Text(WireLimits.PropertyQueryCursorChars), keyword);
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
        var rows = new PropertyArticleRow[reader.Count(0, WireLimits.PropertyPageSize, InvalidProperty)];
        for (var i = 0; i < rows.Length; i++)
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
        if (!ValidCursor(input.Cursor) || !IsCanonicalAuthorArticleKeyword(input.Keyword)) throw InvalidProperty();
        ValidatePropertyConditions(input.SchemaRevision, input.Conditions);
    }

    private static void WritePropertyConditions(Writer writer, IReadOnlyList<PropertyCondition> conditions)
    {
        writer.I32(conditions.Count);
        foreach (var condition in conditions)
        {
            writer.Uuid(condition.DefinitionId);
            writer.I64(condition.DefinitionRevision);
            writer.I32(PropertyComparisonCode(condition.Comparison, condition.AnyOf));
            WriteValue(writer, condition.Value);
        }
    }

    private static PropertyCondition[] ReadPropertyConditions(ref Reader reader, bool allowEmpty = false)
    {
        var conditions = new PropertyCondition[reader.Count(allowEmpty ? 0 : 1, WireLimits.PropertyQueryConditionCount, InvalidProperty)];
        for (var i = 0; i < conditions.Length; i++)
        {
            var definition = reader.Uuid();
            var revision = reader.I64();
            var (comparison, anyOf) = ReadPropertyComparison(ref reader);
            conditions[i] = new(definition, revision, comparison, ReadValue(ref reader), anyOf);
        }
        return conditions;
    }

    public static int PropertyComparisonCode(PropertyComparison comparison, bool anyOf) =>
        (int)comparison | (anyOf ? PropertyAnyOf : 0);

    private static (PropertyComparison Comparison, bool AnyOf) ReadPropertyComparison(ref Reader reader)
    {
        var code = reader.I32();
        return ((PropertyComparison)(code & ~PropertyAnyOf), (code & PropertyAnyOf) != 0);
    }

    private static string PropertyOperandKey(PropertyFieldValue value)
    {
        var writer = new Writer();
        WriteValue(writer, value switch
        {
            PropertyFieldValue.MultiSelect options => new PropertyFieldValue.MultiSelect(options.Value.Order().ToArray()),
            PropertyFieldValue.ArticleReference references => new PropertyFieldValue.ArticleReference(references.Value.Order().ToArray()),
            _ => value,
        });
        return Convert.ToHexString(writer.Written);
    }

    private static void ValidatePropertyConditions(long schema, IReadOnlyList<PropertyCondition> conditions, bool allowEmpty = false)
    {
        if (conditions.Count == 0)
        {
            if (!allowEmpty || schema != 0) throw InvalidProperty();
            return;
        }
        if (conditions.Count > WireLimits.PropertyQueryConditionCount) throw InvalidProperty();
        var unique = new HashSet<(Guid, PropertyComparison, string)>();
        foreach (var condition in conditions)
            if (!ValidCondition(schema, condition.DefinitionId, condition.DefinitionRevision, condition.Value) ||
                !ValidComparison(condition.Comparison, condition.Value) ||
                !unique.Add((condition.DefinitionId, condition.Comparison, condition.AnyOf ? PropertyOperandKey(condition.Value) : "")))
                throw InvalidProperty();
        foreach (var group in conditions.GroupBy(condition => condition.DefinitionId))
            if (group.Any(condition => condition.AnyOf) && (group.Count() < 2 ||
                group.Any(condition => !condition.AnyOf || condition.DefinitionRevision != group.First().DefinitionRevision)))
                throw InvalidProperty();
    }

    private static bool ValidComparison(PropertyComparison comparison, PropertyFieldValue value) => comparison switch
    {
        PropertyComparison.Equal => true,
        // The existing zero-payload field tag encodes an operand-free comparison.
        PropertyComparison.IsPresent => value is PropertyFieldValue.Missing,
        PropertyComparison.MultiSelectAnyOf => value is PropertyFieldValue.MultiSelect,
        PropertyComparison.SingleSelectAnyOf => value is PropertyFieldValue.MultiSelect { Value.Count: > 0 },
        PropertyComparison.ReferenceAnyOf => value is PropertyFieldValue.ArticleReference,
        PropertyComparison.LessThan or PropertyComparison.AtMost or PropertyComparison.GreaterThan or PropertyComparison.AtLeast
            => value is PropertyFieldValue.Number or PropertyFieldValue.Date,
        _ => false,
    };

    private static bool ValidCondition(long schema, Guid definition, long revision, PropertyFieldValue value) =>
        ValidPropertyDefinitionCoordinates(definition, revision, schema) && value is not PropertyFieldValue.Unavailable;

    private static bool ValidCursor(string cursor) => cursor.Length == 0 || cursor.Length == WireLimits.PropertyQueryCursorChars &&
        cursor.All(character => char.IsAsciiLetterOrDigit(character) || character is '-' or '_');

    public static bool IsCanonicalAuthorArticleKeyword(string keyword)
    {
        var remaining = keyword.AsSpan();
        if (remaining.Length > WireLimits.AuthorArticleKeywordChars || remaining.Trim().Length != remaining.Length)
            return false;
        while (!remaining.IsEmpty)
        {
            if (Rune.DecodeFromUtf16(remaining, out var scalar, out var width) != OperationStatus.Done || Rune.IsControl(scalar))
                return false;
            remaining = remaining[width..];
        }
        return true;
    }
}
