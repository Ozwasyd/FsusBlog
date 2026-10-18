using FsusBlog.Server.Infrastructure.SchemaMigration;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class SourceReceiptSchemaCoveragePostgresTests(PostgresSchemaMigrationFixture fixture)
{
    [Theory]
    [InlineData("taxonomy_mutation_receipt")]
    [InlineData("user_locale_mutation_receipt")]
    public async Task ActualReceiptTableAndGuardMustBeRepresentedByTheOriginalCurrentSchemaOwner(string table)
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(User), typeof(UserLocalePreference), typeof(Category), typeof(Tag));
        Assert.Equal(table, await db.Ado.GetStringAsync("SELECT to_regclass(@Table)::text;", new SugarParameter("@Table", table)));
        Assert.True(await db.Ado.GetIntAsync("""
            SELECT count(*) FROM pg_trigger
            WHERE tgrelid = to_regclass(@Table) AND NOT tgisinternal;
            """, new SugarParameter("@Table", table)) > 0);
        Assert.Contains(CurrentSchemaOwnedProjectionExporter.DescribeRequiredRecipes(), recipe => recipe.TableName == table);
    }
}
