using System.Collections.Immutable;

using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleRelations;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Actual index algorithm controls with explicit fixture ports, not observed permission or durable-store receipts.</summary>
[Trait("Category", "Unit")]
public sealed class ArticleRelationIndexTests
{
    private static readonly string s_digest = new('a', 64);
    private static readonly ArticleRelationActorContext s_actor = new("actor:index", "site:primary", s_digest);

    [Fact]
    public async Task Rebuild_IndexesAllCanonicalTargetKindsAndExactBrokenFacts()
    {
        ArticleRelationTargetIdentity article = Target(ArticleRelationTargetKind.Article);
        ArticleRelationTargetIdentity heading = Target(ArticleRelationTargetKind.Heading);
        ArticleRelationTargetIdentity block = Target();
        var source = new FixtureSource([Family(1, 1, Set(1, 1, records: [
            Record(1, 1, article), Record(1, 1, heading, offset: 10), Record(1, 1, block, offset: 20),
            Record(1, 1, block, ArticleRelationKind.Broken, ArticleRelationResolutionStatus.MissingAnchor, 30)]))]);
        var index = new ArticleRelationIndex(source, s_actor);

        ArticleRelationIndexSnapshot snapshot = await index.RebuildAsync(0);
        Assert.Equal(1, snapshot.IndexGeneration);
        Assert.Single(index.InspectTarget(article, 1).Records);
        Assert.Single(index.InspectTarget(heading, 1).Records);
        Assert.Equal(2, index.InspectTarget(block, 1).Records.Length);
        ArticleRelationRecord broken = Assert.Single(index.InspectTarget(block, 1, ArticleRelationKind.Broken).Records);
        Assert.Equal(ArticleRelationResolutionStatus.MissingAnchor, broken.Resolution);
        Assert.Equal("anchor-a", broken.Target.TargetIdentity!.BlockAnchorIdentity);
        await index.RevalidateSourceAsync(index.InspectTarget(block, 1));
        Assert.Single(source.ArticleReads);
    }

    [Fact]
    public async Task Rebuild_OwnsRelationListsAndProducesDeterministicCanonicalOrder()
    {
        var mutable = new List<ArticleRelationRecord> { Record(1, 1, Target(), offset: 20), Record(1, 1, Target(), offset: 0) };
        ArticleRelationSet input = Set(1, 1, records: mutable);
        var source = new FixtureSource([Family(1, 1, input)]);
        var index = new ArticleRelationIndex(source, s_actor);
        ArticleRelationIndexSnapshot first = await index.RebuildAsync(0);
        mutable.Clear();
        Assert.Equal(2, first.Articles[Article(1)].Sets[0].Relations.Count);

        var reverseSource = new FixtureSource([Family(1, 1, Set(1, 1, records: [
            Record(1, 1, Target(), offset: 0), Record(1, 1, Target(), offset: 20)]))]);
        ArticleRelationIndexSnapshot reverse = await new ArticleRelationIndex(reverseSource, s_actor).RebuildAsync(0);
        Assert.Equal(Digests(first), Digests(reverse));
    }

