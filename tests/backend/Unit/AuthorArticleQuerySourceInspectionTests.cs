using System.Security.Claims;

using FsusBlog.Contracts.Articles;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Services.Authoring;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class AuthorArticleQuerySourceInspectionTests
{
    [Fact]
    public async Task Inspection_DeniedPrincipalReadsNeitherCoordinatesNorMetadata()
    {
        var source = new FakeSource();
        var authority = new FakePermission { Unavailable = true };
        var result = await new AuthorArticleQuerySourceInspection(authority, source).InspectAsync(Request());
        Assert.Equal(AuthorArticleQuerySourceUnavailableReason.PermissionUnavailable, result.UnavailableReason);
        Assert.Empty(result.ObservedFields);
        Assert.Equal(0, source.CoordinateReads);
        Assert.Equal(0, source.FieldReads);
    }

    [Fact]
    public async Task Inspection_AdmitsOnlyRealProjectableAndWritableIdsBeforeMetadata()
    {
        var source = new FakeSource();
        var authority = new FakePermission { DeniedId = 2 };
        var result = await new AuthorArticleQuerySourceInspection(authority, source).InspectAsync(Request());
        Assert.Equal(AuthorArticleQuerySourceUnavailableReason.SlugUnavailable, result.UnavailableReason);
        Assert.Equal(new[] { 1 }, source.LastAdmittedIds);
        Assert.Equal(1, Assert.Single(result.ObservedFields).Coordinate.ArticleId);
        Assert.Equal(3, authority.Calls);
    }

    [Fact]
    public async Task Inspection_NoWritableIdsNeverReadsFieldsOrSucceedsAsEmptyQuery()
    {
        var source = new FakeSource();
        var authority = new FakePermission { DenyAllWrites = true };
        var result = await new AuthorArticleQuerySourceInspection(authority, source).InspectAsync(Request());
        Assert.Equal(AuthorArticleQuerySourceUnavailableReason.SlugUnavailable, result.UnavailableReason);
        Assert.Empty(result.ObservedFields);
        Assert.Equal(0, source.FieldReads);
    }

    [Fact]
    public async Task Inspection_EmptyCorpusStillHasMissingSlugCapability()
    {
        var source = new FakeSource { Coordinates = [] };
        var result = await new AuthorArticleQuerySourceInspection(new FakePermission(), source).InspectAsync(Request());
        Assert.Equal(AuthorArticleQuerySourceUnavailableReason.SlugUnavailable, result.UnavailableReason);
        Assert.Empty(result.ObservedFields);
        Assert.False(result.HasMore);
        Assert.Equal(0, source.FieldReads);
    }

    [Theory]
    [InlineData("owner")]
    [InlineData("digest")]
    [InlineData("duplicate")]
    [InlineData("session")]
    public async Task Inspection_TamperedOrDriftingPermissionNeverReadsMetadata(string fault)
    {
        var source = new FakeSource();
        var authority = new FakePermission { Fault = fault, FaultCall = 2 };
        var result = await new AuthorArticleQuerySourceInspection(authority, source).InspectAsync(Request());
        Assert.Equal(AuthorArticleQuerySourceUnavailableReason.PermissionChanged, result.UnavailableReason);
        Assert.Empty(result.ObservedFields);
        Assert.Equal(0, source.FieldReads);
    }

    [Fact]
    public async Task Inspection_PermissionRevokedDuringSourceReadDiscardsAllFields()
    {
        var source = new FakeSource();
        var authority = new FakePermission { Fault = "session", FaultCall = 3 };
        var result = await new AuthorArticleQuerySourceInspection(authority, source).InspectAsync(Request());
        Assert.Equal(AuthorArticleQuerySourceUnavailableReason.PermissionChanged, result.UnavailableReason);
        Assert.Empty(result.ObservedFields);
        Assert.Equal(1, source.FieldReads);
    }

    [Theory]
    [InlineData("revision")]
    [InlineData("lifecycle")]
    [InlineData("missing")]
    [InlineData("unrequested")]
    public async Task Inspection_SourceChangesCannotEscapeAsAdmittedFields(string fault)
    {
        var source = new FakeSource { Fault = fault };
        var result = await new AuthorArticleQuerySourceInspection(new FakePermission(), source).InspectAsync(Request());
        Assert.Equal(AuthorArticleQuerySourceUnavailableReason.SourceChanged, result.UnavailableReason);
        Assert.Empty(result.ObservedFields);
    }

    [Theory]
    [InlineData("duplicate")]
    [InlineData("unbounded")]
    [InlineData("unversioned")]
    public async Task Inspection_InvalidSourceCoordinatesCannotReachMetadata(string fault)
    {
        var source = new FakeSource();
        source.Coordinates = fault switch
        {
            "duplicate" => [Coordinate(1), Coordinate(1)],
            "unbounded" => Enumerable.Range(1, AuthorArticleQuerySourceInspection.MaxBatchSize + 1)
                .Select(Coordinate).ToArray(),
            _ => [Coordinate(1) with { ServerRevision = 0 }]
        };
        var result = await new AuthorArticleQuerySourceInspection(new FakePermission(), source).InspectAsync(Request());
        Assert.Equal(AuthorArticleQuerySourceUnavailableReason.SourceChanged, result.UnavailableReason);
        Assert.Empty(result.ObservedFields);
        Assert.Equal(0, source.FieldReads);
    }

    [Fact]
    public async Task Inspection_ArchivedRecentAndCursorStayClosedWithoutSourceReads()
    {
        foreach (var request in new[]
        {
            Request() with { Statuses = [AuthorArticleQueryStatus.Archived] },
            Request() with { Buckets = [AuthorArticleQueryBucket.Recent] },
            Request() with { Cursor = "unverified-cursor" }
        })
        {
            var source = new FakeSource();
            var result = await new AuthorArticleQuerySourceInspection(new FakePermission(), source).InspectAsync(request);
            Assert.Empty(result.ObservedFields);
            Assert.NotEqual(AuthorArticleQuerySourceUnavailableReason.SlugUnavailable, result.UnavailableReason);
            Assert.Equal(0, source.CoordinateReads);
        }
    }

    [Fact]
    public async Task Inspection_CanceledRequestCannotConsultPermissionOrSource()
    {
        var source = new FakeSource();
        var authority = new FakePermission();
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            new AuthorArticleQuerySourceInspection(authority, source).InspectAsync(Request(), cancellation.Token));
        Assert.Equal(0, authority.Calls);
        Assert.Equal(0, source.CoordinateReads);
    }

    [Fact]
    public async Task Selection_RevalidatesOnlyOneLiveIdWithoutEnumeratingOrProjectingCandidates()
    {
        var source = new FakeSource();
        var authority = new FakePermission();
        Guid requestId = Guid.CreateVersion7();
        var result = await new AuthorArticleQuerySelectionRevalidator(authority, source).RevalidateAsync(
            new(7, "site-a"), 1, 10, Hash("decision-1"), requestId);
        Assert.True(result.Current);
        Assert.Equal(requestId, result.RequestId);
        Assert.Equal(Hash("decision-1"), result.PermissionToken);
        Assert.Equal(0, source.CoordinateReads);
        Assert.Equal(new[] { 1 }, source.LastAdmittedIds);
        Assert.Equal(2, source.FieldReads);
        Assert.Equal(3, authority.Calls);
    }

    [Theory]
    [InlineData("denied")]
    [InlineData("not-writable")]
    [InlineData("unavailable")]
    [InlineData("wrong-token")]
    public async Task Selection_DeniedOrStalePermissionReadsNoArticleMetadata(string fault)
    {
        var source = new FakeSource();
        var authority = new FakePermission
        {
            DeniedId = fault == "denied" ? 1 : 0,
            DenyAllWrites = fault == "not-writable",
            Unavailable = fault == "unavailable"
        };
        var result = await new AuthorArticleQuerySelectionRevalidator(authority, source).RevalidateAsync(
            new(7, "site-a"), 1, 10, Hash(fault == "wrong-token" ? "wrong-token" : "decision-1"), Guid.CreateVersion7());
        Assert.False(result.Current);
        Assert.Null(result.PermissionToken);
        Assert.Equal(0, source.FieldReads);
        Assert.Equal(0, source.CoordinateReads);
    }

    [Theory]
    [InlineData("owner", 1)]
    [InlineData("digest", 1)]
    [InlineData("duplicate", 1)]
    [InlineData("session", 2)]
    [InlineData("session", 3)]
    public async Task Selection_TamperedOrChangingAuthorityNeverReturnsACurrentToken(string fault, int faultCall)
    {
        var source = new FakeSource();
        var authority = new FakePermission { Fault = fault, FaultCall = faultCall };
        var result = await new AuthorArticleQuerySelectionRevalidator(authority, source).RevalidateAsync(
            new(7, "site-a"), 1, 10, Hash("decision-1"), Guid.CreateVersion7());
        Assert.False(result.Current);
        Assert.Null(result.PermissionToken);
        Assert.Equal(0, source.CoordinateReads);
        Assert.Equal(faultCall - 1, source.FieldReads);
    }

    [Theory]
    [InlineData("revision", 1)]
    [InlineData("lifecycle", 1)]
    [InlineData("missing", 1)]
    [InlineData("unrequested", 1)]
    [InlineData("row-version", 2)]
    [InlineData("revision", 2)]
    public async Task Selection_ChangedMissingOrArchivedSourceCannotRemainCurrent(string fault, int faultCall)
    {
        var source = new FakeSource { Fault = fault, FaultCall = faultCall };
        var result = await new AuthorArticleQuerySelectionRevalidator(new FakePermission(), source).RevalidateAsync(
            new(7, "site-a"), 1, 10, Hash("decision-1"), Guid.CreateVersion7());
        Assert.False(result.Current);
        Assert.Null(result.PermissionToken);
        Assert.Equal(0, source.CoordinateReads);
    }

    [Fact]
    public async Task Selection_CanceledRequestCannotConsultPermissionOrSource()
    {
        var source = new FakeSource();
        var authority = new FakePermission();
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            new AuthorArticleQuerySelectionRevalidator(authority, source).RevalidateAsync(
                new(7, "site-a"), 1, 10, Hash("decision-1"), Guid.CreateVersion7(), cancellation.Token));
        Assert.Equal(0, authority.Calls);
        Assert.Equal(0, source.FieldReads);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Selection_ApplicationPortDerivesOwnerFromAuthenticatedServerContext(bool denied)
    {
        var source = new FakeSource();
        var authority = new FakePermission();
        var accessor = new HttpContextAccessor { HttpContext = new DefaultHttpContext() };
        if (!denied)
        {
            accessor.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity(
            [
                new Claim("identity_kind", "admin_principal"), new Claim("admin_id", "7"),
                new Claim("admin_sid", "current-session"),
                new Claim(AdminPermissions.PermissionClaimType, AdminPermissions.ArticleWrite)
            ], "test"));
        }
        IConfiguration configuration = new ConfigurationBuilder().AddInMemoryCollection(
            new Dictionary<string, string?> { ["SITE_BASEURL"] = "site-a" }).Build();
        var facade = new AuthorRecentArticleHistoryApplicationFacade(
            Substitute.For<IAuthorRecentArticleHistoryStore>(),
            Substitute.For<IAuthorRecentArticleHistoryProjectionService>(), accessor, configuration, authority, source);
        if (denied)
        {
            await Assert.ThrowsAsync<AuthorRecentArticleHistoryAccessDeniedException>(() =>
                facade.RevalidateSelectionAsync(1, 10, Hash("decision-1"), Guid.CreateVersion7()));
            Assert.Equal(0, authority.Calls);
            Assert.Equal(0, source.FieldReads);
        }
        else
        {
            var result = await facade.RevalidateSelectionAsync(1, 10, Hash("decision-1"), Guid.CreateVersion7());
            Assert.True(result.Current);
            Assert.Equal(new AuthorRecentArticleHistoryOwner(7, "site-a"), result.Owner);
        }
    }

    [Fact]
    public async Task Selection_CancellationDuringSourceReadReturnsNoCurrentObservation()
    {
        using var cancellation = new CancellationTokenSource();
        var source = new FakeSource { AfterFields = cancellation.Cancel };
        var authority = new FakePermission();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            new AuthorArticleQuerySelectionRevalidator(authority, source).RevalidateAsync(
                new(7, "site-a"), 1, 10, Hash("decision-1"), Guid.CreateVersion7(), cancellation.Token));
        Assert.Equal(1, source.FieldReads);
        Assert.Equal(1, authority.Calls);
    }

    [Fact]
    public async Task Selection_InboxUsesCurrentPermissionAndExactSourceWithoutQueryEnumeration()
    {
        var source = new FakeSource { Status = AuthorArticleQueryStatus.Inbox };
        var authority = new FakePermission();
        var owner = new AuthorRecentArticleHistoryOwner(7, "site-a");
        Guid requestId = Guid.CreateVersion7();
        var result = await new AuthorArticleQuerySelectionRevalidator(authority, source).RevalidateAsync(
            owner, 1, 10, Hash("decision-1"), requestId);
        Assert.True(result.Current);
        Assert.Equal(owner, result.Owner);
        Assert.Equal(1, result.ArticleId);
        Assert.Equal(10, result.ServerRevision);
        Assert.Equal(requestId, result.RequestId);
        Assert.Equal(Hash("decision-1"), result.PermissionToken);
        Assert.Equal(0, source.CoordinateReads);
        Assert.Equal(new[] { 1 }, source.LastAdmittedIds);
        Assert.Equal(2, source.FieldReads);
        Assert.Equal(3, authority.Calls);
    }

    [Theory]
    [InlineData("revision")]
    [InlineData("lifecycle")]
    [InlineData("triaged")]
    [InlineData("row-version")]
    public async Task Selection_InboxSourceDriftReturnsNoCurrentToken(string fault)
    {
        var source = new FakeSource { Status = AuthorArticleQueryStatus.Inbox, Fault = fault, FaultCall = 2 };
        var authority = new FakePermission();
        var result = await new AuthorArticleQuerySelectionRevalidator(authority, source).RevalidateAsync(
            new(7, "site-a"), 1, 10, Hash("decision-1"), Guid.CreateVersion7());
        Assert.False(result.Current);
        Assert.Null(result.PermissionToken);
        Assert.Equal(0, source.CoordinateReads);
        Assert.Equal(2, source.FieldReads);
    }

    [Theory]
    [InlineData("denied", 1)]
    [InlineData("wrong-token", 1)]
    [InlineData("owner", 1)]
    [InlineData("session", 2)]
    [InlineData("session", 3)]
    public async Task Selection_InboxPermissionDriftCannotExposeCurrentToken(string fault, int faultCall)
    {
        var source = new FakeSource { Status = AuthorArticleQueryStatus.Inbox };
        var authority = new FakePermission
        {
            DeniedId = fault == "denied" ? 1 : 0,
            Fault = fault,
            FaultCall = faultCall
        };
        var result = await new AuthorArticleQuerySelectionRevalidator(authority, source).RevalidateAsync(
            new(7, "site-a"), 1, 10, Hash(fault == "wrong-token" ? "stale" : "decision-1"), Guid.CreateVersion7());
        Assert.False(result.Current);
        Assert.Null(result.PermissionToken);
        Assert.Equal(0, source.CoordinateReads);
        Assert.Equal(faultCall - 1, source.FieldReads);
    }

    [Theory]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public async Task Inspection_InboxQueryGateStillRefusesBeforePermissionOrSource(bool status, bool bucket)
    {
        var source = new FakeSource { Status = AuthorArticleQueryStatus.Inbox };
        var authority = new FakePermission();
        AuthorArticleQueryRequest request = Request() with
        {
            Statuses = [status ? AuthorArticleQueryStatus.Inbox : AuthorArticleQueryStatus.Draft],
            Buckets = [bucket ? AuthorArticleQueryBucket.Inbox : AuthorArticleQueryBucket.Draft]
        };
        var error = await Assert.ThrowsAsync<NotSupportedException>(() =>
            new AuthorArticleQuerySourceInspection(authority, source).InspectAsync(request));
        Assert.Equal("author_article_query_inbox_unavailable", error.Message);
        Assert.Equal(0, authority.Calls);
        Assert.Equal(0, source.CoordinateReads);
        Assert.Equal(0, source.FieldReads);
    }

    [Fact]
    public async Task Selection_InboxCancellationDuringReadReturnsNoCurrentObservation()
    {
        using var cancellation = new CancellationTokenSource();
        var source = new FakeSource { Status = AuthorArticleQueryStatus.Inbox, AfterFields = cancellation.Cancel };
        var authority = new FakePermission();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            new AuthorArticleQuerySelectionRevalidator(authority, source).RevalidateAsync(
                new(7, "site-a"), 1, 10, Hash("decision-1"), Guid.CreateVersion7(), cancellation.Token));
        Assert.Equal(1, source.FieldReads);
        Assert.Equal(1, authority.Calls);
        Assert.Equal(0, source.CoordinateReads);
    }

    private static AuthorArticleQueryRequest Request()
        => new(1, new(7, "site-a"), Guid.CreateVersion7(), 1, "article",
            [AuthorArticleQueryStatus.Draft], [AuthorArticleQueryBucket.Draft], "zh-CN",
            AuthorArticleQueryContract.Collation, 10, null);

    private static AuthorArticleQuerySourceCoordinate Coordinate(int id)
        => new(id, id * 10L, $"row-{id}", AuthorArticleQueryStatus.Draft);

    private static string Hash(string text) => AuthorRecentArticleHistoryContract.HashText(text);

    private sealed class FakeSource : IAuthorArticleQuerySourceReader
    {
        public AuthorArticleQueryStatus Status { get; init; } = AuthorArticleQueryStatus.Draft;

        public Action? AfterFields
        {
            get; init;
        }
        public int FaultCall
        {
            get; init;
        }
        public IReadOnlyList<AuthorArticleQuerySourceCoordinate> Coordinates { get; set; } = [Coordinate(1), Coordinate(2)];
        public string? Fault
        {
            get; init;
        }
        public int CoordinateReads
        {
            get; private set;
        }
        public int FieldReads
        {
            get; private set;
        }
        public IReadOnlyList<int> LastAdmittedIds { get; private set; } = [];

        public Task<AuthorArticleQuerySourceBatch> ReadCoordinatesAsync(
            IReadOnlyList<AuthorArticleQueryStatus> statuses, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            CoordinateReads++;
            return Task.FromResult(new AuthorArticleQuerySourceBatch(Coordinates, false));
        }

        public Task<IReadOnlyList<AuthorArticleQuerySourceFields>> ReadFieldsAsync(
            IReadOnlyList<int> admittedArticleIds, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            FieldReads++;
            LastAdmittedIds = admittedArticleIds.ToArray();
            string? fault = FaultCall == 0 || FaultCall == FieldReads ? Fault : null;
            IReadOnlyList<AuthorArticleQuerySourceFields> fields = admittedArticleIds.Select(id =>
            {
                AuthorArticleQuerySourceCoordinate current = Coordinate(id) with
                {
                    Status = Status
                };
                AuthorArticleQuerySourceCoordinate coordinate = fault switch
                {
                    "revision" => current with { ServerRevision = 999 },
                    "lifecycle" => current with { Status = AuthorArticleQueryStatus.Archived },
                    "triaged" => current with { Status = AuthorArticleQueryStatus.Draft },
                    "unrequested" => Coordinate(99),
                    "row-version" => current with { RowVersion = "changed-row" },
                    _ => current
                };
                return new AuthorArticleQuerySourceFields(coordinate, "real-title", "real-category", ["real-tag"]);
            }).ToArray();
            AfterFields?.Invoke();
            return Task.FromResult(fault == "missing" ? (IReadOnlyList<AuthorArticleQuerySourceFields>)[] : fields);
        }
    }

    private sealed class FakePermission : IAuthorRecentArticleHistoryPermissionProjectionProvider
    {
        public bool Unavailable
        {
            get; init;
        }
        public bool DenyAllWrites
        {
            get; init;
        }
        public int DeniedId
        {
            get; init;
        }
        public string? Fault
        {
            get; init;
        }
        public int FaultCall
        {
            get; init;
        }
        public int Calls
        {
            get; private set;
        }

        public Task<AuthorRecentArticleHistoryPermissionSnapshot> ResolveAsync(
            AuthorRecentArticleHistoryPermissionRequest request, CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Calls++;
            bool fault = Calls == FaultCall;
            AuthorRecentArticleHistoryPermissionDecision[] decisions = request.ArticleIds.Select(id =>
                new AuthorRecentArticleHistoryPermissionDecision(id, id != DeniedId, !DenyAllWrites && id != DeniedId,
                    Hash($"decision-{id}"))).ToArray();
            if (fault && Fault == "duplicate")
            {
                decisions = [decisions[0], decisions[0]];
            }
            var snapshot = new AuthorRecentArticleHistoryPermissionSnapshot(
                Unavailable ? AuthorRecentArticleHistoryPermissionSnapshotStatus.Unavailable
                    : AuthorRecentArticleHistoryPermissionSnapshotStatus.Current,
                fault && Fault == "owner" ? request.Owner with
                {
                    SiteScope = "other-site"
                } : request.Owner,
                Hash("permission"), Hash("site"), Hash(fault && Fault == "session" ? "changed" : "session"),
                decisions, string.Empty);
            return Task.FromResult(snapshot with
            {
                ContentDigest = fault && Fault == "digest" ? Hash("tampered")
                    : AuthorRecentArticleHistoryContract.ComputePermissionDigest(snapshot)
            });
        }
    }
}
