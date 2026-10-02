using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Contracts.Schema;
using FsusBlog.Server.Infrastructure.SchemaMigration;

namespace FsusBlog.Server.Tests;

public sealed class CurrentSchemaOwnedProjectionExporterTests
{
    [Fact]
    public void LiveReaderProjectionOverloads_KeepTheOriginalCompositeIdentityAndPhysicalFacts()
    {
        var inspector = new SchemaModelInspector();
        CurrentSchemaProjection entity = CurrentSchemaCanonicalAuthority.Generate(
            inspector.BuildCanonicalModel(inspector.GetManagedEntityTypes()));
        IReadOnlyList<CurrentSchemaRequiredRecipeReference> recipes = CurrentSchemaOwnedProjectionExporter.DescribeRequiredRecipes();
        var producer = new CurrentSchemaProducerIdentity(new string('a', 40), CurrentSchemaOwnedProjectionExporter.ProducerId,
            new string('b', 64), new string('c', 64));
        var input = new CurrentSchemaBootstrapInput(entity, producer, recipes);

        CurrentSchemaIdentity composite = CurrentSchemaOwnedTargetProjection.Observe(input);
        Assert.NotEqual(entity.Identity, composite);
        Assert.Equal(composite, CurrentSchemaOwnedTargetProjection.Observe(entity, recipes));
        CurrentSchemaCompletePhysicalProjection bound = CurrentSchemaCanonicalAuthority.ProjectOwnedTarget(input, SchemaProviderKind.PostgreSql);
        CurrentSchemaCompletePhysicalProjection live = CurrentSchemaCanonicalAuthority.ProjectOwnedTarget(entity, recipes, SchemaProviderKind.PostgreSql);
        Assert.Equal(System.Text.Json.JsonSerializer.Serialize(bound), System.Text.Json.JsonSerializer.Serialize(live));
    }

    [Fact]
    public async Task OriginalOwnerInvocation_PublishesCompleteFactsAndRetainsActualChildEvidence()
    {
        Assembly producerAssembly = typeof(CurrentSchemaOwnedProjectionExporter).Assembly;
        string sourceRevision = producerAssembly.GetCustomAttributes<AssemblyMetadataAttribute>()
            .Single(static attribute => attribute.Key == "FsusBlog.SourceCommit").Value!;
        Assert.NotEqual(new string('0', 40), sourceRevision);
        string taskRoot = Directory.CreateTempSubdirectory("fsusblog-owned-target-invocation-").FullName;
        using var cancellation = new CancellationTokenSource();
        var owned = await FsusBlog.Migration.OwnedCurrentSchemaTarget.InvokeOriginalOwnerAsync(
            producerAssembly.Location, sourceRevision, taskRoot, cancellation.Token);
        CurrentSchemaBootstrapInput input = owned.ReadBoundInput();
        Assert.Equal(0, owned.Execution.ExitCode);
        Assert.Equal(sourceRevision, owned.Execution.SourceRevision);
        Assert.Equal(CurrentSchemaRuntimeRollupTables.Tables.Count, input.RequiredRecipes.Count);
        Assert.Equal(CurrentSchemaOwnedTargetProjection.Observe(input), owned.Target);
        Assert.Equal(input.Producer.ContractAssemblySha256, Convert.ToHexString(SHA256.HashData(
            await File.ReadAllBytesAsync(typeof(CurrentSchemaCanonicalAuthority).Assembly.Location))).ToLowerInvariant());
        Assert.Contains(owned.Execution.ProducerFiles, static file => file.RelativePath == "FsusBlog.Server.dll");
        Assert.True(File.Exists(Path.Combine(owned.Execution.EvidenceDirectory, "stdout.log")));
        Assert.True(File.Exists(Path.Combine(owned.Execution.EvidenceDirectory, "stderr.log")));
        Assert.True(File.Exists(Path.Combine(owned.Execution.EvidenceDirectory, "child-terminal.json")));
        Assert.True(File.Exists(Path.Combine(owned.Execution.EvidenceDirectory, "result.json")));
        Assert.NotEmpty(owned.Compile(SchemaProviderKind.PostgreSql).Commands);
        Assert.Throws<InvalidOperationException>(() => owned.Compile(SchemaProviderKind.MySql));
        Assert.Throws<InvalidOperationException>(() => owned.Compile(SchemaProviderKind.Sqlite));
        input.EntityProjection.Schema.Tables.Values.First().Columns.Clear();
        Assert.NotEmpty(owned.ReadBoundInput().EntityProjection.Schema.Tables.Values.First().Columns);
    }

