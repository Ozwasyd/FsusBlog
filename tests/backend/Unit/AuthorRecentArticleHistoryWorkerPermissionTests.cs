using System.Data;
using System.Security.Claims;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Services.Authoring;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class AuthorRecentArticleHistoryWorkerPermissionTests
{
    private const string SiteScope = "https://example.test";
    private const string SessionId = "server-captured-admin-session";
    private static readonly DateTimeOffset s_now = new(2026, 10, 8, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public async Task Worker_ReusesBoundSqlAuthorityWithoutReadingHttpContext()
    {
        var fixture = new Fixture();
        AuthorRecentArticleHistoryPermissionSnapshot result = await fixture.Authority.ResolveForSessionAsync(
            Request([1, 2, 3, 4]), SessionId);

        Assert.Equal(AuthorRecentArticleHistoryPermissionSnapshotStatus.Current, result.Status);
        Assert.Equal(0, fixture.Context.ReadCount);
        Assert.Equal(2, fixture.Queries.Count);
        Assert.Contains("s.adminprincipalid = ap.id", fixture.Queries[0].Sql, StringComparison.Ordinal);
        Assert.Contains(fixture.Queries[0].Parameters, parameter =>
            parameter.ParameterName == "@AdminPrincipalId" && Equals(parameter.Value, 7L));
        Assert.Contains(fixture.Queries[0].Parameters, parameter =>
            parameter.ParameterName == "@SessionId" && Equals(parameter.Value, SessionId));
        Assert.Contains(fixture.Queries[1].Parameters, parameter =>
            parameter.ParameterName == "@ArticleIds" && Equals(parameter.Value, "{1,2,3,4}"));
        Assert.True(result.Decisions.Single(decision => decision.ArticleId == 1).CanWrite);
        Assert.All(result.Decisions.Where(decision => decision.ArticleId != 1), decision =>
        {
            Assert.False(decision.CanProject);
            Assert.False(decision.CanWrite);
        });
        Assert.Equal(AuthorRecentArticleHistoryContract.ComputePermissionDigest(result), result.ContentDigest);
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("inactive")]
    [InlineData("no-permission")]
    [InlineData("revoked")]
    [InlineData("idle-expired")]
    [InlineData("absolute-expired")]
    public async Task Worker_DeniedLiveSessionNeverReadsArticles(string condition)
    {
        var fixture = new Fixture(condition);
        AuthorRecentArticleHistoryPermissionSnapshot result = await fixture.Authority.ResolveForSessionAsync(
            Request([1]), SessionId);

        Assert.Equal(AuthorRecentArticleHistoryPermissionSnapshotStatus.Unavailable, result.Status);
        Assert.Empty(result.Decisions);
        Assert.Single(fixture.Queries);
        Assert.Equal(0, fixture.Context.ReadCount);
    }

    [Theory]
    [InlineData("")]
    [InlineData(" ")]
    [InlineData(" session")]
    [InlineData("session ")]
    [InlineData("session\ncontrol")]
    public async Task Worker_InvalidCapturedSessionNeverQueriesDatabase(string sessionId)
    {
        var fixture = new Fixture();
        AuthorRecentArticleHistoryPermissionSnapshot result = await fixture.Authority.ResolveForSessionAsync(
            Request([1]), sessionId);

        Assert.Equal(AuthorRecentArticleHistoryPermissionSnapshotStatus.Unavailable, result.Status);
        Assert.Empty(fixture.Queries);
        Assert.Equal(0, fixture.Context.ReadCount);
    }

    [Fact]
    public async Task Worker_ForeignScopeAndInvalidArticleSetNeverQueryDatabase()
    {
        var fixture = new Fixture();
        foreach (AuthorRecentArticleHistoryPermissionRequest request in new[]
        {
            Request([1]) with { Owner = new(7, "https://other.test") },
            Request([1, 1]),
            Request([0]),
            Request(Enumerable.Range(1, AuthorRecentArticleHistoryContract.MaxEntriesPerOwner + 1).ToArray())
        })
        {
            AuthorRecentArticleHistoryPermissionSnapshot result = await fixture.Authority.ResolveForSessionAsync(
                request, SessionId);
            Assert.Equal(AuthorRecentArticleHistoryPermissionSnapshotStatus.Unavailable, result.Status);
            Assert.Empty(result.Decisions);
        }
        Assert.Empty(fixture.Queries);
    }

    [Fact]
    public async Task Worker_AlreadyCancelledNeverQueriesDatabase()
    {
        var fixture = new Fixture();
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => fixture.Authority.ResolveForSessionAsync(
            Request([1]), SessionId, cancellation.Token));
        Assert.Empty(fixture.Queries);
    }

    [Theory]
    [InlineData("missing-context")]
    [InlineData("unauthenticated")]
    [InlineData("account-identity")]
    [InlineData("foreign-owner")]
    [InlineData("no-claim-permission")]
    [InlineData("missing-admin-session")]
    public async Task Endpoint_StillRequiresItsAuthenticatedHttpContext(string condition)
    {
        var fixture = new Fixture();
        if (condition != "missing-context")
        {
            var claims = new List<Claim>
            {
                new("identity_kind", condition == "account-identity" ? "anonymous_account" : "admin_principal"),
                new("admin_id", condition == "foreign-owner" ? "8" : "7"),
                new("sid", "ordinary-account-session")
            };
            if (condition != "missing-admin-session")
            {
                claims.Add(new("admin_sid", SessionId));
            }
            if (condition != "no-claim-permission")
            {
                claims.Add(new(AdminPermissions.PermissionClaimType, AdminPermissions.ArticleWrite));
            }
            fixture.Context.HttpContext = new DefaultHttpContext
            {
                User = new ClaimsPrincipal(new ClaimsIdentity(claims,
                    condition == "unauthenticated" ? null : "controlled-test"))
            };
        }

        AuthorRecentArticleHistoryPermissionSnapshot result = await fixture.Authority.ResolveAsync(Request([1]));

        Assert.Equal(AuthorRecentArticleHistoryPermissionSnapshotStatus.Unavailable, result.Status);
        Assert.Empty(fixture.Queries);
        Assert.Equal(1, fixture.Context.ReadCount);
    }

    private static AuthorRecentArticleHistoryPermissionRequest Request(int[] articleIds)
        => new(new(7, SiteScope), Guid.CreateVersion7(), articleIds);

    private sealed class Fixture
    {
        public TrackingContextAccessor Context { get; } = new();
        public List<(string Sql, SugarParameter[] Parameters)> Queries { get; } = [];
        public SqlAuthorRecentArticleHistoryPermissionAuthority Authority { get; }

        public Fixture(string condition = "current")
        {
            var db = Substitute.For<ISqlSugarClient>();
            var ado = Substitute.For<IAdo>();
            db.Ado.Returns(ado);
            ado.GetDataReaderAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>()).Returns(call =>
            {
                string sql = call.ArgAt<string>(0);
                Queries.Add((sql, call.ArgAt<SugarParameter[]>(1)));
                DataTable table = sql.Contains("FROM admin_principal", StringComparison.Ordinal)
                    ? SessionTable(condition)
                    : ArticleTable();
                return Task.FromResult((IDataReader)table.CreateDataReader());
            });
            IConfiguration configuration = new ConfigurationBuilder().AddInMemoryCollection(
                new Dictionary<string, string?> { ["SITE_BASEURL"] = $" {SiteScope}/ " }).Build();
            Authority = new(db, Context, configuration, new FixedClock());
        }

        private static DataTable SessionTable(string condition)
        {
            var table = new DataTable();
            table.Columns.Add("principal_status", typeof(string));
            table.Columns.Add("isroot", typeof(bool));
            table.Columns.Add("permissions", typeof(string));
            table.Columns.Add("principal_row_version", typeof(string));
            table.Columns.Add("revokedatutc", typeof(DateTime));
            table.Columns.Add("idleexpiresatutc", typeof(DateTime));
            table.Columns.Add("absoluteexpiresatutc", typeof(DateTime));
            table.Columns.Add("session_row_version", typeof(string));
            if (condition != "missing")
            {
                table.Rows.Add(
                    condition == "inactive" ? "disabled" : AdminPrincipalStatus.Active,
                    false,
                    condition == "no-permission" ? string.Empty : AdminPermissions.ArticleWrite,
                    "11",
                    condition == "revoked" ? s_now.UtcDateTime : DBNull.Value,
                    condition == "idle-expired" ? s_now.UtcDateTime : s_now.AddHours(1).UtcDateTime,
                    condition == "absolute-expired" ? s_now.UtcDateTime : s_now.AddHours(2).UtcDateTime,
                    "12");
            }
            return table;
        }

        private static DataTable ArticleTable()
        {
            var table = new DataTable();
            table.Columns.Add("id", typeof(int));
            table.Columns.Add("status", typeof(int));
            table.Columns.Add("isdeleted", typeof(bool));
            table.Rows.Add(1, (int)ArticleStatus.Published, false);
            table.Rows.Add(2, (int)ArticleStatus.Archived, false);
            table.Rows.Add(3, (int)ArticleStatus.Published, true);
            return table;
        }
    }

    private sealed class TrackingContextAccessor : IHttpContextAccessor
    {
        private HttpContext? _context;
        public int ReadCount { get; private set; }
        public HttpContext? HttpContext
        {
            get
            {
                ReadCount++;
                return _context;
            }
            set => _context = value;
        }
    }

    private sealed class FixedClock : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => s_now;
    }
}