    [Fact]
    public async Task Apply_ReplacesCurrentSetIdempotentlyAndMatchesFullRebuild()
    {
        ArticleRelationSet frozen = Set(1, 20, ArticleRelationRevisionKind.Published);
        var source = new FixtureSource([Family(1, 1, Set(1, 2), frozen)]);
        var index = new ArticleRelationIndex(source, s_actor);
        ArticleRelationIndexSnapshot before = await index.RebuildAsync(0);
        source.Generation = 2;
        // A rollback can lower the source revision while the observed lifecycle sequence increases.
        source.Articles = [Family(1, 2, Set(1, 1), frozen)];
        ArticleRelationIndexSnapshot after = await index.ApplyAsync(Article(1), 1);
        Assert.Same(after, await index.ApplyAsync(Article(1), 2));
        ArticleRelationIndexSnapshot rebuilt = await new ArticleRelationIndex(source, s_actor).RebuildAsync(0);
        Assert.Equal(Digests(after), Digests(rebuilt));
        Assert.Equal(frozen.SetDigest, after.Articles[Article(1)].Sets.Single(static set => set.Source.RevisionKind == ArticleRelationRevisionKind.Published).SetDigest);
        Assert.Equal(2, before.Articles[Article(1)].Sets.Single(static set => set.Source.RevisionKind == ArticleRelationRevisionKind.Current).Source.RevisionNumber);
        Assert.Equal(1, after.Articles[Article(1)].Sets.Single(static set => set.Source.RevisionKind == ArticleRelationRevisionKind.Current).Source.RevisionNumber);
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task History_RemovalOrRewriteIsRefusedWithoutPartialCommit(bool rebuild, bool rewrite)
    {
        ArticleRelationSet frozen = Set(1, 20, ArticleRelationRevisionKind.Published);
        var source = new FixtureSource([Family(1, 1, Set(1, 1), frozen)]);
        var index = new ArticleRelationIndex(source, s_actor);
        ArticleRelationIndexSnapshot original = await index.RebuildAsync(0);
        source.Generation = 2;
        source.Articles = [rewrite
            ? Family(1, 2, Set(1, 2), Set(1, 20, ArticleRelationRevisionKind.Published, [Record(1, 20, Target(), offset: 40, sourceKind: ArticleRelationRevisionKind.Published)]))
            : Family(1, 2, Set(1, 2))];

        ArticleRelationIndexException failure = await Assert.ThrowsAsync<ArticleRelationIndexException>(
            () => rebuild ? index.RebuildAsync(1) : index.ApplyAsync(Article(1), 1));
        Assert.Equal("article_relation_index_history_immutable", failure.ReasonCode);
        Assert.Same(original, index.ReadSnapshot(1));
    }

    [Theory]
    [InlineData("generation-old")]
    [InlineData("generation-gap")]
    [InlineData("sequence-old")]
    [InlineData("same-generation-changed")]
    [InlineData("actor")]
    [InlineData("article")]
    public async Task Apply_RefusesStaleReorderedAndMisboundSourceEvents(string fault)
    {
        var source = new FixtureSource([Family(1, 2, Set(1, 2))]) { Generation = 2 };
        var index = new ArticleRelationIndex(source, s_actor);
        ArticleRelationIndexSnapshot original = await index.RebuildAsync(0);
        source.Generation = fault switch
        {
            "generation-old" => 1,
            "generation-gap" => 4,
            "same-generation-changed" => 2,
            _ => 3
        };
        source.Articles = [Family(1, fault == "sequence-old" ? 1 : 3, Set(1, 3))];
        source.ReadFault = fault;
        await Assert.ThrowsAsync<ArticleRelationIndexException>(() => index.ApplyAsync(Article(1), 1));
        Assert.Same(original, index.ReadSnapshot(1));
    }

    [Fact]
    public async Task ConcurrentApply_OnlyOneExpectedGenerationCommits()
    {
        var source = new FixtureSource([Family(1, 1, Set(1, 1))]);
        var index = new ArticleRelationIndex(source, s_actor);
        await index.RebuildAsync(0);
        source.Generation = 2;
        source.Articles = [Family(1, 2, Set(1, 2))];
        var bothArrived = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        int arrivals = 0;
        source.BeforeArticleRead = async () =>
        {
            if (Interlocked.Increment(ref arrivals) == 2)
            {
                bothArrived.SetResult();
            }
            await bothArrived.Task.WaitAsync(TimeSpan.FromSeconds(10));
        };
        async Task<bool> Apply()
        {
            try
            {
                await index.ApplyAsync(Article(1), 1);
                return true;
            }
            catch (ArticleRelationIndexException failure)
            {
                Assert.Equal("article_relation_index_generation_stale", failure.ReasonCode);
                return false;
            }
        }
        bool[] outcomes = await Task.WhenAll(Apply(), Apply());
        Assert.Single(outcomes, static success => success);
        Assert.Equal(2, index.ReadSnapshot(2).IndexGeneration);
    }

    [Theory]
    [InlineData("digest")]
    [InlineData("duplicate-set")]
    [InlineData("duplicate-current")]
    [InlineData("wrong-source")]
    [InlineData("wrong-query-actor")]
    [InlineData("unordered-page")]
    [InlineData("empty-progress")]
    public async Task Rebuild_RefusesTamperedDuplicateOrAmbiguousInputs(string fault)
    {
        ArticleRelationSet valid = Set(1, 1);
        ArticleRelationSet changed = fault switch
        {
            "digest" => valid with { SetDigest = new string('b', 64) },
            "wrong-source" => Set(2, 1),
            "wrong-query-actor" => Set(1, 1, records: [ArticleRelationContractValidator.Seal(Record(1, 1, Target()) with
            {
                Visibility = Record(1, 1, Target()).Visibility with { QueryActor = s_actor with { ActorIdentity = "actor:other" } }
            })]),
            _ => valid
        };
        ArticleRelationIndexArticle family = fault switch
        {
            "duplicate-set" => Family(1, 1, valid, valid),
            "duplicate-current" => Family(1, 1, valid, Set(1, 2)),
            _ => Family(1, 1, changed)
        };
        var source = new FixtureSource([family]) { PageFault = fault };
        var index = new ArticleRelationIndex(source, s_actor);
        await Assert.ThrowsAsync<ArticleRelationIndexException>(() => index.RebuildAsync(0));
        Assert.Equal("article_relation_index_rebuild_required", Assert.Throws<ArticleRelationIndexException>(() => index.ReadSnapshot(0)).ReasonCode);
    }

    [Fact]
    public async Task Rebuild_SourceDriftAndCancellationLeavePreviousSnapshotIntact()
    {
        var source = new FixtureSource([Family(1, 1, Set(1, 1))]);
        var index = new ArticleRelationIndex(source, s_actor);
        ArticleRelationIndexSnapshot original = await index.RebuildAsync(0);
        source.PageCalls = 0;
        source.OnPageRead = call =>
        {
            if (call == 2)
            {
                source.Generation++;
            }
        };
        await Assert.ThrowsAsync<ArticleRelationIndexException>(() => index.RebuildAsync(1));
        Assert.Same(original, index.ReadSnapshot(1));
        source.OnPageRead = null;
        using var cancellation = new CancellationTokenSource();
        source.OnPageRead = _ => cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => index.RebuildAsync(1, cancellation.Token));
        Assert.Same(original, index.ReadSnapshot(1));
        Assert.ThrowsAny<OperationCanceledException>(() => index.InspectTarget(Target(), 1, cancellationToken: cancellation.Token));
    }

