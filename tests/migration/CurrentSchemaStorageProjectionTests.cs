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
        Assert.NotEqual(before.ContentDigest, Model(logical with
        {
            Conversion = "none"
        }).Identity.ContentDigest);

        SchemaColumnModel actualWrongType = physical.Tables["probe"].Columns["payload"] with
        {
            PhysicalType = "text"
        };
        Assert.NotEmpty(SchemaModelComparer.Compare(physical, Snapshot(actualWrongType)));
        SchemaColumnModel inventedActualLogicalConversion = physical.Tables["probe"].Columns["payload"] with
        {
            Conversion = "json"
        };
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
        if (provider == SchemaProviderKind.MySql)
        {
            SchemaConstraintModel nativeUnique = Assert.Single(result.Tables.Tables[recipe.Name].Constraints.Values);
            Assert.Equal("idx_added", nativeUnique.Name);
            Assert.Equal("unique", nativeUnique.Kind);
            Assert.Equal(new[] { "added" }, nativeUnique.Columns);
            Assert.Single(result.Tables.Tables[recipe.Name].IndexDefinitions);
        }
        else
        {
            Assert.Empty(result.Tables.Tables[recipe.Name].Constraints);
        }
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
        SchemaTableModel recipe = new("recipe", new(StringComparer.Ordinal)
        {
            [column.Name] = column
        }, index is null ? [] : [index.Name],
            index is null ? null : new Dictionary<string, SchemaIndexModel> { [index.Name] = index },
            check is null ? null : new Dictionary<string, SchemaConstraintModel> { [check.Name] = check });
        Assert.Throws<InvalidOperationException>(() => CurrentSchemaCanonicalAuthority.ProjectOwnedTarget(
            PortableEntity(), [Reference(recipe)], provider));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void MySqlOwnedExplicitIndex_ProjectsUniqueConstraintOnlyForUniqueKey(bool unique)
    {
        var column = new SchemaColumnModel("counter", true, false, false, null, "int64");
        var index = new SchemaIndexModel("idx_counter", unique, [new("counter", "asc", "first", "default", "default")], [], "btree", null, false);
        SchemaTableModel recipe = new("recipe", new(StringComparer.Ordinal)
        {
            [column.Name] = column
        }, [index.Name],
            new Dictionary<string, SchemaIndexModel> { [index.Name] = index });
        CurrentSchemaRequiredRecipeReference[] references = [Reference(recipe)];
        CurrentSchemaIdentity original = CurrentSchemaOwnedTargetProjection.Observe(PortableEntity(), references);
        CurrentSchemaCompletePhysicalProjection result = CurrentSchemaCanonicalAuthority.ProjectOwnedTarget(
            PortableEntity(), references, SchemaProviderKind.MySql);
        SchemaTableModel physical = result.Tables.Tables[recipe.Name];
        Assert.Single(physical.IndexDefinitions);
        Assert.Equal(unique, physical.IndexDefinitions["idx_counter"].IsUnique);
        Assert.True(physical.Columns["counter"].IsNullable);
        if (unique)
        {
            SchemaConstraintModel constraint = Assert.Single(physical.Constraints.Values);
            Assert.Equal("idx_counter", constraint.Name);
            Assert.Equal("unique", constraint.Kind);
            Assert.Equal(new[] { "counter" }, constraint.Columns);
        }
        else
        {
            Assert.Empty(physical.Constraints);
        }
        Assert.Empty(recipe.Constraints);
        Assert.Equal(original, result.Tables.Identity);
        Assert.Equal(original, CurrentSchemaOwnedTargetProjection.Observe(PortableEntity(), references));
    }

    [Fact]
    public void MySqlOwnedPrimaryKey_ProjectsImplicitNotNullWithoutChangingOriginalLogicalFacts()
    {
        var columns = new Dictionary<string, SchemaColumnModel>(StringComparer.Ordinal)
        {
            ["counter"] = new("counter", true, false, false, null, "int64"),
            ["other"] = new("other", true, false, false, null, "int64"),
            ["unused"] = new("unused", true, false, false, null, "int64")
        };
        var primary = new SchemaConstraintModel("original_primary", "primary-key", ["other", "counter"]);
        SchemaTableModel recipe = new("recipe", columns, [], constraints: new Dictionary<string, SchemaConstraintModel> { [primary.Name] = primary });
        CurrentSchemaRequiredRecipeReference[] references = [Reference(recipe)];
        CurrentSchemaIdentity original = CurrentSchemaOwnedTargetProjection.Observe(PortableEntity(), references);
        CurrentSchemaCompletePhysicalProjection result = CurrentSchemaCanonicalAuthority.ProjectOwnedTarget(
            PortableEntity(), references, SchemaProviderKind.MySql);
        SchemaTableModel physical = result.Tables.Tables[recipe.Name];
        SchemaConstraintModel nativePrimary = Assert.Single(physical.Constraints.Values);
        Assert.Equal("PRIMARY", nativePrimary.Name);
        Assert.Equal("primary-key", nativePrimary.Kind);
        Assert.Equal(new[] { "other", "counter" }, nativePrimary.Columns);
        Assert.Equal(new[] { "other", "counter" }, Assert.Single(physical.IndexDefinitions.Values).Keys.Select(key => key.Column));
        Assert.All(nativePrimary.Columns, name =>
        {
            Assert.False(physical.Columns[name].IsNullable);
            Assert.True(physical.Columns[name].IsPrimaryKey);
        });
        Assert.True(physical.Columns["unused"].IsNullable);
        Assert.False(physical.Columns["unused"].IsPrimaryKey);
        Assert.All(recipe.Columns.Values, column =>
        {
            Assert.True(column.IsNullable);
            Assert.False(column.IsPrimaryKey);
        });
        Assert.Equal("original_primary", Assert.Single(recipe.Constraints.Values).Name);
        Assert.Equal(original, result.Tables.Identity);
        Assert.Equal(original, CurrentSchemaOwnedTargetProjection.Observe(PortableEntity(), references));
    }

    [Theory]
    [InlineData("duplicate-primary")]
    [InlineData("unique-key-collision")]
    [InlineData("missing-primary-column")]
    [InlineData("reserved-primary-index")]
    public void MySqlOwnedNativeKeys_RefuseCorruptOrConflictingWholeInput(string corruption)
    {
        var columns = new Dictionary<string, SchemaColumnModel>(StringComparer.Ordinal)
        {
            ["counter"] = new("counter", false, false, false, null, "int64"),
            ["other"] = new("other", false, false, false, null, "int64")
        };
        var constraints = new Dictionary<string, SchemaConstraintModel>(StringComparer.Ordinal);
        var indexes = new Dictionary<string, SchemaIndexModel>(StringComparer.Ordinal);
        if (corruption == "duplicate-primary")
        {
            constraints.Add("first", new("first", "primary-key", ["counter"]));
            constraints.Add("second", new("second", "primary-key", ["other"]));
        }
        else if (corruption == "missing-primary-column")
        {
            constraints.Add("first", new("first", "primary-key", ["missing"]));
        }
        else
        {
            string name = corruption == "reserved-primary-index" ? "PRIMARY" : "same_name";
            indexes.Add(name, new(name, true, [new("other", "asc", "first", "default", "default")], [], "btree", null, false));
            if (corruption == "unique-key-collision")
            {
                constraints.Add(name, new(name, "unique", ["counter"]));
            }
        }
        SchemaTableModel recipe = new("recipe", columns, indexes.Keys, indexes, constraints);
        Assert.Throws<InvalidOperationException>(() => CurrentSchemaCanonicalAuthority.ProjectOwnedTarget(
            PortableEntity(), [Reference(recipe)], SchemaProviderKind.MySql));
    }

    [Theory]
    [InlineData("constraint-index")]
    [InlineData("index-index")]
    [InlineData("constraint-constraint")]
    public void MySqlOwnedNativeKeys_RefuseCaseOnlyNamespaceCollisions(string members)
    {
        var columns = new Dictionary<string, SchemaColumnModel>(StringComparer.Ordinal)
        {
            ["counter"] = new("counter", false, false, false, null, "int64"),
            ["other"] = new("other", false, false, false, null, "int64")
        };
        var constraints = new Dictionary<string, SchemaConstraintModel>(StringComparer.Ordinal);
        var indexes = new Dictionary<string, SchemaIndexModel>(StringComparer.Ordinal);
        if (members == "index-index")
        {
            indexes.Add("same_name", new("same_name", true, [new("counter", "asc", "first", "default", "default")], [], "btree", null, false));
        }
        else
        {
            constraints.Add("same_name", new("same_name", "unique", ["counter"]));
        }
        if (members == "constraint-constraint")
        {
            constraints.Add("SAME_NAME", new("SAME_NAME", "unique", ["other"]));
        }
        else
        {
            indexes.Add("SAME_NAME", new("SAME_NAME", true, [new("other", "asc", "first", "default", "default")], [], "btree", null, false));
        }
        SchemaTableModel recipe = new("recipe", columns, indexes.Keys, indexes, constraints);
        Assert.Throws<InvalidOperationException>(() => CurrentSchemaCanonicalAuthority.ProjectOwnedTarget(
            PortableEntity(), [Reference(recipe)], SchemaProviderKind.MySql));
    }

    [Theory]
    [InlineData("primary", true)]
    [InlineData("PrImArY", true)]
    [InlineData("primary", false)]
    [InlineData("PrImArY", false)]
    public void MySqlOwnedNativeKeys_RefuseCaseVariantsOfReservedPrimary(string name, bool explicitIndex)
    {
        SchemaTableModel original = PortableRecipe();
        var indexes = new Dictionary<string, SchemaIndexModel>(StringComparer.Ordinal);
        var constraints = new Dictionary<string, SchemaConstraintModel>(StringComparer.Ordinal);
        if (explicitIndex)
        {
            indexes.Add(name, new(name, true, [new("counter", "asc", "first", "default", "default")], [], "btree", null, false));
        }
        else
        {
            constraints.Add(name, new(name, "unique", ["counter"]));
        }
        SchemaTableModel recipe = new(original.Name, original.Columns, indexes.Keys, indexes, constraints);
        Assert.Throws<InvalidOperationException>(() => CurrentSchemaCanonicalAuthority.ProjectOwnedTarget(
            PortableEntity(), [Reference(recipe)], SchemaProviderKind.MySql));
    }

    [Fact]
    public void MySqlOwnedNativeKeys_PreserveNonconflictingOriginalCaseAndTargetIdentity()
    {
        const string Name = "MiXeD_Key";
        SchemaTableModel original = PortableRecipe();
        var index = new SchemaIndexModel(Name, true, [new("counter", "asc", "first", "default", "default")], [], "btree", null, false);
        SchemaTableModel recipe = new(original.Name, original.Columns, [Name], new Dictionary<string, SchemaIndexModel> { [Name] = index });
        CurrentSchemaRequiredRecipeReference[] references = [Reference(recipe)];
        CurrentSchemaIdentity identity = CurrentSchemaOwnedTargetProjection.Observe(PortableEntity(), references);
        CurrentSchemaCompletePhysicalProjection result = CurrentSchemaCanonicalAuthority.ProjectOwnedTarget(
            PortableEntity(), references, SchemaProviderKind.MySql);
        SchemaTableModel native = result.Tables.Tables[recipe.Name];
        Assert.Equal(Name, Assert.Single(native.IndexDefinitions.Keys));
        Assert.Equal(Name, Assert.Single(native.IndexDefinitions.Values).Name);
        Assert.Equal(Name, Assert.Single(native.Constraints.Keys));
        Assert.Equal(Name, Assert.Single(native.Constraints.Values).Name);
        Assert.Equal(Name, Assert.Single(recipe.IndexDefinitions.Keys));
        Assert.Empty(recipe.Constraints);
        Assert.Equal(identity, result.Tables.Identity);
        Assert.Equal(identity, CurrentSchemaOwnedTargetProjection.Observe(PortableEntity(), references));
    }

    private static CurrentSchemaProjection PortableEntity()
        => CurrentSchemaCanonicalAuthority.Generate(Model(new("payload", false, false, false, null, "int64")));

    private static SchemaTableModel PortableRecipe()
        => new("recipe", new(StringComparer.Ordinal)
        {
            ["counter"] = new("counter", false, false, false, null, "int64")
        }, []);

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
