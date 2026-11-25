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

public sealed record PropertyTextField(Guid DefinitionId, long DefinitionRevision, string MachineKey, string Label,
    bool Deprecated, string? Value);
public sealed record PropertyWorkspace(int ArticleId, long ArticleRevision, long SchemaRevision, long ValueRevision,
    string NextKey, IReadOnlyList<PropertyTextField> Fields);
public sealed record PropertyValueInput(int ArticleId, long ArticleRevision, long SchemaRevision, long ValueRevision,
    Guid DefinitionId, long DefinitionRevision, Guid RequestId, PropertyFieldValue Value);
public sealed record PropertyValueChange(Guid DefinitionId, long DefinitionRevision, PropertyFieldValue Value);
public sealed record PropertyValueBatchInput(int ArticleId, long ArticleRevision, long SchemaRevision, long ValueRevision,
    Guid RequestId, IReadOnlyList<PropertyValueChange> Changes);
public sealed record PropertyEditorField(Guid DefinitionId, long DefinitionRevision, string MachineKey, string Label,
    bool Deprecated, PropertyFieldKind Kind, IReadOnlyList<PropertyFieldOption> Options, PropertyFieldValue Value);
public sealed record PropertyEditorWorkspace(int ArticleId, long ArticleRevision, long SchemaRevision, long ValueRevision,
    string NextKey, IReadOnlyList<PropertyEditorField> Fields);

public sealed record PropertyFilterField(Guid Id, long Revision, string MachineKey, string Label, PropertyFieldKind Kind,
    bool Enabled, bool Deprecated, IReadOnlyList<PropertyFieldOption> Options);
public sealed record PropertyFilterCatalog(long SchemaRevision, string NextKey, IReadOnlyList<PropertyFilterField> Fields);
public sealed record PropertyProjectionCatalog(long SchemaRevision, string NextKey, IReadOnlyList<PropertyProjectionCatalogField> Fields);
public sealed record PropertyProjectionCatalogField(PropertyFilterField Field, bool SearchEligible, bool Sortable);
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
public sealed record PropertyTextHitRequest(int ArticleId, long ArticleRevision, long SchemaRevision, long ValueRevision,
    Guid DefinitionId, long DefinitionRevision, byte[] SourceDigest);

public enum SavedViewAction { Save = 1, Rename = 2, Retire = 3 }
public sealed record SavedViewCommand(SavedViewAction Action, Guid Id, long Revision, long CollectionRevision,
    Guid RequestId, string Name, PropertyArticleQueryGroup? Query);
public sealed record SavedViewReceipt(Guid Id, long Revision, long CollectionRevision, bool Retired);
public sealed record SavedViewSummary(Guid Id, long Revision, string Name);
public sealed record SavedViewCatalog(long CollectionRevision, Guid NextId, IReadOnlyList<SavedViewSummary> Views);
public sealed record SavedViewExecute(Guid Id, long Revision, string Cursor);
public sealed record SavedViewCondition(Guid DefinitionId, PropertyFieldKind Kind, PropertyComparison Comparison, PropertyFieldValue Value,
    bool AnyOf = false);
public sealed record SavedViewDefinition(IReadOnlyList<SavedViewCondition> Conditions, string Keyword);

public enum SavedViewPlacementAction { Pin = 4, Unpin = 5, Default = 6, ClearDefault = 7, MoveBefore = 8 }
public sealed record SavedViewPlacementCommand(SavedViewPlacementAction Action, Guid Id, long Revision, long CollectionRevision,
    Guid RequestId, Guid BeforeId);
public sealed record SavedViewPlacement(long CollectionRevision, SavedViewSummary? Default, SavedViewSummary? Requested,
    bool RequestedPinned, int NextOffset, IReadOnlyList<SavedViewSummary> Pins);

public static partial class Wire
{
    private const string PropertyDecimalFormat = "0.############################";
    private const string PropertyDateFormat = "yyyy-MM-dd'T'HH:mm:ss.fff'Z'";
    private const int PropertyAnyOf = 0x100;

    private static Writer WritePropertyWorkspaceHeader(Writer writer, int articleId, long articleRevision,
        long schemaRevision, long valueRevision, string nextKey) =>
        writer.I32(articleId).I64(articleRevision).I64(schemaRevision).I64(valueRevision).Text(nextKey, PropertyKeyBytes);

    private static Writer WritePropertyFieldPrefix(Writer writer, Guid id, long revision, string machineKey, string label, bool deprecated) =>
        writer.Uuid(id).I64(revision).Text(machineKey, PropertyKeyBytes).Text(label, PropertyLabelBytes).Bool(deprecated);

    public static byte[] EncodePropertyWorkspace(PropertyWorkspace workspace)
    {
        ArgumentOutOfRangeException.ThrowIfGreaterThan(workspace.Fields.Count, PropertyPageSize);
        return EncodeFrame(FrameType.PropertyWorkspace, writer =>
            WritePropertyWorkspaceHeader(writer, workspace.ArticleId, workspace.ArticleRevision,
                workspace.SchemaRevision, workspace.ValueRevision, workspace.NextKey).Items(workspace.Fields, static (w, field) =>
                    WritePropertyFieldPrefix(w, field.DefinitionId, field.DefinitionRevision, field.MachineKey, field.Label, field.Deprecated)
                        .Optional(field.Value, static (tw, value) => tw.Text(value, PropertyValueBytes))));
    }

