using System.Globalization;

namespace FsusBlog.V2.Contracts;

public enum PropertyFieldKind { Text, Number, Boolean, Date, SingleSelect, MultiSelect, ArticleReference, Url }
public sealed record PropertyFieldOption(Guid Id, string Label);
public sealed record PropertySchemaInput(PropertyDefinitionCommand Command, PropertyFieldKind Kind, IReadOnlyList<PropertyFieldOption> Options);

public abstract record PropertyFieldValue
{
    private PropertyFieldValue() { }

    public sealed record Missing : PropertyFieldValue;
    public sealed record Null : PropertyFieldValue;
    public sealed record Unavailable : PropertyFieldValue;
    public sealed record Text(string Value) : PropertyFieldValue;
    public sealed record Number(decimal Value) : PropertyFieldValue;
    public sealed record Boolean(bool Value) : PropertyFieldValue;
    public sealed record Date(DateTimeOffset Value) : PropertyFieldValue;
    public sealed record SingleSelect(Guid Value) : PropertyFieldValue;
    public sealed record MultiSelect(IReadOnlyList<Guid> Value) : PropertyFieldValue;
    public sealed record ArticleReference(IReadOnlyList<int> Value) : PropertyFieldValue;
    public sealed record Url(string Value) : PropertyFieldValue;
}

public sealed record PropertyValueInput(int ArticleId, long ArticleRevision, long SchemaRevision, long ValueRevision,
    Guid DefinitionId, long DefinitionRevision, Guid RequestId, PropertyFieldValue Value);
public sealed record PropertyValueChange(Guid DefinitionId, long DefinitionRevision, PropertyFieldValue Value);
public sealed record PropertyValueBatchInput(int ArticleId, long ArticleRevision, long SchemaRevision, long ValueRevision,
    Guid RequestId, IReadOnlyList<PropertyValueChange> Changes);
public sealed record PropertyEditorField(Guid DefinitionId, long DefinitionRevision, string MachineKey, string Label,
    bool Deprecated, PropertyFieldKind Kind, IReadOnlyList<PropertyFieldOption> Options, PropertyFieldValue Value);
public sealed record PropertyEditorWorkspace(int ArticleId, long ArticleRevision, long SchemaRevision, long ValueRevision,
    string NextKey, IReadOnlyList<PropertyEditorField> Fields);

public static partial class Wire
{
    private const string PropertyDecimalFormat = "0.############################";
    private const string PropertyDateFormat = "yyyy-MM-dd'T'HH:mm:ss.fff'Z'";

    public static byte[] EncodePropertySchemaInput(PropertySchemaInput input)
    {
        Validate(input.Command);
        var writer = new Writer();
        var command = input.Command;
        writer.I32(command.Operation);
        writer.Uuid(command.DefinitionId);
        writer.Uuid(command.RequestId);
        writer.I64(command.SchemaRevision);
        writer.I64(command.DefinitionRevision);
        writer.Text(command.MachineKey, WireLimits.PropertyKeyBytes);
        writer.Text(command.Label, WireLimits.PropertyLabelBytes);
        ValidateDefinitionFields(command.Operation, input.Kind, input.Options);
        writer.I32((int)input.Kind);
        WriteOptions(writer, input.Options);
        return Aeds.Encode(FrameType.PropertySchemaCommand, writer.Written);
    }

    public static PropertySchemaInput DecodePropertySchemaInput(ReadOnlySpan<byte> frame)
    {
        var reader = new Reader(Aeds.Decode(frame, FrameType.PropertySchemaCommand));
        var command = new PropertyDefinitionCommand(reader.I32(), reader.Uuid(), reader.Uuid(), reader.I64(),
            reader.I64(), reader.Text(WireLimits.PropertyKeyBytes), reader.Text(WireLimits.PropertyLabelBytes));
        Validate(command);
        var kind = ReadKind(ref reader);
        var options = ReadOptions(ref reader);
        ValidateDefinitionFields(command.Operation, kind, options);
        reader.Finish();
        return new(command, kind, options);
    }

    public static byte[] EncodePropertyValueInput(PropertyValueInput input)
    {
        ValidateValueInput(input);
        var writer = new Writer();
        writer.I32(input.ArticleId);
        writer.I64(input.ArticleRevision);
        writer.I64(input.SchemaRevision);
        writer.I64(input.ValueRevision);
        writer.Uuid(input.DefinitionId);
        writer.I64(input.DefinitionRevision);
        writer.Uuid(input.RequestId);
        WriteValue(writer, input.Value);
        return Aeds.Encode(FrameType.PropertyValueCommand, writer.Written);
    }

