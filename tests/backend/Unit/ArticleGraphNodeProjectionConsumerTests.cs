using FsusBlog.Server.Entities;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleGraph;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Native-reader consumer controls with explicit controlled facts, not live permission or runtime qualification.</summary>
[Trait("Category", "Unit")]
public sealed class ArticleGraphNodeProjectionConsumerTests
{
    [Fact]
    public async Task EveryNeighborRequiresItsOwnPermissionBeforeMetadata()
    {
        var fixture = new Fixture();
        fixture.Denied.Add(2);
        ArticleGraphNodeProjectionConsumer.NodeRead read = Assert.IsType<ArticleGraphNodeProjectionConsumer.NodeRead>(
            await fixture.Consumer.ReadAsync(fixture.Request()));

        Assert.Equal(Article(1), Assert.Single(read.Nodes).ArticleIdentity);
        Assert.Equal(new[] { "", "1,2", "1,2" }, fixture.PermissionRequests);
        Assert.Equal(new[] { "1", "1" }, fixture.MetadataRequests);
        Assert.Equal(new[] { 1, 1 }, fixture.CoordinateReads);
        Assert.True(await fixture.Consumer.VerifyAsync(read));
        Assert.Equal(14, read.ReadOperations);
    }

    [Theory]
    [InlineData(ArticleStatus.Draft, 1)]
    [InlineData(ArticleStatus.Scheduled, 2)]
    [InlineData(ArticleStatus.Published, 3)]
    [InlineData(ArticleStatus.Archived, 4)]
    public async Task NativeTitleCurrentRevisionAndLifecycleProduceStableReadonlyNodes(ArticleStatus status, int lifecycle)
    {
        var fixture = new Fixture();
        fixture.Status = status;
        ArticleGraphNodeReadRequest request = fixture.Request() with
        {
            Candidates = fixture.Request().Candidates.Reverse().ToArray()
        };
        ArticleGraphNodeProjectionConsumer.NodeRead read = Assert.IsType<ArticleGraphNodeProjectionConsumer.NodeRead>(
            await fixture.Consumer.ReadAsync(request));

        Assert.Equal(new[] { Article(1), Article(2) }, read.Nodes.Select(static node => node.ArticleIdentity));
        Assert.Equal(new[] { "native title 1", "native title 2" }, read.Nodes.Select(static node => node.Title));
        Assert.Equal(new[] { Revision(1, 1), Revision(2, 1) }, read.Nodes.Select(static node => node.RevisionIdentity));
        Assert.All(read.Nodes, node => Assert.Equal(lifecycle, (int)node.Lifecycle));
        var nodes = Assert.IsAssignableFrom<IList<ArticleGraphNode>>(read.Nodes);
        Assert.True(nodes.IsReadOnly);
        Assert.Throws<NotSupportedException>(() => nodes.Clear());
    }

    [Theory]
    [InlineData("title-oversize")]
    [InlineData("fact-digest")]
    [InlineData("revision")]
    [InlineData("missing")]
    [InlineData("deleted")]
    [InlineData("unknown-status")]
    [InlineData("duplicates")]
    [InlineData("foreign-article")]
    public async Task InvalidNativeMetadataCannotProduceNodes(string mutation)
    {
        var fixture = new Fixture { MetadataMutation = mutation };
        Assert.Null(await fixture.Consumer.ReadAsync(fixture.Request()));
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("identity")]
    [InlineData("revision-identity")]
    [InlineData("revision-id")]
    [InlineData("revision-number")]
    [InlineData("empty-source-epoch")]
    public async Task CanonicalCoordinatesMustBindEveryCurrentArticleAndRevision(string mutation)
    {
        var fixture = new Fixture { CoordinateMutation = mutation };
        Assert.Null(await fixture.Consumer.ReadAsync(fixture.Request()));
    }

