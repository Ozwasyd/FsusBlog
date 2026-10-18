using FsusBlog.Contracts.Schema;

using Xunit;

namespace FsusBlog.Migration.Tests;

// Compiler controls are not native provider acceptance, backup admission or SQLite incarnation proof.
public sealed class CurrentSchemaPortableBootstrapCompilerTests
{
    [Theory]
    [InlineData(SchemaProviderKind.MySql)]
    [InlineData(SchemaProviderKind.Sqlite)]
    public void EntitySubset_UsesSoleProjectionAndNativeDialectWithoutChangingTarget(SchemaProviderKind provider)
    {
        CurrentSchemaProjection projection = Projection();
        CompiledCurrentSchemaBootstrap first = CurrentSchemaPortableBootstrapCompiler.CompileEntitySubset(projection, provider);
        CompiledCurrentSchemaBootstrap second = CurrentSchemaPortableBootstrapCompiler.CompileEntitySubset(projection, provider);
        Assert.Equal(projection.Identity, first.Target);
        Assert.Equal(first.CommandDigest, second.CommandDigest);
        Assert.Equal(first.Commands, second.Commands);
        Assert.Contains("DEFAULT 'pending'", first.Commands[0].Sql);
        if (provider == SchemaProviderKind.MySql)
        {
            Assert.Contains("`id` bigint AUTO_INCREMENT", first.Commands[0].Sql);
            Assert.Contains("ENGINE=InnoDB", first.Commands[0].Sql);
            Assert.Contains("`name` varchar(64)", first.Commands[0].Sql);
        }
        else
        {
            Assert.Contains("\"id\" INTEGER CONSTRAINT \"pk_probe\" PRIMARY KEY AUTOINCREMENT", first.Commands[0].Sql);
            Assert.Contains("\"name\" TEXT", first.Commands[0].Sql);
        }
        Assert.DoesNotContain("bigserial", first.Commands[0].Sql);
        Assert.DoesNotContain("NULLS", first.Commands[1].Sql);
        Assert.Throws<InvalidOperationException>(() => CurrentSchemaBootstrapCompiler.CompileEntityProjection(projection, provider));
    }

    [Theory]
    [InlineData(SchemaProviderKind.MySql)]
    [InlineData(SchemaProviderKind.Sqlite)]
    public void OwnedFacts_BindOriginalCompleteTargetAndCannotAcceptUnboundRecipes(SchemaProviderKind provider)
    {
        CurrentSchemaBootstrapInput input = Input([]);
        string binding = CurrentSchemaBootstrapCompiler.OwnedInputDigest(input);
        CompiledCurrentSchemaBootstrap compiled = CurrentSchemaPortableBootstrapCompiler.CompileOwnedFacts(input, input.Producer, provider, binding);
        Assert.Equal(CurrentSchemaOwnedTargetProjection.Observe(input), compiled.Target);
        Assert.Equal(3, compiled.Commands.Count);
        Assert.Throws<InvalidOperationException>(() => CurrentSchemaPortableBootstrapCompiler.CompileOwnedFacts(input,
            input.Producer with
            {
                ProducerAssemblySha256 = new string('d', 64)
            }, provider, binding));
        input.RequiredRecipes[0].SemanticDescription!.Table.Columns["id"] = new("id", false, true, false, null, "int64", PhysicalType: "bigint");
        Assert.Throws<InvalidOperationException>(() => CurrentSchemaPortableBootstrapCompiler.CompileOwnedFacts(input, input.Producer, provider, binding));
    }

