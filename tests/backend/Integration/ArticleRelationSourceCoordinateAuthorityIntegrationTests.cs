using System.Data;

using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleEmbeds;

using Npgsql;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

/// <summary>
/// Ordinary task-owned module transactions using the original disposable PostgreSQL fixture.
/// Direct fixture rows prove persistence semantics, not original-owner lifecycle/HTTP acceptance.
/// </summary>
[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class ArticleRelationSourceCoordinateAuthorityIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    private readonly ArticleRelationSourceCoordinateAuthority _authority = new();
    private static DateTime Now => TestTemporalContext.FromEnvironment().BusinessEpochUtc.UtcDateTime;

    [Fact]
    public async Task ProvisionCommitReconnectAndExactRereadPreserveSavedCoordinates()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        (int article, long revision) = await CreateSourceAsync(db);
        ArticleRelationRevisionCoordinate saved = await ProvisionAndCommitAsync(db, article, revision);
        Assert.True(ArticleEmbedTargetCodec.IsPortableArticleIdentity(saved.ArticleIdentity));
        Assert.StartsWith("revision:", saved.RevisionIdentity);
        Assert.NotEqual(Guid.Empty, saved.SourceEpoch);
        string connectionString = db.CurrentConnectionConfig.ConnectionString;
        db.Close();
        using SqlSugarClient restarted = PostgresSqlSugarTestClient.Create(connectionString);
        var restartedAuthority = new ArticleRelationSourceCoordinateAuthority();
        Assert.Equal(saved, await restartedAuthority.ReadRevisionAsync(restarted, article, revision));
        Assert.Equal(new ArticleRelationArticleCoordinate(article, saved.ArticleIdentity),
            await restartedAuthority.FindArticleAsync(restarted, saved.ArticleIdentity));
        await AssertCountsAsync(restarted, 1, 1);
    }

    [Fact]
    public async Task RepeatedProvisioningPreservesBindingsAndLeavesCallerTransactionLive()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        (int article, long revision) = await CreateSourceAsync(db);
        await db.Ado.BeginTranAsync();
        IDbTransaction callerTransaction = db.Ado.Transaction;
        ArticleRelationRevisionCoordinate first = await _authority.ProvisionRevisionAsync(db, article, revision);
        Assert.Equal(first, await _authority.ProvisionRevisionAsync(db, article, revision));
        Assert.Equal(first, await _authority.ReadRevisionAsync(db, article, revision));
        Assert.Same(callerTransaction, db.Ado.Transaction);
        Assert.Same(db.Ado.Connection, callerTransaction.Connection);
        await db.Ado.CommitTranAsync();
        Assert.Equal(first, await ProvisionAndCommitAsync(db, article, revision));
        await AssertCountsAsync(db, 1, 1);
    }

    [Fact]
    public async Task ConcurrentExactAndNewRevisionProvisioningSerializeOneArticleBinding()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        (int article, long revision) = await CreateSourceAsync(db);
        long nextRevision = await CreateRevisionAsync(db, article, 2);
        string connectionString = db.CurrentConnectionConfig.ConnectionString;
        Task<ArticleRelationRevisionCoordinate> Run(long source) => Task.Run(async () =>
        {
            using SqlSugarClient caller = PostgresSqlSugarTestClient.Create(connectionString);
            return await ProvisionAndCommitAsync(caller, article, source);
        });
        ArticleRelationRevisionCoordinate[] raced = await Task.WhenAll(Run(revision), Run(revision), Run(nextRevision));
        Assert.Equal(raced[0], raced[1]);
        Assert.Equal(raced[0].ArticleIdentity, raced[2].ArticleIdentity);
        Assert.NotEqual(raced[0].RevisionIdentity, raced[2].RevisionIdentity);
        Assert.NotEqual(raced[0].SourceEpoch, raced[2].SourceEpoch);
        await AssertCountsAsync(db, 1, 2);
    }

    [Fact]
    public async Task MissingArticleRevisionAndWrongOwnershipRefuseBeforeBindingWrites()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        (int article, long revision) = await CreateSourceAsync(db);
        (int otherArticle, _) = await CreateSourceAsync(db);
        foreach ((int articleId, long revisionId) in new[] { (int.MaxValue, revision), (article, long.MaxValue), (otherArticle, revision) })
        {
            await db.Ado.BeginTranAsync();
            await Assert.ThrowsAsync<ArticleRelationSourceCoordinateException>(
                () => _authority.ProvisionRevisionAsync(db, articleId, revisionId));
            // Failures before writes leave the caller free to inspect/rollback its transaction.
            await AssertCountsAsync(db, 0, 0);
            await db.Ado.RollbackTranAsync();
            Assert.Null(await _authority.ReadRevisionAsync(db, articleId, revisionId));
        }
    }

    [Fact]
    public async Task MismatchedAndCompletedCallerTransactionsAreRejected()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        (int article, long revision) = await CreateSourceAsync(db);
        using SqlSugarClient other = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        await other.Ado.BeginTranAsync();
        db.Ado.Transaction = other.Ado.Transaction;
        try
        {
            await Assert.ThrowsAsync<ArticleRelationSourceCoordinateException>(
                () => _authority.ProvisionRevisionAsync(db, article, revision));
            await Assert.ThrowsAsync<ArticleRelationSourceCoordinateException>(
                () => _authority.ReadRevisionAsync(db, article, revision));
        }
        finally
        {
            db.Ado.Transaction = null;
            await other.Ado.RollbackTranAsync();
        }
        await db.Ado.BeginTranAsync();
        NpgsqlTransaction native = Assert.IsType<NpgsqlTransaction>(db.Ado.Transaction);
        await native.RollbackAsync();
        try
        {
            await Assert.ThrowsAsync<ArticleRelationSourceCoordinateException>(
                () => _authority.ProvisionRevisionAsync(db, article, revision));
        }
        finally
        {
            db.Ado.Transaction = null;
            await native.DisposeAsync();
        }
        await AssertCountsAsync(db, 0, 0);
    }

    [Fact]
    public async Task CallerRollbackRemovesProvisionedBindingsAndFreshRetryPersists()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        (int article, long revision) = await CreateSourceAsync(db);
        await db.Ado.BeginTranAsync();
        ArticleRelationRevisionCoordinate provisional = await _authority.ProvisionRevisionAsync(db, article, revision);
        Assert.Equal(provisional, await _authority.ReadRevisionAsync(db, article, revision));
        await db.Ado.RollbackTranAsync();
        Assert.Null(await _authority.ReadRevisionAsync(db, article, revision));
        await AssertCountsAsync(db, 0, 0);
        ArticleRelationRevisionCoordinate saved = await ProvisionAndCommitAsync(db, article, revision);
        Assert.NotEqual(provisional.ArticleIdentity, saved.ArticleIdentity);
        Assert.Equal(saved, await _authority.ReadRevisionAsync(db, article, revision));
    }

    [Fact]
    public async Task CancellationDuringActualCallerRowLockWaitLeavesNoBindings()
    {
        using SqlSugarClient blocker = await CreateDatabaseAsync();
        (int article, long revision) = await CreateSourceAsync(blocker);
        string connectionString = blocker.CurrentConnectionConfig.ConnectionString;
        using SqlSugarClient waiter = PostgresSqlSugarTestClient.Create(connectionString);
        await blocker.Ado.BeginTranAsync();
        await blocker.Ado.ExecuteCommandAsync("SELECT id FROM article WHERE id = @id FOR UPDATE;", new SugarParameter("@id", article));
        await waiter.Ado.BeginTranAsync();
        int waiterPid = ((NpgsqlConnection)waiter.Ado.Connection).ProcessID;
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        Task<ArticleRelationRevisionCoordinate> provisioning = _authority.ProvisionRevisionAsync(waiter, article, revision, cancellation.Token);
        try
        {
            await using var observer = new NpgsqlConnection(connectionString);
            await observer.OpenAsync(cancellation.Token);
            await using var command = new NpgsqlCommand("SELECT cardinality(pg_blocking_pids(@pid)) > 0;", observer);
            command.Parameters.AddWithValue("pid", waiterPid);
            bool blocked = false;
            while (!blocked && !provisioning.IsCompleted)
            {
                blocked = (bool)(await command.ExecuteScalarAsync(cancellation.Token))!;
                if (!blocked)
                {
                    await Task.Delay(10, cancellation.Token);
                }
            }
            Assert.True(blocked, "The exact provisioning command must be observed waiting on the caller's row lock.");
            cancellation.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => provisioning);
        }
        finally
        {
            cancellation.Cancel();
            try
            {
                await provisioning;
            }
            catch (OperationCanceledException)
            {
            }
            await waiter.Ado.RollbackTranAsync();
            await blocker.Ado.RollbackTranAsync();
        }
        await AssertCountsAsync(blocker, 0, 0);
    }

    [Fact]
    public async Task ExactAndPortableReadsRunInReadOnlyTransactionWithoutProvisioning()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        (int article, long revision) = await CreateSourceAsync(db);
        await db.Ado.BeginTranAsync();
        await db.Ado.ExecuteCommandAsync("SET TRANSACTION READ ONLY;");
        Assert.Null(await _authority.ReadRevisionAsync(db, article, revision));
        Assert.Null(await _authority.FindArticleAsync(db, $"article:{Guid.NewGuid():D}"));
        await db.Ado.CommitTranAsync();
        await AssertCountsAsync(db, 0, 0);
        ArticleRelationRevisionCoordinate saved = await ProvisionAndCommitAsync(db, article, revision);
        await db.Ado.BeginTranAsync();
        await db.Ado.ExecuteCommandAsync("SET TRANSACTION READ ONLY;");
        Assert.Equal(saved, await _authority.ReadRevisionAsync(db, article, revision));
        Assert.NotNull(await _authority.FindArticleAsync(db, saved.ArticleIdentity));
        Assert.Null(await _authority.ReadRevisionAsync(db, article, long.MaxValue));
        await db.Ado.CommitTranAsync();
        await AssertCountsAsync(db, 1, 1);
    }

    [Fact]
    public async Task ImportPreservesSuppliedArticleIdentityAndAllocatesLocalRevisionCoordinates()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        string supplied = $"article:{Guid.NewGuid():D}";
        await db.Ado.BeginTranAsync();
        int article = await CreateArticleAsync(db);
        ArticleRelationArticleCoordinate binding = await _authority.ProvisionImportedArticleAsync(db, article, supplied);
        Assert.Equal(new ArticleRelationArticleCoordinate(article, supplied), binding);
        Assert.Equal(binding, await _authority.ProvisionImportedArticleAsync(db, article, supplied));
        await AssertCountsAsync(db, 1, 0);
        long revision = await CreateRevisionAsync(db, article, 1);
        Assert.Null(await _authority.ReadRevisionAsync(db, article, revision));
        ArticleRelationRevisionCoordinate saved = await _authority.ProvisionRevisionAsync(db, article, revision);
        await db.Ado.CommitTranAsync();
        Assert.Equal(supplied, saved.ArticleIdentity);
        Assert.Equal(saved, await ProvisionAndCommitAsync(db, article, revision));
        await db.Ado.BeginTranAsync();
        Assert.Equal(saved, await _authority.ProvisionImportedRevisionAsync(db, article, revision, supplied));
        await db.Ado.CommitTranAsync();
        Assert.Equal(new ArticleRelationArticleCoordinate(article, supplied), await _authority.FindArticleAsync(db, supplied));
    }

    [Fact]
    public async Task ImportRefusesExistingRemapAndCrossArticleIdentityCollision()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        (int article, long revision) = await CreateSourceAsync(db);
        long nextRevision = await CreateRevisionAsync(db, article, 2);
        (int otherArticle, long otherRevision) = await CreateSourceAsync(db);
        ArticleRelationRevisionCoordinate saved = await ProvisionAndCommitAsync(db, article, revision);
        foreach (long source in new[] { revision, nextRevision })
        {
            await db.Ado.BeginTranAsync();
            ArticleRelationSourceCoordinateException exception = await Assert.ThrowsAsync<ArticleRelationSourceCoordinateException>(
                () => _authority.ProvisionImportedRevisionAsync(db, article, source, $"article:{Guid.NewGuid():D}"));
            Assert.Equal("article_relation_article_remap_refused", exception.Message);
            await db.Ado.RollbackTranAsync();
        }
        await db.Ado.BeginTranAsync();
        ArticleRelationSourceCoordinateException collision = await Assert.ThrowsAsync<ArticleRelationSourceCoordinateException>(
            () => _authority.ProvisionImportedRevisionAsync(db, otherArticle, otherRevision, saved.ArticleIdentity));
        Assert.Equal("article_relation_binding_conflict", collision.Message);
        await db.Ado.RollbackTranAsync();
        await db.Ado.BeginTranAsync();
        await Assert.ThrowsAsync<ArticleRelationSourceCoordinateException>(
            () => _authority.ProvisionImportedArticleAsync(db, article, $"article:{Guid.NewGuid():D}"));
        await db.Ado.RollbackTranAsync();
        await db.Ado.BeginTranAsync();
        await Assert.ThrowsAsync<ArticleRelationSourceCoordinateException>(
            () => _authority.ProvisionImportedArticleAsync(db, otherArticle, saved.ArticleIdentity));
        await db.Ado.RollbackTranAsync();
        Assert.Equal(saved, await _authority.ReadRevisionAsync(db, article, revision));
        Assert.Null(await _authority.ReadRevisionAsync(db, article, nextRevision));
        Assert.Null(await _authority.ReadRevisionAsync(db, otherArticle, otherRevision));
        await AssertCountsAsync(db, 1, 1);
    }

    [Fact]
    public async Task DatabaseRejectsBindingRemapDeletionWrongOwnerAndRevisionEpochCollisions()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        (int article, long revision) = await CreateSourceAsync(db);
        (int otherArticle, long otherRevision) = await CreateSourceAsync(db);
        ArticleRelationRevisionCoordinate saved = await ProvisionAndCommitAsync(db, article, revision);
        await ProvisionAndCommitAsync(db, otherArticle, otherRevision);
        long thirdRevision = await CreateRevisionAsync(db, otherArticle, 2);
        Guid savedRevisionIdentity = Guid.Parse(saved.RevisionIdentity["revision:".Length..]);
        string[] refused =
        [
            "UPDATE article_relation_article_binding SET portable_identity = gen_random_uuid();",
            "UPDATE article_relation_source_coordinate SET source_epoch = gen_random_uuid();",
            "DELETE FROM article_relation_article_binding;",
            "DELETE FROM article_relation_source_coordinate;",
            $"INSERT INTO article_relation_source_coordinate VALUES ({thirdRevision}, {article}, gen_random_uuid(), gen_random_uuid());",
            $"INSERT INTO article_relation_source_coordinate VALUES ({thirdRevision}, {otherArticle}, '{savedRevisionIdentity:D}', gen_random_uuid());",
            $"INSERT INTO article_relation_source_coordinate VALUES ({thirdRevision}, {otherArticle}, gen_random_uuid(), '{saved.SourceEpoch:D}');",
            $"UPDATE article_revision SET article_id = {otherArticle} WHERE id = {revision};"
        ];
        foreach (string sql in refused)
        {
            await using var connection = new NpgsqlConnection(db.CurrentConnectionConfig.ConnectionString);
            await connection.OpenAsync();
            await using var command = new NpgsqlCommand(sql, connection);
            PostgresException failure = await Assert.ThrowsAsync<PostgresException>(() => command.ExecuteNonQueryAsync());
            Assert.Contains(failure.SqlState, new[] { "23514", "23503", "23505" });
        }
        Assert.Equal(saved, await _authority.ReadRevisionAsync(db, article, revision));
        await AssertCountsAsync(db, 2, 2);
    }

    [Fact]
    public async Task HistoricalBindingsSurviveMetadataSoftDeleteRestoreAndNewRevision()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        (int article, long revision) = await CreateSourceAsync(db);
        ArticleRelationRevisionCoordinate original = await ProvisionAndCommitAsync(db, article, revision);
        foreach (bool deleted in new[] { true, false })
        {
            await db.Updateable<Article>().SetColumns(row => new Article { IsDeleted = deleted, Title = "renamed" })
                .Where(row => row.Id == article).ExecuteCommandAsync();
            Assert.Equal(original, await _authority.ReadRevisionAsync(db, article, revision));
            Assert.NotNull(await _authority.FindArticleAsync(db, original.ArticleIdentity));
        }
        long newRevision = await CreateRevisionAsync(db, article, 2);
        ArticleRelationRevisionCoordinate newer = await ProvisionAndCommitAsync(db, article, newRevision);
        Assert.Equal(original.ArticleIdentity, newer.ArticleIdentity);
        Assert.NotEqual(original.RevisionIdentity, newer.RevisionIdentity);
        Assert.NotEqual(original.SourceEpoch, newer.SourceEpoch);
        Assert.Equal(original, await _authority.ReadRevisionAsync(db, article, revision));
        await AssertCountsAsync(db, 1, 2);
    }

    [Fact]
    public async Task DraftCurrentAndPublishedViewsDoNotAllocateOrOverwriteImmutableSourceBindings()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        (int article, long revision) = await CreateSourceAsync(db);
        long currentRevision = await CreateRevisionAsync(db, article, 2);
        ArticleRelationRevisionCoordinate published = await ProvisionAndCommitAsync(db, article, revision);
        ArticleRelationRevisionCoordinate current = await ProvisionAndCommitAsync(db, article, currentRevision);
        long publicationId = await db.Insertable(new ArticlePublicationRecord
        {
            ArticleId = article,
            ArticleRevisionId = revision,
            RevisionNo = 1,
            PublicationNo = 1,
            PublishedAt = Now,
            CreatedAt = Now,
            TransitionKind = "fixture"
        }).ExecuteReturnBigIdentityAsync();
        await db.Updateable<Article>().SetColumns(row => new Article
        {
            CurrentRevisionId = currentRevision,
            CurrentPublicationId = publicationId
        }).Where(row => row.Id == article).ExecuteCommandAsync();
        long draftOnlyId = 0;
        for (int index = 0; index < 3; index++)
        {
            draftOnlyId = await db.Insertable(new ArticleDraft
            {
                OwnerAdminPrincipalId = 42,
                ArticleId = null,
                DraftKey = $"unbound-draft-{index}",
                Title = "draft",
                ServerRevision = 1,
                CreatedAt = Now,
                UpdatedAt = Now
            }).ExecuteReturnBigIdentityAsync();
        }
        Assert.True(draftOnlyId > currentRevision);
        Assert.Null(await _authority.ReadRevisionAsync(db, article, draftOnlyId));
        await db.Ado.BeginTranAsync();
        await Assert.ThrowsAsync<ArticleRelationSourceCoordinateException>(
            () => _authority.ProvisionRevisionAsync(db, article, draftOnlyId));
        await db.Ado.RollbackTranAsync();
        Assert.Equal(published, await _authority.ReadRevisionAsync(db, article, revision));
        Assert.Equal(current, await _authority.ReadRevisionAsync(db, article, currentRevision));
        await db.Updateable<ArticleDraft>().SetColumns(row => new ArticleDraft { ServerRevision = 2, MarkdownContent = "draft change" })
            .Where(row => row.Id == draftOnlyId).ExecuteCommandAsync();
        Assert.Equal(published, await _authority.ReadRevisionAsync(db, article, revision));
        Assert.Equal(current, await _authority.ReadRevisionAsync(db, article, currentRevision));
        await AssertCountsAsync(db, 1, 2);
        // No draft provisioning API exists; the unbound draft has acquired no article binding.
        Assert.Equal(1, await db.Queryable<ArticleRelationArticleBinding>().CountAsync());
    }

    [Fact]
    public async Task BatchReadsSixtyFourExactHistoricalBindingsInInputOrderAcrossReconnect()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        var saved = new List<ArticleRelationRevisionCoordinate>();
        for (int index = 0; index < 32; index++)
        {
            (int article, long revision) = await CreateSourceAsync(db);
            saved.Add(await ProvisionAndCommitAsync(db, article, revision));
            long next = await CreateRevisionAsync(db, article, 2);
            saved.Add(await ProvisionAndCommitAsync(db, article, next));
        }
        saved.Reverse();
        (int ArticleId, long RevisionId)[] pairs = saved.Select(static source => (source.ArticleId, source.RevisionId)).ToArray();
        Assert.Equal(64, pairs.Length);
        Assert.Equal(saved, await _authority.ReadRevisionsAsync(db, pairs));
        db.Close();
        using SqlSugarClient restarted = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        Assert.Equal(saved, await new ArticleRelationSourceCoordinateAuthority().ReadRevisionsAsync(restarted, pairs));
        await AssertCountsAsync(restarted, 32, 64);
    }

    [Fact]
    public async Task BatchReadsUncommittedCallerBindingsAndPreservesReadOnlyRepeatableReadTransaction()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        (int article, long revision) = await CreateSourceAsync(db);
        long next = await CreateRevisionAsync(db, article, 2);
        await db.Ado.BeginTranAsync();
        ArticleRelationRevisionCoordinate first = await _authority.ProvisionRevisionAsync(db, article, revision);
        ArticleRelationRevisionCoordinate second = await _authority.ProvisionRevisionAsync(db, article, next);
        var pairs = new (int, long)[] { (article, next), (article, revision) };
        Assert.Equal(new[] { second, first }, await _authority.ReadRevisionsAsync(db, pairs));
        using SqlSugarClient observer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        await Assert.ThrowsAsync<ArticleRelationSourceCoordinateException>(() => _authority.ReadRevisionsAsync(observer, pairs));
        await db.Ado.CommitTranAsync();

        await db.Ado.BeginTranAsync(IsolationLevel.RepeatableRead);
        await db.Ado.ExecuteCommandAsync("SET TRANSACTION READ ONLY;");
        NpgsqlTransaction transaction = Assert.IsType<NpgsqlTransaction>(db.Ado.Transaction);
        IDbConnection connection = db.Ado.Connection;
        int pid = ((NpgsqlConnection)connection).ProcessID;
        Assert.Equal(new[] { second, first }, await _authority.ReadRevisionsAsync(db, pairs));
        Assert.Same(connection, db.Ado.Connection);
        Assert.Same(transaction, db.Ado.Transaction);
        Assert.Equal(IsolationLevel.RepeatableRead, transaction.IsolationLevel);
        Assert.Equal(pid, ((NpgsqlConnection)connection).ProcessID);
        Assert.Equal("on", await db.Ado.GetStringAsync("SHOW transaction_read_only;"));
        await db.Ado.RollbackTranAsync();
        Assert.Equal(new[] { second, first }, await _authority.ReadRevisionsAsync(db, pairs));
        await AssertCountsAsync(db, 1, 2);
    }

    [Fact]
    public async Task BatchMissingUnprovisionedOrWrongOwnerRefusesWholeReadWithoutWriting()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        (int article, long revision) = await CreateSourceAsync(db);
        (int other, long unprovisioned) = await CreateSourceAsync(db);
        ArticleRelationRevisionCoordinate saved = await ProvisionAndCommitAsync(db, article, revision);
        foreach ((int articleId, long revisionId) in new[] { (other, unprovisioned), (other, revision), (article, long.MaxValue), (int.MaxValue, revision) })
        {
            foreach (bool missingFirst in new[] { true, false })
            {
                var pairs = missingFirst
                    ? new (int, long)[] { (articleId, revisionId), (article, revision) }
                    : new (int, long)[] { (article, revision), (articleId, revisionId) };
                await db.Ado.BeginTranAsync();
                await db.Ado.ExecuteCommandAsync("SET TRANSACTION READ ONLY;");
                ArticleRelationSourceCoordinateException exception = await Assert.ThrowsAsync<ArticleRelationSourceCoordinateException>(
                    () => _authority.ReadRevisionsAsync(db, pairs));
                Assert.Equal("article_relation_binding_unavailable", exception.Message);
                Assert.Equal(saved, await _authority.ReadRevisionAsync(db, article, revision));
                await AssertCountsAsync(db, 1, 1);
                await db.Ado.RollbackTranAsync();
            }
        }
    }

    [Fact]
    public async Task BatchRefusesForeignAndCompletedCallerTransactions()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        (int article, long revision) = await CreateSourceAsync(db);
        await ProvisionAndCommitAsync(db, article, revision);
        var pairs = new (int, long)[] { (article, revision) };
        using SqlSugarClient other = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        await other.Ado.BeginTranAsync();
        db.Ado.Transaction = other.Ado.Transaction;
        try
        {
            await Assert.ThrowsAsync<ArticleRelationSourceCoordinateException>(() => _authority.ReadRevisionsAsync(db, pairs));
        }
        finally
        {
            db.Ado.Transaction = null;
            await other.Ado.RollbackTranAsync();
        }
        await db.Ado.BeginTranAsync();
        NpgsqlTransaction transaction = Assert.IsType<NpgsqlTransaction>(db.Ado.Transaction);
        await transaction.RollbackAsync();
        try
        {
            await Assert.ThrowsAsync<ArticleRelationSourceCoordinateException>(() => _authority.ReadRevisionsAsync(db, pairs));
        }
        finally
        {
            db.Ado.Transaction = null;
            await transaction.DisposeAsync();
        }
        await AssertCountsAsync(db, 1, 1);
    }

    [Fact]
    public async Task BatchCancellationReachesBlockedSqlAndCompletesBeforeBorrowedClientReuse()
    {
        using SqlSugarClient blocker = await CreateDatabaseAsync();
        (int article, long revision) = await CreateSourceAsync(blocker);
        ArticleRelationRevisionCoordinate saved = await ProvisionAndCommitAsync(blocker, article, revision);
        string connectionString = blocker.CurrentConnectionConfig.ConnectionString;
        using SqlSugarClient waiter = PostgresSqlSugarTestClient.Create(connectionString);
        waiter.Ado.Open();
        NpgsqlConnection connection = Assert.IsType<NpgsqlConnection>(waiter.Ado.Connection);
        int pid = connection.ProcessID;
        await blocker.Ado.BeginTranAsync();
        await blocker.Ado.ExecuteCommandAsync("LOCK TABLE article_relation_source_coordinate IN ACCESS EXCLUSIVE MODE;");
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        Task<IReadOnlyList<ArticleRelationRevisionCoordinate>> read = _authority.ReadRevisionsAsync(
            waiter, new (int, long)[] { (article, revision) }, cancellation.Token);
        Exception? primaryFailure = null;
        try
        {
            await ObserveBlockedCommandAsync(connectionString, pid, read, cancellation.Token);
            cancellation.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => read);
            Assert.True(read.IsCompleted);
            Assert.Same(connection, waiter.Ado.Connection);
            Assert.Equal(ConnectionState.Open, connection.State);
            Assert.Equal(pid, connection.ProcessID);
            await using var command = new NpgsqlCommand("SELECT 1;", connection);
            Assert.Equal(1, await command.ExecuteScalarAsync());
        }
        catch (Exception exception)
        {
            primaryFailure = exception;
            throw;
        }
        finally
        {
            await ReleaseBlockerAndDrainAsync(blocker, read, cancellation, primaryFailure);
        }
        Assert.Equal(saved, Assert.Single(await _authority.ReadRevisionsAsync(waiter, new (int, long)[] { (article, revision) })));
        await AssertCountsAsync(blocker, 1, 1);
    }

    [Fact]
    public async Task BatchCopiesRequestedPairsBeforeAwaitingActualSql()
    {
        using SqlSugarClient blocker = await CreateDatabaseAsync();
        (int article, long revision) = await CreateSourceAsync(blocker);
        ArticleRelationRevisionCoordinate saved = await ProvisionAndCommitAsync(blocker, article, revision);
        string connectionString = blocker.CurrentConnectionConfig.ConnectionString;
        using SqlSugarClient waiter = PostgresSqlSugarTestClient.Create(connectionString);
        waiter.Ado.Open();
        int pid = ((NpgsqlConnection)waiter.Ado.Connection).ProcessID;
        await blocker.Ado.BeginTranAsync();
        await blocker.Ado.ExecuteCommandAsync("LOCK TABLE article_relation_source_coordinate IN ACCESS EXCLUSIVE MODE;");
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        var pairs = new (int, long)[] { (article, revision) };
        Task<IReadOnlyList<ArticleRelationRevisionCoordinate>> read = _authority.ReadRevisionsAsync(waiter, pairs, cancellation.Token);
        Exception? primaryFailure = null;
        try
        {
            await ObserveBlockedCommandAsync(connectionString, pid, read, cancellation.Token);
            pairs[0] = (int.MaxValue, long.MaxValue);
            await blocker.Ado.RollbackTranAsync();
            Assert.Equal(saved, Assert.Single(await read));
        }
        catch (Exception exception)
        {
            primaryFailure = exception;
            throw;
        }
        finally
        {
            await ReleaseBlockerAndDrainAsync(blocker, read, cancellation, primaryFailure);
        }
        await AssertCountsAsync(waiter, 1, 1);
    }

    private static async Task ReleaseBlockerAndDrainAsync(
        SqlSugarClient blocker, Task read, CancellationTokenSource cancellation, Exception? primaryFailure)
    {
        var cleanupFailures = new List<Exception>();
        try
        {
            // Release this test's lock before awaiting pending work on the borrowed waiter.
            if (blocker.Ado.Transaction is not null)
            {
                await blocker.Ado.RollbackTranAsync();
            }
        }
        catch (Exception exception)
        {
            cleanupFailures.Add(exception);
        }
        finally
        {
            try
            {
                cancellation.Cancel();
            }
            catch (Exception exception)
            {
                cleanupFailures.Add(exception);
            }
            finally
            {
                // A rollback/cancellation error must not let using dispose a still-borrowed client.
                // Await real completion; do not substitute a timeout or detach the read task.
                try
                {
                    await read;
                }
                catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
                {
                }
                catch (Exception exception)
                {
                    cleanupFailures.Add(exception);
                }
            }
        }

        if (cleanupFailures.Count != 0)
        {
            // Keep the original assertion/operation failure and stack; retain every secondary
            // cleanup error for inspection instead of replacing the primary exception or hiding it.
            Exception failure = primaryFailure ?? cleanupFailures[0];
            failure.Data["ArticleRelationSourceCoordinateCleanupFailures"] = cleanupFailures
                .Where(exception => !ReferenceEquals(exception, failure)).ToArray();
            if (primaryFailure is null)
            {
                System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
            }
        }
    }

    private static async Task ObserveBlockedCommandAsync(string connectionString, int pid, Task operation, CancellationToken token)
    {
        await using var observer = new NpgsqlConnection(connectionString);
        await observer.OpenAsync(token);
        await using var command = new NpgsqlCommand("SELECT cardinality(pg_blocking_pids(@pid)) > 0;", observer);
        command.Parameters.AddWithValue("pid", pid);
        bool blocked = false;
        while (!blocked && !operation.IsCompleted)
        {
            blocked = (bool)(await command.ExecuteScalarAsync(token))!;
            if (!blocked)
            {
                await Task.Delay(10, token);
            }
        }
        Assert.True(blocked, "The exact batch command must be observed blocked on the task-owned table lock.");
    }

    private async Task<SqlSugarClient> CreateDatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        try
        {
            PostgresSqlSugarTestClient.InitTables(db, typeof(Article), typeof(ArticleRevision), typeof(ArticleDraft), typeof(ArticlePublicationRecord));
            await fixture.ExecuteAsync(db.CurrentConnectionConfig.ConnectionString,
                ArticleRelationSourceCoordinateMigrationDefinitions.Sql);
            return db;
        }
        catch
        {
            db.Dispose();
            throw;
        }
    }

    private static async Task<(int Article, long Revision)> CreateSourceAsync(SqlSugarClient db)
    {
        int article = await CreateArticleAsync(db);
        return (article, await CreateRevisionAsync(db, article, 1));
    }

    private static Task<int> CreateArticleAsync(SqlSugarClient db)
        => db.Insertable(new Article
        {
            Title = "task-owned coordinate fixture",
            CreateTime = Now,
            MetadataUpdatedAt = Now,
            Status = ArticleStatus.Draft,
            IsDeleted = false
        }).ExecuteReturnIdentityAsync();

    private static Task<long> CreateRevisionAsync(SqlSugarClient db, int article, int revisionNo)
        => db.Insertable(new ArticleRevision
        {
            ArticleId = article,
            RevisionNo = revisionNo,
            Title = "immutable fixture",
            DiffSummary = "module fixture",
            CreatedAt = Now
        }).ExecuteReturnBigIdentityAsync();

    private async Task<ArticleRelationRevisionCoordinate> ProvisionAndCommitAsync(SqlSugarClient db, int article, long revision)
    {
        await db.Ado.BeginTranAsync();
        try
        {
            ArticleRelationRevisionCoordinate result = await _authority.ProvisionRevisionAsync(db, article, revision);
            await db.Ado.CommitTranAsync();
            return result;
        }
        catch
        {
            await db.Ado.RollbackTranAsync();
            throw;
        }
    }

    private static async Task AssertCountsAsync(SqlSugarClient db, int articles, int sources)
    {
        Assert.Equal(articles, await db.Queryable<ArticleRelationArticleBinding>().CountAsync());
        Assert.Equal(sources, await db.Queryable<ArticleRelationSourceCoordinate>().CountAsync());
    }
}