    [Theory]
    [InlineData("actor")]
    [InlineData("records")]
    [InlineData("target")]
    [InlineData("source-generation")]
    [InlineData("source-drift")]
    [InlineData("index-drift")]
    public async Task Inspection_RefusesManufacturedOrStaleResults(string fault)
    {
        var source = new FixtureSource([Family(1, 1, Set(1, 1))]);
        var index = new ArticleRelationIndex(source, s_actor);
        await index.RebuildAsync(0);
        ArticleRelationIndexInspection inspection = index.InspectTarget(Target(), 1);
        inspection = fault switch
        {
            "actor" => inspection with { Actor = s_actor with { ActorIdentity = "actor:other" } },
            "records" => inspection with { Records = [] },
            "target" => inspection with { Target = Target() with { BlockAnchorIdentity = "other-anchor" } },
            "source-generation" => inspection with { SourceGeneration = 2 },
            _ => inspection
        };
        if (fault is "source-drift" or "index-drift")
        {
            source.Articles = [Family(1, 2, Set(1, 2))];
            if (fault == "index-drift")
            {
                source.Generation = 2;
                await index.ApplyAsync(Article(1), 1);
            }
        }
        await Assert.ThrowsAsync<ArticleRelationIndexException>(() => index.RevalidateSourceAsync(inspection));
    }

