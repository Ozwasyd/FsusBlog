using FsusBlog.Contracts.Schema;

using Xunit;

namespace FsusBlog.Migration.Tests;

public sealed class CurrentSchemaStorageProjectionTests
{
    [Fact]
    public void PhysicalConversionDomain_DoesNotReplaceLogicalInputOrJsonStorageFacts()
    {
        var logical = new SchemaColumnModel("payload", false, false, false, null, "json", Conversion: "json",
            Owner: new("FsusBlog.Server.Entities.Probe.Payload", "original-owner"));
        CurrentSchemaCanonicalModel canonical = Model(logical);
        CurrentSchemaIdentity before = canonical.Identity;
        SchemaModelSnapshot physical = CurrentSchemaCanonicalAuthority.ProjectProvider(canonical, SchemaProviderKind.PostgreSql);
        Assert.Equal("json", canonical.SemanticSchema.Tables["probe"].Columns["payload"].Conversion);
        Assert.Equal(before, canonical.Identity);
        Assert.Equal("none", physical.Tables["probe"].Columns["payload"].Conversion);
        Assert.Equal("jsonb", physical.Tables["probe"].Columns["payload"].PhysicalType);
        Assert.Equal(logical.Owner, physical.Tables["probe"].Columns["payload"].Owner);
        Assert.NotEqual(before.ContentDigest, Model(logical with { Conversion = "none" }).Identity.ContentDigest);

        SchemaColumnModel actualWrongType = physical.Tables["probe"].Columns["payload"] with { PhysicalType = "text" };
        Assert.NotEmpty(SchemaModelComparer.Compare(physical, Snapshot(actualWrongType)));
        SchemaColumnModel inventedActualLogicalConversion = physical.Tables["probe"].Columns["payload"] with { Conversion = "json" };
        Assert.NotEmpty(SchemaModelComparer.Compare(physical, Snapshot(inventedActualLogicalConversion)));
    }

    [Fact]
    public void UnknownLogicalConverter_CannotBeErasedByPhysicalProjection()
    {
        CurrentSchemaCanonicalModel canonical = Model(new("payload", false, false, false, null, "json", Conversion: "unknown-converter"));
        Assert.Throws<InvalidOperationException>(() => CurrentSchemaCanonicalAuthority.ProjectProvider(canonical, SchemaProviderKind.PostgreSql));
    }

    [Theory]
    [InlineData(SchemaProviderKind.PostgreSql)]
    [InlineData(SchemaProviderKind.MySql)]
    [InlineData(SchemaProviderKind.Sqlite)]
    public void CurrentControlProjection_PreservesWholeSoleShapeAndLogicalBounds(SchemaProviderKind provider)
    {
        SchemaTableModel semantic = CurrentSchemaControlShape.DescribeApplyJournal();
        string before = CurrentSchemaCanonicalAuthority.ComputeContentDigest(new Dictionary<string, SchemaTableModel> { [semantic.Name] = semantic });
        SchemaTableModel physical = CurrentSchemaControlShape.ProjectApplyJournal(provider);
        Assert.Equal(7, physical.Columns.Count);
        Assert.Equal(4, physical.Constraints.Count);
        Assert.Equal(3, physical.IndexDefinitions.Count);
        Assert.True(physical.Indexes.SetEquals(physical.IndexDefinitions.Keys));
        Assert.Equal("sequence > 0", physical.Constraints.Values.Single(value => value.Kind == "check").Expression);
        Assert.Equal(new[] { "plan_digest", "database_digest", "invocation_id", "sequence" },
            physical.Constraints.Values.Single(value => value.Kind == "primary-key").Columns);
        Assert.All(physical.Columns.Values, value =>
        {
            Assert.False(value.IsNullable);
            Assert.False(value.IsIdentity);
            Assert.Null(value.DefaultValue);
            Assert.Null(value.ComputedExpression);
            Assert.Null(value.OwnedSequence);
            Assert.Equal("none", value.GenerationKind);
        });
        Assert.Equal(64, semantic.Columns["plan_digest"].MaxLength);
        Assert.Equal(160, semantic.Columns["invocation_id"].MaxLength);
        Assert.Equal(before, CurrentSchemaCanonicalAuthority.ComputeContentDigest(
            new Dictionary<string, SchemaTableModel> { [semantic.Name] = semantic }));
        Assert.Equal(CurrentSchemaControlShape.Version, CurrentSchemaControlShape.DescribeApplyJournalFacts().Version);
    }

