using System.Collections.Immutable;

using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleRelations;
using FsusBlog.Shared.Contracts.BlockLinks;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Real producer/index algorithm controls using explicit parsed-fact fixtures, not production parser or permission receipts.</summary>
[Trait("Category", "Unit")]
public sealed class ArticleBlockRelationProducerTests
{
    private const string SourceArticle = "article:20000000-0000-4000-8000-000000000001";
    private const string TargetArticle = "article:20000000-0000-4000-8000-000000000002";
    private static readonly string s_digest = new('a', 64);
    private static readonly ArticleRelationActorContext s_actor = new("actor:producer", "site:primary", s_digest);

    [Fact]
    public async Task Produce_UsesExistingCodecAndFeedsTheActualIndex()
    {
        ArticleBlockRelationProductionInput input = Input();
        ArticleBlockRelationProduction production = ArticleBlockRelationProducer.Produce(input);
        Assert.True(production.Produced, production.ReasonCode);
        Assert.True(ArticleRelationContractValidator.Validate(production.Set).IsValid);
        ArticleRelationRecord record = Assert.Single(production.Set!.Relations);
        Assert.Equal(input.Links[0].SourceRange, record.Occurrence.First);
        Assert.Equal(input.Links[0].SourceRange.MatchedText, record.Occurrence.LinkText);
        Assert.Equal(TargetArticle, record.Target.TargetIdentity!.ArticleIdentity);
        Assert.Equal("anchor-a", record.Target.TargetIdentity.BlockAnchorIdentity);
        Assert.Equal(ArticleRelationKind.Outgoing, record.Kind);
        Assert.Equal(ArticleRelationResolutionStatus.Resolved, record.Resolution);
        var source = new ProducerSource(input);
        var index = new ArticleRelationIndex(new ArticleBlockRelationIndexSource(source), s_actor);
        await index.RebuildAsync(0);
        ArticleRelationIndexInspection inspection = index.InspectTarget(record.Target.TargetIdentity, 1);
        Assert.Equal(record.RecordDigest, Assert.Single(inspection.Records).RecordDigest);
        await index.RevalidateSourceAsync(inspection);
    }

    [Theory]
    [InlineData("anchor-missing", ArticleRelationResolutionStatus.MissingAnchor, ArticleRelationKind.Broken)]
    [InlineData("denied", ArticleRelationResolutionStatus.Unauthorized, ArticleRelationKind.Broken)]
    [InlineData("archived", ArticleRelationResolutionStatus.Archived, ArticleRelationKind.Broken)]
    [InlineData("deleted", ArticleRelationResolutionStatus.Deleted, ArticleRelationKind.Broken)]
    [InlineData("draft", ArticleRelationResolutionStatus.Draft, ArticleRelationKind.VisibilityRisk)]
    [InlineData("scheduled", ArticleRelationResolutionStatus.Private, ArticleRelationKind.VisibilityRisk)]
    [InlineData("slug", ArticleRelationResolutionStatus.Stale, ArticleRelationKind.Broken)]
    public void Produce_ResolvesCanonicalLifecycleAndRouteFactsWithoutRewritingSource(
        string fault, ArticleRelationResolutionStatus expectedStatus, ArticleRelationKind expectedKind)
    {
        ArticleBlockRelationProductionInput input = Input();
        ArticleBlockRelationTargetInventory target = input.Targets[0];
        target = fault switch
        {
            "anchor-missing" => target with { Anchors = [] },
            "denied" => target with
            {
                ArticleFacts = target.ArticleFacts with
                {
                    Permission = ArticleRelationPermissionState.Denied
                },
                Anchors = [],
                CanonicalSlug = null
            },
            "archived" => target with { ArticleFacts = target.ArticleFacts with { Lifecycle = ArticleRelationLifecycleState.Archived } },
            "deleted" => target with { ArticleFacts = target.ArticleFacts with { Lifecycle = ArticleRelationLifecycleState.Deleted } },
            "draft" => target with { ArticleFacts = target.ArticleFacts with { RevisionKind = ArticleRelationRevisionKind.Draft, Lifecycle = ArticleRelationLifecycleState.Draft } },
            "scheduled" => target with { ArticleFacts = target.ArticleFacts with { Lifecycle = ArticleRelationLifecycleState.Scheduled } },
            _ => target with { CanonicalSlug = "new-route" }
        };
        ArticleBlockRelationProduction production = ArticleBlockRelationProducer.Produce(input with
        {
            Targets = [target]
        });
        Assert.True(production.Produced, production.ReasonCode);
        ArticleRelationRecord record = Assert.Single(production.Set!.Relations);
        Assert.Equal(expectedStatus, record.Resolution);
        Assert.Equal(expectedKind, record.Kind);
        Assert.Equal("anchor-a", record.Target.TargetIdentity!.BlockAnchorIdentity);
        Assert.Equal(input.Links[0].SourceRange.MatchedText, record.Occurrence.LinkText);
    }