    [Fact]
    public async Task EmptyCorpus_IsRevalidatedAndDoesNotFabricateAnAdmittedPage()
    {
        var source = new FixtureSource([]);
        var index = new ArticleRelationIndex(source, s_actor);
        await index.RebuildAsync(0);
        ArticleRelationIndexInspection inspection = index.InspectTarget(Target(), 1);
        Assert.Empty(inspection.Records);
        await index.RevalidateSourceAsync(inspection);
        source.Generation++;
        await Assert.ThrowsAsync<ArticleRelationIndexException>(() => index.RevalidateSourceAsync(inspection));
        Assert.Empty(source.ArticleReads);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(10_000)]
    public async Task Scale_UsesBoundedPagesForUpToTenThousandArticlesAndOneHundredThousandEdges(int count)
    {
        ImmutableArray<ArticleRelationIndexArticle> articles = [.. Enumerable.Range(1, count)
            .Select(id => Family(id, 1, Set(id, 1, records: Enumerable.Range(0, 10)
                .Select(offset => Record(id, 1, Target(), offset: offset * 10)).ToArray())))];
        var source = new FixtureSource(articles);
        var index = new ArticleRelationIndex(source, s_actor);
        ArticleRelationIndexSnapshot snapshot = await index.RebuildAsync(0);
        Assert.Equal(count, snapshot.Articles.Count);
        Assert.Equal(count * 10, index.InspectTarget(Target(), 1).Records.Length);
        Assert.All(source.PageSizes, static size => Assert.InRange(size, 1, ArticleRelationIndex.BatchSize));
        Assert.Empty(source.ArticleReads);
    }

    [Fact]
    public async Task Budget_RefusesArticleAndEdgeOverflow()
    {
        var tooManyArticles = new FixtureSource([.. Enumerable.Range(1, ArticleRelationIndex.MaxArticles + 1)
            .Select(id => Family(id, 1))]);
        await Assert.ThrowsAsync<ArticleRelationIndexException>(() => new ArticleRelationIndex(tooManyArticles, s_actor).RebuildAsync(0));
        ArticleRelationSet valid = Set(1, 1);
        var overflow = valid with
        {
            Relations = Enumerable.Repeat(valid.Relations[0], ArticleRelationIndex.MaxRelations + 1).ToArray()
        };
        var tooManyEdges = new FixtureSource([Family(1, 1, overflow)]);
        await Assert.ThrowsAsync<ArticleRelationIndexException>(() => new ArticleRelationIndex(tooManyEdges, s_actor).RebuildAsync(0));
    }

