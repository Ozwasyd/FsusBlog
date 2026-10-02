using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Contracts.Schema;
using FsusBlog.Server.Infrastructure.SchemaMigration;

namespace FsusBlog.Server.Tests;

public sealed class CurrentSchemaOwnedProjectionExporterTests
{
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
            Assert.Null(reference.SemanticDescription);
        }
    }
}