    public static PropertyWorkspace DecodePropertyWorkspace(ReadOnlySpan<byte> frame) =>
        DecodeFrame(FrameType.PropertyWorkspace, frame, static (ref Reader reader) =>
        {
            int article = reader.I32();
            long articleRevision = reader.I64();
            long schemaRevision = reader.I64();
            long valueRevision = reader.I64();
            string nextKey = reader.Text(PropertyKeyBytes);
            int size = reader.I32();
            if (article <= 0 || articleRevision <= 0 || schemaRevision < 0 || valueRevision < 0 ||
                size is < 0 or > PropertyPageSize || nextKey.Length != 0 && size == 0)
                throw new ProtocolException("Invalid property page.");
            var fields = new PropertyTextField[size];
            var seen = new HashSet<Guid>();
            for (int i = 0; i < fields.Length; i++)
            {
                var field = new PropertyTextField(reader.Uuid(), reader.I64(), reader.Text(PropertyKeyBytes),
                    reader.Text(PropertyLabelBytes), reader.Bool(),
                    reader.Optional(static (ref Reader r) => r.Text(PropertyValueBytes)));
                if (field.DefinitionId == Guid.Empty || !seen.Add(field.DefinitionId) || field.DefinitionRevision <= 0 ||
                    !ValidPropertyKey(field.MachineKey) || string.IsNullOrWhiteSpace(field.Label) ||
                    i > 0 && StringComparer.Ordinal.Compare(fields[i - 1].MachineKey, field.MachineKey) >= 0)
                    throw new ProtocolException("Invalid property item.");
                fields[i] = field;
            }
            if (nextKey.Length != 0 && (size != PropertyPageSize || fields[^1].MachineKey != nextKey))
                throw new ProtocolException("Invalid property cursor.");
            return new PropertyWorkspace(article, articleRevision, schemaRevision, valueRevision, nextKey, fields);
        });

    internal static void Validate(PropertyDefinitionCommand input) =>
        Check(input.DefinitionId != Guid.Empty && input.RequestId != Guid.Empty && input.SchemaRevision >= 0 &&
            input.DefinitionRevision >= 0 && input.Operation is >= 1 and <= 4 &&
            (input.Operation == 1) == (input.DefinitionRevision == 0) &&
            (input.Operation == 1) == (input.MachineKey.Length != 0) &&
            (input.Operation is 1 or 2) == (input.Label.Length != 0), "Invalid property definition command.");

    internal static void Validate(PropertyDefinitionProjectionCommand input) =>
        Check(input.RequestId != Guid.Empty && ValidPropertyDefinitionCoordinates(input.DefinitionId, input.DefinitionRevision, input.SchemaRevision),
            "Invalid property definition projection command.");

    internal static void Validate(PropertyDefinitionProjection output) =>
        Check(ValidPropertyDefinitionCoordinates(output.DefinitionId, output.DefinitionRevision, output.SchemaRevision) &&
            IsLowerHex(output.Digest, PropertyDefinitionDigestBytes), "Invalid property definition projection.");

    private static bool ValidPropertyDefinitionCoordinates(Guid definition, long definitionRevision, long schemaRevision) =>
        definition != Guid.Empty && definitionRevision > 0 && definitionRevision <= schemaRevision;

    internal static void Validate(PropertyWorkspaceRequest input) =>
        Check(input.ArticleId > 0 && input.ArticleRevision > 0 && input.SchemaRevision >= 0 && input.ValueRevision >= 0 &&
            (input.AfterKey.Length == 0 ? input.SchemaRevision == 0 && input.ValueRevision == 0 : ValidPropertyKey(input.AfterKey)),
            "Invalid property workspace request.");

    internal static void Validate(PropertyTextCommand input) =>
        Check(input.ArticleId > 0 && input.ArticleRevision > 0 && input.DefinitionId != Guid.Empty && input.RequestId != Guid.Empty &&
            input.SchemaRevision > 0 && input.DefinitionRevision > 0 && input.ValueRevision >= 0 &&
            !(input.Remove && input.Value.Length != 0), "Invalid property value command.");

    internal static void Validate(PropertyCommandReceipt input) =>
        Check(input.DefinitionId != Guid.Empty && input.SchemaRevision > 0 && input.Revision > 0, "Invalid property receipt.");

    private static bool ValidPropertyKey(string key)
    {
        if (key.Length == 0 || key[0] is < 'a' or > 'z') return false;
        bool separator = false;
        foreach (char value in key)
        {
            if (value is >= 'a' and <= 'z' or >= '0' and <= '9') separator = false;
            else if (!separator && value is '_' or '-') separator = true;
            else return false;
        }
        return !separator;
    }

    public static byte[] EncodePropertySchemaInput(PropertySchemaInput input)
    {
        var command = input.Command;
        Validate(command);
        ValidateDefinitionFields(command.Operation, input.Kind, input.Options);
        return EncodeFrame(FrameType.PropertySchemaCommand, writer =>
        {
            writer.I32(command.Operation).Uuid(command.DefinitionId).Uuid(command.RequestId)
                .I64(command.SchemaRevision).I64(command.DefinitionRevision)
                .Text(command.MachineKey, PropertyKeyBytes).Text(command.Label, PropertyLabelBytes).I32((int)input.Kind);
            WriteOptions(writer, input.Options);
        });
    }

    public static PropertySchemaInput DecodePropertySchemaInput(ReadOnlySpan<byte> frame) =>
        DecodeFrame(FrameType.PropertySchemaCommand, frame, static (ref Reader reader) =>
        {
            var command = new PropertyDefinitionCommand(reader.I32(), reader.Uuid(), reader.Uuid(), reader.I64(),
                reader.I64(), reader.Text(PropertyKeyBytes), reader.Text(PropertyLabelBytes));
            Validate(command);
            var kind = ReadKind(ref reader);
            var options = ReadOptions(ref reader);
            ValidateDefinitionFields(command.Operation, kind, options);
            return new PropertySchemaInput(command, kind, options);
        });

    public static byte[] EncodePropertyValueInput(PropertyValueInput input)
    {
        ValidateValueInput(input);
        return EncodeFrame(FrameType.PropertyValueCommand, writer =>
            WriteValue(writer.I32(input.ArticleId).I64(input.ArticleRevision).I64(input.SchemaRevision).I64(input.ValueRevision)
                .Uuid(input.DefinitionId).I64(input.DefinitionRevision).Uuid(input.RequestId), input.Value));
    }

