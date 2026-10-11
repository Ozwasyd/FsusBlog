using FsusBlog.Contracts.Articles;
using FsusBlog.Server.Services.Authoring;

using Microsoft.AspNetCore.DataProtection;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Ordinary metadata recheck controls; substituted source facts do not qualify a query response.</summary>
[Trait("Category", "Unit")]
public sealed class AuthorArticleQuerySourceStabilityTests
{
    [Fact]
    public async Task Stability_PreservesCurrentMetadataWhileRefusingMissingSlug()
    {
        var fixture = new Fixture();

        AuthorArticleQuerySourceInspectionResult result = await fixture.Inspection.InspectStablePageAsync(Request(), 0);

        Assert.Equal(AuthorArticleQuerySourceUnavailableReason.SlugUnavailable, result.UnavailableReason);
        AuthorArticleQuerySourceFields field = Assert.Single(result.ObservedFields);
        Assert.Equal(Coordinate(1), field.Coordinate);
        Assert.Equal("title", field.Title);
        Assert.Equal("category", field.Category);
        Assert.Equal(new[] { "tag-a", "tag-b" }, field.Tags);
        Assert.Equal(2, fixture.Source.FieldReads);
        Assert.Equal(1, fixture.Source.CoordinateRechecks);
        Assert.Equal(5, fixture.Permission.Calls);
    }

    [Theory]
    [InlineData("title")]
    [InlineData("category")]
    [InlineData("tags")]
    [InlineData("tag-order")]
    [InlineData("mutable-tags")]
    public async Task Stability_RejectsChangedMetadataWithUnchangedArticleCoordinate(string fault)
    {
        var fixture = new Fixture();
        fixture.Source.MetadataFault = fault;

        AuthorArticleQuerySourceInspectionResult result = await fixture.Inspection.InspectStablePageAsync(Request(), 0);

        Assert.Equal(AuthorArticleQuerySourceUnavailableReason.SourceChanged, result.UnavailableReason);
        AssertClosed(result);
        Assert.Equal(2, fixture.Source.FieldReads);
        Assert.Equal(1, fixture.Source.CoordinateRechecks);
    }

    [Theory]
    [InlineData("revision")]
    [InlineData("row-version")]
    [InlineData("lifecycle")]
    [InlineData("missing")]
    [InlineData("duplicate")]
    [InlineData("unrequested")]
    [InlineData("has-more")]
    public async Task Stability_RejectsCoordinateChangesBeforeSecondMetadataRead(string fault)
    {
        var fixture = new Fixture();
        fixture.Source.CoordinateFault = fault;

        AuthorArticleQuerySourceInspectionResult result = await fixture.Inspection.InspectStablePageAsync(Request(), 0);

        Assert.Equal(AuthorArticleQuerySourceUnavailableReason.SourceChanged, result.UnavailableReason);
        AssertClosed(result);
        Assert.Equal(1, fixture.Source.FieldReads);
    }

    [Theory]
    [InlineData("owner")]
    [InlineData("session")]
    [InlineData("digest")]
    [InlineData("write")]
    [InlineData("decision")]
    public async Task Stability_PermissionDriftBeforeRecheckCannotReadMetadata(string fault)
    {
        var fixture = new Fixture();
        fixture.Permission.Fault = fault;
        fixture.Permission.FaultCall = 4;

        AuthorArticleQuerySourceInspectionResult result = await fixture.Inspection.InspectStablePageAsync(Request(), 0);

        Assert.Equal(AuthorArticleQuerySourceUnavailableReason.PermissionChanged, result.UnavailableReason);
        AssertClosed(result);
        Assert.Equal(1, fixture.Source.FieldReads);
        Assert.Equal(0, fixture.Source.CoordinateRechecks);
    }

    [Fact]
    public async Task Stability_PermissionChangeDuringSecondReadDiscardsEveryObservation()
    {
        var fixture = new Fixture();
        fixture.Permission.Fault = "session";
        fixture.Permission.FaultCall = 5;

        AuthorArticleQuerySourceInspectionResult result = await fixture.Inspection.InspectStablePageAsync(Request(), 0);

        Assert.Equal(AuthorArticleQuerySourceUnavailableReason.PermissionChanged, result.UnavailableReason);
        AssertClosed(result);
        Assert.Equal(2, fixture.Source.FieldReads);
    }