    [Fact]
    public void CurrentControlMySqlProjection_UsesNativePrimaryAndExactNoPadTextKeys()
    {
        SchemaTableModel physical = CurrentSchemaControlShape.ProjectApplyJournal(SchemaProviderKind.MySql);
        Assert.Equal("primary-key", physical.Constraints["PRIMARY"].Kind);
        Assert.Equal("PRIMARY", physical.IndexDefinitions["PRIMARY"].Name);
        Assert.Equal("varchar(160)", physical.Columns["invocation_id"].PhysicalType);
        Assert.Equal("longtext", physical.Columns["entry_payload"].PhysicalType);
        Assert.Equal("bigint", physical.Columns["sequence"].PhysicalType);
        Assert.All(physical.Columns.Values.Where(value => value.DataType == "string"),
            value => Assert.Equal("utf8mb4_0900_bin", value.Collation));
        Assert.All(physical.IndexDefinitions.Values, value => Assert.Equal("first", value.Keys[0].NullPlacement));
        Assert.Equal(160, physical.Columns["invocation_id"].MaxLength);
    }

    [Fact]
    public void CurrentControlSqliteProjection_UsesThreeCompositeConstraintIndexesNotRowidAlias()
    {
        SchemaTableModel physical = CurrentSchemaControlShape.ProjectApplyJournal(SchemaProviderKind.Sqlite);
        SchemaConstraintModel[] constraints = CurrentSchemaControlShape.DescribeApplyJournal().Constraints.Values
            .Where(value => value.Kind is "primary-key" or "unique").ToArray();
        for (int index = 0; index < 3; index++)
        {
            SchemaIndexModel backing = physical.IndexDefinitions[$"sqlite_autoindex_{physical.Name}_{index + 1}"];
            Assert.True(backing.IsUnique);
            Assert.Equal(constraints[index].Columns, backing.Keys.Select(value => value.Column));
            Assert.All(backing.Keys, value => Assert.Equal("BINARY", value.Collation));
        }
        Assert.Equal(4, constraints[0].Columns.Count);
        Assert.Equal("INTEGER", physical.Columns["sequence"].PhysicalType);
        Assert.Equal("TEXT", physical.Columns["invocation_id"].PhysicalType);
        Assert.Null(physical.Columns["invocation_id"].MaxLength);
        Assert.Equal("BINARY", physical.Columns["invocation_id"].Collation);
    }

    [Theory]
    [InlineData(SchemaProviderKind.Semantic)]
    [InlineData((SchemaProviderKind)999)]
    public void CurrentControlProjection_DoesNotAdmitUnknownProvider(SchemaProviderKind provider)
        => Assert.Throws<InvalidOperationException>(() => CurrentSchemaControlShape.ProjectApplyJournal(provider));

    [Theory]
    [InlineData(SchemaProviderKind.MySql)]
    [InlineData(SchemaProviderKind.Sqlite)]
    public void PortableOwnedStructuralProjection_FoldsTypedEffectsAndPreservesSoleTargetIdentity(SchemaProviderKind provider)
    {
        CurrentSchemaProjection entity = PortableEntity();
        SchemaTableModel recipe = PortableRecipe();
        var additional = new SchemaColumnModel("added", false, false, false, null, "int64");
        var index = new SchemaIndexModel("idx_added", true, [new("added", "asc", "last", "default", "default")], [], "btree", null, false);
        CurrentSchemaRequiredRecipeReference[] references = [Reference(recipe,
            new(CurrentSchemaRecipeOperationKind.AddColumnIfAbsent, "added", recipe.Name, Column: additional),
            new(CurrentSchemaRecipeOperationKind.CreateIndex, index.Name, recipe.Name, Index: index))];
        CurrentSchemaIdentity expected = CurrentSchemaOwnedTargetProjection.Observe(entity, references);
        CurrentSchemaCompletePhysicalProjection result = CurrentSchemaCanonicalAuthority.ProjectOwnedTarget(entity, references, provider);
        Assert.Equal(expected, result.Tables.Identity);
        Assert.Equal(provider, result.Tables.Provider);
        Assert.Equal(3, result.Tables.Tables.Count);
        Assert.Equal(provider == SchemaProviderKind.MySql ? "bigint" : "INTEGER", result.Tables.Tables[recipe.Name].Columns["added"].PhysicalType);
        Assert.Equal("first", result.Tables.Tables[recipe.Name].IndexDefinitions[index.Name].Keys[0].NullPlacement);
        Assert.Empty(result.SchemaEffects);
        Assert.Empty(result.BootstrapDataEffects);
        Assert.Empty(result.IndependentSequences);
        Assert.Equal(expected, CurrentSchemaOwnedTargetProjection.Observe(entity, references));
    }