    public static PropertyValueInput DecodePropertyValueInput(ReadOnlySpan<byte> frame) =>
        DecodeRecord<PropertyValueInput>(FrameType.PropertyValueCommand, frame, static (ref Reader reader) =>
            new(reader.I32(), reader.I64(), reader.I64(), reader.I64(),
                reader.Uuid(), reader.I64(), reader.Uuid(), ReadValue(ref reader)), ValidateValueInput);

    public static byte[] EncodePropertyValueBatch(PropertyValueBatchInput input)
    {
        ValidateBatch(input);
        return EncodeFrame(FrameType.PropertyValueBatchCommand, writer =>
            writer.I32(input.ArticleId).I64(input.ArticleRevision).I64(input.SchemaRevision).I64(input.ValueRevision)
                .Uuid(input.RequestId).Items(input.Changes, static (w, change) =>
                    WriteValue(w.Uuid(change.DefinitionId).I64(change.DefinitionRevision), change.Value)));
    }

    public static PropertyValueBatchInput DecodePropertyValueBatch(ReadOnlySpan<byte> frame) =>
        DecodeRecord<PropertyValueBatchInput>(FrameType.PropertyValueBatchCommand, frame, PropertyBatchMaxCommandBytes, InvalidProperty,
            static (ref Reader reader) => new(reader.I32(), reader.I64(), reader.I64(), reader.I64(), reader.Uuid(),
                reader.Items(1, PropertyBatchMaxChanges, InvalidProperty,
                    static (ref Reader r) => new PropertyValueChange(r.Uuid(), r.I64(), ReadValue(ref r)))), ValidateBatch);

    private static void ValidateBatch(PropertyValueBatchInput input)
    {
        Check(input.ArticleId > 0 && input.ArticleRevision > 0 && input.SchemaRevision > 0 &&
            input.ValueRevision is >= 0 and < long.MaxValue && input.RequestId != Guid.Empty &&
            input.Changes.Count is >= 1 and <= PropertyBatchMaxChanges, InvalidProperty);
        var fields = new HashSet<Guid>();
        foreach (var change in input.Changes)
            Check(change.DefinitionId != Guid.Empty && change.DefinitionRevision > 0 &&
                change.Value is not (null or PropertyFieldValue.Unavailable) && fields.Add(change.DefinitionId), InvalidProperty);
    }

    private static void Validate(PropertyValueBatchReceipt receipt) =>
        Check(receipt.ArticleId > 0 && receipt.SchemaRevision > 0 && receipt.ValueRevision > 0 && receipt.RequestId != Guid.Empty,
            InvalidProperty);

    public static byte[] EncodePropertyEditor(PropertyEditorWorkspace input)
    {
        ValidateEditor(input);
        return EncodeFrame(FrameType.PropertyEditor, writer =>
            WritePropertyWorkspaceHeader(writer, input.ArticleId, input.ArticleRevision, input.SchemaRevision,
                input.ValueRevision, input.NextKey).Items(input.Fields, static (w, field) =>
            {
                WritePropertyFieldPrefix(w, field.DefinitionId, field.DefinitionRevision, field.MachineKey, field.Label, field.Deprecated)
                    .I32((int)field.Kind);
                WriteOptions(w, field.Options);
                WriteValue(w, field.Value);
            }));
    }

    public static PropertyEditorWorkspace DecodePropertyEditor(ReadOnlySpan<byte> frame) =>
        DecodeRecord<PropertyEditorWorkspace>(FrameType.PropertyEditor, frame, static (ref Reader reader) =>
            new(reader.I32(), reader.I64(), reader.I64(), reader.I64(), reader.Text(PropertyKeyBytes),
                reader.Items(0, PropertyPageSize, InvalidProperty, static (ref Reader r) =>
                    new PropertyEditorField(r.Uuid(), r.I64(), r.Text(PropertyKeyBytes), r.Text(PropertyLabelBytes),
                        r.Bool(), ReadKind(ref r), ReadOptions(ref r), ReadValue(ref r)))), ValidateEditor);