    [Theory]
    [InlineData(ArticleRelationResolutionStatus.Resolved)]
    [InlineData(ArticleRelationResolutionStatus.MissingAnchor)]
    [InlineData(ArticleRelationResolutionStatus.Deleted)]
    [InlineData(ArticleRelationResolutionStatus.Archived)]
    [InlineData(ArticleRelationResolutionStatus.Unauthorized)]
    [InlineData(ArticleRelationResolutionStatus.Private)]
    [InlineData(ArticleRelationResolutionStatus.Draft)]
    [InlineData(ArticleRelationResolutionStatus.Stale)]
    public async Task Lifecycle_PreservesCanonicalStatusFactsWithoutReauthorizingThem(ArticleRelationResolutionStatus status)
    {
        ArticleRelationRecord record = Record(1, 1, Target(),
            status == ArticleRelationResolutionStatus.Resolved ? ArticleRelationKind.Outgoing : ArticleRelationKind.Broken, status);
        ArticleRelationTargetFacts target = record.Target with
        {
            Permission = status is ArticleRelationResolutionStatus.Unauthorized or ArticleRelationResolutionStatus.Private
                ? ArticleRelationPermissionState.Denied : ArticleRelationPermissionState.Allowed,
            RevisionKind = status == ArticleRelationResolutionStatus.Draft ? ArticleRelationRevisionKind.Draft : ArticleRelationRevisionKind.Current,
            Lifecycle = status switch
            {
                ArticleRelationResolutionStatus.Deleted => ArticleRelationLifecycleState.Deleted,
                ArticleRelationResolutionStatus.Archived => ArticleRelationLifecycleState.Archived,
                ArticleRelationResolutionStatus.Draft => ArticleRelationLifecycleState.Draft,
                _ => ArticleRelationLifecycleState.Published
            }
        };
        record = ArticleRelationContractValidator.Seal(record with
        {
            Target = target
        });
        var source = new FixtureSource([Family(1, 1, Set(1, 1, records: [record]))]);
        var index = new ArticleRelationIndex(source, s_actor);
        await index.RebuildAsync(0);
        ArticleRelationRecord stored = Assert.Single(index.InspectTarget(Target(), 1).Records);
        Assert.Equal(status, stored.Resolution);
        Assert.Equal(target, stored.Target);
    }

    [Fact]
    public async Task AnchorRename_RemainsBrokenAtOldIdentityAndMoveUpdatesOnlyCanonicalRangeFacts()
    {
        var source = new FixtureSource([Family(1, 1, Set(1, 1))]);
        var index = new ArticleRelationIndex(source, s_actor);
        ArticleRelationIndexSnapshot old = await index.RebuildAsync(0);
        source.Generation = 2;
        source.Articles = [Family(1, 2, Set(1, 2, records: [Record(1, 2, Target(),
            ArticleRelationKind.Broken, ArticleRelationResolutionStatus.MissingAnchor)]))];
        await index.ApplyAsync(Article(1), 1);
        Assert.Equal(ArticleRelationResolutionStatus.MissingAnchor, Assert.Single(index.InspectTarget(Target(), 2).Records).Resolution);
        Assert.Empty(index.InspectTarget(Target() with
        {
            BlockAnchorIdentity = "anchor-renamed"
        }, 2).Records);
        source.Generation = 3;
        source.Articles = [Family(1, 3, Set(1, 3, records: [Record(1, 3, Target(), offset: 50)]))];
        await index.ApplyAsync(Article(1), 2);
        ArticleRelationRecord moved = Assert.Single(index.InspectTarget(Target(), 3).Records);
        Assert.Equal("anchor-a", moved.Target.TargetIdentity!.BlockAnchorIdentity);
        Assert.Equal(50, moved.Occurrence.First.Start);
        Assert.Equal("[link]", moved.Occurrence.LinkText);
        Assert.Equal(0, old.Articles[Article(1)].Sets[0].Relations[0].Occurrence.First.Start);
    }

    [Fact]
    public async Task SlugOnlyObservation_PreservesStableTargetAndSemanticSetBytes()
    {
        ArticleRelationSet unchanged = Set(1, 1);
        var source = new FixtureSource([Family(1, 1, unchanged)]);
        var index = new ArticleRelationIndex(source, s_actor);
        ArticleRelationIndexSnapshot before = await index.RebuildAsync(0);
        source.Generation = 2;
        // Routes are absent from the canonical relation identity; the source lifecycle sequence changes.
        source.Articles = [Family(1, 2, unchanged)];
        ArticleRelationIndexSnapshot after = await index.ApplyAsync(Article(1), 1);
        Assert.Equal(Digests(before), Digests(after));
        Assert.Equal(Target(), Assert.Single(index.InspectTarget(Target(), 2).Records).Target.TargetIdentity);
    }

