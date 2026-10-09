using FsusBlog.Server.Entities;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleGraph;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Controlled canonical lookup/context tests; resolved coordinates never confer a node permission.</summary>
[Trait("Category", "Unit")]
public sealed class ArticleGraphNodeCandidateResolverTests
{
    [Fact]
    public async Task NativePortableIdentitiesResolveThroughCanonicalReaderInStableReadonlyOrder()
    {
        var fixture = new Fixture();
        ArticleGraphNodeCandidates result = Assert.IsType<ArticleGraphNodeCandidates>(await fixture.ResolveAsync([Article(2), Article(1)]));
        Assert.Equal(new[] { Article(1), Article(2) }, fixture.Lookups);
        Assert.Equal(new[] { 1, 2 }, result.Coordinates.Select(static coordinate => coordinate.ArticleId));
        Assert.Equal(4, result.ReadOperations);
        Assert.InRange(result.RemainingMilliseconds, 1, 250);
        Assert.Equal(2, fixture.ContextReads);
        var coordinates = Assert.IsAssignableFrom<IList<ArticleRelationArticleCoordinate>>(result.Coordinates);
        Assert.True(coordinates.IsReadOnly);
        Assert.Throws<NotSupportedException>(() => coordinates.Clear());
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("wrong-portable")]
    [InlineData("invalid-numeric")]
    [InlineData("duplicate-numeric")]
    public async Task InvalidCanonicalMappingCannotProduceCandidates(string mutation)
    {
        var fixture = new Fixture { MappingMutation = mutation };
        Assert.Null(await fixture.ResolveAsync([Article(1), Article(2)]));
    }

    [Theory]
    [InlineData("denied")]
    [InlineData("owner")]
    [InlineData("digest")]
    [InlineData("nonempty")]
    public async Task InvalidLiveContextPrecedesCanonicalLookup(string mutation)
    {
        var fixture = new Fixture { ContextMutation = mutation };
        Assert.Null(await fixture.ResolveAsync([Article(1)]));
        Assert.Empty(fixture.Lookups);
    }

    [Fact]
    public async Task ContextDriftDuringLookupDiscardsAllMappings()
    {
        var fixture = new Fixture();
        fixture.AfterLookup = () => fixture.SessionRevision = "session:changed";
        Assert.Null(await fixture.ResolveAsync([Article(1), Article(2)]));
    }

    [Fact]
    public async Task InvalidIdentityDuplicateAndOversizedInputsInvokeNoReaders()
    {
        var fixture = new Fixture();
        Assert.Null(await fixture.ResolveAsync(["article:1"]));
        Assert.Null(await fixture.ResolveAsync([Article(1), Article(1)]));
        Assert.Null(await fixture.ResolveAsync(Enumerable.Range(1, 10000).Select(Article).ToArray()));
        Assert.Empty(fixture.Lookups);
        Assert.Equal(0, fixture.ContextReads);
    }

    [Fact]
    public async Task TheLookupAllocationMustLeaveBothContextReads()
    {
        var fixture = new Fixture();
        Assert.Null(await fixture.ResolveAsync([Article(1), Article(2)], operations: 3));
        Assert.Empty(fixture.Lookups);
        Assert.Equal(0, fixture.ContextReads);
    }

    [Fact]
    public async Task PinnedStateCannotReadContextOrCoordinates()
    {
        var fixture = new Fixture { Fresh = false };
        Assert.Null(await fixture.ResolveAsync([Article(1)]));
        Assert.Empty(fixture.Lookups);
        Assert.Equal(0, fixture.ContextReads);
    }