    private static void ValidateEditor(PropertyEditorWorkspace workspace)
    {
        if (workspace.ArticleId <= 0 || workspace.ArticleRevision <= 0 || workspace.SchemaRevision < 0 || workspace.ValueRevision < 0 ||
            workspace.Fields.Count > PropertyPageSize ||
            workspace.NextKey.Length != 0 && (workspace.Fields.Count != PropertyPageSize || workspace.Fields[^1].MachineKey != workspace.NextKey))
            throw InvalidProperty();
        var seen = new HashSet<Guid>();
        string previous = "";
        foreach (var field in workspace.Fields)
        {
            if (field.DefinitionId == Guid.Empty || !seen.Add(field.DefinitionId) || field.DefinitionRevision <= 0 ||
                field.DefinitionRevision > workspace.SchemaRevision || !ValidPropertyKey(field.MachineKey) ||
                string.IsNullOrWhiteSpace(field.Label) || StringComparer.Ordinal.Compare(field.MachineKey, previous) <= 0 ||
                !Enum.IsDefined(field.Kind))
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
        Check(Enum.IsDefined(kind) && (operation == 1 || kind == PropertyFieldKind.Text && options.Count == 0) &&
            (kind is PropertyFieldKind.SingleSelect or PropertyFieldKind.MultiSelect) == (options.Count > 0), InvalidProperty);
        ValidateOptions(options);
    }

    private static void ValidateValueInput(PropertyValueInput value) =>
        Check(value.ArticleId > 0 && value.ArticleRevision > 0 && value.SchemaRevision > 0 && value.ValueRevision >= 0 &&
            value.DefinitionId != Guid.Empty && value.DefinitionRevision > 0 && value.RequestId != Guid.Empty &&
            value.Value is not PropertyFieldValue.Unavailable, InvalidProperty);

    private static void ValidateOptions(IReadOnlyList<PropertyFieldOption> options) =>
        Check(options.Count <= PropertyOptionCount && options.All(option => option.Id != Guid.Empty &&
            !string.IsNullOrWhiteSpace(option.Label)) && options.Select(option => option.Id).Distinct().Count() == options.Count, InvalidProperty);

    private static void WriteOptions(Writer writer, IReadOnlyList<PropertyFieldOption> options) =>
        writer.Items(options, static (w, option) => w.Uuid(option.Id).Text(option.Label, PropertyLabelBytes));

    private static PropertyFieldOption[] ReadOptions(ref Reader reader)
    {
        var options = reader.Items(0, PropertyOptionCount, InvalidProperty,
            static (ref Reader r) => new PropertyFieldOption(r.Uuid(), r.Text(PropertyLabelBytes)));
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
            case PropertyFieldValue.Text text: writer.Text(text.Value, PropertyValueBytes); break;
            case PropertyFieldValue.Number number:
                writer.Text(number.Value.ToString(PropertyDecimalFormat, CultureInfo.InvariantCulture), PropertyDecimalBytes); break;
            case PropertyFieldValue.Boolean flag: writer.Bool(flag.Value); break;
            case PropertyFieldValue.Date date:
                if (date.Value.Ticks % TimeSpan.TicksPerMillisecond != 0) throw InvalidProperty();
                writer.Text(date.Value.UtcDateTime.ToString(PropertyDateFormat, CultureInfo.InvariantCulture), PropertyDateBytes); break;
            case PropertyFieldValue.SingleSelect single:
                if (single.Value == Guid.Empty) throw InvalidProperty();
                writer.Uuid(single.Value); break;
            case PropertyFieldValue.MultiSelect multi:
                if (multi.Value.Count > PropertyOptionCount || !ValidateSet(multi.Value, id => id != Guid.Empty)) throw InvalidProperty();
                writer.Items(multi.Value, static (w, id) => w.Uuid(id)); break;
            case PropertyFieldValue.ArticleReference reference:
                if (!ValidateSet(reference.Value, id => id > 0)) throw InvalidProperty();
                writer.I32s(reference.Value, PropertyOptionCount); break;
            case PropertyFieldValue.Url url: writer.Text(url.Value, PropertyUrlBytes); break;
        }
    }

    private static PropertyFieldValue ReadValue(ref Reader reader) => reader.I32() switch
    {
        -3 => new PropertyFieldValue.Unavailable(),
        -2 => new PropertyFieldValue.Missing(),
        -1 => new PropertyFieldValue.Null(),
        0 => new PropertyFieldValue.Text(reader.Text(PropertyValueBytes)),
        1 => new PropertyFieldValue.Number(ReadDecimal(ref reader)),
        2 => new PropertyFieldValue.Boolean(reader.Bool()),
        3 => new PropertyFieldValue.Date(ReadDate(ref reader)),
        4 => new PropertyFieldValue.SingleSelect(reader.Uuid() is { } id && id != Guid.Empty ? id : throw InvalidProperty()),
        5 => new PropertyFieldValue.MultiSelect(ReadOptionIds(ref reader)),
        6 => new PropertyFieldValue.ArticleReference(ReadArticleIds(ref reader)),
        7 => new PropertyFieldValue.Url(reader.Text(PropertyUrlBytes)),
        _ => throw InvalidProperty(),
    };

    private static decimal ReadDecimal(ref Reader reader)
    {
        string input = reader.Text(PropertyDecimalBytes);
        return decimal.TryParse(input, NumberStyles.AllowLeadingSign | NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out var value) &&
            value.ToString(PropertyDecimalFormat, CultureInfo.InvariantCulture) == input ? value : throw InvalidProperty();
    }

    private static DateTimeOffset ReadDate(ref Reader reader)
    {
        string input = reader.Text(PropertyDateBytes);
        return DateTimeOffset.TryParseExact(input, PropertyDateFormat, CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var value) ? value : throw InvalidProperty();
    }

    private static Guid[] ReadOptionIds(ref Reader reader)
    {
        var ids = reader.Items(0, PropertyOptionCount, InvalidProperty, static (ref Reader r) => r.Uuid());
        return ValidateSet(ids, id => id != Guid.Empty) ? ids : throw InvalidProperty();
    }

    private static int[] ReadArticleIds(ref Reader reader)
    {
        var ids = reader.I32s(PropertyOptionCount);
        return ValidateSet(ids, id => id > 0) ? ids : throw InvalidProperty();
    }

    private static bool ValidateSet<T>(IReadOnlyList<T> values, Func<T, bool> valid) =>
        values.All(valid) && values.Distinct().Count() == values.Count;

    private static ProtocolException InvalidProperty() => new("Invalid typed property data.");

    public static byte[] EncodePropertyFilterCatalog(PropertyFilterCatalog catalog) =>
        EncodeFrame(FrameType.PropertyFilterCatalog, writer =>
            writer.I64(catalog.SchemaRevision).Text(catalog.NextKey, PropertyKeyBytes).Items(catalog.Fields, WritePropertyFilterField));

    public static PropertyFilterCatalog DecodePropertyFilterCatalog(ReadOnlySpan<byte> frame) =>
        DecodeFrame(FrameType.PropertyFilterCatalog, frame, static (ref Reader reader) =>
        {
            var (revision, next, fields) = ReadPropertyCatalog(ref reader, ReadPropertyFilterField);
            return new PropertyFilterCatalog(revision, next, fields);
        });

