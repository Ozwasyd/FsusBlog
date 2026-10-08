using System.Collections.Concurrent;

using FsusBlog.Migration;
using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Tests.TestInfrastructure;

using Npgsql;

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

    [Theory]
    [InlineData(2L, "collision-primary")]
    [InlineData(1L, "collision-other-site")]
    public async Task Persistence_RejectsConcurrentViewIdentityFromAnotherOwnerScope(
        long otherPrincipalId,
        string otherSiteScope)
    {
        using SqlSugarClient observer = await CreateDatabaseAsync();
        string connectionString = observer.CurrentConnectionConfig.ConnectionString;
        string winnerApplication = $"saved-view-winner-{Guid.NewGuid():N}";
        string loserApplication = $"saved-view-loser-{Guid.NewGuid():N}";
        using SqlSugarClient winnerDb = PostgresSqlSugarTestClient.Create(
            WithApplicationName(connectionString, winnerApplication));
        using SqlSugarClient loserDb = PostgresSqlSugarTestClient.Create(
            WithApplicationName(connectionString, loserApplication));
        Assert.Equal("read committed", await winnerDb.Ado.GetStringAsync("SHOW transaction_isolation;"));
        Assert.Equal("read committed", await loserDb.Ado.GetStringAsync("SHOW transaction_isolation;"));
        var winnerOwner = new AuthorSavedViewOwner(1, "collision-primary");
        var loserOwner = new AuthorSavedViewOwner(otherPrincipalId, otherSiteScope);
        Guid viewId = Guid.CreateVersion7();
        AuthorSavedViewQuery winnerQuery = LifecycleQuery();
        AuthorSavedViewQuery loserQuery = winnerQuery with
        {
            PageSize = 50,
            Conditions =
            [
                new(new(AuthorSavedViewFieldKind.LifecycleStatus, AuthorSavedViewContract.LifecycleStatusField),
                    "identity.equals", ["draft"])
            ]
        };
        var validator = new AuthorSavedViewQueryValidator(new AuthorSavedViewDependencyCatalog([]));
        AuthorSavedViewQueryValidationResult expected = await validator.ValidateAsync(winnerOwner, winnerQuery);
        Assert.True(expected.IsValid);
        var winnerStore = new AuthorSavedViewStore(new PostgresAuthorSavedViewPersistence(winnerDb),
            validator, TimeProvider.System);
        var loserStore = new AuthorSavedViewStore(new PostgresAuthorSavedViewPersistence(loserDb),
            validator, TimeProvider.System);
        var headerWritten = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var releaseWinner = new ManualResetEventSlim();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        var loserStatements = new ConcurrentQueue<string>();
        winnerDb.Aop.OnLogExecuting = (sql, _) =>
        {
            if (sql.Contains("INSERT INTO author_saved_view_condition(", StringComparison.Ordinal))
            {
                // The real header INSERT has returned inside the still-open
                // transaction; pause before its first AST child write.
                headerWritten.TrySetResult();
                releaseWinner.Wait(deadline.Token);
            }
        };
        loserDb.Aop.OnLogExecuting = (sql, _) => loserStatements.Enqueue(sql);
        Task<AuthorSavedViewWriteReceipt> winner = Task.Run(() => winnerStore.CreateAsync(new(
            viewId, winnerOwner, 0, Guid.CreateVersion7(), "Winner private view", winnerQuery), deadline.Token));
        Task<AuthorSavedViewWriteReceipt>? loser = null;
        try
        {
            await headerWritten.Task.WaitAsync(deadline.Token);
            Assert.Equal(0, await observer.Ado.GetIntAsync(
                "SELECT COUNT(*) FROM author_saved_view WHERE id = @ViewId;",
                new SugarParameter("@ViewId", viewId)));
            loser = loserStore.CreateAsync(new(
                viewId, loserOwner, 0, Guid.CreateVersion7(), "Loser private view", loserQuery), deadline.Token);
            await WaitForHeaderCollisionAsync(observer, winnerApplication, loserApplication, loser, deadline.Token);
            Assert.False(winner.IsCompleted);
            Assert.False(loser.IsCompleted);
            Assert.Contains(loserStatements, static sql =>
                sql.Contains("SELECT COUNT(1)", StringComparison.Ordinal)
                && sql.Contains("owner_admin_principal_id <>", StringComparison.Ordinal));

            releaseWinner.Set();
            AuthorSavedViewWriteReceipt created = await winner.WaitAsync(deadline.Token);
            await Assert.ThrowsAsync<AuthorSavedViewAccessDeniedException>(() => loser.WaitAsync(deadline.Token));
            Assert.DoesNotContain(loserStatements, static sql =>
                sql.Contains("DELETE FROM author_saved_view_condition", StringComparison.Ordinal)
                || sql.Contains("DELETE FROM author_saved_view_projection", StringComparison.Ordinal)
                || sql.Contains("INSERT INTO author_saved_view_condition(", StringComparison.Ordinal)
                || sql.Contains("INSERT INTO author_saved_view_projection(", StringComparison.Ordinal));

            AuthorSavedView stored = Assert.IsType<AuthorSavedView>(await winnerStore.GetAsync(winnerOwner, viewId));
            Assert.Equal(winnerOwner, stored.Owner);
            Assert.Equal("Winner private view", stored.Name);
            Assert.Equal(1, stored.Revision);
            Assert.Equal(AuthorSavedViewContract.SchemaVersion, stored.SchemaVersion);
            Assert.False(stored.Pinned);
            Assert.Equal(0, stored.OrderKey);
            Assert.Equal(AuthorSavedViewLifecycleState.Active, stored.LifecycleState);
            Assert.Equal(expected.QueryDigest, stored.QueryDigest);
            Assert.Equal(expected.DependencyDigest, stored.DependencyDigest);
            Assert.Equal(expected.QueryDigest, AuthorSavedViewContract.ComputeQueryDigest(stored.Query));
            Assert.Equal(expected.Query.SchemaVersion, stored.Query.SchemaVersion);
            Assert.Equal(expected.Query.Sort, stored.Query.Sort);
            Assert.Equal(expected.Query.PageSize, stored.Query.PageSize);
            Assert.Equal(expected.Query.Sort.StableTieBreaker, stored.Query.Sort.StableTieBreaker);
            Assert.Equal(expected.Query.Projection.ToArray(), stored.Query.Projection.ToArray());
            Assert.Equal(expected.Query.Conditions.Count, stored.Query.Conditions.Count);
            foreach ((AuthorSavedViewCondition before, AuthorSavedViewCondition after)
                in expected.Query.Conditions.Zip(stored.Query.Conditions))
            {
                Assert.Equal(before.Field, after.Field);
                Assert.Equal(before.OperatorId, after.OperatorId);
                Assert.Equal(before.TimeZoneId, after.TimeZoneId);
                Assert.Equal(before.Values.ToArray(), after.Values.ToArray());
            }
            Assert.Equal(AuthorSavedViewStorageContract.ComputeViewDigest(
                winnerOwner, viewId, 1, stored.Name, expected.QueryDigest, expected.DependencyDigest,
                false, 0, AuthorSavedViewLifecycleState.Active), stored.ContentDigest);
            Assert.Equal(created.QueryDigest, stored.QueryDigest);
            AuthorSavedViewVerificationResult verification = await winnerStore.VerifyAsync(winnerOwner);
            Assert.True(verification.Valid, string.Join(", ", verification.Reasons));
            Assert.Null(await loserStore.GetAsync(loserOwner, viewId));
            Assert.Empty((await loserStore.ListAsync(loserOwner, null, 100)).Items);
            foreach (string table in new[]
            {
                "author_saved_view_collection", "author_saved_view_receipt", "author_saved_view_idempotency"
            })
            {
                Assert.Equal(0, await observer.Ado.GetIntAsync(
                    $"SELECT COUNT(*) FROM {table} WHERE owner_admin_principal_id = @Owner AND site_scope = @Site;",
                    new SugarParameter("@Owner", loserOwner.AdminPrincipalId),
                    new SugarParameter("@Site", loserOwner.SiteScope)));
            }
            Assert.Equal(1, await observer.Ado.GetIntAsync("SELECT COUNT(*) FROM author_saved_view_receipt_change;"));
        }
        finally
        {
            releaseWinner.Set();
            try
            {
                deadline.Cancel();
            }
            finally
            {
                // Cancellation cannot interrupt every SQL command. Both tasks
                // must actually finish before their clients and gate are disposed.
                try
                {
                    await ObserveCollisionOperationAsync(winner);
                }
                finally
                {
                    try
                    {
                        if (loser is not null)
                        {
                            await ObserveCollisionOperationAsync(loser);
                        }
                    }
                    finally
                    {
                        winnerDb.Aop.OnLogExecuting = null;
                        loserDb.Aop.OnLogExecuting = null;
                    }
                }
            }
        }
    }

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

    [Fact]
    public async Task Persistence_RoundTripsSubMicrosecondClockWithoutReceiptDigestDrift()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        var persistence = new PostgresAuthorSavedViewPersistence(db);
        DateTime now = new(638962848000000007, DateTimeKind.Utc);
        DateTime expected = new(now.Ticks - now.Ticks % TimeSpan.TicksPerMicrosecond, DateTimeKind.Utc);
        var store = new AuthorSavedViewStore(persistence,
            new AuthorSavedViewQueryValidator(new AuthorSavedViewDependencyCatalog([])),
            new FixedUtcTimeProvider(now));
        var command = new CreateAuthorSavedViewCommand(Guid.CreateVersion7(), s_singleOwner,
            0, Guid.CreateVersion7(), "Timestamp round trip", LifecycleQuery());

        AuthorSavedViewWriteReceipt created = await store.CreateAsync(command);
        AuthorSavedViewVerificationHistory history = await persistence.ReadVerificationHistoryAsync(s_singleOwner);
        AuthorSavedViewWriteReceipt persisted = Assert.Single(history.Receipts);
        AuthorSavedViewVerificationResult verification = await store.VerifyAsync(s_singleOwner);
        Assert.True(verification.Valid,
            $"{string.Join(", ", verification.Reasons)}; createdTicks={created.OccurredAtUtc.Ticks}; "
            + $"persistedTicks={persisted.OccurredAtUtc.Ticks}; "
            + $"storedDigest={persisted.ContentDigest}; computedDigest={AuthorSavedViewStorageContract.ComputeReceiptDigest(persisted)}");
        Assert.Equal(expected, created.OccurredAtUtc);
        Assert.Equal(created.OccurredAtUtc, persisted.OccurredAtUtc);
        Assert.Equal(created.ContentDigest, persisted.ContentDigest);
        Assert.Equal(persisted.ContentDigest, AuthorSavedViewStorageContract.ComputeReceiptDigest(persisted));
        AuthorSavedView stored = Assert.IsType<AuthorSavedView>(await store.GetAsync(s_singleOwner, command.ViewId));
        Assert.Equal(expected, stored.CreatedAtUtc);
        Assert.Equal(expected, stored.UpdatedAtUtc);
        AuthorSavedViewWriteReceipt replay = await store.CreateAsync(command);
        Assert.True(replay.IdempotentReplay);
        Assert.Equal(created.ReceiptId, replay.ReceiptId);
        Assert.Equal(created.ContentDigest, replay.ContentDigest);
        Assert.True((await store.VerifyAsync(s_singleOwner)).Valid);
    }

    private sealed class FixedUtcTimeProvider(DateTime now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => new(now);
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

    private static string WithApplicationName(string connectionString, string applicationName)
        => new NpgsqlConnectionStringBuilder(connectionString)
        {
            ApplicationName = applicationName
        }.ConnectionString;

    private static async Task WaitForHeaderCollisionAsync(
        SqlSugarClient observer,
        string winnerApplication,
        string loserApplication,
        Task loser,
        CancellationToken cancellationToken)
    {
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Assert.False(loser.IsCompleted, "The competing write must reach the uncommitted header, not a preflight rejection.");
            int blocked = await observer.Ado.GetIntAsync(
                """
                SELECT COUNT(*)
                FROM pg_stat_activity AS losing
                JOIN pg_stat_activity AS winning ON winning.datname = losing.datname
                WHERE losing.datname = current_database()
                  AND losing.application_name = @Loser
                  AND winning.application_name = @Winner
                  AND losing.wait_event_type = 'Lock'
                  AND winning.pid = ANY(pg_blocking_pids(losing.pid))
                  AND losing.query LIKE '%INSERT INTO author_saved_view(%';
                """,
                new SugarParameter("@Loser", loserApplication),
                new SugarParameter("@Winner", winnerApplication));
            if (blocked == 1)
            {
                return;
            }
            await Task.Delay(TimeSpan.FromMilliseconds(25), cancellationToken);
        }
    }

    private static async Task ObserveCollisionOperationAsync(Task operation)
    {
        try
        {
            await operation;
        }
        catch (Exception) when (operation.IsCompleted)
        {
            // Observe a terminal fault without replacing the case's original
            // assertion or barrier failure; no wait timeout substitutes for exit.
        }
    }

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
