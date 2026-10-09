using System.Collections.Immutable;

using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Relations;
using FsusBlog.Shared.Contracts.ArticleRelations;

using static FsusBlog.Server.Services.Authoring.ArticleRelationIndex;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Original API publication controls; controlled facts do not qualify live permissions or runtime.</summary>
[Trait("Category", "Unit")]
public sealed class ArticleGraphAdjacencyGatewayTests
{
    private static readonly string s_digest = new('a', 64);
    private static readonly ArticleRelationActorContext s_actor = new("actor:graph-boundary", "site:primary", s_digest);

    [Fact]
    public async Task NativeReadAlreadyRevalidatesBeforeDeliveringOriginalFacts()
    {
        var (index, source, authority, record) = await CreateFixtureAsync();
        AdjacencyResult result = await index.ReadAdjacencyAsync(Request(1), authority, index.CreateAdjacencyBudget());
        Assert.True(result.Available);
        Assert.Same(record, Assert.Single(result.Edges).Link);
        Assert.Equal(2, authority.Observations);
        Assert.Equal(new[] { Article(1), Article(2) }, source.ArticleReads);
        Assert.All(authority.PermissionReads.Values, static count => Assert.Equal(2, count));
    }

    [Fact]
    public async Task PermissionLossDuringReadClosureReturnsNothingAndInvalidatesLease()
    {
        var (index, _, authority, _) = await CreateFixtureAsync();
        authority.DenyRepeatedSource = true;
        AdjacencyBudget budget = index.CreateAdjacencyBudget();
        AssertUnavailable(await index.ReadAdjacencyAsync(Request(1), authority, budget));
        Assert.False(await index.VerifyAdjacencyBudgetAsync(budget, authority));
        AssertUnavailable(await index.ReadAdjacencyAsync(Request(1), authority, budget));
    }

    [Fact]
    public async Task PermissionLossAfterReadFailsWholeQueryPublicationAndCannotReuseLease()
    {
        var (index, _, authority, _) = await CreateFixtureAsync();
        AdjacencyBudget budget = index.CreateAdjacencyBudget();
        AdjacencyResult staged = await index.ReadAdjacencyAsync(Request(1), authority, budget);
        Assert.True(staged.Available);
        authority.DenySource = true;
        Assert.False(await index.VerifyAdjacencyBudgetAsync(budget, authority));
        AssertUnavailable(await index.ReadAdjacencyAsync(Request(1), authority, budget));
        Assert.False(await index.VerifyAdjacencyBudgetAsync(budget, authority));
    }

    [Fact]
    public async Task SourceGenerationDriftAfterReadFailsWholeQueryPublication()
    {
        var (index, source, authority, _) = await CreateFixtureAsync();
        AdjacencyBudget budget = index.CreateAdjacencyBudget();
        Assert.True((await index.ReadAdjacencyAsync(Request(1), authority, budget)).Available);
        source.Generation = 2;
        Assert.False(await index.VerifyAdjacencyBudgetAsync(budget, authority));
        AssertUnavailable(await index.ReadAdjacencyAsync(Request(1), authority, budget));
    }

    [Fact]
    public async Task DepthTwoReadsMustShareTheOriginalCumulativeLease()
    {
        var (index, _, authority, _) = await CreateFixtureAsync(includeSecondHop: true);
        AdjacencyLimits limits = new(Nodes: 2);
        AdjacencyBudget shared = index.CreateAdjacencyBudget(limits);
        AdjacencyResult first = await index.ReadAdjacencyAsync(Request(1), authority, shared);
        Assert.True(first.Available);
        Assert.Equal(new[] { Article(1), Article(2) }, first.ArticleIdentities);
        AssertUnavailable(await index.ReadAdjacencyAsync(Request(2), authority, shared));
        Assert.False(await index.VerifyAdjacencyBudgetAsync(shared, authority));

        // A fresh lease admits this hop alone: it cannot stand in for a whole-query lease.
        AdjacencyResult resetCounterexample = await index.ReadAdjacencyAsync(Request(2), authority,
            index.CreateAdjacencyBudget(limits));
        Assert.True(resetCounterexample.Available);
        Assert.Equal(new[] { Article(2), Article(3) }, resetCounterexample.ArticleIdentities);
    }