    public static byte[] EncodePropertyProjectionCatalog(PropertyProjectionCatalog catalog) =>
        EncodeRecord(FrameType.PropertyProjectionCatalog, catalog, ValidatePropertyProjectionCatalog, static (writer, value) =>
            writer.I64(value.SchemaRevision).Text(value.NextKey, PropertyKeyBytes).Items(value.Fields, static (w, projected) =>
            {
                WritePropertyFilterField(w, projected.Field);
                w.Bool(projected.SearchEligible).Bool(projected.Sortable);
            }));

    public static PropertyProjectionCatalog DecodePropertyProjectionCatalog(ReadOnlySpan<byte> frame) =>
        DecodeRecord<PropertyProjectionCatalog>(FrameType.PropertyProjectionCatalog, frame, static (ref Reader reader) =>
        {
            var (revision, next, fields) = ReadPropertyCatalog(ref reader, static (ref Reader r) =>
                new PropertyProjectionCatalogField(ReadPropertyFilterField(ref r), r.Bool(), r.Bool()));
            return new(revision, next, fields);
        }, ValidatePropertyProjectionCatalog);

    private static void ValidatePropertyProjectionCatalog(PropertyProjectionCatalog catalog)
    {
        Check(catalog.SchemaRevision >= 0 && catalog.Fields.Count <= PropertyPageSize, InvalidProperty);
        var previous = "";
        var seen = new HashSet<Guid>();
        foreach (var projected in catalog.Fields)
        {
            var field = projected.Field;
            Check(field.Id != Guid.Empty && seen.Add(field.Id) && field.Revision > 0 && field.Revision <= catalog.SchemaRevision &&
                string.CompareOrdinal(field.MachineKey, previous) > 0 && field.Label.Length != 0 && Enum.IsDefined(field.Kind) &&
                (!field.Deprecated || (!field.Enabled && !projected.SearchEligible && !projected.Sortable)), InvalidProperty);
            previous = field.MachineKey;
        }
        Check(catalog.NextKey.Length == 0 || (catalog.Fields.Count == PropertyPageSize && catalog.NextKey == previous), InvalidProperty);
    }

    private static (long Revision, string Next, T[] Fields) ReadPropertyCatalog<T>(ref Reader reader, ReadRecord<T> readItem)
    {
        var (revision, next, count) = (reader.I64(), reader.Text(PropertyKeyBytes), reader.I32());
        Check(revision >= 0 && count is >= 0 and <= PropertyPageSize, InvalidProperty);
        var fields = new T[count];
        for (var i = 0; i < count; i++) fields[i] = readItem(ref reader);
        return (revision, next, fields);
    }

    private static void WritePropertyFilterField(Writer writer, PropertyFilterField field)
    {
        writer.Uuid(field.Id).I64(field.Revision).Text(field.MachineKey, PropertyKeyBytes).Text(field.Label, PropertyLabelBytes)
            .I32((int)field.Kind).Bool(field.Enabled).Bool(field.Deprecated);
        WriteOptions(writer, field.Options);
    }

    private static PropertyFilterField ReadPropertyFilterField(ref Reader reader) =>
        new(reader.Uuid(), reader.I64(), reader.Text(PropertyKeyBytes), reader.Text(PropertyLabelBytes),
            ReadKind(ref reader), reader.Bool(), reader.Bool(), ReadOptions(ref reader));

    public static byte[] EncodePropertyArticleQuery(PropertyArticleQuery input) =>
        EncodeRecord(FrameType.PropertyArticleQuery, input, Validate, static (writer, query) =>
        {
            writer.I64(query.SchemaRevision).Uuid(query.DefinitionId).I64(query.DefinitionRevision);
            WriteValue(writer, query.Value);
            writer.Text(query.Cursor, PropertyQueryCursorChars);
        });

    public static PropertyArticleQuery DecodePropertyArticleQuery(ReadOnlySpan<byte> frame) =>
        ReadPropertyArticleQuery(Aeds.Decode(frame, FrameType.PropertyArticleQuery));

    private static PropertyArticleQuery ReadPropertyArticleQuery(ReadOnlySpan<byte> payload)
    {
        var reader = new Reader(payload);
        var input = new PropertyArticleQuery(reader.I64(), reader.Uuid(), reader.I64(), ReadValue(ref reader),
            reader.Text(PropertyQueryCursorChars));
        reader.Finish();
        Validate(input);
        return input;
    }

    public static byte[] EncodePropertyArticleQueryGroup(PropertyArticleQueryGroup input)
    {
        Validate(input);
        var hasKeyword = input.Keyword.Length != 0;
        return EncodeFrame(hasKeyword ? FrameType.PropertyKeywordQuery : FrameType.PropertyArticleQueryGroup, writer =>
        {
            writer.I64(input.SchemaRevision);
            if (hasKeyword) writer.Text(input.Keyword, AuthorArticleKeywordChars * 4);
            WritePropertyConditions(writer, input.Conditions);
            writer.Text(input.Cursor, PropertyQueryCursorChars);
        });
    }

    public static PropertyArticleQueryGroup DecodePropertyArticleQueryGroup(ReadOnlySpan<byte> frame)
    {
        var payload = Aeds.Decode(frame, out var type);
        var hasKeyword = type == FrameType.PropertyKeywordQuery;
        if (frame.Length > (hasKeyword ? PropertyKeywordQueryFrameBytes : PropertyQueryGroupFrameBytes)) throw InvalidProperty();
        if (type == FrameType.PropertyArticleQuery)
        {
            var exact = ReadPropertyArticleQuery(payload);
            return new(exact.SchemaRevision,
                [new(exact.DefinitionId, exact.DefinitionRevision, PropertyComparison.Equal, exact.Value)], exact.Cursor);
        }
        if (type != FrameType.PropertyArticleQueryGroup && !hasKeyword) throw InvalidProperty();
        var reader = new Reader(payload);
        var revision = reader.I64();
        var keyword = hasKeyword ? reader.Text(AuthorArticleKeywordChars * 4) : "";
        if (hasKeyword && keyword.Length == 0) throw InvalidProperty();
        var conditions = ReadPropertyConditions(ref reader);
        var input = new PropertyArticleQueryGroup(revision, conditions, reader.Text(PropertyQueryCursorChars), keyword);
        reader.Finish();
        Validate(input);
        return input;
    }

