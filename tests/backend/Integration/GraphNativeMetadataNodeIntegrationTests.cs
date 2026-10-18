using System.Collections.Concurrent;
using System.Data;
using System.Diagnostics;
using System.Security.Claims;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.ArticleGraph;

using Microsoft.Extensions.Configuration;

using Npgsql;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class GraphNativeMetadataNodeIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    private static readonly AuthorArticlePinOwner s_owner = new(1, "primary-site");

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(64)]
    [InlineData(65)]
    [InlineData(1000)]
    public async Task NativeBatchesReadRealTitlesAndExactSourcesWithActualSqlAccounting(int count)
    {
        using SqlSugarClient db = await DatabaseAsync();
        var source = new TrapArticleSource();
        var consumer = new ArticleGraphNodeProjectionConsumer(db, new(), Permissions(db), source);
        using var trace = new Commands();
        long started = Stopwatch.GetTimestamp();
        ArticleGraphNodeProjectionConsumer.NodeRead? result = await consumer.ReadAsync(Request(count));
        if (result is null)
        {
            // The real 1000-candidate read may exhaust the unchanged admission allocation.
            // Require the actual deadline and bounded multi-batch work, with no returned facts.
            Assert.Equal(1000, count);
            Assert.True(Stopwatch.GetElapsedTime(started) >= TimeSpan.FromMilliseconds(240));
            Assert.InRange(trace.Sql.Count, 22, 672);
            Assert.DoesNotContain(trace.Sql, sql => sql.Contains("revision.article_id = @articleId", StringComparison.Ordinal));
            Assert.Equal(1, await db.Ado.GetIntAsync("SELECT 1"));
            return;
        }
        ArticleGraphNodeProjectionConsumer.NodeRead read = result;
        Assert.Equal(count, read.Nodes.Count);
        Assert.Equal(0, source.Calls);
        Assert.Equal(trace.Sql.Count, read.ReadOperations);
        Assert.All(read.Nodes, node =>
        {
            int id = Convert.ToInt32(node.ArticleIdentity[8..16], 16);
            Assert.Equal($"current synthetic {id}", node.Title);
            Assert.Equal($"revision:{id:x8}-2222-4222-8222-222222222222", node.RevisionIdentity);
        });
        int batches = Math.Max(1, (count + 63) / 64);
        Assert.Equal(count == 0 ? 20 : 42 * batches, read.ReadOperations);
        Assert.Equal(count == 0 ? 0 : 4 * batches,
            trace.Sql.Count(sql => sql.Contains("WITH ORDINALITY AS requested", StringComparison.Ordinal)));
        Assert.DoesNotContain(trace.Sql, sql => sql.Contains("revision.article_id = @articleId", StringComparison.Ordinal));
        Assert.Equal(ConnectionState.Open, db.Ado.Connection.State);
        bool verified = await consumer.VerifyAsync(read);
        if (count == 1000 && !verified)
        {
            Assert.True(Stopwatch.GetElapsedTime(started) >= TimeSpan.FromMilliseconds(240));
            Assert.Empty(read.Nodes);
        }
        else
        {
            Assert.True(verified);
            Assert.Equal(trace.Sql.Count, read.ReadOperations);
        }
        Assert.Equal(1, await db.Ado.GetIntAsync("SELECT 1"));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task NativeMetadataRetainsCallerTransactionPriorTokenAndCountsAtMost26(bool transaction)
    {
        using SqlSugarClient db = await DatabaseAsync();
        if (transaction)
        {
            await db.Ado.BeginTranAsync(IsolationLevel.ReadCommitted);
        }
        using var prior = new CancellationTokenSource();
        db.Ado.CancellationToken = prior.Token;
        IDbConnection connection = db.Ado.Connection;
        IDbTransaction? original = db.Ado.Transaction;
        try
        {
            var metadata = new SqlArticleGraphPersistedMetadataReader(db, new(), Permissions(db));
            using var trace = new Commands();
            ArticleGraphPersistedMetadataResult result = Assert.IsType<ArticleGraphPersistedMetadataResult>(
                await metadata.ReadAsync(Metadata(64)));
            Assert.Equal(21, result.ReadOperations);
            Assert.Equal(trace.Sql.Count, result.ReadOperations);
            Assert.True(result.ReadOperations <= 26);
            Assert.Equal(64, result.Facts.Count);
            Assert.All(result.Facts, fact =>
            {
                Assert.Equal(fact.ArticleId, fact.Source.RevisionId);
                Assert.Equal(1, fact.Source.RevisionNo);
                Assert.Equal($"revision:{fact.ArticleId:x8}-2222-4222-8222-222222222222", fact.Source.RevisionIdentity);
                Assert.Equal(Guid.Parse($"{fact.ArticleId:x8}-3333-4333-8333-333333333333"), fact.Source.SourceEpoch);
            });
            Assert.Equal("current synthetic 1", result.Facts[0].Title);
            Assert.Equal(new[] { 7, 9 }, result.Facts[0].TagIds);
            Assert.Same(connection, db.Ado.Connection);
            Assert.Same(original, db.Ado.Transaction);
            Assert.Equal(prior.Token, db.Ado.CancellationToken);
            Assert.Equal(1, await db.Ado.GetIntAsync("SELECT 1"));
        }
        finally
        {
            db.Ado.CancellationToken = null;
            if (transaction)
            {
                await db.Ado.RollbackTranAsync();
            }
        }
    }

    [Theory]
    [InlineData("title")]
    [InlineData("pointer")]
    [InlineData("category")]
    [InlineData("tags")]
    [InlineData("source")]
    [InlineData("permission")]
    [InlineData("grant-version")]
    public async Task TwoPassNativeReadsRejectRealPersistedDrift(string change)
    {
        using SqlSugarClient db = await DatabaseAsync();
        using SqlSugarClient worker = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        string update = ChangeSql(change);
        bool changed = false;
        using var trace = new Commands(sql =>
        {
            if (!changed && sql.Contains(change == "source" ? "WITH ORDINALITY AS requested" : "SELECT a.id, a.status", StringComparison.Ordinal))
            {
                changed = true;
                worker.Ado.ExecuteCommand(update);
            }
        });
        var metadata = new SqlArticleGraphPersistedMetadataReader(db, new(), Permissions(db));
        Assert.Null(await metadata.ReadAsync(Metadata(2)));
        Assert.True(changed);
        Assert.Equal(1, await db.Ado.GetIntAsync("SELECT 1"));
    }

    [Theory]
    [InlineData("title")]
    [InlineData("pointer")]
    [InlineData("category")]
    [InlineData("tags")]
    [InlineData("source")]
    [InlineData("permission")]
    [InlineData("grant-version")]
    public async Task NativeNodeVerificationInvalidatesAllStagedFactsOnDrift(string change)
    {
        using SqlSugarClient db = await DatabaseAsync();
        var consumer = new ArticleGraphNodeProjectionConsumer(db, new(), Permissions(db), new TrapArticleSource());
        ArticleGraphNodeProjectionConsumer.NodeRead read = Assert.IsType<ArticleGraphNodeProjectionConsumer.NodeRead>(
            await consumer.ReadAsync(Request(65)));
        string update = ChangeSql(change);
        await db.Ado.ExecuteCommandAsync(update);
        Assert.False(await consumer.VerifyAsync(read));
        Assert.Empty(read.Nodes);
    }

    [Theory]
    [InlineData("title")]
    [InlineData("pointer")]
    [InlineData("category")]
    [InlineData("tags")]
    [InlineData("source")]
    [InlineData("permission")]
    [InlineData("grant-version")]
    public async Task NativeCrossBatchSweepRejectsEarlierBatchDrift(string change)
    {
        using SqlSugarClient db = await DatabaseAsync();
        using SqlSugarClient worker = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        int metadataReads = 0;
        bool changed = false;
        using var trace = new Commands(sql =>
        {
            if (sql.Contains("SELECT a.id, a.status", StringComparison.Ordinal) && ++metadataReads == 3)
            {
                changed = true;
                worker.Ado.ExecuteCommand(ChangeSql(change));
            }
        });
        var consumer = new ArticleGraphNodeProjectionConsumer(db, new(), Permissions(db), new TrapArticleSource());
        Assert.Null(await consumer.ReadAsync(Request(65)));
        Assert.True(changed);
    }

    [Fact]
    public async Task DeniedBatchReadsNoMetadataAndUnsupportedScopesAndSuppliersDispatchNothing()
    {
        using SqlSugarClient db = await DatabaseAsync();
        var metadata = new SqlArticleGraphPersistedMetadataReader(db, new(), Permissions(db));
        await db.Ado.ExecuteCommandAsync("UPDATE article SET isdeleted = TRUE");
        using var trace = new Commands();
        ArticleGraphPersistedMetadataResult denied = Assert.IsType<ArticleGraphPersistedMetadataResult>(
            await metadata.ReadAsync(Metadata(64)));
        Assert.Empty(denied.Facts);
        Assert.DoesNotContain(trace.Sql, sql => sql.Contains("SELECT a.id, a.status", StringComparison.Ordinal)
            || sql.Contains("WITH ORDINALITY AS requested", StringComparison.Ordinal));
        using SqlSugarClient other = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        trace.Sql.Clear();
        Assert.Null(await metadata.ReadAsync(Metadata(65)));
        Assert.Empty(trace.Sql);
        var consumer = new ArticleGraphNodeProjectionConsumer(db, new(), Permissions(db), new TrapArticleSource());
        Assert.Null(await consumer.ReadAsync(Request(1) with
        {
            Scope = ArticleGraphScope.Published
        }));
        Assert.Null(await consumer.ReadAsync(Request(1) with
        {
            Filters = new(["7"], [], [ArticleGraphEdgeKind.Link])
        }));
        Assert.Null(await new SqlArticleGraphPersistedMetadataReader(other, new(), Permissions(db)).ReadAsync(Metadata(1)));
        Assert.Empty(trace.Sql);
    }

    [Theory]
    [InlineData("missing-source")]
    [InlineData("wrong-revision")]
    [InlineData("wrong-article")]
    [InlineData("title-limit")]
    [InlineData("tag-limit")]
    public async Task NativeExactSourceAndBoundedMetadataRefuseWithoutPartialFacts(string invalid)
    {
        using SqlSugarClient db = await DatabaseAsync();
        string update = invalid switch
        {
            "missing-source" => "DELETE FROM article_relation_source_coordinate WHERE article_id = 2",
            "wrong-revision" => "UPDATE article_relation_source_coordinate SET revision_id = 20001 WHERE article_id = 2",
            "wrong-article" => "UPDATE article_relation_article_binding SET portable_identity = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' WHERE article_id = 2",
            "title-limit" => "UPDATE article SET title = repeat('x',257) WHERE id = 2",
            _ => "INSERT INTO article_tag SELECT 2, id FROM generate_series(20,276) id"
        };
        await db.Ado.ExecuteCommandAsync(update);
        var metadata = new SqlArticleGraphPersistedMetadataReader(db, new(), Permissions(db));
        Assert.Null(await metadata.ReadAsync(Metadata(2)));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task NativeNodeRejectsCallerTransactionReplacementWithoutOwningItsLifecycle(bool initialTransaction)
    {
        using SqlSugarClient db = await DatabaseAsync();
        if (initialTransaction)
        {
            await db.Ado.BeginTranAsync(IsolationLevel.ReadCommitted);
        }
        var consumer = new ArticleGraphNodeProjectionConsumer(db, new(), Permissions(db), new TrapArticleSource());
        ArticleGraphNodeProjectionConsumer.NodeRead read = Assert.IsType<ArticleGraphNodeProjectionConsumer.NodeRead>(
            await consumer.ReadAsync(Request(1)));
        if (initialTransaction)
        {
            await db.Ado.RollbackTranAsync();
        }
        await db.Ado.BeginTranAsync(IsolationLevel.ReadCommitted);
        IDbTransaction replacement = db.Ado.Transaction;
        try
        {
            using var trace = new Commands();
            Assert.False(await consumer.VerifyAsync(read));
            Assert.Empty(read.Nodes);
            Assert.Empty(trace.Sql);
            Assert.Same(replacement, db.Ado.Transaction);
            Assert.Equal(1, await db.Ado.GetIntAsync("SELECT 1"));
        }
        finally
        {
            await db.Ado.RollbackTranAsync();
        }
    }

    [Theory]
    [InlineData(IsolationLevel.RepeatableRead)]
    [InlineData(IsolationLevel.Serializable)]
    public async Task NativeSnapshotTransactionsRefuseBeforeAnySql(IsolationLevel isolation)
    {
        using SqlSugarClient db = await DatabaseAsync();
        await db.Ado.BeginTranAsync(isolation);
        try
        {
            using var trace = new Commands();
            Assert.Null(await new SqlArticleGraphPersistedMetadataReader(db, new(), Permissions(db)).ReadAsync(Metadata(1)));
            Assert.Empty(trace.Sql);
        }
        finally
        {
            await db.Ado.RollbackTranAsync();
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task NativeReaderCompletionBarrierRejectsLateFactsAndAwaitsCleanup(bool cancelCaller)
    {
        using SqlSugarClient db = await DatabaseAsync();
        using var caller = new CancellationTokenSource();
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        bool held = false;
        using var trace = new Commands(sql =>
        {
            if (!held && sql.Contains("SELECT a.id, a.status", StringComparison.Ordinal))
            {
                held = true;
                started.TrySetResult();
                release.Task.GetAwaiter().GetResult();
            }
        });
        var metadata = new SqlArticleGraphPersistedMetadataReader(db, new(), Permissions(db));
        Task<ArticleGraphPersistedMetadataResult?> pending = Task.Run(() => metadata.ReadAsync(Metadata(1), caller.Token));
        try
        {
            await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
            if (cancelCaller)
            {
                caller.Cancel();
            }
            await Task.Delay(300);
            Assert.False(pending.IsCompleted);
        }
        finally
        {
            release.TrySetResult();
            if (cancelCaller)
            {
                await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending);
            }
            else
            {
                Assert.Null(await pending);
            }
        }
        Assert.DoesNotContain(trace.Sql, sql => sql.Contains("WITH ORDINALITY AS requested", StringComparison.Ordinal));
        Assert.Equal(1, await db.Ado.GetIntAsync("SELECT 1"));
    }

    [Theory]
    [InlineData("request", false, "admin_principal")]
    [InlineData("request", true, "admin_principal")]
    [InlineData("prior", false, "article_tag")]
    [InlineData("prior", true, "article_tag")]
    [InlineData("deadline", false, "article_relation_source_coordinate")]
    [InlineData("deadline", true, "article_relation_source_coordinate")]
    public async Task NativeLockCancellationAwaitsCompletionAndLeavesCallerOwnership(
        string cancellation, bool transaction, string table)
    {
        using SqlSugarClient db = await DatabaseAsync();
        if (transaction)
        {
            await db.Ado.BeginTranAsync(IsolationLevel.ReadCommitted);
        }
        var connection = Assert.IsType<NpgsqlConnection>(db.Ado.Connection);
        IDbTransaction? original = db.Ado.Transaction;
        await using var blocker = new NpgsqlConnection(db.CurrentConnectionConfig.ConnectionString);
        await blocker.OpenAsync();
        await using NpgsqlTransaction block = await blocker.BeginTransactionAsync();
        await using (var command = new NpgsqlCommand($"LOCK TABLE {table} IN ACCESS EXCLUSIVE MODE", blocker, block))
        {
            await command.ExecuteNonQueryAsync();
        }
        using var caller = new CancellationTokenSource();
        using var prior = new CancellationTokenSource();
        db.Ado.CancellationToken = prior.Token;
        Task<ArticleGraphPersistedMetadataResult?>? pending = null;
        try
        {
            var metadata = new SqlArticleGraphPersistedMetadataReader(db, new(), Permissions(db));
            pending = metadata.ReadAsync(Metadata(1), caller.Token);
            await using var observer = new NpgsqlConnection(db.CurrentConnectionConfig.ConnectionString);
            await observer.OpenAsync();
            bool blocked = false;
            for (int attempt = 0; attempt < 100 && !pending.IsCompleted; attempt++)
            {
                await using var command = new NpgsqlCommand(
                    "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = @pid AND wait_event_type = 'Lock')", observer);
                command.Parameters.AddWithValue("pid", connection.ProcessID);
                if (await command.ExecuteScalarAsync() is true)
                {
                    blocked = true;
                    break;
                }
                await Task.Delay(2);
            }
            Assert.True(blocked, "The real borrowed command must be observed waiting on the task-owned lock.");
            if (cancellation == "request")
            {
                caller.Cancel();
            }
            else if (cancellation == "prior")
            {
                prior.Cancel();
            }
            if (cancellation == "deadline")
            {
                Assert.Null(await pending);
            }
            else
            {
                await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending);
            }
            Assert.Same(connection, db.Ado.Connection);
            Assert.Same(original, db.Ado.Transaction);
            Assert.Equal(prior.Token, db.Ado.CancellationToken);
        }
        finally
        {
            // Release the independently owned blocker, request cancellation, and await the
            // borrowed read independently. Never dispose the caller while SQL is pending.
            try
            {
                await block.RollbackAsync();
            }
            finally
            {
                caller.Cancel();
                try
                {
                    if (pending is not null)
                    {
                        try
                        {
                            await pending;
                        }
                        catch (OperationCanceledException)
                        {
                        }
                    }
                }
                finally
                {
                    db.Ado.CancellationToken = null;
                    if (transaction)
                    {
                        await db.Ado.RollbackTranAsync();
                    }
                }
            }
        }
        Assert.Equal(1, await db.Ado.GetIntAsync("SELECT 1"));
    }

    private static string ChangeSql(string change)
        => change switch
        {
            "title" => "UPDATE article SET title = 'changed synthetic title' WHERE id = 1",
            "pointer" => "UPDATE article SET current_revision_id = 10001 WHERE id = 1",
            "category" => "UPDATE article SET categoryid = 8 WHERE id = 1",
            "tags" => "UPDATE article_tag SET tagid = 10 WHERE articleid = 1 AND tagid = 9",
            "source" => "UPDATE article_relation_source_coordinate SET source_epoch = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' WHERE article_id = 1",
            "grant-version" => "UPDATE admin_principal SET permissions = 'article.write' || chr(10) || 'tag.write'",
            _ => "UPDATE admin_session SET revokedatutc = TIMESTAMP '2026-01-01'"
        };

    private static ArticleGraphNodeReadRequest Request(int count)
        => new(s_owner, Guid.NewGuid(), Candidates(count), ArticleGraphScope.CurrentEditable,
            new([], [], [ArticleGraphEdgeKind.Link]), 4096, 250);

    private static ArticleGraphPersistedMetadataRequest Metadata(int count)
        => new(s_owner, Guid.NewGuid(), Candidates(count), ArticleGraphMetadataSelection.Current, 26, 250);

    private static ArticleRelationArticleCoordinate[] Candidates(int count)
        => Enumerable.Range(1, count).Select(id => new ArticleRelationArticleCoordinate(id,
            $"article:{id:x8}-1111-4111-8111-111111111111")).ToArray();

    private static SqlAuthorArticlePinPermissionAuthority Permissions(ISqlSugarClient db)
    {
        var identity = new ClaimsIdentity([
            new Claim("identity_kind", "admin_principal"), new Claim("admin_id", "1"),
            new Claim("admin_sid", "synthetic-session"),
            new Claim(AdminPermissions.PermissionClaimType, AdminPermissions.ArticleWrite)], "test");
        return new(db, new HttpContextAccessor { HttpContext = new DefaultHttpContext { User = new(identity) } },
            new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["SITE_BASEURL"] = "primary-site" }).Build(),
            TimeProvider.System);
    }

    private async Task<SqlSugarClient> DatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        try
        {
            await db.Ado.ExecuteCommandAsync("""
                CREATE TABLE admin_principal(id bigint PRIMARY KEY, status text NOT NULL, isroot boolean NOT NULL, permissions text NOT NULL);
                INSERT INTO admin_principal VALUES (1, 'active', FALSE, 'article.write');
                CREATE TABLE admin_session(sessionid text PRIMARY KEY, adminprincipalid bigint, revokedatutc timestamp,
                    idleexpiresatutc timestamp NOT NULL, absoluteexpiresatutc timestamp NOT NULL);
                INSERT INTO admin_session VALUES ('synthetic-session', 1, NULL, TIMESTAMP '2099-01-01', TIMESTAMP '2099-01-02');
                CREATE TABLE article(id integer PRIMARY KEY, title text NOT NULL, status integer NOT NULL, isdeleted boolean NOT NULL,
                    current_revision_id bigint, current_publication_id bigint, categoryid integer NOT NULL);
                CREATE TABLE article_revision(id bigint PRIMARY KEY, article_id integer NOT NULL, revision_no integer NOT NULL,
                    categoryid integer NOT NULL DEFAULT 7, tag_ids text NOT NULL DEFAULT '7,9');
                CREATE TABLE article_publication(id bigint PRIMARY KEY, article_id integer, publication_no integer, article_revision_id bigint, revision_no integer);
                CREATE TABLE article_tag(articleid integer, tagid integer, PRIMARY KEY(articleid, tagid));
                CREATE TABLE article_relation_article_binding(article_id integer PRIMARY KEY, portable_identity uuid NOT NULL);
                CREATE TABLE article_relation_source_coordinate(article_id integer, revision_id bigint PRIMARY KEY, revision_identity uuid NOT NULL, source_epoch uuid NOT NULL);
                INSERT INTO article SELECT id, 'current synthetic ' || id, 0, FALSE, id, NULL, 7 FROM generate_series(1,1000) id;
                INSERT INTO article_revision SELECT id, id, 1, 7, '7,9' FROM generate_series(1,1000) id;
                INSERT INTO article_revision VALUES (10001,1,2,7,'7,9');
                INSERT INTO article_tag SELECT id, tag FROM generate_series(1,1000) id CROSS JOIN (VALUES (7),(9)) tags(tag);
                INSERT INTO article_relation_article_binding SELECT id, (lpad(to_hex(id),8,'0') || '-1111-4111-8111-111111111111')::uuid FROM generate_series(1,1000) id;
                INSERT INTO article_relation_source_coordinate VALUES (1, 10001, '00002711-2222-4222-8222-222222222222', '00002711-3333-4333-8333-333333333333');
                INSERT INTO article_relation_source_coordinate SELECT id, id,
                    (lpad(to_hex(id),8,'0') || '-2222-4222-8222-222222222222')::uuid,
                    (lpad(to_hex(id),8,'0') || '-3333-4333-8333-333333333333')::uuid FROM generate_series(1,1000) id;
                """);
            db.CurrentConnectionConfig.IsAutoCloseConnection = false;
            await db.Ado.OpenAsync();
            // Warm the original supplier and command path outside the admission allocation.
            await Permissions(db).ResolveAsync(new(s_owner, Guid.NewGuid(), [1]));
            return db;
        }
        catch
        {
            db.Dispose();
            throw;
        }
    }

    private sealed class TrapArticleSource : IAuthorArticlePinArticleProjectionSource
    {
        internal int Calls
        {
            get; private set;
        }
        public Task<IReadOnlyList<AuthorArticlePinArticleFact>> ReadCurrentBatchAsync(IReadOnlyList<int> articleIds,
            CancellationToken cancellationToken = default)
        {
            Calls++;
            throw new InvalidOperationException("The native node must use persisted metadata, never the old Pin title projection.");
        }
    }

    private sealed class Commands : IDisposable
    {
        private readonly ActivityListener _listener;
        internal ConcurrentQueue<string> Sql { get; } = new();

        internal Commands(Action<string>? stopped = null)
        {
            _listener = new ActivityListener
            {
                ShouldListenTo = static source => source.Name == "Npgsql",
                Sample = static (ref ActivityCreationOptions<ActivityContext> _) => ActivitySamplingResult.AllData,
                ActivityStopped = activity =>
                {
                    string? sql = activity.GetTagItem("db.query.text") as string ?? activity.GetTagItem("db.statement") as string;
                    if (sql is not null)
                    {
                        Sql.Enqueue(sql);
                        stopped?.Invoke(sql);
                    }
                }
            };
            ActivitySource.AddActivityListener(_listener);
        }

        public void Dispose() => _listener.Dispose();
    }
}
