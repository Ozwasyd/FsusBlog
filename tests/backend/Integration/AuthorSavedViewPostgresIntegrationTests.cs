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
    private static readonly AuthorSavedViewOwner s_scaleOwner = new(2, "saved-view-scale");

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

    [Fact]
    public async Task Persistence_PagesOneThousandAndBulkMovesWithOneAuditInsert()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        var persistence = new PostgresAuthorSavedViewPersistence(db);
        var store = new AuthorSavedViewStore(
            persistence,
            new AuthorSavedViewQueryValidator(new AuthorSavedViewDependencyCatalog([])),
            TimeProvider.System);

        Assert.Empty((await store.ListAsync(s_singleOwner, null, 100)).Items);
        AuthorSavedViewWriteReceipt created = await store.CreateAsync(new(
            Guid.Parse("10000000-0000-0000-0000-000000000001"),
            s_singleOwner,
            0,
            Guid.CreateVersion7(),
            "Single saved view",
            LifecycleQuery()));
        Assert.Single((await store.ListAsync(s_singleOwner, null, 100)).Items);
        Assert.Equal(created.ViewId, (await store.GetAsync(s_singleOwner, created.ViewId))!.Id);

        await SeedScaleOwnerAsync(db);
        Guid movedId = ScaleViewId(1_000);
        Guid firstId = ScaleViewId(1);
        Guid requestId = Guid.CreateVersion7();
        AuthorSavedViewWriteReceipt moved = await store.MovePinnedAsync(new(
            s_scaleOwner,
            7,
            requestId,
            [movedId],
            firstId,
            new Dictionary<Guid, long> { [movedId] = 1 }));

        Assert.Equal(1_000, moved.ChangeCount);
        Assert.Equal(movedId, (await store.ListAsync(s_scaleOwner, null, 1)).Items.Single().Id);
        int count = 0;
        AuthorSavedViewPageCursor? cursor = null;
        do
        {
            AuthorSavedViewPage page = await store.ListAsync(s_scaleOwner, cursor, 100);
            count += page.Items.Count;
            cursor = page.NextCursor;
        }
        while (cursor is not null);
        Assert.Equal(1_000, count);
        Assert.Equal(
            1_000,
            await db.Ado.GetIntAsync(
                "SELECT COUNT(*) FROM author_saved_view_receipt_change WHERE receipt_id = @ReceiptId;",
                new SugarParameter("@ReceiptId", moved.ReceiptId)));

        AuthorSavedViewWriteReceipt replay = await store.MovePinnedAsync(new(
            s_scaleOwner,
            7,
            requestId,
            [movedId],
            firstId,
            new Dictionary<Guid, long> { [movedId] = 1 }));
        Assert.True(replay.IdempotentReplay);
        Assert.Equal(moved.ReceiptId, replay.ReceiptId);
        Assert.Equal(1, await db.Ado.GetIntAsync(
            "SELECT COUNT(*) FROM author_saved_view_receipt WHERE owner_admin_principal_id = 2;"));
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

    private static async Task SeedScaleOwnerAsync(SqlSugarClient db)
    {
        string emptyCommandDigest = AuthorSavedViewStorageContract.ComputeCommandDigest();
        string collectionDigest = AuthorSavedViewStorageContract.ComputeCollectionDigest(
            s_scaleOwner,
            7,
            null,
            AuthorSavedViewStorageContract.MaxViewsPerOwner,
            emptyCommandDigest);
        await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO author_saved_view_collection(
                owner_admin_principal_id, site_scope, revision, default_view_id,
                active_view_count, last_command_digest, content_digest)
            VALUES (2, @SiteScope, 7, NULL, 1000, @CommandDigest, @CollectionDigest);

            INSERT INTO author_saved_view(
                id, owner_admin_principal_id, site_scope, schema_version, revision, name, name_key,
                query_digest, dependency_digest, sort_field_kind, sort_field_identity,
                sort_direction, sort_null_placement, sort_collation, sort_timezone_id,
                stable_tie_breaker, page_size, pinned, order_key, lifecycle_state,
                created_at_utc, updated_at_utc, content_digest)
            SELECT
                ('00000000-0000-0000-0000-' || lpad(sequence::text, 12, '0'))::uuid,
                2,
                @SiteScope,
                1,
                1,
                'view-' || lpad(sequence::text, 4, '0'),
                'VIEW-' || lpad(sequence::text, 4, '0'),
                repeat('a', 64),
                repeat('b', 64),
                0,
                'article.lifecycle.status',
                0,
                1,
                'ordinal',
                NULL,
                'article.id',
                25,
                TRUE,
                sequence,
                0,
                TIMESTAMP '1970-01-01 00:00:00',
                TIMESTAMP '1970-01-01 00:00:00',
                repeat('c', 64)
            FROM generate_series(1, 1000) AS sequence;
            """,
            new SugarParameter("@SiteScope", s_scaleOwner.SiteScope),
            new SugarParameter("@CommandDigest", emptyCommandDigest),
            new SugarParameter("@CollectionDigest", collectionDigest));
    }

    private static Guid ScaleViewId(int index)
        => Guid.Parse($"00000000-0000-0000-0000-{index:D12}");

    private static AuthorSavedViewQuery LifecycleQuery()
        => new(
            AuthorSavedViewContract.SchemaVersion,
            [
                new(
                    new(AuthorSavedViewFieldKind.LifecycleStatus,
                        AuthorSavedViewContract.LifecycleStatusField),
                    "identity.equals",
                    ["published"])
            ],
            new(
                new(AuthorSavedViewFieldKind.LifecycleStatus,
                    AuthorSavedViewContract.LifecycleStatusField),
                AuthorSavedViewSortDirection.Ascending,
                AuthorSavedViewNullPlacement.Last,
                "ordinal"),
            [new(AuthorSavedViewFieldKind.LifecycleStatus, AuthorSavedViewContract.LifecycleStatusField)],
            25);
}