    [Theory]
    [InlineData("title")]
    [InlineData("revision")]
    [InlineData("lifecycle")]
    [InlineData("permission")]
    [InlineData("site")]
    [InlineData("session")]
    [InlineData("source-epoch")]
    public async Task StagedNodesRequireFreshPermissionMetadataAndCoordinatesAtPublication(string mutation)
    {
        var fixture = new Fixture();
        ArticleGraphNodeProjectionConsumer.NodeRead read = Assert.IsType<ArticleGraphNodeProjectionConsumer.NodeRead>(
            await fixture.Consumer.ReadAsync(fixture.Request()));
        fixture.Change(mutation);

        Assert.False(await fixture.Consumer.VerifyAsync(read));
        Assert.Empty(read.Nodes);
        Assert.False(await fixture.Consumer.VerifyAsync(read));
        if (mutation == "permission")
        {
            Assert.All(fixture.MetadataRequests.Skip(2), ids => Assert.DoesNotContain("2", ids));
        }
    }

    [Theory]
    [InlineData("category")]
    [InlineData("tag")]
    [InlineData("published")]
    public async Task MissingFilterOrPublishedSourceFactsAreRefusedBeforeReaders(string operation)
    {
        var fixture = new Fixture();
        ArticleGraphNodeReadRequest request = fixture.Request();
        request = operation switch
        {
            "category" => request with { Filters = request.Filters with { Categories = new[] { "category:1" } } },
            "tag" => request with { Filters = request.Filters with { Tags = new[] { "tag:1" } } },
            _ => request with { Scope = ArticleGraphScope.Published }
        };

        Assert.Null(await fixture.Consumer.ReadAsync(request));
        Assert.Empty(fixture.PermissionRequests);
        Assert.Empty(fixture.MetadataRequests);
        Assert.Empty(fixture.CoordinateReads);
    }

    [Theory]
    [InlineData("digest")]
    [InlineData("owner")]
    [InlineData("missing-decision")]
    [InlineData("duplicate-decision")]
    [InlineData("stale")]
    [InlineData("foreign-decision")]
    public async Task InvalidPermissionSnapshotsNeverReachMetadata(string mutation)
    {
        var fixture = new Fixture { PermissionMutation = mutation };
        Assert.Null(await fixture.Consumer.ReadAsync(fixture.Request()));
        Assert.Empty(fixture.MetadataRequests);
        Assert.Empty(fixture.CoordinateReads);
    }

    [Fact]
    public async Task RevocationDuringCoordinateClosureDiscardsTheWholeStagedRead()
    {
        var fixture = new Fixture();
        fixture.AfterCoordinate = () => fixture.Denied.Add(2);
        Assert.Null(await fixture.Consumer.ReadAsync(fixture.Request()));
    }

    [Fact]
    public async Task MetadataDriftDuringCoordinateClosureDiscardsTheWholeStagedRead()
    {
        var fixture = new Fixture();
        fixture.AfterCoordinate = () => fixture.TitleSuffix = "changed";
        Assert.Null(await fixture.Consumer.ReadAsync(fixture.Request()));
    }

    [Fact]
    public async Task NoAdmittedNodesProduceNoPlaceholdersOrMetadataReads()
    {
        var fixture = new Fixture();
        fixture.Denied.UnionWith(new[] { 1, 2 });
        ArticleGraphNodeProjectionConsumer.NodeRead read = Assert.IsType<ArticleGraphNodeProjectionConsumer.NodeRead>(
            await fixture.Consumer.ReadAsync(fixture.Request()));

        Assert.Empty(read.Nodes);
        Assert.Empty(fixture.MetadataRequests);
        Assert.Empty(fixture.CoordinateReads);
        Assert.True(await fixture.Consumer.VerifyAsync(read));
    }

