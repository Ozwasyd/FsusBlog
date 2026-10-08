using System.Collections.Immutable;

using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleRelations;
using FsusBlog.Shared.Contracts.BlockLinks;

namespace FsusBlog.Server.Tests.Unit;

// Controlled original-port inputs exercise the real index/planner; no fixture is a production authority.
public sealed class ArticleBlockAnchorImpactPlannerTests
{
    private const string Digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string OtherDigest = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private static readonly ArticleRelationActorContext s_actor = new("actor:impact", "site:primary", Digest);
    private static readonly BlockAnchorId s_old = BlockAnchorId.Create("old-id");
    private static readonly BlockAnchorId s_new = BlockAnchorId.Create("new-id");

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(10_000)]
    public async Task ActualIndexFreezesEveryCurrentRangeWithBoundedSequentialFactReads(int count)
    {
        Fixture fixture = await Fixture.CreateAsync(count);
        ArticleBlockAnchorImpactPlan plan = (await fixture.Planner.FreezeAsync(fixture.Request)).Plan!;
        Assert.NotNull(plan);
        Assert.Equal(count, plan.Items.Length);
        Assert.All(plan.Items, item =>
        {
            Assert.Equal(ArticleBlockAnchorImpactDisposition.RenameCurrentLink, item.Disposition);
            Assert.Equal("[引用](/posts/old-route#old-id)", item.BeforeMarkdown);
            Assert.Equal("[引用](/posts/old-route#new-id)", item.AfterMarkdown);
            Assert.Equal(item.Record.Source.RevisionIdentity, item.CurrentArticle!.RevisionIdentity);
            Assert.Equal(item.Record.Source.ContentDigest, item.CurrentArticle.ContentDigest);
        });
        Assert.Equal(1, fixture.Metadata.MaximumConcurrentReads);
        Assert.True(fixture.Metadata.Reads <= (count + 1) * 2);
        Assert.Contains(Article(1), fixture.Relations.ArticleReads);
        Assert.True(plan.RequiresTargetInventoryAndMarkerAdmission);
        Assert.True(plan.RequiresCanonicalTransactionAdmission);
        Assert.False(plan.HasCurrentBlocks);
    }

    [Fact]
    public async Task HistoricalAndCurrentSameRevisionRemainSeparateAndHistoryIsNeverRewritten()
    {
        Fixture fixture = await Fixture.CreateAsync(1, history: true);
        ArticleBlockAnchorImpactPlan plan = (await fixture.Planner.FreezeAsync(fixture.Request)).Plan!;
        Assert.Equal(2, plan.Items.Length);
        ArticleBlockAnchorImpactItem history = Assert.Single(plan.Items, item => item.Disposition == ArticleBlockAnchorImpactDisposition.ImmutableHistory);
        Assert.Equal(history.BeforeMarkdown, history.AfterMarkdown);
        Assert.Null(history.CurrentArticle);
        Assert.Equal(ArticleRelationRevisionKind.Published, history.Record.Source.RevisionKind);
        Assert.True(plan.RequiresHistoricalPermissionAdmission);
        Assert.Equal(ArticleBlockAnchorImpactDisposition.RenameCurrentLink,
            Assert.Single(plan.Items, item => item.CurrentArticle is not null).Disposition);
    }

    [Fact]
    public async Task HistoricalOnlyReferencesRequireCurrentReadAndSeparateHistoricalAdmission()
    {
        Fixture fixture = await Fixture.CreateAsync(1, history: true, historyOnly: true);
        ArticleBlockAnchorImpactPlan plan = (await fixture.Planner.FreezeAsync(fixture.Request)).Plan!;
        Assert.Equal(ArticleBlockAnchorImpactDisposition.ImmutableHistory, Assert.Single(plan.Items).Disposition);
        Assert.True(plan.RequiresHistoricalPermissionAdmission);
        Assert.Contains(Article(2), plan.CurrentArticles.Keys);
        fixture.Metadata.Articles.Remove(Article(2));
        AssertUnavailable(await fixture.Planner.FreezeAsync(fixture.Request));
    }

    [Fact]
    public async Task DraftReferencesRetainActualDraftRevisionAndReadOnlyItemsBlockWholeExecution()
    {
        Fixture fixture = await Fixture.CreateAsync(1, draft: true);
        fixture.Metadata.Articles[Article(1)] = fixture.Metadata.Articles[Article(1)] with
        {
            EditPermission = ArticleRelationPermissionState.Allowed
        };
        fixture.Metadata.Articles[Article(2)] = fixture.Metadata.Articles[Article(2)] with
        {
            EditPermission = ArticleRelationPermissionState.Denied
        };
        ArticleBlockAnchorImpactPlan plan = (await fixture.Planner.FreezeAsync(fixture.Request)).Plan!;
        ArticleBlockAnchorImpactItem item = Assert.Single(plan.Items);
        Assert.Equal(ArticleRelationRevisionKind.Draft, item.Record.Source.RevisionKind);
        Assert.Equal(ArticleBlockAnchorImpactDisposition.BlockedCurrentEdit, item.Disposition);
        Assert.Equal(item.BeforeMarkdown, item.AfterMarkdown);
        Assert.True(plan.HasCurrentBlocks);
    }

    [Theory]
    [InlineData(ArticleBlockAnchorRemovalChoice.RequireNoCurrentReferences, ArticleBlockAnchorImpactDisposition.BlockedRemovalReferences)]
    [InlineData(ArticleBlockAnchorRemovalChoice.LeaveBrokenExplicitly, ArticleBlockAnchorImpactDisposition.KeepBrokenExplicitly)]
    public async Task RemovalChoiceIsExplicitAndNeverCleansIncomingLinksAutomatically(
        ArticleBlockAnchorRemovalChoice choice, ArticleBlockAnchorImpactDisposition expected)
    {
        Fixture fixture = await Fixture.CreateAsync(1);
        ArticleBlockAnchorImpactRequest request = fixture.Request with
        {
            Operation = ArticleBlockAnchorImpactOperation.Remove,
            NewAnchor = null,
            RemovalChoice = choice
        };
        ArticleBlockAnchorImpactPlan plan = (await fixture.Planner.FreezeAsync(request)).Plan!;
        ArticleBlockAnchorImpactItem item = Assert.Single(plan.Items);
        Assert.Equal(expected, item.Disposition);
        Assert.Equal(item.BeforeMarkdown, item.AfterMarkdown);
        Assert.True(plan.RequiresTargetInventoryAndMarkerAdmission);
        Assert.True(plan.RequiresCanonicalTransactionAdmission);
    }

    [Fact]
    public async Task CancelledRemovalNeverReadsPrivateTargetOrIndex()
    {
        Fixture fixture = await Fixture.CreateAsync(1);
        ArticleBlockAnchorImpactResult result = await fixture.Planner.FreezeAsync(fixture.Request with
        {
            Operation = ArticleBlockAnchorImpactOperation.Remove,
            NewAnchor = null,
            RemovalChoice = ArticleBlockAnchorRemovalChoice.Cancel
        });
        Assert.Equal(ArticleBlockAnchorImpactStatus.Cancelled, result.Status);
        Assert.Null(result.Plan);
        Assert.Equal(0, fixture.Metadata.Reads);
        Assert.Equal(0, fixture.Metadata.Observations);
    }

    [Theory]
    [InlineData(ArticleRelationLifecycleState.Archived)]
    [InlineData(ArticleRelationLifecycleState.Deleted)]
    public async Task CurrentNonEditableLifecycleRemainsBlockedWithoutDroppingReference(ArticleRelationLifecycleState lifecycle)
    {
        Fixture fixture = await Fixture.CreateAsync(1, currentLifecycle: lifecycle);
        ArticleBlockAnchorImpactPlan plan = (await fixture.Planner.FreezeAsync(fixture.Request)).Plan!;
        ArticleBlockAnchorImpactItem item = Assert.Single(plan.Items);
        Assert.Equal(ArticleBlockAnchorImpactDisposition.BlockedCurrentLifecycle, item.Disposition);
        Assert.Equal(item.BeforeMarkdown, item.AfterMarkdown);
        Assert.True(plan.HasCurrentBlocks);
    }

    [Theory]
    [InlineData("permission")]
    [InlineData("query")]
    [InlineData("index")]
    [InlineData("route")]
    [InlineData("actor")]
    [InlineData("site")]
    [InlineData("digest")]
    [InlineData("source-generation")]
    [InlineData("index-generation")]
    [InlineData("scope")]
    public async Task AnyIndependentObservationDriftBeforeOrAfterReadRefusesEveryItem(string fault)
    {
        foreach (int stage in new[] { 1, 2 })
        {
            Fixture fixture = await Fixture.CreateAsync(1);
            fixture.Metadata.BeforeObservation = call =>
            {
                if (call == stage)
                {
                    fixture.Metadata.Observation = Changed(fixture.Metadata.Observation, fault);
                }
            };
            AssertUnavailable(await fixture.Planner.FreezeAsync(fixture.Request));
        }
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("denied")]
    [InlineData("revision")]
    [InlineData("content")]
    [InlineData("binding")]
    public async Task MissingDeniedOrDriftingRequiredSourceNeverProducesPartialPlan(string fault)
    {
        Fixture fixture = await Fixture.CreateAsync(2);
        fixture.Metadata.BeforeRead = (identity, _) =>
        {
            if (identity != Article(2))
            {
                return;
            }
            if (fault == "missing")
            {
                fixture.Metadata.Articles.Remove(identity);
                return;
            }
            fixture.Metadata.Articles[identity] = fixture.Metadata.Articles[identity] with
            {
                Permission = fault == "denied" ? ArticleRelationPermissionState.Denied : ArticleRelationPermissionState.Allowed,
                RevisionNumber = fault == "revision" ? 2 : 1,
                ContentDigest = fault == "content" ? OtherDigest : Digest,
                ArticleIdentity = fault == "binding" ? Article(999) : identity
            };
        };
        AssertUnavailable(await fixture.Planner.FreezeAsync(fixture.Request));
    }

    [Fact]
    public async Task PermissionDriftDuringOriginalIndexRevalidationStalesAllItems()
    {
        Fixture fixture = await Fixture.CreateAsync(1);
        fixture.Relations.BeforeArticleRead = _ => fixture.Metadata.Articles[Article(2)] = fixture.Metadata.Articles[Article(2)] with
        {
            EditPermission = ArticleRelationPermissionState.Denied
        };
        AssertUnavailable(await fixture.Planner.FreezeAsync(fixture.Request));
    }

    [Fact]
    public async Task EmptyImpactStillRevalidatesOriginalTargetFamily()
    {
        Fixture fixture = await Fixture.CreateAsync(0);
        fixture.Relations.BeforeArticleRead = id => fixture.Relations.Articles[id] = fixture.Relations.Articles[id] with
        {
            SourceSequence = 2
        };
        AssertUnavailable(await fixture.Planner.FreezeAsync(fixture.Request));
        Assert.Contains(Article(1), fixture.Relations.ArticleReads);
    }

    [Fact]
    public async Task IndependentPrepareRevalidationDetectsChangedPermissionsAndDoesNotUpdateFrozenPlan()
    {
        Fixture fixture = await Fixture.CreateAsync(1);
        ArticleBlockAnchorImpactPlan plan = (await fixture.Planner.FreezeAsync(fixture.Request)).Plan!;
        Assert.True(await fixture.Planner.RevalidateAsync(plan));
        string digest = plan.OperationDigest;
        fixture.Metadata.Articles[Article(2)] = fixture.Metadata.Articles[Article(2)] with
        {
            EditPermission = ArticleRelationPermissionState.Denied
        };
        Assert.False(await fixture.Planner.RevalidateAsync(plan));
        Assert.Equal(digest, plan.OperationDigest);
        Assert.Equal(ArticleBlockAnchorImpactDisposition.RenameCurrentLink, Assert.Single(plan.Items).Disposition);
    }

    [Fact]
    public async Task OperationFingerprintBindsRequestAndExactNewAnchor()
    {
        Fixture fixture = await Fixture.CreateAsync(1);
        ArticleBlockAnchorImpactPlan first = (await fixture.Planner.FreezeAsync(fixture.Request)).Plan!;
        ArticleBlockAnchorImpactPlan second = (await fixture.Planner.FreezeAsync(fixture.Request with
        {
            RequestId = "request:another"
        })).Plan!;
        ArticleBlockAnchorImpactPlan third = (await fixture.Planner.FreezeAsync(fixture.Request with
        {
            NewAnchor = BlockAnchorId.Create("another-id")
        })).Plan!;
        Assert.NotEqual(first.OperationDigest, second.OperationDigest);
        Assert.NotEqual(first.OperationDigest, third.OperationDigest);
    }

    [Fact]
    public async Task IndependentVerifierRejectsAlteredMutationRecordAndInspectionEvenWithOriginalDigest()
    {
        Fixture fixture = await Fixture.CreateAsync(1);
        ArticleBlockAnchorImpactPlan plan = (await fixture.Planner.FreezeAsync(fixture.Request)).Plan!;
        ArticleBlockAnchorImpactItem item = Assert.Single(plan.Items);
        ArticleBlockAnchorImpactItem[] tampered =
        [
            item with { AfterMarkdown = "unrelated source replacement" },
            item with { Range = item.Range with { MatchedText = "forged" } },
            item with { Record = item.Record with { Source = item.Record.Source with { ContentDigest = OtherDigest } } }
        ];
        foreach (ArticleBlockAnchorImpactItem changed in tampered)
        {
            var forged = new ArticleBlockAnchorImpactPlan(plan.Request, plan.Inspection, [changed], plan.CurrentArticles, plan.OperationDigest);
            Assert.False(await fixture.Planner.RevalidateAsync(forged));
        }
        var inspection = new ArticleBlockAnchorImpactPlan(plan.Request, plan.Inspection with
        {
            Records = []
        }, plan.Items,
            plan.CurrentArticles, plan.OperationDigest);
        Assert.False(await fixture.Planner.RevalidateAsync(inspection));
    }

    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    public async Task FirstLastAggregateMustAccountForEverySourceOccurrence(int count)
    {
        Fixture fixture = await Fixture.CreateAsync(1, occurrences: count);
        ArticleBlockAnchorImpactResult result = await fixture.Planner.FreezeAsync(fixture.Request);
        if (count == 3)
        {
            AssertUnavailable(result);
        }
        else
        {
            Assert.Equal(count, result.Plan!.Items.Length);
            Assert.Equal(count, result.Plan.Items.Select(item => item.Range.Start).Distinct().Count());
        }
    }

    [Theory]
    [InlineData("not standard Markdown")]
    [InlineData("[text](/posts/old-route#different-id)")]
    [InlineData("[text](/posts/%6Fld-route#old-id)")]
    public async Task UnsupportedOrNonExactLiteralsCannotBecomeMutations(string literal)
    {
        Fixture fixture = await Fixture.CreateAsync(1, literal: literal);
        AssertUnavailable(await fixture.Planner.FreezeAsync(fixture.Request));
    }

    [Fact]
    public async Task SourceGenerationDriftCancellationAndPrivateExceptionAreContentFree()
    {
        Fixture fixture = await Fixture.CreateAsync(1);
        fixture.Relations.BeforeArticleRead = _ => fixture.Relations.Generation = 2;
        AssertUnavailable(await fixture.Planner.FreezeAsync(fixture.Request));
        Fixture failed = await Fixture.CreateAsync(1);
        failed.Metadata.BeforeRead = (_, _) => throw new InvalidOperationException("private article title and source body");
        AssertUnavailable(await failed.Planner.FreezeAsync(failed.Request));
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        Fixture cancelled = await Fixture.CreateAsync(1);
        ArticleBlockAnchorImpactResult result = await cancelled.Planner.FreezeAsync(cancelled.Request, cancellation.Token);
        Assert.Equal(ArticleBlockAnchorImpactStatus.Cancelled, result.Status);
        Assert.Null(result.Plan);
    }

    [Fact]
    public async Task InvalidAnchorAndUnchangedRenameAreRejectedBeforeSourceReads()
    {
        Fixture fixture = await Fixture.CreateAsync(1);
        await Assert.ThrowsAsync<ArticleRelationIndexException>(() => fixture.Planner.FreezeAsync(fixture.Request with { NewAnchor = default(BlockAnchorId) }));
        await Assert.ThrowsAsync<ArticleRelationIndexException>(() => fixture.Planner.FreezeAsync(fixture.Request with { NewAnchor = s_old }));
        Assert.Equal(0, fixture.Metadata.Reads);
    }

    private static void AssertUnavailable(ArticleBlockAnchorImpactResult result)
    {
        Assert.Equal(ArticleBlockAnchorImpactStatus.Unavailable, result.Status);
        Assert.Null(result.Plan);
    }

    private static string Article(int id) => $"article:20000000-0000-4000-8000-{id:x12}";
    private static string Revision(int id) => $"revision:30000000-0000-4000-8000-{id:x12}";

    private static ArticleBlockTargetQueryObservation Changed(ArticleBlockTargetQueryObservation observation, string fault)
        => observation with
        {
            SourceGeneration = fault == "source-generation" ? 2 : observation.SourceGeneration,
            IndexGeneration = fault == "index-generation" ? 2 : observation.IndexGeneration,
            Scope = fault == "scope" ? BlockTargetQueryScope.CurrentPublicPublication : observation.Scope,
            Coordinate = observation.Coordinate with
            {
                PermissionRevision = fault == "permission" ? 8 : observation.Coordinate.PermissionRevision,
                QueryRevision = fault == "query" ? 12 : observation.Coordinate.QueryRevision,
                IndexRevision = fault == "index" ? 14 : observation.Coordinate.IndexRevision,
                RouteRevision = fault == "route" ? 18 : observation.Coordinate.RouteRevision,
                ActorIdentity = fault == "actor" ? "actor:other" : observation.Coordinate.ActorIdentity,
                SiteIdentity = fault == "site" ? "site:other" : observation.Coordinate.SiteIdentity,
                PermissionContextDigest = fault == "digest" ? OtherDigest : observation.Coordinate.PermissionContextDigest
            }
        };

    private sealed class MetadataSource : IArticleBlockTargetQuerySource
    {
        public Dictionary<string, BlockTargetArticleCoordinate> Articles { get; } = new(StringComparer.Ordinal);
        public ArticleBlockTargetQueryObservation Observation
        {
            get; set;
        } = new(
            new(s_actor.ActorIdentity, s_actor.SiteIdentity, s_actor.PermissionContextDigest, 7, 11, 13, 17,
                BlockAnchorSchemas.Version, BlockAnchorSchemas.ContractDigest), BlockTargetQueryScope.AuthoringCurrent, 1, 1);
        public Action<int>? BeforeObservation
        {
            get; set;
        }
        public Action<string, int>? BeforeRead
        {
            get; set;
        }
        public int Observations
        {
            get; set;
        }
        public int Reads
        {
            get; set;
        }
        public int MaximumConcurrentReads
        {
            get; set;
        }
        private int _activeReads;

        public Task<ArticleBlockTargetQueryObservation?> ObserveAsync(ArticleRelationActorContext actor,
            BlockTargetQueryScope scope, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            BeforeObservation?.Invoke(++Observations);
            return Task.FromResult<ArticleBlockTargetQueryObservation?>(Observation);
        }

        public async Task<ArticleBlockTargetQueryArticleRead> ReadArticleAsync(ArticleBlockTargetQueryObservation observation,
            string articleIdentity, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            MaximumConcurrentReads = Math.Max(MaximumConcurrentReads, ++_activeReads);
            try
            {
                BeforeRead?.Invoke(articleIdentity, ++Reads);
                await Task.Yield();
                Articles.TryGetValue(articleIdentity, out BlockTargetArticleCoordinate? article);
                return new(observation, article is null ? null : new(article, "authorized metadata", 1));
            }
            finally
            {
                _activeReads--;
            }
        }

        public Task<ArticleBlockTargetQueryArticleBatch> ReadArticlesAsync(ArticleBlockTargetQueryObservation observation,
            string search, string? afterArticleIdentity, int pageSize, CancellationToken cancellationToken)
            => throw new NotSupportedException("Impact never searches the corpus");

        public Task<ArticleBlockTargetQueryHeadingBatch> ReadHeadingsAsync(ArticleBlockTargetQueryObservation observation,
            BlockTargetArticleCoordinate article, string search, string? afterHeadingIdentity, int pageSize, CancellationToken cancellationToken)
            => throw new NotSupportedException("Impact never scans heading inventory");
    }

    private sealed class RelationSource : IArticleRelationIndexSource
    {
        public SortedDictionary<string, ArticleRelationIndexArticle> Articles { get; } = new(StringComparer.Ordinal);
        public long Generation { get; set; } = 1;
        public List<string> ArticleReads { get; } = [];
        public Action<string>? BeforeArticleRead
        {
            get; set;
        }

        public Task<ArticleRelationIndexSourcePage> ReadAsync(ArticleRelationActorContext actor, string? afterArticleIdentity,
            int pageSize, long? expectedSourceGeneration, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            ArticleRelationIndexArticle[] candidates = Articles.Values.Where(article => afterArticleIdentity is null
                || StringComparer.Ordinal.Compare(article.ArticleIdentity, afterArticleIdentity) > 0).Take(pageSize + 1).ToArray();
            return Task.FromResult(new ArticleRelationIndexSourcePage(actor, Generation, [.. candidates.Take(pageSize)], candidates.Length > pageSize));
        }

        public Task<ArticleRelationIndexArticleRead> ReadArticleAsync(ArticleRelationActorContext actor, string articleIdentity,
            long? expectedSourceGeneration, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            ArticleReads.Add(articleIdentity);
            BeforeArticleRead?.Invoke(articleIdentity);
            return Task.FromResult(new ArticleRelationIndexArticleRead(actor, Generation, Articles[articleIdentity]));
        }
    }

    private sealed record Fixture(MetadataSource Metadata, RelationSource Relations, ArticleRelationIndex Index,
        ArticleBlockAnchorImpactPlanner Planner, ArticleBlockAnchorImpactRequest Request)
    {
        public static async Task<Fixture> CreateAsync(int count, bool history = false, bool draft = false, bool historyOnly = false,
            int occurrences = 1, string literal = "[引用](/posts/old-route#old-id)", ArticleRelationLifecycleState? currentLifecycle = null)
        {
            var metadata = new MetadataSource();
            var relations = new RelationSource();
            // At scale, target self-reference keeps the complete index within its original10,000 article bound.
            int[] ids = count == 10_000 ? Enumerable.Range(1, count).ToArray() : Enumerable.Range(2, count).ToArray();
            var referenced = ids.ToHashSet();
            foreach (int id in ids.Append(1).Distinct().Order())
            {
                ArticleRelationRevisionKind kind = draft && id != 1 ? ArticleRelationRevisionKind.Draft : ArticleRelationRevisionKind.Current;
                ArticleRelationLifecycleState lifecycle = kind == ArticleRelationRevisionKind.Draft
                    ? ArticleRelationLifecycleState.Draft : ArticleRelationLifecycleState.Published;
                if (id != 1 && currentLifecycle.HasValue)
                {
                    lifecycle = currentLifecycle.Value;
                }
                var article = new BlockTargetArticleCoordinate(Article(id), Revision(id), 1, kind, lifecycle,
                    ArticleRelationPermissionState.Allowed, ArticleRelationPermissionState.Allowed, Digest, id == 1 ? "current-route" : $"source-{id}");
                metadata.Articles.Add(article.ArticleIdentity, article);
                var source = new ArticleRelationSourceFacts(article.ArticleIdentity, article.RevisionIdentity, 1, kind, lifecycle,
                    ArticleRelationPermissionState.Allowed, s_actor, Digest);
                ArticleRelationRecord[] records = referenced.Contains(id) && !historyOnly ? [Record(source, literal, occurrences)] : [];
                var sets = new List<ArticleRelationSet> { Set(source, records) };
                if (history && id != 1)
                {
                    ArticleRelationSourceFacts published = source with
                    {
                        RevisionKind = ArticleRelationRevisionKind.Published,
                        Lifecycle = ArticleRelationLifecycleState.Published
                    };
                    sets.Add(Set(published, [Record(published, literal, occurrences)]));
                }
                relations.Articles.Add(article.ArticleIdentity, new(article.ArticleIdentity, 1, [.. sets]));
            }
            var index = new ArticleRelationIndex(relations, s_actor);
            await index.RebuildAsync(0);
            var request = new ArticleBlockAnchorImpactRequest("request:impact", ArticleBlockAnchorImpactOperation.Rename,
                metadata.Articles[Article(1)], s_old, s_new, ArticleBlockAnchorRemovalChoice.RequireNoCurrentReferences, metadata.Observation);
            return new(metadata, relations, index, new(index, metadata), request);
        }

        private static ArticleRelationRecord Record(ArticleRelationSourceFacts source, string literal, int occurrences)
        {
            var first = new ArticleRelationSourceRange(1, 1 + literal.Length, literal);
            int lastStart = 1 + (literal.Length + 1) * (occurrences - 1);
            var last = new ArticleRelationSourceRange(lastStart, lastStart + literal.Length, literal);
            return ArticleRelationContractValidator.Seal(new ArticleRelationRecord(ArticleRelationSchemas.Relation, 1, string.Empty, 1,
                ArticleRelationKind.Outgoing, source, new(literal, first, last, occurrences),
                new(new(Article(1), ArticleRelationTargetKind.Block, null, s_old.Value), Revision(1), 1,
                    ArticleRelationRevisionKind.Current, ArticleRelationLifecycleState.Published, ArticleRelationPermissionState.Allowed),
                new(s_actor, s_actor, ArticleRelationQueryScope.Authoring, ArticleRelationPublicContext.AuthoringActor, Digest),
                ArticleRelationResolutionStatus.Resolved, new(1, 1, 1, 1, 1), string.Empty));
        }

        private static ArticleRelationSet Set(ArticleRelationSourceFacts source, IReadOnlyList<ArticleRelationRecord> records)
            => ArticleRelationContractValidator.Seal(new ArticleRelationSet(ArticleRelationSchemas.RelationSet, 1, source, records, string.Empty));
    }
}
