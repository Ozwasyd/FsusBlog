using FsusBlog.Contracts.Schema;

using Xunit;

namespace FsusBlog.Migration.Tests;

public sealed class CurrentSchemaBootstrapCompilerTests
{
    [Fact]
    public void Bootstrap_HistoryOrderExpressionRendersOnlyBoundFactsAndBindsEveryOrderedKey()
    {
        CurrentSchemaBootstrapInput input = HistoryExpressionInput();
        CurrentSchemaProducerIdentity owner = input.Producer;
        string binding = CurrentSchemaBootstrapCompiler.OwnedInputDigest(input);
        CompiledCurrentSchemaBootstrap compiled = CurrentSchemaBootstrapCompiler.Compile(input, owner,
            SchemaProviderKind.PostgreSql, binding);
        Assert.Equal("CREATE INDEX \"ix_history_order\" ON \"history_probe\" (\"owner_id\" ASC NULLS LAST, GREATEST(\"opened\", \"edited\", \"activated\") DESC NULLS FIRST, \"article_id\" DESC NULLS FIRST);",
            compiled.Commands[^1].Sql);
        Assert.Equal(CurrentSchemaOwnedTargetProjection.Observe(input), compiled.Target);
        CurrentSchemaCompletePhysicalProjection complete = CurrentSchemaCanonicalAuthority.ProjectOwnedTarget(input,
            SchemaProviderKind.PostgreSql);
        SchemaIndexModel original = input.RequiredRecipes[0].SemanticDescription!.AdditionalOperations[0].Index!;
        Assert.Equal(original, complete.Tables.Tables["history_probe"].IndexDefinitions["ix_history_order"]);
        Assert.DoesNotContain(complete.Tables.Tables["history_probe"].Constraints.Values,
            static constraint => constraint.Kind == "unique" && constraint.Columns.Contains(""));
        SchemaIndexKeyModel key = original.Keys[1];
        SchemaIndexModel reordered = original with
        {
            Keys = [original.Keys[0], key with
            {
                Expression = key.Expression! with { Arguments = key.Expression.Arguments.Reverse().ToArray() }
            }, original.Keys[2]]
        };
        CurrentSchemaBootstrapInput changed = WithHistoryIndex(input, reordered);
        Assert.NotEqual(binding, CurrentSchemaBootstrapCompiler.OwnedInputDigest(changed));
        Assert.NotEqual(compiled.Target.ContentDigest, CurrentSchemaOwnedTargetProjection.Observe(changed).ContentDigest);
        Assert.Throws<InvalidOperationException>(() => CurrentSchemaBootstrapCompiler.Compile(changed, owner,
            SchemaProviderKind.PostgreSql, binding));
        Assert.NotEqual(compiled.CommandDigest, CurrentSchemaBootstrapCompiler.Compile(changed, owner,
            SchemaProviderKind.PostgreSql, CurrentSchemaBootstrapCompiler.OwnedInputDigest(changed)).CommandDigest);
    }

    [Theory]
    [InlineData("kind")]
    [InlineData("column-with-expression")]
    [InlineData("raw-column")]
    [InlineData("missing-tree")]
    [InlineData("unknown-function")]
    [InlineData("foreign-column")]
    [InlineData("cast")]
    [InlineData("physical-mysql-payload")]
    [InlineData("unique-expression")]
    public void Bootstrap_HistoryExpressionUnknownOrIgnoredFactsRefuseBeforeCommands(string mutation)
    {
        CurrentSchemaBootstrapInput input = HistoryExpressionInput();
        SchemaIndexModel original = input.RequiredRecipes[0].SemanticDescription!.AdditionalOperations[0].Index!;
        SchemaIndexKeyModel key = original.Keys[1];
        SchemaIndexKeyModel altered = mutation switch
        {
            "kind" => key with { Kind = (SchemaIndexKeyKind)999 },
            "column-with-expression" => key with { Kind = SchemaIndexKeyKind.Column, Column = "opened" },
            "raw-column" => key with { Column = "GREATEST(opened, edited, activated)" },
            "missing-tree" => key with { Expression = null },
            "unknown-function" => key with { Expression = key.Expression! with { Value = "least" } },
            "foreign-column" => key with { Expression = new("call", "greatest", [new("column", "missing", []), new("column", "edited", [])]) },
            "cast" => key with { Expression = new("call", "greatest", [new("cast", "timestamp", [new("column", "opened", [])]), new("column", "edited", [])]) },
            "physical-mysql-payload" => key with { MySqlPhysical = new(null, "ignored") },
            "unique-expression" => key,
            _ => throw new InvalidOperationException("unknown mutation fixture")
        };
        CurrentSchemaBootstrapInput changed = WithHistoryIndex(input, original with
        {
            IsUnique = mutation == "unique-expression",
            Keys = [original.Keys[0], altered, original.Keys[2]]
        });
        Assert.NotEqual(CurrentSchemaBootstrapCompiler.OwnedInputDigest(input),
            CurrentSchemaBootstrapCompiler.OwnedInputDigest(changed));
        Assert.Throws<InvalidOperationException>(() => CurrentSchemaBootstrapCompiler.Compile(changed,
            changed.Producer, SchemaProviderKind.PostgreSql, CurrentSchemaBootstrapCompiler.OwnedInputDigest(changed)));
        Assert.Throws<InvalidOperationException>(() => CurrentSchemaCanonicalAuthority.ProjectOwnedTarget(changed,
            SchemaProviderKind.PostgreSql));
    }