    [Theory]
    [InlineData("source-denied")]
    [InlineData("source-unknown")]
    [InlineData("actor")]
    [InlineData("site")]
    [InlineData("source-digest")]
    [InlineData("generation")]
    [InlineData("contract")]
    [InlineData("transclusion")]
    [InlineData("range")]
    [InlineData("literal")]
    [InlineData("anchor-mismatch")]
    [InlineData("duplicate-anchor")]
    [InlineData("invalid-anchor")]
    [InlineData("duplicate-target")]
    [InlineData("missing-target")]
    [InlineData("unknown-target")]
    [InlineData("denied-content")]
    public void Produce_RefusesDriftDenialAndAmbiguityWithoutPartialSet(string fault)
    {
        ArticleBlockRelationProductionInput input = Input();
        ArticleBlockRelationParsedLink link = input.Links[0];
        ArticleBlockRelationTargetInventory target = input.Targets[0];
        input = fault switch
        {
            "source-denied" => input with { Source = input.Source with { Permission = ArticleRelationPermissionState.Denied } },
            "source-unknown" => input with { Source = input.Source with { Permission = ArticleRelationPermissionState.Unknown } },
            "actor" => input with { Targets = [target with { Actor = s_actor with { ActorIdentity = "actor:other" } }] },
            "site" => input with { Visibility = input.Visibility with { QueryActor = s_actor with { SiteIdentity = "site:other" } } },
            "source-digest" => input with { ParsedSourceDigest = new string('b', 64) },
            "generation" => input with { Targets = [target with { SourceGeneration = 2 }] },
            "contract" => input with { AnchorContractDigest = new string('b', 64) },
            "transclusion" => input with { Links = [link with { Kind = ArticleBlockRelationParsedKind.Transclusion }] },
            "range" => input with { SourceUtf16Length = 1 },
            "literal" => input with { Links = [link with { SourceRange = new(0, 10, "[[legacy]]") }] },
            "anchor-mismatch" => input with { Links = [link with { Target = link.Target with { AnchorId = BlockAnchorId.Create("other-anchor") } }] },
            "duplicate-anchor" => input with { Targets = [target with { Anchors = [target.Anchors[0], target.Anchors[0]] }] },
            "invalid-anchor" => input with { Targets = [target with { Anchors = [default] }] },
            "duplicate-target" => input with { Targets = [target, target] },
            "missing-target" => input with { Targets = [] },
            "unknown-target" => input with { Targets = [target with { ArticleFacts = target.ArticleFacts with { Permission = ArticleRelationPermissionState.Unknown }, CanonicalSlug = null, Anchors = [] }] },
            _ => input with { Targets = [target with { ArticleFacts = target.ArticleFacts with { Permission = ArticleRelationPermissionState.Denied } }] }
        };
        ArticleBlockRelationProduction production = ArticleBlockRelationProducer.Produce(input);
        Assert.False(production.Produced);
        Assert.Null(production.Set);
        Assert.False(string.IsNullOrWhiteSpace(production.ReasonCode));
        Assert.DoesNotContain(TargetArticle, production.ReasonCode!);
    }

    [Theory]
    [InlineData(BlockTargetInventoryDiagnostic.Duplicate)]
    [InlineData(BlockTargetInventoryDiagnostic.Invalid)]
    [InlineData(BlockTargetInventoryDiagnostic.Malformed)]
    [InlineData(BlockTargetInventoryDiagnostic.Orphan)]
    public async Task RefusedProduction_CannotPartiallyReplaceCommittedIndex(BlockTargetInventoryDiagnostic diagnostic)
    {
        ArticleBlockRelationProductionInput input = Input();
        var source = new ProducerSource(input);
        var index = new ArticleRelationIndex(new ArticleBlockRelationIndexSource(source), s_actor);
        ArticleRelationIndexSnapshot original = await index.RebuildAsync(0);
        source.Input = input with
        {
            SourceGeneration = 2,
            Targets = [input.Targets[0] with { SourceGeneration = 2, Diagnostic = diagnostic }]
        };
        await Assert.ThrowsAsync<ArticleRelationIndexException>(() => index.ApplyAsync(SourceArticle, 1));
        Assert.Same(original, index.ReadSnapshot(1));
        await Assert.ThrowsAsync<ArticleRelationIndexException>(() => index.RevalidateSourceAsync(
            index.InspectTarget(new(TargetArticle, ArticleRelationTargetKind.Block, null, "anchor-a"), 1)));
    }

