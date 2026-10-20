using System.Data;
using System.Text.Json;

using FsusBlog.Contracts.Articles;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.Security;

using Npgsql;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

public sealed partial class ArticlePropertyDefinitionAuthorityIntegrationTests
{
    [Fact]
    public async Task SourceEnrollment_DefinitionAndRealPolicyUseOneFamilyWithoutInventingAnArticle()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        var owner = ArticlePropertyDefinitionOwner.User(42, "source-observation");
        var command = CreateCommand(owner, ArticlePropertyValueType.Text, Guid.CreateVersion7(), Guid.CreateVersion7(), 0, []);
        var store = CreateStore(db);
        ArticlePropertyDefinitionWriteReceipt receipt = await store.CreateAsync(command);
        Assert.Equal(1, await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
        ArticleSourceObservation definition = await db.Queryable<ArticleSourceObservation>().SingleAsync();
        Assert.Equal("property-definition", definition.OriginKind);
        Assert.Equal(receipt.ReceiptId.ToString("D"), definition.OriginKey);
        Assert.Null(definition.ArticleId);
        Assert.Null(definition.SourceSequence);
        Assert.True((await store.CreateAsync(command)).IsIdempotentReplay);
        Assert.Equal(1, await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));

        InitPolicyTables(db);
        var policy = new SecurityPolicySnapshotService(db, TimeProvider.System);
        SecurityPolicySnapshotRecord activated = await policy.ActivateAsync("source-test", "observe", new
        {
            Enabled = true
        }, 42, "test");
        Assert.Equal(2, await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
        ArticleSourceObservation policyObservation = await db.Queryable<ArticleSourceObservation>()
            .Where(row => row.OriginKind == "security-policy").SingleAsync();
        Assert.Equal("source-test:" + activated.Version, policyObservation.OriginKey);
        Assert.Null(policyObservation.ArticleId);
        Assert.Equal(0, await db.Queryable<ArticleSourceSequence>().CountAsync());
        Assert.Equal(0, await db.Queryable<ArticleSourceMutation>().CountAsync());
        Assert.Equal(2, await db.Queryable<ArticleSourceObservation>().CountAsync());

        PostgresSqlSugarTestClient.InitTables(db, typeof(Article), typeof(ArticleBody), typeof(ArticleTag),
            typeof(ArticleRevision), typeof(ArticleRevisionContentBlock), typeof(ArticleRightsPolicy),
            typeof(ArticleRightsSnapshot), typeof(ArticleResponsibilitySnapshot), typeof(ArticlePublicationRecord),
            typeof(ArticleMutationOutboxEvent), typeof(ArticleMutationCommand), typeof(ContentAsset),
            typeof(ContentAssetReference), typeof(ContentAssetCleanupQueueItem));
        ArticleCreateMutationAuthority.Result? article = null;
        DateTime now = DateTime.UtcNow;
        var transaction = await db.Ado.UseTranAsync(async () => article = await ArticleCreateMutationAuthority.ExecuteAsync(db,
            new("Source observation", "# current", null, null, 1, [], ArticleStatus.Draft,
                null, null, null, null, null, now, ArticleProductionNormalizers.NormalizeArticleRights(null),
                42, "source observation", ArticleMutationEventTypes.Created, ArticlePublicationTransitionKinds.SaveDraft,
                new ArticleMutationScopeSnapshot(1, [], "draft"))));
        Assert.True(transaction.IsSuccess, transaction.ErrorException?.ToString());
        Assert.Equal(new ArticleSourceCursor(article!.ArticleId, 3, 1),
            await ArticleSourceGenerationAuthority.ReadArticleCursorAsync(db, article.ArticleId));
        ArticleSourceObservation articleObservation = await db.Queryable<ArticleSourceObservation>()
            .Where(row => row.OriginKind == "article").SingleAsync();
        Assert.Equal(article.Outbox.EventId, articleObservation.OriginKey);
        Assert.Equal(3, articleObservation.SourceGeneration);
        Assert.Equal(1, await db.Queryable<ArticleSourceMutation>().CountAsync());
        Assert.Equal(3, await db.Queryable<ArticleSourceObservation>().CountAsync());
    }