    private static CurrentSchemaBootstrapInput WithHistoryIndex(CurrentSchemaBootstrapInput input, SchemaIndexModel index)
    {
        CurrentSchemaRequiredRecipeReference reference = input.RequiredRecipes[0];
        CurrentSchemaRecipeFacts facts = reference.SemanticDescription!;
        return input with { RequiredRecipes = [reference with
        {
            SemanticDescription = facts with
            {
                AdditionalOperations = [facts.AdditionalOperations[0] with { Index = index }]
            }
        }] };
    }

    private static CurrentSchemaBootstrapInput HistoryExpressionInput()
    {
        var columns = new Dictionary<string, SchemaColumnModel>(StringComparer.Ordinal)
        {
            ["owner_id"] = new("owner_id", false, false, false, null, "int64", PhysicalType: "bigint"),
            ["article_id"] = new("article_id", false, false, false, null, "int64", PhysicalType: "bigint"),
            ["opened"] = new("opened", true, false, false, null, "timestamp", PhysicalType: "timestamp without time zone"),
            ["edited"] = new("edited", true, false, false, null, "timestamp", PhysicalType: "timestamp without time zone"),
            ["activated"] = new("activated", true, false, false, null, "timestamp", PhysicalType: "timestamp without time zone")
        };
        var key = new SchemaIndexKeyModel("", "desc", "first", "default", "default")
        {
            Kind = SchemaIndexKeyKind.Expression,
            Expression = new("call", "greatest", [new("column", "opened", []), new("column", "edited", []), new("column", "activated", [])])
        };
        var index = new SchemaIndexModel("ix_history_order", false,
            [new("owner_id", "asc", "last", "default", "default"), key, new("article_id", "desc", "first", "default", "default")],
            [], "btree", null, false);
        var table = new SchemaTableModel("history_probe", columns, []);
        var operation = new CurrentSchemaRecipeOperation(CurrentSchemaRecipeOperationKind.CreateIndex, index.Name,
            table.Name, Index: index);
        return new(Projection(), Owner(), [new(table.Name, SchemaProviderKind.PostgreSql, new string('d', 64), new(table, [operation]))]);
    }

