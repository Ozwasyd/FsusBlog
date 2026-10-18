using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleGraph;
using FsusBlog.Shared.Contracts.ArticleRelations;

using Xunit;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleGraphQueryTests : IDisposable
{
    private readonly CancellationTokenSource _cancellation = new();

    public void Dispose() => _cancellation.Dispose();

    [Fact]
    public async Task OmittedDepthIsOneAndMissingCanonicalApiIsUnavailable()
    {
        ArticleGraphResult result = await new ArticleGraphQueryService(new ArticleGraphUnavailableRelationProjection()).QueryAsync(Request(null), _cancellation.Token);
        Assert.Equal(1, result.Projection.RequestedDepth);
        Assert.Equal(ArticleGraphStatus.Unavailable, result.Projection.Status);
        Assert.Empty(result.Projection.Nodes);
        Assert.Empty(result.Projection.Edges);
        Assert.Equal("relation-api-unavailable", result.Projection.Reason);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(3)]
    [InlineData(999)]
    public async Task InvalidSuppliedDepthNeverReadsSource(int depth)
    {
        Source source = new();
        ArticleGraphResult result = await new ArticleGraphQueryService(source).QueryAsync(Request(depth), _cancellation.Token);
        Assert.Equal("invalid-depth", result.Projection.Reason);
        Assert.Equal(0, source.Calls);
    }

    [Fact]
    public async Task TwoRequiresExplicitExpansionAndDoesNotDowngradeCompleteness()
    {
        Source source = new();
        ArticleGraphRequest request = Request(2);
        Assert.Equal("invalid-depth", (await new ArticleGraphQueryService(source).QueryAsync(request, _cancellation.Token)).Projection.Reason);
        request = request with
        {
            ExplicitExpansion = true
        };
        source.Value = Projection(request) with
        {
            EffectiveDepth = 1
        };
        ArticleGraphResult result = await new ArticleGraphQueryService(source).QueryAsync(request, _cancellation.Token);
        Assert.Equal(ArticleGraphStatus.Refused, result.Projection.Status);
        Assert.Empty(result.Projection.Nodes);
    }

    [Fact]
    public async Task TruncationRetainsRequestedAndEffectiveDepth()
    {
        ArticleGraphRequest request = Request(2) with
        {
            ExplicitExpansion = true
        };
        Source source = new()
        {
            Value = Projection(request) with
            {
                EffectiveDepth = 1,
                Status = ArticleGraphStatus.Truncated,
                Reason = "node-budget"
            }
        };
        ArticleGraphResult result = await new ArticleGraphQueryService(source).QueryAsync(request, _cancellation.Token);
        Assert.Equal(ArticleGraphStatus.Truncated, result.Projection.Status);
        Assert.Equal(2, result.Projection.RequestedDepth);
        Assert.Equal(1, result.Projection.EffectiveDepth);
        Assert.Equal(ArticleGraphContract.ComputeDigest(result), result.ContentDigest);
        Assert.Equal(ArticleGraphContract.ComputeRequestDigest(request), result.RequestDigest);
        Assert.NotEqual(result.RequestDigest, ArticleGraphContract.ComputeRequestDigest(request with
        {
            Scope = ArticleGraphScope.Published
        }));
        Assert.NotEqual(result.RequestDigest, ArticleGraphContract.ComputeRequestDigest(request with
        {
            Budget = request.Budget with
            {
                Nodes = 500
            }
        }));
        Assert.NotEqual(result.ContentDigest, ArticleGraphContract.ComputeDigest(result with
        {
            Sequence = 42
        }));
    }

    [Fact]
    public async Task PermissionDriftErasesEntireProjection()
    {
        ArticleGraphRequest request = Request(1);
        Source source = new()
        {
            Value = Projection(request) with
            {
                Identity = request.Identity with
                {
                    Actor = request.Identity.Actor with
                    {
                        PermissionContextDigest = new string('b', 64)
                    }
                }
            }
        };
        ArticleGraphResult result = await new ArticleGraphQueryService(source).QueryAsync(request, _cancellation.Token);
        Assert.Equal(ArticleGraphStatus.Stale, result.Projection.Status);
        Assert.Empty(result.Projection.Nodes);
        Assert.Empty(result.Projection.Edges);
        Assert.Equal(new ArticleGraphUsage(0, 0, 0, 0), result.Projection.Usage);
    }

    [Fact]
    public async Task UnknownTargetsAndCountLeaksRefuseWholeResult()
    {
        ArticleGraphRequest request = Request(1);
        ArticleGraphProjection projection = Projection(request);
        Source source = new()
        {
            Value = projection with
            {
                Edges = [new("relation-1", "root", "private-target", ArticleGraphEdgeKind.Link, ArticleRelationResolutionStatus.Resolved, new("root", "revision", "epoch", 0, 3, new string('a', 64)))],
                Usage = new(1, 1, 0, 1)
            }
        };
        ArticleGraphResult result = await new ArticleGraphQueryService(source).QueryAsync(request, _cancellation.Token);
        Assert.Equal("invalid-edge", result.Projection.Reason);
        Assert.DoesNotContain("private-target", System.Text.Json.JsonSerializer.Serialize(result));
        source.Value = projection with
        {
            Usage = new(99, 0, 0, 1)
        };
        Assert.Equal("source-budget", (await new ArticleGraphQueryService(source).QueryAsync(request, _cancellation.Token)).Projection.Reason);
    }

    [Theory]
    [InlineData(100)]
    [InlineData(1000)]
    [InlineData(10000)]
    public async Task ScaleCannotBypassHardBudget(int count)
    {
        ArticleGraphRequest request = Request(1);
        ArticleGraphNode[] nodes = Enumerable.Range(1, count - 1).Select(index => new ArticleGraphNode($"article-{index:D5}", "revision", "Title", ArticleRelationLifecycleState.Draft)).Append(new("root", "revision", "Root", ArticleRelationLifecycleState.Draft)).OrderBy(node => node.ArticleIdentity, StringComparer.Ordinal).ToArray();
        Source source = new()
        {
            Value = Projection(request) with
            {
                Nodes = nodes,
                Usage = new(count, 0, 0, 1)
            }
        };
        ArticleGraphResult result = await new ArticleGraphQueryService(source).QueryAsync(request, _cancellation.Token);
        Assert.Equal(count <= 1000 ? ArticleGraphStatus.Complete : ArticleGraphStatus.Refused, result.Projection.Status);
        Assert.Equal(count <= 1000 ? count : 0, result.Projection.Nodes.Count);
    }

    [Fact]
    public async Task UncooperativeSourceCannotCommitAfterDeadline()
    {
        ArticleGraphRequest request = Request(1) with
        {
            Budget = ArticleGraphBudget.Default with
            {
                QueryMilliseconds = 250
            }
        };
        Source source = new()
        {
            Pending = new(TaskCreationOptions.RunContinuationsAsynchronously),
            CleanupPending = new(TaskCreationOptions.RunContinuationsAsynchronously)
        };
        Task<ArticleGraphResult> query = new ArticleGraphQueryService(source).QueryAsync(request, _cancellation.Token);
        var cancelled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using CancellationTokenRegistration registration = source.Token.Register(() => cancelled.TrySetResult());
        try
        {
            await cancelled.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.True(source.BorrowedClientInUse);
            await AssertPendingAsync(query);
            source.Pending.TrySetResult(Projection(request));
            await source.CleanupStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.True(source.BorrowedClientInUse);
            await AssertPendingAsync(query);
        }
        finally
        {
            // End the simulated borrowed operation even if a regression assertion fails.
            source.Pending.TrySetResult(Projection(request));
            source.CleanupPending.TrySetResult();
        }
        ArticleGraphResult result = await query.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(ArticleGraphStatus.Cancelled, result.Projection.Status);
        Assert.Equal("time-budget", result.Projection.Reason);
        Assert.True(source.Token.IsCancellationRequested);
        Assert.Empty(result.Projection.Nodes);
        Assert.Empty(result.Projection.Edges);
        Assert.Equal(new ArticleGraphUsage(0, 0, 0, 0), result.Projection.Usage);
        Assert.False(source.BorrowedClientInUse);
        Assert.True(source.CleanupCompleted);
    }

    [Fact]
    public async Task CallerCancellationWaitsForSourceCompletionAndDiscardsLateFacts()
    {
        ArticleGraphRequest request = Request(1);
        Source source = new()
        {
            Pending = new(TaskCreationOptions.RunContinuationsAsynchronously)
        };
        Task<ArticleGraphResult> query = new ArticleGraphQueryService(source).QueryAsync(request, _cancellation.Token);
        try
        {
            _cancellation.Cancel();
            Assert.True(source.Token.IsCancellationRequested);
            Assert.True(source.BorrowedClientInUse);
            await AssertPendingAsync(query);
        }
        finally
        {
            source.Pending.TrySetResult(Projection(request));
        }
        ArticleGraphResult result = await query.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(ArticleGraphStatus.Cancelled, result.Projection.Status);
        Assert.Equal("cancelled", result.Projection.Reason);
        Assert.Empty(result.Projection.Nodes);
        Assert.Empty(result.Projection.Edges);
        Assert.False(source.BorrowedClientInUse);
        Assert.True(source.CleanupCompleted);
    }

    [Fact]
    public async Task FaultDuringCancellationIsObservedAfterSourceCompletionWithoutPrivateDiagnostics()
    {
        Source source = new()
        {
            Pending = new(TaskCreationOptions.RunContinuationsAsynchronously),
            CleanupPending = new(TaskCreationOptions.RunContinuationsAsynchronously)
        };
        Task<ArticleGraphResult> query = new ArticleGraphQueryService(source).QueryAsync(Request(1), _cancellation.Token);
        try
        {
            _cancellation.Cancel();
            await AssertPendingAsync(query);
            source.Pending.TrySetException(new InvalidOperationException("private-driver-diagnostics"));
            await source.CleanupStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.True(source.BorrowedClientInUse);
            await AssertPendingAsync(query);
        }
        finally
        {
            source.Pending.TrySetException(new InvalidOperationException("private-driver-diagnostics"));
            source.CleanupPending.TrySetResult();
        }
        ArticleGraphResult result = await query.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal("cancelled", result.Projection.Reason);
        Assert.Equal(ArticleGraphStatus.Cancelled, result.Projection.Status);
        Assert.DoesNotContain("private-driver-diagnostics", System.Text.Json.JsonSerializer.Serialize(result));
        Assert.False(source.BorrowedClientInUse);
        Assert.True(source.CleanupCompleted);
    }

    [Fact]
    public async Task AlreadyCancelledRequestNeverStartsSourceWork()
    {
        Source source = new();
        _cancellation.Cancel();
        ArticleGraphResult result = await new ArticleGraphQueryService(source).QueryAsync(Request(1), _cancellation.Token);
        Assert.Equal(0, source.Calls);
        Assert.Equal(ArticleGraphStatus.Cancelled, result.Projection.Status);
        Assert.Equal("cancelled", result.Projection.Reason);
    }

    [Fact]
    public async Task CancellationDuringProjectionFreezeCannotSealLateFacts()
    {
        ArticleGraphRequest request = Request(1);
        ArticleGraphProjection projection = Projection(request);
        Source source = new()
        {
            Value = projection with
            {
                Nodes = new CancellingNodes(projection.Nodes, _cancellation)
            }
        };
        ArticleGraphResult result = await new ArticleGraphQueryService(source).QueryAsync(request, _cancellation.Token);
        Assert.True(source.CleanupCompleted);
        Assert.Equal(ArticleGraphStatus.Cancelled, result.Projection.Status);
        Assert.Equal("cancelled", result.Projection.Reason);
        Assert.Empty(result.Projection.Nodes);
        Assert.Empty(result.Projection.Edges);
    }

    private static ArticleGraphRequest Request(int? depth) => new(1, new(new("actor", "site", new string('a', 64)), "root", "revision", "epoch", "index"), "session", 0, ArticleGraphScope.CurrentEditable, depth, false, new([], [], Enum.GetValues<ArticleGraphEdgeKind>()), ArticleGraphBudget.Default);

    [Fact]
    public async Task InvalidRequestCannotAmplifyRefusalPayload()
    {
        Source source = new();
        ArticleGraphRequest request = Request(1) with
        {
            SessionId = new string('x', 100_000),
            Filters = new(Enumerable.Repeat("category", 10_000).ToArray(), [], Enum.GetValues<ArticleGraphEdgeKind>())
        };
        ArticleGraphResult result = await new ArticleGraphQueryService(source).QueryAsync(request, _cancellation.Token);
        Assert.Equal(0, source.Calls);
        Assert.Equal("", result.RequestDigest);
        Assert.True(System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(result).Length < 2048);
    }

    private static ArticleGraphProjection Projection(ArticleGraphRequest request) => new(request.Identity, request.RequestedDepth ?? 1, request.RequestedDepth ?? 1, ArticleGraphStatus.Complete, null, [new("root", "revision", "Root", ArticleRelationLifecycleState.Draft)], [], new(1, 0, 0, 1), new string('a', 64));

    private static async Task AssertPendingAsync(Task pending)
    {
        // Let cancellation continuations run while the fake borrowed-work gate stays closed.
        // This is an observation window, not a production cleanup/response-time bound.
        Task observation = Task.Delay(TimeSpan.FromMilliseconds(25));
        Assert.Same(observation, await Task.WhenAny(pending, observation).WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.False(pending.IsCompleted);
    }

    private sealed class CancellingNodes(IReadOnlyList<ArticleGraphNode> nodes, CancellationTokenSource cancellation)
        : IReadOnlyList<ArticleGraphNode>
    {
        public int Count => nodes.Count;
        public ArticleGraphNode this[int index] => nodes[index];

        public IEnumerator<ArticleGraphNode> GetEnumerator()
        {
            cancellation.Cancel();
            return nodes.GetEnumerator();
        }

        System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() => GetEnumerator();
    }

    private sealed class Source : IArticleGraphRelationProjection
    {
        // Controlled lifetime model only; it is not a real Npgsql/client-reuse receipt.
        public bool BorrowedClientInUse
        {
            get; private set;
        }
        public bool CleanupCompleted
        {
            get; private set;
        }
        public TaskCompletionSource CleanupStarted { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource? CleanupPending
        {
            get; set;
        }
        public int Calls
        {
            get; private set;
        }
        public ArticleGraphProjection? Value
        {
            get; set;
        }
        public TaskCompletionSource<ArticleGraphProjection?>? Pending
        {
            get; set;
        }
        public CancellationToken Token
        {
            get; private set;
        }

        public async Task<ArticleGraphProjection?> ReadAsync(ArticleGraphRequest request, CancellationToken cancellationToken)
        {
            Calls++;
            Token = cancellationToken;
            BorrowedClientInUse = true;
            try
            {
                return Pending is null ? Value : await Pending.Task;
            }
            finally
            {
                CleanupStarted.TrySetResult();
                if (CleanupPending is not null)
                {
                    await CleanupPending.Task;
                }
                BorrowedClientInUse = false;
                CleanupCompleted = true;
            }
        }
    }
}
