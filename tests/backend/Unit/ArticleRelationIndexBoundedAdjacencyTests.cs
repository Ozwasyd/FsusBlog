using System.Collections.Immutable;

using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleEmbeds;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Relations;
using FsusBlog.Shared.Contracts.ArticleRelations;

using static FsusBlog.Server.Services.Authoring.ArticleRelationIndex;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Ordinary in-process algorithm controls; fixture permissions are not live SQL/runtime receipts.</summary>
[Trait("Category", "Unit")]
public sealed class ArticleRelationIndexBoundedAdjacencyTests
{
    private static readonly string s_digest = new('a', 64);
    private static readonly ArticleRelationActorContext s_actor = new("actor:adjacency", "site:primary", s_digest);

    [Fact]
    public async Task Incoming_UsesAllTargetKindsAndPreservesOriginalFacts()
    {
        ArticleRelationRecord[] records = [Record(2, 1), Record(3, 1, ArticleRelationTargetKind.Heading),
            Record(4, 1, ArticleRelationTargetKind.Block)];
        var (index, source, authority) = await Setup(records);
        AdjacencyBudget budget = index.CreateAdjacencyBudget();
        AdjacencyResult result = await index.ReadAdjacencyAsync(Request(1), authority, budget);
        Assert.True(result.Available);
        Assert.Equal(4, result.ArticleIdentities.Length);
        Assert.Equal(3, result.Edges.Length);
        Assert.Equal(records.Select(static record => record.RecordDigest), result.Edges.Select(static edge => edge.Link!.RecordDigest));
        Assert.All(result.Edges, static edge => Assert.Null(edge.Embed));
        Assert.Equal(new[] { Article(2), Article(3), Article(4) }, source.ArticleReads);
        Assert.True(await index.VerifyAdjacencyBudgetAsync(budget, authority));
    }

    [Fact]
    public async Task Both_MergesDeterministicallyAndDeduplicatesAdmittedSelfLoop()
    {
        ArticleRelationRecord[] records = [Record(2, 1), Record(1, 3), Record(1, 1)];
        var (index, _, authority) = await Setup(records.Reverse().ToArray());
        AdjacencyResult result = await index.ReadAdjacencyAsync(Request(1, AdjacencyDirections.Both), authority, index.CreateAdjacencyBudget());
        Assert.True(result.Available);
        Assert.Equal(3, result.Edges.Length);
        Assert.Equal(records.OrderBy(static record => record.Source.ArticleIdentity, StringComparer.Ordinal)
            .ThenBy(static record => record.RelationIdentity, StringComparer.Ordinal).Select(static record => record.RelationIdentity),
            result.Edges.Select(static edge => edge.Link!.RelationIdentity));
        // Incoming edge plus the self-loop twice, then one final exact-coordinate revalidation.
        Assert.Equal(4, authority.Reads.Count(coordinate => coordinate.Role == AdjacencyPermissionRole.Target
            && coordinate.ArticleIdentity == Article(1)));
    }

    [Fact]
    public async Task ExactHeadingIncoming_DoesNotCollapseArticleOrBlockTargets()
    {
        ArticleRelationRecord[] records = [Record(2, 1), Record(3, 1, ArticleRelationTargetKind.Heading),
            Record(4, 1, ArticleRelationTargetKind.Block)];
        var (index, _, authority) = await Setup(records);
        AdjacencyResult result = await index.ReadAdjacencyAsync(Request(1) with
        {
            ExactIncomingLinkTarget = Target(1, ArticleRelationTargetKind.Heading)
        }, authority, index.CreateAdjacencyBudget());
        Assert.True(result.Available);
        Assert.Equal(records[1], Assert.Single(result.Edges).Link);
        Assert.Contains(authority.Reads, coordinate => coordinate.ArticleIdentity == Article(4)
            && coordinate.Role == AdjacencyPermissionRole.Source);
    }

