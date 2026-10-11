using System.Data;
using System.Security.Claims;

using FsusBlog.Contracts.Articles;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Services.Authoring;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class AuthorArticleQueryArchivedPermissionObservationTests
{
    [Fact]
    public async Task ArchivedObservation_ReadsActualManagementCoordinatesWithoutChangingHistoryPolicy()
    {
        var fixture = new Fixture();
        fixture.Rows.Rows.Add(1, 3, false, 101L, "row-1");
        fixture.Rows.Rows.Add(2, 3, true, 102L, "row-2");
        fixture.Rows.Rows.Add(3, 0, false, 103L, "row-3");
        AuthorRecentArticleHistoryPermissionRequest request = Request([1, 2, 3, 4]);
        var result = await fixture.Authority.ObserveArchivedManagementPermissionAsync(request);
        Assert.Null(result.UnavailableReason);
        AuthorArticleQueryArchivedPermissionObservation observed = Assert.IsType<AuthorArticleQueryArchivedPermissionObservation>(
            result.Observation);
        Assert.Equal(request.Owner, observed.Owner);
        Assert.Equal(request.RequestId, observed.RequestId);
        Assert.Equal(new[] { 1, 2, 3, 4 }, observed.Decisions.Select(static decision => decision.ArticleId));
        AuthorArticleQueryArchivedManagementReadDecision allowed = Assert.Single(observed.Decisions,
            static decision => decision.CanReadManagementMetadata);
        Assert.Equal(new AuthorArticleQuerySourceCoordinate(1, 101, "row-1", AuthorArticleQueryStatus.Archived),
            allowed.Coordinate);
        Assert.All(observed.Decisions.Skip(1), static decision => Assert.Null(decision.Coordinate));
        AuthorRecentArticleHistoryContract.ValidateDigest(observed.PermissionRevision);
        AuthorRecentArticleHistoryContract.ValidateDigest(observed.SiteRevision);
        AuthorRecentArticleHistoryContract.ValidateDigest(observed.SessionRevision);
        Assert.Equal(3, fixture.PermissionReads);
        Assert.Equal(2, fixture.ArticleReads);
        Assert.All(fixture.Commands.Where(static command => command.Contains("FROM article", StringComparison.Ordinal)), command =>
        {
            Assert.Contains("LIMIT @Limit", command);
            Assert.DoesNotContain("title", command, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("category", command, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("tag", command, StringComparison.OrdinalIgnoreCase);
        });
        AuthorRecentArticleHistoryPermissionSnapshot history = await fixture.Authority.ResolveAsync(Request([1]));
        AuthorRecentArticleHistoryPermissionDecision original = Assert.Single(history.Decisions);
        Assert.False(original.CanProject);
        Assert.False(original.CanWrite);
        Assert.All(fixture.Readers, static reader => Assert.True(reader.IsClosed));
    }

    [Theory]
    [InlineData("principal")]
    [InlineData("site")]
    [InlineData("permission-claim")]
    [InlineData("persisted-permission")]
    [InlineData("principal-disabled")]
    [InlineData("revoked")]
    [InlineData("idle-expired")]
    [InlineData("absolute-expired")]
    public async Task ArchivedObservation_ContextDenialCannotReadArticleState(string fault)
    {
        var fixture = new Fixture();
        AuthorRecentArticleHistoryPermissionRequest request = Request([1]);
        switch (fault)
        {
            case "principal":
                fixture.SetPrincipal(8);
                break;
            case "site":
                request = request with
                {
                    Owner = new(7, "other-site")
                };
                break;
            case "permission-claim":
                fixture.SetPrincipal(7, false);
                break;
            case "persisted-permission":
                fixture.PersistedPermissions = string.Empty;
                break;
            case "principal-disabled":
                fixture.PrincipalStatus = "disabled";
                break;
            case "revoked":
                fixture.Revoked = true;
                break;
            case "idle-expired":
                fixture.IdleExpires = Fixture.Now;
                break;
            case "absolute-expired":
                fixture.AbsoluteExpires = Fixture.Now;
                break;
        }
        var result = await fixture.Authority.ObserveArchivedManagementPermissionAsync(request);
        Assert.Null(result.Observation);
        Assert.Equal("author_article_query_archived_observation_permission_unavailable", result.UnavailableReason);
        Assert.Equal(0, fixture.ArticleReads);
        Assert.All(fixture.Readers, static reader => Assert.True(reader.IsClosed));
    }

    [Theory]
    [InlineData("revision")]
    [InlineData("row-version")]
    [InlineData("lifecycle")]
    [InlineData("deleted")]
    [InlineData("missing")]
    [InlineData("unrequested")]
    [InlineData("duplicate")]
    public async Task ArchivedObservation_SourceDriftDiscardsEveryObservation(string fault)
    {
        var fixture = new Fixture();
        fixture.Rows.Rows.Add(1, 3, false, 101L, "row-1");
        fixture.RowsForArticleRead = read =>
        {
            DataTable rows = fixture.Rows.Copy();
            if (read == 2)
            {
                switch (fault)
                {
                    case "revision":
                        rows.Rows[0]["current_revision_id"] = 102L;
                        break;
                    case "row-version":
                        rows.Rows[0]["row_version"] = "changed";
                        break;
                    case "lifecycle":
                        rows.Rows[0]["status"] = 0;
                        break;
                    case "deleted":
                        rows.Rows[0]["isdeleted"] = true;
                        break;
                    case "missing":
                        rows.Rows.Clear();
                        break;
                    case "unrequested":
                        rows.Rows.Add(2, 3, false, 102L, "row-2");
                        break;
                    case "duplicate":
                        rows.Rows.Add(1, 3, false, 101L, "row-1");
                        break;
                }
            }
            return rows;
        };
        var result = await fixture.Authority.ObserveArchivedManagementPermissionAsync(Request([1]));
        Assert.Null(result.Observation);
        Assert.Equal("author_article_query_archived_observation_source_changed", result.UnavailableReason);
        Assert.All(fixture.Readers, static reader => Assert.True(reader.IsClosed));
    }

    [Theory]
    [InlineData("permission")]
    [InlineData("session")]
    [InlineData("site")]
    public async Task ArchivedObservation_LiveAuthorityDriftStopsBeforeSecondArticleRead(string fault)
    {
        var fixture = new Fixture();
        fixture.Rows.Rows.Add(1, 3, false, 101L, "row-1");
        fixture.BeforeArticleRead = _ =>
        {
            switch (fault)
            {
                case "permission":
                    fixture.PersistedPermissions += "\nother-permission";
                    break;
                case "session":
                    fixture.SessionRowVersion = "session-changed";
                    break;
                case "site":
                    fixture.Configuration["SITE_BASEURL"] = "other-site";
                    break;
            }
        };
        var result = await fixture.Authority.ObserveArchivedManagementPermissionAsync(Request([1]));
        Assert.Null(result.Observation);
        Assert.Equal("author_article_query_archived_observation_permission_changed", result.UnavailableReason);
        Assert.Equal(1, fixture.ArticleReads);
        Assert.All(fixture.Readers, static reader => Assert.True(reader.IsClosed));
    }

    [Theory]
    [InlineData("zero")]
    [InlineData("negative")]
    [InlineData("duplicate")]
    [InlineData("oversized")]
    public async Task ArchivedObservation_InvalidIdsCannotEnterOriginalAuthority(string fault)
    {
        var fixture = new Fixture();
        int[] ids = fault switch
        {
            "zero" => [0],
            "negative" => [-1],
            "duplicate" => [1, 1],
            _ => Enumerable.Range(1, AuthorRecentArticleHistoryContract.MaxEntriesPerOwner + 1).ToArray()
        };
        var result = await fixture.Authority.ObserveArchivedManagementPermissionAsync(Request(ids));
        Assert.Null(result.Observation);
        Assert.Equal("author_article_query_archived_observation_request_invalid", result.UnavailableReason);
        Assert.Empty(fixture.Commands);
    }

    [Fact]
    public async Task ArchivedObservation_FinalAuthorityDriftDiscardsStableCoordinates()
    {
        var fixture = new Fixture();
        fixture.Rows.Rows.Add(1, 3, false, 101L, "row-1");
        fixture.BeforeArticleRead = read =>
        {
            if (read == 2)
            {
                fixture.SessionRowVersion = "session-changed";
            }
        };
        var result = await fixture.Authority.ObserveArchivedManagementPermissionAsync(Request([1]));
        Assert.Null(result.Observation);
        Assert.Equal("author_article_query_archived_observation_permission_changed", result.UnavailableReason);
        Assert.Equal(2, fixture.ArticleReads);
        Assert.Equal(3, fixture.PermissionReads);
        Assert.All(fixture.Readers, static reader => Assert.True(reader.IsClosed));
    }

    [Theory]
    [InlineData("deleted-status")]
    [InlineData("unknown-status")]
    [InlineData("missing-revision")]
    [InlineData("missing-row-version")]
    public async Task ArchivedObservation_UnavailableEntityFactsHaveTheSameDeniedProjectionAsMissing(string fault)
    {
        var fixture = new Fixture();
        fixture.Rows.Rows.Add(1, 3, false, 101L, "row-1");
        switch (fault)
        {
            case "deleted-status":
                fixture.Rows.Rows[0]["status"] = 4;
                break;
            case "unknown-status":
                fixture.Rows.Rows[0]["status"] = 42;
                break;
            case "missing-revision":
                fixture.Rows.Rows[0]["current_revision_id"] = DBNull.Value;
                break;
            case "missing-row-version":
                fixture.Rows.Rows[0]["row_version"] = DBNull.Value;
                break;
        }
        var result = await fixture.Authority.ObserveArchivedManagementPermissionAsync(Request([1, 2]));
        Assert.Null(result.UnavailableReason);
        Assert.NotNull(result.Observation);
        Assert.Equal(2, result.Observation.Decisions.Length);
        Assert.All(result.Observation.Decisions, static decision =>
        {
            Assert.False(decision.CanReadManagementMetadata);
            Assert.Null(decision.Coordinate);
        });
    }

    [Fact]
    public async Task ArchivedObservation_EmptySelectionStillRechecksAuthorityWithoutReadingArticles()
    {
        var fixture = new Fixture();
        var result = await fixture.Authority.ObserveArchivedManagementPermissionAsync(Request([]));
        Assert.Null(result.UnavailableReason);
        Assert.NotNull(result.Observation);
        Assert.Empty(result.Observation.Decisions);
        Assert.Equal(3, fixture.PermissionReads);
        Assert.Equal(0, fixture.ArticleReads);
        Assert.All(fixture.Readers, static reader => Assert.True(reader.IsClosed));
    }

    [Fact]
    public async Task ArchivedObservation_FreezesCallerIdsBeforeOriginalPermissionRead()
    {
        var fixture = new Fixture();
        fixture.Rows.Rows.Add(1, 3, false, 101L, "row-1");
        var ids = new List<int> { 1 };
        fixture.BeforePermissionRead = read =>
        {
            if (read == 1)
            {
                ids[0] = 2;
            }
        };
        var result = await fixture.Authority.ObserveArchivedManagementPermissionAsync(Request(ids));
        Assert.NotNull(result.Observation);
        Assert.Equal(1, Assert.Single(result.Observation.Decisions).ArticleId);
        Assert.All(fixture.ArchivedIdParameters, static value => Assert.Equal("{1}", value));
    }

    [Fact]
    public async Task ArchivedObservation_CancellationDisposesOriginalReaders()
    {
        var fixture = new Fixture();
        fixture.Rows.Rows.Add(1, 3, false, 101L, "row-1");
        using var cancellation = new CancellationTokenSource();
        fixture.BeforeArticleRead = _ => cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            fixture.Authority.ObserveArchivedManagementPermissionAsync(Request([1]), cancellation.Token));
        Assert.Equal(1, fixture.ArticleReads);
        Assert.All(fixture.Readers, static reader => Assert.True(reader.IsClosed));
    }

    [Fact]
    public async Task ArchivedObservation_CannotOpenTheOriginalQueryGrantGate()
    {
        var fixture = new Fixture();
        fixture.Rows.Rows.Add(1, 3, false, 101L, "row-1");
        var observation = await fixture.Authority.ObserveArchivedManagementPermissionAsync(Request([1]));
        Assert.True(Assert.Single(Assert.IsType<AuthorArticleQueryArchivedPermissionObservation>(
            observation.Observation).Decisions).CanReadManagementMetadata);
        var source = Substitute.For<IAuthorArticleQuerySourceReader>();
        var inspection = new AuthorArticleQuerySourceInspection(fixture.Authority, source);
        var request = new AuthorArticleQueryRequest(1, new(7, "site-a"), Guid.CreateVersion7(), 1, string.Empty,
            [AuthorArticleQueryStatus.Archived], [AuthorArticleQueryBucket.Archived], "zh-CN",
            AuthorArticleQueryContract.Collation, 10, null);
        var result = await inspection.InspectAsync(request);
        Assert.Equal(AuthorArticleQuerySourceUnavailableReason.ArchivedReadGrantUnavailable, result.UnavailableReason);
        Assert.Empty(result.ObservedFields);
        Assert.Empty(result.RecentBindings);
        Assert.Null(result.HistoryIdentity);
        Assert.Null(result.NextAfterArticleId);
        Assert.Empty(source.ReceivedCalls());
    }

    [Fact]
    public async Task ArchivedObservation_RejectsInvalidOriginalRequestIdentityBeforeSql()
    {
        var fixture = new Fixture();
        await Assert.ThrowsAsync<AuthorRecentArticleHistoryValidationException>(() =>
            fixture.Authority.ObserveArchivedManagementPermissionAsync(Request([1]) with
            {
                RequestId = Guid.Empty
            }));
        Assert.Empty(fixture.Commands);
    }

    private static AuthorRecentArticleHistoryPermissionRequest Request(IReadOnlyList<int> ids)
        => new(new(7, "site-a"), Guid.CreateVersion7(), ids);

    private sealed class Fixture
    {
        public static readonly DateTime Now = new(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        public DataTable Rows { get; } = ArticleRows();
        public List<DataTableReader> Readers { get; } = [];
        public List<string> Commands { get; } = [];
        public List<string> ArchivedIdParameters { get; } = [];
        public int PermissionReads
        {
            get; private set;
        }
        public int ArticleReads
        {
            get; private set;
        }
        public string PersistedPermissions { get; set; } = AdminPermissions.ArticleWrite;
        public string PrincipalStatus { get; set; } = AdminPrincipalStatus.Active;
        public string SessionRowVersion { get; set; } = "session-1";
        public bool Revoked
        {
            get; set;
        }
        public DateTime IdleExpires { get; set; } = Now.AddHours(1);
        public DateTime AbsoluteExpires { get; set; } = Now.AddHours(2);
        public Action<int>? BeforeArticleRead
        {
            get; set;
        }
        public Action<int>? BeforePermissionRead
        {
            get; set;
        }
        public Func<int, DataTable>? RowsForArticleRead
        {
            get; set;
        }
        public IConfiguration Configuration
        {
            get;
        } = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["SITE_BASEURL"] = "site-a" }).Build();
        public HttpContextAccessor Context { get; } = new() { HttpContext = new DefaultHttpContext() };
        public SqlAuthorRecentArticleHistoryPermissionAuthority Authority
        {
            get;
        }

        public Fixture()
        {
            SetPrincipal(7);
            var db = Substitute.For<ISqlSugarClient>();
            var ado = Substitute.For<IAdo>();
            db.Ado.Returns(ado);
            ado.GetDataReaderAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>()).Returns(call =>
            {
                string command = call.ArgAt<string>(0);
                Commands.Add(command);
                DataTable rows;
                if (command.Contains("FROM admin_principal", StringComparison.Ordinal))
                {
                    PermissionReads++;
                    BeforePermissionRead?.Invoke(PermissionReads);
                    rows = PermissionRows();
                }
                else
                {
                    ArticleReads++;
                    BeforeArticleRead?.Invoke(ArticleReads);
                    if (command.Contains("row_version", StringComparison.Ordinal))
                    {
                        SugarParameter parameter = Assert.Single(call.ArgAt<SugarParameter[]>(1),
                            static value => value.ParameterName == "@ArticleIds");
                        ArchivedIdParameters.Add(Assert.IsType<string>(parameter.Value));
                    }
                    rows = RowsForArticleRead?.Invoke(ArticleReads) ?? Rows;
                }
                DataTableReader reader = rows.CreateDataReader();
                Readers.Add(reader);
                return Task.FromResult((IDataReader)reader);
            });
            Authority = new(db, Context, Configuration, new FixedClock());
        }

        public void SetPrincipal(long id, bool write = true)
        {
            var claims = new List<Claim>
            {
                new("identity_kind", "admin_principal"),
                new("admin_id", id.ToString(System.Globalization.CultureInfo.InvariantCulture)),
                new("admin_sid", "session-a")
            };
            if (write)
            {
                claims.Add(new(AdminPermissions.PermissionClaimType, AdminPermissions.ArticleWrite));
            }
            Context.HttpContext!.User = new ClaimsPrincipal(new ClaimsIdentity(claims, "test"));
        }

        private DataTable PermissionRows()
        {
            var rows = new DataTable();
            rows.Columns.Add("principal_status", typeof(string));
            rows.Columns.Add("isroot", typeof(bool));
            rows.Columns.Add("permissions", typeof(string));
            rows.Columns.Add("principal_row_version", typeof(string));
            rows.Columns.Add("revokedatutc", typeof(DateTime));
            rows.Columns.Add("idleexpiresatutc", typeof(DateTime));
            rows.Columns.Add("absoluteexpiresatutc", typeof(DateTime));
            rows.Columns.Add("session_row_version", typeof(string));
            rows.Rows.Add(PrincipalStatus, false, PersistedPermissions, "principal-1",
                Revoked ? Now : DBNull.Value, IdleExpires, AbsoluteExpires, SessionRowVersion);
            return rows;
        }

        private static DataTable ArticleRows()
        {
            var rows = new DataTable();
            rows.Columns.Add("id", typeof(int));
            rows.Columns.Add("status", typeof(int));
            rows.Columns.Add("isdeleted", typeof(bool));
            rows.Columns.Add("current_revision_id", typeof(long));
            rows.Columns.Add("row_version", typeof(string));
            return rows;
        }

        private sealed class FixedClock : TimeProvider
        {
            public override DateTimeOffset GetUtcNow() => new(Now);
        }
    }
}