    [Fact]
    public void Bootstrap_IndependentSequenceTypedFactsPreserveOriginalSqlAndBindCompleteTarget()
    {
        CurrentSchemaProducerIdentity owner = Owner();
        var table = new SchemaTableModel("recipe_probe", new Dictionary<string, SchemaColumnModel>
        {
            ["id"] = new("id", false, false, false, null, "int32", PhysicalType: "integer")
        }, []);
        var sequence = new CurrentSchemaRecipeOperation(CurrentSchemaRecipeOperationKind.CreateSequence, "sequence_probe",
            Sequence: CurrentSchemaIndependentSequenceFacts.PostgreSqlBigIntDefaults);
        var input = new CurrentSchemaBootstrapInput(Projection(), owner,
            [new("recipe_probe", SchemaProviderKind.PostgreSql, new string('d', 64), new(table, [sequence]))]);
        CompiledCurrentSchemaBootstrap compiled = CurrentSchemaBootstrapCompiler.Compile(input, owner,
            SchemaProviderKind.PostgreSql, CurrentSchemaBootstrapCompiler.OwnedInputDigest(input));
        Assert.Equal("CREATE SEQUENCE \"sequence_probe\" AS bigint;", compiled.Commands[^1].Sql);
        Assert.Equal(CurrentSchemaOwnedTargetProjection.Observe(input), compiled.Target);
        var altered = input with
        {
            RequiredRecipes = [input.RequiredRecipes[0] with
            {
                SemanticDescription = new(table, [sequence with
                {
                    Sequence = sequence.Sequence! with { CacheSize = 2 }
                }])
            }]
        };
        Assert.NotEqual(compiled.Target.ContentDigest, CurrentSchemaOwnedTargetProjection.Observe(altered).ContentDigest);
        Assert.Throws<InvalidOperationException>(() => CurrentSchemaBootstrapCompiler.Compile(altered, owner,
            SchemaProviderKind.PostgreSql, CurrentSchemaBootstrapCompiler.OwnedInputDigest(altered)));
    }

    [Fact]
    public void EntitySubset_PostgresCommandsAreDeterministicAndBindCanonicalIdentity()
    {
        CurrentSchemaProjection projection = Projection();
        CompiledCurrentSchemaBootstrap first = CurrentSchemaBootstrapCompiler.CompileEntityProjection(projection, SchemaProviderKind.PostgreSql);
        CompiledCurrentSchemaBootstrap second = CurrentSchemaBootstrapCompiler.CompileEntityProjection(projection, SchemaProviderKind.PostgreSql);
        Assert.Equal(projection.Identity, first.Target);
        Assert.Equal(first.CommandDigest, second.CommandDigest);
        Assert.Equal(first.Commands, second.Commands);
        Assert.Contains("bigserial", first.Commands[0].Sql);
        Assert.Contains("PRIMARY KEY", first.Commands[0].Sql);
        Assert.Contains("NULLS LAST", first.Commands[1].Sql);
        Assert.Equal(projection.Identity, CurrentSchemaCanonicalAuthority.Generate(
            new CurrentSchemaCanonicalModel(projection.Schema, projection.Identity)).Identity);
    }

    [Theory]
    [InlineData(SchemaProviderKind.MySql)]
    [InlineData(SchemaProviderKind.Sqlite)]
    [InlineData(SchemaProviderKind.Semantic)]
    public void MissingNativeProviderCapability_IsExplicitRefusal(SchemaProviderKind provider)
        => Assert.Contains("provider_capability_not_implemented", Assert.Throws<InvalidOperationException>(
            () => CurrentSchemaBootstrapCompiler.CompileEntityProjection(Projection(), provider)).Message);

    [Fact]
    public void Bootstrap_RejectsEveryUnmodelledRecipeBeforeReturningCommands()
    {
        CurrentSchemaProducerIdentity owner = Owner();
        var input = new CurrentSchemaBootstrapInput(Projection(), owner,
            [new CurrentSchemaRequiredRecipeReference("required_current_table", SchemaProviderKind.PostgreSql, new string('b', 64), null)]);
        Assert.Contains("recipe_semantics_unavailable:required_current_table", Assert.Throws<InvalidOperationException>(
            () => CurrentSchemaBootstrapCompiler.Compile(input, owner, SchemaProviderKind.PostgreSql)).Message);
    }

    [Fact]
    public void Bootstrap_RejectsSelfReportedRecipeSemanticBinding()
    {
        CurrentSchemaProducerIdentity owner = Owner();
        CurrentSchemaProjection projection = Projection();
        var input = new CurrentSchemaBootstrapInput(projection, owner,
            [new CurrentSchemaRequiredRecipeReference("required_current_table", SchemaProviderKind.PostgreSql, new string('b', 64),
                new CurrentSchemaRecipeFacts(projection.Schema.Tables["probe"], []))]);
        Assert.Contains("recipe_semantic_binding_invalid", Assert.Throws<InvalidOperationException>(
            () => CurrentSchemaBootstrapCompiler.Compile(input, owner, SchemaProviderKind.PostgreSql)).Message);
    }

