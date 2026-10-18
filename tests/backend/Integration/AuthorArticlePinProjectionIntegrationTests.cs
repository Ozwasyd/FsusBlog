using System.Collections;
using System.Runtime.ExceptionServices;
using System.Security.Claims;

using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.Configuration;

using Npgsql;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class AuthorArticlePinProjectionIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    private static readonly AuthorArticlePinOwner s_owner = new(1, "primary-site");

    [Fact]
    public async Task Projection_ConsumesRealPinArticleAndRevisionFactsAndInvalidatesOnCurrentRevisionChange()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        SqlAuthorArticlePinPermissionAuthority permissions = CreatePermissionAuthority(db);
        await Assert.ThrowsAsync<AuthorArticlePinAccessDeniedException>(() =>
            permissions.AuthorizeAsync(s_owner, []));
        var pins = new AuthorArticlePinStore(db, TimeProvider.System, permissions);
        long revision = 0;
        for (int articleId = 1; articleId <= 4; articleId++)
        {
            revision = (await pins.AddAsync(new AddAuthorArticlePinCommand(
                s_owner,
                articleId,
                revision,
                Guid.CreateVersion7()))).Revision;
        }
        await db.Ado.ExecuteCommandAsync(
            """
            UPDATE article SET status = 4, isdeleted = TRUE WHERE id = 3;
            DELETE FROM article WHERE id = 4;
            """);

        var articleFacts = new RecordingArticleSource(new SqlAuthorArticlePinArticleProjectionSource(db));
        var reconciliation = new RecordingReconciliationSink();
        var service = new AuthorArticlePinProjectionService(
            pins,
            permissions,
            articleFacts,
            new DirectAuthorArticlePinProjectionCache(),
            reconciliation,
            TimeProvider.System);
        AuthorArticlePinProjectionRequest request = new(s_owner, Guid.CreateVersion7());

        AuthorArticlePinProjectionPage initial = await service.ReadAsync(request);

        Assert.Equal(AuthorArticlePinProjectionStatus.Current, initial.Status);
        Assert.Equal(new[] { 1, 2 }, initial.Items.Select(static item => item.ArticleId));
        Assert.Equal(ArticleStatus.Archived, initial.Items[1].Status);
        Assert.Equal(new[] { 3, 4 }, reconciliation.Obligations.Select(static item => item.ArticleId));
        Assert.Equal(new[] { "article-deleted", "article-missing" }, reconciliation.Obligations.Select(static item => item.ReasonCode));
        Assert.Equal(new[] { 1, 2, 3, 4 }, Assert.Single(articleFacts.Requests));
        AuthorArticlePinCollectionSnapshot collection = await pins.GetAuthoritySnapshotAsync(s_owner);
        AuthorArticlePinProjectionVerificationResult verified = AuthorArticlePinProjectionVerifier.Verify(
            new AuthorArticlePinProjectionVerificationInput(
                collection,
                await permissions.ResolveAsync(new AuthorArticlePinPermissionBatchRequest(
                    s_owner,
                    request.RequestId,
                    [1, 2, 3, 4])),
                articleFacts.LastFacts,
                request,
                initial,
                ClosedRemovals: reconciliation.Obligations));
        Assert.True(verified.Valid, string.Join(',', verified.Reasons));

        await db.Ado.ExecuteCommandAsync(
            "UPDATE article SET views = views + 100 WHERE id = 1;");
        AuthorArticlePinProjectionPage viewsChanged = await service.ReadAsync(request with
        {
            RequestId = Guid.CreateVersion7()
        });
        Assert.Equal(AuthorArticlePinProjectionStatus.Current, viewsChanged.Status);
        Assert.Equal(initial.ArticleProjectionDigest, viewsChanged.ArticleProjectionDigest);
        Assert.Equal(initial.CacheReference, viewsChanged.CacheReference);
        Assert.Equal(initial.Items, viewsChanged.Items);

        await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO article_revision(id, article_id, revision_no) VALUES (11, 1, 2);
            UPDATE article SET title = 'renamed without identity change', current_revision_id = 11 WHERE id = 1;
            """);
        AuthorArticlePinProjectionPage changed = await service.ReadAsync(request with
        {
            RequestId = Guid.CreateVersion7(),
            ExpectedCollectionRevision = initial.CollectionRevision,
            ExpectedArticleProjectionDigest = initial.ArticleProjectionDigest,
            ExpectedPermissionRevision = initial.PermissionRevision,
            ExpectedSiteRevision = initial.SiteRevision,
            ExpectedSessionRevision = initial.SessionRevision
        });

        Assert.Equal(AuthorArticlePinProjectionStatus.Stale, changed.Status);
        Assert.Contains("article_projection_stale", changed.StaleReasons);
        Assert.Equal(1, changed.Items[0].ArticleId);
        Assert.Equal("renamed without identity change", changed.Items[0].Title);
        Assert.Equal(11, changed.Items[0].CurrentRevisionId);
        Assert.NotEqual(initial.CacheReference, changed.CacheReference);

        await db.Ado.ExecuteCommandAsync(
            "UPDATE article SET current_revision_id = 20 WHERE id = 1;");
        AuthorArticlePinProjectionPage crossArticleRevision = await service.ReadAsync(request with
        {
            RequestId = Guid.CreateVersion7()
        });
        Assert.Equal(AuthorArticlePinProjectionStatus.Unavailable, crossArticleRevision.Status);
        Assert.Contains("article_pin_article_projection_invalid", crossArticleRevision.StaleReasons);

        await db.Ado.ExecuteCommandAsync(
            "UPDATE article SET current_revision_id = 11 WHERE id = 1;");
        var reconcilingService = new AuthorArticlePinProjectionService(
            pins,
            permissions,
            new SqlAuthorArticlePinArticleProjectionSource(db),
            new DirectAuthorArticlePinProjectionCache(),
            new AuthorArticlePinReconciliationSink(pins),
            TimeProvider.System);
        AuthorArticlePinProjectionPage reconciled = await reconcilingService.ReadAsync(request with
        {
            RequestId = Guid.CreateVersion7()
        });
        Assert.Equal(AuthorArticlePinProjectionStatus.Current, reconciled.Status);
        Assert.Equal(new[] { 1, 2 }, (await pins.GetAuthoritySnapshotAsync(s_owner))
            .Pins.Select(static pin => pin.ArticleId));

        int articleReadsBeforeRevocation = articleFacts.Requests.Count;
        await db.Ado.ExecuteCommandAsync(
            "UPDATE admin_session SET revokedatutc = CURRENT_TIMESTAMP WHERE sessionid = 'pin-session';");
        AuthorArticlePinProjectionPage revoked = await service.ReadAsync(request with
        {
            RequestId = Guid.CreateVersion7()
        });
        Assert.Equal(AuthorArticlePinProjectionStatus.Unavailable, revoked.Status);
        Assert.Contains("article_pin_permission_authority_unavailable", revoked.StaleReasons);
        Assert.Equal(articleReadsBeforeRevocation, articleFacts.Requests.Count);

        await db.Ado.ExecuteCommandAsync(
            "UPDATE admin_session SET revokedatutc = NULL WHERE sessionid = 'pin-session';");
        AuthorArticlePinPermissionSnapshot movedSite = await CreatePermissionAuthority(db, "moved-site")
            .ResolveAsync(new AuthorArticlePinPermissionBatchRequest(
                s_owner,
                Guid.CreateVersion7(),
                [1]));
        Assert.Equal(AuthorArticlePinPermissionSnapshotStatus.Unavailable, movedSite.Status);

        AuthorArticlePinPermissionSnapshot wrongOwner = await permissions.ResolveAsync(
            new AuthorArticlePinPermissionBatchRequest(
                new AuthorArticlePinOwner(2, s_owner.SiteScope),
                Guid.CreateVersion7(),
                [1]));
        Assert.Equal(AuthorArticlePinPermissionSnapshotStatus.Unavailable, wrongOwner.Status);

        await db.Ado.ExecuteCommandAsync(
            "UPDATE admin_principal SET permissions = '' WHERE id = 1;");
        AuthorArticlePinPermissionSnapshot permissionRemoved = await permissions.ResolveAsync(
            new AuthorArticlePinPermissionBatchRequest(
                s_owner,
                Guid.CreateVersion7(),
                [1]));
        Assert.Equal(AuthorArticlePinPermissionSnapshotStatus.Unavailable, permissionRemoved.Status);
    }

    [Fact]
    public async Task ArticleSource_ResolvesOneThousandStableIdentitiesInOnePostgresBatch()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO article_revision(id, article_id, revision_no)
            SELECT 10000 + article_id, article_id, 1
            FROM generate_series(5, 1000) AS generated(article_id);
            INSERT INTO article(id, title, status, isdeleted, current_revision_id)
            SELECT article_id,
                   concat('title-', article_id::text),
                   2,
                   FALSE,
                   10000 + article_id
            FROM generate_series(5, 1000) AS generated(article_id);
            """);
        int[] articleIds = Enumerable.Range(1, AuthorArticlePinContract.MaxPinsPerOwner).ToArray();
        var source = new RecordingArticleSource(new SqlAuthorArticlePinArticleProjectionSource(db));

        IReadOnlyList<AuthorArticlePinArticleFact> facts = await source.ReadCurrentBatchAsync(articleIds);

        Assert.Equal(AuthorArticlePinContract.MaxPinsPerOwner, facts.Count);
        Assert.Equal(articleIds, facts.Select(static fact => fact.ArticleId));
        Assert.Equal(articleIds, Assert.Single(source.Requests));
        Assert.All(facts, static fact =>
        {
            Assert.True(fact.Exists);
            Assert.False(fact.IsDeleted);
            Assert.True(fact.CurrentRevisionId > 0);
            Assert.Equal(1, fact.RevisionNo);
            Assert.Equal(
                AuthorArticlePinProjectionContract.ComputeArticleFactDigest(fact),
                fact.ContentDigest);
        });
    }

    private async Task AssertBoundedPermissionInputAsync(int count, bool priorToken, bool callerTransaction)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        if (count > 0)
        {
            await db.Ado.ExecuteCommandAsync(
                """
                INSERT INTO article_revision(id, article_id, revision_no)
                SELECT 10000 + article_id, article_id, 1
                FROM generate_series(5, 1000) AS generated(article_id);
                INSERT INTO article(id, title, status, isdeleted, current_revision_id)
                SELECT article_id, concat('title-', article_id::text), 2, FALSE, 10000 + article_id
                FROM generate_series(5, 1000) AS generated(article_id);
                """);
        }
        db.CurrentConnectionConfig.IsAutoCloseConnection = false;
        await db.Ado.OpenAsync();
        if (callerTransaction)
        {
            await db.Ado.BeginTranAsync(System.Data.IsolationLevel.ReadCommitted);
        }
        var connection = db.Ado.Connection;
        var transaction = db.Ado.Transaction;
        using var previous = new CancellationTokenSource();
        CancellationToken? before = priorToken ? previous.Token : null;
        db.Ado.CancellationToken = before;
        int[] values = Enumerable.Range(1, count).ToArray();
        var input = new PermissionInputList(values);
        int commands = 0;
        db.Ado.IsEnableLogEvent = true;
        db.Aop.OnLogExecuting = (_, _) =>
        {
            commands++;
            // The permission read must use the captured identities even if the caller changes later.
            Array.Fill(values, -1);
        };
        try
        {
            AuthorArticlePinPermissionSnapshot result = await CreatePermissionAuthority(db).ResolveAsync(
                new(s_owner, Guid.CreateVersion7(), input));

            Assert.Equal(AuthorArticlePinPermissionSnapshotStatus.Current, result.Status);
            Assert.Equal(Enumerable.Range(1, count), result.Decisions.Select(static decision => decision.ArticleId));
            Assert.All(result.Decisions, static decision => Assert.True(decision.CanProject && decision.CanOpen));
            Assert.Equal(AuthorArticlePinProjectionContract.ComputePermissionDigest(result), result.ContentDigest);
            Assert.Equal(count == 0 ? 1 : 2, commands);
            Assert.Equal(count * 2, input.IndexReads);
            Assert.Equal(0, input.EnumeratorCalls);
            Assert.Equal(before, db.Ado.CancellationToken);
            Assert.Same(connection, db.Ado.Connection);
            Assert.Same(transaction, db.Ado.Transaction);

            db.Aop.OnLogExecuting = null;
            await db.Ado.ExecuteCommandAsync(
                "UPDATE admin_session SET revokedatutc = CURRENT_TIMESTAMP WHERE sessionid = 'pin-session';");
            AuthorArticlePinPermissionSnapshot denied = await CreatePermissionAuthority(db).ResolveAsync(
                new(s_owner, Guid.CreateVersion7(), Enumerable.Range(1, count).ToArray()));
            Assert.Equal(AuthorArticlePinPermissionSnapshotStatus.Unavailable, denied.Status);
            Assert.Equal("article_pin_permission_session_denied", denied.ReasonCode);
            Assert.Equal(before, db.Ado.CancellationToken);
            Assert.Same(transaction, db.Ado.Transaction);
            Assert.Equal(1, await db.Ado.GetIntAsync("SELECT 1;"));
        }
        finally
        {
            db.Aop.OnLogExecuting = null;
            db.Ado.CancellationToken = null;
            if (callerTransaction)
            {
                await db.Ado.RollbackTranAsync();
            }
        }
    }

    private async Task AssertInvalidPermissionInputAsync(bool replaceIdentities)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        await db.Ado.BeginTranAsync(System.Data.IsolationLevel.ReadCommitted);
        var connection = db.Ado.Connection;
        var transaction = db.Ado.Transaction;
        using var previous = new CancellationTokenSource();
        db.Ado.CancellationToken = previous.Token;
        var input = new PermissionInputList(
            Enumerable.Range(1, replaceIdentities ? 2 : 1001).ToArray(), replaceIdentities);
        int commands = 0;
        db.Ado.IsEnableLogEvent = true;
        db.Aop.OnLogExecuting = (_, _) => commands++;
        try
        {
            AuthorArticlePinPermissionSnapshot result = await CreatePermissionAuthority(db).ResolveAsync(
                new(s_owner, Guid.CreateVersion7(), input));

            Assert.Equal(AuthorArticlePinPermissionSnapshotStatus.Unavailable, result.Status);
            Assert.Equal("article_pin_permission_request_invalid", result.ReasonCode);
            Assert.Empty(result.Decisions);
            Assert.Equal(0, commands);
            Assert.Equal(replaceIdentities ? 3 : 0, input.IndexReads);
            Assert.Equal(0, input.EnumeratorCalls);
            Assert.Equal(previous.Token, db.Ado.CancellationToken);
            Assert.Same(connection, db.Ado.Connection);
            Assert.Same(transaction, db.Ado.Transaction);
        }
        finally
        {
            db.Aop.OnLogExecuting = null;
            db.Ado.CancellationToken = null;
            await db.Ado.RollbackTranAsync();
        }
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task PermissionAuthority_RestoresAdoCancellationAndCallerTransactionAfterSuccess(
        bool priorToken, bool callerTransaction)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        using var previous = new CancellationTokenSource();
        db.CurrentConnectionConfig.IsAutoCloseConnection = false;
        await db.Ado.OpenAsync();
        if (callerTransaction)
        {
            await db.Ado.BeginTranAsync(System.Data.IsolationLevel.ReadCommitted);
        }
        var connection = db.Ado.Connection;
        var transaction = db.Ado.Transaction;
        CancellationToken? before = priorToken ? previous.Token : null;
        db.Ado.CancellationToken = before;
        try
        {
            AuthorArticlePinPermissionSnapshot result = await CreatePermissionAuthority(db).ResolveAsync(
                new(s_owner, Guid.CreateVersion7(), [1, 2]));
            Assert.Equal(AuthorArticlePinPermissionSnapshotStatus.Current, result.Status);
            Assert.Equal(2, result.Decisions.Count);
            Assert.All(result.Decisions, static decision => Assert.True(decision.CanProject && decision.CanOpen));
            Assert.Equal(before, db.Ado.CancellationToken);
            Assert.Same(connection, db.Ado.Connection);
            Assert.Same(transaction, db.Ado.Transaction);
            Assert.Equal(1, await db.Ado.GetIntAsync("SELECT 1;"));
        }
        finally
        {
            db.Ado.CancellationToken = null;
            if (callerTransaction)
            {
                await db.Ado.RollbackTranAsync();
            }
        }
        foreach (int count in new[] { 0, AuthorArticlePinContract.MaxPinsPerOwner })
        {
            await AssertBoundedPermissionInputAsync(count, priorToken, callerTransaction);
        }
        await AssertInvalidPermissionInputAsync(replaceIdentities: false);
        await AssertInvalidPermissionInputAsync(replaceIdentities: true);
    }

    [Theory]
    [InlineData("admin_principal", false, false)]
    [InlineData("admin_principal", true, false)]
    [InlineData("admin_principal", false, true)]
    [InlineData("admin_principal", true, true)]
    [InlineData("article", false, false)]
    [InlineData("article", true, false)]
    [InlineData("article", false, true)]
    [InlineData("article", true, true)]
    public async Task PermissionAuthority_CancelsActualBlockedCommandAndAwaitsCompletion(
        string table, bool cancelPriorToken, bool callerTransaction)
    {
        Assert.Contains(table, new[] { "admin_principal", "article" });
        using SqlSugarClient db = await CreateDatabaseAsync();
        db.CurrentConnectionConfig.IsAutoCloseConnection = false;
        await db.Ado.OpenAsync();
        if (callerTransaction)
        {
            await db.Ado.BeginTranAsync(System.Data.IsolationLevel.ReadCommitted);
        }
        NpgsqlConnection native = Assert.IsType<NpgsqlConnection>(db.Ado.Connection);
        var transaction = db.Ado.Transaction;
        // The original client configuration retains the fixture's credentials and temporal options.
        string testConnectionString = db.CurrentConnectionConfig.ConnectionString;
        var blocker = new NpgsqlConnection(testConnectionString);
        var observer = new NpgsqlConnection(testConnectionString);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var prior = new CancellationTokenSource();
        using var requested = new CancellationTokenSource();
        NpgsqlTransaction? blockingTransaction = null;
        Task<AuthorArticlePinPermissionSnapshot>? pending = null;
        ExceptionDispatchInfo? failure = null;
        var cleanupFailureTypes = new List<string>();
        try
        {
            await blocker.OpenAsync(deadline.Token);
            await observer.OpenAsync(deadline.Token);
            blockingTransaction = await blocker.BeginTransactionAsync(deadline.Token);
            await using (var command = new NpgsqlCommand($"LOCK TABLE {table} IN ACCESS EXCLUSIVE MODE;", blocker, blockingTransaction))
            {
                await command.ExecuteNonQueryAsync(deadline.Token);
            }
            db.Ado.CancellationToken = prior.Token;
            pending = CreatePermissionAuthority(db).ResolveAsync(
                new(s_owner, Guid.CreateVersion7(), [1]), requested.Token);
            while (!await IsWaitingForLockAsync(observer, native.ProcessID, deadline.Token))
            {
                Assert.False(pending.IsCompleted, "The original SQL command must actually reach the held relation lock.");
                await Task.Delay(10, deadline.Token);
            }
            (cancelPriorToken ? prior : requested).Cancel();
            while (!pending.IsCompleted)
            {
                await Task.Delay(10, deadline.Token);
            }
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending);
            Assert.False(await IsWaitingForLockAsync(observer, native.ProcessID, deadline.Token));
            Assert.Equal(prior.Token, db.Ado.CancellationToken);
            Assert.Same(native, db.Ado.Connection);
            Assert.Same(transaction, db.Ado.Transaction);
            if (!callerTransaction)
            {
                db.Ado.CancellationToken = null;
                Assert.Equal(1, await db.Ado.GetIntAsync("SELECT 1;"));
            }
        }
        catch (Exception error)
        {
            failure = ExceptionDispatchInfo.Capture(error);
        }
        finally
        {
            await CompleteCleanupAsync(() =>
            {
                prior.Cancel();
                return Task.CompletedTask;
            });
            await CompleteCleanupAsync(() =>
            {
                requested.Cancel();
                return Task.CompletedTask;
            });
            using var cleanupDeadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            if (blockingTransaction is not null)
            {
                await CompleteCleanupAsync(() => blockingTransaction.RollbackAsync(cleanupDeadline.Token));
            }
            // Closing only the test-owned blocker also releases its lock if rollback failed.
            await CompleteCleanupAsync(() => blocker.CloseAsync());
            if (pending is not null)
            {
                // Await the actual SQL task even when earlier cleanup failed; never abandon the borrowed client.
                await CompleteCleanupAsync(async () =>
                {
                    await pending;
                }, ignoreCancellation: true);
            }
            await CompleteCleanupAsync(() =>
            {
                db.Ado.CancellationToken = null;
                return Task.CompletedTask;
            });
            if (callerTransaction)
            {
                await CompleteCleanupAsync(() => db.Ado.RollbackTranAsync());
            }
            if (blockingTransaction is not null)
            {
                await CompleteCleanupAsync(() => blockingTransaction.DisposeAsync().AsTask());
            }
            await CompleteCleanupAsync(() => observer.DisposeAsync().AsTask());
            await CompleteCleanupAsync(() => blocker.DisposeAsync().AsTask());
        }
        if (failure is not null && cleanupFailureTypes.Count > 0)
        {
            failure.SourceException.Data["PermissionCleanupFailureTypes"] = cleanupFailureTypes.ToArray();
        }
        failure?.Throw();

        async Task CompleteCleanupAsync(Func<Task> cleanup, bool ignoreCancellation = false)
        {
            try
            {
                await cleanup();
            }
            catch (OperationCanceledException) when (ignoreCancellation)
            {
            }
            catch (Exception error)
            {
                failure ??= ExceptionDispatchInfo.Capture(error);
                cleanupFailureTypes.Add(error.GetType().FullName ?? error.GetType().Name);
            }
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task PermissionAuthority_RestoresAdoCancellationAfterCommandFailure(bool priorToken)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        using var previous = new CancellationTokenSource();
        CancellationToken? before = priorToken ? previous.Token : null;
        db.Ado.CancellationToken = before;
        var connection = db.Ado.Connection;
        db.Ado.IsEnableLogEvent = true;
        db.Aop.OnLogExecuting = static (_, _) => throw new InvalidOperationException("permission-command-failure");
        await Assert.ThrowsAsync<InvalidOperationException>(() => CreatePermissionAuthority(db).ResolveAsync(
            new(s_owner, Guid.CreateVersion7(), [1])));
        Assert.Equal(before, db.Ado.CancellationToken);
        Assert.Same(connection, db.Ado.Connection);
        Assert.Null(db.Ado.Transaction);
        db.Aop.OnLogExecuting = null;
        db.Ado.CancellationToken = null;
        Assert.Equal(1, await db.Ado.GetIntAsync("SELECT 1;"));
    }

    private static async Task<bool> IsWaitingForLockAsync(
        NpgsqlConnection observer, int processId, CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand(
            "SELECT count(*) FROM pg_stat_activity WHERE pid = @Pid AND state = 'active' AND wait_event_type = 'Lock';", observer);
        command.Parameters.AddWithValue("Pid", processId);
        return (long)(await command.ExecuteScalarAsync(cancellationToken))! == 1;
    }

    private async Task<SqlSugarClient> CreateDatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        await db.Ado.ExecuteCommandAsync(
            """
            CREATE TABLE admin_principal(
                id bigint PRIMARY KEY,
                status varchar(32) NOT NULL,
                isroot boolean NOT NULL,
                permissions text NOT NULL);
            INSERT INTO admin_principal(id, status, isroot, permissions)
            VALUES (1, 'active', FALSE, 'article.write');
            CREATE TABLE admin_session(
                sessionid varchar(64) PRIMARY KEY,
                adminprincipalid bigint NOT NULL REFERENCES admin_principal(id),
                revokedatutc timestamp without time zone NULL,
                idleexpiresatutc timestamp without time zone NOT NULL,
                absoluteexpiresatutc timestamp without time zone NOT NULL);
            INSERT INTO admin_session(
                sessionid, adminprincipalid, revokedatutc, idleexpiresatutc, absoluteexpiresatutc)
            VALUES ('pin-session', 1, NULL, TIMESTAMP '2099-01-01', TIMESTAMP '2099-01-02');
            CREATE TABLE article_revision(
                id bigint PRIMARY KEY,
                article_id integer NOT NULL,
                revision_no integer NOT NULL);
            INSERT INTO article_revision(id, article_id, revision_no)
            VALUES (10, 1, 1), (20, 2, 1), (30, 3, 1), (40, 4, 1);
            CREATE TABLE article(
                id integer PRIMARY KEY,
                title varchar(256) NOT NULL,
                status integer NOT NULL,
                isdeleted boolean NOT NULL,
                views integer NOT NULL DEFAULT 0,
                current_revision_id bigint NULL REFERENCES article_revision(id));
            INSERT INTO article(id, title, status, isdeleted, current_revision_id)
            VALUES
                (1, 'active title', 2, FALSE, 10),
                (2, 'archived title', 3, FALSE, 20),
                (3, 'deleted title', 2, FALSE, 30),
                (4, 'missing title', 0, FALSE, 40);
            """);
        ISchemaMigrationDescriptor migration = AuthorArticlePinMigrationDefinitions.BuildMigration();
        foreach (SchemaMigrationStep step in migration.Steps)
        {
            await step.ExecuteAsync(db, CancellationToken.None);
        }
        return db;
    }

    private static SqlAuthorArticlePinPermissionAuthority CreatePermissionAuthority(
        ISqlSugarClient db,
        string siteScope = "primary-site")
    {
        var identity = new ClaimsIdentity(
        [
            new Claim("identity_kind", "admin_principal"),
            new Claim("admin_id", "1"),
            new Claim("admin_sid", "pin-session"),
            new Claim(AdminPermissions.PermissionClaimType, AdminPermissions.ArticleWrite)
        ],
        "test");
        var accessor = new HttpContextAccessor
        {
            HttpContext = new DefaultHttpContext
            {
                User = new ClaimsPrincipal(identity)
            }
        };
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["SITE_BASEURL"] = siteScope
            })
            .Build();
        return new SqlAuthorArticlePinPermissionAuthority(
            db,
            accessor,
            configuration,
            TimeProvider.System);
    }

    private sealed class PermissionInputList(IReadOnlyList<int> values, bool replaceOnRecheck = false) : IReadOnlyList<int>
    {
        public int Count => values.Count;
        public int IndexReads
        {
            get; private set;
        }
        public int EnumeratorCalls
        {
            get; private set;
        }
        public int this[int index]
        {
            get
            {
                IndexReads++;
                return replaceOnRecheck && IndexReads > Count ? values[index] + Count : values[index];
            }
        }

        public IEnumerator<int> GetEnumerator()
        {
            EnumeratorCalls++;
            throw new InvalidOperationException("Caller input must not be enumerated.");
        }

        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }

    private sealed class RecordingArticleSource(IAuthorArticlePinArticleProjectionSource inner)
        : IAuthorArticlePinArticleProjectionSource
    {
        public List<int[]> Requests { get; } = [];
        public IReadOnlyList<AuthorArticlePinArticleFact> LastFacts { get; private set; } = [];

        public async Task<IReadOnlyList<AuthorArticlePinArticleFact>> ReadCurrentBatchAsync(
            IReadOnlyList<int> articleIds,
            CancellationToken cancellationToken = default)
        {
            Requests.Add([.. articleIds]);
            LastFacts = await inner.ReadCurrentBatchAsync(articleIds, cancellationToken).ConfigureAwait(false);
            return LastFacts;
        }
    }

    private sealed class RecordingReconciliationSink : IAuthorArticlePinReconciliationSink
    {
        public List<AuthorArticlePinClosedRemovalObligation> Obligations { get; } = [];

        public Task<bool> RecordClosedRemovalsAsync(
            IReadOnlyList<AuthorArticlePinClosedRemovalObligation> obligations,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Obligations.Clear();
            Obligations.AddRange(obligations);
            return Task.FromResult(true);
        }
    }
}