    [Theory]
    [InlineData(SchemaProviderKind.MySql, CurrentSchemaRecipeOperationKind.CreateSequence)]
    [InlineData(SchemaProviderKind.Sqlite, CurrentSchemaRecipeOperationKind.CreateSequence)]
    [InlineData(SchemaProviderKind.MySql, CurrentSchemaRecipeOperationKind.DefineImmutableGuard)]
    [InlineData(SchemaProviderKind.Sqlite, CurrentSchemaRecipeOperationKind.DefineImmutableGuard)]
    public void OwnedFacts_RefuseUnimplementedEffectsRatherThanInventCounterTables(
        SchemaProviderKind provider, CurrentSchemaRecipeOperationKind kind)
    {
        CurrentSchemaRecipeOperation operation = kind == CurrentSchemaRecipeOperationKind.CreateSequence
            ? new(kind, "probe_sequence") : new(kind, "probe_guard", ErrorCode: "immutable_row");
        CurrentSchemaBootstrapInput input = Input([operation]);
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() =>
            CurrentSchemaPortableBootstrapCompiler.CompileOwnedFacts(input, input.Producer, provider,
                CurrentSchemaBootstrapCompiler.OwnedInputDigest(input)));
        Assert.Equal("portable_bootstrap_recipe_effect_unavailable", error.Message);
    }

    [Theory]
    [InlineData(SchemaProviderKind.MySql)]
    [InlineData(SchemaProviderKind.Sqlite)]
    public void OwnedFacts_CreateIndexUsesClosedTypedEffectAndOriginalTarget(SchemaProviderKind provider)
    {
        var index = new SchemaIndexModel("ix_recipe_id", false, [new("id", "desc", "first", "default", "default")], [], "btree", null, false);
        CurrentSchemaBootstrapInput input = Input([new(CurrentSchemaRecipeOperationKind.CreateIndex, index.Name, "recipe_probe", Index: index)]);
        CompiledCurrentSchemaBootstrap compiled = CurrentSchemaPortableBootstrapCompiler.CompileOwnedFacts(input, input.Producer, provider,
            CurrentSchemaBootstrapCompiler.OwnedInputDigest(input));
        Assert.Equal(CurrentSchemaOwnedTargetProjection.Observe(input), compiled.Target);
        Assert.Equal(4, compiled.Commands.Count);
        Assert.Contains(" DESC", compiled.Commands[3].Sql);
        Assert.Contains("ix_recipe_id", compiled.Commands[3].Sql);
    }

    [Theory]
    [InlineData(SchemaProviderKind.MySql, "null-order")]
    [InlineData(SchemaProviderKind.Sqlite, "null-order")]
    [InlineData(SchemaProviderKind.MySql, "index-incomplete")]
    [InlineData(SchemaProviderKind.Sqlite, "index-incomplete")]
    [InlineData(SchemaProviderKind.MySql, "unknown-default")]
    [InlineData(SchemaProviderKind.Sqlite, "unknown-default")]
    [InlineData(SchemaProviderKind.MySql, "identifier-lf")]
    [InlineData(SchemaProviderKind.Sqlite, "identifier-lf")]
    public void EntitySubset_RefusesUnsupportedOrAmbiguousFacts(SchemaProviderKind provider, string invalid)
    {
        CurrentSchemaProjection valid = Projection();
        Assert.NotEmpty(CurrentSchemaPortableBootstrapCompiler.CompileEntitySubset(valid, provider).Commands);
        SchemaTableModel table = valid.Schema.Tables["probe"];
        if (invalid == "index-incomplete")
            table.Indexes.Add("not_observed");
        else
            table.Columns["name"] = table.Columns["name"] with
            {
                IsNullable = invalid == "null-order",
                DefaultValue = invalid == "unknown-default" ? "unowned_function()" : "pending",
                Name = invalid == "identifier-lf" ? "name\n" : "name"
            };
        // Reseal supported source facts so rejection exercises provider capability,
        // not merely an earlier semantic content hash mismatch.
        CurrentSchemaProjection changed = CurrentSchemaCanonicalAuthority.Generate(
            CurrentSchemaCanonicalAuthority.Create(valid.Schema.Tables, valid.Identity.SourceDigest));
        Assert.Throws<InvalidOperationException>(() => CurrentSchemaPortableBootstrapCompiler.CompileEntitySubset(changed, provider));
    }

    [Fact]
    public void MySql_RefusesResealedBackslashLiteralWithoutSqlModeProof()
    {
        CurrentSchemaProjection projection = Projection();
        SchemaTableModel table = projection.Schema.Tables["probe"];
        table.Columns["name"] = table.Columns["name"] with
        {
            DefaultValue = @"'a\b'"
        };
        CurrentSchemaProjection resealed = CurrentSchemaCanonicalAuthority.Generate(
            CurrentSchemaCanonicalAuthority.Create(projection.Schema.Tables, projection.Identity.SourceDigest));
        InvalidOperationException subset = Assert.Throws<InvalidOperationException>(() =>
            CurrentSchemaPortableBootstrapCompiler.CompileEntitySubset(resealed, SchemaProviderKind.MySql));
        Assert.Equal("portable_bootstrap_default_escape_unavailable", subset.Message);
        CurrentSchemaBootstrapInput input = Input([]) with
        {
            EntityProjection = resealed
        };
        string binding = CurrentSchemaBootstrapCompiler.OwnedInputDigest(input);
        // Original owner/input admission succeeds; refusal is the native dialect's
        // unsupported escape semantics, not an obsolete content seal.
        Assert.NotEmpty(CurrentSchemaBootstrapCompiler.Compile(input, input.Producer, SchemaProviderKind.PostgreSql, binding).Commands);
        InvalidOperationException owned = Assert.Throws<InvalidOperationException>(() =>
            CurrentSchemaPortableBootstrapCompiler.CompileOwnedFacts(input, input.Producer, SchemaProviderKind.MySql, binding));
        Assert.Equal("portable_bootstrap_default_escape_unavailable", owned.Message);
    }

    [Theory]
    [InlineData(SchemaProviderKind.MySql, "'pending'")]
    [InlineData(SchemaProviderKind.Sqlite, "'pending'")]
    [InlineData(SchemaProviderKind.MySql, "'can''t'")]
    [InlineData(SchemaProviderKind.Sqlite, "'can''t'")]
    public void OwnedFacts_PreserveSupportedQuotedLiteralDefaults(SchemaProviderKind provider, string literal)
    {
        CurrentSchemaProjection projection = Projection();
        SchemaTableModel table = projection.Schema.Tables["probe"];
        table.Columns["name"] = table.Columns["name"] with
        {
            DefaultValue = literal
        };
        CurrentSchemaProjection resealed = CurrentSchemaCanonicalAuthority.Generate(
            CurrentSchemaCanonicalAuthority.Create(projection.Schema.Tables, projection.Identity.SourceDigest));
        CurrentSchemaBootstrapInput input = Input([]) with
        {
            EntityProjection = resealed
        };
        CompiledCurrentSchemaBootstrap compiled = CurrentSchemaPortableBootstrapCompiler.CompileOwnedFacts(input,
            input.Producer, provider, CurrentSchemaBootstrapCompiler.OwnedInputDigest(input));
        Assert.Equal(CurrentSchemaOwnedTargetProjection.Observe(input), compiled.Target);
        Assert.Contains("DEFAULT " + literal, compiled.Commands[0].Sql);
    }

    [Theory]
    [InlineData(SchemaProviderKind.MySql)]
    [InlineData(SchemaProviderKind.Sqlite)]
    public void OwnedFacts_FoldAddedColumnIntoFinalEmptyTableWithoutMutatingBoundInput(SchemaProviderKind provider)
    {
        // Owned recipe columns retain the original PostgreSQL physical type;
        // int64 projects to bigint before the portable relational fold.
        var column = new SchemaColumnModel("added_counter", true, false, false, null, "int64", PhysicalType: "bigint");
        CurrentSchemaBootstrapInput input = Input([new(CurrentSchemaRecipeOperationKind.AddColumnIfAbsent,
            column.Name, "recipe_probe", Column: column)]);
        string binding = CurrentSchemaBootstrapCompiler.OwnedInputDigest(input);
        Assert.NotEmpty(CurrentSchemaBootstrapCompiler.Compile(input, input.Producer,
            SchemaProviderKind.PostgreSql, binding).Commands);
        CompiledCurrentSchemaBootstrap compiled = CurrentSchemaPortableBootstrapCompiler.CompileOwnedFacts(
            input, input.Producer, provider, binding);
        Assert.Equal(3, compiled.Commands.Count);
        Assert.Contains(provider == SchemaProviderKind.MySql ? "`added_counter` bigint NULL" : "\"added_counter\" INTEGER NULL", compiled.Commands[1].Sql);
        Assert.All(compiled.Commands, command => Assert.DoesNotContain("ALTER TABLE", command.Sql));
        Assert.False(input.RequiredRecipes[0].SemanticDescription!.Table.Columns.ContainsKey(column.Name));
        Assert.Equal(binding, CurrentSchemaBootstrapCompiler.OwnedInputDigest(input));
        Assert.Equal(CurrentSchemaOwnedTargetProjection.Observe(input), compiled.Target);
        Assert.False(CurrentSchemaPortableBootstrapCompiler.ProducesCompleteCurrentBootstrap);
    }

    [Theory]
    [InlineData(SchemaProviderKind.MySql)]
    [InlineData(SchemaProviderKind.Sqlite)]
    public void OwnedFacts_FoldTypedUniqueConstraintOnceWithoutAnotherBackingIndexCommand(SchemaProviderKind provider)
    {
        var constraint = new SchemaConstraintModel("uq_recipe_counter", "unique", ["counter"]);
        CurrentSchemaBootstrapInput input = Input([new(CurrentSchemaRecipeOperationKind.AddConstraintIfAbsent,
            constraint.Name, "recipe_probe", Constraint: constraint)]);
        SchemaTableModel original = input.RequiredRecipes[0].SemanticDescription!.Table;
        original.Columns.Add("counter", new("counter", false, false, false, null, "int64", PhysicalType: "bigint"));
        string binding = CurrentSchemaBootstrapCompiler.OwnedInputDigest(input);
        Assert.NotEmpty(CurrentSchemaBootstrapCompiler.Compile(input, input.Producer,
            SchemaProviderKind.PostgreSql, binding).Commands);
        CompiledCurrentSchemaBootstrap compiled = CurrentSchemaPortableBootstrapCompiler.CompileOwnedFacts(
            input, input.Producer, provider, binding);
        Assert.Equal(3, compiled.Commands.Count);
        Assert.Contains(provider == SchemaProviderKind.MySql ? "CONSTRAINT `uq_recipe_counter` UNIQUE (`counter`)"
            : "CONSTRAINT \"uq_recipe_counter\" UNIQUE (\"counter\")", compiled.Commands[1].Sql);
        Assert.All(compiled.Commands, command => Assert.DoesNotContain("CREATE UNIQUE INDEX", command.Sql));
        Assert.False(original.Constraints.ContainsKey(constraint.Name));
        Assert.Equal(binding, CurrentSchemaBootstrapCompiler.OwnedInputDigest(input));
        Assert.Equal(CurrentSchemaOwnedTargetProjection.Observe(input), compiled.Target);
        Assert.False(CurrentSchemaPortableBootstrapCompiler.ProducesCompleteCurrentBootstrap);
    }

    [Theory]
    [InlineData(SchemaProviderKind.MySql, "conflicting-column")]
    [InlineData(SchemaProviderKind.Sqlite, "conflicting-column")]
    [InlineData(SchemaProviderKind.MySql, "unused-effect-field")]
    [InlineData(SchemaProviderKind.Sqlite, "unused-effect-field")]
    [InlineData(SchemaProviderKind.MySql, "raw-check")]
    [InlineData(SchemaProviderKind.Sqlite, "raw-check")]
    [InlineData(SchemaProviderKind.MySql, "raw-predicate")]
    [InlineData(SchemaProviderKind.Sqlite, "raw-predicate")]
    [InlineData(SchemaProviderKind.MySql, "foreign-key")]
    [InlineData(SchemaProviderKind.Sqlite, "foreign-key")]
    public void OwnedFacts_RefuseConflictsAndUnspecifiedTypedOrRawRelationalEffects(SchemaProviderKind provider, string invalid)
    {
        var column = new SchemaColumnModel(invalid == "conflicting-column" ? "id" : "added", false, false, false, null, "int64");
        CurrentSchemaRecipeOperation effect = invalid switch
        {
            "raw-check" => new(CurrentSchemaRecipeOperationKind.AddConstraintIfAbsent, "ck_recipe", "recipe_probe",
                Constraint: new("ck_recipe", "check", [], Expression: "id > 0")),
            "raw-predicate" => new(CurrentSchemaRecipeOperationKind.CreateIndex, "ix_recipe", "recipe_probe",
                Index: new("ix_recipe", false, [new("id", "asc", "last", "default", "default")], [], "btree", "id > 0", false)),
            "foreign-key" => new(CurrentSchemaRecipeOperationKind.AddConstraintIfAbsent, "fk_recipe", "recipe_probe",
                Constraint: new("fk_recipe", "foreign-key", ["id"], ReferencedTable: "probe", ReferencedColumns: ["id"],
                    ReferencedSchema: "public", ForeignKeyMatchType: "simple", ForeignKeyUpdateAction: "no-action", ForeignKeyDeleteAction: "no-action")),
            _ => new(CurrentSchemaRecipeOperationKind.AddColumnIfAbsent, column.Name, "recipe_probe", Column: column,
                Values: invalid == "unused-effect-field" ? ["1"] : null)
        };
        CurrentSchemaBootstrapInput input = Input([effect]);
        string binding = CurrentSchemaBootstrapCompiler.OwnedInputDigest(input);
        if (invalid is "raw-check" or "raw-predicate" or "foreign-key")
        {
            // The original source/input and PG grammar are accepted. Portable
            // refusal must not be mistaken for an obsolete ownership seal.
            Assert.NotEmpty(CurrentSchemaBootstrapCompiler.Compile(input, input.Producer,
                SchemaProviderKind.PostgreSql, binding).Commands);
        }
        Assert.Throws<InvalidOperationException>(() => CurrentSchemaPortableBootstrapCompiler.CompileOwnedFacts(
            input, input.Producer, provider, binding));
        Assert.Equal(binding, CurrentSchemaBootstrapCompiler.OwnedInputDigest(input));
        Assert.False(CurrentSchemaPortableBootstrapCompiler.ProducesCompleteCurrentBootstrap);
    }

    [Theory]
    [InlineData(SchemaProviderKind.MySql)]
    [InlineData(SchemaProviderKind.Sqlite)]
    public void OwnedFacts_StillBindWholeOriginalOwnerAndInputBeforeRelationalFold(SchemaProviderKind provider)
    {
        var column = new SchemaColumnModel("added", false, false, false, null, "int64");
        CurrentSchemaBootstrapInput input = Input([new(CurrentSchemaRecipeOperationKind.AddColumnIfAbsent,
            column.Name, "recipe_probe", Column: column)]);
        string binding = CurrentSchemaBootstrapCompiler.OwnedInputDigest(input);
        Assert.Throws<InvalidOperationException>(() => CurrentSchemaPortableBootstrapCompiler.CompileOwnedFacts(
            input, input.Producer with
            {
                ContractAssemblySha256 = new string('e', 64)
            }, provider, binding));
        Assert.Throws<InvalidOperationException>(() => CurrentSchemaPortableBootstrapCompiler.CompileOwnedFacts(
            input, input.Producer, provider, new string('e', 64)));
        Assert.False(input.RequiredRecipes[0].SemanticDescription!.Table.Columns.ContainsKey(column.Name));
        Assert.Equal(binding, CurrentSchemaBootstrapCompiler.OwnedInputDigest(input));
    }

    private static CurrentSchemaBootstrapInput Input(IReadOnlyList<CurrentSchemaRecipeOperation> operations)
    {
        var recipe = new SchemaTableModel("recipe_probe", new Dictionary<string, SchemaColumnModel>
        {
            ["id"] = new("id", false, true, false, null, "int32", PhysicalType: "integer")
        }, [], constraints: new Dictionary<string, SchemaConstraintModel>
        {
            ["pk_recipe_probe"] = new("pk_recipe_probe", "primary-key", ["id"])
        });
        var owner = new CurrentSchemaProducerIdentity(new string('a', 40), "fsusblog.current-schema-owned-projection.v1",
            new string('b', 64), new string('c', 64));
        return new(Projection(), owner, [new("recipe_probe", SchemaProviderKind.PostgreSql, new string('d', 64), new(recipe, operations))]);
    }

    private static CurrentSchemaProjection Projection()
    {
        var indexes = new Dictionary<string, SchemaIndexModel>
        {
            ["ix_probe_name"] = new("ix_probe_name", false, [new("name", "asc", "last", "default", "default")], [], "btree", null, false)
        };
        var tables = new Dictionary<string, SchemaTableModel>
        {
            ["probe"] = new("probe", new Dictionary<string, SchemaColumnModel>
            {
                ["id"] = new("id", false, true, true, null, "int64"),
                ["name"] = new("name", false, false, false, 64, "string", DefaultValue: "pending")
            }, indexes.Keys, indexes, new Dictionary<string, SchemaConstraintModel>
            {
                ["pk_probe"] = new("pk_probe", "primary-key", ["id"])
            })
        };
        return CurrentSchemaCanonicalAuthority.Generate(CurrentSchemaCanonicalAuthority.Create(tables, new string('a', 64)));
    }
}