    [Fact]
    public async Task CancellationPrecedesAllReaders()
    {
        var fixture = new Fixture();
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => fixture.ResolveAsync([Article(1)], token: cancellation.Token));
        Assert.Empty(fixture.Lookups);
        Assert.Equal(0, fixture.ContextReads);
    }

    [Fact]
    public async Task ResolvedPairsStillNeedIndependentNeighborAdmissionBeforeMetadata()
    {
        var fixture = new Fixture();
        ArticleGraphNodeCandidates candidates = Assert.IsType<ArticleGraphNodeCandidates>(
            await fixture.ResolveAsync([Article(1), Article(2)]));
        var readers = new NeighborReaders();
        var consumer = new ArticleGraphNodeProjectionConsumer(readers, readers,
            (id, revision, token) => Task.FromResult<ArticleRelationRevisionCoordinate?>(new(id, revision, 1, Article(id),
                $"revision:c0000000-0000-0000-0000-{id:D12}", Guid.Parse("d0000000-0000-0000-0000-000000000001"))), () => true);
        ArticleGraphNodeProjectionConsumer.NodeRead read = Assert.IsType<ArticleGraphNodeProjectionConsumer.NodeRead>(
            await consumer.ReadAsync(new(new(1, "site:fixture"), Guid.NewGuid(), candidates.Coordinates,
                ArticleGraphScope.CurrentEditable, new([], [], [ArticleGraphEdgeKind.Link]),
                4096 - candidates.ReadOperations, candidates.RemainingMilliseconds)));

        Assert.Equal(Article(1), Assert.Single(read.Nodes).ArticleIdentity);
        Assert.Equal(2, readers.MetadataReads);
        Assert.True(await consumer.VerifyAsync(read));
        Assert.Equal(4, readers.MetadataReads);
    }

    [Theory]
    [InlineData("permission")]
    [InlineData("coordinate")]
    public async Task CancellationWaitsForBorrowedLookupCompletion(string boundary)
    {
        var fixture = new Fixture();
        var started = new TaskCompletionSource<CancellationToken>(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        bool completed = false;
        async Task PauseAsync(CancellationToken token)
        {
            started.TrySetResult(token);
            await release.Task;
            completed = true;
        }
        if (boundary == "permission")
        {
            fixture.BeforeContext = PauseAsync;
        }
        else
        {
            fixture.BeforeLookup = PauseAsync;
        }
        using var cancellation = new CancellationTokenSource();
        Task<ArticleGraphNodeCandidates?> pending = fixture.ResolveAsync([Article(1)], token: cancellation.Token);
        try
        {
            CancellationToken token = await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
            cancellation.Cancel();
            Assert.True(token.IsCancellationRequested);
            Assert.False(completed);
            // Observe cancellation continuations while the simulated lookup remains held.
            Task observation = Task.Delay(TimeSpan.FromMilliseconds(25));
            Assert.Same(observation, await Task.WhenAny(pending, observation).WaitAsync(TimeSpan.FromSeconds(5)));
            Assert.False(pending.IsCompleted);
        }
        finally
        {
            release.TrySetResult();
        }
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.True(completed);
    }

    private static string Article(int id) => $"article:b0000000-0000-0000-0000-{id:D12}";

    private sealed class NeighborReaders : IAuthorArticlePinPermissionProjectionProvider, IAuthorArticlePinArticleProjectionSource
    {
        internal int MetadataReads
        {
            get; private set;
        }

        public Task<AuthorArticlePinPermissionSnapshot> ResolveAsync(AuthorArticlePinPermissionBatchRequest request,
            CancellationToken cancellationToken = default)
        {
            var value = new AuthorArticlePinPermissionSnapshot(AuthorArticlePinPermissionSnapshotStatus.Current, request.Owner,
                "permission:1", "site:1", "session:1", request.ArticleIds.Select(id =>
                    new AuthorArticlePinPermissionDecision(id, id == 1, id == 1, $"permission:article:{id}")).ToArray(), string.Empty);
            return Task.FromResult(value with
            {
                ContentDigest = AuthorArticlePinProjectionContract.ComputePermissionDigest(value)
            });
        }

        public Task<IReadOnlyList<AuthorArticlePinArticleFact>> ReadCurrentBatchAsync(IReadOnlyList<int> articleIds,
            CancellationToken cancellationToken = default)
        {
            Assert.Equal(new[] { 1 }, articleIds);
            MetadataReads++;
            var value = new AuthorArticlePinArticleFact(1, "permitted", ArticleStatus.Published, 10, 1,
                "article:1", "revision:1", true, false, string.Empty);
            return Task.FromResult<IReadOnlyList<AuthorArticlePinArticleFact>>([value with
            {
                ContentDigest = AuthorArticlePinProjectionContract.ComputeArticleFactDigest(value)
            }]);
        }
    }

    private sealed class Fixture : IAuthorArticlePinPermissionProjectionProvider
    {
        private readonly ArticleGraphNodeCandidateResolver _resolver;

        internal Fixture()
        {
            _resolver = new ArticleGraphNodeCandidateResolver(this, FindAsync, () => Fresh);
        }

        internal List<string> Lookups { get; } = [];
        internal int ContextReads
        {
            get; private set;
        }
        internal string? MappingMutation
        {
            get; set;
        }
        internal string? ContextMutation
        {
            get; set;
        }
        internal string SessionRevision { get; set; } = "session:1";
        internal bool Fresh { get; set; } = true;
        internal Action? AfterLookup
        {
            get; set;
        }
        internal Func<CancellationToken, Task>? BeforeContext
        {
            get; set;
        }
        internal Func<CancellationToken, Task>? BeforeLookup
        {
            get; set;
        }

        internal Task<ArticleGraphNodeCandidates?> ResolveAsync(IReadOnlyList<string> identities, int operations = 4096, CancellationToken token = default)
            => _resolver.ResolveAsync(new(1, "site:fixture"), Guid.NewGuid(), identities, operations, 250, token);

        public async Task<AuthorArticlePinPermissionSnapshot> ResolveAsync(AuthorArticlePinPermissionBatchRequest request,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (BeforeContext is not null)
            {
                await BeforeContext(cancellationToken);
            }
            cancellationToken.ThrowIfCancellationRequested();
            Assert.Empty(request.ArticleIds);
            ContextReads++;
            var value = new AuthorArticlePinPermissionSnapshot(
                ContextMutation == "denied" ? AuthorArticlePinPermissionSnapshotStatus.Unavailable : AuthorArticlePinPermissionSnapshotStatus.Current,
                ContextMutation == "owner" ? new(9, request.Owner.SiteScope) : request.Owner,
                "permission:1", "site:1", SessionRevision,
                ContextMutation == "nonempty" ? [new(1, true, true, "permission:1")] : [], string.Empty);
            return value with
            {
                ContentDigest = ContextMutation == "digest" ? "tampered" : AuthorArticlePinProjectionContract.ComputePermissionDigest(value)
            };
        }

        private async Task<ArticleRelationArticleCoordinate?> FindAsync(string identity, CancellationToken token)
        {
            token.ThrowIfCancellationRequested();
            if (BeforeLookup is not null)
            {
                await BeforeLookup(token);
            }
            token.ThrowIfCancellationRequested();
            Lookups.Add(identity);
            int id = identity == Article(1) ? 1 : 2;
            ArticleRelationArticleCoordinate? coordinate = MappingMutation switch
            {
                "missing" => null,
                "wrong-portable" => new(id, Article(999)),
                "invalid-numeric" => new(0, identity),
                "duplicate-numeric" => new(1, identity),
                _ => new(id, identity)
            };
            Action? callback = AfterLookup;
            AfterLookup = null;
            callback?.Invoke();
            return coordinate;
        }
    }
}