    [Fact]
    public void ExportOnlyCommand_RequiresExactArgumentsAndANewAbsoluteOutput()
    {
        string directory = Directory.CreateTempSubdirectory("fsusblog-current-owner-command-").FullName;
        string output = Path.Combine(directory, "owned-target.json");
        Assert.True(CurrentSchemaOwnedTargetExportCommand.IsRequested([CurrentSchemaOwnedTargetExportCommand.Command]));
        Assert.False(CurrentSchemaOwnedTargetExportCommand.IsRequested(["serve"]));
        Assert.Equal(output, CurrentSchemaOwnedTargetExportCommand.ParseOutputPath(
            [CurrentSchemaOwnedTargetExportCommand.Command, "--output", output]));
        Assert.Throws<InvalidOperationException>(() => CurrentSchemaOwnedTargetExportCommand.ParseOutputPath(
            [CurrentSchemaOwnedTargetExportCommand.Command, "--output", "relative.json"]));
        Assert.Throws<InvalidOperationException>(() => CurrentSchemaOwnedTargetExportCommand.ParseOutputPath(
            [CurrentSchemaOwnedTargetExportCommand.Command, "--output", output, "--serve"]));
        File.WriteAllText(output, "retained existing bytes");
        Assert.Throws<InvalidOperationException>(() => CurrentSchemaOwnedTargetExportCommand.ParseOutputPath(
            [CurrentSchemaOwnedTargetExportCommand.Command, "--output", output]));
        Assert.Equal("retained existing bytes", File.ReadAllText(output));
    }

    [Fact]
    public void OwnedArtifactReader_BindsOriginalFactsAndRejectsDuplicateUnknownOrTamperedPayload()
    {
        var inspector = new SchemaModelInspector();
        CurrentSchemaProjection projection = CurrentSchemaCanonicalAuthority.Generate(inspector.BuildCanonicalModel(inspector.GetManagedEntityTypes()));
        var producer = new CurrentSchemaProducerIdentity(new string('a', 40), CurrentSchemaOwnedProjectionExporter.ProducerId,
            new string('b', 64), new string('c', 64));
        var input = new CurrentSchemaBootstrapInput(projection, producer, CurrentSchemaOwnedProjectionExporter.DescribeRequiredRecipes());
        var artifact = new CurrentSchemaOwnedTargetArtifact(CurrentSchemaOwnedTargetProjection.ArtifactSchemaVersion,
            input, CurrentSchemaOwnedTargetProjection.ComputeInputDigest(input), CurrentSchemaOwnedTargetProjection.Observe(input));
        byte[] original = JsonSerializer.SerializeToUtf8Bytes(artifact);
        Assert.Equal(artifact.Target, FsusBlog.Migration.OwnedCurrentSchemaTarget.ReadArtifact(original, producer).Target);
        string json = Encoding.UTF8.GetString(original);
        Assert.Throws<InvalidOperationException>(() => FsusBlog.Migration.OwnedCurrentSchemaTarget.ReadArtifact(
            Encoding.UTF8.GetBytes(json.Replace("{", "{\"SchemaVersion\":\"duplicate\",", StringComparison.Ordinal)), producer));
        Assert.Throws<JsonException>(() => FsusBlog.Migration.OwnedCurrentSchemaTarget.ReadArtifact(
            Encoding.UTF8.GetBytes("{\"UnknownApproval\":true," + json[1..]), producer));
        Assert.Throws<InvalidOperationException>(() => FsusBlog.Migration.OwnedCurrentSchemaTarget.ReadArtifact(
            JsonSerializer.SerializeToUtf8Bytes(artifact with { InputSha256 = new string('d', 64) }), producer));
        Assert.Throws<InvalidOperationException>(() => FsusBlog.Migration.OwnedCurrentSchemaTarget.ReadArtifact(
            original, producer with { SourceCommit = new string('e', 40) }));
        Assert.Throws<InvalidOperationException>(() => FsusBlog.Migration.OwnedCurrentSchemaTarget.ReadArtifact(
            JsonSerializer.SerializeToUtf8Bytes(artifact with { Input = input with { RequiredRecipes = [] } }), producer));
    }