    [Fact]
    public void EmptyParseAndDuplicateOrOverlappingNodesAreHandledExactly()
    {
        ArticleBlockRelationProductionInput input = Input();
        Assert.Empty(ArticleBlockRelationProducer.Produce(input with
        {
            Links = [],
            Targets = [],
            SourceUtf16Length = 0
        }).Set!.Relations);
        ArticleBlockRelationParsedLink first = input.Links[0];
        ArticleBlockRelationParsedLink second = first with
        {
            NodeIdentity = "node:second"
        };
        Assert.Null(ArticleBlockRelationProducer.Produce(input with
        {
            Links = [first, second]
        }).Set);
        int length = first.SourceRange.MatchedText.Length;
        second = first with
        {
            SourceRange = new(length, length * 2, first.SourceRange.MatchedText)
        };
        Assert.Null(ArticleBlockRelationProducer.Produce(input with
        {
            Links = [first, second],
            SourceUtf16Length = length * 2
        }).Set);
        second = second with
        {
            NodeIdentity = "node:second"
        };
        ArticleRelationSet set = ArticleBlockRelationProducer.Produce(input with
        {
            Links = [first, second],
            SourceUtf16Length = length * 2
        }).Set!;
        Assert.Equal(2, set.Relations.Count);
        Assert.Equal(set.SetDigest, ArticleBlockRelationProducer.Produce(input with
        {
            Links = [second, first],
            SourceUtf16Length = length * 2
        }).Set!.SetDigest);
    }