    [Fact]
    public async Task CancellationDuringPublicationInvalidatesTheStagedLease()
    {
        var (index, _, authority, _) = await CreateFixtureAsync();
        AdjacencyBudget budget = index.CreateAdjacencyBudget();
        Assert.True((await index.ReadAdjacencyAsync(Request(1), authority, budget)).Available);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            index.VerifyAdjacencyBudgetAsync(budget, authority, cancellation.Token));
        AssertUnavailable(await index.ReadAdjacencyAsync(Request(1), authority, budget));
    }

    [Theory]
    [InlineData("document-epoch")]
    [InlineData("document-identity")]
    [InlineData("session")]
    [InlineData("permission")]
    public async Task ReadClosureAndPublicationVerifyUseEquivalentObservationGuards(string field)
    {
        var (index, _, authority, _) = await CreateFixtureAsync();
        authority.ChangeAtReadClosure = field;
        AdjacencyBudget duringRead = index.CreateAdjacencyBudget();
        AssertUnavailable(await index.ReadAdjacencyAsync(Request(1), authority, duringRead));
        Assert.False(await index.VerifyAdjacencyBudgetAsync(duringRead, authority));

        var (nextIndex, _, nextAuthority, _) = await CreateFixtureAsync();
        AdjacencyBudget afterRead = nextIndex.CreateAdjacencyBudget();
        Assert.True((await nextIndex.ReadAdjacencyAsync(Request(1), nextAuthority, afterRead)).Available);
        nextAuthority.ChangeObservation(field);
        Assert.False(await nextIndex.VerifyAdjacencyBudgetAsync(afterRead, nextAuthority));
        AssertUnavailable(await nextIndex.ReadAdjacencyAsync(Request(1), nextAuthority, afterRead));
    }

    private static async Task<(ArticleRelationIndex, FixtureSource, FixtureAuthority, ArticleRelationRecord)> CreateFixtureAsync(
        bool includeSecondHop = false)
    {
        ArticleRelationRecord record = Record(2, 1);
        ImmutableArray<ArticleRelationIndexArticle> families = includeSecondHop
            ? [Family(1, []), Family(2, [record]), Family(3, [Record(3, 2)])]
            : [Family(1, []), Family(2, [record])];
        var source = new FixtureSource(families);
        var index = new ArticleRelationIndex(source, s_actor);
        await index.RebuildAsync(0);
        return (index, source, new(), record);
    }

    private static string Article(int id) => $"article:40000000-0000-4000-8000-{id:x12}";

    private static ArticleRelationSourceFacts Source(int id)
        => new(Article(id), "revision:50000000-0000-4000-8000-000000000001", 1,
            ArticleRelationRevisionKind.Current, ArticleRelationLifecycleState.Published,
            ArticleRelationPermissionState.Allowed, s_actor, s_digest);

    private static ArticleRelationRecord Record(int source, int target)
        => ArticleRelationContractValidator.Seal(new ArticleRelationRecord(ArticleRelationSchemas.Relation, 1, string.Empty, 1,
            ArticleRelationKind.Outgoing, Source(source), new("[link]", new(0, 6, "[link]"), new(0, 6, "[link]"), 1),
            new(new(Article(target), ArticleRelationTargetKind.Article, null, null),
                "revision:50000000-0000-4000-8000-000000000001", 1, ArticleRelationRevisionKind.Current,
                ArticleRelationLifecycleState.Published, ArticleRelationPermissionState.Allowed),
            new(s_actor, s_actor, ArticleRelationQueryScope.Authoring, ArticleRelationPublicContext.AuthoringActor, s_digest),
            ArticleRelationResolutionStatus.Resolved, new(1, 1, 1, 1, 1), string.Empty));

    private static ArticleRelationIndexArticle Family(int id, ArticleRelationRecord[] records)
        => new(Article(id), 1, [ArticleRelationContractValidator.Seal(new ArticleRelationSet(
            ArticleRelationSchemas.RelationSet, 1, Source(id), records, string.Empty))]);

    private static AdjacencyRequest Request(int id)
        => new(s_actor, 1, 1, 1, "document:graph-boundary", new(Article(id), Source(id).RevisionIdentity, 1,
            ArticleRelationRevisionKind.Current, new(Article(id), ArticleRelationTargetKind.Article, null, null),
            null, null, AdjacencyPermissionRole.Root), AdjacencyDirections.Incoming,
            ArticleRelationQueryScope.Authoring, ArticleEmbedEdgeScope.Authoring, IncludeEmbeds: false);

    private static void AssertUnavailable(AdjacencyResult result)
    {
        Assert.False(result.Available);
        Assert.Empty(result.ArticleIdentities);
        Assert.Empty(result.Edges);
    }

    private sealed class FixtureAuthority : IAdjacencyAuthority
    {
        private AdjacencyObservation _observation = new(s_actor, 1, 1, 1, "document:graph-boundary",
            ArticleRelationQueryScope.Authoring, "permission:1", "site:1", "session:1");
        public Dictionary<AdjacencyPermissionCoordinate, int> PermissionReads { get; } = [];
        public int Observations
        {
            get; private set;
        }
        public bool DenySource
        {
            get; set;
        }
        public bool DenyRepeatedSource
        {
            get; set;
        }
        public string? ChangeAtReadClosure
        {
            get; set;
        }

        public Task<AdjacencyObservation?> ObserveAsync(ArticleRelationActorContext actor,
            ArticleRelationQueryScope scope, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (++Observations == 2 && ChangeAtReadClosure is not null)
            {
                ChangeObservation(ChangeAtReadClosure);
            }
            return Task.FromResult<AdjacencyObservation?>(_observation);
        }

        public Task<AdjacencyPermissionDecision?> ReadPermissionAsync(AdjacencyObservation observation,
            AdjacencyPermissionCoordinate coordinate, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            int count = PermissionReads.GetValueOrDefault(coordinate) + 1;
            PermissionReads[coordinate] = count;
            bool denied = coordinate.Role == AdjacencyPermissionRole.Source
                && (DenySource || DenyRepeatedSource && count > 1);
            return Task.FromResult<AdjacencyPermissionDecision?>(new(observation, coordinate,
                denied ? ArticleRelationPermissionState.Denied : ArticleRelationPermissionState.Allowed));
        }

        public void ChangeObservation(string field)
        {
            _observation = field switch
            {
                "document-epoch" => _observation with { DocumentEpoch = 2 },
                "document-identity" => _observation with { DocumentIdentity = "document:other" },
                "session" => _observation with { SessionRevision = "session:2" },
                _ => _observation with { PermissionRevision = "permission:2" }
            };
        }
    }

    private sealed class FixtureSource(ImmutableArray<ArticleRelationIndexArticle> families) : IArticleRelationIndexSource
    {
        public long Generation { get; set; } = 1;
        public List<string> ArticleReads { get; } = [];

        public Task<ArticleRelationIndexSourcePage> ReadAsync(ArticleRelationActorContext actor, string? afterArticleIdentity,
            int pageSize, long? expectedSourceGeneration, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            ArticleRelationIndexArticle[] remaining = families.Where(family => afterArticleIdentity is null
                || StringComparer.Ordinal.Compare(family.ArticleIdentity, afterArticleIdentity) > 0).ToArray();
            return Task.FromResult(new ArticleRelationIndexSourcePage(actor, Generation,
                remaining.Take(pageSize).ToImmutableArray(), remaining.Length > pageSize));
        }

        public Task<ArticleRelationIndexArticleRead> ReadArticleAsync(ArticleRelationActorContext actor, string articleIdentity,
            long? expectedSourceGeneration, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            ArticleReads.Add(articleIdentity);
            return Task.FromResult(new ArticleRelationIndexArticleRead(actor, Generation,
                families.Single(family => family.ArticleIdentity == articleIdentity)));
        }
    }
}