    public static byte[] EncodePropertyArticlePage(PropertyArticlePage page) =>
        EncodeFrame(FrameType.PropertyArticlePage, writer => writer.Text(page.NextCursor, PropertyQueryCursorChars)
            .Items(page.Rows, static (w, row) => w.I32(row.Id).I64(row.Revision).Text(row.Title, TitleBytes)));

    public static PropertyArticlePage DecodePropertyArticlePage(ReadOnlySpan<byte> frame) =>
        DecodeFrame(FrameType.PropertyArticlePage, frame, static (ref Reader reader) => new PropertyArticlePage(
            reader.Text(PropertyQueryCursorChars),
            reader.Items(0, PropertyPageSize, InvalidProperty,
                static (ref Reader r) => new PropertyArticleRow(r.I32(), r.I64(), r.Text(TitleBytes)))));

    internal static void Validate(PropertyFilterabilityCommand input) =>
        Check(input.DefinitionId != Guid.Empty && input.RequestId != Guid.Empty && input.SchemaRevision > 0 &&
            input.DefinitionRevision > 0 && input.DefinitionRevision <= input.SchemaRevision, InvalidProperty);

    private static void Validate(PropertyArticleQuery input) =>
        Check(ValidCondition(input.SchemaRevision, input.DefinitionId, input.DefinitionRevision, input.Value) &&
            ValidCursor(input.Cursor), InvalidProperty);

    private static void Validate(PropertyArticleQueryGroup input)
    {
        Check(ValidCursor(input.Cursor) && IsCanonicalAuthorArticleKeyword(input.Keyword), InvalidProperty);
        ValidatePropertyConditions(input.SchemaRevision, input.Conditions);
    }

    private static void WritePropertyConditions(Writer writer, IReadOnlyList<PropertyCondition> conditions) =>
        writer.Items(conditions, static (w, condition) =>
            WriteValue(w.Uuid(condition.DefinitionId).I64(condition.DefinitionRevision)
                .I32(PropertyComparisonCode(condition.Comparison, condition.AnyOf)), condition.Value));

    private static PropertyCondition[] ReadPropertyConditions(ref Reader reader, bool allowEmpty = false) =>
        reader.Items(allowEmpty ? 0 : 1, PropertyQueryConditionCount, InvalidProperty, static (ref Reader r) =>
        {
            var definition = r.Uuid();
            var revision = r.I64();
            var (comparison, anyOf) = ReadPropertyComparison(ref r);
            return new PropertyCondition(definition, revision, comparison, ReadValue(ref r), anyOf);
        });

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
        if (conditions.Count > PropertyQueryConditionCount) throw InvalidProperty();
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

    private static bool ValidCursor(string cursor) =>
        cursor.Length == 0 || cursor.Length == PropertyQueryCursorChars && IsBase64Url(cursor);

    public static bool IsCanonicalAuthorArticleKeyword(string keyword)
    {
        var remaining = keyword.AsSpan();
        if (remaining.Length > AuthorArticleKeywordChars || remaining.Trim().Length != remaining.Length) return false;
        while (!remaining.IsEmpty)
        {
            if (Rune.DecodeFromUtf16(remaining, out var scalar, out var width) != OperationStatus.Done || Rune.IsControl(scalar))
                return false;
            remaining = remaining[width..];
        }
        return true;
    }

    public static byte[] EncodePropertyTextHitRequest(PropertyTextHitRequest value) =>
        EncodeRecord(FrameType.PropertyTextHitRequest, value, ValidatePropertyTextHitRequest, static (writer, record) =>
            writer.I32(record.ArticleId).I64(record.ArticleRevision).I64(record.SchemaRevision).I64(record.ValueRevision)
                .Uuid(record.DefinitionId).I64(record.DefinitionRevision).FixedBytes(record.SourceDigest));

    public static PropertyTextHitRequest DecodePropertyTextHitRequest(ReadOnlySpan<byte> frame)
    {
        if (frame.Length != PropertyTextHitRequestFrameBytes) throw InvalidPropertyTextHitRequest();
        return DecodeRecord<PropertyTextHitRequest>(FrameType.PropertyTextHitRequest, frame, static (ref Reader reader) =>
            new(reader.I32(), reader.I64(), reader.I64(), reader.I64(), reader.Uuid(), reader.I64(),
                reader.FixedBytes(AuthorTextSearchSourceDigestBytes).ToArray()), ValidatePropertyTextHitRequest);
    }

    private static void ValidatePropertyTextHitRequest(PropertyTextHitRequest value) =>
        Check(value.ArticleId > 0 && value.ArticleRevision > 0 && value.SchemaRevision > 0 && value.ValueRevision >= 0 &&
            value.DefinitionId != Guid.Empty && value.DefinitionRevision > 0 && value.DefinitionRevision <= value.SchemaRevision &&
            value.SourceDigest.Length == AuthorTextSearchSourceDigestBytes, InvalidPropertyTextHitRequest);

    private static ProtocolException InvalidPropertyTextHitRequest() => new("Invalid saved text property match request.");

    public static string NormalizeSavedViewName(string name)
    {
        var value = name.Trim().Normalize(NormalizationForm.FormC);
        if (value.Length is 0 or > 128 || value.Any(char.IsControl) || Utf8.GetByteCount(value) > SavedViewNameBytes)
            throw InvalidSavedView();
        return value;
    }

    public static byte[] EncodeSavedViewCommand(SavedViewCommand command) =>
        EncodeRecord(FrameType.SavedViewCommand, command, Validate, static (writer, record) =>
            writer.I32((int)record.Action).Uuid(record.Id).I64(record.Revision).I64(record.CollectionRevision)
                .Uuid(record.RequestId).Text(record.Name, SavedViewNameBytes)
                .Bytes(record.Query is null ? [] : EncodePropertyArticleQueryGroup(record.Query)));

