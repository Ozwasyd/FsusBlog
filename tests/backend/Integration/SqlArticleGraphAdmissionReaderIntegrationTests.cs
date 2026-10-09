using System.Security.Claims;
using System.Transactions;

using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.Configuration;

using Npgsql;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

/// <summary>Original disposable PostgreSQL module tests; no HTTP/editor-host acceptance is claimed.</summary>
[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class SqlArticleGraphAdmissionReaderIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    private static readonly AuthorArticlePinOwner s_owner = new(1, "primary-site");

    [Fact]
    public async Task RealCurrentReadAndFreshRevalidationSucceedInReadOnlyTransaction()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        ArticleGraphCurrentArticleReadRequest request = await RequestAsync(db);
        var permission = new PermissionProbe(CreatePermission(db));
        var article = new ArticleProbe(new SqlAuthorArticlePinArticleProjectionSource(db));
        var reader = Reader(db, permission, article);
        await db.Ado.BeginTranAsync();
        await db.Ado.ExecuteCommandAsync("SET TRANSACTION READ ONLY;");
        try
        {
            ArticleGraphCurrentArticleAdmission admission = Assert.IsType<ArticleGraphCurrentArticleAdmission>(
                await reader.ReadCurrentAsync(request));
            Assert.Equal(1, admission.Source.ArticleId);
            Assert.Equal(10, admission.Source.RevisionId);
            Assert.Equal(1, admission.Source.RevisionNo);
            Assert.NotEqual(Guid.Empty, admission.Source.SourceEpoch);
            Assert.Equal("current title", admission.Article.Title);
            Assert.Equal(new[] { 0, 1, 1 }, permission.Requests.Select(static value => value.ArticleIds.Count));
            Assert.Equal(2, article.Reads);
            Assert.All(article.Requests, static value => Assert.Equal(new[] { 1 }, value));
            var decisions = Assert.IsAssignableFrom<IList<AuthorArticlePinPermissionDecision>>(admission.Permission.Decisions);
            Assert.True(decisions.IsReadOnly);
            Assert.Throws<NotSupportedException>(() => decisions.Clear());
            ArticleGraphCurrentArticleAdmission fresh = Assert.IsType<ArticleGraphCurrentArticleAdmission>(
                await reader.RevalidateCurrentAsync(request, admission));
            Assert.NotEqual(admission.ReadId, fresh.ReadId);
            Assert.Equal(admission.Source, fresh.Source);
            Assert.Equal(admission.Article, fresh.Article);
            Assert.Equal(6, permission.Requests.Count);
            Assert.Equal(4, article.Reads);
            Assert.Null(await reader.ReadCurrentAsync(request with
            {
                RevisionIdentity = "revision:aa90413e-7d50-4264-9910-d89294ac2f18"
            }));
            Assert.Null(await reader.ReadCurrentAsync(request with
            {
                Owner = new(2, s_owner.SiteScope)
            }));
            Assert.Equal(1, await db.Ado.GetIntAsync("SELECT COUNT(*) FROM article_relation_article_binding;"));
            Assert.Equal(2, await db.Ado.GetIntAsync("SELECT COUNT(*) FROM article_relation_source_coordinate;"));
            await db.Ado.CommitTranAsync();
        }
        catch
        {
            await db.Ado.RollbackTranAsync();
            throw;
        }
    }

    [Theory]
    [InlineData("revoked")]
    [InlineData("idle-expired")]
    [InlineData("absolute-expired")]
    [InlineData("principal-inactive")]
    [InlineData("permission-removed")]
    [InlineData("session-missing")]
    [InlineData("owner")]
    [InlineData("site")]
    [InlineData("host-site")]
    [InlineData("host-session")]
    public async Task LiveContextRefusalPrecedesCanonicalLookupAndMetadata(string change)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        ArticleGraphCurrentArticleReadRequest request = await RequestAsync(db);
        if (change == "owner")
        {
            request = request with
            {
                Owner = new(2, s_owner.SiteScope)
            };
        }
        else if (change == "site")
        {
            request = request with
            {
                Owner = new(1, "other-site")
            };
        }
        else if (!change.StartsWith("host-", StringComparison.Ordinal))
        {
            await db.Ado.ExecuteCommandAsync(ChangeSql(change));
        }
        var permission = new PermissionProbe(CreatePermission(db,
            change == "host-site" ? "other-site" : s_owner.SiteScope,
            change == "host-session" ? "absent-session" : "root-session"));
        var article = new ArticleProbe(new SqlAuthorArticlePinArticleProjectionSource(db));
        var statements = new List<string>();
        db.Aop.OnLogExecuting = (sql, _) => statements.Add(sql);
        Assert.Null(await Reader(db, permission, article).ReadCurrentAsync(request));
        Assert.Equal(0, article.Reads);
        Assert.Empty(Assert.Single(permission.Requests).ArticleIds);
        Assert.DoesNotContain(statements, static sql => sql.Contains("article_relation_", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("deleted")]
    [InlineData("deleted-status")]
    [InlineData("missing")]
    [InlineData("unprovisioned")]
    [InlineData("wrong-revision")]
    [InlineData("missing-current")]
    [InlineData("foreign-current")]
    [InlineData("zero-number")]
    [InlineData("coordinate-table-missing")]
    [InlineData("identity-missing")]
    public async Task DeniedMissingUnprovisionedAndNoncurrentSourcesReturnNull(string change)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        ArticleGraphCurrentArticleReadRequest request = await RequestAsync(db);
        if (change == "unprovisioned")
        {
            request = request with
            {
                ArticleIdentity = "article:dd90413e-7d50-4264-9910-d89294ac2f18"
            };
            await db.Ado.ExecuteCommandAsync("INSERT INTO article_relation_article_binding VALUES (2, 'dd90413e-7d50-4264-9910-d89294ac2f18');");
        }
        else if (change == "wrong-revision")
        {
            ArticleRelationRevisionCoordinate old = (await new ArticleRelationSourceCoordinateAuthority().ReadRevisionAsync(db, 1, 11))!;
            request = request with
            {
                RevisionIdentity = old.RevisionIdentity
            };
        }
        else if (change == "identity-missing")
        {
            request = request with
            {
                ArticleIdentity = "article:aa90413e-7d50-4264-9910-d89294ac2f18"
            };
        }
        else if (change == "missing")
        {
            // The ordinary unbound article has no restrictive canonical FK and can be absent.
            request = request with
            {
                ArticleIdentity = "article:dd90413e-7d50-4264-9910-d89294ac2f18"
            };
            await db.Ado.ExecuteCommandAsync("DELETE FROM article_revision WHERE article_id = 2; DELETE FROM article WHERE id = 2;");
        }
        else
        {
            await db.Ado.ExecuteCommandAsync(ChangeSql(change));
        }
        var article = new ArticleProbe(new SqlAuthorArticlePinArticleProjectionSource(db));
        Assert.Null(await Reader(db, CreatePermission(db), article).ReadCurrentAsync(request));
        if (change is "deleted" or "deleted-status" or "missing" or "identity-missing")
        {
            Assert.Equal(0, article.Reads);
        }
    }

    [Theory]
    [InlineData("can-project")]
    [InlineData("can-open")]
    [InlineData("duplicate")]
    [InlineData("wrong-article")]
    [InlineData("digest")]
    [InlineData("reference")]
    public async Task InvalidArticleDecisionStopsBeforeMetadata(string change)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        ArticleGraphCurrentArticleReadRequest request = await RequestAsync(db);
        var permission = new PermissionProbe(CreatePermission(db))
        {
            Transform = (count, snapshot) => count != 2 ? snapshot : InvalidDecision(snapshot, change)
        };
        var article = new ArticleProbe(new SqlAuthorArticlePinArticleProjectionSource(db));
        Assert.Null(await Reader(db, permission, article).ReadCurrentAsync(request));
        Assert.Equal(2, permission.Requests.Count);
        Assert.Equal(0, article.Reads);
    }

    [Theory]
    [InlineData("title")]
    [InlineData("lifecycle")]
    [InlineData("deleted")]
    [InlineData("current-revision")]
    [InlineData("revision-number")]
    [InlineData("revoked")]
    [InlineData("idle-expired")]
    [InlineData("absolute-expired")]
    [InlineData("permission-removed")]
    [InlineData("session-revision")]
    [InlineData("permission-revision")]
    [InlineData("coordinate-table-missing")]
    public async Task ActualDatabaseDriftBetweenInitialAndFinalReadsRefuses(string change)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        ArticleGraphCurrentArticleReadRequest request = await RequestAsync(db);
        var article = new ArticleProbe(new SqlAuthorArticlePinArticleProjectionSource(db))
        {
            AfterRead = count => count == 1 ? db.Ado.ExecuteCommandAsync(ChangeSql(change)) : Task.CompletedTask
        };
        Assert.Null(await Reader(db, CreatePermission(db), article).ReadCurrentAsync(request));
    }

    [Theory]
    [InlineData("site-revision")]
    [InlineData("session-revision")]
    [InlineData("permission-revision")]
    [InlineData("permission-reference")]
    [InlineData("digest")]
    public async Task FreshFinalPermissionDriftCannotReuseInitialSnapshot(string change)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        ArticleGraphCurrentArticleReadRequest request = await RequestAsync(db);
        var permission = new PermissionProbe(CreatePermission(db))
        {
            Transform = (count, snapshot) => count != 3 ? snapshot : PermissionDrift(snapshot, change)
        };
        Assert.Null(await Reader(db, permission, new SqlAuthorArticlePinArticleProjectionSource(db)).ReadCurrentAsync(request));
        Assert.Equal(3, permission.Requests.Count);
    }

    [Theory]
    [InlineData("title")]
    [InlineData("lifecycle")]
    [InlineData("current-revision")]
    [InlineData("revoked")]
    [InlineData("idle-expired")]
    [InlineData("absolute-expired")]
    [InlineData("session-revision")]
    [InlineData("permission-revision")]
    public async Task RevalidationRejectsActualChangesAfterAdmission(string change)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        ArticleGraphCurrentArticleReadRequest request = await RequestAsync(db);
        var reader = Reader(db, CreatePermission(db), new SqlAuthorArticlePinArticleProjectionSource(db));
        ArticleGraphCurrentArticleAdmission admission = Assert.IsType<ArticleGraphCurrentArticleAdmission>(await reader.ReadCurrentAsync(request));
        await db.Ado.ExecuteCommandAsync(ChangeSql(change));
        Assert.Null(await reader.RevalidateCurrentAsync(request, admission));
    }

    [Theory]
    [InlineData("title")]
    [InlineData("epoch")]
    [InlineData("revision")]
    [InlineData("owner")]
    [InlineData("permission")]
    [InlineData("read-id")]
    public async Task RevalidationRejectsTamperingEvenWithRecomputedInputDigest(string change)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        ArticleGraphCurrentArticleReadRequest request = await RequestAsync(db);
        var reader = Reader(db, CreatePermission(db), new SqlAuthorArticlePinArticleProjectionSource(db));
        ArticleGraphCurrentArticleAdmission admission = Assert.IsType<ArticleGraphCurrentArticleAdmission>(await reader.ReadCurrentAsync(request));
        if (change == "title")
        {
            AuthorArticlePinArticleFact tampered = admission.Article with
            {
                Title = "forged"
            };
            admission = admission with
            {
                Article = tampered with
                {
                    ContentDigest = AuthorArticlePinProjectionContract.ComputeArticleFactDigest(tampered)
                }
            };
        }
        else
        {
            admission = change switch
            {
                "epoch" => admission with { Source = admission.Source with { SourceEpoch = Guid.NewGuid() } },
                "revision" => admission with { Source = admission.Source with { RevisionId = 11 } },
                "owner" => admission with { Permission = Seal(admission.Permission with { Owner = new(2, s_owner.SiteScope) }) },
                "permission" => admission with { Permission = PermissionDrift(admission.Permission, "permission-reference") },
                _ => admission with { ReadId = Guid.Empty }
            };
        }
        Assert.Null(await reader.RevalidateCurrentAsync(request, admission));
    }

    [Theory]
    [InlineData("digest")]
    [InlineData("duplicate")]
    [InlineData("wrong-article")]
    [InlineData("missing")]
    [InlineData("failure")]
    public async Task InvalidMetadataNeverReturnsPartialFacts(string change)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        ArticleGraphCurrentArticleReadRequest request = await RequestAsync(db);
        var article = new ArticleProbe(new SqlAuthorArticlePinArticleProjectionSource(db))
        {
            Transform = facts => change switch
            {
                "digest" => [facts[0] with { ContentDigest = "forged" }],
                "duplicate" => [facts[0], facts[0]],
                "wrong-article" => [facts[0] with { ArticleId = 2 }],
                "missing" => [],
                _ => throw new InvalidOperationException("private database detail")
            }
        };
        Assert.Null(await Reader(db, CreatePermission(db), article).ReadCurrentAsync(request));
    }

    [Fact]
    public async Task CancellationDuringRealMetadataReadPropagates()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        ArticleGraphCurrentArticleReadRequest request = await RequestAsync(db);
        using var cancellation = new CancellationTokenSource();
        var article = new ArticleProbe(new SqlAuthorArticlePinArticleProjectionSource(db))
        {
            AfterRead = _ =>
            {
                cancellation.Cancel();
                return Task.CompletedTask;
            }
        };
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            Reader(db, CreatePermission(db), article).ReadCurrentAsync(request, cancellation.Token));
    }

    [Fact]
    public async Task RevalidationRefusesRetainedSnapshotsAfterOtherConnectionCommitsRootChanges()
    {
        foreach (System.Data.IsolationLevel isolation in new[]
        {
            System.Data.IsolationLevel.RepeatableRead,
            System.Data.IsolationLevel.Serializable,
            System.Data.IsolationLevel.ReadCommitted
        })
        {
            foreach (string change in new[] { "revoked", "deleted", "current-revision" })
            {
                using SqlSugarClient db = await CreateDatabaseAsync();
                ArticleGraphCurrentArticleReadRequest request = await RequestAsync(db);
                SqlAuthorArticlePinPermissionAuthority permissions = CreatePermission(db);
                var articles = new ArticleProbe(new SqlAuthorArticlePinArticleProjectionSource(db));
                var reader = Reader(db, permissions, articles);
                ArticleGraphCurrentArticleAdmission admission = Assert.IsType<ArticleGraphCurrentArticleAdmission>(
                    await reader.ReadCurrentAsync(request));

                await db.Ado.BeginTranAsync(isolation);
                await db.Ado.ExecuteCommandAsync("SET TRANSACTION READ ONLY;");
                System.Data.IDbTransaction callerTransaction = db.Ado.Transaction;
                try
                {
                    Assert.Equal(10, await db.Ado.GetIntAsync("SELECT current_revision_id FROM article WHERE id = 1;"));
                    using SqlSugarClient writer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
                    Assert.Null(writer.Ado.Transaction);
                    await writer.Ado.ExecuteCommandAsync(ChangeSql(change));

                    // These are real committed writes on another connection, not a mocked snapshot.
                    AuthorArticlePinPermissionSnapshot observedPermission = await permissions.ResolveAsync(
                        new(s_owner, request.RequestId, [1]));
                    AuthorArticlePinArticleFact observedArticle = Assert.Single(
                        await new SqlAuthorArticlePinArticleProjectionSource(db).ReadCurrentBatchAsync([1]));
                    if (isolation != System.Data.IsolationLevel.ReadCommitted)
                    {
                        Assert.Equal(AuthorArticlePinPermissionSnapshotStatus.Current, observedPermission.Status);
                        Assert.True(Assert.Single(observedPermission.Decisions).CanOpen);
                        Assert.Equal(admission.Article, observedArticle);
                        Assert.Equal(admission.Source,
                            await new ArticleRelationSourceCoordinateAuthority().ReadRevisionAsync(db, 1, 10));
                        Assert.Null(await reader.ReadCurrentAsync(request));
                    }
                    else
                    {
                        Assert.True(change switch
                        {
                            "revoked" => observedPermission.Status == AuthorArticlePinPermissionSnapshotStatus.Unavailable,
                            "deleted" => observedArticle.IsDeleted,
                            _ => observedArticle.CurrentRevisionId == 11
                        });
                    }

                    Assert.Null(await reader.RevalidateCurrentAsync(request, admission));
                    if (isolation != System.Data.IsolationLevel.ReadCommitted)
                    {
                        Assert.Equal(2, articles.Reads);
                    }
                    using var cancellation = new CancellationTokenSource();
                    cancellation.Cancel();
                    await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
                        reader.RevalidateCurrentAsync(request, admission, cancellation.Token));
                    Assert.Same(callerTransaction, db.Ado.Transaction);
                    Assert.Equal(isolation, callerTransaction.IsolationLevel);
                    Assert.Equal("on", await db.Ado.GetStringAsync("SHOW transaction_read_only;"));
                }
                finally
                {
                    await db.Ado.RollbackTranAsync();
                }
            }
        }
    }

    [Fact]
    public async Task AdmissionRefusesAmbientAndUntrackedNativeFixedSnapshots()
    {
        foreach (bool ambient in new[] { false, true })
        {
            using SqlSugarClient db = await CreateDatabaseAsync();
            ArticleGraphCurrentArticleReadRequest request = await RequestAsync(db);
            SqlAuthorArticlePinPermissionAuthority permissions = CreatePermission(db);
            var articles = new ArticleProbe(new SqlAuthorArticlePinArticleProjectionSource(db));
            var reader = Reader(db, permissions, articles);
            ArticleGraphCurrentArticleAdmission admission = Assert.IsType<ArticleGraphCurrentArticleAdmission>(
                await reader.ReadCurrentAsync(request));
            db.CurrentConnectionConfig.IsAutoCloseConnection = false;
            using SqlSugarClient writer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);

            if (ambient)
            {
                using var scope = new TransactionScope(TransactionScopeOption.RequiresNew,
                    new TransactionOptions { IsolationLevel = System.Transactions.IsolationLevel.RepeatableRead },
                    TransactionScopeAsyncFlowOption.Enabled);
                db.Ado.Open();
                await db.Ado.ExecuteCommandAsync("SET TRANSACTION READ ONLY;");
                Assert.Equal(10, await db.Ado.GetIntAsync("SELECT current_revision_id FROM article WHERE id = 1;"));
                Transaction? callerTransaction = Transaction.Current;
                Assert.NotNull(callerTransaction);
                Assert.Null(db.Ado.Transaction);
                Assert.Null(await reader.ReadCurrentAsync(request));
                Assert.Null(await reader.RevalidateCurrentAsync(request, admission));

                using (var suppressed = new TransactionScope(TransactionScopeOption.Suppress, TransactionScopeAsyncFlowOption.Enabled))
                {
                    await writer.Ado.ExecuteCommandAsync(ChangeSql("revoked"));
                    Assert.Null(Transaction.Current);
                    Assert.Equal(AuthorArticlePinPermissionSnapshotStatus.Current,
                        (await permissions.ResolveAsync(new(s_owner, request.RequestId, [1]))).Status);
                    // The connector remains enlisted even though ambient flow is suppressed.
                    Assert.Null(await reader.ReadCurrentAsync(request));
                    Assert.Null(await reader.RevalidateCurrentAsync(request, admission));
                }
                Assert.Same(callerTransaction, Transaction.Current);
                db.Ado.Close();
            }
            else
            {
                db.Ado.Open();
                var connection = Assert.IsType<NpgsqlConnection>(db.Ado.Connection);
                await using NpgsqlTransaction callerTransaction = await connection.BeginTransactionAsync(
                    System.Data.IsolationLevel.RepeatableRead);
                try
                {
                    await db.Ado.ExecuteCommandAsync("SET TRANSACTION READ ONLY;");
                    Assert.Equal(10, await db.Ado.GetIntAsync("SELECT current_revision_id FROM article WHERE id = 1;"));
                    Assert.Null(db.Ado.Transaction);
                    await writer.Ado.ExecuteCommandAsync(ChangeSql("revoked"));
                    Assert.Equal(AuthorArticlePinPermissionSnapshotStatus.Current,
                        (await permissions.ResolveAsync(new(s_owner, request.RequestId, [1]))).Status);
                    Assert.Null(await reader.ReadCurrentAsync(request));
                    Assert.Null(await reader.RevalidateCurrentAsync(request, admission));
                    Assert.Same(connection, callerTransaction.Connection);
                    Assert.Equal(System.Data.IsolationLevel.RepeatableRead, callerTransaction.IsolationLevel);
                }
                finally
                {
                    await callerTransaction.RollbackAsync();
                }
            }
            Assert.Equal(2, articles.Reads);
        }
    }

    [Fact]
    public async Task AutocommitAdmissionKeepsConnectionIdentityAcrossLegalOpenAndClose()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        ArticleGraphCurrentArticleReadRequest request = await RequestAsync(db);
        var connection = Assert.IsType<NpgsqlConnection>(db.Ado.Connection);
        var reader = Reader(db, CreatePermission(db), new SqlAuthorArticlePinArticleProjectionSource(db));
        Assert.True(db.CurrentConnectionConfig.IsAutoCloseConnection);
        Assert.Null(db.Ado.Transaction);
        db.Ado.Close();
        Assert.Equal(System.Data.ConnectionState.Closed, connection.State);

        ArticleGraphCurrentArticleAdmission admission = Assert.IsType<ArticleGraphCurrentArticleAdmission>(
            await reader.ReadCurrentAsync(request));
        Assert.Same(connection, db.Ado.Connection);
        Assert.Null(db.Ado.Transaction);
        db.Ado.Open();
        Assert.Equal(System.Data.ConnectionState.Open, connection.State);
        ArticleGraphCurrentArticleAdmission current = Assert.IsType<ArticleGraphCurrentArticleAdmission>(
            await reader.RevalidateCurrentAsync(request, admission));
        Assert.Equal(admission.Source, current.Source);
        Assert.Equal(admission.Article, current.Article);
        Assert.Same(connection, db.Ado.Connection);
        Assert.Null(db.Ado.Transaction);
    }

    [Theory]
    [InlineData("begin-transaction")]
    [InlineData("replace-transaction")]
    [InlineData("replace-connection")]
    public async Task AdmissionAndRevalidationRefuseContextReplacementWithoutEndingCallerContext(string change)
    {
        foreach (bool revalidate in new[] { false, true })
        {
            using SqlSugarClient db = await CreateDatabaseAsync();
            ArticleGraphCurrentArticleReadRequest request = await RequestAsync(db);
            ArticleGraphCurrentArticleAdmission admission = Assert.IsType<ArticleGraphCurrentArticleAdmission>(
                await Reader(db, CreatePermission(db), new SqlAuthorArticlePinArticleProjectionSource(db))
                    .ReadCurrentAsync(request));
            var originalConnection = Assert.IsType<NpgsqlConnection>(db.Ado.Connection);
            db.CurrentConnectionConfig.IsAutoCloseConnection = false;
            await using var replacementConnection = new NpgsqlConnection(db.CurrentConnectionConfig.ConnectionString);
            NpgsqlTransaction? originalTransaction = null;
            NpgsqlTransaction? replacementTransaction = null;
            if (change == "replace-transaction")
            {
                await db.Ado.BeginTranAsync(System.Data.IsolationLevel.ReadCommitted);
                await db.Ado.ExecuteCommandAsync("SET TRANSACTION READ ONLY;");
                originalTransaction = Assert.IsType<NpgsqlTransaction>(db.Ado.Transaction);
            }
            var articles = new ArticleProbe(new SqlAuthorArticlePinArticleProjectionSource(db))
            {
                AfterRead = async count =>
                {
                    if (count != 1)
                    {
                        return;
                    }
                    // Only this test owner changes the context, after an actual metadata read.
                    if (change == "replace-connection")
                    {
                        await replacementConnection.OpenAsync();
                        db.Ado.Connection = replacementConnection;
                        return;
                    }
                    if (originalTransaction is not null)
                    {
                        await db.Ado.RollbackTranAsync();
                        // Npgsql reuses its transaction object on the same physical connector.
                        // Reopen this nonpooled connection to exercise an actual reference replacement.
                        await originalConnection.CloseAsync();
                        await originalConnection.OpenAsync();
                    }
                    await db.Ado.BeginTranAsync(System.Data.IsolationLevel.ReadCommitted);
                    await db.Ado.ExecuteCommandAsync("SET TRANSACTION READ ONLY;");
                    replacementTransaction = Assert.IsType<NpgsqlTransaction>(db.Ado.Transaction);
                }
            };
            var reader = Reader(db, CreatePermission(db), articles);
            try
            {
                Assert.Null(revalidate
                    ? await reader.RevalidateCurrentAsync(request, admission)
                    : await reader.ReadCurrentAsync(request));
                Assert.Equal(1, articles.Reads);
                if (change == "replace-connection")
                {
                    Assert.Same(replacementConnection, db.Ado.Connection);
                    Assert.Null(db.Ado.Transaction);
                }
                else
                {
                    Assert.NotNull(replacementTransaction);
                    Assert.NotSame(originalTransaction, replacementTransaction);
                    Assert.Same(replacementTransaction, db.Ado.Transaction);
                    Assert.Same(originalConnection, replacementTransaction.Connection);
                    Assert.Equal(System.Data.IsolationLevel.ReadCommitted, replacementTransaction.IsolationLevel);
                    Assert.Equal("on", await db.Ado.GetStringAsync("SHOW transaction_read_only;"));
                }
                Assert.Equal(1, await db.Ado.GetIntAsync("SELECT 1;"));
                using var cancellation = new CancellationTokenSource();
                cancellation.Cancel();
                await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
                    reader.RevalidateCurrentAsync(request, admission, cancellation.Token));
                Assert.Same(replacementTransaction, db.Ado.Transaction);
            }
            finally
            {
                db.Ado.Connection = originalConnection;
                if (db.Ado.Transaction is not null)
                {
                    await db.Ado.RollbackTranAsync();
                }
            }
        }
    }

    private async Task<SqlSugarClient> CreateDatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        try
        {
            await db.Ado.ExecuteCommandAsync("""
                CREATE TABLE admin_principal(id bigint PRIMARY KEY, status text NOT NULL, isroot boolean NOT NULL, permissions text NOT NULL);
                INSERT INTO admin_principal VALUES (1, 'active', FALSE, 'article.write');
                CREATE TABLE admin_session(sessionid text PRIMARY KEY, adminprincipalid bigint NOT NULL REFERENCES admin_principal(id),
                    revokedatutc timestamp NULL, idleexpiresatutc timestamp NOT NULL, absoluteexpiresatutc timestamp NOT NULL);
                INSERT INTO admin_session VALUES ('root-session', 1, NULL, TIMESTAMP '2099-01-01', TIMESTAMP '2099-01-02');
                CREATE TABLE article(id integer PRIMARY KEY, title text NOT NULL, status integer NOT NULL,
                    isdeleted boolean NOT NULL, current_revision_id bigint NULL);
                INSERT INTO article VALUES (1, 'current title', 0, FALSE, 10), (2, 'unbound title', 0, FALSE, 20);
                CREATE TABLE article_revision(id bigint PRIMARY KEY, article_id integer NOT NULL REFERENCES article(id), revision_no integer NOT NULL);
                INSERT INTO article_revision VALUES (10, 1, 1), (11, 1, 2), (20, 2, 1);
                """);
            await fixture.ExecuteAsync(db.CurrentConnectionConfig.ConnectionString, ArticleRelationSourceCoordinateMigrationDefinitions.Sql);
            await db.Ado.BeginTranAsync();
            var authority = new ArticleRelationSourceCoordinateAuthority();
            await authority.ProvisionRevisionAsync(db, 1, 10);
            await authority.ProvisionRevisionAsync(db, 1, 11);
            await db.Ado.CommitTranAsync();
            return db;
        }
        catch
        {
            db.Dispose();
            throw;
        }
    }

    private static async Task<ArticleGraphCurrentArticleReadRequest> RequestAsync(SqlSugarClient db)
    {
        ArticleRelationRevisionCoordinate source = (await new ArticleRelationSourceCoordinateAuthority().ReadRevisionAsync(db, 1, 10))!;
        return new(s_owner, Guid.NewGuid(), source.ArticleIdentity, source.RevisionIdentity);
    }

    private static SqlArticleGraphAdmissionReader Reader(ISqlSugarClient db,
        IAuthorArticlePinPermissionProjectionProvider permissions, IAuthorArticlePinArticleProjectionSource articles)
        => new(db, new(), permissions, articles);

    private static SqlAuthorArticlePinPermissionAuthority CreatePermission(ISqlSugarClient db,
        string site = "primary-site", string session = "root-session")
    {
        var principal = new ClaimsPrincipal(new ClaimsIdentity(
        [
            new("identity_kind", "admin_principal"), new("admin_id", "1"), new("admin_sid", session),
            new(AdminPermissions.PermissionClaimType, AdminPermissions.ArticleWrite)
        ], "test"));
        var context = new HttpContextAccessor { HttpContext = new DefaultHttpContext { User = principal } };
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["SITE_BASEURL"] = site }).Build();
        return new(db, context, configuration, TestTemporalContext.FromEnvironment().BusinessClock);
    }

    private static string ChangeSql(string change) => change switch
    {
        "revoked" => "UPDATE admin_session SET revokedatutc = TIMESTAMP '2000-01-01';",
        "idle-expired" => "UPDATE admin_session SET idleexpiresatutc = TIMESTAMP '2000-01-01';",
        "absolute-expired" => "UPDATE admin_session SET absoluteexpiresatutc = TIMESTAMP '2000-01-01';",
        "principal-inactive" => "UPDATE admin_principal SET status = 'inactive';",
        "permission-removed" => "UPDATE admin_principal SET permissions = '';",
        "session-missing" => "DELETE FROM admin_session;",
        "session-revision" => "UPDATE admin_session SET idleexpiresatutc = TIMESTAMP '2098-01-01';",
        "permission-revision" => "UPDATE admin_principal SET permissions = E'article.write\nother.permission';",
        "title" => "UPDATE article SET title = 'changed title' WHERE id = 1;",
        "lifecycle" => "UPDATE article SET status = 3 WHERE id = 1;",
        "deleted" => "UPDATE article SET isdeleted = TRUE WHERE id = 1;",
        "deleted-status" => "UPDATE article SET status = 4 WHERE id = 1;",
        "current-revision" => "UPDATE article SET current_revision_id = 11 WHERE id = 1;",
        "revision-number" => "UPDATE article_revision SET revision_no = 3 WHERE id = 10;",
        "zero-number" => "UPDATE article_revision SET revision_no = 0 WHERE id = 10;",
        "missing-current" => "UPDATE article SET current_revision_id = NULL WHERE id = 1;",
        "foreign-current" => "UPDATE article SET current_revision_id = 20 WHERE id = 1;",
        "coordinate-table-missing" => "DROP TABLE article_relation_source_coordinate;",
        _ => throw new ArgumentOutOfRangeException(nameof(change))
    };

    private static AuthorArticlePinPermissionSnapshot Seal(AuthorArticlePinPermissionSnapshot snapshot)
        => snapshot with
        {
            ContentDigest = AuthorArticlePinProjectionContract.ComputePermissionDigest(snapshot)
        };

    private static AuthorArticlePinPermissionSnapshot InvalidDecision(AuthorArticlePinPermissionSnapshot snapshot, string change)
    {
        AuthorArticlePinPermissionDecision original = snapshot.Decisions[0];
        AuthorArticlePinPermissionDecision decision = change switch
        {
            "can-project" => original with { CanProject = false },
            "can-open" => original with { CanOpen = false },
            "wrong-article" => original with { ArticleId = 2 },
            "reference" => original with { PermissionReference = "" },
            _ => original
        };
        return change == "digest" ? snapshot with
        {
            ContentDigest = "forged"
        }
            : Seal(snapshot with
            {
                Decisions = change == "duplicate" ? [decision, decision] : [decision]
            });
    }

    private static AuthorArticlePinPermissionSnapshot PermissionDrift(AuthorArticlePinPermissionSnapshot snapshot, string change)
        => change == "digest" ? snapshot with
        {
            ContentDigest = "forged"
        } : Seal(change switch
        {
            "site-revision" => snapshot with { SiteRevision = "changed" },
            "session-revision" => snapshot with { SessionRevision = "changed" },
            "permission-revision" => snapshot with { PermissionRevision = "changed" },
            _ => snapshot with { Decisions = [snapshot.Decisions[0] with { PermissionReference = "changed" }] }
        });

    private sealed class PermissionProbe(IAuthorArticlePinPermissionProjectionProvider inner)
        : IAuthorArticlePinPermissionProjectionProvider
    {
        public List<AuthorArticlePinPermissionBatchRequest> Requests { get; } = [];
        public Func<int, AuthorArticlePinPermissionSnapshot, AuthorArticlePinPermissionSnapshot>? Transform
        {
            get; init;
        }

        public async Task<AuthorArticlePinPermissionSnapshot> ResolveAsync(
            AuthorArticlePinPermissionBatchRequest request, CancellationToken cancellationToken = default)
        {
            Requests.Add(request);
            AuthorArticlePinPermissionSnapshot snapshot = await inner.ResolveAsync(request, cancellationToken);
            return Transform?.Invoke(Requests.Count, snapshot) ?? snapshot;
        }
    }

    private sealed class ArticleProbe(IAuthorArticlePinArticleProjectionSource inner)
        : IAuthorArticlePinArticleProjectionSource
    {
        public int Reads
        {
            get; private set;
        }
        public List<int[]> Requests { get; } = [];
        public Func<int, Task>? AfterRead
        {
            get; init;
        }
        public Func<IReadOnlyList<AuthorArticlePinArticleFact>, IReadOnlyList<AuthorArticlePinArticleFact>>? Transform
        {
            get; init;
        }

        public async Task<IReadOnlyList<AuthorArticlePinArticleFact>> ReadCurrentBatchAsync(
            IReadOnlyList<int> articleIds, CancellationToken cancellationToken = default)
        {
            Reads++;
            Requests.Add([.. articleIds]);
            IReadOnlyList<AuthorArticlePinArticleFact> facts = await inner.ReadCurrentBatchAsync(articleIds, cancellationToken);
            if (AfterRead is not null)
            {
                await AfterRead(Reads);
            }
            return Transform?.Invoke(facts) ?? facts;
        }
    }
}
