using System.Collections;

using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleGraph;
using FsusBlog.Shared.Contracts.ArticleRelations;

using Xunit;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleGraphSnapshotTests : IDisposable
{
    private readonly CancellationTokenSource _cancellation = new();

    public void Dispose() => _cancellation.Dispose();

    [Fact]
    public async Task ValidSnapshotsUseOnlyBoundedIndexesAndFreezeBothOwners()
    {
        List<string> categories = ["category"];
        List<ArticleGraphNode> nodes = [Node()];
        IndexedList<string> callerCategories = new(() => categories.Count, index => categories[index]);
        IndexedList<ArticleGraphNode> sourceNodes = new(() => nodes.Count, index => nodes[index]);
        ArticleGraphRequest request = Request() with
        {
            Filters = new(callerCategories, new IndexedList<string>(() => 0, _ => throw new InvalidOperationException()),
                new IndexedList<ArticleGraphEdgeKind>(() => 1, _ => ArticleGraphEdgeKind.Link))
        };
        Source source = new(Projection(request) with
        {
            Nodes = sourceNodes,
            Edges = new IndexedList<ArticleGraphEdge>(() => 0, _ => throw new InvalidOperationException())
        });
        ArticleGraphResult result = await new ArticleGraphQueryService(source).QueryAsync(request, _cancellation.Token);
        categories[0] = "changed";
        nodes.Clear();
        Assert.Equal(ArticleGraphStatus.Complete, result.Projection.Status);
        Assert.Equal("category", Assert.Single(source.Request!.Filters.Categories));
        Assert.Equal("root", Assert.Single(result.Projection.Nodes).ArticleIdentity);
        Assert.Equal(new[] { 0 }, callerCategories.IndexReads);
        Assert.Equal(new[] { 0 }, sourceNodes.IndexReads);
        Assert.Equal(ArticleGraphContract.ComputeRequestDigest(source.Request), result.RequestDigest);
        Assert.Equal(ArticleGraphContract.ComputeDigest(result), result.ContentDigest);
    }

    [Fact]
    public async Task InvalidScalarNeverTouchesCallerListsEvenDuringRefusalSealing()
    {
        IndexedList<string> categories = new(() => throw new InvalidOperationException("caller Count"), _ => throw new InvalidOperationException());
        ArticleGraphRequest request = Request() with
        {
            SchemaVersion = 0,
            Filters = new(categories, [], [ArticleGraphEdgeKind.Link])
        };
        Source source = new(null);
        ArticleGraphResult result = await new ArticleGraphQueryService(source).QueryAsync(request, _cancellation.Token);
        Assert.Equal("invalid-request", result.Projection.Reason);
        Assert.Empty(result.RequestDigest);
        Assert.Equal(0, categories.CountReads);
        Assert.Equal(0, source.Calls);
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(33)]
    [InlineData(int.MaxValue)]
    public async Task FilterCountOutsideLimitNeverIndexesOrReadsSource(int count)
    {
        IndexedList<string> categories = new(() => count, _ => throw new InvalidOperationException());
        ArticleGraphRequest request = Request() with
        {
            Filters = new(categories, [], [ArticleGraphEdgeKind.Link])
        };
        Source source = new(null);
        ArticleGraphResult result = await new ArticleGraphQueryService(source).QueryAsync(request, _cancellation.Token);
        Assert.Equal("invalid-filter", result.Projection.Reason);
        Assert.Empty(result.RequestDigest);
        Assert.Empty(categories.IndexReads);
        Assert.Equal(1, categories.CountReads);
        Assert.Equal(0, source.Calls);
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(1001)]
    [InlineData(int.MaxValue)]
    public async Task SourceCountOutsideBudgetNeverIndexesOrTouchesLaterLists(int count)
    {
        ArticleGraphRequest request = Request();
        IndexedList<ArticleGraphNode> nodes = new(() => count, _ => throw new InvalidOperationException());
        IndexedList<ArticleGraphEdge> edges = new(() => throw new InvalidOperationException("later list"), _ => throw new InvalidOperationException());
        Source source = new(Projection(request) with
        {
            Nodes = nodes,
            Edges = edges
        });
        ArticleGraphResult result = await new ArticleGraphQueryService(source).QueryAsync(request, _cancellation.Token);
        Assert.Equal("source-budget", result.Projection.Reason);
        Assert.Empty(result.Projection.Nodes);
        Assert.Empty(result.Projection.Edges);
        Assert.Empty(nodes.IndexReads);
        Assert.Equal(0, edges.CountReads);
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task BoundsFailureIsRefusedOnlyWhenCurrentCountProvesIndexLoss(bool indexOutOfRange, bool shrunk)
    {
        ArticleGraphRequest request = Request();
        Exception failure = indexOutOfRange ? new IndexOutOfRangeException("source index") : new ArgumentOutOfRangeException("index");
        bool accessed = false;
        IndexedList<ArticleGraphNode> nodes = new(() => accessed && shrunk ? 0 : 1, _ =>
        {
            accessed = true;
            throw failure;
        });
        Source source = new(Projection(request) with
        {
            Nodes = nodes
        });
        Task<ArticleGraphResult> query = new ArticleGraphQueryService(source).QueryAsync(request, _cancellation.Token);
        if (shrunk)
        {
            Assert.Equal("source-budget", (await query).Projection.Reason);
        }
        else
        {
            Assert.Same(failure, await Record.ExceptionAsync(async () => await query));
        }
        Assert.Equal(new[] { 0 }, nodes.IndexReads);
        Assert.Equal(2, nodes.CountReads);
    }

    [Fact]
    public async Task GrowthAfterCapturedCountCopiesNoAdditionalItemsAndRefuses()
    {
        ArticleGraphRequest request = Request();
        bool accessed = false;
        IndexedList<ArticleGraphNode> nodes = new(() => accessed ? 2 : 1, _ =>
        {
            accessed = true;
            return Node();
        });
        Source source = new(Projection(request) with
        {
            Nodes = nodes
        });
        ArticleGraphResult result = await new ArticleGraphQueryService(source).QueryAsync(request, _cancellation.Token);
        Assert.Equal("source-budget", result.Projection.Reason);
        Assert.Equal(new[] { 0 }, nodes.IndexReads);
        Assert.Empty(result.Projection.Nodes);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CountProofFailurePropagatesInsteadOfFabricatingRefusal(bool cancelled)
    {
        ArticleGraphRequest request = Request();
        Exception failure = cancelled ? new OperationCanceledException("Count callback") : new InvalidOperationException("Count callback");
        bool accessed = false;
        IndexedList<ArticleGraphNode> nodes = new(() => accessed ? throw failure : 1, _ =>
        {
            accessed = true;
            throw new ArgumentOutOfRangeException("index");
        });
        Source source = new(Projection(request) with
        {
            Nodes = nodes
        });
        Assert.Same(failure, await Record.ExceptionAsync(async () => await new ArticleGraphQueryService(source).QueryAsync(request, _cancellation.Token)));
        Assert.False(_cancellation.IsCancellationRequested);
    }

    private static ArticleGraphRequest Request() => new(1, new(new("actor", "site", new string('a', 64)), "root", "revision", "epoch", "index"), "session", 0, ArticleGraphScope.CurrentEditable, 1, false, new([], [], [ArticleGraphEdgeKind.Link]), ArticleGraphBudget.Default);

    private static ArticleGraphNode Node() => new("root", "revision", "Root", ArticleRelationLifecycleState.Draft);

    private static ArticleGraphProjection Projection(ArticleGraphRequest request) => new(request.Identity, 1, 1, ArticleGraphStatus.Complete, null, [Node()], [], new(1, 0, 0, 1), new string('a', 64));

    private sealed class Source(ArticleGraphProjection? value) : IArticleGraphRelationProjection
    {
        public int Calls
        {
            get; private set;
        }
        public ArticleGraphRequest? Request
        {
            get; private set;
        }

        public Task<ArticleGraphProjection?> ReadAsync(ArticleGraphRequest request, CancellationToken cancellationToken)
        {
            Calls++;
            Request = request;
            return Task.FromResult(value);
        }
    }

    private sealed class IndexedList<T>(Func<int> count, Func<int, T> item) : IReadOnlyList<T>
    {
        public int CountReads
        {
            get; private set;
        }
        public List<int> IndexReads { get; } = [];
        public int Count
        {
            get
            {
                CountReads++;
                return count();
            }
        }
        public T this[int index]
        {
            get
            {
                IndexReads.Add(index);
                return item(index);
            }
        }

        // A successful query must never fall back to caller/provider enumeration.
        public IEnumerator<T> GetEnumerator() => throw new InvalidOperationException("untrusted enumeration");
        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }
}
