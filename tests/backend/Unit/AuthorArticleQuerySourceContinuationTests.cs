using FsusBlog.Contracts.Articles;
using FsusBlog.Server.Services.Authoring;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Ordinary controls for internal source pages; no authenticated query cursor or runtime receipt.</summary>
[Trait("Category", "Unit")]
public sealed class AuthorArticleQuerySourceContinuationTests
{
    [Fact]
    public async Task Page_UsesExactPositionAndAdmitsOnlyWritableMetadata()
    {
        var source = new Source { Coordinates = [Coordinate(1001), Coordinate(1002)] };
        var permission = new Permission { DeniedId = 1002 };

        AuthorArticleQuerySourceInspectionResult page = await new AuthorArticleQuerySourceInspection(permission, source)
            .InspectPageAsync(Request(), 1000);

        Assert.Equal(AuthorArticleQuerySourceUnavailableReason.SlugUnavailable, page.UnavailableReason);
        Assert.Equal(1000, source.LastPosition);
        Assert.Equal(0, source.FirstReads);
        Assert.Equal(new[] { 1001 }, source.LastFieldIds);
        Assert.Equal(1001, Assert.Single(page.ObservedFields).Coordinate.ArticleId);
        Assert.False(page.HasMore);
        Assert.Null(page.NextAfterArticleId);
        Assert.Equal(3, permission.Calls);
    }

    [Fact]
    public async Task Page_ProvidesBoundedRawPositionEvenWhenNoIdsWritable()
    {
        var source = FullPage();
        var permission = new Permission { DenyAllWrites = true };

        AuthorArticleQuerySourceInspectionResult page = await new AuthorArticleQuerySourceInspection(permission, source)
            .InspectPageAsync(Request(), 1000);

        Assert.Equal(AuthorArticleQuerySourceUnavailableReason.SlugUnavailable, page.UnavailableReason);
        Assert.Empty(page.ObservedFields);
        Assert.True(page.HasMore);
        Assert.Equal(2000, page.NextAfterArticleId);
        Assert.Equal(0, source.FieldReads);
    }

    [Fact]
    public async Task Page_RejectsPermissionBeforeContinuation()
    {
        var source = FullPage();

        AuthorArticleQuerySourceInspectionResult page = await new AuthorArticleQuerySourceInspection(
            new Permission { Unavailable = true }, source).InspectPageAsync(Request(), 1000);

        Assert.Equal(AuthorArticleQuerySourceUnavailableReason.PermissionUnavailable, page.UnavailableReason);
        AssertClosed(page);
        Assert.Equal(0, source.PageReads);
        Assert.Equal(0, source.FieldReads);
    }

    [Theory]
    [InlineData("equal")]
    [InlineData("previous")]
    [InlineData("duplicate")]
    [InlineData("no-revision")]
    [InlineData("partial-more")]
    [InlineData("unknown-status")]
    public async Task Page_InvalidCoordinatesNeverReachMetadata(string fault)
    {
        var source = new Source
        {
            Coordinates = fault switch
            {
                "equal" => [Coordinate(1000)],
                "previous" => [Coordinate(999)],
                "duplicate" => [Coordinate(1001), Coordinate(1001)],
                "no-revision" => [Coordinate(1001) with { ServerRevision = 0 }],
                "unknown-status" => [Coordinate(1001) with { Status = (AuthorArticleQueryStatus)42 }],
                _ => [Coordinate(1001)]
            },
            HasMore = fault == "partial-more"
        };

        AuthorArticleQuerySourceInspectionResult page = await new AuthorArticleQuerySourceInspection(new Permission(), source)
            .InspectPageAsync(Request(), 1000);

        Assert.Equal(AuthorArticleQuerySourceUnavailableReason.SourceChanged, page.UnavailableReason);
        AssertClosed(page);
        Assert.Equal(0, source.FieldReads);
    }

    [Fact]
    public async Task Page_RevokedSessionDiscardsFieldsAndPosition()
    {
        var source = FullPage();

        AuthorArticleQuerySourceInspectionResult page = await new AuthorArticleQuerySourceInspection(
            new Permission { RevokeOnCall = 3 }, source).InspectPageAsync(Request(), 1000);

        Assert.Equal(AuthorArticleQuerySourceUnavailableReason.PermissionChanged, page.UnavailableReason);
        AssertClosed(page);
        Assert.Equal(1, source.FieldReads);
    }

