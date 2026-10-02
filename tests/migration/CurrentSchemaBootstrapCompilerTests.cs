using FsusBlog.Contracts.Schema;

using Xunit;

namespace FsusBlog.Migration.Tests;

public sealed class CurrentSchemaBootstrapCompilerTests
{
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
            [new CurrentSchemaRequiredRecipeReference("required_current_table", SchemaProviderKind.PostgreSql, new string('b', 64), projection.Schema)]);
        Assert.Contains("recipe_semantic_binding_not_implemented", Assert.Throws<InvalidOperationException>(
            () => CurrentSchemaBootstrapCompiler.Compile(input, owner, SchemaProviderKind.PostgreSql)).Message);
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
