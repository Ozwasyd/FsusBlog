public sealed class PropertySchemaTests
{
    private static readonly Guid Actor = Guid.Parse("e3726967-184d-4714-86e0-cbf84ef45a19");
    private static readonly Guid Field = Guid.Parse("fd3ab94e-d198-432a-98eb-6b6eb210c53b");
    private static readonly Guid First = Guid.Parse("068ae8be-8554-4e89-89ee-ef3219baa469");
    private static readonly Guid Second = Guid.Parse("ebb4f6cc-0a2b-481a-832f-a85794fa6bca");

    [Fact]
    public void ExactlyEightTypedValuesUseTheSameDefinitionValidation()
    {
        var date = DateTimeOffset.Parse("2026-11-14T18:28:00+08:00");
        var cases = new (PropertySettings Settings, PropertyValue Value, PropertyValue Expected)[]
        {
            (new(PropertyKind.Text, new()), new PropertyValue.Text("e\u0301"), new PropertyValue.Text("é")),
            (new(PropertyKind.Number, new(), NumberRange: new(0, 2)), new PropertyValue.Number(1.5m), new PropertyValue.Number(1.5m)),
            (new(PropertyKind.Boolean, new()), new PropertyValue.Boolean(false), new PropertyValue.Boolean(false)),
            (new(PropertyKind.Date, new()), new PropertyValue.Date(date), new PropertyValue.Date(date.ToUniversalTime())),
            (new(PropertyKind.SingleSelect, new(), Options: Options()), new PropertyValue.SingleSelect(First), new PropertyValue.SingleSelect(First)),
            (new(PropertyKind.MultiSelect, new(), Options: Options()), new PropertyValue.MultiSelect([Second, First]), new PropertyValue.MultiSelect([First, Second])),
            (new(PropertyKind.ArticleReference, new(), Reference: new()), new PropertyValue.ArticleReference([45]), new PropertyValue.ArticleReference([45])),
            (new(PropertyKind.Url, new(), Url: new()), new PropertyValue.Url("https://EXAMPLE.com/KeepCase"), new PropertyValue.Url("https://example.com/KeepCase"))
        };
        Assert.Equal(cases.Length, Enum.GetValues<PropertyKind>().Length);

        foreach (var (settings, value, expected) in cases)
        {
            var normalized = PropertyValues.Validate(Create(settings).Find(Field)!, value, 1, _ => new("main", true, false, false, false));
            if (normalized is PropertyValue.MultiSelect options)
                Assert.Equal(((PropertyValue.MultiSelect)expected).OptionIds.ToArray(), options.OptionIds.ToArray());
            else if (normalized is PropertyValue.ArticleReference references)
                Assert.Equal(((PropertyValue.ArticleReference)expected).ArticleIds.ToArray(), references.ArticleIds.ToArray());
            else Assert.Equal(expected, normalized);
        }

        Invalid(() => Create(new((PropertyKind)8, new())));
        var numeric = Create(new(PropertyKind.Number, new())).Find(Field)!;
        Invalid(() => PropertyValues.Validate(numeric, new PropertyValue.Text("12"), 1));
        Assert.True(PropertyValues.SupportsOperator(PropertyKind.Number, "number.between"));
        Assert.False(PropertyValues.SupportsOperator(PropertyKind.Text, "number.between"));
        Assert.False(PropertyValues.SupportsOperator(PropertyKind.Text, "script.run"));
    }

    [Fact]
    public void MissingAndExplicitNullFollowDifferentPolicies()
    {
        var defaultValue = new PropertyValue.Text("default");
        var definition = Create(new(PropertyKind.Text, new(ApplyDefault: true, Empty: PropertyEmptyPolicy.TreatAsNull), Default: defaultValue)).Find(Field)!;
        Assert.Equal(defaultValue, PropertyValues.Validate(definition, null, 1));
        Assert.IsType<PropertyValue.Null>(PropertyValues.Validate(definition, new PropertyValue.Null(), 1));
        Assert.IsType<PropertyValue.Null>(PropertyValues.Validate(definition, new PropertyValue.Text(""), 1));

        var required = Create(new(PropertyKind.Text, new(Required: true, AllowNull: false, Empty: PropertyEmptyPolicy.Reject))).Find(Field)!;
        Invalid(() => PropertyValues.Validate(required, null, 1));
        Invalid(() => PropertyValues.Validate(required, new PropertyValue.Text(""), 1));
        Invalid(() => Create(new(PropertyKind.Boolean, new(), NumberRange: new(0, 1))));
    }

    [Fact]
    public void ReplayReturnsOriginalReceiptAndStaleWritersCannotRename()
    {
        var schema = Create(new(PropertyKind.Text, new()));
        var rename = Command(schema, new PropertyChange.Rename(Field, [new("zh-CN", " 新名 ")]));
        var result = schema.Apply(rename);
        var updated = result.Schema.Find(Field)!;
        Assert.Equal(("topic", Field, "新名"), (updated.MachineKey, updated.Id, updated.Names.Single().Label));
        Assert.NotEqual(result.Receipt.BeforeDigest, result.Receipt.AfterDigest);

        var replay = result.Schema.Apply(rename, replay: result.Receipt);
        Assert.True(replay.Replayed);
        Assert.Same(result.Schema, replay.Schema);
        Assert.Same(result.Receipt, replay.Receipt);

        var tampered = rename with { Change = new PropertyChange.Rename(Field, [new("en", "different")]) };
        SchemaError("idempotency-conflict", () => result.Schema.Apply(tampered, replay: result.Receipt));
        SchemaError("schema-conflict", () => result.Schema.Apply(rename));
        SchemaError("definition-conflict", () => result.Schema.Apply(rename with { ExpectedSchemaRevision = result.Schema.Revision }));
    }

    [Fact]
    public void ChangingTypeOrDiscardingDataRequiresExplicitMigration()
    {
        var settings = new PropertySettings(PropertyKind.Text, new());
        var schema = Create(settings);
        SchemaError("type-migration-required", () => UpdateSettings(schema, new(PropertyKind.Number, new()), 0));

        var constrain = Command(schema, new PropertyChange.ChangeSettings(Field, settings with { TextRange = new(2, 40) }));
        SchemaError("impact-unavailable", () => schema.Apply(constrain));
        var blocked = Assert.Throws<PropertySchemaException>(() => schema.Apply(constrain, countAffected: (_, _) => 7));
        Assert.Equal(("reconciliation-required", 7), (blocked.Code, blocked.AffectedCount));
        Assert.Null(schema.Find(Field)!.Settings.TextRange);

        var archived = Apply(schema, new PropertyChange.Deprecate(Field), 7);
        Assert.Equal((PropertyStatus.Deprecated, 7), (archived.Receipt.Status, archived.Receipt.AffectedCount));
        var delete = Command(archived.Schema, new PropertyChange.Delete(Field));
        SchemaError("reconciliation-required", () => archived.Schema.Apply(delete, countAffected: (_, _) => 7));
        var removed = archived.Schema.Apply(delete, countAffected: (_, _) => 0);
        Assert.Empty(removed.Schema.Page(null));
        Assert.Equal(PropertyStatus.Deleted, removed.Schema.Find(Field)!.Status);
        SchemaError("identity-conflict", () => Apply(removed.Schema, new PropertyChange.Create(Guid.NewGuid(), "topic", [new("en", "New")], settings)));
    }

    [Fact]
    public void OptionLabelMayChangeWithoutChangingStoredIdentity()
    {
        var settings = new PropertySettings(PropertyKind.SingleSelect, new(), Options: Options());
        var schema = Create(settings);
        var modified = UpdateSettings(schema, settings with { Options = [new(First, "RENAMED", 0), settings.Options[1]] }).Find(Field)!;
        var existing = new PropertyValue.SingleSelect(First);
        Assert.Equal(existing, PropertyValues.Validate(modified, existing, 1));
        Assert.Equal("RENAMED", modified.Settings.Options[0].Label);

        Invalid(() => Create(settings with { Options = [new(First, "A", 0), new(First, "B", 1)] }));
        SchemaError("option-lifecycle", () => UpdateSettings(schema, settings with { Options = [settings.Options[1]] }));

        var retired = UpdateSettings(schema, settings with { Options = [settings.Options[0] with { Status = PropertyStatus.Deprecated }, settings.Options[1]] }, 0).Find(Field)!;
        Invalid(() => PropertyValues.Validate(retired, existing, 1));
    }

    [Fact]
    public void MultiSelectAlternativesUseActiveIdentitiesOutsideStoredValueCardinality()
    {
        var settings = new PropertySettings(PropertyKind.MultiSelect, new(Empty: PropertyEmptyPolicy.Reject), CountRange: new(2, 2), Options: Options(), Filterable: true);
        var schema = Create(settings);
        var definition = schema.Find(Field)!;
        var one = new PropertyValue.MultiSelect([First]);
        Invalid(() => PropertyValues.NormalizeFilter(definition, one));
        Assert.Equal(new[] { First }, PropertyValues.NormalizeSelectionAlternatives(definition, one).OptionIds.ToArray());
        Assert.Empty(PropertyValues.NormalizeSelectionAlternatives(definition, new([])).OptionIds);
        Assert.Equal(new[] { First, Second }, PropertyValues.NormalizeSelectionAlternatives(definition, new([Second, First])).OptionIds.ToArray());
        var current = UpdateSettings(schema, settings with
            { Options = [settings.Options[0] with { Status = PropertyStatus.Deprecated }, settings.Options[1] with { Label = "Renamed" }] }, 0).Find(Field)!;
        Invalid(() => PropertyValues.NormalizeSelectionAlternatives(current, one));
        Assert.Equal(new[] { Second }, PropertyValues.NormalizeSelectionAlternatives(current, new([Second])).OptionIds.ToArray());
    }

    [Fact]
    public void SingleSelectAlternativesRequireAtLeastOneActiveOption()
    {
        var definition = Create(new(PropertyKind.SingleSelect, new(), Options: Options(), Filterable: true)).Find(Field)!;
        Assert.Equal(new[] { First, Second }, PropertyValues.NormalizeSelectionAlternatives(definition, new([Second, First])).OptionIds.ToArray());
        foreach (var bad in new ImmutableArray<Guid>[] { [], [First, First], [First, Guid.NewGuid()] })
            Invalid(() => PropertyValues.NormalizeSelectionAlternatives(definition, new(bad)));
    }

    [Fact]
    public void ReferenceFailuresShareOneOutcomeAndUrlPolicyIsClosed()
    {
        var reference = Create(new(PropertyKind.ArticleReference, new(), Reference: new())).Find(Field)!;
        var value = new PropertyValue.ArticleReference([2]);
        PropertyReferenceFacts?[] unavailable =
        [
            null, new("other", true, false, false, false), new("main", false, false, false, false),
            new("main", true, true, false, false), new("main", true, false, true, false), new("main", true, false, false, true)
        ];
        foreach (var facts in unavailable)
            Assert.Equal("reference-unavailable", Invalid(() => PropertyValues.Validate(reference, value, 1, _ => facts)).Code);
        Assert.Equal("reference-unavailable", Invalid(() => PropertyValues.Validate(reference, value, 2, _ => new("main", true, false, false, false))).Code);

        var url = Create(new(PropertyKind.Url, new(), Url: new(AllowRelative: true))).Find(Field)!;
        Assert.Equal(new PropertyValue.Url("/article/2"), PropertyValues.Validate(url, new PropertyValue.Url("/article/2"), 1));
        foreach (var invalid in new[] { "javascript:example", "https://user@example.com/", "//example.com/", "http://example.com/" })
            Invalid(() => PropertyValues.Validate(url, new PropertyValue.Url(invalid), 1));
    }

    [Fact]
    public void StoredSchemaMustRoundTripScopeRevisionsAndCanonicalDefinitions()
    {
        var renamed = Apply(Create(new(PropertyKind.Text, new())), new PropertyChange.Rename(Field, [new("en", "New title")])).Schema;
        var definitions = renamed.Page(null);
        Assert.Equal(renamed.Find(Field)!.Digest, PropertySchema.Restore(renamed.Scope, renamed.Revision, definitions).Find(Field)!.Digest);
        Invalid(() => PropertySchema.Restore(renamed.Scope, 1, definitions));
        Invalid(() => PropertySchema.Restore(new("foreign"), 2, definitions));
        Invalid(() => PropertySchema.Restore(renamed.Scope, 2, [definitions[0] with { Names = [new("en", " New title ")] }]));
    }

    [Fact]
    public void SchemaPagesBoundResultsAtOneThousandDefinitions()
    {
        Assert.Empty(new PropertySchema(new("main", Actor)).Page(null));
        var definitions = Enumerable.Range(0, PropertySchema.MaxDefinitions)
            .Select(index => new PropertyDefinition(Guid.NewGuid(), new("main", Actor), $"field-{index:D4}",
                [new("en", "Field")], new(PropertyKind.Text, new(), Options: []), PropertyStatus.Active, 1)).ToArray();
        var schema = PropertySchema.Restore(new("main", Actor), definitions.Length, definitions);
        var firstPage = schema.Page(null);
        Assert.Equal((PropertySchema.MaxPageSize, "field-0100"), (firstPage.Length, schema.Page(firstPage[^1].MachineKey)[0].MachineKey));
        Invalid(() => schema.Page(null, PropertySchema.MaxPageSize + 1));
        SchemaError("schema-budget", () => Apply(schema, new PropertyChange.Create(Field, "field-1000", [new("en", "Extra")], new(PropertyKind.Text, new()))));
    }

    private static PropertyValidationException Invalid(Action act) => Assert.Throws<PropertyValidationException>(act);
    private static void SchemaError(string code, Action act) => Assert.Equal(code, Assert.Throws<PropertySchemaException>(act).Code);
    private static ImmutableArray<PropertyOption> Options() => [new(First, "One", 0), new(Second, "Two", 1)];
    private static PropertySchema Create(PropertySettings settings) =>
        Apply(new(new("main", Actor)), new PropertyChange.Create(Field, "Topic", [new("en", "Topic")], settings), 0).Schema;
    private static PropertyTransition Apply(PropertySchema schema, PropertyChange change, int? affected = null) =>
        schema.Apply(Command(schema, change), countAffected: affected is int count ? (_, _) => count : null);
    private static PropertySchema UpdateSettings(PropertySchema schema, PropertySettings settings, int? affected = null) =>
        Apply(schema, new PropertyChange.ChangeSettings(Field, settings), affected).Schema;
    private static PropertyCommand Command(PropertySchema schema, PropertyChange change) =>
        new(Actor, Guid.NewGuid(), schema.Revision, schema.Find(change.DefinitionId)?.Revision ?? 0, change);
}