    [Theory]
    [InlineData("archived-status")]
    [InlineData("archived-bucket")]
    [InlineData("cursor")]
    public async Task Page_ArchivedAndQueryCursorRemainClosed(string fault)
    {
        var source = FullPage();
        AuthorArticleQueryRequest request = fault switch
        {
            "archived-status" => Request() with { Statuses = [AuthorArticleQueryStatus.Archived] },
            "archived-bucket" => Request() with { Buckets = [AuthorArticleQueryBucket.Archived] },
            _ => Request() with { Cursor = "unverified-cursor" }
        };

        AuthorArticleQuerySourceInspectionResult page = await new AuthorArticleQuerySourceInspection(new Permission(), source)
            .InspectPageAsync(request, 1000);

        Assert.Equal(fault == "cursor" ? AuthorArticleQuerySourceUnavailableReason.QueryCursorUnavailable
            : AuthorArticleQuerySourceUnavailableReason.ArchivedReadGrantUnavailable, page.UnavailableReason);
        AssertClosed(page);
        Assert.Equal(0, source.PageReads);
    }

    [Theory]
    [InlineData("recent-only")]
    [InlineData("mixed")]
    public async Task Page_RecentContinuationCannotUseRawCorpusPosition(string scope)
    {
        var source = FullPage();
        AuthorArticleQueryRequest request = Request() with
        {
            Buckets = scope == "mixed" ? [AuthorArticleQueryBucket.Recent, AuthorArticleQueryBucket.Draft]
                : [AuthorArticleQueryBucket.Recent]
        };

        AuthorArticleQuerySourceInspectionResult page = await new AuthorArticleQuerySourceInspection(new Permission(), source)
            .InspectPageAsync(request, 1000);

        Assert.Equal(AuthorArticleQuerySourceUnavailableReason.SourceWindowUnavailable, page.UnavailableReason);
        AssertClosed(page);
        Assert.Equal(0, source.PageReads);
    }

    [Fact]
    public async Task Page_MissingContinuationCapabilityNeverReplaysFirstPage()
    {
        var source = FullPage();

        AuthorArticleQuerySourceInspectionResult page = await new AuthorArticleQuerySourceInspection(
            new Permission(), new FirstPageOnly(source)).InspectPageAsync(Request(), 1000);

        Assert.Equal(AuthorArticleQuerySourceUnavailableReason.SourceWindowUnavailable, page.UnavailableReason);
        AssertClosed(page);
        Assert.Equal(0, source.FirstReads);
        Assert.Equal(0, source.FieldReads);
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(int.MinValue)]
    public async Task Page_NegativePositionDoesNotReadPermission(int position)
    {
        var source = FullPage();
        var permission = new Permission();

        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => new AuthorArticleQuerySourceInspection(permission, source)
            .InspectPageAsync(Request(), position));