    public static PropertyValueInput DecodePropertyValueInput(ReadOnlySpan<byte> frame)
    {
        var reader = new Reader(Aeds.Decode(frame, FrameType.PropertyValueCommand));
        var value = new PropertyValueInput(reader.I32(), reader.I64(), reader.I64(), reader.I64(),
            reader.Uuid(), reader.I64(), reader.Uuid(), ReadValue(ref reader));
        ValidateValueInput(value);
        reader.Finish();
        return value;
    }

    public static byte[] EncodePropertyValueBatch(PropertyValueBatchInput input)
    {
        ValidateBatch(input);
        var writer = new Writer();
        writer.I32(input.ArticleId);
        writer.I64(input.ArticleRevision);
        writer.I64(input.SchemaRevision);
        writer.I64(input.ValueRevision);
        writer.Uuid(input.RequestId);
        writer.I32(input.Changes.Count);
        foreach (var change in input.Changes)
        {
            writer.Uuid(change.DefinitionId);
            writer.I64(change.DefinitionRevision);
            WriteValue(writer, change.Value);
        }
        return Aeds.Encode(FrameType.PropertyValueBatchCommand, writer.Written);
    }

    public static PropertyValueBatchInput DecodePropertyValueBatch(ReadOnlySpan<byte> frame)
    {
        if (frame.Length > WireLimits.PropertyBatchMaxCommandBytes) throw InvalidProperty();
        var reader = new Reader(Aeds.Decode(frame, FrameType.PropertyValueBatchCommand));
        var article = reader.I32();
        var revision = reader.I64();
        var schema = reader.I64();
        var values = reader.I64();
        var request = reader.Uuid();
        var count = reader.I32();
        if (count is < 1 or > WireLimits.PropertyBatchMaxChanges) throw InvalidProperty();
        var changes = new PropertyValueChange[count];
        for (var index = 0; index < changes.Length; index++)
            changes[index] = new(reader.Uuid(), reader.I64(), ReadValue(ref reader));
        reader.Finish();
        var input = new PropertyValueBatchInput(article, revision, schema, values, request, changes);
        ValidateBatch(input);
        return input;
    }

    private static void ValidateBatch(PropertyValueBatchInput input)
    {
        if (input.ArticleId <= 0 || input.ArticleRevision <= 0 || input.SchemaRevision <= 0 ||
            input.ValueRevision is < 0 or long.MaxValue || input.RequestId == Guid.Empty ||
            input.Changes.Count is < 1 or > WireLimits.PropertyBatchMaxChanges)
            throw InvalidProperty();
        var fields = new HashSet<Guid>();
        foreach (var change in input.Changes)
            if (change.DefinitionId == Guid.Empty || change.DefinitionRevision <= 0 ||
                change.Value is null or PropertyFieldValue.Unavailable || !fields.Add(change.DefinitionId))
                throw InvalidProperty();
    }

    private static void Validate(PropertyValueBatchReceipt receipt)
    {
        if (receipt.ArticleId <= 0 || receipt.SchemaRevision <= 0 || receipt.ValueRevision <= 0 || receipt.RequestId == Guid.Empty)
            throw InvalidProperty();
    }

    public static byte[] EncodePropertyEditor(PropertyEditorWorkspace input)
    {
        ValidateEditor(input);
        var writer = new Writer();
        writer.I32(input.ArticleId);
        writer.I64(input.ArticleRevision);
        writer.I64(input.SchemaRevision);
        writer.I64(input.ValueRevision);
        writer.Text(input.NextKey, WireLimits.PropertyKeyBytes);
        writer.I32(input.Fields.Count);
        foreach (var field in input.Fields)
        {
            writer.Uuid(field.DefinitionId);
            writer.I64(field.DefinitionRevision);
            writer.Text(field.MachineKey, WireLimits.PropertyKeyBytes);
            writer.Text(field.Label, WireLimits.PropertyLabelBytes);
            writer.Bool(field.Deprecated);
            writer.I32((int)field.Kind);
            WriteOptions(writer, field.Options);
            WriteValue(writer, field.Value);
        }
        return Aeds.Encode(FrameType.PropertyEditor, writer.Written);
    }

    public static PropertyEditorWorkspace DecodePropertyEditor(ReadOnlySpan<byte> frame)
    {
        var reader = new Reader(Aeds.Decode(frame, FrameType.PropertyEditor));
        int articleId = reader.I32();
        long articleRevision = reader.I64();
        long schemaRevision = reader.I64();
        long valueRevision = reader.I64();
        string nextKey = reader.Text(WireLimits.PropertyKeyBytes);
        int count = reader.I32();
        if (count is < 0 or > WireLimits.PropertyPageSize) throw InvalidProperty();
        var fields = new PropertyEditorField[count];
        for (var index = 0; index < count; index++)
            fields[index] = new(reader.Uuid(), reader.I64(), reader.Text(WireLimits.PropertyKeyBytes),
                reader.Text(WireLimits.PropertyLabelBytes), reader.Bool(), ReadKind(ref reader), ReadOptions(ref reader), ReadValue(ref reader));
        reader.Finish();
        var workspace = new PropertyEditorWorkspace(articleId, articleRevision, schemaRevision, valueRevision, nextKey, fields);
        ValidateEditor(workspace);
        return workspace;
    }