    [Fact]
    public void Bootstrap_BoundRecipeFactsCompileCompleteEffectsAndSharedTargetIdentity()
    {
        CurrentSchemaProducerIdentity owner = Owner();
        var columns = new Dictionary<string, SchemaColumnModel>(StringComparer.Ordinal)
        {
            ["id"] = new("id", false, true, false, null, "int32", PhysicalType: "integer"),
            ["value"] = new("value", false, false, false, null, "int32", DefaultValue: "0", PhysicalType: "integer")
        };
        var constraints = new Dictionary<string, SchemaConstraintModel>(StringComparer.Ordinal)
        {
            ["recipe_probe_pkey"] = new("recipe_probe_pkey", "primary-key", ["id"])
        };
        var table = new SchemaTableModel("recipe_probe", columns, [], constraints: constraints);
        var facts = new CurrentSchemaRecipeFacts(table,
        [
            new(CurrentSchemaRecipeOperationKind.DefineImmutableGuard, "recipe_guard", ErrorCode: "immutable_row"),
            new(CurrentSchemaRecipeOperationKind.RemoveTrigger, "recipe_trigger", "recipe_probe"),
            new(CurrentSchemaRecipeOperationKind.CreateImmutableTrigger, "recipe_trigger", "recipe_probe", Function: "recipe_guard"),
            new(CurrentSchemaRecipeOperationKind.InsertIfAbsent, "recipe_probe", "recipe_probe", Columns: ["id", "value"], Values: ["1", "0"], ConflictColumn: "id")
        ]);
        var input = new CurrentSchemaBootstrapInput(Projection(), owner,
            [new("recipe_probe", SchemaProviderKind.PostgreSql, new string('d', 64), facts)]);
        string binding = CurrentSchemaBootstrapCompiler.OwnedInputDigest(input);
        CompiledCurrentSchemaBootstrap compiled = CurrentSchemaBootstrapCompiler.Compile(input, owner, SchemaProviderKind.PostgreSql, binding);
        Assert.Equal(7, compiled.Commands.Count);
        Assert.Contains("CREATE FUNCTION", compiled.Commands[3].Sql);
        Assert.Contains("BEFORE UPDATE OR DELETE", compiled.Commands[5].Sql);
        Assert.False(compiled.Commands[6].IsDdl);
        Assert.NotEqual(input.EntityProjection.Identity.ContentDigest, compiled.Target.ContentDigest);
        Assert.Equal(compiled.Target, CurrentSchemaBootstrapCompiler.Compile(input, owner, SchemaProviderKind.PostgreSql, binding).Target);
        var dropped = input with { RequiredRecipes = [] };
        Assert.Contains("recipe_closure_unavailable", Assert.Throws<InvalidOperationException>(() =>
            CurrentSchemaBootstrapCompiler.Compile(dropped, owner, SchemaProviderKind.PostgreSql, binding)).Message);
        table.Columns["value"] = columns["value"] with { DefaultValue = "1" };
        Assert.Contains("recipe_semantic_binding_invalid", Assert.Throws<InvalidOperationException>(() =>
            CurrentSchemaBootstrapCompiler.Compile(input, owner, SchemaProviderKind.PostgreSql, binding)).Message);
    }

    [Fact]
    public void Bootstrap_BoundFactsRejectUnknownEffectAndIgnoredArguments()
    {
        CurrentSchemaProducerIdentity owner = Owner();
        var table = new SchemaTableModel("recipe_probe", new Dictionary<string, SchemaColumnModel>
        {
            ["id"] = new("id", false, false, false, null, "int32", PhysicalType: "integer")
        }, []);
        foreach (CurrentSchemaRecipeOperation operation in new[]
        {
            new CurrentSchemaRecipeOperation((CurrentSchemaRecipeOperationKind)999, "unknown"),
            new CurrentSchemaRecipeOperation(CurrentSchemaRecipeOperationKind.CreateSequence, "sequence_probe", ErrorCode: "ignored")
        })
        {
            var input = new CurrentSchemaBootstrapInput(Projection(), owner,
                [new("recipe_probe", SchemaProviderKind.PostgreSql, new string('d', 64), new(table, [operation]))]);
            Assert.Throws<InvalidOperationException>(() => CurrentSchemaBootstrapCompiler.Compile(input, owner,
                SchemaProviderKind.PostgreSql, CurrentSchemaBootstrapCompiler.OwnedInputDigest(input)));
        }
    }