    [Fact]
    public async Task SourceEnrollment_RealPolicyRollbackAllocatesOnceAndOldSnapshotReplayRetainsItsCoordinates()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        InitPolicyTables(db);
        var policy = new SecurityPolicySnapshotService(db, TimeProvider.System);
        SecurityPolicySnapshotRecord first = await policy.ActivateAsync("source-test", "observe", new
        {
            Enabled = false
        }, 42, "first");
        await policy.ActivateAsync("source-test", "enforce", new
        {
            Enabled = true
        }, 42, "second");
        SecurityPolicyRollbackResult<JsonElement> rollback = await policy.RollbackAsync<JsonElement>("source-test", first.Version, 42, "rollback");
        Assert.True(rollback.Success, rollback.Reason);
        Assert.Equal(first.Version, rollback.Record!.RollbackOfVersion);
        Assert.Equal(3, await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
        db.Ado.BeginTran(IsolationLevel.ReadCommitted);
        try
        {
            await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(db);
            ArticleSourceObservationCursor replay = await ArticleSourceGenerationAuthority.RecordPolicySnapshotAsync(db, "source-test", first.Version);
            Assert.Equal(new ArticleSourceObservationCursor(1, null, null), replay);
            db.Ado.CommitTran();
        }
        finally
        {
            if (db.Ado.Transaction is not null)
                db.Ado.RollbackTran();
        }
        Assert.Equal(3, await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
        Assert.Equal(3, await db.Queryable<ArticleSourceObservation>().CountAsync());
    }

    [Fact]
    public async Task SourceEnrollment_MissingObservationSchemaRefusesOriginalPolicyCommit()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        InitPolicyTables(db);
        await db.Ado.ExecuteCommandAsync("DROP TABLE article_source_observation;");
        Exception error = await Assert.ThrowsAnyAsync<Exception>(() => new SecurityPolicySnapshotService(db, TimeProvider.System)
            .ActivateAsync("source-test", "observe", new
            {
                Enabled = true
            }, 42, "test"));
        Assert.Contains("article_source_observation", error.ToString());
        using SqlSugarClient observer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        Assert.Equal(0, await observer.Queryable<SecurityPolicySnapshot>().CountAsync());
        Assert.Equal(0, await observer.Queryable<SecurityPolicyVersionCounter>().CountAsync());
        Assert.Null(await ArticleSourceGenerationAuthority.ReadGenerationAsync(observer));
    }