    [Fact]
    public void CompletePhysicalProjection_RetainsEveryRecipeAndSeparateUnobservedEffects()
    {
        var inspector = new SchemaModelInspector();
        CurrentSchemaProjection entities = CurrentSchemaCanonicalAuthority.Generate(inspector.BuildCanonicalModel(inspector.GetManagedEntityTypes()));
        var input = new CurrentSchemaBootstrapInput(entities,
            new CurrentSchemaProducerIdentity(new string('a', 40), CurrentSchemaOwnedProjectionExporter.ProducerId,
                new string('b', 64), new string('c', 64)), CurrentSchemaOwnedProjectionExporter.DescribeRequiredRecipes());
        CurrentSchemaCompletePhysicalProjection complete = CurrentSchemaCanonicalAuthority.ProjectOwnedTarget(input, SchemaProviderKind.PostgreSql);
        Assert.Equal(entities.Schema.Tables.Count + input.RequiredRecipes.Count, complete.Tables.Tables.Count);
        Assert.Equal(CurrentSchemaOwnedTargetProjection.Observe(input), complete.Tables.Identity);
        Assert.NotEmpty(complete.SchemaEffects);
        Assert.NotEmpty(complete.BootstrapDataEffects);
        foreach (CurrentSchemaRequiredRecipeReference recipe in input.RequiredRecipes)
        {
            SchemaTableModel table = complete.Tables.Tables[recipe.TableName];
            foreach (SchemaColumnModel column in recipe.SemanticDescription!.Table.Columns.Values)
            {
                Assert.Equal(column.GenerationKind, table.Columns[column.Name].GenerationKind);
            }
            foreach (CurrentSchemaRecipeOperation operation in recipe.SemanticDescription.AdditionalOperations)
            {
                if (operation.Kind == CurrentSchemaRecipeOperationKind.CreateIndex)
                {
                    Assert.Equal(operation.Index, complete.Tables.Tables[operation.Table!].IndexDefinitions[operation.Name]);
                }
                else if (operation.Kind == CurrentSchemaRecipeOperationKind.AddColumnIfAbsent)
                {
                    Assert.Equal(operation.Column, complete.Tables.Tables[operation.Table!].Columns[operation.Name]);
                }
                else if (operation.Kind == CurrentSchemaRecipeOperationKind.AddConstraintIfAbsent)
                {
                    Assert.Equal(operation.Constraint, complete.Tables.Tables[operation.Table!].Constraints[operation.Name]);
                }
            }
        }
        Assert.Throws<InvalidOperationException>(() => CurrentSchemaCanonicalAuthority.ProjectOwnedTarget(input, SchemaProviderKind.MySql));
        Assert.Throws<InvalidOperationException>(() => CurrentSchemaCanonicalAuthority.ProjectOwnedTarget(input, SchemaProviderKind.Sqlite));
    }

