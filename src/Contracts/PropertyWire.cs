namespace FsusBlog.V2.Contracts;

public sealed record PropertyTextField(Guid DefinitionId, long DefinitionRevision, string MachineKey, string Label,
    bool Deprecated, string? Value);
public sealed record PropertyWorkspace(int ArticleId, long ArticleRevision, long SchemaRevision, long ValueRevision,
    string NextKey, IReadOnlyList<PropertyTextField> Fields);

public static partial class Wire
{
    public static byte[] EncodePropertyWorkspace(PropertyWorkspace workspace)
    {
        ArgumentOutOfRangeException.ThrowIfGreaterThan(workspace.Fields.Count, WireLimits.PropertyPageSize);
        var writer = new Writer();
        writer.I32(workspace.ArticleId);
        writer.I64(workspace.ArticleRevision);
        writer.I64(workspace.SchemaRevision);
        writer.I64(workspace.ValueRevision);
        writer.Text(workspace.NextKey, WireLimits.PropertyKeyBytes);
        writer.I32(workspace.Fields.Count);
        foreach (var field in workspace.Fields)
        {
            writer.Uuid(field.DefinitionId);
            writer.I64(field.DefinitionRevision);
            writer.Text(field.MachineKey, WireLimits.PropertyKeyBytes);
            writer.Text(field.Label, WireLimits.PropertyLabelBytes);
            writer.Bool(field.Deprecated);
            writer.Bool(field.Value is not null);
            if (field.Value is { } value) writer.Text(value, WireLimits.PropertyValueBytes);
        }
        return Aeds.Encode(FrameType.PropertyWorkspace, writer.Written);
    }

    public static PropertyWorkspace DecodePropertyWorkspace(ReadOnlySpan<byte> frame)
    {
        var reader = new Reader(Aeds.Decode(frame, FrameType.PropertyWorkspace));
        int article = reader.I32();
        long articleRevision = reader.I64();
        long schemaRevision = reader.I64();
        long valueRevision = reader.I64();
        string nextKey = reader.Text(WireLimits.PropertyKeyBytes);
        int size = reader.I32();
        if (article <= 0 || articleRevision <= 0 || schemaRevision < 0 || valueRevision < 0 ||
            size is < 0 or > WireLimits.PropertyPageSize || nextKey.Length != 0 && size == 0)
            throw new ProtocolException("Invalid property page.");
        var fields = new PropertyTextField[size];
        var seen = new HashSet<Guid>();
        for (int i = 0; i < fields.Length; i++)
        {
            var field = new PropertyTextField(reader.Uuid(), reader.I64(), reader.Text(WireLimits.PropertyKeyBytes),
                reader.Text(WireLimits.PropertyLabelBytes), reader.Bool(),
                reader.Bool() ? reader.Text(WireLimits.PropertyValueBytes) : null);
            if (field.DefinitionId == Guid.Empty || !seen.Add(field.DefinitionId) || field.DefinitionRevision <= 0 ||
                !ValidPropertyKey(field.MachineKey) || string.IsNullOrWhiteSpace(field.Label) ||
                i > 0 && StringComparer.Ordinal.Compare(fields[i - 1].MachineKey, field.MachineKey) >= 0)
                throw new ProtocolException("Invalid property item.");
            fields[i] = field;
        }
        if (nextKey.Length != 0 && (size != WireLimits.PropertyPageSize || fields[^1].MachineKey != nextKey))
            throw new ProtocolException("Invalid property cursor.");
        reader.Finish();
        return new(article, articleRevision, schemaRevision, valueRevision, nextKey, fields);
    }

    internal static void Validate(PropertyDefinitionCommand input)
    {
        if (input.DefinitionId == Guid.Empty || input.RequestId == Guid.Empty || input.SchemaRevision < 0
            || input.DefinitionRevision < 0 || input.Operation is < 1 or > 4
            || (input.Operation == 1) != (input.DefinitionRevision == 0)
            || (input.Operation == 1) != (input.MachineKey.Length != 0)
            || (input.Operation is 1 or 2) != (input.Label.Length != 0))
            throw new ProtocolException("Invalid property definition command.");
    }

    internal static void Validate(PropertyWorkspaceRequest input)
    {
        if (input.ArticleId <= 0 || input.ArticleRevision <= 0 || input.SchemaRevision < 0 || input.ValueRevision < 0
            || (input.AfterKey.Length == 0 ? input.SchemaRevision != 0 || input.ValueRevision != 0 : !ValidPropertyKey(input.AfterKey)))
            throw new ProtocolException("Invalid property workspace request.");
    }

    internal static void Validate(PropertyTextCommand input)
    {
        if (input.ArticleId <= 0 || input.ArticleRevision <= 0 || input.DefinitionId == Guid.Empty || input.RequestId == Guid.Empty
            || input.SchemaRevision <= 0 || input.DefinitionRevision <= 0 || input.ValueRevision < 0
            || input.Remove && input.Value.Length != 0)
            throw new ProtocolException("Invalid property value command.");
    }

    internal static void Validate(PropertyCommandReceipt input)
    {
        if (input.DefinitionId == Guid.Empty || input.SchemaRevision <= 0 || input.Revision <= 0)
            throw new ProtocolException("Invalid property receipt.");
    }

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
}