    [Fact]
    public void Bootstrap_RejectsDifferentProducerBytes()
    {
        CurrentSchemaProducerIdentity owner = Owner();
        var input = new CurrentSchemaBootstrapInput(Projection(), owner, []);
        Assert.Contains("owner_binding_invalid", Assert.Throws<InvalidOperationException>(
            () => CurrentSchemaBootstrapCompiler.Compile(input, owner with { ProducerAssemblySha256 = new string('c', 64) },
                SchemaProviderKind.PostgreSql)).Message);
    }

    [Fact]
    public void FullBootstrap_EmptyRecipeRosterCannotFallBackToEntitySubset()
    {
        CurrentSchemaProducerIdentity owner = Owner();
        var empty = new CurrentSchemaBootstrapInput(Projection(), owner, []);
        Assert.Contains("recipe_closure_unavailable", Assert.Throws<InvalidOperationException>(() =>
            CurrentSchemaBootstrapCompiler.Compile(empty, owner, SchemaProviderKind.PostgreSql,
                CurrentSchemaBootstrapCompiler.OwnedInputDigest(empty))).Message);
        Assert.NotEmpty(CurrentSchemaBootstrapCompiler.CompileEntityProjection(empty.EntityProjection, SchemaProviderKind.PostgreSql).Commands);
    }

    [Fact]
    public void EntitySubset_RejectsContentDriftAndIncompleteIndexDescription()
    {
        CurrentSchemaProjection projection = Projection();
        projection.Schema.Tables["probe"].Columns.Remove("name");
        Assert.Throws<InvalidOperationException>(() =>
            CurrentSchemaBootstrapCompiler.CompileEntityProjection(projection, SchemaProviderKind.PostgreSql));

        projection = Projection();
        projection.Schema.Tables["probe"].Indexes.Add("unknown_index");
        Assert.Contains("index_description_incomplete", Assert.Throws<InvalidOperationException>(() =>
            CurrentSchemaBootstrapCompiler.CompileEntityProjection(projection, SchemaProviderKind.PostgreSql)).Message);
    }

    [Fact]
    public void EntitySubset_RejectsUnsupportedDefaultWithoutSilentlyDroppingIt()
    {
        CurrentSchemaProjection projection = Projection(defaultValue: "unknown_default()");
        Assert.Contains("default_capability_unavailable", Assert.Throws<InvalidOperationException>(() =>
            CurrentSchemaBootstrapCompiler.CompileEntityProjection(projection, SchemaProviderKind.PostgreSql)).Message);
    }

    [Fact]
    public void EntitySubset_CurrentStringDefaultIsATypeDerivedLiteralNotAnIdentifier()
    {
        CompiledCurrentSchemaBootstrap compiled = CurrentSchemaBootstrapCompiler.CompileEntityProjection(
            Projection(defaultValue: "pending"), SchemaProviderKind.PostgreSql);
        Assert.Contains("DEFAULT 'pending'", compiled.Commands[0].Sql);
    }

    private static CurrentSchemaProducerIdentity Owner()
        => new(new string('a', 40), "fsusblog.current-schema-owned-projection.v1", new string('b', 64), new string('c', 64));

    private static CurrentSchemaProjection Projection(string? defaultValue = null)
    {
        var columns = new Dictionary<string, SchemaColumnModel>(StringComparer.Ordinal)
        {
            ["id"] = new("id", false, true, true, null, "int64"),
            ["name"] = new("name", true, false, false, 64, "string", DefaultValue: defaultValue)
        };
        var indexes = new Dictionary<string, SchemaIndexModel>(StringComparer.Ordinal)
        {
            ["ix_probe_name"] = new("ix_probe_name", false, [new("name", "asc", "last", "default", "default")], [], "btree", null, false)
        };
        var constraints = new Dictionary<string, SchemaConstraintModel>(StringComparer.Ordinal)
        {
            ["pk_probe"] = new("pk_probe", "primary-key", ["id"])
        };
        var tables = new Dictionary<string, SchemaTableModel>(StringComparer.Ordinal)
        {
            ["probe"] = new("probe", columns, indexes.Keys, indexes, constraints, new("synthetic-contract-fixture", "synthetic-contract-fixture"))
        };
        return CurrentSchemaCanonicalAuthority.Generate(CurrentSchemaCanonicalAuthority.Create(tables, new string('a', 64)));
    }
}
