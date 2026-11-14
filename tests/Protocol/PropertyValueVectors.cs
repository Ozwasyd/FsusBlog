using FsusBlog.V2.Contracts;

internal static class PropertyValueVectors
{
    internal static void Run(string fixtures)
    {
        byte[] Fixture(string name) => Convert.FromHexString(File.ReadAllText(Path.Combine(fixtures, name + ".hex")).Trim());

        var red = new PropertyFieldOption(Guid.Parse("af970001-2222-4000-8000-112233445566"), "Red");
        var blue = new PropertyFieldOption(Guid.Parse("af970002-2222-4000-8000-112233445566"), "蓝色");
        var requestId = Guid.Parse("0a0b0c0d-1111-4000-8000-010203040506");
        var number = new PropertyFieldValue.Number(-9007199254740993.000000000001m);
        const long articleRevision = 9_007_199_254_740_993;

        var editorBytes = Fixture("property-editor-typed");
        var editor = Wire.DecodePropertyEditor(editorBytes);
        BytesEqual(editorBytes, Wire.EncodePropertyEditor(editor));
        if (editor.ArticleId != 17 || editor.ArticleRevision != articleRevision || editor.SchemaRevision != 10 ||
            editor.ValueRevision != 8 || editor.NextKey.Length != 0 || editor.Fields.Count != 10 ||
            editor.Fields[0].Value is not PropertyFieldValue.ArticleReference reference ||
            !reference.Value.SequenceEqual([5, 40]) || editor.Fields[1].Value != new PropertyFieldValue.Boolean(false) ||
            editor.Fields[2].Value != new PropertyFieldValue.Date(new DateTimeOffset(2024, 2, 29, 14, 12, 6, 15, TimeSpan.Zero)) ||
            editor.Fields[3].Value is not PropertyFieldValue.MultiSelect multiple ||
            !multiple.Value.SequenceEqual([blue.Id, red.Id]) || !editor.Fields[3].Options.SequenceEqual([red, blue]) ||
            editor.Fields[4].Value is not PropertyFieldValue.Null || editor.Fields[5].Value != number ||
            editor.Fields[6].Value != new PropertyFieldValue.SingleSelect(blue.Id) || !editor.Fields[6].Deprecated ||
            editor.Fields[7].Value != new PropertyFieldValue.Text("空值不同于未设置 🐈") ||
            editor.Fields[8].Value is not PropertyFieldValue.Missing ||
            editor.Fields[9].Value != new PropertyFieldValue.Url("https://example.org/a?q=x%20y"))
            throw new InvalidOperationException("Typed property editor differs from independent records.");

        var valueBytes = Fixture("property-value-exact-decimal");
        var value = new PropertyValueInput(17, articleRevision, 10, 8, Guid.Parse("00000000-0000-4000-8000-000000000006"),
            1, requestId, number);
        BytesEqual(valueBytes, Wire.EncodePropertyValueInput(value));
        if (Wire.DecodePropertyValueInput(valueBytes) != value)
            throw new InvalidOperationException("Typed property command changed the exact decimal or coordinates.");
        Reject(() => Wire.EncodePropertyValueInput(value with { Value = new PropertyFieldValue.Unavailable() }));

        var schemaBytes = Fixture("property-definition-options");
        var schema = new PropertySchemaInput(new(1, Guid.Parse("00000000-0000-4000-8000-000000000004"), requestId,
            10, 0, "multi", "Multiple"), PropertyFieldKind.MultiSelect, [red, blue]);
        BytesEqual(schemaBytes, Wire.EncodePropertySchemaInput(schema));
        var schemaDecoded = Wire.DecodePropertySchemaInput(schemaBytes);
        if (schemaDecoded.Command != schema.Command || schemaDecoded.Kind != schema.Kind ||
            !schemaDecoded.Options.SequenceEqual(schema.Options))
            throw new InvalidOperationException("Stable option identities differ from independent typed definition.");
        Reject(() => Wire.DecodePropertyEditor(editorBytes.AsSpan(0, editorBytes.Length - 1)));
    }

    private static void BytesEqual(ReadOnlySpan<byte> expected, ReadOnlySpan<byte> actual)
    {
        if (!expected.SequenceEqual(actual))
            throw new InvalidOperationException("Typed properties differ from the independent byte vector.");
    }

    private static void Reject(Action action)
    {
        try { action(); }
        catch (ProtocolException) { return; }
        throw new InvalidOperationException("Invalid typed property input was accepted.");
    }
}