    [Theory]
    [InlineData(SchemaProviderKind.MySql, "sequence")]
    [InlineData(SchemaProviderKind.Sqlite, "sequence")]
    [InlineData(SchemaProviderKind.MySql, "guard")]
    [InlineData(SchemaProviderKind.Sqlite, "guard")]
    [InlineData(SchemaProviderKind.MySql, "seed-expression")]
    [InlineData(SchemaProviderKind.Sqlite, "seed-expression")]
    [InlineData(SchemaProviderKind.MySql, "unknown")]
    [InlineData(SchemaProviderKind.Sqlite, "unknown")]
    public void PortableOwnedProjection_RefusesUnspecifiedEffectsRatherThanReturningSubset(SchemaProviderKind provider, string kind)
    {
        SchemaTableModel recipe = PortableRecipe();
        CurrentSchemaRecipeOperation effect = kind switch
        {
            "sequence" => new(CurrentSchemaRecipeOperationKind.CreateSequence, "independent_sequence",
                Sequence: CurrentSchemaIndependentSequenceFacts.PostgreSqlBigIntDefaults),
            "guard" => new(CurrentSchemaRecipeOperationKind.DefineImmutableGuard, "immutable_guard", Function: "immutable_guard", ErrorCode: "P0001"),
            "seed-expression" => new(CurrentSchemaRecipeOperationKind.InsertIfAbsent, "seed", recipe.Name,
                Columns: ["counter"], Values: ["current_setting('max_connections')::bigint"], ConflictColumn: "counter"),
            _ => new((CurrentSchemaRecipeOperationKind)999, "unknown", recipe.Name)
        };
        Assert.Throws<InvalidOperationException>(() => CurrentSchemaCanonicalAuthority.ProjectOwnedTarget(
            PortableEntity(), [Reference(recipe, effect)], provider));
    }

    [Theory]
    [InlineData(SchemaProviderKind.MySql, "default")]
    [InlineData(SchemaProviderKind.Sqlite, "default")]
    [InlineData(SchemaProviderKind.MySql, "identity")]
    [InlineData(SchemaProviderKind.Sqlite, "identity")]
    [InlineData(SchemaProviderKind.MySql, "nullable-index")]
    [InlineData(SchemaProviderKind.Sqlite, "nullable-index")]
    [InlineData(SchemaProviderKind.MySql, "raw-check")]
    [InlineData(SchemaProviderKind.Sqlite, "raw-check")]
    public void PortableOwnedProjection_RefusesUnspecifiedStorageOrExpressionSemantics(SchemaProviderKind provider, string kind)
    {
        SchemaColumnModel column = new("counter", kind == "nullable-index", false, kind == "identity", null, "int64",
            DefaultValue: kind == "default" ? "1::bigint" : null);
        SchemaIndexModel? index = kind == "nullable-index"
            ? new("idx_counter", false, [new("counter", "asc", "last", "default", "default")], [], "btree", null, false) : null;
        SchemaConstraintModel? check = kind == "raw-check" ? new("raw_check", "check", ["counter"], Expression: "counter > 0") : null;
        SchemaTableModel recipe = new("recipe", new(StringComparer.Ordinal) { [column.Name] = column }, index is null ? [] : [index.Name],
            index is null ? null : new Dictionary<string, SchemaIndexModel> { [index.Name] = index },
            check is null ? null : new Dictionary<string, SchemaConstraintModel> { [check.Name] = check });
        Assert.Throws<InvalidOperationException>(() => CurrentSchemaCanonicalAuthority.ProjectOwnedTarget(
            PortableEntity(), [Reference(recipe)], provider));
    }

    private static CurrentSchemaProjection PortableEntity()
        => CurrentSchemaCanonicalAuthority.Generate(Model(new("payload", false, false, false, null, "int64")));

    private static SchemaTableModel PortableRecipe()
        => new("recipe", new(StringComparer.Ordinal) { ["counter"] = new("counter", false, false, false, null, "int64") }, []);

    private static CurrentSchemaRequiredRecipeReference Reference(SchemaTableModel table, params CurrentSchemaRecipeOperation[] effects)
        => new(table.Name, SchemaProviderKind.PostgreSql, new string('b', 64), new(table, effects));

    private static CurrentSchemaCanonicalModel Model(SchemaColumnModel column)
        => CurrentSchemaCanonicalAuthority.Create(Snapshot(column).Tables, new string('a', 64));

    private static SchemaModelSnapshot Snapshot(SchemaColumnModel column)
        => new(new Dictionary<string, SchemaTableModel>(StringComparer.Ordinal)
        {
            ["probe"] = new("probe", new Dictionary<string, SchemaColumnModel>(StringComparer.Ordinal) { [column.Name] = column }, [],
                owner: new("FsusBlog.Server.Entities.Probe", "original-owner"))
        }, provider: SchemaProviderKind.PostgreSql);
}