    [Theory]
    [InlineData("empty")]
    [InlineData("denied")]
    public async Task Stability_EmptyObservationStillCannotSucceedAsQuery(string scope)
    {
        var fixture = new Fixture();
        fixture.Source.Empty = scope == "empty";
        fixture.Permission.DeniedId = scope == "denied" ? 1 : 0;

        AuthorArticleQuerySourceInspectionResult result = await fixture.Inspection.InspectStablePageAsync(Request(), 0);

        Assert.Equal(AuthorArticleQuerySourceUnavailableReason.SlugUnavailable, result.UnavailableReason);
        Assert.Empty(result.ObservedFields);
        Assert.Equal(0, fixture.Source.FieldReads);
        Assert.Equal(0, fixture.Source.CoordinateRechecks);
    }

    [Theory]
    [InlineData("archived")]
    [InlineData("cursor")]
    [InlineData("permission")]
    [InlineData("recent")]
    public async Task Stability_OriginalRefusalsCannotReachNewMetadataReads(string scope)
    {
        var fixture = new Fixture();
        fixture.Permission.Unavailable = scope == "permission";
        AuthorArticleQueryRequest request = scope switch
        {
            "archived" => Request() with { Statuses = [AuthorArticleQueryStatus.Archived] },
            "cursor" => Request() with { Cursor = "unverified-cursor" },
            "recent" => Request() with { Buckets = [AuthorArticleQueryBucket.Recent] },
            _ => Request()
        };

        AuthorArticleQuerySourceInspectionResult result = await fixture.Inspection.InspectStablePageAsync(request, 0);

        Assert.Equal(scope switch
        {
            "archived" => AuthorArticleQuerySourceUnavailableReason.ArchivedReadGrantUnavailable,
            "cursor" => AuthorArticleQuerySourceUnavailableReason.QueryCursorUnavailable,
            "recent" => AuthorArticleQuerySourceUnavailableReason.VerifiedRecentSourceUnavailable,
            _ => AuthorArticleQuerySourceUnavailableReason.PermissionUnavailable
        }, result.UnavailableReason);
        AssertClosed(result);
        Assert.Equal(0, fixture.Source.FieldReads);
    }

    [Fact]
    public async Task Stability_MissingExactIdCapabilityNeverReplaysCorpus()
    {
        var fixture = new Fixture();

        AuthorArticleQuerySourceInspectionResult result = await new AuthorArticleQuerySourceInspection(
            fixture.Permission, new CorpusOnly(fixture.Source)).InspectStablePageAsync(Request(), 0);

        Assert.Equal(AuthorArticleQuerySourceUnavailableReason.SourceWindowUnavailable, result.UnavailableReason);
        AssertClosed(result);
        Assert.Equal(1, fixture.Source.CorpusReads);
        Assert.Equal(1, fixture.Source.FieldReads);
    }

    [Fact]
    public async Task Stability_CanceledRequestCannotReadPermissionOrSource()
    {
        var fixture = new Fixture();
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => fixture.Inspection.InspectStablePageAsync(
            Request(), 0, cancellation.Token));