    private static void ValidateEditor(PropertyEditorWorkspace workspace)
    {
        if (workspace.ArticleId <= 0 || workspace.ArticleRevision <= 0 || workspace.SchemaRevision < 0 || workspace.ValueRevision < 0 ||
            workspace.Fields.Count > WireLimits.PropertyPageSize ||
            workspace.NextKey.Length != 0 && (workspace.Fields.Count != WireLimits.PropertyPageSize ||
                workspace.Fields[^1].MachineKey != workspace.NextKey)) throw InvalidProperty();
        var seen = new HashSet<Guid>();
        string previous = "";
        foreach (var field in workspace.Fields)
        {
            if (field.DefinitionId == Guid.Empty || !seen.Add(field.DefinitionId) || field.DefinitionRevision <= 0 ||
                field.DefinitionRevision > workspace.SchemaRevision ||
                !ValidPropertyKey(field.MachineKey) || string.IsNullOrWhiteSpace(field.Label) ||
                StringComparer.Ordinal.Compare(field.MachineKey, previous) <= 0 || !Enum.IsDefined(field.Kind))
                throw InvalidProperty();
            if (Tag(field.Value) >= 0 && Tag(field.Value) != (int)field.Kind ||
                field.Value is PropertyFieldValue.Unavailable && field.Kind != PropertyFieldKind.ArticleReference ||
                (field.Kind is PropertyFieldKind.SingleSelect or PropertyFieldKind.MultiSelect) != (field.Options.Count > 0) ||
                field.Value is PropertyFieldValue.SingleSelect single && field.Options.All(option => option.Id != single.Value) ||
                field.Value is PropertyFieldValue.MultiSelect multi && multi.Value.Any(id => field.Options.All(option => option.Id != id)))
                throw InvalidProperty();
            ValidateOptions(field.Options);
            previous = field.MachineKey;
        }
    }

    private static void ValidateDefinitionFields(int operation, PropertyFieldKind kind, IReadOnlyList<PropertyFieldOption> options)
    {
        if (!Enum.IsDefined(kind) || operation != 1 && (kind != PropertyFieldKind.Text || options.Count != 0) ||
            (kind is PropertyFieldKind.SingleSelect or PropertyFieldKind.MultiSelect) != (options.Count > 0))
            throw InvalidProperty();
        ValidateOptions(options);
    }

    private static void ValidateValueInput(PropertyValueInput value)
    {
        if (value.ArticleId <= 0 || value.ArticleRevision <= 0 || value.SchemaRevision <= 0 || value.ValueRevision < 0 ||
            value.DefinitionId == Guid.Empty || value.DefinitionRevision <= 0 || value.RequestId == Guid.Empty ||
            value.Value is PropertyFieldValue.Unavailable)
            throw InvalidProperty();
    }

    private static void ValidateOptions(IReadOnlyList<PropertyFieldOption> options)
    {
        if (options.Count > WireLimits.PropertyOptionCount || options.Any(option => option.Id == Guid.Empty ||
            string.IsNullOrWhiteSpace(option.Label)) || options.Select(option => option.Id).Distinct().Count() != options.Count)
            throw InvalidProperty();
    }

    private static void WriteOptions(Writer writer, IReadOnlyList<PropertyFieldOption> options)
    {
        writer.I32(options.Count);
        foreach (var option in options)
        {
            writer.Uuid(option.Id);
            writer.Text(option.Label, WireLimits.PropertyLabelBytes);
        }
    }

    private static PropertyFieldOption[] ReadOptions(ref Reader reader)
    {
        var count = reader.I32();
        if (count is < 0 or > WireLimits.PropertyOptionCount) throw InvalidProperty();
        var options = new PropertyFieldOption[count];
        for (var index = 0; index < count; index++)
            options[index] = new(reader.Uuid(), reader.Text(WireLimits.PropertyLabelBytes));
        ValidateOptions(options);
        return options;
    }

    private static PropertyFieldKind ReadKind(ref Reader reader)
    {
        var kind = (PropertyFieldKind)reader.I32();
        return Enum.IsDefined(kind) ? kind : throw InvalidProperty();
    }

    private static int Tag(PropertyFieldValue value) => value switch
    {
        PropertyFieldValue.Unavailable => -3, PropertyFieldValue.Missing => -2, PropertyFieldValue.Null => -1,
        PropertyFieldValue.Text => 0, PropertyFieldValue.Number => 1,
        PropertyFieldValue.Boolean => 2, PropertyFieldValue.Date => 3, PropertyFieldValue.SingleSelect => 4,
        PropertyFieldValue.MultiSelect => 5, PropertyFieldValue.ArticleReference => 6, PropertyFieldValue.Url => 7,
        _ => throw InvalidProperty(),
    };