    [Fact]
    public async Task SourceEnrollment_DefinitionJournalAuditAndClockRollBackWhenEnrollmentFails()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        await InstallObservationFailureAsync(db);
        var owner = ArticlePropertyDefinitionOwner.User(42, "source-rollback");
        var command = CreateCommand(owner, ArticlePropertyValueType.Text, Guid.CreateVersion7(), Guid.CreateVersion7(), 0, []);
        Exception error = await Assert.ThrowsAnyAsync<Exception>(() => CreateStore(db).CreateAsync(command));
        Assert.Contains("original observation enrollment failed", error.ToString());
        using SqlSugarClient observer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        foreach (string table in new[] { "article_property_definition", "article_property_definition_receipt",
            "article_property_definition_command", "article_property_definition_idempotency", "sys_audit_log", "article_source_observation" })
            Assert.Equal(0, await observer.Ado.GetIntAsync($"SELECT COUNT(*) FROM {table};"));
        Assert.Null(await ArticleSourceGenerationAuthority.ReadGenerationAsync(observer));
        await observer.Ado.ExecuteCommandAsync("DROP TRIGGER fail_original_observation ON article_source_observation;");
        await CreateStore(observer).CreateAsync(command);
        Assert.Equal(1, await ArticleSourceGenerationAuthority.ReadGenerationAsync(observer));
    }

    [Fact]
    public async Task SourceEnrollment_RealPolicyActivationRollsBackSnapshotCounterAndClockOnEnrollmentFailure()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        InitPolicyTables(db);
        await InstallObservationFailureAsync(db);
        var policy = new SecurityPolicySnapshotService(db, TimeProvider.System);
        Exception error = await Assert.ThrowsAnyAsync<Exception>(() =>
            policy.ActivateAsync("source-test", "observe", new
            {
                Enabled = true
            }, 42, "test"));
        Assert.Contains("original observation enrollment failed", error.ToString());
        using SqlSugarClient observer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        Assert.Equal(0, await observer.Queryable<SecurityPolicySnapshot>().CountAsync());
        Assert.Equal(0, await observer.Queryable<SecurityPolicyVersionCounter>().CountAsync());
        Assert.Equal(0, await observer.Queryable<ArticleSourceObservation>().CountAsync());
        Assert.Null(await ArticleSourceGenerationAuthority.ReadGenerationAsync(observer));
    }

    [Fact]
    public async Task SourceEnrollment_OriginalDefinitionWaitsForFamilyBeforeItsOwnerAndDefinitionAdvisoryLocks()
    {
        using SqlSugarClient blocker = await CreateDatabaseAsync();
        using SqlSugarClient writer = PostgresSqlSugarTestClient.Create(blocker.CurrentConnectionConfig.ConnectionString);
        writer.Ado.Open();
        int pid = ((NpgsqlConnection)writer.Ado.Connection).ProcessID;
        blocker.Ado.BeginTran(IsolationLevel.ReadCommitted);
        await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(blocker);
        var owner = ArticlePropertyDefinitionOwner.User(42, "source-contention");
        Task<ArticlePropertyDefinitionWriteReceipt> waiting = CreateStore(writer).CreateAsync(
            CreateCommand(owner, ArticlePropertyValueType.Text, Guid.CreateVersion7(), Guid.CreateVersion7(), 0, []));
        try
        {
            await using var monitor = new NpgsqlConnection(blocker.CurrentConnectionConfig.ConnectionString);
            await monitor.OpenAsync();
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            await using var query = new NpgsqlCommand("""
                SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = @Pid AND locktype = 'advisory' AND NOT granted);
                """, monitor);
            query.Parameters.AddWithValue("Pid", pid);
            while (!(bool)(await query.ExecuteScalarAsync(deadline.Token))!)
                await Task.Delay(20, deadline.Token);
            query.CommandText = "SELECT COUNT(*) FROM pg_locks WHERE pid = @Pid AND locktype = 'advisory' AND granted;";
            Assert.Equal(0L, (long)(await query.ExecuteScalarAsync(deadline.Token))!);
            blocker.Ado.RollbackTran();
            await waiting;
            Assert.Equal(1, await ArticleSourceGenerationAuthority.ReadGenerationAsync(writer));
        }
        finally
        {
            if (blocker.Ado.Transaction is not null)
                blocker.Ado.RollbackTran();
            await waiting;
        }
    }

    [Fact]
    public async Task SourceEnrollment_ReadOnlyRepeatableReadComposesWithOriginalReadCommittedPolicyWrites()
    {
        using SqlSugarClient writer = await CreateDatabaseAsync();
        InitPolicyTables(writer);
        var owner = ArticlePropertyDefinitionOwner.User(42, "source-read-snapshot");
        await CreateStore(writer).CreateAsync(CreateCommand(owner, ArticlePropertyValueType.Text,
            Guid.CreateVersion7(), Guid.CreateVersion7(), 0, []));
        using SqlSugarClient reader = PostgresSqlSugarTestClient.Create(writer.CurrentConnectionConfig.ConnectionString);
        reader.Ado.BeginTran(IsolationLevel.RepeatableRead);
        try
        {
            await reader.Ado.ExecuteCommandAsync("SET TRANSACTION READ ONLY;");
            Assert.Equal(1, await ArticleSourceGenerationAuthority.ReadGenerationAsync(reader));
            Assert.Equal(0, await reader.Queryable<SecurityPolicySnapshot>().CountAsync());
            await new SecurityPolicySnapshotService(writer, TimeProvider.System)
                .ActivateAsync("source-test", "observe", new
                {
                    Enabled = true
                }, 42, "test");
            Assert.Equal(2, await ArticleSourceGenerationAuthority.ReadGenerationAsync(writer));
            Assert.Equal(1, await ArticleSourceGenerationAuthority.ReadGenerationAsync(reader));
            Assert.Equal(0, await reader.Queryable<SecurityPolicySnapshot>().CountAsync());
        }
        finally
        {
            reader.Ado.RollbackTran();
        }
        Assert.Equal(2, await ArticleSourceGenerationAuthority.ReadGenerationAsync(reader));
        Assert.Equal(1, await reader.Queryable<SecurityPolicySnapshot>().CountAsync());
    }

    [Fact]
    public async Task SourceEnrollment_MissingOriginalReceiptsCannotInitializeClock()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        InitPolicyTables(db);
        db.Ado.BeginTran(IsolationLevel.ReadCommitted);
        try
        {
            await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(db);
            InvalidOperationException definitionError = await Assert.ThrowsAsync<InvalidOperationException>(() =>
                ArticleSourceGenerationAuthority.RecordPropertyDefinitionAsync(db, Guid.CreateVersion7()));
            Assert.Equal("article_source_original_observation_missing", definitionError.Message);
            InvalidOperationException policyError = await Assert.ThrowsAsync<InvalidOperationException>(() =>
                ArticleSourceGenerationAuthority.RecordPolicySnapshotAsync(db, "missing-policy", 1));
            Assert.Equal("article_source_original_observation_missing", policyError.Message);
            Assert.Null(await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
        }
        finally
        {
            db.Ado.RollbackTran();
        }
    }

    [Theory]
    [InlineData("1, NULL, 1")]
    [InlineData("NULL, 1, 1")]
    [InlineData("1, 0, 1")]
    [InlineData("1, 2, 1")]
    public async Task SourceEnrollment_DdlRejectsInvalidNullableArticleSequencePairs(string coordinates)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        PostgresException error = await Assert.ThrowsAsync<PostgresException>(() => db.Ado.ExecuteCommandAsync(
            "INSERT INTO article_source_observation(origin_kind, origin_key, article_id, source_sequence, source_generation, origin_facts) "
            + $"VALUES ('property-value', 'invalid', {coordinates}, '{{}}');"));
        Assert.Equal(PostgresErrorCodes.CheckViolation, error.SqlState);
    }

    private static void InitPolicyTables(SqlSugarClient db)
        => PostgresSqlSugarTestClient.InitTables(db, typeof(SecurityPolicySnapshot), typeof(SecurityPolicyVersionCounter));

    private static Task<int> InstallObservationFailureAsync(SqlSugarClient db)
        => db.Ado.ExecuteCommandAsync("""
            CREATE FUNCTION fail_original_observation() RETURNS trigger AS $$
            BEGIN RAISE EXCEPTION 'original observation enrollment failed'; END;
            $$ LANGUAGE plpgsql;
            CREATE TRIGGER fail_original_observation BEFORE INSERT ON article_source_observation
                FOR EACH ROW EXECUTE FUNCTION fail_original_observation();
            """);
}