        Assert.Equal(0, fixture.Permission.Calls);
        Assert.Equal(0, fixture.Source.CorpusReads);
    }

    [Fact]
    public async Task Stability_CancellationDuringCoordinateRecheckStopsSecondMetadataRead()
    {
        var fixture = new Fixture();
        using var cancellation = new CancellationTokenSource();
        fixture.Source.BeforeCoordinateRecheck = cancellation.Cancel;

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => fixture.Inspection.InspectStablePageAsync(
            Request(), 0, cancellation.Token));

        Assert.Equal(1, fixture.Source.FieldReads);
    }

    [Fact]
    public async Task Stability_HistoryMutationAfterSecondMetadataReadDiscardsObservation()
    {
        var fixture = new Fixture(withHistory: true);
        fixture.Source.AfterSecondFieldsRead = () => fixture.HistorySnapshot = Snapshot(2);

        AuthorArticleQuerySourceInspectionResult result = await fixture.Inspection.InspectStablePageAsync(
            Request() with
            {
                Buckets = [AuthorArticleQueryBucket.Recent]
            }, 0);

        Assert.Equal(AuthorArticleQuerySourceUnavailableReason.VerifiedRecentSourceUnavailable, result.UnavailableReason);
        AssertClosed(result);
        Assert.Equal(2, fixture.Source.FieldReads);
    }

    [Fact]
    public async Task Stability_RechecksOriginalPermissionScopeIncludingDeniedIds()
    {
        var fixture = new Fixture();
        fixture.Source.IncludeSecond = true;
        fixture.Permission.DeniedId = 2;

        AuthorArticleQuerySourceInspectionResult result = await fixture.Inspection.InspectStablePageAsync(Request(), 0);

        Assert.Equal(AuthorArticleQuerySourceUnavailableReason.SlugUnavailable, result.UnavailableReason);
        Assert.Equal(1, Assert.Single(result.ObservedFields).Coordinate.ArticleId);
        Assert.Equal(new[] { 1, 2 }, fixture.Permission.Requests[^1].ArticleIds);
        Assert.Equal(new[] { 1 }, fixture.Source.LastRecheckIds);
        Assert.Equal(new[] { 1 }, fixture.Source.LastFieldIds);
    }

    [Fact]
    public async Task Stability_DoesNotAliasMutableSourceTagArrays()
    {
        var fixture = new Fixture();

        AuthorArticleQuerySourceInspectionResult result = await fixture.Inspection.InspectStablePageAsync(Request(), 0);
        fixture.Source.Tags[0] = "after-return";

        Assert.Equal(new[] { "tag-a", "tag-b" }, Assert.Single(result.ObservedFields).Tags);
        Assert.Equal(AuthorArticleQuerySourceUnavailableReason.SlugUnavailable, result.UnavailableReason);
    }

    private static void AssertClosed(AuthorArticleQuerySourceInspectionResult result)
    {
        Assert.Empty(result.ObservedFields);
        Assert.Empty(result.RecentBindings);
        Assert.Null(result.HistoryIdentity);
        Assert.Null(result.NextAfterArticleId);
        Assert.False(result.HasMore);
    }

    private static AuthorArticleQueryRequest Request()
        => new(1, new(7, "site-a"), Guid.CreateVersion7(), 1, "article", [AuthorArticleQueryStatus.Draft],
            [AuthorArticleQueryBucket.Draft], "zh-CN", AuthorArticleQueryContract.Collation, 10, null);

    private static AuthorArticleQuerySourceCoordinate Coordinate(int id)
        => new(id, id * 10L, $"row-{id}", AuthorArticleQueryStatus.Draft);

    private static string Hash(string text) => AuthorRecentArticleHistoryContract.HashText(text);

    private static AuthorRecentArticleHistoryCollectionSnapshot Snapshot(int revision)
    {
        var owner = new AuthorRecentArticleHistoryOwner(7, "site-a");
        var entry = new AuthorRecentArticleHistoryEntry(1, 1,
            new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddSeconds(revision),
            null, null, "open", revision, Hash("pending"));
        entry = entry with
        {
            ContentDigest = AuthorRecentArticleHistoryContract.ComputeEntryDigest(owner, entry)
        };
        return new(owner, 1, revision, 1, [entry], RecentArticleHistoryOrdering.LatestFactAtUtc(entry),
            AuthorRecentArticleHistoryContract.ComputeCollectionDigest(owner, revision, [entry]));
    }

    private sealed class Fixture
    {
        public Source Source { get; } = new();
        public Permission Permission { get; } = new();
        public AuthorRecentArticleHistoryCollectionSnapshot HistorySnapshot { get; set; } = Snapshot(1);
        public AuthorArticleQuerySourceInspection Inspection
        {
            get;
        }

        public Fixture(bool withHistory = false)
        {
            if (!withHistory)
            {
                Inspection = new(Permission, Source);
                return;
            }
            var store = Substitute.For<IAuthorRecentArticleHistoryStore>();
            store.GetAuthoritySnapshotAsync(Arg.Any<AuthorRecentArticleHistoryOwner>(), Arg.Any<CancellationToken>())
                .Returns(_ => Task.FromResult(HistorySnapshot));
            store.VerifyAsync(Arg.Any<AuthorRecentArticleHistoryOwner>(), Arg.Any<CancellationToken>())
                .Returns(_ => Task.FromResult(new AuthorRecentArticleHistoryVerificationResult(
                    true, [], HistorySnapshot.Revision, HistorySnapshot.ItemCount, HistorySnapshot.ContentDigest)));
            var projection = new AuthorRecentArticleHistoryProjectionService(store, Permission,
                new AuthorRecentArticleHistoryCursorCodec(new EphemeralDataProtectionProvider()),
                new DirectAuthorRecentArticleHistoryProjectionCache());
            Inspection = new(Permission, Source, new AuthorArticleQueryHistoryIdentityReader(projection));
        }
    }

    private sealed class Permission : IAuthorRecentArticleHistoryPermissionProjectionProvider
    {
        public int Calls
        {
            get; private set;
        }
        public string? Fault
        {
            get; set;
        }
        public int FaultCall
        {
            get; set;
        }
        public bool Unavailable
        {
            get; set;
        }
        public int DeniedId
        {
            get; set;
        }
        public List<AuthorRecentArticleHistoryPermissionRequest> Requests { get; } = [];

        public Task<AuthorRecentArticleHistoryPermissionSnapshot> ResolveAsync(
            AuthorRecentArticleHistoryPermissionRequest request, CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Calls++;
            Requests.Add(request);
            bool fault = Calls == FaultCall;
            var snapshot = new AuthorRecentArticleHistoryPermissionSnapshot(
                Unavailable ? AuthorRecentArticleHistoryPermissionSnapshotStatus.Unavailable
                    : AuthorRecentArticleHistoryPermissionSnapshotStatus.Current,
                fault && Fault == "owner" ? request.Owner with
                {
                    SiteScope = "other-site"
                } : request.Owner,
                Hash("permission"), Hash("site"), Hash(fault && Fault == "session" ? "changed-session" : "session"),
                request.ArticleIds.Select(id => new AuthorRecentArticleHistoryPermissionDecision(id,
                    id != DeniedId, id != DeniedId && !(fault && Fault == "write"),
                    Hash(fault && Fault == "decision" ? $"changed-{id}" : $"decision-{id}"))).ToArray(), string.Empty);
            return Task.FromResult(snapshot with
            {
                ContentDigest = fault && Fault == "digest" ? Hash("invalid-digest")
                    : AuthorRecentArticleHistoryContract.ComputePermissionDigest(snapshot)
            });
        }
    }

    private sealed class CorpusOnly(Source source) : IAuthorArticleQuerySourceReader
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
        public bool Empty
        {
            get; set;
        }
        public bool IncludeSecond
        {
            get; set;
        }
        public int CorpusReads
        {
            get; private set;
        }
        public int FieldReads
        {
            get; private set;
        }
        public int CoordinateRechecks
        {
            get; private set;
        }
        public string? MetadataFault
        {
            get; set;
        }
        public string? CoordinateFault
        {
            get; set;
        }
        public Action? BeforeCoordinateRecheck
        {
            get; set;
        }
        public Action? AfterSecondFieldsRead
        {
            get; set;
        }
        public int[] LastRecheckIds { get; private set; } = [];
        public int[] LastFieldIds { get; private set; } = [];
        public string[] Tags { get; } = ["tag-a", "tag-b"];

        public Task<AuthorArticleQuerySourceBatch> ReadCoordinatesAsync(
            IReadOnlyList<AuthorArticleQueryStatus> statuses, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            CorpusReads++;
            return Task.FromResult(new AuthorArticleQuerySourceBatch(Empty ? []
                : IncludeSecond ? [Coordinate(1), Coordinate(2)] : [Coordinate(1)], false));
        }

        public Task<AuthorArticleQuerySourceBatch> ReadCoordinatesForIdsAsync(
            IReadOnlyList<AuthorArticleQueryStatus> statuses, IReadOnlyList<int> articleIds,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            BeforeCoordinateRecheck?.Invoke();
            cancellationToken.ThrowIfCancellationRequested();
            CoordinateRechecks++;
            LastRecheckIds = articleIds.ToArray();
            AuthorArticleQuerySourceCoordinate[] coordinates = CoordinateFault switch
            {
                "revision" => [Coordinate(1) with { ServerRevision = 999 }],
                "row-version" => [Coordinate(1) with { RowVersion = "changed-row" }],
                "lifecycle" => [Coordinate(1) with { Status = AuthorArticleQueryStatus.Archived }],
                "missing" => [],
                "duplicate" => [Coordinate(1), Coordinate(1)],
                "unrequested" => [Coordinate(99)],
                _ => articleIds.Select(Coordinate).ToArray()
            };
            return Task.FromResult(new AuthorArticleQuerySourceBatch(coordinates, CoordinateFault == "has-more"));
        }

        public Task<IReadOnlyList<AuthorArticleQuerySourceFields>> ReadFieldsAsync(
            IReadOnlyList<int> admittedArticleIds, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            FieldReads++;
            LastFieldIds = admittedArticleIds.ToArray();
            bool second = FieldReads == 2;
            if (second && MetadataFault == "mutable-tags")
            {
                Tags[0] = "changed-tag";
            }
            IReadOnlyList<AuthorArticleQuerySourceFields> fields = admittedArticleIds.Select(id =>
                new AuthorArticleQuerySourceFields(Coordinate(id),
                    second && MetadataFault == "title" ? "changed-title" : "title",
                    second && MetadataFault == "category" ? "changed-category" : "category",
                    second && MetadataFault == "tags" ? ["changed-tag", "tag-b"]
                        : second && MetadataFault == "tag-order" ? ["tag-b", "tag-a"] : Tags)).ToArray();
            if (second)
            {
                AfterSecondFieldsRead?.Invoke();
            }
            return Task.FromResult(fields);
        }
    }
}
