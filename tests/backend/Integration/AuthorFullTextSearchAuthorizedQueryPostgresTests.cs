using System.Collections.Immutable;
using System.Security.Claims;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.ArticleProperties;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

/// <summary>Real PostgreSQL authorization joined to the original typed index/consumer; source text/value inputs are algorithm fixtures.</summary>
[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class AuthorFullTextSearchAuthorizedQueryPostgresTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task RealOwnershipAndTypedPredicateRunBeforePageTrimmingWithoutHistoryGrant()
    {
        using Case test = await CreateCaseAsync();
        using AuthorFullTextSearchIndex index = await test.IndexAsync();
        var history = await test.Authority.ResolveAsync(new(new(1, Case.Site), Guid.NewGuid(), [2]));
        Assert.True(Assert.Single(history.Decisions).CanProject);
        var evaluator = new AuthorFullTextSearchQueryEvaluator(index);
        var zero = await evaluator.InspectIndexAsync(test.Query(index, 0), test.Definitions, test.Source, test.Authority);
        Assert.Equal(1, Assert.Single(zero.Candidates).Document.Identity.ArticleId);
        var one = await evaluator.InspectIndexAsync(AuthorFullTextSearchContract.SealQuery(test.Query(index, 1) with
        {
            PageSize = 1
        }),
            test.Definitions, test.Source, test.Authority);
        Assert.Equal(3, Assert.Single(one.Candidates).Document.Identity.ArticleId);
        test.Mutator.Ado.ExecuteCommand("UPDATE admin_principal SET isroot = TRUE, permissions = '' WHERE id = 1");
        await test.RefreshIdentityAsync();
        using AuthorFullTextSearchIndex rootIndex = await test.IndexAsync();
        Assert.Equal(1, Assert.Single((await new AuthorFullTextSearchQueryEvaluator(rootIndex).InspectIndexAsync(test.Query(rootIndex, 0),
            test.Definitions, test.Source, test.Authority)).Candidates).Document.Identity.ArticleId);
    }

    [Theory]
    [InlineData("anonymous", false)]
    [InlineData("anonymous", true)]
    [InlineData("revoked", false)]
    [InlineData("revoked", true)]
    [InlineData("idle", false)]
    [InlineData("idle", true)]
    [InlineData("absolute", false)]
    [InlineData("absolute", true)]
    [InlineData("disabled", false)]
    [InlineData("disabled", true)]
    [InlineData("claim", false)]
    [InlineData("claim", true)]
    [InlineData("site", false)]
    [InlineData("site", true)]
    [InlineData("session-owner", false)]
    [InlineData("session-owner", true)]
    [InlineData("session-row", false)]
    [InlineData("session-row", true)]
    public async Task EmptyOrNoMatchCannotBypassActualActorSessionAndPolicy(string fault, bool empty)
    {
        using Case test = await CreateCaseAsync(empty);
        using AuthorFullTextSearchIndex index = await test.IndexAsync();
        test.ResetPrincipalReads();
        test.Change(fault);
        Assert.Equal("author_search_current_permission_unavailable",
            (await Assert.ThrowsAsync<AuthorSearchContractException>(() => new AuthorFullTextSearchQueryEvaluator(index)
                .InspectIndexAsync(test.Query(index, 99), test.Definitions, test.Source, test.Authority))).Message);
        Assert.True(test.PrincipalReads > 0 || fault is "anonymous" or "claim" or "site");
    }

    [Theory]
    [InlineData("owner", false)]
    [InlineData("owner", true)]
    [InlineData("revoked", false)]
    [InlineData("revoked", true)]
    [InlineData("clock", false)]
    [InlineData("clock", true)]
    [InlineData("context", false)]
    [InlineData("context", true)]
    [InlineData("principal-row", false)]
    [InlineData("principal-row", true)]
    [InlineData("session-row", false)]
    [InlineData("session-row", true)]
    [InlineData("archived", false)]
    [InlineData("archived", true)]
    [InlineData("revision-row", false)]
    [InlineData("revision-row", true)]
    public async Task SourceAwaitDriftRefusesActualSqlFactsEvenWhenPredicateReturnsZero(string change, bool noMatch)
    {
        using Case test = await CreateCaseAsync();
        using AuthorFullTextSearchIndex index = await test.IndexAsync();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        test.Source.Hold();
        Task<AuthorSearchTokenEvaluation> pending = new AuthorFullTextSearchQueryEvaluator(index).InspectIndexAsync(
            test.Query(index, noMatch ? 99 : 0), test.Definitions, test.Source, test.Authority, timeout.Token);
        try
        {
            await test.Source.Entered.Task.WaitAsync(timeout.Token);
            Assert.False(pending.IsCompleted);
            test.Change(change);
            test.Source.Release.TrySetResult();
            Assert.Equal("author_search_current_permission_unavailable",
                (await Assert.ThrowsAsync<AuthorSearchContractException>(() => pending)).Message);
        }
        finally
        {
            test.Source.Release.TrySetResult();
            try
            {
                _ = await pending;
            }
            catch (AuthorSearchContractException)
            {
                // Drain the checked refusal before the case's real clients are disposed.
            }
        }
    }

    [Fact]
    public async Task GenerationDriftDuringSourceAwaitAndReplacementIncarnationRefuse()
    {
        using Case test = await CreateCaseAsync();
        using AuthorFullTextSearchIndex index = await test.IndexAsync();
        AuthorSearchQuery query = test.Query(index, 0);
        using AuthorFullTextSearchIndex replacement = await test.IndexAsync();
        Assert.Equal(index.RequireCurrentGeneration(), replacement.RequireCurrentGeneration());
        Assert.Equal("author_search_index_read_scope_or_generation_stale", (await Assert.ThrowsAsync<AuthorSearchContractException>(() =>
            new AuthorFullTextSearchQueryEvaluator(replacement).InspectIndexAsync(query, test.Definitions, test.Source, test.Authority))).Message);
        test.Source.Hold();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        Task<AuthorSearchTokenEvaluation> pending = new AuthorFullTextSearchQueryEvaluator(index)
            .InspectIndexAsync(query, test.Definitions, test.Source, test.Authority, timeout.Token);
        try
        {
            await test.Source.Entered.Task.WaitAsync(timeout.Token);
            test.Source.StopHolding();
            while (await index.RebuildStepAsync(cancellationToken: timeout.Token) is not null)
            {
            }
            test.Source.Release.TrySetResult();
            await Assert.ThrowsAsync<AuthorSearchContractException>(() => pending);
        }
        finally
        {
            test.Source.Release.TrySetResult();
            try
            {
                _ = await pending;
            }
            catch (AuthorSearchContractException)
            {
                // Drain this case-owned stale generation operation.
            }
        }
    }

    [Theory]
    [InlineData("revision")]
    [InlineData("policy")]
    [InlineData("user")]
    [InlineData("site")]
    public async Task QueryPermissionCoordinatesAreNeverRewrittenToFitTheReader(string field)
    {
        using Case test = await CreateCaseAsync();
        using AuthorFullTextSearchIndex index = await test.IndexAsync();
        var query = AuthorFullTextSearchContract.SealQuery(test.Query(index, 0) with
        {
            Clauses = AuthorFullTextSearchContract.ParseClauses("needle")
        });
        query = AuthorFullTextSearchContract.SealQuery(field switch
        {
            "revision" => query with { PermissionRevision = query.PermissionRevision + 1 },
            "policy" => query with { PermissionPolicyDigest = AuthorFullTextSearchContract.Digest("wrong") },
            "user" => query with { UserId = 2 },
            _ => query with { SiteScope = "https://other.example.test" }
        });
        Assert.Equal("author_search_current_permission_unavailable", (await Assert.ThrowsAsync<AuthorSearchContractException>(() =>
            new AuthorFullTextSearchQueryEvaluator(index).InspectIndexAsync(query, test.Definitions, test.Source, test.Authority))).Message);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task SuccessfulZeroResultsStillReadAndRevalidateTheActualSession(bool empty)
    {
        using Case test = await CreateCaseAsync(empty);
        using AuthorFullTextSearchIndex index = await test.IndexAsync();
        test.ResetPrincipalReads();
        var result = await new AuthorFullTextSearchQueryEvaluator(index).InspectIndexAsync(
            test.Query(index, 99), test.Definitions, test.Source, test.Authority);
        Assert.Empty(result.Candidates);
        Assert.True(test.PrincipalReads > 3);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task FinalActualSqlAwaitCannotHideDefinitionOrCancellationDrift(bool cancel)
    {
        using Case test = await CreateCaseAsync();
        using AuthorFullTextSearchIndex index = await test.IndexAsync();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        test.Source.Hold();
        Task<AuthorSearchTokenEvaluation> pending = new AuthorFullTextSearchQueryEvaluator(index).InspectIndexAsync(
            test.Query(index, 0), test.Definitions, test.Source, test.Authority, timeout.Token);
        try
        {
            await test.Source.Entered.Task.WaitAsync(timeout.Token);
            test.OnNextPrincipalRead = () =>
            {
                if (cancel)
                {
                    timeout.Cancel();
                }
                else
                {
                    var changed = test.Definition with
                    {
                        SchemaRevision = 2
                    };
                    ((Dictionary<Guid, ArticlePropertyDefinition>)test.Definitions)[changed.DefinitionId] = changed with
                    {
                        ContentDigest = ArticlePropertyDefinitionContract.ComputeDefinitionDigest(changed)
                    };
                }
            };
            test.Source.Release.TrySetResult();
            if (cancel)
            {
                await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending);
            }
            else
            {
                await Assert.ThrowsAsync<AuthorSearchContractException>(() => pending);
            }
            Assert.Null(test.OnNextPrincipalRead);
        }
        finally
        {
            test.Source.Release.TrySetResult();
            try
            {
                _ = await pending;
            }
            catch (Exception error) when (error is AuthorSearchContractException or OperationCanceledException)
            {
                // Drain the refusal before disposing this case's actual SQL clients.
            }
        }
    }

    private async Task<Case> CreateCaseAsync(bool empty = false)
    {
        var db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        await db.Ado.ExecuteCommandAsync(
            """
            CREATE TABLE admin_principal(id bigint PRIMARY KEY, status text NOT NULL,
                isroot boolean NOT NULL, permissions text NOT NULL);
            INSERT INTO admin_principal VALUES (1, 'active', FALSE, 'article.write'), (2, 'active', FALSE, 'article.write');
            CREATE TABLE admin_session(sessionid text PRIMARY KEY, adminprincipalid bigint NOT NULL,
                revokedatutc timestamp NULL, idleexpiresatutc timestamp NOT NULL, absoluteexpiresatutc timestamp NOT NULL);
            INSERT INTO admin_session VALUES ('search-session', 1, NULL, '2099-01-01', '2099-01-02');
            CREATE TABLE article(id integer PRIMARY KEY, status integer NOT NULL,
                isdeleted boolean NOT NULL, current_revision_id bigint NULL);
            CREATE TABLE article_revision(id bigint PRIMARY KEY, article_id integer NOT NULL,
                created_by_admin_principal_id bigint NOT NULL);
            INSERT INTO article VALUES (1, 0, FALSE, 101), (2, 0, FALSE, 102), (3, 2, FALSE, 103);
            INSERT INTO article_revision VALUES (101, 1, 1), (102, 2, 2), (103, 3, 1);
            """);
        var result = new Case(db, PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString));
        await result.RefreshIdentityAsync(empty);
        return result;
    }

    private sealed class Case : IDisposable
    {
        internal const string Site = "https://author.example.test/blog";

        internal Case(SqlSugarClient db, SqlSugarClient mutator)
        {
            Db = db;
            Mutator = mutator;
            Accessor.HttpContext = new DefaultHttpContext { User = Principal() };
            Authority = new(db, Accessor, Configuration, Clock);
            db.Aop.OnLogExecuting = (sql, _) =>
            {
                if (sql.Contains("AS principal_generation", StringComparison.Ordinal))
                {
                    PrincipalReads++;
                    Action? next = OnNextPrincipalRead;
                    OnNextPrincipalRead = null;
                    next?.Invoke();
                }
            };
            var definition = new ArticlePropertyDefinition(ArticlePropertyDefinitionContract.SchemaVersion,
                Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"), ArticlePropertyDefinitionOwner.User(1, Site),
                "number", [new("en", "Number")], ArticlePropertyValueType.Number, ArticlePropertyCardinality.Single, false,
                new(ArticlePropertyMissingBehavior.PreserveMissing, ArticlePropertyNullBehavior.AllowNull, ArticlePropertyEmptyBehavior.PreserveEmpty),
                null, new(), [], null, null, true, true, false, ArticlePropertyDisplayPlacement.Metadata,
                ArticlePropertyVisibilityScope.AuthorOnly, ArticlePropertyDefinitionStatus.Active, 1,
                Clock.GetUtcNow().UtcDateTime, Clock.GetUtcNow().UtcDateTime, string.Empty);
            Definition = definition with
            {
                ContentDigest = ArticlePropertyDefinitionContract.ComputeDefinitionDigest(definition)
            };
            Definitions = new Dictionary<Guid, ArticlePropertyDefinition> { [Definition.DefinitionId] = Definition };
        }

        internal SqlSugarClient Db
        {
            get;
        }
        internal SqlSugarClient Mutator
        {
            get;
        }
        internal Accessor Accessor { get; } = new();
        internal IConfigurationRoot Configuration
        {
            get;
        } = new ConfigurationBuilder().AddInMemoryCollection(
            new Dictionary<string, string?> { ["SITE_BASEURL"] = Site + "/" }).Build();
        internal TestBusinessTimeProvider Clock { get; } = TestTemporalContext.CreateCanonical().BusinessClock;
        internal SqlAuthorRecentArticleHistoryPermissionAuthority Authority
        {
            get;
        }
        internal ArticlePropertyDefinition Definition
        {
            get;
        }
        internal IReadOnlyDictionary<Guid, ArticlePropertyDefinition> Definitions
        {
            get;
        }
        internal AuthorSearchPermissionIdentity Identity
        {
            get; private set;
        }
        internal Source Source { get; private set; } = new([]);
        internal int PrincipalReads
        {
            get; private set;
        }

        internal Action? OnNextPrincipalRead
        {
            get; set;
        }

        internal void ResetPrincipalReads() => PrincipalReads = 0;

        internal async Task RefreshIdentityAsync(bool empty = false)
        {
            var raw = Assert.IsType<SqlAuthorRecentArticleHistoryPermissionAuthority.FullTextQueryPermissionObservation>(
                await Authority.ObserveFullTextQueryPermissionAsync(new(new(1, Site), Guid.NewGuid(), [])));
            Identity = AuthorFullTextSearchContract.EncodePermissionIdentity(raw);
            Source = new(empty ? [] : [Article(1, 0), Article(2, 0), Article(3, 1)]);
        }

        internal async Task<AuthorFullTextSearchIndex> IndexAsync()
        {
            var index = new AuthorFullTextSearchIndex(Source, 1, Site);
            while (await index.RebuildStepAsync() is not null)
            {
            }
            return index;
        }

        internal AuthorSearchQuery Query(AuthorFullTextSearchIndex index, decimal expected)
            => AuthorFullTextSearchContract.SealQuery(new(AuthorFullTextSearchContract.QuerySchemaVersion,
                AuthorFullTextSearchContract.QuerySchema, AuthorFullTextSearchContract.TokenizerVersion,
                AuthorFullTextSearchContract.RankingVersion, AuthorFullTextSearchContract.IndexOwner,
                Guid.NewGuid(), Identity.UserId, Identity.SiteScope, Identity.PermissionRevision, index.RequireCurrentGeneration(),
                AuthorSearchScope.CurrentArticle, AuthorFullTextSearchContract.ParseClauses("needle",
                    [AuthorFullTextSearchContract.CreatePropertyOperand(Definition, "number.equals", [new ArticlePropertyNumberValue(expected)])]),
                10, null, string.Empty, Identity.PermissionPolicyDigest, index.IndexInstanceId));

        private AuthorSearchIndexArticleSource Article(int id, decimal number)
        {
            long revision = 100 + id;
            var input = new ArticlePropertyValueInput(Definition.DefinitionId, Definition.SchemaRevision, Definition.ContentDigest,
                ArticlePropertyValuePresence.Present, new ArticlePropertyNumberValue(number));
            var entry = new ArticlePropertyValueEntry(input.DefinitionId, input.DefinitionSchemaRevision, input.DefinitionDigest,
                input.Presence, input.Value, ArticlePropertyValueDigest.ComputeValue(input));
            var coordinates = new ArticlePropertySnapshotCoordinates(1, Site, id, 1, revision);
            var values = new ArticlePropertyValueSnapshot(ArticlePropertyValueSnapshot.CurrentSchemaVersion, coordinates, [entry],
                ArticlePropertyValueDigest.ComputeSnapshot(coordinates, [entry]));
            const string Raw = "needle";
            string digest = AuthorFullTextSearchContract.Digest(Raw);
            var document = AuthorFullTextSearchContract.SealDocument(new(AuthorFullTextSearchContract.SchemaVersion,
                AuthorFullTextSearchContract.DocumentSchema, AuthorFullTextSearchContract.TokenizerVersion, AuthorFullTextSearchContract.IndexOwner,
                new(id, 1, Site, revision, revision, Identity.PermissionRevision, 1, "en", id == 3 ? ArticleStatus.Published : ArticleStatus.Draft,
                    AuthorSearchScope.CurrentArticle, AuthorSearchPermissionState.Allowed, AuthorSearchVisibilityScope.AuthorOnly, Identity.PermissionPolicyDigest),
                new(AuthorSearchFieldKind.Title, digest, null, null, null),
                new(AuthorFullTextSearchContract.SourceCoordinateAuthority, "algorithm-fixture-parser", "document:1", revision,
                    digest, 0, Raw.Length, 0, Encoding.UTF8.GetByteCount(Raw)), string.Empty));
            return new(id, revision, false, [new(document, Raw, "algorithm-fixture-parser", "document:1")], Definitions, values);
        }

        internal void Change(string fault)
        {
            string? sql = fault switch
            {
                "revoked" => "UPDATE admin_session SET revokedatutc = TIMESTAMP '2024-01-01'",
                "idle" => "UPDATE admin_session SET idleexpiresatutc = TIMESTAMP '2024-01-01'",
                "absolute" => "UPDATE admin_session SET absoluteexpiresatutc = TIMESTAMP '2024-01-01'",
                "disabled" => "UPDATE admin_principal SET status = 'disabled' WHERE id = 1",
                "session-owner" => "UPDATE admin_session SET adminprincipalid = 2",
                "session-row" => "UPDATE admin_session SET idleexpiresatutc = idleexpiresatutc",
                "principal-row" => "UPDATE admin_principal SET permissions = permissions WHERE id = 1",
                "owner" => "UPDATE article_revision SET created_by_admin_principal_id = 2 WHERE id = 101",
                "archived" => "UPDATE article SET status = 3 WHERE id = 1",
                "revision-row" => "UPDATE article_revision SET article_id = article_id WHERE id = 101",
                _ => null
            };
            if (sql is not null)
            {
                Mutator.Ado.ExecuteCommand(sql);
            }
            else if (fault == "anonymous")
            {
                Accessor.HttpContext!.User = new ClaimsPrincipal(new ClaimsIdentity());
            }
            else if (fault == "claim")
            {
                var identity = (ClaimsIdentity)Accessor.HttpContext!.User.Identity!;
                identity.RemoveClaim(identity.FindFirst(AdminPermissions.PermissionClaimType)!);
            }
            else if (fault == "site")
            {
                Configuration["SITE_BASEURL"] = "https://other.example.test";
            }
            else if (fault == "clock")
            {
                Clock.Advance(TimeSpan.FromDays(365 * 100));
            }
            else if (fault == "context")
            {
                Accessor.HttpContext = new DefaultHttpContext { User = Principal() };
            }
            else
            {
                throw new ArgumentOutOfRangeException(nameof(fault));
            }
        }

        private static ClaimsPrincipal Principal() => new(new ClaimsIdentity(
            [new("identity_kind", "admin_principal"), new("admin_id", "1"), new("admin_sid", "search-session"),
                new(AdminPermissions.PermissionClaimType, AdminPermissions.ArticleWrite)], "test"));

        public void Dispose()
        {
            Db.Dispose();
            Mutator.Dispose();
        }
    }

    private sealed class Accessor : IHttpContextAccessor
    {
        public HttpContext? HttpContext
        {
            get; set;
        }
    }

    private sealed class Source(ImmutableArray<AuthorSearchIndexArticleSource> articles) : IAuthorFullTextSearchIndexSource
    {
        private bool _hold;
        internal TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal void Hold() => _hold = true;
        internal void StopHolding() => _hold = false;

        public async Task<AuthorSearchIndexSourcePage> ReadAsync(int userId, string siteScope, int afterArticleId, int pageSize,
            long? expectedSourceGeneration, CancellationToken cancellationToken)
        {
            if (_hold)
            {
                Entered.TrySetResult();
                await Release.Task.WaitAsync(cancellationToken);
            }
            return new(1, [.. articles.Where(article => article.ArticleId > afterArticleId).Take(pageSize)], false);
        }
    }

    [Theory]
    [InlineData("revoked")]
    [InlineData("session-row")]
    [InlineData("owner")]
    [InlineData("context")]
    public async Task EachSourcePageMustRevalidateBeforeReadingTheNextPage(string change)
    {
        using Case test = await CreateCaseAsync();
        using AuthorFullTextSearchIndex index = await test.IndexAsync();
        var pages = new PagedSource(test.Source, gatePage: 1);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        Task<AuthorSearchTokenEvaluation> pending = new AuthorFullTextSearchQueryEvaluator(index).InspectIndexAsync(
            test.Query(index, 0), test.Definitions, pages, test.Authority, timeout.Token);
        try
        {
            await pages.Entered.Task.WaitAsync(timeout.Token);
            Assert.False(pending.IsCompleted);
            test.Change(change);
            pages.Release.TrySetResult();
            Assert.Equal("author_search_current_permission_unavailable",
                (await Assert.ThrowsAsync<AuthorSearchContractException>(() => pending)).Message);
            Assert.Equal(1, pages.ReadCount);
        }
        finally
        {
            pages.Release.TrySetResult();
            _ = await Record.ExceptionAsync(() => pending);
        }
    }

    [Fact]
    public async Task RevocationAfterFirstPageTakesPriorityOverLaterSourceFailure()
    {
        using Case test = await CreateCaseAsync();
        using AuthorFullTextSearchIndex index = await test.IndexAsync();
        var pages = new PagedSource(test.Source, gatePage: 1, errorPage: 2);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        Task<AuthorSearchTokenEvaluation> pending = new AuthorFullTextSearchQueryEvaluator(index).InspectIndexAsync(
            test.Query(index, 0), test.Definitions, pages, test.Authority, timeout.Token);
        try
        {
            await pages.Entered.Task.WaitAsync(timeout.Token);
            test.Change("revoked");
            pages.Release.TrySetResult();
            Assert.Equal("author_search_current_permission_unavailable",
                (await Assert.ThrowsAsync<AuthorSearchContractException>(() => pending)).Message);
            Assert.Equal(1, pages.ReadCount);
        }
        finally
        {
            pages.Release.TrySetResult();
            _ = await Record.ExceptionAsync(() => pending);
        }
    }

    /// <summary>
    /// Real verifier pagination over the original algorithm fixture. Only test source
    /// I/O is synthetic; actual SQL authority, row mutations and issuer stay unchanged.
    /// The gate deliberately ignores cancellation so the consumer must enforce it.
    /// </summary>
    private sealed class PagedSource(Source original, int gatePage = 0, int errorPage = 0)
        : IAuthorFullTextSearchIndexSource
    {
        internal TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal int ReadCount
        {
            get; private set;
        }
        internal InvalidOperationException Error { get; } = new("synthetic page I/O failure");
        internal int MalformedPage
        {
            get; set;
        }
        internal int LookupPage
        {
            get; set;
        }
        internal Action? OnDefinitionLookup
        {
            get; set;
        }

        public async Task<AuthorSearchIndexSourcePage> ReadAsync(int userId, string siteScope, int afterArticleId,
            int pageSize, long? expectedSourceGeneration, CancellationToken cancellationToken)
        {
            int page = ++ReadCount;
            if (page == gatePage)
            {
                Entered.TrySetResult();
                await Release.Task.ConfigureAwait(false);
            }
            if (page == errorPage)
            {
                throw Error;
            }
            AuthorSearchIndexSourcePage source = await original.ReadAsync(userId, siteScope, afterArticleId,
                1, expectedSourceGeneration, cancellationToken).ConfigureAwait(false);
            if (page == LookupPage)
            {
                AuthorSearchIndexArticleSource article = source.Articles.Single();
                source = source with
                {
                    Articles = [article with { Definitions = new LookupDefinitions(article.Definitions, OnDefinitionLookup!) }]
                };
            }
            return source with
            {
                HasMore = source.Articles.Single().ArticleId < 3,
                SourceGeneration = page == MalformedPage ? source.SourceGeneration + 1 : source.SourceGeneration
            };
        }
    }

    [Theory]
    [InlineData(0, 1)]
    [InlineData(1, 3)]
    public async Task AuthorizedPaginationPreservesOriginalOwnershipTypedPredicateAndPageTrimming(int value, int articleId)
    {
        using Case test = await CreateCaseAsync();
        using AuthorFullTextSearchIndex index = await test.IndexAsync();
        var pages = new PagedSource(test.Source);
        AuthorSearchQuery query = AuthorFullTextSearchContract.SealQuery(test.Query(index, value) with
        {
            PageSize = 1
        });
        AuthorSearchTokenEvaluation result = await new AuthorFullTextSearchQueryEvaluator(index)
            .InspectIndexAsync(query, test.Definitions, pages, test.Authority);
        Assert.Equal(articleId, Assert.Single(result.Candidates).Document.Identity.ArticleId);
        Assert.Equal(3, pages.ReadCount);
    }

    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    public async Task AuthorizedSourceErrorsRetainTheirOriginalException(int page)
    {
        using Case test = await CreateCaseAsync();
        using AuthorFullTextSearchIndex index = await test.IndexAsync();
        var pages = new PagedSource(test.Source, errorPage: page);
        Exception error = await Assert.ThrowsAsync<InvalidOperationException>(() => new AuthorFullTextSearchQueryEvaluator(index)
            .InspectIndexAsync(test.Query(index, 0), test.Definitions, pages, test.Authority));
        Assert.Same(pages.Error, error);
        Assert.Equal(page, pages.ReadCount);
    }

    [Theory]
    [InlineData(1, "throw")]
    [InlineData(3, "throw")]
    [InlineData(1, "generation")]
    [InlineData(3, "generation")]
    public async Task RevocationWinsAtThrowingAndMalformedPageBoundariesIncludingTheTerminalPage(int page, string fault)
    {
        using Case test = await CreateCaseAsync();
        using AuthorFullTextSearchIndex index = await test.IndexAsync();
        var pages = new PagedSource(test.Source, page, fault == "throw" ? page : 0)
        {
            MalformedPage = fault == "generation" ? page : 0
        };
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        Task<AuthorSearchTokenEvaluation> pending = new AuthorFullTextSearchQueryEvaluator(index).InspectIndexAsync(
            test.Query(index, 99), test.Definitions, pages, test.Authority, timeout.Token);
        try
        {
            await pages.Entered.Task.WaitAsync(timeout.Token);
            test.Change("revoked");
            pages.Release.TrySetResult();
            Assert.Equal("author_search_current_permission_unavailable",
                (await Assert.ThrowsAsync<AuthorSearchContractException>(() => pending)).Message);
            Assert.Equal(page, pages.ReadCount);
        }
        finally
        {
            pages.Release.TrySetResult();
            _ = await Record.ExceptionAsync(() => pending);
        }
    }

    [Theory]
    [InlineData("normal")]
    [InlineData("throw")]
    [InlineData("generation")]
    public async Task CancellationWinsAtTheTerminalReadEvenWhenSourceIgnoresItsToken(string fault)
    {
        using Case test = await CreateCaseAsync();
        using AuthorFullTextSearchIndex index = await test.IndexAsync();
        var pages = new PagedSource(test.Source, 3, fault == "throw" ? 3 : 0)
        {
            MalformedPage = fault == "generation" ? 3 : 0
        };
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        Task<AuthorSearchTokenEvaluation> pending = new AuthorFullTextSearchQueryEvaluator(index).InspectIndexAsync(
            test.Query(index, 99), test.Definitions, pages, test.Authority, cancellation.Token);
        try
        {
            await pages.Entered.Task.WaitAsync(deadline.Token);
            test.Change("revoked");
            cancellation.Cancel();
            pages.Release.TrySetResult();
            var error = await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending);
            Assert.Equal(cancellation.Token, error.CancellationToken);
            Assert.Equal(3, pages.ReadCount);
        }
        finally
        {
            pages.Release.TrySetResult();
            _ = await Record.ExceptionAsync(() => pending);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task DriftWhileProcessingAPageMustBeCheckedBeforeTheNextSourceRead(bool cancel)
    {
        using Case test = await CreateCaseAsync();
        using AuthorFullTextSearchIndex index = await test.IndexAsync();
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        bool changed = false;
        var pages = new PagedSource(test.Source)
        {
            LookupPage = 1,
            OnDefinitionLookup = () =>
            {
                changed = true;
                if (cancel)
                {
                    cancellation.Cancel();
                }
                else
                {
                    test.Change("revoked");
                }
            }
        };
        Task<AuthorSearchTokenEvaluation> pending = new AuthorFullTextSearchQueryEvaluator(index).InspectIndexAsync(
            test.Query(index, 99), test.Definitions, pages, test.Authority, cancellation.Token);
        if (cancel)
        {
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending);
        }
        else
        {
            Assert.Equal("author_search_current_permission_unavailable",
                (await Assert.ThrowsAsync<AuthorSearchContractException>(() => pending)).Message);
        }
        Assert.True(changed);
        Assert.Equal(1, pages.ReadCount);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task TerminalVerifierFailureStillRevalidatesActualAuthorityAndCancellation(bool cancel)
    {
        using Case test = await CreateCaseAsync();
        using AuthorFullTextSearchIndex index = await test.IndexAsync();
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        bool changed = false;
        var pages = new PagedSource(test.Source) { LookupPage = 3 };
        pages.OnDefinitionLookup = () =>
        {
            changed = true;
            test.Change("revoked");
            if (cancel)
            {
                cancellation.Cancel();
            }
            throw pages.Error;
        };
        Task<AuthorSearchTokenEvaluation> pending = new AuthorFullTextSearchQueryEvaluator(index).InspectIndexAsync(
            test.Query(index, 99), test.Definitions, pages, test.Authority, cancellation.Token);
        if (cancel)
        {
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending);
        }
        else
        {
            Assert.Equal("author_search_current_permission_unavailable",
                (await Assert.ThrowsAsync<AuthorSearchContractException>(() => pending)).Message);
        }
        Assert.True(changed);
        Assert.Equal(3, pages.ReadCount);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task EveryPageChecksOriginalIndexGenerationEvenWhenSourceThrows(bool fail)
    {
        using Case test = await CreateCaseAsync();
        using AuthorFullTextSearchIndex index = await test.IndexAsync();
        var pages = new PagedSource(test.Source, 1, fail ? 1 : 0);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        Task<AuthorSearchTokenEvaluation> pending = new AuthorFullTextSearchQueryEvaluator(index).InspectIndexAsync(
            test.Query(index, 0), test.Definitions, pages, test.Authority, timeout.Token);
        try
        {
            await pages.Entered.Task.WaitAsync(timeout.Token);
            while (await index.RebuildStepAsync(cancellationToken: timeout.Token) is not null)
            {
            }
            pages.Release.TrySetResult();
            Assert.Equal("author_search_index_source_snapshot_stale",
                (await Assert.ThrowsAsync<AuthorSearchContractException>(() => pending)).Message);
            Assert.Equal(1, pages.ReadCount);
        }
        finally
        {
            pages.Release.TrySetResult();
            _ = await Record.ExceptionAsync(() => pending);
        }
    }

    /// <summary>Runs a real SQL/cancellation mutation during synchronous verifier processing, after a page's I/O fence.</summary>
    private sealed class LookupDefinitions(IReadOnlyDictionary<Guid, ArticlePropertyDefinition> definitions, Action onLookup)
        : IReadOnlyDictionary<Guid, ArticlePropertyDefinition>
    {
        private Action? _onLookup = onLookup;
        public int Count => definitions.Count;
        public IEnumerable<Guid> Keys => definitions.Keys;
        public IEnumerable<ArticlePropertyDefinition> Values => definitions.Values;
        public ArticlePropertyDefinition this[Guid key]
        {
            get
            {
                Interlocked.Exchange(ref _onLookup, null)?.Invoke();
                return definitions[key];
            }
        }
        public bool ContainsKey(Guid key) => definitions.ContainsKey(key);
        public bool TryGetValue(Guid key, out ArticlePropertyDefinition value)
        {
            Interlocked.Exchange(ref _onLookup, null)?.Invoke();
            return definitions.TryGetValue(key, out value!);
        }
        public IEnumerator<KeyValuePair<Guid, ArticlePropertyDefinition>> GetEnumerator() => definitions.GetEnumerator();
        System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() => GetEnumerator();
    }
}
