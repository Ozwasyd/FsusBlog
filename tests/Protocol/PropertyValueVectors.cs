using System.Security.Cryptography;
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

        var groupBytes = Fixture("property-query-group");
        var group = new PropertyArticleQueryGroup(10,
        [
            new(value.DefinitionId, 2, PropertyComparison.AtLeast, number),
            new(Guid.Parse("12345678-1234-4000-9000-123456789abc"), 3, PropertyComparison.AtMost,
                new PropertyFieldValue.Date(new DateTimeOffset(2024, 2, 29, 14, 12, 6, 15, TimeSpan.Zero))),
        ], "");
        BytesEqual(groupBytes, Wire.EncodePropertyArticleQueryGroup(group));
        var decoded = Wire.DecodePropertyArticleQueryGroup(groupBytes);
        if (decoded.SchemaRevision != group.SchemaRevision || decoded.Cursor != "" || !decoded.Conditions.SequenceEqual(group.Conditions))
            throw new InvalidOperationException("Property group differs from the independent byte vector.");
        var invalidGroup = Aeds.Decode(groupBytes, FrameType.PropertyArticleQueryGroup).ToArray();
        invalidGroup[36] = 6;
        Reject(() => Wire.DecodePropertyArticleQueryGroup(Aeds.Encode(FrameType.PropertyArticleQueryGroup, invalidGroup)));
        invalidGroup[36] = 5;
        Reject(() => Wire.DecodePropertyArticleQueryGroup(Aeds.Encode(FrameType.PropertyArticleQueryGroup, invalidGroup)));

        var presence = new PropertyCondition(value.DefinitionId, 2, PropertyComparison.IsPresent, new PropertyFieldValue.Missing());
        var presenceBytes = Fixture("property-query-presence");
        BytesEqual(presenceBytes, Wire.EncodePropertyArticleQueryGroup(new(10, [presence], "")));
        if (Wire.DecodePropertyArticleQueryGroup(presenceBytes).Conditions.Single() != presence)
            throw new InvalidOperationException("Property presence lost its operand-free wire identity.");
        var saved = new SavedViewCondition(presence.DefinitionId, PropertyFieldKind.Number, presence.Comparison, presence.Value);
        var legacy = saved with { Comparison = PropertyComparison.Equal };
        VerifyStoredDefinition(1, legacy);
        VerifyStoredDefinition(2, saved);

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

    private static void VerifyStoredDefinition(byte version, SavedViewCondition condition)
    {
        var definition = Wire.EncodeSavedViewDefinition([condition]);
        var expected = Convert.FromHexString("0100000001000000000000000000400080000000000000060100000000000000feffffff");
        expected[0] = version;
        expected[28] = (byte)condition.Comparison;
        BytesEqual(expected, definition);
        if (Wire.DecodeSavedViewDefinition(definition, SHA256.HashData(definition)).Single() != condition)
            throw new InvalidOperationException("Stored saved view lost its original comparison.");
        definition[0] = version == 1 ? (byte)2 : (byte)1;
        Reject(() => Wire.DecodeSavedViewDefinition(definition, SHA256.HashData(definition)));
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
