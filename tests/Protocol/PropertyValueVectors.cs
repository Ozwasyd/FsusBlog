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

        var batch = new PropertyValueBatchInput(17, articleRevision, 10, 8, requestId,
        [
            new(value.DefinitionId, 1, number),
            new(Guid.Parse("00000000-0000-4000-8000-000000000004"), 3, new PropertyFieldValue.Missing())
        ]);
        var batchBytes = Fixture("property-value-batch");
        BytesEqual(batchBytes, Wire.EncodePropertyValueBatch(batch));
        var decodedBatch = Wire.DecodePropertyValueBatch(batchBytes);
        if (decodedBatch with { Changes = batch.Changes } != batch ||
            !decodedBatch.Changes.SequenceEqual(batch.Changes))
            throw new InvalidOperationException("Property batch differs from the independent byte vector.");
        Reject(() => Wire.EncodePropertyValueBatch(batch with { Changes = [batch.Changes[0], batch.Changes[0]] }));
        var invalidBatch = Aeds.Decode(batchBytes, FrameType.PropertyValueBatchCommand).ToArray();
        invalidBatch[44] = checked((byte)(WireLimits.PropertyBatchMaxChanges + 1));
        Reject(() => Wire.DecodePropertyValueBatch(Aeds.Encode(FrameType.PropertyValueBatchCommand, invalidBatch)));
        var batchReceipt = new PropertyValueBatchReceipt(17, 10, 9, requestId);
        var batchReceiptBytes = Fixture("property-value-batch-receipt");
        BytesEqual(batchReceiptBytes, Wire.EncodePropertyValueBatchReceipt(batchReceipt));
        if (Wire.DecodePropertyValueBatchReceipt(batchReceiptBytes) != batchReceipt)
            throw new InvalidOperationException("Property batch receipt differs from the independent byte vector.");

        var groupBytes = Fixture("property-query-group");
        var group = new PropertyArticleQueryGroup(10,
        [
            new(value.DefinitionId, 2, PropertyComparison.AtLeast, number),
            new(Guid.Parse("12345678-1234-4000-9000-123456789abc"), 3, PropertyComparison.AtMost,
                new PropertyFieldValue.Date(new DateTimeOffset(2024, 2, 29, 14, 12, 6, 15, TimeSpan.Zero))),
        ], "");
        BytesEqual(groupBytes, Wire.EncodePropertyArticleQueryGroup(group));
        var decoded = Wire.DecodePropertyArticleQueryGroup(groupBytes);
        if (decoded.SchemaRevision != group.SchemaRevision || decoded.Cursor != "" || decoded.Keyword != "" ||
            !decoded.Conditions.SequenceEqual(group.Conditions))
            throw new InvalidOperationException("Property group differs from the independent byte vector.");
        var alternativeGroup = group with { Conditions = [
            new(value.DefinitionId, 2, PropertyComparison.Equal, new PropertyFieldValue.Number(0), true),
            new(value.DefinitionId, 2, PropertyComparison.Equal, new PropertyFieldValue.Number(19.75m), true),
        ] };
        var alternativeBytes = Fixture("property-query-alternatives");
        BytesEqual(alternativeBytes, Wire.EncodePropertyArticleQueryGroup(alternativeGroup));
        if (!Wire.DecodePropertyArticleQueryGroup(alternativeBytes).Conditions.SequenceEqual(alternativeGroup.Conditions))
            throw new InvalidOperationException("Property alternatives differ from the independent byte vector.");
        var splitGroup = Aeds.Decode(alternativeBytes, FrameType.PropertyArticleQueryGroup).ToArray();
        splitGroup[37] = 0;
        Reject(() => Wire.DecodePropertyArticleQueryGroup(Aeds.Encode(FrameType.PropertyArticleQueryGroup, splitGroup)));
        var savedAlternatives = alternativeGroup.Conditions.Select(item =>
            new SavedViewCondition(item.DefinitionId, PropertyFieldKind.Number, item.Comparison, item.Value, item.AnyOf)).ToArray();
        BytesEqual(Wire.EncodeSavedViewDefinition(savedAlternatives), Wire.EncodeSavedViewDefinition(savedAlternatives.Reverse().ToArray()));
        var invalidGroup = Aeds.Decode(groupBytes, FrameType.PropertyArticleQueryGroup).ToArray();
        invalidGroup[36] = 9;
        Reject(() => Wire.DecodePropertyArticleQueryGroup(Aeds.Encode(FrameType.PropertyArticleQueryGroup, invalidGroup)));
        invalidGroup[36] = 5;
        Reject(() => Wire.DecodePropertyArticleQueryGroup(Aeds.Encode(FrameType.PropertyArticleQueryGroup, invalidGroup)));
        invalidGroup[36] = 6;
        Reject(() => Wire.DecodePropertyArticleQueryGroup(Aeds.Encode(FrameType.PropertyArticleQueryGroup, invalidGroup)));
        invalidGroup[36] = 7;
        Reject(() => Wire.DecodePropertyArticleQueryGroup(Aeds.Encode(FrameType.PropertyArticleQueryGroup, invalidGroup)));
        invalidGroup[36] = 8;
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
        var alternatives = new PropertyFieldValue.MultiSelect([blue.Id, red.Id]);
        var overlap = new PropertyCondition(value.DefinitionId, 2, PropertyComparison.MultiSelectAnyOf, alternatives);
        var overlapBytes = Fixture("property-query-multi-select-any-of");
        BytesEqual(overlapBytes, Wire.EncodePropertyArticleQueryGroup(new(10, [overlap], "")));
        BytesEqual(overlapBytes, Wire.EncodePropertyArticleQueryGroup(Wire.DecodePropertyArticleQueryGroup(overlapBytes)));
        var anotherField = saved with { DefinitionId = group.Conditions[1].DefinitionId };
        VerifyStoredOverlap(3, new(overlap.DefinitionId, PropertyFieldKind.MultiSelect, overlap.Comparison, overlap.Value), anotherField,
            "03000000010000000000000000004000800000000000000605000000060000000500000002000000af970001222240008000112233445566af970002222240008000112233445566");

        var single = overlap with { Comparison = PropertyComparison.SingleSelectAnyOf };
        var singleBytes = Fixture("property-query-single-select-any-of");
        BytesEqual(singleBytes, Wire.EncodePropertyArticleQueryGroup(new(10, [single], "")));
        BytesEqual(singleBytes, Wire.EncodePropertyArticleQueryGroup(Wire.DecodePropertyArticleQueryGroup(singleBytes)));
        Reject(() => Wire.EncodePropertyArticleQueryGroup(new(10, [single with { Value = new PropertyFieldValue.MultiSelect([]) }], "")));
        var empty = Wire.EncodePropertyArticleQueryGroup(new(10, [overlap with { Value = new PropertyFieldValue.MultiSelect([]) }], ""));
        var emptySingle = Aeds.Decode(empty, FrameType.PropertyArticleQueryGroup).ToArray();
        emptySingle[36] = 7;
        Reject(() => Wire.DecodePropertyArticleQueryGroup(Aeds.Encode(FrameType.PropertyArticleQueryGroup, emptySingle)));
        VerifyStoredOverlap(4, new(single.DefinitionId, PropertyFieldKind.SingleSelect, single.Comparison, single.Value), anotherField,
            "04000000010000000000000000004000800000000000000604000000070000000500000002000000af970001222240008000112233445566af970002222240008000112233445566");

        var referenceAnyOf = new PropertyCondition(value.DefinitionId, 2, PropertyComparison.ReferenceAnyOf,
            new PropertyFieldValue.ArticleReference([42, 17]));
        var referenceBytes = Fixture("property-query-reference-any-of");
        BytesEqual(referenceBytes, Wire.EncodePropertyArticleQueryGroup(new(10, [referenceAnyOf], "")));
        BytesEqual(referenceBytes, Wire.EncodePropertyArticleQueryGroup(Wire.DecodePropertyArticleQueryGroup(referenceBytes)));
        var referenceView = new SavedViewCondition(value.DefinitionId, PropertyFieldKind.ArticleReference,
            referenceAnyOf.Comparison, referenceAnyOf.Value);
        var referenceDefinition = Wire.EncodeSavedViewDefinition([referenceView]);
        BytesEqual(Convert.FromHexString("05000000010000000000000000004000800000000000000606000000080000000600000002000000110000002a000000"),
            referenceDefinition);
        var decodedReference = Wire.DecodeSavedViewDefinition(referenceDefinition, SHA256.HashData(referenceDefinition));
        BytesEqual(referenceDefinition, Wire.EncodeSavedViewDefinition(decodedReference.Conditions, decodedReference.Keyword));
        Reject(() => Wire.EncodeSavedViewDefinition([referenceView with { Kind = PropertyFieldKind.MultiSelect }]));
        referenceDefinition[0] = 4;
        Reject(() => Wire.DecodeSavedViewDefinition(referenceDefinition, SHA256.HashData(referenceDefinition)));

        const string keyword = "%_雪";
        var keywordBytes = Fixture("property-query-keyword");
        var keywordQuery = new PropertyArticleQueryGroup(10, [presence], "", keyword);
        BytesEqual(keywordBytes, Wire.EncodePropertyArticleQueryGroup(keywordQuery));
        var decodedKeyword = Wire.DecodePropertyArticleQueryGroup(keywordBytes);
        if (decodedKeyword.Keyword != keyword || decodedKeyword.SchemaRevision != 10 || decodedKeyword.Cursor != "" ||
            decodedKeyword.Conditions.Single() != presence)
            throw new InvalidOperationException("The keyword frame lost its exact search and property coordinates.");
        var invalidKeyword = Aeds.Decode(presenceBytes, FrameType.PropertyArticleQueryGroup).ToArray().ToList();
        invalidKeyword.InsertRange(8, new byte[4]);
        Reject(() => Wire.DecodePropertyArticleQueryGroup(Aeds.Encode(FrameType.PropertyKeywordQuery, invalidKeyword.ToArray())));
        Reject(() => Wire.EncodePropertyArticleQueryGroup(keywordQuery with { Keyword = " " + keyword }));
        Reject(() => Wire.EncodePropertyArticleQueryGroup(keywordQuery with { Keyword = new string('雪', 129) }));
        Reject(() => Wire.EncodePropertyArticleQueryGroup(keywordQuery with { Keyword = "a\u0085b" }));
        Reject(() => Wire.EncodePropertyArticleQueryGroup(keywordQuery with { Keyword = "\ud800" }));
        var storedKeyword = Wire.EncodeSavedViewDefinition([saved], keyword);
        BytesEqual(Convert.FromHexString("0600000005000000255fe99baa01000000000000000000400080000000000000060100000005000000feffffff"),
            storedKeyword);
        var decodedStoredKeyword = Wire.DecodeSavedViewDefinition(storedKeyword, SHA256.HashData(storedKeyword));
        if (decodedStoredKeyword.Keyword != keyword || decodedStoredKeyword.Conditions.Single() != saved)
            throw new InvalidOperationException("Stored v6 saved view lost its search or property condition.");
        var invalidStoredKeyword = Wire.EncodeSavedViewDefinition([saved]).ToList();
        invalidStoredKeyword[0] = 6;
        invalidStoredKeyword.InsertRange(4, new byte[4]);
        var storedWithoutKeyword = invalidStoredKeyword.ToArray();
        Reject(() => Wire.DecodeSavedViewDefinition(storedWithoutKeyword, SHA256.HashData(storedWithoutKeyword)));

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
        var decoded = Wire.DecodeSavedViewDefinition(definition, SHA256.HashData(definition));
        if (decoded.Keyword != "" || decoded.Conditions.Single() != condition)
            throw new InvalidOperationException("Stored saved view lost its original comparison.");
        definition[0] = 3;
        Reject(() => Wire.DecodeSavedViewDefinition(definition, SHA256.HashData(definition)));
        definition[0] = version == 1 ? (byte)2 : (byte)1;
        Reject(() => Wire.DecodeSavedViewDefinition(definition, SHA256.HashData(definition)));
    }

    private static void VerifyStoredOverlap(byte version, SavedViewCondition overlap, SavedViewCondition presence, string hex)
    {
        var expected = Convert.FromHexString(hex);
        var definition = Wire.EncodeSavedViewDefinition([overlap]);
        BytesEqual(expected, definition);
        var decoded = Wire.DecodeSavedViewDefinition(definition, SHA256.HashData(definition));
        BytesEqual(expected, Wire.EncodeSavedViewDefinition(decoded.Conditions, decoded.Keyword));
        var mixed = Wire.EncodeSavedViewDefinition([overlap, presence]);
        if (mixed[0] != version || Wire.DecodeSavedViewDefinition(mixed, SHA256.HashData(mixed)).Conditions.Count != 2)
            throw new InvalidOperationException("Mixed comparisons did not use the overlap definition revision.");
        var otherKind = overlap.Kind == PropertyFieldKind.SingleSelect ? PropertyFieldKind.MultiSelect : PropertyFieldKind.SingleSelect;
        Reject(() => Wire.EncodeSavedViewDefinition([overlap with { Kind = otherKind }]));
        definition[0] = (byte)(version - 1);
        Reject(() => Wire.DecodeSavedViewDefinition(definition, SHA256.HashData(definition)));
        definition[0] = (byte)(version + 1);
        Reject(() => Wire.DecodeSavedViewDefinition(definition, SHA256.HashData(definition)));
        definition[0] = version;
        var reversed = definition[56..];
        definition.AsSpan(40, 16).CopyTo(definition.AsSpan(56));
        reversed.CopyTo(definition, 40);
        Reject(() => Wire.DecodeSavedViewDefinition(definition, SHA256.HashData(definition)));
    }

    private static void BytesEqual(ReadOnlySpan<byte> expected, ReadOnlySpan<byte> actual)
    {
        if (!expected.SequenceEqual(actual))
            throw new InvalidOperationException("Typed properties differ from the independent byte vector.");
    }

    private static void Reject(Action action) =>
        ProtocolRejection.Assert(action, "Invalid typed property input was accepted.");
}