    private static void WriteValue(Writer writer, PropertyFieldValue value)
    {
        writer.I32(Tag(value));
        switch (value)
        {
            case PropertyFieldValue.Text text:
                writer.Text(text.Value, WireLimits.PropertyValueBytes);
                break;
            case PropertyFieldValue.Number number:
                writer.Text(number.Value.ToString(PropertyDecimalFormat, CultureInfo.InvariantCulture), WireLimits.PropertyDecimalBytes);
                break;
            case PropertyFieldValue.Boolean flag:
                writer.Bool(flag.Value);
                break;
            case PropertyFieldValue.Date date:
                if (date.Value.Ticks % TimeSpan.TicksPerMillisecond != 0) throw InvalidProperty();
                writer.Text(date.Value.UtcDateTime.ToString(PropertyDateFormat, CultureInfo.InvariantCulture), WireLimits.PropertyDateBytes);
                break;
            case PropertyFieldValue.SingleSelect single:
                if (single.Value == Guid.Empty) throw InvalidProperty();
                writer.Uuid(single.Value);
                break;
            case PropertyFieldValue.MultiSelect multi:
                if (multi.Value.Count > WireLimits.PropertyOptionCount || !ValidateSet(multi.Value, id => id != Guid.Empty))
                    throw InvalidProperty();
                writer.I32(multi.Value.Count);
                foreach (var id in multi.Value) writer.Uuid(id);
                break;
            case PropertyFieldValue.ArticleReference reference:
                if (!ValidateSet(reference.Value, id => id > 0)) throw InvalidProperty();
                writer.I32s(reference.Value, WireLimits.PropertyOptionCount);
                break;
            case PropertyFieldValue.Url url:
                writer.Text(url.Value, WireLimits.PropertyUrlBytes);
                break;
        }
    }

    private static PropertyFieldValue ReadValue(ref Reader reader) => reader.I32() switch
    {
        -3 => new PropertyFieldValue.Unavailable(),
        -2 => new PropertyFieldValue.Missing(),
        -1 => new PropertyFieldValue.Null(),
        0 => new PropertyFieldValue.Text(reader.Text(WireLimits.PropertyValueBytes)),
        1 => new PropertyFieldValue.Number(ReadDecimal(ref reader)),
        2 => new PropertyFieldValue.Boolean(reader.Bool()),
        3 => new PropertyFieldValue.Date(ReadDate(ref reader)),
        4 => new PropertyFieldValue.SingleSelect(reader.Uuid() is { } id && id != Guid.Empty ? id : throw InvalidProperty()),
        5 => new PropertyFieldValue.MultiSelect(ReadOptionIds(ref reader)),
        6 => new PropertyFieldValue.ArticleReference(ReadArticleIds(ref reader)),
        7 => new PropertyFieldValue.Url(reader.Text(WireLimits.PropertyUrlBytes)),
        _ => throw InvalidProperty(),
    };

    private static decimal ReadDecimal(ref Reader reader)
    {
        string input = reader.Text(WireLimits.PropertyDecimalBytes);
        if (!decimal.TryParse(input, NumberStyles.AllowLeadingSign | NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out var value) ||
            value.ToString(PropertyDecimalFormat, CultureInfo.InvariantCulture) != input)
            throw InvalidProperty();
        return value;
    }

    private static DateTimeOffset ReadDate(ref Reader reader)
    {
        string input = reader.Text(WireLimits.PropertyDateBytes);
        if (!DateTimeOffset.TryParseExact(input, PropertyDateFormat, CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var value))
            throw InvalidProperty();
        return value;
    }

    private static Guid[] ReadOptionIds(ref Reader reader)
    {
        var count = reader.I32();
        if (count is < 0 or > WireLimits.PropertyOptionCount) throw InvalidProperty();
        var ids = new Guid[count];
        for (var index = 0; index < count; index++) ids[index] = reader.Uuid();
        return ValidateSet(ids, id => id != Guid.Empty) ? ids : throw InvalidProperty();
    }

    private static int[] ReadArticleIds(ref Reader reader)
    {
        var ids = reader.I32s(WireLimits.PropertyOptionCount);
        return ValidateSet(ids, id => id > 0) ? ids : throw InvalidProperty();
    }

    private static bool ValidateSet<T>(IReadOnlyList<T> values, Func<T, bool> valid) =>
        values.All(valid) && values.Distinct().Count() == values.Count;

    private static ProtocolException InvalidProperty() => new("Invalid typed property data.");
}
