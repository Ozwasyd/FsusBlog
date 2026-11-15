using System.Collections.Immutable;
using FsusBlog.V2.Core.Authoring;

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
            var definition = Create(settings).Find(Field)!;
            var normalized = PropertyValues.Validate(definition, value, 1, _ => new("main", true, false, false, false));
            if (normalized is PropertyValue.MultiSelect options)
                Assert.Equal(((PropertyValue.MultiSelect)expected).OptionIds.ToArray(), options.OptionIds.ToArray());
            else if (normalized is PropertyValue.ArticleReference references)
                Assert.Equal(((PropertyValue.ArticleReference)expected).ArticleIds.ToArray(), references.ArticleIds.ToArray());
            else
                Assert.Equal(expected, normalized);
        }

        Assert.Throws<PropertyValidationException>(() => Create(new((PropertyKind)8, new())));
        var numeric = Create(new(PropertyKind.Number, new())).Find(Field)!;
        Assert.Throws<PropertyValidationException>(() => PropertyValues.Validate(numeric, new PropertyValue.Text("12"), 1));
        Assert.True(PropertyValues.SupportsOperator(PropertyKind.Number, "number.between"));
        Assert.False(PropertyValues.SupportsOperator(PropertyKind.Text, "number.between"));
        Assert.False(PropertyValues.SupportsOperator(PropertyKind.Text, "script.run"));
    }

    [Fact]
    public void MissingAndExplicitNullFollowDifferentPolicies()
    {
        var defaultValue = new PropertyValue.Text("default");
        var definition = Create(new(PropertyKind.Text, new(ApplyDefault: true, Empty: PropertyEmptyPolicy.TreatAsNull),
            Default: defaultValue)).Find(Field)!;
        Assert.Equal(defaultValue, PropertyValues.Validate(definition, null, 1));
        Assert.IsType<PropertyValue.Null>(PropertyValues.Validate(definition, new PropertyValue.Null(), 1));
        Assert.IsType<PropertyValue.Null>(PropertyValues.Validate(definition, new PropertyValue.Text(""), 1));

        var required = Create(new(PropertyKind.Text, new(Required: true, AllowNull: false,
            Empty: PropertyEmptyPolicy.Reject))).Find(Field)!;
        Assert.Throws<PropertyValidationException>(() => PropertyValues.Validate(required, null, 1));
        Assert.Throws<PropertyValidationException>(() => PropertyValues.Validate(required, new PropertyValue.Text(""), 1));
        Assert.Throws<PropertyValidationException>(() => Create(new(PropertyKind.Boolean, new(), NumberRange: new(0, 1))));
    }

    [Fact]
    public void ReplayReturnsOriginalReceiptAndStaleWritersCannotRename()
    {
        var schema = Create(new(PropertyKind.Text, new()));
        var rename = Command(schema, new PropertyChange.Rename(Field, [new("zh-CN", " 新名 ")]));
        var result = schema.Apply(rename);
        Assert.Equal("topic", result.Schema.Find(Field)!.MachineKey);
        Assert.Equal(Field, result.Schema.Find(Field)!.Id);
        Assert.Equal("新名", result.Schema.Find(Field)!.Names.Single().Label);
        Assert.NotEqual(result.Receipt.BeforeDigest, result.Receipt.AfterDigest);

        var replay = result.Schema.Apply(rename, replay: result.Receipt);
        Assert.True(replay.Replayed);
        Assert.Same(result.Schema, replay.Schema);
        Assert.Same(result.Receipt, replay.Receipt);

        var tampered = rename with { Change = new PropertyChange.Rename(Field, [new("en", "different")]) };
        Assert.Equal("idempotency-conflict", Assert.Throws<PropertySchemaException>(() =>
            result.Schema.Apply(tampered, replay: result.Receipt)).Code);
        Assert.Equal("schema-conflict", Assert.Throws<PropertySchemaException>(() => result.Schema.Apply(rename)).Code);
        Assert.Equal("definition-conflict", Assert.Throws<PropertySchemaException>(() =>
            result.Schema.Apply(rename with { ExpectedSchemaRevision = result.Schema.Revision })).Code);
    }

    [Fact]
    public void ChangingTypeOrDiscardingDataRequiresExplicitMigration()
    {
        var settings = new PropertySettings(PropertyKind.Text, new());
        var schema = Create(settings);
        var changeKind = Command(schema, new PropertyChange.ChangeSettings(Field, new(PropertyKind.Number, new())));
        Assert.Equal("type-migration-required", Assert.Throws<PropertySchemaException>(() =>
            schema.Apply(changeKind, countAffected: (_, _) => 0)).Code);

        var constrain = Command(schema, new PropertyChange.ChangeSettings(Field, settings with { TextRange = new(2, 40) }));
        Assert.Equal("impact-unavailable", Assert.Throws<PropertySchemaException>(() => schema.Apply(constrain)).Code);
        var blocked = Assert.Throws<PropertySchemaException>(() => schema.Apply(constrain, countAffected: (_, _) => 7));
        Assert.Equal("reconciliation-required", blocked.Code);
        Assert.Equal(7, blocked.AffectedCount);
        Assert.Null(schema.Find(Field)!.Settings.TextRange);

        var deprecate = Command(schema, new PropertyChange.Deprecate(Field));
        var archived = schema.Apply(deprecate, countAffected: (_, _) => 7);
        Assert.Equal(PropertyStatus.Deprecated, archived.Receipt.Status);
        Assert.Equal(7, archived.Receipt.AffectedCount);
        var delete = Command(archived.Schema, new PropertyChange.Delete(Field));
        Assert.Equal("reconciliation-required", Assert.Throws<PropertySchemaException>(() =>
            archived.Schema.Apply(delete, countAffected: (_, _) => 7)).Code);
        var removed = archived.Schema.Apply(delete, countAffected: (_, _) => 0);
        Assert.Empty(removed.Schema.Page(null));
        Assert.Equal(PropertyStatus.Deleted, removed.Schema.Find(Field)!.Status);
        Assert.Equal("identity-conflict", Assert.Throws<PropertySchemaException>(() => removed.Schema.Apply(
            Command(removed.Schema, new PropertyChange.Create(Guid.NewGuid(), "topic", [new("en", "New")], settings)))).Code);
    }

    [Fact]
    public void OptionLabelMayChangeWithoutChangingStoredIdentity()
    {
        var settings = new PropertySettings(PropertyKind.SingleSelect, new(), Options: Options());
        var schema = Create(settings);
        var renamed = settings with { Options = [new(First, "RENAMED", 0), settings.Options[1]] };
        var change = Command(schema, new PropertyChange.ChangeSettings(Field, renamed));
        var modified = schema.Apply(change).Schema.Find(Field)!;
        var existing = new PropertyValue.SingleSelect(First);
        Assert.Equal(existing, PropertyValues.Validate(modified, existing, 1));
        Assert.Equal("RENAMED", modified.Settings.Options[0].Label);

        Assert.Throws<PropertyValidationException>(() => Create(settings with { Options = [new(First, "A", 0), new(First, "B", 1)] }));
        var remove = Command(schema, new PropertyChange.ChangeSettings(Field, settings with { Options = [settings.Options[1]] }));
        Assert.Equal("option-lifecycle", Assert.Throws<PropertySchemaException>(() => schema.Apply(remove)).Code);

        var retire = Command(schema, new PropertyChange.ChangeSettings(Field, settings with
        {
            Options = [settings.Options[0] with { Status = PropertyStatus.Deprecated }, settings.Options[1]]
        }));
        var retired = schema.Apply(retire, countAffected: (_, _) => 0).Schema.Find(Field)!;
        Assert.Throws<PropertyValidationException>(() => PropertyValues.Validate(retired, existing, 1));
    }

    [Fact]
    public void MultiSelectAlternativesUseActiveIdentitiesOutsideStoredValueCardinality()
    {
        var settings = new PropertySettings(PropertyKind.MultiSelect, new(Empty: PropertyEmptyPolicy.Reject),
            CountRange: new(2, 2), Options: Options(), Filterable: true);
        var schema = Create(settings);
        var definition = schema.Find(Field)!;
        var one = new PropertyValue.MultiSelect([First]);
        Assert.Throws<PropertyValidationException>(() => PropertyValues.NormalizeFilter(definition, one));
        Assert.Equal(new[] { First }, PropertyValues.NormalizeMultiSelectAlternatives(definition, one).OptionIds.ToArray());
        Assert.Empty(PropertyValues.NormalizeMultiSelectAlternatives(definition, new([])).OptionIds);
        Assert.Equal(new[] { First, Second }, PropertyValues.NormalizeMultiSelectAlternatives(definition, new([Second, First])).OptionIds.ToArray());
        var changed = Command(schema, new PropertyChange.ChangeSettings(Field, settings with
        {
            Options = [settings.Options[0] with { Status = PropertyStatus.Deprecated }, settings.Options[1] with { Label = "Renamed" }]
        }));
        var current = schema.Apply(changed, countAffected: (_, _) => 0).Schema.Find(Field)!;
        Assert.Throws<PropertyValidationException>(() => PropertyValues.NormalizeMultiSelectAlternatives(current, one));
        Assert.Equal(new[] { Second }, PropertyValues.NormalizeMultiSelectAlternatives(current, new([Second])).OptionIds.ToArray());
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
            Assert.Equal("reference-unavailable", Assert.Throws<PropertyValidationException>(() =>
                PropertyValues.Validate(reference, value, 1, _ => facts)).Code);
        Assert.Equal("reference-unavailable", Assert.Throws<PropertyValidationException>(() =>
            PropertyValues.Validate(reference, value, 2, _ => new("main", true, false, false, false))).Code);

        var url = Create(new(PropertyKind.Url, new(), Url: new(AllowRelative: true))).Find(Field)!;
        Assert.Equal(new PropertyValue.Url("/article/2"), PropertyValues.Validate(url, new PropertyValue.Url("/article/2"), 1));
        foreach (var invalid in new[] { "javascript:example", "https://user@example.com/", "//example.com/", "http://example.com/" })
            Assert.Throws<PropertyValidationException>(() => PropertyValues.Validate(url, new PropertyValue.Url(invalid), 1));
    }

    [Fact]
    public void StoredSchemaMustRoundTripScopeRevisionsAndCanonicalDefinitions()
    {
        var schema = Create(new(PropertyKind.Text, new()));
        var renamed = schema.Apply(Command(schema, new PropertyChange.Rename(Field, [new("en", "New title")]))).Schema;
        var definitions = renamed.Page(null);
        var restored = PropertySchema.Restore(renamed.Scope, renamed.Revision, definitions);
        Assert.Equal(renamed.Find(Field)!.Digest, restored.Find(Field)!.Digest);
        Assert.Throws<PropertyValidationException>(() => PropertySchema.Restore(renamed.Scope, 1, definitions));
        Assert.Throws<PropertyValidationException>(() => PropertySchema.Restore(new("foreign"), 2, definitions));
        Assert.Throws<PropertyValidationException>(() => PropertySchema.Restore(renamed.Scope, 2,
            [definitions[0] with { Names = [new("en", " New title ")] }]));
    }

    [Fact]
    public void SchemaPagesBoundResultsAtOneThousandDefinitions()
    {
        Assert.Empty(new PropertySchema(new("main", Actor)).Page(null));
        var definitions = Enumerable.Range(0, PropertySchema.MaxDefinitions)
            .Select(index => new PropertyDefinition(Guid.NewGuid(), new("main", Actor), $"field-{index:D4}",
                [new("en", "Field")], new(PropertyKind.Text, new(), Options: []), PropertyStatus.Active, 1))
            .ToArray();
        var schema = PropertySchema.Restore(new("main", Actor), definitions.Length, definitions);
        var firstPage = schema.Page(null);
        var nextPage = schema.Page(firstPage[^1].MachineKey);
        Assert.Equal(PropertySchema.MaxPageSize, firstPage.Length);
        Assert.Equal("field-0100", nextPage[0].MachineKey);
        Assert.Throws<PropertyValidationException>(() => schema.Page(null, PropertySchema.MaxPageSize + 1));
        var create = Command(schema, new PropertyChange.Create(Field, "field-1000", [new("en", "Extra")], new(PropertyKind.Text, new())));
        Assert.Equal("schema-budget", Assert.Throws<PropertySchemaException>(() => schema.Apply(create)).Code);
    }

    private static ImmutableArray<PropertyOption> Options() => [new(First, "One", 0), new(Second, "Two", 1)];

    private static PropertySchema Create(PropertySettings settings)
    {
        var empty = new PropertySchema(new("main", Actor));
        return empty.Apply(Command(empty, new PropertyChange.Create(Field, "Topic", [new("en", "Topic")], settings)),
            countAffected: (_, _) => 0).Schema;
    }

    private static PropertyCommand Command(PropertySchema schema, PropertyChange change) =>
        new(Actor, Guid.NewGuid(), schema.Revision, schema.Find(change.DefinitionId)?.Revision ?? 0, change);
}
