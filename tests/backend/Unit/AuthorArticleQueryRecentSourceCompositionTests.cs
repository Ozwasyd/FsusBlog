using FsusBlog.Contracts.Articles;
using FsusBlog.Server.Services.Authoring;

using Microsoft.AspNetCore.DataProtection;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Ordinary source composition controls; substituted durable storage is not runtime qualification.</summary>
[Trait("Category", "Unit")]
public sealed class AuthorArticleQueryRecentSourceCompositionTests
{
    [Fact]
    public async Task Recent_BindsOriginalVerifiedOrdinalsToLiveIdsAndDistinctRevisions()
    {
        var fixture = new Fixture();

        AuthorArticleQuerySourceInspectionResult result = await fixture.Inspection.InspectAsync(Request());

        Assert.Equal(AuthorArticleQuerySourceUnavailableReason.SlugUnavailable, result.UnavailableReason);
        Assert.Equal(0, fixture.Source.CorpusReads);
        Assert.Equal(new[] { 2001, 3001 }, fixture.Source.LastHistoryIds);
        Assert.Equal(new[] { 2001, 3001 }, result.ObservedFields.Select(static field => field.Coordinate.ArticleId));
        Assert.Equal(new[] { 3001, 2001 }, result.RecentBindings.Select(static binding => binding.Coordinate.ArticleId));
        Assert.Equal(new[] { 1, 2 }, result.RecentBindings.Select(static binding => binding.Ordinal));
        Assert.All(result.RecentBindings, static binding =>
        {
            Assert.Equal(10, binding.HistoryServerRevision);
            Assert.NotEqual(binding.HistoryServerRevision, binding.Coordinate.ServerRevision);
        });
        Assert.Equal(fixture.Snapshot.Revision, Assert.IsType<AuthorArticleQueryHistoryIdentity>(result.HistoryIdentity)
            .CollectionRevision);
        await fixture.Store.Received(2).VerifyAsync(Arg.Any<AuthorRecentArticleHistoryOwner>(), Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Recent_MixedBucketsDeduplicateLiveIdentityAndPreserveOnlyRecentOrdinals()
    {
        var fixture = new Fixture();
        fixture.Source.Corpus = [Coordinate(1), Coordinate(2001)];

        AuthorArticleQuerySourceInspectionResult result = await fixture.Inspection.InspectAsync(
            Request() with
            {
                Buckets = [AuthorArticleQueryBucket.Recent, AuthorArticleQueryBucket.Draft]
            });

        Assert.Equal(AuthorArticleQuerySourceUnavailableReason.SlugUnavailable, result.UnavailableReason);
        Assert.Equal(new[] { 1, 2001, 3001 }, result.ObservedFields.Select(static field => field.Coordinate.ArticleId));
        Assert.Equal(new[] { 3001, 2001 }, result.RecentBindings.Select(static binding => binding.Coordinate.ArticleId));
        Assert.Equal(1, fixture.Source.CorpusReads);
    }

    [Theory]
    [InlineData("project")]
    [InlineData("write")]
    public async Task Recent_FiltersOriginalPermissionBeforeMetadata(string denied)
    {
        var fixture = new Fixture();
        fixture.Permission.DeniedProjectionId = denied == "project" ? 3001 : 0;
        fixture.Permission.DeniedWriteId = 3001;

        AuthorArticleQuerySourceInspectionResult result = await fixture.Inspection.InspectAsync(Request());

        Assert.Equal(AuthorArticleQuerySourceUnavailableReason.SlugUnavailable, result.UnavailableReason);
        Assert.Equal(new[] { 2001 }, fixture.Source.LastFieldIds);
        Assert.Equal(2001, Assert.Single(result.RecentBindings).Coordinate.ArticleId);
    }

    [Theory]
    [InlineData("verification")]
    [InlineData("cache")]
    public async Task Recent_UnavailableCanonicalProjectionCannotReadCurrentMetadata(string fault)
    {
        var fixture = new Fixture();
        fixture.InvalidVerification = fault == "verification";
        fixture.RejectCache = fault == "cache";

        AuthorArticleQuerySourceInspectionResult result = await fixture.Inspection.InspectAsync(Request());

        Assert.Equal(AuthorArticleQuerySourceUnavailableReason.VerifiedRecentSourceUnavailable, result.UnavailableReason);
        AssertClosed(result);
        Assert.Equal(0, fixture.Source.HistoryReads);
        Assert.Equal(0, fixture.Source.FieldReads);
    }

    [Fact]
    public async Task Recent_HistoryPermissionDriftCannotReadMetadata()
    {
        var fixture = new Fixture();
        fixture.Source.BeforeHistoryRead = () => fixture.Permission.SessionRevision = Hash("changed-session");

        AuthorArticleQuerySourceInspectionResult result = await fixture.Inspection.InspectAsync(Request());

        Assert.Equal(AuthorArticleQuerySourceUnavailableReason.PermissionChanged, result.UnavailableReason);
        AssertClosed(result);
        Assert.Equal(0, fixture.Source.FieldReads);
    }

    [Fact]
    public async Task Recent_HistoryChangesDuringMetadataDiscardEveryBinding()
    {
        var fixture = new Fixture();
        fixture.Source.BeforeFieldsRead = () => fixture.Snapshot = Snapshot([2001]);

        AuthorArticleQuerySourceInspectionResult result = await fixture.Inspection.InspectAsync(Request());

        Assert.Equal(AuthorArticleQuerySourceUnavailableReason.VerifiedRecentSourceUnavailable, result.UnavailableReason);
        AssertClosed(result);
        Assert.Equal(1, fixture.Source.FieldReads);
    }

    [Theory]
    [InlineData("coordinates-unrequested")]
    [InlineData("metadata-revision")]
    [InlineData("overlap-revision")]
    public async Task Recent_CurrentSourceDriftDiscardsEveryField(string fault)
    {
        var fixture = new Fixture();
        fixture.Source.Fault = fault;
        if (fault == "overlap-revision")
        {
            fixture.Source.Corpus = [Coordinate(2001) with { ServerRevision = 999 }];
        }

        AuthorArticleQuerySourceInspectionResult result = await fixture.Inspection.InspectAsync(
            Request() with
            {
                Buckets = [AuthorArticleQueryBucket.Recent, AuthorArticleQueryBucket.Draft]
            });

        Assert.Equal(AuthorArticleQuerySourceUnavailableReason.SourceChanged, result.UnavailableReason);
        AssertClosed(result);
    }

    [Theory]
    [InlineData("archived-status")]
    [InlineData("archived-bucket")]
    [InlineData("cursor")]
    public async Task Recent_ArchivedAndCursorRemainClosedBeforeHistory(string fault)
    {
        var fixture = new Fixture();
        AuthorArticleQueryRequest request = fault switch
        {
            "archived-status" => Request() with { Statuses = [AuthorArticleQueryStatus.Archived] },
            "archived-bucket" => Request() with { Buckets = [AuthorArticleQueryBucket.Recent, AuthorArticleQueryBucket.Archived] },
            _ => Request() with { Cursor = "unverified-cursor" }
        };

        AuthorArticleQuerySourceInspectionResult result = await fixture.Inspection.InspectAsync(request);

        Assert.Equal(fault == "cursor" ? AuthorArticleQuerySourceUnavailableReason.QueryCursorUnavailable
            : AuthorArticleQuerySourceUnavailableReason.ArchivedReadGrantUnavailable, result.UnavailableReason);
        AssertClosed(result);
        await fixture.Store.DidNotReceive().GetAuthoritySnapshotAsync(
            Arg.Any<AuthorRecentArticleHistoryOwner>(), Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Recent_CancellationDuringCanonicalHistoryStopsBeforeCurrentSource()
    {
        var fixture = new Fixture();
        using var cancellation = new CancellationTokenSource();
        fixture.BeforeSnapshot = cancellation.Cancel;

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => fixture.Inspection.InspectAsync(Request(), cancellation.Token));

        Assert.Equal(0, fixture.Source.HistoryReads);
        Assert.Equal(0, fixture.Source.FieldReads);
    }

    [Fact]
    public async Task Recent_BoundedUnionNeverPretendsToBeCompleteRankedQuery()
    {
        var fixture = new Fixture();
        fixture.Source.Corpus = Enumerable.Range(1, AuthorArticleQuerySourceInspection.MaxBatchSize)
            .Select(Coordinate).ToArray();

        AuthorArticleQuerySourceInspectionResult result = await fixture.Inspection.InspectAsync(
            Request() with
            {
                Buckets = [AuthorArticleQueryBucket.Recent, AuthorArticleQueryBucket.Draft]
            });

        Assert.Equal(AuthorArticleQuerySourceUnavailableReason.SourceWindowUnavailable, result.UnavailableReason);
        AssertClosed(result);
        Assert.Equal(0, fixture.Source.FieldReads);
    }

    [Fact]
    public async Task Recent_EmptyVerifiedHistoryStillRefusesSlug()
    {
        var fixture = new Fixture { Snapshot = Snapshot([]) };

        AuthorArticleQuerySourceInspectionResult result = await fixture.Inspection.InspectAsync(Request());

        Assert.Equal(AuthorArticleQuerySourceUnavailableReason.SlugUnavailable, result.UnavailableReason);
        Assert.NotNull(result.HistoryIdentity);
        Assert.Empty(result.RecentBindings);
        Assert.Empty(result.ObservedFields);
        Assert.Equal(0, fixture.Source.HistoryReads);
    }

    [Fact]
    public async Task Recent_CurrentStatusFilterCanExcludeExistingHistoryEntry()
    {
        var fixture = new Fixture();

        AuthorArticleQuerySourceInspectionResult result = await fixture.Inspection.InspectAsync(
            Request() with
            {
                Statuses = [AuthorArticleQueryStatus.Published]
            });

        Assert.Equal(AuthorArticleQuerySourceUnavailableReason.SlugUnavailable, result.UnavailableReason);
        Assert.NotNull(result.HistoryIdentity);
        Assert.Empty(result.RecentBindings);
        Assert.Empty(result.ObservedFields);
    }

    [Fact]
    public async Task Recent_MissingExactIdCapabilityNeverFallsBackToCorpusPrefix()
    {
        var fixture = new Fixture();
        var borrowed = new BorrowedCorpusSource(fixture.Source);

        AuthorArticleQuerySourceInspectionResult result = await new AuthorArticleQuerySourceInspection(
            fixture.Permission, borrowed, fixture.History).InspectAsync(Request());

        Assert.Equal(AuthorArticleQuerySourceUnavailableReason.VerifiedRecentSourceUnavailable, result.UnavailableReason);
        AssertClosed(result);
        Assert.Equal(0, fixture.Source.CorpusReads);
        Assert.Equal(0, fixture.Source.FieldReads);
    }

    [Theory]
    [InlineData(101)]
    [InlineData(1000)]
    public async Task Recent_ComposesEveryPageFromOriginalBoundedHistory(int count)
    {
        var fixture = new Fixture { Snapshot = Snapshot(Enumerable.Range(1, count).ToArray()) };

        AuthorArticleQuerySourceInspectionResult result = await fixture.Inspection.InspectAsync(Request());

        Assert.Equal(AuthorArticleQuerySourceUnavailableReason.SlugUnavailable, result.UnavailableReason);
        Assert.Equal(count, result.ObservedFields.Count);
        Assert.Equal(Enumerable.Range(1, count).Reverse(),
            result.RecentBindings.Select(static binding => binding.Coordinate.ArticleId));
        Assert.Equal(Enumerable.Range(1, count), result.RecentBindings.Select(static binding => binding.Ordinal));
        await fixture.Store.Received(2 * ((count + 99) / 100)).VerifyAsync(
            Arg.Any<AuthorRecentArticleHistoryOwner>(), Arg.Any<CancellationToken>());
    }

    private static void AssertClosed(AuthorArticleQuerySourceInspectionResult result)
    {
        Assert.Empty(result.ObservedFields);
        Assert.Empty(result.RecentBindings);
        Assert.Null(result.HistoryIdentity);
    }

    private static AuthorArticleQueryRequest Request()
        => new(1, new(7, "site-a"), Guid.CreateVersion7(), 1, "article",
            [AuthorArticleQueryStatus.Draft], [AuthorArticleQueryBucket.Recent], "zh-CN",
            AuthorArticleQueryContract.Collation, 10, null);

    private static AuthorArticleQuerySourceCoordinate Coordinate(int id)
        => new(id, id * 10L + 1, $"live-row-{id}", AuthorArticleQueryStatus.Draft);

    private static string Hash(string text) => AuthorRecentArticleHistoryContract.HashText(text);

    private static AuthorRecentArticleHistoryCollectionSnapshot Snapshot(int[] ids)
    {
        var owner = new AuthorRecentArticleHistoryOwner(7, "site-a");
        AuthorRecentArticleHistoryEntry[] entries = ids.Reverse().Select((id, index) =>
        {
            var entry = new AuthorRecentArticleHistoryEntry(id, 10,
                new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddSeconds(ids.Length - index),
                null, null, "open", ids.Length - index, Hash("pending"));
            return entry with
            {
                ContentDigest = AuthorRecentArticleHistoryContract.ComputeEntryDigest(owner, entry)
            };
        }).ToArray();
        long revision = entries.Length;
        return new(owner, 1, revision, entries.Length, entries,
            entries.Length == 0 ? DateTime.SpecifyKind(DateTime.MinValue, DateTimeKind.Utc)
                : entries.Max(RecentArticleHistoryOrdering.LatestFactAtUtc),
            AuthorRecentArticleHistoryContract.ComputeCollectionDigest(owner, revision, entries));
    }

    private sealed class Fixture
    {
        public AuthorRecentArticleHistoryCollectionSnapshot Snapshot
        {
            get; set;
        } =
            AuthorArticleQueryRecentSourceCompositionTests.Snapshot([2001, 3001]);
        public bool InvalidVerification
        {
            get; set;
        }
        public bool RejectCache
        {
            get; set;
        }
        public Action? BeforeSnapshot
        {
            get; set;
        }
        public Permission Permission { get; } = new();
        public Source Source { get; } = new();
        public IAuthorRecentArticleHistoryStore Store { get; } = Substitute.For<IAuthorRecentArticleHistoryStore>();
        public AuthorArticleQuerySourceInspection Inspection
        {
            get;
        }
        public AuthorArticleQueryHistoryIdentityReader History
        {
            get;
        }

        public Fixture()
        {
            Store.GetAuthoritySnapshotAsync(Arg.Any<AuthorRecentArticleHistoryOwner>(), Arg.Any<CancellationToken>())
                .Returns(call =>
                {
                    BeforeSnapshot?.Invoke();
                    call.ArgAt<CancellationToken>(1).ThrowIfCancellationRequested();
                    return Task.FromResult(Snapshot);
                });
            Store.VerifyAsync(Arg.Any<AuthorRecentArticleHistoryOwner>(), Arg.Any<CancellationToken>())
                .Returns(_ => Task.FromResult(new AuthorRecentArticleHistoryVerificationResult(!InvalidVerification,
                    [], Snapshot.Revision, Snapshot.ItemCount, Snapshot.ContentDigest)));
            var cache = Substitute.For<IAuthorRecentArticleHistoryProjectionCache>();
            var directCache = new DirectAuthorRecentArticleHistoryProjectionCache();
            cache.PublishAsync(Arg.Any<AuthorRecentArticleHistoryProjectionPage>(),
                Arg.Any<IReadOnlyList<AuthorRecentArticleHistoryEntry>>(), Arg.Any<CancellationToken>())
                .Returns(call => RejectCache ? Task.FromResult(false)
                    : directCache.PublishAsync(call.ArgAt<AuthorRecentArticleHistoryProjectionPage>(0),
                        call.ArgAt<IReadOnlyList<AuthorRecentArticleHistoryEntry>>(1), call.ArgAt<CancellationToken>(2)));
            var projection = new AuthorRecentArticleHistoryProjectionService(Store, Permission,
                new AuthorRecentArticleHistoryCursorCodec(new EphemeralDataProtectionProvider()), cache);
            History = new(projection);
            Inspection = new(Permission, Source, History);
        }
    }

    private sealed class Permission : IAuthorRecentArticleHistoryPermissionProjectionProvider
    {
        public int DeniedProjectionId
        {
            get; set;
        }
        public int DeniedWriteId
        {
            get; set;
        }
        public string SessionRevision { get; set; } = Hash("session");

        public Task<AuthorRecentArticleHistoryPermissionSnapshot> ResolveAsync(
            AuthorRecentArticleHistoryPermissionRequest request, CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var snapshot = new AuthorRecentArticleHistoryPermissionSnapshot(
                AuthorRecentArticleHistoryPermissionSnapshotStatus.Current, request.Owner,
                Hash("permission"), Hash("site"), SessionRevision,
                request.ArticleIds.Select(id => new AuthorRecentArticleHistoryPermissionDecision(id,
                    id != DeniedProjectionId, id != DeniedWriteId, Hash($"decision-{id}"))).ToArray(), string.Empty);
            return Task.FromResult(snapshot with
            {
                ContentDigest = AuthorRecentArticleHistoryContract.ComputePermissionDigest(snapshot)
            });
        }
    }

    private sealed class BorrowedCorpusSource(Source source) : IAuthorArticleQuerySourceReader
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
        public AuthorArticleQuerySourceCoordinate[] Corpus { get; set; } = [];
        public string? Fault
        {
            get; set;
        }
        public Action? BeforeHistoryRead
        {
            get; set;
        }
        public Action? BeforeFieldsRead
        {
            get; set;
        }
        public int CorpusReads
        {
            get; private set;
        }
        public int HistoryReads
        {
            get; private set;
        }
        public int FieldReads
        {
            get; private set;
        }
        public int[] LastHistoryIds { get; private set; } = [];
        public int[] LastFieldIds { get; private set; } = [];

        public Task<AuthorArticleQuerySourceBatch> ReadCoordinatesAsync(
            IReadOnlyList<AuthorArticleQueryStatus> statuses, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            CorpusReads++;
            return Task.FromResult(new AuthorArticleQuerySourceBatch(Corpus, false));
        }

        public Task<AuthorArticleQuerySourceBatch> ReadCoordinatesForIdsAsync(
            IReadOnlyList<AuthorArticleQueryStatus> statuses, IReadOnlyList<int> articleIds,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            BeforeHistoryRead?.Invoke();
            HistoryReads++;
            LastHistoryIds = articleIds.ToArray();
            return Task.FromResult(new AuthorArticleQuerySourceBatch(Fault == "coordinates-unrequested"
                ? [Coordinate(99)] : articleIds.Select(Coordinate).Where(row => statuses.Contains(row.Status)).ToArray(), false));
        }

        public Task<IReadOnlyList<AuthorArticleQuerySourceFields>> ReadFieldsAsync(
            IReadOnlyList<int> admittedArticleIds, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            BeforeFieldsRead?.Invoke();
            FieldReads++;
            LastFieldIds = admittedArticleIds.ToArray();
            IReadOnlyList<AuthorArticleQuerySourceFields> fields = admittedArticleIds.Select(id =>
                new AuthorArticleQuerySourceFields(Fault == "metadata-revision"
                    ? Coordinate(id) with
                    {
                        ServerRevision = 999
                    } : Coordinate(id),
                    "real-title", "real-category", ["real-tag"])).ToArray();
            return Task.FromResult(fields);
        }
    }
}