    [Theory]
    [InlineData(ArticleRelationPermissionState.Denied)]
    [InlineData(ArticleRelationPermissionState.Unknown)]
    public async Task RootUnavailable_ExposesNoCountsAndDoesNotReadSource(ArticleRelationPermissionState permission)
    {
        var (index, source, authority) = await Setup([Record(2, 1)]);
        int pageReads = source.PageReads;
        authority.Decide = coordinate => coordinate.Role == AdjacencyPermissionRole.Root ? permission : ArticleRelationPermissionState.Allowed;
        AdjacencyBudget budget = index.CreateAdjacencyBudget();
        AssertUnavailable(await index.ReadAdjacencyAsync(Request(1), authority, budget));
        Assert.Equal(pageReads, source.PageReads);
        Assert.Empty(source.ArticleReads);
        Assert.Single(authority.Reads);
        Assert.False(await index.VerifyAdjacencyBudgetAsync(budget, authority));
    }

    [Theory]
    [InlineData(ArticleRelationPermissionState.Denied, AdjacencyPermissionRole.Source)]
    [InlineData(ArticleRelationPermissionState.Unknown, AdjacencyPermissionRole.Source)]
    [InlineData(ArticleRelationPermissionState.Denied, AdjacencyPermissionRole.Target)]
    [InlineData(ArticleRelationPermissionState.Unknown, AdjacencyPermissionRole.Target)]
    public async Task NeighbourUnavailable_HidesPayloadBeforeNodeAndEdgeBudgets(
        ArticleRelationPermissionState permission, AdjacencyPermissionRole role)
    {
        var (index, source, authority) = await Setup([Record(2, 1)]);
        authority.Decide = coordinate => coordinate.Role == role ? permission : ArticleRelationPermissionState.Allowed;
        AdjacencyResult result = await index.ReadAdjacencyAsync(Request(1), authority, index.CreateAdjacencyBudget(new(Nodes: 1, Edges: 1)));
        Assert.True(result.Available);
        Assert.Equal(Article(1), Assert.Single(result.ArticleIdentities));
        Assert.Empty(result.Edges);
        Assert.Empty(source.ArticleReads);
    }

    [Fact]
    public async Task Admission_PrecedesKindAndRevisionFilters()
    {
        var (index, _, authority) = await Setup([Record(2, 1)]);
        AdjacencyResult result = await index.ReadAdjacencyAsync(Request(1) with
        {
            LinkKind = ArticleRelationKind.Broken,
            SourceRevisionKind = ArticleRelationRevisionKind.Published
        }, authority, index.CreateAdjacencyBudget());
        Assert.True(result.Available);
        Assert.Empty(result.Edges);
        Assert.Contains(authority.Reads, static coordinate => coordinate.Role == AdjacencyPermissionRole.Source);
        Assert.Contains(authority.Reads, static coordinate => coordinate.Role == AdjacencyPermissionRole.Target);
    }

    [Theory]
    [InlineData("nodes")]
    [InlineData("edges")]
    [InlineData("bytes")]
    [InlineData("operations")]
    [InlineData("time")]
    public async Task ExhaustedBudget_RefusesWholeResultAndInvalidatesLease(string dimension)
    {
        var (index, _, authority) = await Setup([Record(2, 1), Record(3, 1)]);
        var clock = new FixtureClock();
        AdjacencyLimits limits = dimension switch
        {
            "nodes" => new(Nodes: 2),
            "edges" => new(Edges: 1),
            "bytes" => new(Bytes: 128),
            "operations" => new(IndexOperations: 6),
            _ => new()
        };
        if (dimension == "time")
        {
            authority.OnRead = coordinate =>
            {
                if (coordinate.Role == AdjacencyPermissionRole.Source)
                {
                    clock.Advance(251);
                }
            };
        }
        AdjacencyBudget budget = index.CreateAdjacencyBudget(limits, clock);
        AssertUnavailable(await index.ReadAdjacencyAsync(Request(1), authority, budget));
        Assert.False(await index.VerifyAdjacencyBudgetAsync(budget, authority));
        AssertUnavailable(await index.ReadAdjacencyAsync(Request(1), authority, budget));
    }