    [Fact]
    public async Task ConcurrentProducedRebuilds_OnlyOneGenerationCommitsAndCancellationDoesNotCommit()
    {
        var source = new ProducerSource(Input());
        var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        int arrivals = 0;
        source.BeforePage = async () =>
        {
            if (Interlocked.Increment(ref arrivals) == 2)
            {
                gate.SetResult();
            }
            await gate.Task.WaitAsync(TimeSpan.FromSeconds(10));
        };
        var index = new ArticleRelationIndex(new ArticleBlockRelationIndexSource(source), s_actor);
        async Task<bool> Build()
        {
            try
            {
                await index.RebuildAsync(0);
                return true;
            }
            catch (ArticleRelationIndexException failure)
            {
                Assert.Equal("article_relation_index_generation_stale", failure.ReasonCode);
                return false;
            }
        }
        bool[] outcomes = await Task.WhenAll(Build(), Build());
        Assert.Single(outcomes, static value => value);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        Assert.ThrowsAny<OperationCanceledException>(() => ArticleBlockRelationProducer.Produce(Input(), cancellation.Token));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => index.RebuildAsync(1, cancellation.Token));
        Assert.Equal(1, index.ReadSnapshot(1).IndexGeneration);
    }

    [Fact]
    public void PublicScope_RequiresCurrentPublicSourceAndPublishedAllowedTarget()
    {
        ArticleBlockRelationProductionInput input = Input();
        ArticleRelationActorContext actor = s_actor with
        {
            ActorIdentity = "public:anonymous"
        };
        input = input with
        {
            Visibility = input.Visibility with
            {
                QueryActor = actor,
                QueryScope = ArticleRelationQueryScope.CurrentPublicPublication,
                PublicContext = ArticleRelationPublicContext.AnonymousPublic
            },
            Targets = [input.Targets[0] with { Actor = actor, ArticleFacts = input.Targets[0].ArticleFacts with { RevisionKind = ArticleRelationRevisionKind.Published } }]
        };
        Assert.True(ArticleBlockRelationProducer.Produce(input).Produced);
        Assert.Null(ArticleBlockRelationProducer.Produce(input with
        {
            Source = input.Source with
            {
                RevisionKind = ArticleRelationRevisionKind.Draft,
                Lifecycle = ArticleRelationLifecycleState.Draft
            }
        }).Set);
        Assert.Null(ArticleBlockRelationProducer.Produce(input with
        {
            Targets = [input.Targets[0] with
            {
                ArticleFacts = input.Targets[0].ArticleFacts with { Permission = ArticleRelationPermissionState.Denied },
                Anchors = [], CanonicalSlug = null
            }]
        }).Set);
    }

    [Theory]
    [InlineData(1, 100_000)]
    [InlineData(10_000, 10)]
    public void Scale_ConsumesOneHundredThousandAnchorsAtBoundedTargetAndLinkLimits(int targetCount, int anchorsPerTarget)
    {
        ArticleBlockRelationProductionInput input = Input();
        var targets = ImmutableArray.CreateBuilder<ArticleBlockRelationTargetInventory>();
        var links = ImmutableArray.CreateBuilder<ArticleBlockRelationParsedLink>();
        int position = 0;
        for (int targetIndex = 1; targetIndex <= targetCount; targetIndex++)
        {
            string identity = $"article:20000000-0000-4000-8000-{targetIndex + 100000:x12}";
            ImmutableArray<BlockAnchorId> anchors = [.. Enumerable.Range(0, anchorsPerTarget).Select(id => BlockAnchorId.Create($"anchor-{id}"))];
            targets.Add(input.Targets[0] with
            {
                ArticleFacts = input.Targets[0].ArticleFacts with
                {
                    TargetIdentity = new(identity, ArticleRelationTargetKind.Article, null, null)
                },
                Anchors = anchors
            });
            IEnumerable<BlockAnchorId> selected = targetCount == 1 ? anchors : anchors.Take(1);
            foreach (BlockAnchorId anchor in selected)
            {
                ArticleBlockTarget target = ArticleBlockTarget.Create(identity, anchor);
                string markdown = BlockAnchorMarkdownBuilder.Build("link", "post-a", target);
                links.Add(new($"node:{targetIndex}:{anchor.Value}", ArticleBlockRelationParsedKind.Link,
                    new(position, position + markdown.Length, markdown), target));
                position += markdown.Length;
            }
        }
        ArticleBlockRelationProduction production = ArticleBlockRelationProducer.Produce(input with
        {
            Links = links.ToImmutable(),
            Targets = targets.ToImmutable(),
            SourceUtf16Length = position
        });
        Assert.True(production.Produced, production.ReasonCode);
        Assert.Equal(links.Count, production.Set!.Relations.Count);
    }

    [Fact]
    public void Budget_RefusesOversizedNodesTargetsAndInventory()
    {
        ArticleBlockRelationProductionInput input = Input();
        Assert.Null(ArticleBlockRelationProducer.Produce(input with
        {
            Links = [.. Enumerable.Repeat(input.Links[0], ArticleBlockRelationProducer.MaxLinks + 1)]
        }).Set);
        Assert.Null(ArticleBlockRelationProducer.Produce(input with
        {
            Targets = [.. Enumerable.Repeat(input.Targets[0], ArticleBlockRelationProducer.MaxTargets + 1)]
        }).Set);
        Assert.Null(ArticleBlockRelationProducer.Produce(input with
        {
            Targets = [input.Targets[0] with { Anchors = [.. Enumerable.Repeat(input.Targets[0].Anchors[0], ArticleBlockRelationProducer.MaxAnchors + 1)] }]
        }).Set);
    }

    [Fact]
    public async Task ActualIndexSource_PreservesNonBlockFactsAndRefusesSecondBlockProducer()
    {
        ArticleBlockRelationProductionInput input = Input();
        ArticleRelationRecord block = Assert.Single(ArticleBlockRelationProducer.Produce(input).Set!.Relations);
        int start = input.SourceUtf16Length + 10;
        var range = new ArticleRelationSourceRange(start, start + 9, "[heading]");
        ArticleRelationRecord heading = ArticleRelationContractValidator.Seal(block with
        {
            Target = block.Target with
            {
                TargetIdentity = new(TargetArticle, ArticleRelationTargetKind.Heading, "heading:heading-a", null)
            },
            Occurrence = new(range.MatchedText, range, range, 1)
        });
        var source = new ProducerSource(input with
        {
            SourceUtf16Length = start + 9
        })
        {
            NonBlockSet = ArticleRelationContractValidator.Seal(new ArticleRelationSet(
                ArticleRelationSchemas.RelationSet, 1, input.Source, [heading], string.Empty))
        };
        var index = new ArticleRelationIndex(new ArticleBlockRelationIndexSource(source), s_actor);
        ArticleRelationIndexSnapshot snapshot = await index.RebuildAsync(0);
        Assert.Equal(2, snapshot.Articles[SourceArticle].Sets[0].Relations.Count);
        Assert.Equal(heading.RecordDigest, Assert.Single(index.InspectTarget(heading.Target.TargetIdentity!, 1).Records).RecordDigest);
        source.Input = source.Input with
        {
            SourceGeneration = 2,
            Targets = [source.Input.Targets[0] with { SourceGeneration = 2 }]
        };
        source.NonBlockSet = ArticleBlockRelationProducer.Produce(source.Input).Set;
        ArticleRelationIndexException failure = await Assert.ThrowsAsync<ArticleRelationIndexException>(() => index.ApplyAsync(SourceArticle, 1));
        Assert.Equal("article_block_relation_second_producer_refused", failure.ReasonCode);
        Assert.Same(snapshot, index.ReadSnapshot(1));
    }

    private static ArticleBlockRelationProductionInput Input()
    {
        ArticleBlockTarget target = ArticleBlockTarget.Create(TargetArticle, BlockAnchorId.Create("anchor-a"));
        string markdown = BlockAnchorMarkdownBuilder.Build("link 😀", "post-a", target);
        var source = new ArticleRelationSourceFacts(SourceArticle, "revision:30000000-0000-4000-8000-000000000001", 1,
            ArticleRelationRevisionKind.Current, ArticleRelationLifecycleState.Published, ArticleRelationPermissionState.Allowed, s_actor, s_digest);
        var inventory = new ArticleBlockRelationTargetInventory(s_actor, 1,
            new(new(TargetArticle, ArticleRelationTargetKind.Article, null, null), "revision:30000000-0000-4000-8000-000000000002", 1,
                ArticleRelationRevisionKind.Current, ArticleRelationLifecycleState.Published, ArticleRelationPermissionState.Allowed),
            s_digest, "post-a", [target.AnchorId], BlockTargetInventoryDiagnostic.None);
        return new(source, new(s_actor, s_actor, ArticleRelationQueryScope.Authoring, ArticleRelationPublicContext.AuthoringActor, s_digest),
            1, "fixture:original-parser-not-a-runtime-receipt", s_digest, markdown.Length, BlockAnchorSchemas.Version, BlockAnchorSchemas.ContractDigest,
            [new("node:link-a", ArticleBlockRelationParsedKind.Link, new(0, markdown.Length, markdown), target)], [inventory]);
    }

    private sealed class ProducerSource(ArticleBlockRelationProductionInput input) : IArticleBlockRelationParsedSource
    {
        public ArticleBlockRelationProductionInput Input { get; set; } = input;
        public ArticleRelationSet? NonBlockSet
        {
            get; set;
        }
        public Func<Task>? BeforePage
        {
            get; set;
        }

        public async Task<ArticleBlockRelationParsedPage> ReadAsync(ArticleRelationActorContext actor, string? afterArticleIdentity,
            int pageSize, long? expectedSourceGeneration, CancellationToken cancellationToken)
        {
            if (BeforePage is not null)
            {
                await BeforePage();
            }
            ArticleBlockRelationParsedArticle article = Produce(expectedSourceGeneration, cancellationToken);
            return new(actor, Input.SourceGeneration, afterArticleIdentity is null ? [article] : [], false);
        }

        public Task<ArticleBlockRelationParsedArticleRead> ReadArticleAsync(ArticleRelationActorContext actor, string articleIdentity,
            long? expectedSourceGeneration, CancellationToken cancellationToken)
            => Task.FromResult(new ArticleBlockRelationParsedArticleRead(actor, Input.SourceGeneration, Produce(expectedSourceGeneration, cancellationToken)));

        private ArticleBlockRelationParsedArticle Produce(long? expectedGeneration, CancellationToken cancellationToken)
        {
            if (expectedGeneration.HasValue && expectedGeneration != Input.SourceGeneration)
            {
                throw new ArticleRelationIndexException("fixture_source_generation_stale");
            }
            cancellationToken.ThrowIfCancellationRequested();
            ArticleRelationSet original = NonBlockSet ?? ArticleRelationContractValidator.Seal(new ArticleRelationSet(
                ArticleRelationSchemas.RelationSet, 1, Input.Source, [], string.Empty));
            return new(Input.Source.ArticleIdentity, Input.SourceGeneration, [new(original, Input)]);
        }
    }
}