    [Fact]
    public async Task MaximumCandidateBatchUsesTwoMetadataReadsAndExactCanonicalCalls()
    {
        // Functional allocation control only; this is not a real database/1000-node usability receipt.
        var fixture = new Fixture();
        ArticleGraphNodeReadRequest request = fixture.Request(1000);
        ArticleGraphNodeProjectionConsumer.NodeRead read = Assert.IsType<ArticleGraphNodeProjectionConsumer.NodeRead>(
            await fixture.Consumer.ReadAsync(request));
        Assert.Equal(1000, read.Nodes.Count);
        Assert.Equal(2, fixture.MetadataRequests.Count);
        Assert.Equal(2000, fixture.CoordinateReads.Count);
        Assert.Equal(2005, read.ReadOperations);
        Assert.True(await fixture.Consumer.VerifyAsync(read));
        Assert.Equal(4010, read.ReadOperations);
    }

    [Fact]
    public async Task OversizedCandidatesAndInsufficientAllocationCannotReadMetadata()
    {
        var fixture = new Fixture();
        Assert.Null(await fixture.Consumer.ReadAsync(fixture.Request(10000)));
        Assert.Empty(fixture.PermissionRequests);
        Assert.Null(await fixture.Consumer.ReadAsync(fixture.Request() with
        {
            RemainingReadOperations = 8
        }));
        Assert.Empty(fixture.MetadataRequests);
    }

    [Fact]
    public async Task PublicationSharesTheOriginalOperationAllocation()
    {
        var fixture = new Fixture();
        ArticleGraphNodeProjectionConsumer.NodeRead read = Assert.IsType<ArticleGraphNodeProjectionConsumer.NodeRead>(
            await fixture.Consumer.ReadAsync(fixture.Request() with
            {
                RemainingReadOperations = 9
            }));

        Assert.False(await fixture.Consumer.VerifyAsync(read));
        Assert.Empty(read.Nodes);
        Assert.Equal(9, read.ReadOperations);
    }