    [Fact]
    public async Task Apply_RefusesSourceDriftAfterPreparingReplacement()
    {
        var source = new FixtureSource([Family(1, 1, Set(1, 1))]);
        var index = new ArticleRelationIndex(source, s_actor);
        ArticleRelationIndexSnapshot original = await index.RebuildAsync(0);
        source.Generation = 2;
        source.Articles = [Family(1, 2, Set(1, 2))];
        source.OnPageRead = _ => source.Generation++;
        await Assert.ThrowsAsync<ArticleRelationIndexException>(() => index.ApplyAsync(Article(1), 1));
        Assert.Same(original, index.ReadSnapshot(1));
    }

    [Fact]
    public async Task PublicDraftMixAndAggregateTextOverflowAreRefused()
    {
        ArticleRelationRecord draft = Record(1, 1, Target(), sourceKind: ArticleRelationRevisionKind.Draft);
        ArticleRelationRecord invalidPublic = ArticleRelationContractValidator.Seal(draft with
        {
            Visibility = draft.Visibility with
            {
                QueryScope = ArticleRelationQueryScope.CurrentPublicPublication,
                PublicContext = ArticleRelationPublicContext.AnonymousPublic,
                QueryActor = s_actor with
                {
                    ActorIdentity = "public:anonymous"
                }
            }
        });
        var publicSource = new FixtureSource([Family(1, 1, Set(1, 1, ArticleRelationRevisionKind.Draft, [invalidPublic]))]);
        await Assert.ThrowsAsync<ArticleRelationIndexException>(() => new ArticleRelationIndex(publicSource, s_actor).RebuildAsync(0));
        string text = new('a', 8_192);
        ArticleRelationRecord[] bulky = Enumerable.Range(0, 1_366).Select(offset => ArticleRelationContractValidator.Seal(
            Record(1, 1, Target(), offset: offset * 10) with
            {
                Occurrence = new(text, new(offset, offset + text.Length, text), new(offset, offset + text.Length, text), 1)
            })).ToArray();
        var bulkySource = new FixtureSource([Family(1, 1, Set(1, 1, records: bulky))]);
        await Assert.ThrowsAsync<ArticleRelationIndexException>(() => new ArticleRelationIndex(bulkySource, s_actor).RebuildAsync(0));
    }

    private static string[] Digests(ArticleRelationIndexSnapshot snapshot)
        => snapshot.Articles.Values.SelectMany(static article => article.Sets).Select(static set => set.SetDigest).ToArray();

    private static string Article(int id) => $"article:20000000-0000-4000-8000-{id:x12}";

    private static ArticleRelationTargetIdentity Target(ArticleRelationTargetKind kind = ArticleRelationTargetKind.Block)
        => new(Article(900_000), kind, kind == ArticleRelationTargetKind.Heading ? "heading:heading-a" : null,
            kind == ArticleRelationTargetKind.Block ? "anchor-a" : null);

    private static ArticleRelationSourceFacts Source(int id, int revision, ArticleRelationRevisionKind kind)
        => new(Article(id), $"revision:30000000-0000-4000-8000-{revision:x12}", revision, kind,
            kind == ArticleRelationRevisionKind.Draft ? ArticleRelationLifecycleState.Draft : ArticleRelationLifecycleState.Published,
            ArticleRelationPermissionState.Allowed, s_actor, s_digest);

    private static ArticleRelationRecord Record(int id, int revision, ArticleRelationTargetIdentity target,
        ArticleRelationKind kind = ArticleRelationKind.Outgoing, ArticleRelationResolutionStatus status = ArticleRelationResolutionStatus.Resolved,
        int offset = 0, ArticleRelationRevisionKind sourceKind = ArticleRelationRevisionKind.Current)
        => ArticleRelationContractValidator.Seal(new ArticleRelationRecord(
            ArticleRelationSchemas.Relation, 1, string.Empty, 1, kind, Source(id, revision, sourceKind),
            new("[link]", new(offset, offset + 6, "[link]"), new(offset, offset + 6, "[link]"), 1),
            new(target, "revision:30000000-0000-4000-8000-000000090000", 1,
                ArticleRelationRevisionKind.Published, ArticleRelationLifecycleState.Published, ArticleRelationPermissionState.Allowed),
            new(s_actor, s_actor, ArticleRelationQueryScope.Authoring, ArticleRelationPublicContext.AuthoringActor, s_digest),
            status, new(1, 1, 1, 1, 1), string.Empty));

