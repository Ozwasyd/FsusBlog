using System.Data;

using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Tests.TestInfrastructure;

using SqlSugar;

namespace FsusBlog.Server.Tests;

public sealed class ArticleMutationIdempotencyMigrationTests
{
    private const string MigrationId = "20260720-post-article-mutation-idempotency";

    [Fact]
    public void Descriptor_IsAdditiveTransactionalExpand()
    {
        ISchemaMigrationDescriptor descriptor = Assert.Single(
            new SchemaMigrationRegistry().GetDescriptors(),
            static migration => migration.MigrationId == MigrationId);
        OnlineSchemaMigrationMetadata metadata = new OnlineSchemaMigrationCatalog().GetMetadata()[MigrationId];
        string fingerprint = string.Join('\n', descriptor.Steps.Select(static step => step.Fingerprint));

        Assert.Equal(SchemaMigrationPhase.PostCodeFirst, descriptor.Phase);
        Assert.True(descriptor.Transactional);
        Assert.Contains("article_mutation_command", fingerprint, StringComparison.Ordinal);
        Assert.Contains("ux_article_mutation_command_identity", fingerprint, StringComparison.Ordinal);
        Assert.Equal(OnlineSchemaMigrationPhase.Expand, metadata.Phase);
        Assert.Equal(OnlineSchemaMigrationRollbackMode.CompatibleCode, metadata.RollbackMode);
        Assert.False(metadata.Destructive);
        Assert.False(metadata.RequiresExclusiveMode);
    }
}

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class ArticleMutationIdempotencyMigrationDatabaseTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task PostCodeFirstMigration_CreatesScopedUniqueIdentityAndIsIdempotent()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        await db.Ado.ExecuteCommandAsync("""
            CREATE TABLE admin_principal (id bigint PRIMARY KEY);
            CREATE TABLE article (id integer PRIMARY KEY);
            """);
        ISchemaMigrationDescriptor descriptor = Assert.Single(
            new SchemaMigrationRegistry().GetDescriptors(),
            static migration => migration.MigrationId == "20260720-post-article-mutation-idempotency");

        await ApplyAsync(db, descriptor);
        await ApplyAsync(db, descriptor);

        DataTable columns = await db.Ado.GetDataTableAsync("""
            SELECT column_name, is_nullable
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'article_mutation_command';
            """);
        Assert.Contains(columns.Rows.Cast<DataRow>(), static row =>
            string.Equals(Convert.ToString(row["column_name"]), "client_mutation_id", StringComparison.Ordinal)
            && string.Equals(Convert.ToString(row["is_nullable"]), "NO", StringComparison.Ordinal));
        Assert.Equal(1, await db.Ado.GetIntAsync("""
            SELECT COUNT(1)
            FROM pg_indexes
            WHERE schemaname = 'public'
              AND tablename = 'article_mutation_command'
              AND indexname = 'ux_article_mutation_command_identity';
            """));
    }

    private static async Task ApplyAsync(ISqlSugarClient db, ISchemaMigrationDescriptor descriptor)
    {
        foreach (SchemaMigrationStep step in descriptor.Steps)
        {
            await step.ExecuteAsync(db, CancellationToken.None);
        }
    }
}
