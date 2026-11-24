internal static class PropertyValueVectors
{
    internal static void Run(string fixtures)
    {
        byte[] Fixture(string name) => Hex(fixtures, name + ".hex");
        void CheckAnyOf(string name, PropertyCondition condition)
        {
            var frame = Fixture(name);
            Equal(frame, Wire.EncodePropertyArticleQueryGroup(new(10, [condition], "")));
            Equal(frame, Wire.EncodePropertyArticleQueryGroup(Wire.DecodePropertyArticleQueryGroup(frame)));
        }

        var red = new PropertyFieldOption(Guid.Parse("af970001-2222-4000-8000-112233445566"), "Red");
        var blue = new PropertyFieldOption(Guid.Parse("af970002-2222-4000-8000-112233445566"), "蓝色");
        var requestId = Guid.Parse("0a0b0c0d-1111-4000-8000-010203040506");
        var number = new PropertyFieldValue.Number(-9007199254740993.000000000001m);
        const long articleRevision = 9_007_199_254_740_993;

        var editorBytes = Fixture("property-editor-typed");
        var editor = Wire.DecodePropertyEditor(editorBytes);
        Equal(editorBytes, Wire.EncodePropertyEditor(editor));
        Require(editor.ArticleId == 17 && editor.ArticleRevision == articleRevision && editor.SchemaRevision == 10 &&
            editor.ValueRevision == 8 && editor.NextKey.Length == 0 && editor.Fields.Count == 10 &&
            editor.Fields[0].Value is PropertyFieldValue.ArticleReference reference && reference.Value.SequenceEqual([5, 40]) &&
            editor.Fields[1].Value == new PropertyFieldValue.Boolean(false) &&
            editor.Fields[2].Value == new PropertyFieldValue.Date(new DateTimeOffset(2024, 2, 29, 14, 12, 6, 15, TimeSpan.Zero)) &&
            editor.Fields[3].Value is PropertyFieldValue.MultiSelect multiple && multiple.Value.SequenceEqual([blue.Id, red.Id]) &&
            editor.Fields[3].Options.SequenceEqual([red, blue]) && editor.Fields[4].Value is PropertyFieldValue.Null &&
            editor.Fields[5].Value == number && editor.Fields[6].Value == new PropertyFieldValue.SingleSelect(blue.Id) &&
            editor.Fields[6].Deprecated && editor.Fields[7].Value == new PropertyFieldValue.Text("空值不同于未设置 🐈") &&
            editor.Fields[8].Value is PropertyFieldValue.Missing && editor.Fields[9].Value == new PropertyFieldValue.Url("https://example.org/a?q=x%20y"));

        var value = new PropertyValueInput(17, articleRevision, 10, 8, Guid.Parse("00000000-0000-4000-8000-000000000006"), 1, requestId, number);
        CheckRoundTrip(Fixture("property-value-exact-decimal"), value, Wire.EncodePropertyValueInput, b => Wire.DecodePropertyValueInput(b));
        Reject(() => Wire.EncodePropertyValueInput(value with { Value = new PropertyFieldValue.Unavailable() }));

        var batch = new PropertyValueBatchInput(17, articleRevision, 10, 8, requestId,
            [new(value.DefinitionId, 1, number), new(Guid.Parse("00000000-0000-4000-8000-000000000004"), 3, new PropertyFieldValue.Missing())]);
        var batchBytes = Fixture("property-value-batch");
        Equal(batchBytes, Wire.EncodePropertyValueBatch(batch));
        var decodedBatch = Wire.DecodePropertyValueBatch(batchBytes);
        Require(decodedBatch with { Changes = batch.Changes } == batch && decodedBatch.Changes.SequenceEqual(batch.Changes));
        var batchPayload = Aeds.Decode(batchBytes, FrameType.PropertyValueBatchCommand).ToArray();
        RejectAll(
            () => Wire.EncodePropertyValueBatch(batch with { Changes = [batch.Changes[0], batch.Changes[0]] }),
            () => Wire.DecodePropertyValueBatch(Aeds.Encode(FrameType.PropertyValueBatchCommand, WithByte(batchPayload, 44, checked((byte)(WireLimits.PropertyBatchMaxChanges + 1))))));
        CheckRoundTrip(Fixture("property-value-batch-receipt"), new PropertyValueBatchReceipt(17, 10, 9, requestId),
            Wire.EncodePropertyValueBatchReceipt, b => Wire.DecodePropertyValueBatchReceipt(b));

        var groupBytes = Fixture("property-query-group");
        var group = new PropertyArticleQueryGroup(10, [
            new(value.DefinitionId, 2, PropertyComparison.AtLeast, number),
            new(Guid.Parse("12345678-1234-4000-9000-123456789abc"), 3, PropertyComparison.AtMost,
                new PropertyFieldValue.Date(new DateTimeOffset(2024, 2, 29, 14, 12, 6, 15, TimeSpan.Zero))),
        ], "");
        Equal(groupBytes, Wire.EncodePropertyArticleQueryGroup(group));
        var decoded = Wire.DecodePropertyArticleQueryGroup(groupBytes);
        Require(decoded.SchemaRevision == group.SchemaRevision && decoded.Cursor == "" && decoded.Keyword == "" && decoded.Conditions.SequenceEqual(group.Conditions));
        var alternativeGroup = group with { Conditions = [
            new(value.DefinitionId, 2, PropertyComparison.Equal, new PropertyFieldValue.Number(0), true),
            new(value.DefinitionId, 2, PropertyComparison.Equal, new PropertyFieldValue.Number(19.75m), true),
        ] };
        var alternativeBytes = Fixture("property-query-alternatives");
        Equal(alternativeBytes, Wire.EncodePropertyArticleQueryGroup(alternativeGroup));
        Require(Wire.DecodePropertyArticleQueryGroup(alternativeBytes).Conditions.SequenceEqual(alternativeGroup.Conditions));
        Reject(() => Wire.DecodePropertyArticleQueryGroup(Aeds.Encode(FrameType.PropertyArticleQueryGroup,
            WithByte(Aeds.Decode(alternativeBytes, FrameType.PropertyArticleQueryGroup), 37, 0))));
        var savedAlternatives = alternativeGroup.Conditions.Select(item =>
            new SavedViewCondition(item.DefinitionId, PropertyFieldKind.Number, item.Comparison, item.Value, item.AnyOf)).ToArray();
        Equal(Wire.EncodeSavedViewDefinition(savedAlternatives), Wire.EncodeSavedViewDefinition(savedAlternatives.Reverse().ToArray()));
        var groupPayload = Aeds.Decode(groupBytes, FrameType.PropertyArticleQueryGroup).ToArray();
        RejectEach<byte>([9, 5, 6, 7, 8], cmp => Wire.DecodePropertyArticleQueryGroup(Aeds.Encode(FrameType.PropertyArticleQueryGroup, WithByte(groupPayload, 36, cmp))));

        var presence = new PropertyCondition(value.DefinitionId, 2, PropertyComparison.IsPresent, new PropertyFieldValue.Missing());
        var presenceBytes = Fixture("property-query-presence");
        Equal(presenceBytes, Wire.EncodePropertyArticleQueryGroup(new(10, [presence], "")));
        Require(Wire.DecodePropertyArticleQueryGroup(presenceBytes).Conditions.Single() == presence);
        var saved = new SavedViewCondition(presence.DefinitionId, PropertyFieldKind.Number, presence.Comparison, presence.Value);
        VerifyStoredDefinition(1, saved with { Comparison = PropertyComparison.Equal });
        VerifyStoredDefinition(2, saved);

        var alternatives = new PropertyFieldValue.MultiSelect([blue.Id, red.Id]);
        var overlap = new PropertyCondition(value.DefinitionId, 2, PropertyComparison.MultiSelectAnyOf, alternatives);
        CheckAnyOf("property-query-multi-select-any-of", overlap);
        var anotherField = saved with { DefinitionId = group.Conditions[1].DefinitionId };
        VerifyStoredOverlap(3, new(overlap.DefinitionId, PropertyFieldKind.MultiSelect, overlap.Comparison, overlap.Value), anotherField,
            "03000000010000000000000000004000800000000000000605000000060000000500000002000000af970001222240008000112233445566af970002222240008000112233445566");

        var single = overlap with { Comparison = PropertyComparison.SingleSelectAnyOf };
        CheckAnyOf("property-query-single-select-any-of", single);
        var empty = Wire.EncodePropertyArticleQueryGroup(new(10, [overlap with { Value = new PropertyFieldValue.MultiSelect([]) }], ""));
        RejectAll(
            () => Wire.EncodePropertyArticleQueryGroup(new(10, [single with { Value = new PropertyFieldValue.MultiSelect([]) }], "")),
            () => Wire.DecodePropertyArticleQueryGroup(Aeds.Encode(FrameType.PropertyArticleQueryGroup,
                WithByte(Aeds.Decode(empty, FrameType.PropertyArticleQueryGroup), 36, 7))));
        VerifyStoredOverlap(4, new(single.DefinitionId, PropertyFieldKind.SingleSelect, single.Comparison, single.Value), anotherField,
            "04000000010000000000000000004000800000000000000604000000070000000500000002000000af970001222240008000112233445566af970002222240008000112233445566");

        var referenceAnyOf = new PropertyCondition(value.DefinitionId, 2, PropertyComparison.ReferenceAnyOf, new PropertyFieldValue.ArticleReference([42, 17]));
        CheckAnyOf("property-query-reference-any-of", referenceAnyOf);
        var referenceView = new SavedViewCondition(value.DefinitionId, PropertyFieldKind.ArticleReference, referenceAnyOf.Comparison, referenceAnyOf.Value);
        var referenceDefinition = Wire.EncodeSavedViewDefinition([referenceView]);
        Equal(HexBytes("05000000010000000000000000004000800000000000000606000000080000000600000002000000110000002a000000"), referenceDefinition);
        var decodedReference = DecodeStored(referenceDefinition);
        Equal(referenceDefinition, Wire.EncodeSavedViewDefinition(decodedReference.Conditions, decodedReference.Keyword));
        RejectAll(() => Wire.EncodeSavedViewDefinition([referenceView with { Kind = PropertyFieldKind.MultiSelect }]),
            () => DecodeStored(WithByte(referenceDefinition, 0, 4)));

        const string keyword = "%_雪";
        var keywordBytes = Fixture("property-query-keyword");
        var keywordQuery = new PropertyArticleQueryGroup(10, [presence], "", keyword);
        Equal(keywordBytes, Wire.EncodePropertyArticleQueryGroup(keywordQuery));
        var decodedKeyword = Wire.DecodePropertyArticleQueryGroup(keywordBytes);
        Require(decodedKeyword.Keyword == keyword && decodedKeyword.SchemaRevision == 10 && decodedKeyword.Cursor == "" && decodedKeyword.Conditions.Single() == presence);
        var presencePod = Aeds.Decode(presenceBytes, FrameType.PropertyArticleQueryGroup).ToArray();
        Reject(() => Wire.DecodePropertyArticleQueryGroup(Aeds.Encode(FrameType.PropertyKeywordQuery, [.. presencePod[..8], 0, 0, 0, 0, .. presencePod[8..]])));
        RejectEach([" " + keyword, new string('雪', 129), "a\u0085b", "\ud800"], invalid => Wire.EncodePropertyArticleQueryGroup(keywordQuery with { Keyword = invalid }));
        var storedKeyword = Wire.EncodeSavedViewDefinition([saved], keyword);
        Equal(HexBytes("0600000005000000255fe99baa01000000000000000000400080000000000000060100000005000000feffffff"), storedKeyword);
        var decodedStoredKeyword = DecodeStored(storedKeyword);
        Require(decodedStoredKeyword.Keyword == keyword && decodedStoredKeyword.Conditions.Single() == saved);
        var plainStored = Wire.EncodeSavedViewDefinition([saved]);
        Reject(() => DecodeStored([6, .. plainStored[1..4], 0, 0, 0, 0, .. plainStored[4..]]));

        var schemaBytes = Fixture("property-definition-options");
        var schema = new PropertySchemaInput(new(1, Guid.Parse("00000000-0000-4000-8000-000000000004"), requestId, 10, 0, "multi", "Multiple"),
            PropertyFieldKind.MultiSelect, [red, blue]);
        Equal(schemaBytes, Wire.EncodePropertySchemaInput(schema));
        var schemaDecoded = Wire.DecodePropertySchemaInput(schemaBytes);
        Require(schemaDecoded.Command == schema.Command && schemaDecoded.Kind == schema.Kind && schemaDecoded.Options.SequenceEqual(schema.Options));
        Reject(() => Wire.DecodePropertyEditor(editorBytes.AsSpan(0, editorBytes.Length - 1)));
    }

    private static SavedViewDefinition DecodeStored(byte[] bytes) => Wire.DecodeSavedViewDefinition(bytes, SHA256.HashData(bytes));

    private static void VerifyStoredDefinition(byte version, SavedViewCondition condition)
    {
        var definition = Wire.EncodeSavedViewDefinition([condition]);
        var expected = HexBytes("0100000001000000000000000000400080000000000000060100000000000000feffffff");
        expected[0] = version;
        expected[28] = (byte)condition.Comparison;
        Equal(expected, definition);
        var decoded = DecodeStored(definition);
        Require(decoded.Keyword == "" && decoded.Conditions.Single() == condition);
        RejectEach<byte>([3, version == 1 ? (byte)2 : (byte)1], bad => DecodeStored(WithByte(definition, 0, bad)));
    }

    private static void VerifyStoredOverlap(byte version, SavedViewCondition overlap, SavedViewCondition presence, string hex)
    {
        var expected = HexBytes(hex);
        var definition = Wire.EncodeSavedViewDefinition([overlap]);
        Equal(expected, definition);
        var decoded = DecodeStored(definition);
        Equal(expected, Wire.EncodeSavedViewDefinition(decoded.Conditions, decoded.Keyword));
        var mixed = Wire.EncodeSavedViewDefinition([overlap, presence]);
        Require(mixed[0] == version && DecodeStored(mixed).Conditions.Count == 2);
        var otherKind = overlap.Kind == PropertyFieldKind.SingleSelect ? PropertyFieldKind.MultiSelect : PropertyFieldKind.SingleSelect;
        Reject(() => Wire.EncodeSavedViewDefinition([overlap with { Kind = otherKind }]));
        RejectEach<byte>([(byte)(version - 1), (byte)(version + 1)], bad => DecodeStored(WithByte(definition, 0, bad)));
        Reject(() => DecodeStored([.. definition[..40], .. definition[56..], .. definition[40..56]]));
    }
}
