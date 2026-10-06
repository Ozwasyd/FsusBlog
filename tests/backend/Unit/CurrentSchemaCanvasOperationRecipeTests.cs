using System.Text.RegularExpressions;

using FsusBlog.Contracts.Schema;
using FsusBlog.Migration;
using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Infrastructure.SchemaMigration;

namespace FsusBlog.Server.Tests;

public sealed class CurrentSchemaCanvasOperationRecipeTests
{
    [Fact]
    public void OriginalOperationAndLinkSqlHaveCompleteRequiredRecipeClosure()
    {
        ISchemaMigrationDescriptor[] originals =
        [
            AuthoringCanvasOperationJournalMigrationDefinitions.BuildMigration(),
            ArticleCanvasLinkMigrationDefinitions.BuildMigration()
        ];
        foreach (ISchemaMigrationDescriptor original in originals)
        {
            string sql = Assert.IsType<RawSqlStep>(Assert.Single(original.Steps)).Sql;
            MatchCollection statements = Regex.Matches(sql, @"CREATE (?:UNIQUE )?(?:TABLE|INDEX).*?;", RegexOptions.Singleline);
            var recipes = new List<CurrentSchemaRuntimeRollupTable>();
            var expectedIndexes = new List<string>();
            foreach (Match statement in statements)
            {
                Match table = Regex.Match(statement.Value, @"\ACREATE TABLE IF NOT EXISTS ([a-z_]+)");
                if (table.Success)
                {
                    CurrentSchemaRuntimeRollupTable recipe = Assert.Single(CurrentSchemaRuntimeRollupTables.Tables,
                        value => value.TableName == table.Groups[1].Value);
                    Assert.Equal(statement.Value, recipe.CreateSql);
                    CurrentSchemaRecipeFacts facts = CurrentSchemaRecipeFactExtractor.Extract(recipe);
                    Assert.Equal(recipe.TableName, facts.Table.Name);
                    Assert.NotEmpty(facts.Table.Constraints);
                    recipes.Add(recipe);
                }
                else
                {
                    expectedIndexes.Add(statement.Value);
                }
            }
            Assert.Equal(original == originals[0] ? 6 : 2, recipes.Count);
            Assert.Equal(expectedIndexes.Order(StringComparer.Ordinal),
                recipes.SelectMany(recipe => recipe.AdditionalSql ?? []).Order(StringComparer.Ordinal));
        }
    }

    [Fact]
    public void OriginalCanvasArraysRemainTypedThroughWholeTargetAndBootstrap()
    {
        // Pure compiled-source control: fixture producer metadata and an input
        // digest provide no native execution, retained artifact or issuer authority.
        var inspector = new SchemaModelInspector();
        CurrentSchemaProjection entity = CurrentSchemaCanonicalAuthority.Generate(
            inspector.BuildCanonicalModel(inspector.GetManagedEntityTypes()));
        IReadOnlyList<CurrentSchemaRequiredRecipeReference> recipes = CurrentSchemaOwnedProjectionExporter.DescribeRequiredRecipes();
        var owner = new CurrentSchemaProducerIdentity(new string('a', 40), CurrentSchemaOwnedProjectionExporter.ProducerId,
            new string('b', 64), new string('c', 64));
        var input = new CurrentSchemaBootstrapInput(entity, owner, recipes);
        CurrentSchemaCompletePhysicalProjection target = CurrentSchemaCanonicalAuthority.ProjectOwnedTarget(input, SchemaProviderKind.PostgreSql);
        CompiledCurrentSchemaBootstrap compiled = CurrentSchemaBootstrapCompiler.Compile(input, owner,
            SchemaProviderKind.PostgreSql, CurrentSchemaBootstrapCompiler.OwnedInputDigest(input));
        Assert.Equal(target.Tables.Identity, compiled.Target);
        SchemaColumnModel[] arrays = recipes.Where(recipe => recipe.TableName.StartsWith("authoring_canvas_operation_", StringComparison.Ordinal)
                || recipe.TableName == "article_canvas_link_history")
            .SelectMany(recipe => recipe.SemanticDescription!.Table.Columns.Values)
            .Where(column => column.DataType.EndsWith("-array", StringComparison.Ordinal)).ToArray();
        Assert.Equal(13, arrays.Length);
        Assert.Equal(2, arrays.Count(column => column.DataType == "int16-array"));
        Assert.Equal(10, arrays.Count(column => column.DataType == "uuid-array"));
        Assert.Equal(1, arrays.Count(column => column.DataType == "string-array"));
        Assert.Equal("text[]", target.Tables.Tables["authoring_canvas_operation_receipt"].Columns["reasons"].PhysicalType);
        Assert.Equal("default", target.Tables.Tables["authoring_canvas_operation_receipt"].Columns["reasons"].Collation);
        Assert.All(arrays, column =>
        {
            Assert.Null(column.Conversion);
            Assert.Contains(compiled.Commands, command => command.Sql.Contains('"' + column.Name + '"' + " " + column.PhysicalType, StringComparison.Ordinal));
        });
        Assert.All(target.Tables.Tables.Values.SelectMany(table => table.Columns.Values)
            .Where(column => column.DataType.EndsWith("-array", StringComparison.Ordinal)),
            column => Assert.Equal("none", column.Conversion));
    }

    [Theory]
    [InlineData("int2[]")]
    [InlineData("integer[]")]
    [InlineData("uuid[][]")]
    [InlineData("smallint[1]")]
    [InlineData("varchar(32)[]")]
    [InlineData("public.uuid[]")]
    public void RecipeExtractionRejectsUnknownArrayElementsAliasesAndDimensions(string type)
    {
        var recipe = new CurrentSchemaRuntimeRollupTable("array_probe",
            $"CREATE TABLE IF NOT EXISTS array_probe (id uuid PRIMARY KEY, values {type} NOT NULL);");
        Assert.Throws<InvalidOperationException>(() => CurrentSchemaRecipeFactExtractor.Extract(recipe));
    }
}
