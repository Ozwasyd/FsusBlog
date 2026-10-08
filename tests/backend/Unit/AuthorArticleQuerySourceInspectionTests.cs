using FsusBlog.Contracts.Articles;
using FsusBlog.Server.Services.Authoring;

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

    private static AuthorArticleQueryRequest Request()
        => new(1, new(7, "site-a"), Guid.CreateVersion7(), 1, "article",
            [AuthorArticleQueryStatus.Draft], [AuthorArticleQueryBucket.Draft], "zh-CN",
            AuthorArticleQueryContract.Collation, 10, null);

    private static AuthorArticleQuerySourceCoordinate Coordinate(int id)
        => new(id, id * 10L, $"row-{id}", AuthorArticleQueryStatus.Draft);

    private static string Hash(string text) => AuthorRecentArticleHistoryContract.HashText(text);

    private sealed class FakeSource : IAuthorArticleQuerySourceReader
    {
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
            IReadOnlyList<AuthorArticleQuerySourceFields> fields = admittedArticleIds.Select(id =>
            {
                AuthorArticleQuerySourceCoordinate coordinate = Fault switch
                {
                    "revision" => Coordinate(id) with { ServerRevision = 999 },
                    "lifecycle" => Coordinate(id) with { Status = AuthorArticleQueryStatus.Archived },
                    "unrequested" => Coordinate(99),
                    _ => Coordinate(id)
                };
                return new AuthorArticleQuerySourceFields(coordinate, "real-title", "real-category", ["real-tag"]);
            }).ToArray();
            return Task.FromResult(Fault == "missing" ? (IReadOnlyList<AuthorArticleQuerySourceFields>)[] : fields);
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