    [Fact]
    public async Task CancellationAtPublicationInvalidatesTheStagedRead()
    {
        var fixture = new Fixture();
        ArticleGraphNodeProjectionConsumer.NodeRead read = Assert.IsType<ArticleGraphNodeProjectionConsumer.NodeRead>(
            await fixture.Consumer.ReadAsync(fixture.Request()));
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => fixture.Consumer.VerifyAsync(read, cancellation.Token));
        Assert.Empty(read.Nodes);
    }

    [Fact]
    public async Task PinnedStateCannotReadPermissionsOrMetadata()
    {
        var fixture = new Fixture { Fresh = false };
        Assert.Null(await fixture.Consumer.ReadAsync(fixture.Request()));
        Assert.Empty(fixture.PermissionRequests);
        Assert.Empty(fixture.MetadataRequests);
    }

    [Fact]
    public async Task AlteredProjectedNodesCannotPassFreshPublicationChecks()
    {
        var fixture = new Fixture();
        ArticleGraphNodeProjectionConsumer.NodeRead read = Assert.IsType<ArticleGraphNodeProjectionConsumer.NodeRead>(
            await fixture.Consumer.ReadAsync(fixture.Request()));
        read.Projected = read.Nodes.Select(static node => node with { Title = "forged" }).ToArray();
        Assert.False(await fixture.Consumer.VerifyAsync(read));
        Assert.Empty(read.Nodes);
    }

    [Theory]
    [InlineData("permission")]
    [InlineData("metadata")]
    [InlineData("coordinate")]
    public async Task AdmissionDeadlineWaitsForBorrowedReaderCompletionAndDeniesLateFacts(string boundary)
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
        switch (boundary)
        {
            case "permission":
                fixture.BeforePermission = PauseAsync;
                break;
            case "metadata":
                fixture.BeforeMetadata = PauseAsync;
                break;
            default:
                fixture.BeforeCoordinate = PauseAsync;
                break;
        }
        Task<ArticleGraphNodeProjectionConsumer.NodeRead?> pending = fixture.Consumer.ReadAsync(fixture.Request() with
        {
            RemainingMilliseconds = 250
        });
        try
        {
            CancellationToken token = await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
            var cancelled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            using CancellationTokenRegistration registration = token.Register(() => cancelled.TrySetResult());
            await cancelled.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.False(completed);
            // Observe cancellation continuations while the simulated reader remains held.
            Task observation = Task.Delay(TimeSpan.FromMilliseconds(25));
            Assert.Same(observation, await Task.WhenAny(pending, observation).WaitAsync(TimeSpan.FromSeconds(5)));
            Assert.False(pending.IsCompleted);
        }
        finally
        {
            release.TrySetResult();
        }
        Assert.Null(await pending.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.True(completed);
    }

    private static string Article(int id) => $"article:80000000-0000-0000-0000-{id:D12}";
    private static string Revision(int id, int version) => $"revision:90000000-0000-0000-{version:D4}-{id:D12}";

    private sealed class Fixture : IAuthorArticlePinPermissionProjectionProvider, IAuthorArticlePinArticleProjectionSource
    {
        internal Fixture()
        {
            Consumer = new ArticleGraphNodeProjectionConsumer(this, this, CoordinateAsync, () => Fresh);
        }

        internal ArticleGraphNodeProjectionConsumer Consumer
        {
            get;
        }
        internal HashSet<int> Denied { get; } = [];
        internal List<string> PermissionRequests { get; } = [];
        internal List<string> MetadataRequests { get; } = [];
        internal List<int> CoordinateReads { get; } = [];
        internal ArticleStatus Status { get; set; } = ArticleStatus.Published;
        internal int Version { get; set; } = 1;
        internal string TitleSuffix { get; set; } = string.Empty;
        internal string PermissionRevision { get; set; } = "permission:1";
        internal string SiteRevision { get; set; } = "site:1";
        internal string SessionRevision { get; set; } = "session:1";
        internal Guid SourceEpoch { get; set; } = Guid.Parse("a0000000-0000-0000-0000-000000000001");
        internal string? MetadataMutation
        {
            get; set;
        }
        internal string? CoordinateMutation
        {
            get; set;
        }
        internal string? PermissionMutation
        {
            get; set;
        }
        internal Action? AfterCoordinate
        {
            get; set;
        }
        internal bool Fresh { get; set; } = true;
        internal Func<CancellationToken, Task>? BeforePermission
        {
            get; set;
        }
        internal Func<CancellationToken, Task>? BeforeMetadata
        {
            get; set;
        }
        internal Func<CancellationToken, Task>? BeforeCoordinate
        {
            get; set;
        }

        internal ArticleGraphNodeReadRequest Request(int count = 2)
            => new(new AuthorArticlePinOwner(1, "site:fixture"), Guid.NewGuid(),
                Enumerable.Range(1, count).Select(id => new ArticleRelationArticleCoordinate(id, Article(id))).ToArray(),
                ArticleGraphScope.CurrentEditable, new([], [], [ArticleGraphEdgeKind.Link]), 4096, 250);

        internal void Change(string mutation)
        {
            switch (mutation)
            {
                case "title":
                    TitleSuffix = " changed";
                    break;
                case "revision":
                    Version++;
                    break;
                case "lifecycle":
                    Status = ArticleStatus.Archived;
                    break;
                case "permission":
                    Denied.Add(2);
                    break;
                case "site":
                    SiteRevision = "site:2";
                    break;
                case "session":
                    SessionRevision = "session:2";
                    break;
                case "source-epoch":
                    SourceEpoch = Guid.NewGuid();
                    break;
            }
        }

        public async Task<AuthorArticlePinPermissionSnapshot> ResolveAsync(
            AuthorArticlePinPermissionBatchRequest request, CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (BeforePermission is not null)
            {
                await BeforePermission(cancellationToken);
            }
            cancellationToken.ThrowIfCancellationRequested();
            PermissionRequests.Add(string.Join(',', request.ArticleIds));
            AuthorArticlePinPermissionDecision[] decisions = request.ArticleIds.Select(id =>
                new AuthorArticlePinPermissionDecision(id, !Denied.Contains(id), !Denied.Contains(id), $"permission:article:{id}")).ToArray();
            if (decisions.Length != 0)
            {
                decisions = PermissionMutation switch
                {
                    "missing-decision" => [],
                    "duplicate-decision" => [decisions[0], decisions[0]],
                    "foreign-decision" => [decisions[0] with { ArticleId = 9000 }, decisions[1]],
                    _ => decisions
                };
            }
            var value = new AuthorArticlePinPermissionSnapshot(
                PermissionMutation == "stale" ? AuthorArticlePinPermissionSnapshotStatus.Stale : AuthorArticlePinPermissionSnapshotStatus.Current,
                PermissionMutation == "owner" ? request.Owner with
                {
                    AdminPrincipalId = 9
                } : request.Owner,
                PermissionRevision, SiteRevision, SessionRevision, decisions, string.Empty);
            return value with
            {
                ContentDigest = PermissionMutation == "digest" ? "tampered" : AuthorArticlePinProjectionContract.ComputePermissionDigest(value)
            };
        }

        public async Task<IReadOnlyList<AuthorArticlePinArticleFact>> ReadCurrentBatchAsync(
            IReadOnlyList<int> articleIds, CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (BeforeMetadata is not null)
            {
                await BeforeMetadata(cancellationToken);
            }
            cancellationToken.ThrowIfCancellationRequested();
            MetadataRequests.Add(string.Join(',', articleIds));
            AuthorArticlePinArticleFact[] facts = articleIds.Select(Fact).Reverse().ToArray();
            if (MetadataMutation == "duplicates")
            {
                facts = [facts[0], facts[0]];
            }
            return facts;
        }

        private AuthorArticlePinArticleFact Fact(int id)
        {
            var fact = new AuthorArticlePinArticleFact(id, $"native title {id}{TitleSuffix}", Status, 100 + id + 1000 * (Version - 1),
                Version, $"article:version:{Version}", $"revision:version:{Version}", true, false, string.Empty);
            fact = MetadataMutation switch
            {
                "title-oversize" => fact with { Title = new string('a', 257) },
                "revision" => fact with { CurrentRevisionId = 0 },
                "missing" => fact with { Exists = false },
                "deleted" => fact with { IsDeleted = true },
                "unknown-status" => fact with { Status = (ArticleStatus)255 },
                "foreign-article" => fact with { ArticleId = 9000 },
                _ => fact
            };
            return fact with
            {
                ContentDigest = MetadataMutation == "fact-digest" ? "tampered" : AuthorArticlePinProjectionContract.ComputeArticleFactDigest(fact)
            };
        }

        private async Task<ArticleRelationRevisionCoordinate?> CoordinateAsync(int id, long revisionId, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (BeforeCoordinate is not null)
            {
                await BeforeCoordinate(cancellationToken);
            }
            cancellationToken.ThrowIfCancellationRequested();
            CoordinateReads.Add(id);
            var value = new ArticleRelationRevisionCoordinate(id, revisionId, Version, Article(id), Revision(id, Version), SourceEpoch);
            ArticleRelationRevisionCoordinate? coordinate = CoordinateMutation switch
            {
                "missing" => null,
                "identity" => value with { ArticleIdentity = Article(9999) },
                "revision-identity" => value with { RevisionIdentity = "revision:1" },
                "revision-id" => value with { RevisionId = 1 },
                "revision-number" => value with { RevisionNo = 99 },
                "empty-source-epoch" => value with { SourceEpoch = Guid.Empty },
                _ => value
            };
            Action? callback = AfterCoordinate;
            AfterCoordinate = null;
            callback?.Invoke();
            return coordinate;
        }
    }
}
