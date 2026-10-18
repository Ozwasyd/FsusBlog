using System.Security.Claims;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;

using SqlSugar;

using static FsusBlog.Server.Services.Authoring.SqlAuthorRecentArticleHistoryPermissionAuthority;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class AuthorFullTextCurrentAuthPostgresTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task Observation_ReadsRawXminAndOnlyOwnedCurrentArticlesOnConfiguredSite()
    {
        using Case test = await CreateCaseAsync();
        FullTextQueryPermissionObservation observed = Assert.IsType<FullTextQueryPermissionObservation>(
            await test.Authority.ObserveFullTextQueryPermissionAsync(test.Request([1, 2, 3, 4, 5, 6, 7])));
        Assert.Equal(test.Db.Ado.GetLong("SELECT xmin::text::bigint FROM admin_principal WHERE id = 1"),
            observed.ActorState.PrincipalGeneration);
        Assert.Equal(test.Db.Ado.GetLong("SELECT xmin::text::bigint FROM admin_session WHERE sessionid = 'search-session'"),
            observed.ActorState.SessionGeneration);
        Assert.Equal("https://author.example.test/blog", observed.Owner.SiteScope);
        Assert.Equal(new[] { 1, 2, 3 }, observed.Articles.Select(static article => article.ArticleId));
        Assert.Equal(new[] { ArticleStatus.Draft, ArticleStatus.Scheduled, ArticleStatus.Published },
            observed.Articles.Select(static article => article.Status));
        Assert.All(observed.Articles, article =>
        {
            Assert.True(article.CurrentRevisionId > 0);
            Assert.True(article.ArticleGeneration > 0);
            Assert.True(article.RevisionGeneration > 0);
            Assert.True(article.OwnershipGeneration > 0);
        });
        Assert.True(await test.Authority.RevalidateFullTextQueryPermissionAsync(observed));
        Assert.Equal(6, test.PrincipalReads);
        Assert.Equal(4, test.ArticleReads);
    }

    [Theory]
    [InlineData("anonymous")]
    [InlineData("ordinary-user")]
    [InlineData("actor")]
    [InlineData("session")]
    [InlineData("site")]
    [InlineData("claim")]
    [InlineData("disabled")]
    [InlineData("persisted-permission")]
    [InlineData("revoked")]
    [InlineData("idle-expired")]
    [InlineData("absolute-expired")]
    [InlineData("session-owner")]
    [InlineData("missing-principal")]
    [InlineData("missing-session")]
    public async Task EmptyCorpus_StillRequiresRealActorSessionAndSite(string fault)
    {
        using Case test = await CreateCaseAsync();
        test.Change(fault);
        Assert.Null(await test.Authority.ObserveFullTextQueryPermissionAsync(test.Request([])));
        Assert.Equal(0, test.ArticleReads);
    }

    [Fact]
    public async Task EmptyCorpus_AndAllDeniedCorpusStillReadAuthThreeTimes()
    {
        using Case test = await CreateCaseAsync();
        FullTextQueryPermissionObservation empty = Assert.IsType<FullTextQueryPermissionObservation>(
            await test.Authority.ObserveFullTextQueryPermissionAsync(test.Request([])));
        Assert.Empty(empty.Articles);
        Assert.Equal(3, test.PrincipalReads);
        Assert.Equal(0, test.ArticleReads);
        FullTextQueryPermissionObservation denied = Assert.IsType<FullTextQueryPermissionObservation>(
            await test.Authority.ObserveFullTextQueryPermissionAsync(test.Request([4, 5, 6, 7, 999])));
        Assert.Empty(denied.Articles);
        Assert.Equal(6, test.PrincipalReads);
        Assert.Equal(2, test.ArticleReads);
    }

    [Fact]
    public async Task RootPermission_DoesNotRemoveAuthorOnlyOwnershipBoundary()
    {
        using Case test = await CreateCaseAsync();
        test.Mutator.Ado.ExecuteCommand("UPDATE admin_principal SET isroot = TRUE, permissions = '' WHERE id = 1");
        FullTextQueryPermissionObservation observed = Assert.IsType<FullTextQueryPermissionObservation>(
            await test.Authority.ObserveFullTextQueryPermissionAsync(test.Request([1, 4])));
        Assert.Equal(1, Assert.Single(observed.Articles).ArticleId);
    }

    [Theory]
    [InlineData("disabled")]
    [InlineData("persisted-permission")]
    [InlineData("revoked")]
    [InlineData("idle-expired")]
    [InlineData("absolute-expired")]
    [InlineData("owner")]
    [InlineData("delete")]
    [InlineData("archived")]
    [InlineData("unknown-status")]
    [InlineData("revision")]
    [InlineData("revision-row")]
    [InlineData("principal-row")]
    [InlineData("session-row")]
    [InlineData("claim")]
    [InlineData("actor")]
    [InlineData("site")]
    [InlineData("context")]
    [InlineData("clock")]
    public async Task Revalidation_RejectsActualAuthorityOrArticleDrift(string fault)
    {
        using Case test = await CreateCaseAsync();
        FullTextQueryPermissionObservation observed = Assert.IsType<FullTextQueryPermissionObservation>(
            await test.Authority.ObserveFullTextQueryPermissionAsync(test.Request([1])));
        test.Change(fault);
        Assert.False(await test.Authority.RevalidateFullTextQueryPermissionAsync(observed));
    }

    public static IEnumerable<object[]> AwaitBoundaryCases()
    {
        string[] faults = ["revoked", "clock", "owner", "delete", "archived", "principal-row", "claim", "site"];
        foreach (int boundary in new[] { 2, 3, 4, 5 })
        {
            foreach (string fault in faults)
            {
                yield return [boundary, fault];
            }
        }
    }

    [Theory]
    [MemberData(nameof(AwaitBoundaryCases))]
    public async Task SqlAwaitBoundaries_RejectConcurrentCommitsBeforeSearchAdmission(int boundary, string fault)
    {
        using Case test = await CreateCaseAsync();
        int commands = 0;
        bool changed = false;
        test.BeforeRead = () =>
        {
            if (++commands == boundary)
            {
                test.Change(fault);
                changed = true;
            }
        };
        FullTextQueryPermissionObservation? observed = await test.Authority.ObserveFullTextQueryPermissionAsync(
            test.Request([1]));
        Assert.True(changed);
        test.BeforeRead = null;
        // A loss before the first article read yields no readable facts. A later
        // commit must invalidate the held facts at the mandatory pre-output fence.
        // Neither outcome admits a search result, total, facet or snippet.
        Assert.True(observed is null || observed.Articles.IsEmpty
            || !await test.Authority.RevalidateFullTextQueryPermissionAsync(observed));
    }

    [Fact]
    public async Task OwnershipWitness_AndCurrentRevisionMustBelongToTheSameArticle()
    {
        using Case test = await CreateCaseAsync();
        test.Mutator.Ado.ExecuteCommand("UPDATE article SET current_revision_id = 104 WHERE id = 1");
        FullTextQueryPermissionObservation observed = Assert.IsType<FullTextQueryPermissionObservation>(
            await test.Authority.ObserveFullTextQueryPermissionAsync(test.Request([1])));
        Assert.Empty(observed.Articles);
    }

    [Fact]
    public async Task Revalidation_RejectsForeignIssuerAndCallerFabricationWithoutSql()
    {
        using Case test = await CreateCaseAsync();
        FullTextQueryPermissionObservation observed = Assert.IsType<FullTextQueryPermissionObservation>(
            await test.Authority.ObserveFullTextQueryPermissionAsync(test.Request([1])));
        var other = new SqlAuthorRecentArticleHistoryPermissionAuthority(test.Db, test.Accessor, test.Configuration, test.Clock);
        Assert.False(await other.RevalidateFullTextQueryPermissionAsync(observed));
        var fabricated = new FullTextQueryPermissionObservation(new object(), observed.Owner, observed.RequestId,
            observed.ArticleIds, observed.ActorContext, observed.ActorState, observed.Articles);
        Assert.False(await test.Authority.RevalidateFullTextQueryPermissionAsync(fabricated));
        Assert.Equal(3, test.PrincipalReads);
        Assert.Equal(2, test.ArticleReads);
    }

    [Fact]
    public async Task PrincipalAndOwnerAba_RejectsRestoredValuesBecauseRawXminChanged()
    {
        using Case test = await CreateCaseAsync();
        FullTextQueryPermissionObservation observed = Assert.IsType<FullTextQueryPermissionObservation>(
            await test.Authority.ObserveFullTextQueryPermissionAsync(test.Request([1])));
        test.Mutator.Ado.ExecuteCommand("UPDATE admin_principal SET permissions = '' WHERE id = 1");
        test.Mutator.Ado.ExecuteCommand("UPDATE admin_principal SET permissions = 'article.write' WHERE id = 1");
        Assert.False(await test.Authority.RevalidateFullTextQueryPermissionAsync(observed));
        FullTextQueryPermissionObservation refreshed = Assert.IsType<FullTextQueryPermissionObservation>(
            await test.Authority.ObserveFullTextQueryPermissionAsync(test.Request([1])));
        test.Mutator.Ado.ExecuteCommand("UPDATE article_revision SET created_by_admin_principal_id = 2 WHERE id = 101");
        test.Mutator.Ado.ExecuteCommand("UPDATE article_revision SET created_by_admin_principal_id = 1 WHERE id = 101");
        Assert.False(await test.Authority.RevalidateFullTextQueryPermissionAsync(refreshed));
    }

    [Fact]
    public async Task AmbientTransaction_CannotFreezeAnOldAuthorizationSnapshot()
    {
        using Case test = await CreateCaseAsync();
        test.Db.Ado.BeginTran(System.Data.IsolationLevel.RepeatableRead);
        try
        {
            Assert.Null(await test.Authority.ObserveFullTextQueryPermissionAsync(test.Request([1])));
            Assert.Equal(0, test.PrincipalReads);
        }
        finally
        {
            test.Db.Ado.RollbackTran();
        }
    }

    [Fact]
    public async Task BoundsAndCancellation_FailBeforeSql()
    {
        using Case test = await CreateCaseAsync();
        Assert.Null(await test.Authority.ObserveFullTextQueryPermissionAsync(test.Request([1, 1])));
        Assert.Null(await test.Authority.ObserveFullTextQueryPermissionAsync(test.Request([0])));
        Assert.Null(await test.Authority.ObserveFullTextQueryPermissionAsync(test.Request(Enumerable.Range(1, 10_001).ToArray())));
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => test.Authority.ObserveFullTextQueryPermissionAsync(
            test.Request([]), cancellation.Token));
        Assert.Equal(0, test.PrincipalReads);
    }

    [Fact]
    public async Task CancellationDuringSqlAwait_CannotReturnAnObservation()
    {
        using Case test = await CreateCaseAsync();
        using var cancellation = new CancellationTokenSource();
        test.BeforeRead = cancellation.Cancel;
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => test.Authority.ObserveFullTextQueryPermissionAsync(
            test.Request([1]), cancellation.Token));
        Assert.Equal(0, test.ArticleReads);
    }

    [Fact]
    public async Task RawAdminActor_IsNotTruncatedToTheSearchUserIdContract()
    {
        using Case test = await CreateCaseAsync();
        const long PrincipalId = 3_221_225_471;
        test.Mutator.Ado.ExecuteCommand(
            """
            UPDATE admin_principal SET id = 3221225471 WHERE id = 1;
            UPDATE admin_session SET adminprincipalid = 3221225471;
            UPDATE article_revision SET created_by_admin_principal_id = 3221225471
                WHERE created_by_admin_principal_id = 1;
            """);
        ClaimsIdentity identity = (ClaimsIdentity)test.Accessor.HttpContext!.User.Identity!;
        identity.RemoveClaim(identity.FindFirst("admin_id")!);
        identity.AddClaim(new("admin_id", "3221225471"));
        var request = new AuthorRecentArticleHistoryPermissionRequest(
            new(PrincipalId, "https://author.example.test/blog"), Guid.CreateVersion7(), [1]);
        FullTextQueryPermissionObservation observed = Assert.IsType<FullTextQueryPermissionObservation>(
            await test.Authority.ObserveFullTextQueryPermissionAsync(request));
        Assert.Equal(PrincipalId, observed.Owner.AdminPrincipalId);
        Assert.Single(observed.Articles);
        Assert.True(await test.Authority.RevalidateFullTextQueryPermissionAsync(observed));
    }

    [Fact]
    public async Task TenThousandArticles_RemainBoundedAndCurrentWithoutReadingBodies()
    {
        using Case test = await CreateCaseAsync();
        test.Mutator.Ado.ExecuteCommand(
            """
            INSERT INTO article(id, status, isdeleted, current_revision_id)
                SELECT n, 0, FALSE, 100000 + n FROM generate_series(10, 10009) n;
            INSERT INTO article_revision(id, article_id, created_by_admin_principal_id)
                SELECT 100000 + n, n, 1 FROM generate_series(10, 10009) n;
            """);
        FullTextQueryPermissionObservation observed = Assert.IsType<FullTextQueryPermissionObservation>(
            await test.Authority.ObserveFullTextQueryPermissionAsync(test.Request(Enumerable.Range(10, 10_000).ToArray())));
        Assert.Equal(10_000, observed.Articles.Length);
        Assert.Equal(3, test.PrincipalReads);
        Assert.Equal(2, test.ArticleReads);
    }

    private async Task<Case> CreateCaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
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
            CREATE INDEX ownership_lookup ON article_revision(article_id, created_by_admin_principal_id, id);
            INSERT INTO article VALUES (1, 0, FALSE, 101), (2, 1, FALSE, 102), (3, 2, FALSE, 103),
                (4, 0, FALSE, 104), (5, 3, FALSE, 105), (6, 0, TRUE, 106), (7, 91, FALSE, 107);
            INSERT INTO article_revision VALUES (101, 1, 1), (102, 2, 1), (103, 3, 1),
                (104, 4, 2), (105, 5, 1), (106, 6, 1), (107, 7, 1);
            """);
        return new Case(db, PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString));
    }

    private sealed class Case : IDisposable
    {
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
                    BeforeRead?.Invoke();
                }
                else if (sql.Contains("ownership_revision_id", StringComparison.Ordinal))
                {
                    ArticleReads++;
                    BeforeRead?.Invoke();
                }
            };
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
            new Dictionary<string, string?> { ["SITE_BASEURL"] = "https://author.example.test/blog/" }).Build();
        internal TestBusinessTimeProvider Clock { get; } = TestTemporalContext.CreateCanonical().BusinessClock;
        internal SqlAuthorRecentArticleHistoryPermissionAuthority Authority
        {
            get;
        }
        internal int PrincipalReads
        {
            get; private set;
        }
        internal int ArticleReads
        {
            get; private set;
        }
        internal Action? BeforeRead
        {
            get; set;
        }

        internal AuthorRecentArticleHistoryPermissionRequest Request(int[] ids)
            => new(new(1, "https://author.example.test/blog"), Guid.CreateVersion7(), ids);

        internal void Change(string fault)
        {
            string? sql = fault switch
            {
                "disabled" => "UPDATE admin_principal SET status = 'disabled' WHERE id = 1",
                "persisted-permission" => "UPDATE admin_principal SET permissions = '' WHERE id = 1",
                "revoked" => "UPDATE admin_session SET revokedatutc = TIMESTAMP '2024-01-01'",
                "idle-expired" => "UPDATE admin_session SET idleexpiresatutc = TIMESTAMP '2024-01-01'",
                "absolute-expired" => "UPDATE admin_session SET absoluteexpiresatutc = TIMESTAMP '2024-01-01'",
                "session-owner" => "UPDATE admin_session SET adminprincipalid = 2",
                "missing-principal" => "DELETE FROM admin_principal WHERE id = 1",
                "missing-session" => "DELETE FROM admin_session",
                "owner" => "UPDATE article_revision SET created_by_admin_principal_id = 2 WHERE id = 101",
                "delete" => "UPDATE article SET isdeleted = TRUE WHERE id = 1",
                "archived" => "UPDATE article SET status = 3 WHERE id = 1",
                "unknown-status" => "UPDATE article SET status = 99 WHERE id = 1",
                "revision" => "UPDATE article SET current_revision_id = NULL WHERE id = 1",
                "revision-row" => "UPDATE article_revision SET article_id = article_id WHERE id = 101",
                "principal-row" => "UPDATE admin_principal SET permissions = permissions WHERE id = 1",
                "session-row" => "UPDATE admin_session SET idleexpiresatutc = idleexpiresatutc",
                _ => null
            };
            if (sql is not null)
            {
                Mutator.Ado.ExecuteCommand(sql);
                return;
            }
            ClaimsIdentity identity = (ClaimsIdentity)Accessor.HttpContext!.User.Identity!;
            switch (fault)
            {
                case "anonymous":
                    Accessor.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity());
                    break;
                case "ordinary-user":
                    identity.RemoveClaim(identity.FindFirst("identity_kind")!);
                    break;
                case "actor":
                    identity.RemoveClaim(identity.FindFirst("admin_id")!);
                    identity.AddClaim(new("admin_id", "2"));
                    break;
                case "session":
                    identity.RemoveClaim(identity.FindFirst("admin_sid")!);
                    identity.AddClaim(new("admin_sid", "other-session"));
                    break;
                case "claim":
                    identity.RemoveClaim(identity.FindFirst(AdminPermissions.PermissionClaimType)!);
                    break;
                case "site":
                    Configuration["SITE_BASEURL"] = "https://other.example.test";
                    break;
                case "context":
                    Accessor.HttpContext = new DefaultHttpContext { User = Principal() };
                    break;
                case "clock":
                    Clock.Advance(TimeSpan.FromDays(365 * 100));
                    break;
                default:
                    throw new ArgumentOutOfRangeException(nameof(fault));
            }
        }

        private static ClaimsPrincipal Principal() => new(new ClaimsIdentity(
        [
            new("identity_kind", "admin_principal"), new("admin_id", "1"), new("admin_sid", "search-session"),
            new(AdminPermissions.PermissionClaimType, AdminPermissions.ArticleWrite)
        ], "test"));

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
}