    [Fact]
    public async Task CandidateOperations_StopWhileReadingDeniedCandidates()
    {
        var (index, source, authority) = await Setup(Enumerable.Range(2, 100).Select(id => Record(id, 1)).ToArray());
        authority.Decide = coordinate => coordinate.Role == AdjacencyPermissionRole.Source
            ? ArticleRelationPermissionState.Denied : ArticleRelationPermissionState.Allowed;
        AssertUnavailable(await index.ReadAdjacencyAsync(Request(1), authority,
            index.CreateAdjacencyBudget(new(IndexOperations: 12))));
        Assert.InRange(authority.Reads.Count, 2, 6);
        Assert.Empty(source.ArticleReads);
    }

    [Fact]
    public async Task SourceFamilyWork_IsBoundedEvenWithOneAdmittedEdge()
    {
        ArticleRelationRecord[] records = Enumerable.Range(1, 40).Select(target => Record(2, target, offset: target * 10)).ToArray();
        var (index, source, authority) = await Setup(records);
        AssertUnavailable(await index.ReadAdjacencyAsync(Request(1), authority,
            index.CreateAdjacencyBudget(new(IndexOperations: 30))));
        Assert.Single(source.ArticleReads);
    }

    [Theory]
    [InlineData("permission")]
    [InlineData("site")]
    [InlineData("session")]
    [InlineData("document")]
    [InlineData("document-identity")]
    [InlineData("source")]
    [InlineData("index")]
    [InlineData("actor")]
    public async Task ObservationDrift_RefusesWholeResult(string field)
    {
        var (index, _, authority) = await Setup([Record(2, 1)]);
        authority.OnObserve = count =>
        {
            if (count > 1)
            {
                authority.Observation = field switch
                {
                    "permission" => authority.Observation with { PermissionRevision = "permission:2" },
                    "site" => authority.Observation with { SiteRevision = "site:2" },
                    "session" => authority.Observation with { SessionRevision = "session:2" },
                    "document" => authority.Observation with { DocumentEpoch = 2 },
                    "document-identity" => authority.Observation with { DocumentIdentity = "document:other" },
                    "source" => authority.Observation with { SourceGeneration = 2 },
                    "index" => authority.Observation with { IndexGeneration = 2 },
                    _ => authority.Observation with { Actor = s_actor with { ActorIdentity = "actor:other" } }
                };
            }
        };
        AssertUnavailable(await index.ReadAdjacencyAsync(Request(1), authority, index.CreateAdjacencyBudget()));
    }

    [Fact]
    public async Task PermissionDecisionWrongCoordinate_IsUnavailable()
    {
        var (index, _, authority) = await Setup([Record(2, 1)]);
        authority.Misbind = true;
        AssertUnavailable(await index.ReadAdjacencyAsync(Request(1), authority, index.CreateAdjacencyBudget()));
    }

    [Fact]
    public async Task PermissionRevocationDuringFinalCheck_DiscardsStagedEdges()
    {
        var (index, _, authority) = await Setup([Record(2, 1)]);
        int targetReads = 0;
        authority.Decide = coordinate => coordinate.Role == AdjacencyPermissionRole.Target && ++targetReads > 1
            ? ArticleRelationPermissionState.Denied : ArticleRelationPermissionState.Allowed;
        AssertUnavailable(await index.ReadAdjacencyAsync(Request(1), authority, index.CreateAdjacencyBudget()));
    }

    [Theory]
    [InlineData("generation")]
    [InlineData("sequence")]
    [InlineData("record")]
    [InlineData("duplicate")]
    public async Task OriginalSourceDriftOrTampering_IsUnavailable(string fault)
    {
        ArticleRelationRecord record = Record(2, 1);
        ArticleRelationRecord second = Record(2, 1, offset: 10);
        var (index, source, authority) = await Setup([record, second]);
        source.OnArticleRead = () =>
        {
            if (fault == "generation")
            {
                source.Generation++;
            }
            else
            {
                ArticleRelationIndexArticle family = source.Articles[0];
                ArticleRelationSet set = family.Sets[0];
                source.Articles = [fault == "sequence" ? family with { SourceSequence = 2 } : family with
                {
                    Sets = [set with
                    {
                        Relations = fault == "duplicate" ? [record, record]
                            : [record with { Occurrence = record.Occurrence with { LinkText = "tampered" } }, second]
                    }]
                }];
            }
        };
        AssertUnavailable(await index.ReadAdjacencyAsync(Request(1), authority, index.CreateAdjacencyBudget()));
    }