    public static SavedViewCommand DecodeSavedViewCommand(ReadOnlySpan<byte> frame)
    {
        var result = DecodeFrame(FrameType.SavedViewCommand, frame, SavedViewKeywordCommandFrameBytes, InvalidSavedView,
            static (ref Reader reader) =>
            {
                var action = (SavedViewAction)reader.I32();
                var id = reader.Uuid();
                var revision = reader.I64();
                var collection = reader.I64();
                var request = reader.Uuid();
                var name = reader.Text(SavedViewNameBytes);
                var query = reader.Bytes(PropertyKeywordQueryFrameBytes);
                return new SavedViewCommand(action, id, revision, collection, request, name,
                    query.IsEmpty ? null : DecodePropertyArticleQueryGroup(query));
            });
        Validate(result);
        if (result.Query is not { Keyword.Length: > 0 } && frame.Length > SavedViewCommandFrameBytes) throw InvalidSavedView();
        return result;
    }

    public static byte[] EncodeSavedViewReceipt(SavedViewReceipt receipt) =>
        EncodeFrame(FrameType.SavedViewReceipt, writer =>
            writer.Uuid(receipt.Id).I64(receipt.Revision).I64(receipt.CollectionRevision).Bool(receipt.Retired));

    public static SavedViewReceipt DecodeSavedViewReceipt(ReadOnlySpan<byte> frame)
    {
        var result = DecodeFrame(FrameType.SavedViewReceipt, frame,
            static (ref Reader reader) => new SavedViewReceipt(reader.Uuid(), reader.I64(), reader.I64(), reader.Bool()));
        return result.Id == Guid.Empty || result.Revision <= 0 || result.Revision > result.CollectionRevision
            ? throw InvalidSavedView() : result;
    }

    public static byte[] EncodeSavedViewCatalog(SavedViewCatalog catalog) =>
        EncodeFrame(FrameType.SavedViewCatalog, writer =>
            writer.I64(catalog.CollectionRevision).Uuid(catalog.NextId).Items(catalog.Views, WriteSavedViewSummary));

    public static SavedViewCatalog DecodeSavedViewCatalog(ReadOnlySpan<byte> frame) =>
        DecodeFrame(FrameType.SavedViewCatalog, frame, static (ref Reader reader) =>
        {
            var revision = reader.I64();
            var next = reader.Uuid();
            var count = reader.I32();
            if (revision < 0 || count is < 0 or > SavedViewPageSize) throw InvalidSavedView();
            var views = new SavedViewSummary[count];
            for (var i = 0; i < count; i++)
            {
                var entry = views[i] = ReadSavedViewSummary(ref reader, revision);
                if (i > 0 && entry.Id.CompareTo(views[i - 1].Id) <= 0) throw InvalidSavedView();
            }
            if (next != Guid.Empty && (count != SavedViewPageSize || next != views[^1].Id)) throw InvalidSavedView();
            return new SavedViewCatalog(revision, next, views);
        });

    public static byte[] EncodeSavedViewExecute(SavedViewExecute value) =>
        EncodeRecord(FrameType.SavedViewExecute, value, Validate, static (writer, record) =>
            writer.Uuid(record.Id).I64(record.Revision).Text(record.Cursor, PropertyQueryCursorChars));

    public static SavedViewExecute DecodeSavedViewExecute(ReadOnlySpan<byte> frame) =>
        DecodeRecord<SavedViewExecute>(FrameType.SavedViewExecute, frame,
            static (ref Reader reader) => new(reader.Uuid(), reader.I64(), reader.Text(PropertyQueryCursorChars)), Validate);

    public static byte[] EncodeSavedViewDefinition(IReadOnlyList<SavedViewCondition> conditions, string keyword = "")
    {
        Validate(new PropertyArticleQueryGroup(1, conditions.Select(item => new PropertyCondition(item.DefinitionId, 1,
            item.Comparison, item.Value, item.AnyOf)).ToArray(), "", keyword));
        var version = conditions.Any(item => item.AnyOf) ? 7 : keyword.Length != 0 ? 6 : conditions.Max(item => item.Comparison switch
        {
            PropertyComparison.ReferenceAnyOf => 5,
            PropertyComparison.SingleSelectAnyOf => 4,
            PropertyComparison.MultiSelectAnyOf => 3,
            PropertyComparison.IsPresent => 2,
            _ => 1,
        });
        var writer = new Writer().I32(version);
        if (version >= 6) writer.Text(keyword, AuthorArticleKeywordChars * 4);
        writer.I32(conditions.Count);
        foreach (var item in conditions.OrderBy(item => item.DefinitionId).ThenBy(item => item.Comparison)
                     .ThenBy(item => item.AnyOf ? PropertyOperandKey(item.Value) : "", StringComparer.Ordinal))
        {
            writer.Uuid(item.DefinitionId).I32((int)item.Kind).I32(PropertyComparisonCode(item.Comparison, item.AnyOf));
            if (item.Comparison is PropertyComparison.SingleSelectAnyOf or PropertyComparison.MultiSelectAnyOf)
            {
                var expectedKind = item.Comparison == PropertyComparison.SingleSelectAnyOf ? PropertyFieldKind.SingleSelect : PropertyFieldKind.MultiSelect;
                if (item.Kind != expectedKind || item.Value is not PropertyFieldValue.MultiSelect options || options.Value.Count > PropertyOptionCount)
                    throw InvalidSavedView();
                WriteValue(writer, new PropertyFieldValue.MultiSelect(options.Value.Order().ToArray()));
            }
            else if (item.Comparison == PropertyComparison.ReferenceAnyOf)
            {
                if (item.Kind != PropertyFieldKind.ArticleReference || item.Value is not PropertyFieldValue.ArticleReference references ||
                    references.Value.Count > PropertyOptionCount)
                    throw InvalidSavedView();
                WriteValue(writer, new PropertyFieldValue.ArticleReference(references.Value.Order().ToArray()));
            }
            else WriteValue(writer, item.Value);
        }
        return writer.Written.ToArray();
    }