        Assert.Equal(0, permission.Calls);
        Assert.Equal(0, source.PageReads);
    }

    [Fact]
    public async Task Page_CancellationStopsBeforePermission()
    {
        var source = FullPage();
        var permission = new Permission();
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => new AuthorArticleQuerySourceInspection(permission, source)
            .InspectPageAsync(Request(), 1000, cancellation.Token));

        Assert.Equal(0, permission.Calls);
        Assert.Equal(0, source.PageReads);
    }

    private static void AssertClosed(AuthorArticleQuerySourceInspectionResult page)
    {
        Assert.Empty(page.ObservedFields);
        Assert.Empty(page.RecentBindings);
        Assert.Null(page.HistoryIdentity);
        Assert.Null(page.NextAfterArticleId);
        Assert.False(page.HasMore);
    }

    private static AuthorArticleQueryRequest Request()
        => new(1, new(7, "site-a"), Guid.CreateVersion7(), 1, "article", [AuthorArticleQueryStatus.Draft],
            [AuthorArticleQueryBucket.Draft], "zh-CN", AuthorArticleQueryContract.Collation, 10, null);

    private static AuthorArticleQuerySourceCoordinate Coordinate(int id)
        => new(id, id * 10L, $"row-{id}", AuthorArticleQueryStatus.Draft);

    private static Source FullPage() => new()
    {
        Coordinates = Enumerable.Range(1001, AuthorArticleQuerySourceInspection.MaxBatchSize).Select(Coordinate).ToArray(),
        HasMore = true
    };

    private sealed class Permission : IAuthorRecentArticleHistoryPermissionProjectionProvider
    {
        public int Calls
        {
            get; private set;
        }
        public int RevokeOnCall
        {
            get; init;
        }
        public int DeniedId
        {
            get; init;
        }
        public bool DenyAllWrites
        {
            get; init;
        }
        public bool Unavailable
        {
            get; init;
        }

        public Task<AuthorRecentArticleHistoryPermissionSnapshot> ResolveAsync(
            AuthorRecentArticleHistoryPermissionRequest request, CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Calls++;
            var snapshot = new AuthorRecentArticleHistoryPermissionSnapshot(
                Unavailable ? AuthorRecentArticleHistoryPermissionSnapshotStatus.Unavailable
                    : AuthorRecentArticleHistoryPermissionSnapshotStatus.Current, request.Owner,
                Hash("permission"), Hash("site"), Hash(Calls == RevokeOnCall ? "changed-session" : "session"),
                request.ArticleIds.Select(id => new AuthorRecentArticleHistoryPermissionDecision(id, id != DeniedId,
                    !DenyAllWrites && id != DeniedId, Hash($"decision-{id}"))).ToArray(), string.Empty);
            return Task.FromResult(snapshot with
            {
                ContentDigest = AuthorRecentArticleHistoryContract.ComputePermissionDigest(snapshot)
            });
        }

        private static string Hash(string value) => AuthorRecentArticleHistoryContract.HashText(value);
    }

    private sealed class FirstPageOnly(Source source) : IAuthorArticleQuerySourceReader
    {
        public Task<AuthorArticleQuerySourceBatch> ReadCoordinatesAsync(
            IReadOnlyList<AuthorArticleQueryStatus> statuses, CancellationToken cancellationToken)
            => source.ReadCoordinatesAsync(statuses, cancellationToken);

        public Task<IReadOnlyList<AuthorArticleQuerySourceFields>> ReadFieldsAsync(
            IReadOnlyList<int> admittedArticleIds, CancellationToken cancellationToken)
            => source.ReadFieldsAsync(admittedArticleIds, cancellationToken);
    }

    private sealed class Source : IAuthorArticleQuerySourceReader
    {
        public AuthorArticleQuerySourceCoordinate[] Coordinates { get; init; } = [];
        public bool HasMore
        {
            get; init;
        }
        public int FirstReads
        {
            get; private set;
        }
        public int PageReads
        {
            get; private set;
        }
        public int FieldReads
        {
            get; private set;
        }
        public int LastPosition
        {
            get; private set;
        }
        public int[] LastFieldIds { get; private set; } = [];

        public Task<AuthorArticleQuerySourceBatch> ReadCoordinatesAsync(
            IReadOnlyList<AuthorArticleQueryStatus> statuses, CancellationToken cancellationToken)
        {
            FirstReads++;
            return Task.FromResult(new AuthorArticleQuerySourceBatch(Coordinates, HasMore));
        }

        public Task<AuthorArticleQuerySourceBatch> ReadCoordinatesAfterAsync(
            IReadOnlyList<AuthorArticleQueryStatus> statuses, int afterArticleId, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            PageReads++;
            LastPosition = afterArticleId;
            return Task.FromResult(new AuthorArticleQuerySourceBatch(Coordinates, HasMore));
        }

        public Task<IReadOnlyList<AuthorArticleQuerySourceFields>> ReadFieldsAsync(
            IReadOnlyList<int> admittedArticleIds, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            FieldReads++;
            LastFieldIds = admittedArticleIds.ToArray();
            IReadOnlyList<AuthorArticleQuerySourceFields> fields = admittedArticleIds.Select(id =>
                new AuthorArticleQuerySourceFields(Coordinate(id), "real-title", "real-category", ["real-tag"])).ToArray();
            return Task.FromResult(fields);
        }
    }
}