    private static ArticleRelationSet Set(int id, int revision, ArticleRelationRevisionKind kind = ArticleRelationRevisionKind.Current,
        IReadOnlyList<ArticleRelationRecord>? records = null)
        => ArticleRelationContractValidator.Seal(new ArticleRelationSet(ArticleRelationSchemas.RelationSet, 1,
            Source(id, revision, kind), records ?? [Record(id, revision, Target(), sourceKind: kind)], string.Empty));

    private static ArticleRelationIndexArticle Family(int id, long sequence, params ArticleRelationSet[] sets)
        => new(Article(id), sequence, [.. sets]);

    private sealed class FixtureSource(ImmutableArray<ArticleRelationIndexArticle> articles) : IArticleRelationIndexSource
    {
        public ImmutableArray<ArticleRelationIndexArticle> Articles { get; set; } = articles;
        public long Generation { get; set; } = 1;
        public string? ReadFault
        {
            get; set;
        }
        public string? PageFault
        {
            get; set;
        }
        public int PageCalls
        {
            get; set;
        }
        public Action<int>? OnPageRead
        {
            get; set;
        }
        public Func<Task>? BeforeArticleRead
        {
            get; set;
        }
        public List<int> PageSizes { get; } = [];
        public List<string> ArticleReads { get; } = [];

        public Task<ArticleRelationIndexSourcePage> ReadAsync(ArticleRelationActorContext actor, string? afterArticleIdentity,
            int pageSize, long? expectedSourceGeneration, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            PageSizes.Add(pageSize);
            OnPageRead?.Invoke(++PageCalls);
            if (expectedSourceGeneration.HasValue && expectedSourceGeneration != Generation)
            {
                throw new ArticleRelationIndexException("fixture_source_generation_stale");
            }
            ArticleRelationIndexArticle[] remaining = Articles.Where(article => afterArticleIdentity is null
                || StringComparer.Ordinal.Compare(article.ArticleIdentity, afterArticleIdentity) > 0)
                .OrderBy(static article => article.ArticleIdentity, StringComparer.Ordinal).ToArray();
            ImmutableArray<ArticleRelationIndexArticle> page = [.. remaining.Take(pageSize)];
            if (PageFault == "unordered-page")
            {
                page = [Family(2, 1), Family(1, 1)];
            }
            if (PageFault == "empty-progress")
            {
                page = [];
            }
            return Task.FromResult(new ArticleRelationIndexSourcePage(actor, Generation, page,
                PageFault == "empty-progress" || remaining.Length > pageSize));
        }

        public async Task<ArticleRelationIndexArticleRead> ReadArticleAsync(ArticleRelationActorContext actor,
            string articleIdentity, long? expectedSourceGeneration, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (BeforeArticleRead is not null)
            {
                await BeforeArticleRead();
            }
            lock (ArticleReads)
            {
                ArticleReads.Add(articleIdentity);
            }
            if (expectedSourceGeneration.HasValue && expectedSourceGeneration != Generation)
            {
                throw new ArticleRelationIndexException("fixture_source_generation_stale");
            }
            ArticleRelationIndexArticle article = Articles.Single(candidate => candidate.ArticleIdentity == articleIdentity);
            return new(ReadFault == "actor" ? actor with
            {
                ActorIdentity = "actor:other"
            } : actor, Generation,
                ReadFault == "article" ? article with
                {
                    ArticleIdentity = Article(2)
                } : article);
        }
    }
}
