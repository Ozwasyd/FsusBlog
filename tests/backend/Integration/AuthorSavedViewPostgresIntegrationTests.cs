using FsusBlog.Migration;
using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Tests.TestInfrastructure;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class AuthorSavedViewPostgresIntegrationTests(
    PostgresSchemaMigrationFixture fixture)
{
    private static readonly AuthorSavedViewOwner s_singleOwner = new(1, "saved-view-single");

    [Fact]
    public async Task ProductionProvider_UsesTaxonomyAndFailsClosedForUnavailableUpstreams()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        PostgresSqlSugarTestClient.InitTables(db, typeof(Category), typeof(Tag));
        int categoryId = await db.Insertable(new Category { Name = "Saved view category" })
            .ExecuteReturnIdentityAsync();
        int tagId = await db.Insertable(new Tag { Name = "Saved view tag" })
            .ExecuteReturnIdentityAsync();
        var catalog = new AuthorSavedViewDependencyCatalog(
            [new PostgresAuthorSavedViewDependencyProvider(db)]);

        AuthorSavedViewDependencyResolution lifecycle = await catalog.ResolveConditionAsync(
            s_singleOwner,
            new(
                new(AuthorSavedViewFieldKind.LifecycleStatus, AuthorSavedViewContract.LifecycleStatusField),
                "identity.equals",
                ["DRAFT"]));
        AuthorSavedViewDependencyResolution category = await catalog.ResolveConditionAsync(
            s_singleOwner,
            new(
                new(AuthorSavedViewFieldKind.Category, $"category:{categoryId}"),
                "identity.equals",
                [$"category:{categoryId}"]));
        AuthorSavedViewDependencyResolution tag = await catalog.ResolveConditionAsync(
            s_singleOwner,
            new(
                new(AuthorSavedViewFieldKind.Tag, $"tag:{tagId}"),
                "identity.any-of",
                [$"tag:{tagId}", "tag:2147483647"]));

        Assert.Equal(AuthorSavedViewDependencyStatus.Current, lifecycle.Status);
        Assert.Equal(["draft"], lifecycle.CanonicalValues);
        Assert.Equal(AuthorSavedViewDependencyStatus.Current, category.Status);
        Assert.Equal(AuthorSavedViewDependencyStatus.Deleted, tag.Status);

        AuthorSavedViewDependencyResolution fullText = await catalog.ResolveConditionAsync(
            s_singleOwner,
            new(
                new(AuthorSavedViewFieldKind.FullText, AuthorSavedViewContract.AuthorSearchField),
                "author-search.match",
                ["query-ref:local-simulation"]));
        AuthorSavedViewDependencyResolution property = await catalog.ResolveConditionAsync(
            s_singleOwner,
            new(
                new(AuthorSavedViewFieldKind.Property, "property:local-simulation"),
                "value.is-present",
                []));
        AuthorSavedViewDependencyResolution relation = await catalog.ResolveConditionAsync(
            s_singleOwner,
            new(
                new(AuthorSavedViewFieldKind.RelationState, "relation:local-simulation"),
                "identity.equals",
                ["relation:local-simulation"]));
        AuthorSavedViewDependencyResolution contentCheck = await catalog.ResolveConditionAsync(
            s_singleOwner,
            new(
                new(AuthorSavedViewFieldKind.ContentCheckState, "content-check:local-simulation"),
                "identity.equals",
                ["content-check:local-simulation"]));

        Assert.Equal(AuthorSavedViewDependencyStatus.MigrationRequired, fullText.Status);
        Assert.Equal(AuthorSavedViewDependencyStatus.Unknown, property.Status);
        Assert.Equal(AuthorSavedViewDependencyStatus.Unknown, relation.Status);
        Assert.Equal(AuthorSavedViewDependencyStatus.Unknown, contentCheck.Status);
    }

    private async Task<SqlSugarClient> CreateDatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        await db.Ado.ExecuteCommandAsync(
            """
            CREATE TABLE admin_principal(id bigint PRIMARY KEY);
            INSERT INTO admin_principal(id) VALUES (1), (2);
            """);
        await ApplyMigrationAsync(db, AuthorSavedViewMigrationDefinitions.BuildMigration());
        return db;
    }

    private static async Task ApplyMigrationAsync(
        SqlSugarClient db,
        ISchemaMigrationDescriptor migration)
    {
        foreach (SchemaMigrationStep step in migration.Steps)
        {
            await step.ExecuteAsync(db, CancellationToken.None);
        }
    }
}