    [Fact]
    public void RequiredRecipeReferences_UseEveryOriginalCurrentOwnerWithoutCopyingSql()
    {
        IReadOnlyList<CurrentSchemaRequiredRecipeReference> references = CurrentSchemaOwnedProjectionExporter.DescribeRequiredRecipes();
        Assert.Equal(CurrentSchemaRuntimeRollupTables.Tables.Count, references.Count);
        for (int index = 0; index < references.Count; index++)
        {
            CurrentSchemaRuntimeRollupTable recipe = CurrentSchemaRuntimeRollupTables.Tables[index];
            CurrentSchemaRequiredRecipeReference reference = references[index];
            string expected = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new
            {
                recipe.TableName,
                recipe.CreateSql,
                recipe.AdditionalSql
            })))).ToLowerInvariant();
            Assert.Equal(recipe.TableName, reference.TableName);
            Assert.Equal(SchemaProviderKind.PostgreSql, reference.Provider);
            Assert.Equal(expected, reference.RecipeDigest);
            Assert.NotNull(reference.SemanticDescription);
            Assert.Equal(recipe.TableName, reference.SemanticDescription.Table.Name);
            Assert.NotEmpty(reference.SemanticDescription.Table.Columns);
            Assert.Equal(recipe.AdditionalSql?.Count ?? 0, reference.SemanticDescription.AdditionalOperations.Count);
        }
    }

    [Theory]
    [InlineData("DROP TABLE probe;")]
    [InlineData("CREATE TRIGGER guard AFTER UPDATE ON probe FOR EACH ROW EXECUTE FUNCTION guard();")]
    [InlineData("ALTER TABLE probe DROP COLUMN id;")]
    public void RecipeExtraction_UnknownEffectsRefuseWholeExport(string additional)
    {
        var recipe = new CurrentSchemaRuntimeRollupTable("probe", "CREATE TABLE IF NOT EXISTS probe (id integer PRIMARY KEY);", [additional]);
        Assert.Throws<InvalidOperationException>(() => CurrentSchemaRecipeFactExtractor.Extract(recipe));
    }

    [Fact]
    public void RecipeExtraction_PreservesNestedDefaultsDeferredConstraintsAndLiteralContents()
    {
        var recipe = new CurrentSchemaRuntimeRollupTable("probe", """
            CREATE TABLE IF NOT EXISTS probe (
                id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                label varchar(64) NOT NULL DEFAULT 'a  b',
                count integer NOT NULL DEFAULT GREATEST(1, LEAST(1000, 8)),
                CONSTRAINT uq_probe_label UNIQUE (label) DEFERRABLE INITIALLY DEFERRED,
                CONSTRAINT ck_probe_count CHECK (count BETWEEN 1 AND 1000)
            );
            """);
        CurrentSchemaRecipeFacts facts = CurrentSchemaRecipeFactExtractor.Extract(recipe);
        Assert.Equal("'a  b'", facts.Table.Columns["label"].DefaultValue);
        Assert.Equal("GREATEST(1, LEAST(1000, 8))", facts.Table.Columns["count"].DefaultValue);
        Assert.Equal("identity-by-default", facts.Table.Columns["id"].GenerationKind);
        Assert.True(facts.Table.Constraints["uq_probe_label"].IsInitiallyDeferred);
        Assert.Equal("count BETWEEN 1 AND 1000", facts.Table.Constraints["ck_probe_count"].Expression);
        Assert.Throws<InvalidOperationException>(() => CurrentSchemaRecipeFactExtractor.Extract(recipe with { TableName = "different" }));
    }

    [Fact]
    public void CompleteOwnedTargetArtifact_RoundTripsEveryOriginalRecipeAndDetectsFactDrift()
    {
        var inspector = new SchemaModelInspector();
        CurrentSchemaProjection projection = CurrentSchemaCanonicalAuthority.Generate(inspector.BuildCanonicalModel(inspector.GetManagedEntityTypes()));
        var owner = new CurrentSchemaProducerIdentity(new string('a', 40), CurrentSchemaOwnedProjectionExporter.ProducerId,
            new string('b', 64), new string('c', 64));
        var input = new CurrentSchemaBootstrapInput(projection, owner, CurrentSchemaOwnedProjectionExporter.DescribeRequiredRecipes());
        var artifact = new CurrentSchemaOwnedTargetArtifact(CurrentSchemaOwnedTargetProjection.ArtifactSchemaVersion,
            input, CurrentSchemaOwnedTargetProjection.ComputeInputDigest(input), CurrentSchemaOwnedTargetProjection.Observe(input));
        string json = JsonSerializer.Serialize(artifact);
        CurrentSchemaOwnedTargetArtifact restored = JsonSerializer.Deserialize<CurrentSchemaOwnedTargetArtifact>(json)!;
        Assert.Equal(artifact.InputSha256, CurrentSchemaOwnedTargetProjection.ComputeInputDigest(restored.Input));
        Assert.Equal(artifact.Target, CurrentSchemaOwnedTargetProjection.Observe(restored.Input));
        Assert.Equal(CurrentSchemaRuntimeRollupTables.Tables.Count, restored.Input.RequiredRecipes.Count);
        Assert.Equal(input.RequiredRecipes.Sum(static recipe => recipe.SemanticDescription!.AdditionalOperations.Count),
            restored.Input.RequiredRecipes.Sum(static recipe => recipe.SemanticDescription!.AdditionalOperations.Count));
        SchemaTableModel table = restored.Input.RequiredRecipes[0].SemanticDescription!.Table;
        string column = table.Columns.Keys.First();
        table.Columns[column] = table.Columns[column] with { IsNullable = !table.Columns[column].IsNullable };
        Assert.NotEqual(artifact.InputSha256, CurrentSchemaOwnedTargetProjection.ComputeInputDigest(restored.Input));
        Assert.NotEqual(artifact.Target.ContentDigest, CurrentSchemaOwnedTargetProjection.Observe(restored.Input).ContentDigest);
    }
}