    public static SavedViewDefinition DecodeSavedViewDefinition(ReadOnlySpan<byte> encoded, byte[] digest)
    {
        if (!CryptographicOperations.FixedTimeEquals(SHA256.HashData(encoded), digest)) throw InvalidSavedView();
        var reader = new Reader(encoded);
        var version = reader.I32();
        if (version is < 1 or > 7) throw InvalidSavedView();
        var keyword = version >= 6 ? reader.Text(AuthorArticleKeywordChars * 4) : "";
        var conditions = reader.Items(1, PropertyQueryConditionCount, InvalidSavedView, static (ref Reader r) =>
        {
            var definition = r.Uuid();
            var kind = ReadKind(ref r);
            var (comparison, anyOf) = ReadPropertyComparison(ref r);
            return new SavedViewCondition(definition, kind, comparison, ReadValue(ref r), anyOf);
        });
        reader.Finish();
        if (!encoded.SequenceEqual(EncodeSavedViewDefinition(conditions, keyword))) throw InvalidSavedView();
        return new(conditions, keyword);
    }

    public static byte[] EncodeSavedViewPlacementCommand(SavedViewPlacementCommand value) =>
        EncodeRecord(FrameType.SavedViewPlacementCommand, value, Validate, static (writer, record) =>
            writer.I32((int)record.Action).Uuid(record.Id).I64(record.Revision)
                .I64(record.CollectionRevision).Uuid(record.RequestId).Uuid(record.BeforeId));

    public static SavedViewPlacementCommand DecodeSavedViewPlacementCommand(ReadOnlySpan<byte> frame) =>
        DecodeRecord<SavedViewPlacementCommand>(FrameType.SavedViewPlacementCommand, frame, static (ref Reader reader) =>
            new((SavedViewPlacementAction)reader.I32(), reader.Uuid(), reader.I64(), reader.I64(),
                reader.Uuid(), reader.Uuid()), Validate);

    public static byte[] EncodeSavedViewPlacement(SavedViewPlacement value) =>
        EncodeFrame(FrameType.SavedViewPlacement, writer => writer.I64(value.CollectionRevision)
            .Optional(value.Default, WriteSavedViewSummary).Optional(value.Requested, WriteSavedViewSummary)
            .Bool(value.RequestedPinned).I32(value.NextOffset).Items(value.Pins, WriteSavedViewSummary));

    public static SavedViewPlacement DecodeSavedViewPlacement(ReadOnlySpan<byte> frame) =>
        DecodeFrame(FrameType.SavedViewPlacement, frame, static (ref Reader reader) =>
        {
            var revision = reader.I64();
            var fallback = reader.Optional((ref Reader r) => ReadSavedViewSummary(ref r, revision));
            var requested = reader.Optional((ref Reader r) => ReadSavedViewSummary(ref r, revision));
            var requestedPinned = reader.Bool();
            var next = reader.I32();
            var count = reader.I32();
            if (requestedPinned && requested is null || revision < 0 || count is < 0 or > SavedViewPageSize ||
                next is < 0 or > SavedViewMaxCount || next != 0 && count != SavedViewPageSize) throw InvalidSavedView();
            var pins = new SavedViewSummary[count];
            for (var i = 0; i < count; ++i) pins[i] = ReadSavedViewSummary(ref reader, revision);
            if (pins.Select(pin => pin.Id).Distinct().Count() != count) throw InvalidSavedView();
            return new SavedViewPlacement(revision, fallback, requested, requestedPinned, next, pins);
        });

    private static void WriteSavedViewSummary(Writer writer, SavedViewSummary entry) =>
        writer.Uuid(entry.Id).I64(entry.Revision).Text(entry.Name, SavedViewNameBytes);

    private static SavedViewSummary ReadSavedViewSummary(ref Reader reader, long revision)
    {
        var value = new SavedViewSummary(reader.Uuid(), reader.I64(), reader.Text(SavedViewNameBytes));
        return value.Id == Guid.Empty || value.Revision <= 0 || value.Revision > revision ||
            value.Name != NormalizeSavedViewName(value.Name) ? throw InvalidSavedView() : value;
    }

    private static void Validate(SavedViewExecute value) =>
        Check(value.Id != Guid.Empty && value.Revision > 0 && ValidCursor(value.Cursor), InvalidSavedView);

    private static void Validate(SavedViewCommand value)
    {
        Check(value.Id != Guid.Empty && value.RequestId != Guid.Empty && value.Revision >= 0 && value.CollectionRevision >= value.Revision &&
            Enum.IsDefined(value.Action) && (value.Action == SavedViewAction.Save || value.Revision != 0) &&
            (value.Action == SavedViewAction.Save) == (value.Query is not null) && value.Query is not { Cursor.Length: > 0 }, InvalidSavedView);
        if (value.Action == SavedViewAction.Retire) Check(value.Name.Length == 0, InvalidSavedView);
        else NormalizeSavedViewName(value.Name);
    }

    private static void Validate(SavedViewPlacementCommand value) =>
        Check(Enum.IsDefined(value.Action) && value.Id != Guid.Empty && value.RequestId != Guid.Empty && value.Revision > 0 &&
            value.CollectionRevision >= value.Revision && value.BeforeId != value.Id &&
            (value.Action == SavedViewPlacementAction.MoveBefore || value.BeforeId == Guid.Empty), InvalidSavedView);

    private static ProtocolException InvalidSavedView() => new("Invalid saved view.");
}