    [Fact]
    public async Task CanonicalProducerOrderVariation_PreservesParity()
    {
        var (index, source, authority) = await Setup([Record(2, 1), Record(2, 1, offset: 10)]);
        source.Articles = [source.Articles[0] with
        {
            Sets = [ArticleRelationContractValidator.Seal(source.Articles[0].Sets[0] with
            {
                Relations = source.Articles[0].Sets[0].Relations.Reverse().ToArray()
            })]
        }];
        Assert.True((await index.ReadAdjacencyAsync(Request(1), authority, index.CreateAdjacencyBudget())).Available);
    }

    [Fact]
    public async Task Cancellation_StopsNonCooperativePermissionWait()
    {
        var (index, _, authority) = await Setup([Record(2, 1)]);
        using var cancellation = new CancellationTokenSource();
        authority.Pending = new(TaskCreationOptions.RunContinuationsAsynchronously);
        Task<AdjacencyResult> read = index.ReadAdjacencyAsync(Request(1), authority, index.CreateAdjacencyBudget(), cancellation.Token);
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => read);
    }

    [Fact]
    public async Task Deadline_StopsNonCooperativePermissionWaitWithoutPartialPayload()
    {
        var (index, _, authority) = await Setup([Record(2, 1)]);
        authority.Pending = new(TaskCreationOptions.RunContinuationsAsynchronously);
        AssertUnavailable(await index.ReadAdjacencyAsync(Request(1), authority, index.CreateAdjacencyBudget(new(Milliseconds: 20))));
    }

    [Fact]
    public async Task SharedDepthBudget_IsCumulativeAndFinalRevocationRejectsEarlierReads()
    {
        var (index, _, authority) = await Setup([Record(2, 1), Record(3, 2)]);
        AdjacencyBudget budget = index.CreateAdjacencyBudget(new(Nodes: 2));
        Assert.True((await index.ReadAdjacencyAsync(Request(1), authority, budget)).Available);
        AssertUnavailable(await index.ReadAdjacencyAsync(Request(2), authority, budget));
        Assert.False(await index.VerifyAdjacencyBudgetAsync(budget, authority));
        AdjacencyBudget second = index.CreateAdjacencyBudget();
        Assert.True((await index.ReadAdjacencyAsync(Request(1), authority, second)).Available);
        authority.Decide = _ => ArticleRelationPermissionState.Unknown;
        Assert.False(await index.VerifyAdjacencyBudgetAsync(second, authority));
    }

    [Fact]
    public async Task LeaseCannotMoveToAnotherIndexOrAuthority()
    {
        var (index, _, authority) = await Setup([Record(2, 1)]);
        var (otherIndex, _, otherAuthority) = await Setup([Record(2, 1)]);
        AssertUnavailable(await otherIndex.ReadAdjacencyAsync(Request(1), authority, index.CreateAdjacencyBudget()));
        AdjacencyBudget budget = index.CreateAdjacencyBudget();
        Assert.True((await index.ReadAdjacencyAsync(Request(1), authority, budget)).Available);
        AssertUnavailable(await index.ReadAdjacencyAsync(Request(1), otherAuthority, budget));
    }

    [Fact]
    public async Task Apply_CommitsAdjacencyWithTheSameIndexGeneration()
    {
        var (index, source, authority) = await Setup([Record(2, 1)]);
        source.Generation = 2;
        source.Articles = [Family(2, [Record(2, 3)], sequence: 2)];
        await index.ApplyAsync(Article(2), 1);
        AssertUnavailable(await index.ReadAdjacencyAsync(Request(1), authority, index.CreateAdjacencyBudget()));
        authority.Observation = authority.Observation with
        {
            IndexGeneration = 2,
            SourceGeneration = 2
        };
        AdjacencyResult oldTarget = await index.ReadAdjacencyAsync(Request(1) with
        {
            IndexGeneration = 2,
            SourceGeneration = 2
        }, authority, index.CreateAdjacencyBudget());
        Assert.True(oldTarget.Available);
        Assert.Empty(oldTarget.Edges);
        AdjacencyResult newTarget = await index.ReadAdjacencyAsync(Request(3) with
        {
            IndexGeneration = 2,
            SourceGeneration = 2
        }, authority, index.CreateAdjacencyBudget());
        Assert.Equal(Article(3), Assert.Single(newTarget.Edges).Link!.Target.TargetIdentity!.ArticleIdentity);
    }

    [Fact]
    public async Task EmbedProjection_PreservesOriginalCoordinatesAndHidesDeniedSibling()
    {
        ArticleRelationIndexEmbedAdmission admission = EmbedAdmission();
        var source = new FixtureSource([new(Article(2), 1, []) { Embeds = [admission] }]);
        var index = new ArticleRelationIndex(source, s_actor);
        await index.RebuildAsync(0);
        var authority = new FixtureAuthority();
        authority.Decide = coordinate => coordinate.ArticleIdentity == Article(3)
            ? ArticleRelationPermissionState.Denied : ArticleRelationPermissionState.Allowed;
        AdjacencyResult result = await index.ReadAdjacencyAsync(Request(2, AdjacencyDirections.Outgoing), authority, index.CreateAdjacencyBudget());
        Assert.True(result.Available);
        AdjacencyEdge item = Assert.Single(result.Edges);
        Assert.Null(item.Link);
        Assert.Equal(ArticleRelationIndexDependencyKind.Embed, item.DependencyKind);
        Assert.Equal(admission.EdgeSet.Edges[0], item.Embed!.Edge);
        Assert.Equal(admission.Coordinates[0], item.Embed.Coordinate);
        Assert.Null(item.Embed.PublicationReceipt);
        Assert.DoesNotContain(Article(3), result.ArticleIdentities);
        Assert.All(authority.Reads.Where(static coordinate => coordinate.EmbedScope.HasValue), static coordinate =>
        {
            Assert.Null(coordinate.RevisionKind);
            if (coordinate.Role != AdjacencyPermissionRole.Target)
            {
                Assert.Null(coordinate.RevisionIdentity);
            }
        });
        Assert.DoesNotContain(typeof(AdmittedAdjacencyEmbed).GetProperties(), static property =>
            property.PropertyType == typeof(ArticleRelationIndexEmbedAdmission)
            || property.PropertyType == typeof(ArticleEmbedRelationEdgeSet));
    }

    [Fact]
    public async Task HistoricalSource_NeedsItsOwnExactPermissionAdmission()
    {
        ArticleRelationRecord current = Record(2, 1);
        ArticleRelationRecord historical = ArticleRelationContractValidator.Seal(current with
        {
            Source = current.Source with
            {
                RevisionIdentity = "revision:history",
                RevisionNumber = 2,
                RevisionKind = ArticleRelationRevisionKind.Published
            }
        });
        var source = new FixtureSource([new(Article(2), 1,
        [ArticleRelationContractValidator.Seal(new ArticleRelationSet(ArticleRelationSchemas.RelationSet, 1, current.Source, [current], string.Empty)),
            ArticleRelationContractValidator.Seal(new ArticleRelationSet(ArticleRelationSchemas.RelationSet, 1, historical.Source, [historical], string.Empty))])]);
        var index = new ArticleRelationIndex(source, s_actor);
        await index.RebuildAsync(0);
        var authority = new FixtureAuthority
        {
            Decide = coordinate => coordinate.Role == AdjacencyPermissionRole.Source
                && coordinate.RevisionKind == ArticleRelationRevisionKind.Published
                ? ArticleRelationPermissionState.Denied : ArticleRelationPermissionState.Allowed
        };
        AdjacencyResult result = await index.ReadAdjacencyAsync(Request(1), authority, index.CreateAdjacencyBudget());
        Assert.True(result.Available);
        Assert.Equal(current, Assert.Single(result.Edges).Link);
        Assert.Contains(authority.Reads, static coordinate => coordinate.RevisionIdentity == "revision:history");
    }

    [Fact]
    public async Task LinkKindFilter_DoesNotReinterpretOrSuppressExplicitEmbedDomain()
    {
        var family = Family(2, [Record(2, 1)]) with
        {
            Embeds = [EmbedAdmission()]
        };
        var index = new ArticleRelationIndex(new FixtureSource([family]), s_actor);
        await index.RebuildAsync(0);
        var authority = new FixtureAuthority();
        AdjacencyRequest request = Request(2, AdjacencyDirections.Outgoing) with
        {
            LinkKind = ArticleRelationKind.Broken
        };
        AdjacencyResult result = await index.ReadAdjacencyAsync(request, authority, index.CreateAdjacencyBudget());
        Assert.True(result.Available);
        Assert.Equal(2, result.Edges.Length);
        Assert.All(result.Edges, static edge => Assert.Equal(ArticleRelationIndexDependencyKind.Embed, edge.DependencyKind));
        AdjacencyResult linksOnly = await index.ReadAdjacencyAsync(request with
        {
            IncludeEmbeds = false
        }, authority, index.CreateAdjacencyBudget());
        Assert.True(linksOnly.Available);
        Assert.Empty(linksOnly.Edges);
    }

    [Fact]
    public void HardCaps_CannotBeRaised()
    {
        var index = new ArticleRelationIndex(new FixtureSource([]), s_actor);
        Assert.Throws<ArgumentOutOfRangeException>(() => index.CreateAdjacencyBudget(new(Nodes: 1_001)));
        Assert.Throws<ArgumentOutOfRangeException>(() => index.CreateAdjacencyBudget(new(Edges: 2_001)));
        Assert.Throws<ArgumentOutOfRangeException>(() => index.CreateAdjacencyBudget(new(Bytes: 1_048_577)));
        Assert.Throws<ArgumentOutOfRangeException>(() => index.CreateAdjacencyBudget(new(IndexOperations: 4_097)));
        Assert.Throws<ArgumentOutOfRangeException>(() => index.CreateAdjacencyBudget(new(Milliseconds: 251)));
    }

    private static void AssertUnavailable(AdjacencyResult result)
    {
        Assert.False(result.Available);
        Assert.Empty(result.ArticleIdentities);
        Assert.Empty(result.Edges);
    }

    private static async Task<(ArticleRelationIndex, FixtureSource, FixtureAuthority)> Setup(ArticleRelationRecord[] records)
    {
        var source = new FixtureSource(records.GroupBy(static record => record.Source.ArticleIdentity)
            .OrderBy(static group => group.Key, StringComparer.Ordinal)
            .Select(static group => new ArticleRelationIndexArticle(group.Key, 1,
            [ArticleRelationContractValidator.Seal(new ArticleRelationSet(ArticleRelationSchemas.RelationSet, 1,
                group.First().Source, group.ToArray(), string.Empty))]))
            .ToImmutableArray());
        var index = new ArticleRelationIndex(source, s_actor);
        await index.RebuildAsync(0);
        return (index, source, new());
    }

    private static string Article(int id) => $"article:20000000-0000-4000-8000-{id:x12}";

    private static ArticleRelationTargetIdentity Target(int id, ArticleRelationTargetKind kind = ArticleRelationTargetKind.Article)
        => new(Article(id), kind, kind == ArticleRelationTargetKind.Heading ? "heading:heading-a" : null,
            kind == ArticleRelationTargetKind.Block ? "anchor-a" : null);

    private static ArticleRelationSourceFacts Source(int id)
        => new(Article(id), "revision:30000000-0000-4000-8000-000000000001", 1, ArticleRelationRevisionKind.Current,
            ArticleRelationLifecycleState.Published, ArticleRelationPermissionState.Allowed, s_actor, s_digest);

    private static ArticleRelationRecord Record(int source, int target,
        ArticleRelationTargetKind kind = ArticleRelationTargetKind.Article, int offset = 0)
        => ArticleRelationContractValidator.Seal(new ArticleRelationRecord(ArticleRelationSchemas.Relation, 1, string.Empty, 1,
            ArticleRelationKind.Outgoing, Source(source), new("[link]", new(offset, offset + 6, "[link]"), new(offset, offset + 6, "[link]"), 1),
            new(Target(target, kind), "revision:30000000-0000-4000-8000-000000090000", 1,
                ArticleRelationRevisionKind.Published, ArticleRelationLifecycleState.Published, ArticleRelationPermissionState.Allowed),
            new(s_actor, s_actor, ArticleRelationQueryScope.Authoring, ArticleRelationPublicContext.AuthoringActor, s_digest),
            ArticleRelationResolutionStatus.Resolved, new(1, 1, 1, 1, 1), string.Empty));

    private static ArticleRelationIndexArticle Family(int id, ArticleRelationRecord[] records, long sequence = 1)
        => new(Article(id), sequence, [ArticleRelationContractValidator.Seal(new ArticleRelationSet(
            ArticleRelationSchemas.RelationSet, 1, Source(id), records, string.Empty))]);

    private static AdjacencyRequest Request(int id, AdjacencyDirections direction = AdjacencyDirections.Incoming)
        => new(s_actor, 1, 1, 1, "document:adjacency", new(Article(id), "revision:30000000-0000-4000-8000-000000000001", 1,
            ArticleRelationRevisionKind.Current, Target(id), null, null, AdjacencyPermissionRole.Root), direction,
            ArticleRelationQueryScope.Authoring, ArticleEmbedEdgeScope.Authoring);

    private static ArticleRelationIndexEmbedAdmission EmbedAdmission()
    {
        var actor = new ArticleEmbedActorContext(s_actor.ActorIdentity, s_actor.SiteIdentity, s_digest);
        var runtime = new ArticleEmbedRuntimeContext("article-embed", 1, ArticleEmbedSchemas.ProviderRuntime, s_digest);
        var document = new ArticleEmbedDocumentIdentity("document:adjacency", 1);
        var projection = new ArticleEmbedSafeProjectionReference(ArticleEmbedProjectionKind.SafeProjection, "projection:adjacency", s_digest);
        using var signal = new CancellationTokenSource();
        var requestList = new List<ArticleEmbedProviderRequest>();
        foreach (int id in new[] { 1, 3 })
        {
            requestList.Add(ArticleEmbedContractValidator.Seal(new ArticleEmbedProviderRequest(
                ArticleEmbedSchemas.ProviderRequest, ArticleEmbedSchemas.Version, $"request:{id}", Article(2), document, 1,
                new(ArticleEmbedSchemas.ParserContract, Article(id), ArticleEmbedTargetKind.Article, new(id * 50, id * 50 + 44)),
                new(Article(id), ArticleEmbedTargetKind.Article, null, null), ArticleEmbedRequestedScope.Authoring,
                actor, runtime, s_digest, string.Empty, signal.Token)));
        }
        ArticleEmbedProviderRequest[] requests = requestList.ToArray();
        ArticleEmbedTargetFacts[] targets = [.. new[] { 1, 3 }.Select(id => new ArticleEmbedTargetFacts(
            Article(id), s_actor.SiteIdentity, 1, 1, 1, 1, ArticleEmbedVisibilityStatus.Public,
            ArticleEmbedLifecycleStatus.Published, ArticleEmbedPermissionStatus.Allowed, s_digest, "version:1", 128,
            "Fixture", projection, [], [], []))];
        var snapshot = ArticleEmbedAuthoringContractValidator.Seal(new ArticleEmbedAuthoritySnapshot(
            ArticleEmbedAuthoringSchemas.AuthoritySnapshot, ArticleEmbedAuthoringSchemas.Version, Article(2), document,
            1, s_digest, 1, actor, runtime, "zh-CN", "light", targets, string.Empty));
        var budgets = new ArticleEmbedResolutionBudgetLimits(8, 64, 1_048_576, 60_000, 128);
        var pipeline = ArticleEmbedAuthoringPipeline.Evaluate(requests, snapshot, budgets);
        Assert.True(pipeline.Relations.Accepted);
        return ArticleRelationIndexEmbedAdmission.FromAuthoring(1, 1, requests, snapshot, budgets,
            pipeline.Projection, pipeline.Graph, pipeline.Relations);
    }

    private sealed class FixtureClock : TimeProvider
    {
        private long _milliseconds;
        public override long TimestampFrequency => 1_000;
        public override long GetTimestamp() => _milliseconds;
        public void Advance(long milliseconds) => _milliseconds += milliseconds;
    }

    private sealed class FixtureAuthority : IAdjacencyAuthority
    {
        public AdjacencyObservation Observation
        {
            get; set;
        } = new(s_actor, 1, 1, 1, "document:adjacency",
            ArticleRelationQueryScope.Authoring, "permission:1", "site:1", "session:1");
        public Func<AdjacencyPermissionCoordinate, ArticleRelationPermissionState> Decide { get; set; } = _ => ArticleRelationPermissionState.Allowed;
        public Action<AdjacencyPermissionCoordinate>? OnRead
        {
            get; set;
        }
        public Action<int>? OnObserve
        {
            get; set;
        }
        public bool Misbind
        {
            get; set;
        }
        public TaskCompletionSource<AdjacencyPermissionDecision?>? Pending
        {
            get; set;
        }
        public List<AdjacencyPermissionCoordinate> Reads { get; } = [];
        private int _observations;

        public Task<AdjacencyObservation?> ObserveAsync(ArticleRelationActorContext actor,
            ArticleRelationQueryScope scope, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            OnObserve?.Invoke(++_observations);
            return Task.FromResult<AdjacencyObservation?>(Observation);
        }

        public Task<AdjacencyPermissionDecision?> ReadPermissionAsync(AdjacencyObservation observation,
            AdjacencyPermissionCoordinate coordinate, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Reads.Add(coordinate);
            OnRead?.Invoke(coordinate);
            return Pending?.Task ?? Task.FromResult<AdjacencyPermissionDecision?>(new(observation,
                Misbind ? coordinate with
                {
                    ArticleIdentity = Article(99)
                } : coordinate, Decide(coordinate)));
        }
    }

    private sealed class FixtureSource(ImmutableArray<ArticleRelationIndexArticle> articles) : IArticleRelationIndexSource
    {
        public ImmutableArray<ArticleRelationIndexArticle> Articles { get; set; } = articles;
        public long Generation { get; set; } = 1;
        public int PageReads
        {
            get; private set;
        }
        public Action? OnArticleRead
        {
            get; set;
        }
        public List<string> ArticleReads { get; } = [];

        public Task<ArticleRelationIndexSourcePage> ReadAsync(ArticleRelationActorContext actor, string? afterArticleIdentity,
            int pageSize, long? expectedSourceGeneration, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            PageReads++;
            var remaining = Articles.Where(article => afterArticleIdentity is null
                || StringComparer.Ordinal.Compare(article.ArticleIdentity, afterArticleIdentity) > 0).ToArray();
            return Task.FromResult(new ArticleRelationIndexSourcePage(actor, Generation,
                remaining.Take(pageSize).ToImmutableArray(), remaining.Length > pageSize));
        }

        public Task<ArticleRelationIndexArticleRead> ReadArticleAsync(ArticleRelationActorContext actor, string articleIdentity,
            long? expectedSourceGeneration, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            ArticleReads.Add(articleIdentity);
            OnArticleRead?.Invoke();
            return Task.FromResult(new ArticleRelationIndexArticleRead(actor, Generation,
                Articles.Single(article => article.ArticleIdentity == articleIdentity)));
        }
    }
}
