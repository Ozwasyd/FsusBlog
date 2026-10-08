using System.Collections;
using System.Text.Json;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Fixtures.DataScale;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>
/// Synthetic unit-only plans, policy facts and temporal envelopes exercise input
/// resolution. They authenticate no provenance or credentials, generate no physical
/// graph rows and provide no canonical artifact, delivery or qualification receipt.
/// </summary>
public sealed class CanonicalCommentGraphFactoryResolutionTests
{
    private const string SyntheticDigest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string DifferentSyntheticDigest = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private static readonly DateTime s_unitTime = new(2024, 3, 1, 0, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void ResolveIntentStream_PreservesExactOccurrenceRequestOrderAndSuppliedArticleIds()
    {
        CommentScalePlan plan = Plan();
        CommentScaleGraphFactBindings[] frames = Frames(plan);
        var facts = new ObservedFacts(frames);

        CommentScaleResolvedGraphIntent[] result = Resolve(plan, facts).ToArray();

        Assert.Equal(new[]
        {
            new CommentScaleGraphOccurrence("thread", 0, "article.thread"),
            new CommentScaleGraphOccurrence("thread", 1, "article.thread"),
            new CommentScaleGraphOccurrence("empty", 0, "article.empty"),
            new CommentScaleGraphOccurrence("empty", 1, "article.empty")
        }, result.Select(item => item.Occurrence));
        Assert.Equal(new[] { 7777, 13, 950001, 42 }, result.Select(item => item.ArticleId));
        Assert.All(result.Take(2), item => Assert.Equal(new[] { "root", "child", "leaf" },
            item.Comments.Select(request => request.Coordinate.CommentRole)));
        Assert.All(result.Skip(2), item => Assert.Empty(item.Comments));
        for (int index = 0; index < frames.Length; index++)
        {
            Assert.Equal(frames[index].ArticleSemanticRole, result[index].ArticleSemanticRole);
            Assert.Equal(plan.ContentDigest, result[index].CommentPlanDigest);
            Assert.Equal(plan.ArticlePlan.ContentDigest, result[index].ArticlePlanDigest);
            Assert.Same(frames[index].NativeArticleBinding, result[index].NativeArticleBinding);
        }
        Assert.Equal(5, facts.MoveNextCalls);
        Assert.Equal(1, facts.DisposeCalls);
    }

    [Fact]
    public void ResolveIntentStream_KeepsRequestedEdgesSymbolicWithinTheirOwnOccurrence()
    {
        CommentScalePlan plan = Plan();

        CommentScaleResolvedGraphIntent[] result = Resolve(plan, Frames(plan)).ToArray();

        foreach (CommentScaleResolvedGraphIntent occurrence in result.Take(2))
        {
            CommentScaleResolvedRequestIntent root = occurrence.Comments[0];
            CommentScaleResolvedRequestIntent child = occurrence.Comments[1];
            CommentScaleResolvedRequestIntent leaf = occurrence.Comments[2];
            Assert.Null(root.Parent);
            Assert.Null(root.ReplyTarget);
            Assert.Equal(root.Coordinate, child.Parent);
            Assert.Equal(root.Coordinate, child.ReplyTarget);
            Assert.Equal(child.Coordinate, leaf.Parent);
            Assert.Equal(root.Coordinate, leaf.ReplyTarget);
            Assert.All(occurrence.Comments, item => Assert.Equal(occurrence.Occurrence, item.Coordinate.Occurrence));
        }
        Assert.NotEqual(result[0].Comments[0].Coordinate, result[1].Comments[0].Coordinate);
        // Coordinates name requests only; no native comment ID, root ID or depth is computed.
    }

    [Fact]
    public void ResolveIntentStream_PreservesAllPlannedStatusesAndOriginalRoleInstants()
    {
        CommentScalePlan plan = SinglePlan();
        ResolvedTemporalRoleContext temporal = Temporal();

        CommentScaleResolvedRequestIntent root = Assert.Single(
            CanonicalCommentGraphFactory.ResolveIntentStream(plan, temporal, Frames(plan))).Comments[0];

        Assert.Equal(Enum.GetValues<CommentModerationStatus>(), root.Moderation.Select(item => item.Request.Next));
        Assert.Equal(plan.Scenarios[0].Comments[0].Moderation, root.Moderation.Select(item => item.Request));
        Assert.Equal(new[] { s_unitTime, s_unitTime.AddMilliseconds(1), s_unitTime.AddMilliseconds(2), s_unitTime.AddMilliseconds(3) },
            root.Moderation.Select(item => item.OccurredAtUtc));
        Assert.Equal(temporal.RequireInstant("created").UtcDateTime, root.Policies.CreatedAtUtc);
        Assert.Equal("content.root", root.ContentRole);
        Assert.Equal(plan.Scenarios[0].Comments[0].ContentArtifact, root.ContentArtifact);
    }

    [Fact]
    public void ResolveIntentStream_PreservesProductionAuthorRefusalWithoutInventingDownstreamDecisions()
    {
        CommentScalePlan plan = SinglePlan();
        CommentScaleGraphFactBindings frame = Frames(plan)[0];
        frame = frame with
        {
            Comments = frame.Comments.Select(item => item with
            {
                PolicyFacts = item.PolicyFacts with
                {
                    PublicSendExplicitlySelected = false
                }
            }).ToArray()
        };

        CommentScaleResolvedGraphIntent result = Assert.Single(Resolve(plan, [frame]));

        Assert.All(result.Comments, item =>
        {
            Assert.False(item.Policies.AuthorMode.Allowed);
            Assert.Equal("public_opt_in_required", item.Policies.AuthorMode.Status);
            Assert.Null(item.Policies.ArticleWrite);
            Assert.Null(item.Policies.BaseInitialModerationDecision);
            Assert.Null(item.Policies.CandidateReplyRecipientId);
            Assert.Equal(CommentScaleCredentialValidity.PublicAuthenticated, item.Policies.CredentialValidity);
        });
    }

    [Fact]
    public void ResolveIntentStream_KeepsBaseModerationSeparateFromRequestedStatusAndPremoderation()
    {
        CommentScalePlan plan = SinglePlan();
        CommentScaleGraphFactBindings frame = Frames(plan)[0];
        foreach (CommentScaleRequestFactBinding item in frame.Comments)
        {
            item.PolicyFacts.ArticlePolicy!.ModerationMode = ArticleCommentModerationModes.Premoderated;
        }

        CommentScaleResolvedRequestIntent root = Assert.Single(Resolve(plan, [frame])).Comments[0];

        Assert.Equal(CommentModerationStatus.Pending, root.Moderation[0].Request.Next);
        Assert.Equal(CommentModerationStatus.Approved, root.Policies.BaseInitialModerationDecision!.Value.Status);
        Assert.Equal(ArticleCommentModerationModes.Premoderated, root.Policies.ArticleWrite!.Policy.ModerationMode);
        // Base policy plus requested history are not a final row status or graph admission.
    }

    [Theory]
    [InlineData("namespace")]
    [InlineData("comment-plan")]
    [InlineData("article-plan")]
    [InlineData("repetition")]
    [InlineData("scenario")]
    [InlineData("target-role")]
    [InlineData("native-schema")]
    [InlineData("native-digest")]
    [InlineData("native-null")]
    [InlineData("article-id")]
    [InlineData("article-role")]
    [InlineData("request-role")]
    [InlineData("content-role")]
    [InlineData("content-artifact")]
    [InlineData("policy-article-id")]
    [InlineData("request-order")]
    [InlineData("request-count")]
    [InlineData("request-null")]
    [InlineData("policy-null")]
    [InlineData("comments-null")]
    [InlineData("frame-null")]
    [InlineData("occurrence-null")]
    [InlineData("content-schema")]
    [InlineData("content-null")]
    [InlineData("request-extra")]
    public void ResolveIntentStream_RejectsCrossedOrMissingFactBindingsBeforeYieldingAnIntent(string mutation)
    {
        CommentScalePlan plan = SinglePlan();
        CommentScaleGraphFactBindings frame = Frames(plan)[0];
        CommentScaleRequestFactBinding first = frame.Comments[0];
        frame = mutation switch
        {
            "namespace" => frame with { Namespace = "other-unit" },
            "comment-plan" => frame with { CommentPlanDigest = DifferentSyntheticDigest },
            "article-plan" => frame with { ArticlePlanDigest = DifferentSyntheticDigest },
            "repetition" => frame with { Occurrence = frame.Occurrence with { Repetition = 1 } },
            "scenario" => frame with { Occurrence = frame.Occurrence with { ScenarioRole = "other" } },
            "target-role" => frame with { Occurrence = frame.Occurrence with { ArticleTargetRole = "other" } },
            "native-schema" => frame with { NativeArticleBinding = frame.NativeArticleBinding with { Schema = "unowned.v2" } },
            "native-digest" => frame with { NativeArticleBinding = frame.NativeArticleBinding with { ContentDigest = "invalid" } },
            "native-null" => frame with { NativeArticleBinding = null! },
            "article-id" => frame with { ArticleId = 0 },
            "article-role" => frame with { ArticleSemanticRole = " " },
            "request-role" => ReplaceFirst(frame, first with { CommentRole = "crossed" }),
            "content-role" => ReplaceFirst(frame, first with { ContentRole = "crossed" }),
            "content-artifact" => ReplaceFirst(frame, first with { ContentArtifact = first.ContentArtifact with { ContentDigest = DifferentSyntheticDigest } }),
            "policy-article-id" => ReplaceFirst(frame, first with { PolicyFacts = first.PolicyFacts with { ArticleId = 999 } }),
            "request-order" => frame with { Comments = frame.Comments.Reverse().ToArray() },
            "request-count" => frame with { Comments = frame.Comments.Skip(1).ToArray() },
            "request-null" => ReplaceFirst(frame, null!),
            "policy-null" => ReplaceFirst(frame, first with { PolicyFacts = null! }),
            "comments-null" => frame with { Comments = null! },
            "frame-null" => null!,
            "occurrence-null" => frame with { Occurrence = null! },
            "content-schema" => ReplaceFirst(frame, first with { ContentArtifact = first.ContentArtifact with { Schema = "unowned.v2" } }),
            "content-null" => ReplaceFirst(frame, first with { ContentArtifact = null! }),
            "request-extra" => frame with { Comments = frame.Comments.Concat([first]).ToArray() },
            _ => throw new InvalidOperationException(mutation)
        };
        var facts = new ObservedFacts([frame]);
        using IEnumerator<CommentScaleResolvedGraphIntent> input = Resolve(plan, facts).GetEnumerator();

        Assert.Throws<InvalidOperationException>(() => input.MoveNext());

        Assert.Equal(1, facts.MoveNextCalls);
        Assert.Equal(1, facts.DisposeCalls);
    }

    [Theory]
    [InlineData("schema", "plan_schema")]
    [InlineData("counts", "allocation_counts")]
    [InlineData("relations", "graph_relations")]
    [InlineData("public-synthetic", "credential_class")]
    public void ResolveIntentStream_InspectsTheWholePlanBeforeEnumeratingFacts(string mutation, string error)
    {
        CommentScalePlan plan = SinglePlan();
        CommentScaleScenario scenario = plan.Scenarios[0];
        plan = mutation switch
        {
            "schema" => plan with { Schema = "unowned.v2" },
            "counts" => plan with { ArticleCount = 2 },
            "relations" => plan with { Scenarios = [scenario with { Graph = scenario.Graph with { Relations = [] } }] },
            "public-synthetic" => plan with
            {
                Scenarios = [scenario with { Comments = scenario.Comments.Select(item => item with { CredentialValidity = CommentScaleCredentialValidity.ScaleSyntheticTestOnly }).ToArray() }]
            },
            _ => throw new InvalidOperationException(mutation)
        };
        plan = Seal(plan);
        var facts = new ObservedFacts([]);

        InvalidOperationException failure = Assert.Throws<InvalidOperationException>(() => Resolve(plan, facts).ToArray());

        Assert.Contains(error, failure.Message);
        Assert.Equal(0, facts.GetEnumeratorCalls);
        Assert.Equal(0, facts.MoveNextCalls);
    }

    [Fact]
    public void ResolveIntentStream_FreezesAllPlanListsBeforeTheFirstFact()
    {
        CommentScalePlan initial = Plan();
        var moderation = initial.Scenarios[0].Comments[0].Moderation.ToList();
        var comments = initial.Scenarios[0].Comments.Select((item, index) => index == 0 ? item with { Moderation = moderation } : item).ToList();
        var relations = initial.Scenarios[0].Graph.Relations.ToList();
        var authorities = initial.Scenarios[0].Graph.Authorities.ToList();
        var scenarios = initial.Scenarios.Select((item, index) => index == 0 ? item with
        {
            Comments = comments,
            Graph = new(relations, authorities)
        } : item).ToList();
        CommentScalePlan plan = Seal(initial with
        {
            Scenarios = scenarios
        });
        CommentScaleGraphFactBindings[] frames = Frames(plan);
        using IEnumerator<CommentScaleResolvedGraphIntent> input = Resolve(plan, frames).GetEnumerator();
        Assert.True(input.MoveNext());
        CommentScaleResolvedGraphIntent first = input.Current;

        moderation.Clear();
        comments.Clear();
        relations.Clear();
        authorities.Clear();
        scenarios.Clear();

        Assert.True(input.MoveNext());
        CommentScaleResolvedGraphIntent second = input.Current;
        Assert.Equal(3, second.Comments.Count);
        Assert.Equal(4, second.Comments[0].Moderation.Count);
        Assert.Equal(first.Requirements.Relations, second.Requirements.Relations);
        Assert.Equal(Enum.GetValues<CommentScaleRelation>().Length, second.Requirements.Relations.Count);
        Assert.Equal(Enum.GetValues<CommentScaleAuthority>().Length, second.Requirements.Authorities.Count);
        Assert.Equal(plan.ContentDigest, second.CommentPlanDigest);
        Assert.True(input.MoveNext());
        Assert.Empty(input.Current.Comments);
        Assert.True(input.MoveNext());
        Assert.False(input.MoveNext());
    }

    [Fact]
    public void ResolveIntentStream_YieldedRequirementsCannotMutateLaterRepetitions()
    {
        CommentScalePlan plan = ThreadPlan(2);
        using IEnumerator<CommentScaleResolvedGraphIntent> input = Resolve(plan, Frames(plan)).GetEnumerator();
        Assert.True(input.MoveNext());
        CommentScaleResolvedGraphIntent first = input.Current;

        Assert.Throws<NotSupportedException>(() => ((IList<CommentScaleRelation>)first.Requirements.Relations).Clear());
        Assert.Throws<NotSupportedException>(() => ((IList<CommentScaleAuthorityReference>)first.Requirements.Authorities).Clear());

        Assert.True(input.MoveNext());
        Assert.Equal(Enum.GetValues<CommentScaleRelation>(), input.Current.Requirements.Relations);
        Assert.Equal(Enum.GetValues<CommentScaleAuthority>(), input.Current.Requirements.Authorities.Select(item => item.Authority));
        Assert.False(input.MoveNext());
    }

    [Fact]
    public void ResolveIntentStream_RejectsInvalidFinalScenarioBeforeAnyEarlierFactIsRead()
    {
        CommentScalePlan plan = Plan();
        plan = Seal(plan with
        {
            Scenarios = [plan.Scenarios[0], plan.Scenarios[1] with { Graph = plan.Scenarios[1].Graph with { Authorities = [] } }]
        });
        var facts = new ObservedFacts([]);

        InvalidOperationException failure = Assert.Throws<InvalidOperationException>(() => Resolve(plan, facts).ToArray());

        Assert.Contains("graph_authorities", failure.Message);
        Assert.Equal(0, facts.GetEnumeratorCalls);
    }

    [Theory]
    [InlineData("missing", 1)]
    [InlineData("extra", 2)]
    [InlineData("throw", 1)]
    public void ResolveIntentStream_RetainsOnlyItsYieldedPrefixAndDisposesFailedInput(string failureKind, int expectedPrefix)
    {
        CommentScalePlan plan = ThreadPlan(2);
        CommentScaleGraphFactBindings[] frames = Frames(plan);
        var failure = new InvalidOperationException("synthetic-unit-fact-source-failure");
        IEnumerable<CommentScaleGraphFactBindings> items = failureKind switch
        {
            "missing" => frames.Take(1),
            "extra" => frames.Concat([frames[0]]),
            "throw" => ThrowAfterFirst(frames[0], failure),
            _ => throw new InvalidOperationException(failureKind)
        };
        var facts = new ObservedFacts(items);
        var prefix = new List<CommentScaleResolvedGraphIntent>();

        InvalidOperationException actual = Assert.Throws<InvalidOperationException>(() =>
        {
            foreach (CommentScaleResolvedGraphIntent item in Resolve(plan, facts))
            {
                prefix.Add(item);
            }
        });

        Assert.Equal(expectedPrefix, prefix.Count);
        Assert.Equal(frames.Take(expectedPrefix).Select(item => item.ArticleId), prefix.Select(item => item.ArticleId));
        if (failureKind == "throw")
        {
            Assert.Same(failure, actual);
        }
        Assert.Equal(1, facts.DisposeCalls);
    }

    [Fact]
    public void ResolveIntentStream_IsLazyAndDoesNotReadAheadOfTheRequestedOccurrence()
    {
        CommentScalePlan plan = Plan();
        var facts = new ObservedFacts(Frames(plan));
        IEnumerable<CommentScaleResolvedGraphIntent> output = Resolve(plan, facts);
        Assert.Equal(0, facts.GetEnumeratorCalls);
        using (IEnumerator<CommentScaleResolvedGraphIntent> input = output.GetEnumerator())
        {
            Assert.Equal(0, facts.GetEnumeratorCalls);
            Assert.True(input.MoveNext());
            Assert.Equal(1, facts.GetEnumeratorCalls);
            Assert.Equal(1, facts.MoveNextCalls);
            Assert.Equal(7777, input.Current.ArticleId);
        }
        Assert.Equal(1, facts.DisposeCalls);
        Assert.Equal(1, facts.MoveNextCalls);
    }

    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(256)]
    public void ResolveIntentBatches_PreservesIntentOrderWithinTheRequestedBound(int batchSize)
    {
        CommentScalePlan plan = ThreadPlan(5);
        CommentScaleGraphFactBindings[] frames = Frames(plan);

        IReadOnlyList<CommentScaleResolvedGraphIntent>[] batches = CanonicalCommentGraphFactory
            .ResolveIntentBatches(plan, Temporal(), frames, batchSize).ToArray();

        Assert.Equal(256, CanonicalCommentGraphFactory.MaximumIntentsPerBatch);
        Assert.Equal(frames.Select(item => item.ArticleId), batches.SelectMany(batch => batch).Select(item => item.ArticleId));
        Assert.All(batches, batch => Assert.InRange(batch.Count, 1, batchSize));
        Assert.Equal((5 + batchSize - 1) / batchSize, batches.Length);
    }

    [Fact]
    public void ResolveIntentBatches_ReadsOnlyOneBoundedBatchWhenTheConsumerStops()
    {
        CommentScalePlan plan = ThreadPlan(5);
        var facts = new ObservedFacts(Frames(plan));
        using (IEnumerator<IReadOnlyList<CommentScaleResolvedGraphIntent>> input = CanonicalCommentGraphFactory
            .ResolveIntentBatches(plan, Temporal(), facts, 2).GetEnumerator())
        {
            Assert.Equal(0, facts.MoveNextCalls);
            Assert.True(input.MoveNext());
            Assert.Equal(2, input.Current.Count);
            Assert.Equal(2, facts.MoveNextCalls);
        }
        Assert.Equal(1, facts.DisposeCalls);
        Assert.Equal(2, facts.MoveNextCalls);
    }

    [Fact]
    public void ResolveIntentBatches_UsesTheExactMaximumAndKeepsTheFinalPartialBatch()
    {
        CommentScalePlan plan = ThreadPlan(257);
        CommentScaleGraphFactBindings[] frames = Frames(plan);

        IReadOnlyList<CommentScaleResolvedGraphIntent>[] batches = CanonicalCommentGraphFactory
            .ResolveIntentBatches(plan, Temporal(), frames, 256).ToArray();

        Assert.Equal(new[] { 256, 1 }, batches.Select(batch => batch.Count));
        Assert.Equal(frames.Select(item => item.ArticleId), batches.SelectMany(batch => batch).Select(item => item.ArticleId));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(257)]
    public void ResolveIntentBatches_RejectsInvalidBoundsBeforeFactEnumeration(int batchSize)
    {
        var facts = new ObservedFacts([]);

        Assert.Throws<ArgumentOutOfRangeException>(() => CanonicalCommentGraphFactory
            .ResolveIntentBatches(SinglePlan(), Temporal(), facts, batchSize).ToArray());

        Assert.Equal(0, facts.GetEnumeratorCalls);
    }

    [Fact]
    public void ResolveIntentStream_EmptyPlanAcceptsOnlyEmptyFactsAndProducesNoBatches()
    {
        CommentScalePlan plan = Seal(SinglePlan() with
        {
            Scenarios = [],
            ArticleCount = 0,
            CommentCount = 0
        });
        var empty = new ObservedFacts([]);

        Assert.Empty(Resolve(plan, empty));
        Assert.Equal(1, empty.MoveNextCalls);
        Assert.Equal(1, empty.DisposeCalls);
        Assert.Empty(CanonicalCommentGraphFactory.ResolveIntentBatches(plan, Temporal(), [], 256));

        var extra = new ObservedFacts(Frames(SinglePlan()));
        Assert.Throws<InvalidOperationException>(() => Resolve(plan, extra).ToArray());
        Assert.Equal(1, extra.MoveNextCalls);
        Assert.Equal(1, extra.DisposeCalls);
    }

    private static IEnumerable<CommentScaleResolvedGraphIntent> Resolve(
        CommentScalePlan plan,
        IEnumerable<CommentScaleGraphFactBindings> facts)
        => CanonicalCommentGraphFactory.ResolveIntentStream(plan, Temporal(), facts);

    private static CommentScaleGraphFactBindings ReplaceFirst(CommentScaleGraphFactBindings frame, CommentScaleRequestFactBinding first)
        => frame with
        {
            Comments = new[] { first }.Concat(frame.Comments.Skip(1)).ToArray()
        };

    private static IEnumerable<CommentScaleGraphFactBindings> ThrowAfterFirst(CommentScaleGraphFactBindings first, Exception failure)
    {
        yield return first;
        throw failure;
    }

    private static CommentScalePlan SinglePlan() => ThreadPlan(1);

    private static CommentScalePlan ThreadPlan(long repetitions)
    {
        CommentScalePlan plan = Plan();
        return Seal(plan with
        {
            Scenarios = [plan.Scenarios[0] with { Repetitions = repetitions }],
            ArticleCount = repetitions,
            CommentCount = repetitions * 3
        });
    }

    private static CommentScalePlan Plan()
    {
        var root = new CommentScaleCommentRequest("root", null, null, CommentAuthorModes.Public,
            CommentScaleCredentialValidity.PublicAuthenticated, SyntheticDigest, "content.root",
            new("fsusblog.generated-content-shape.v1", SyntheticDigest), SyntheticDigest, "created",
            [new(null, CommentModerationStatus.Pending, "initial", "created"),
             new(CommentModerationStatus.Pending, CommentModerationStatus.Approved, "review", "approved"),
             new(CommentModerationStatus.Approved, CommentModerationStatus.Rejected, "reject", "rejected"),
             new(CommentModerationStatus.Rejected, CommentModerationStatus.Hidden, "hide", "hidden")]);
        var child = root with
        {
            Role = "child",
            ParentRole = "root",
            ReplyTargetRole = "root",
            ContentRole = "content.child"
        };
        var leaf = root with
        {
            Role = "leaf",
            ParentRole = "child",
            ReplyTargetRole = "root",
            ContentRole = "content.leaf"
        };
        var graph = new CommentScaleGraphRequirements(Enum.GetValues<CommentScaleRelation>(),
            Enum.GetValues<CommentScaleAuthority>().Select(authority => new CommentScaleAuthorityReference(
                authority, new string('a', 40), SyntheticDigest)).ToArray());
        return Seal(new(CommentScalePlanContract.Schema, CommentScalePlanContract.GraphSchema,
            "synthetic-unit-only", "unit-tier", 6, 4,
            new(ArticleScaleContractIds.PlanSchema, SyntheticDigest),
            new(ArticleScaleContractIds.ContentShapeCatalogSchema, SyntheticDigest),
            new(ArticleScaleContractIds.TemporalArtifactSchema, SyntheticDigest),
            [new("thread", CommentScaleThreadShape.MixedReplyTargets, "article.thread", 2, [root, child, leaf], graph),
             new("empty", CommentScaleThreadShape.ZeroCommentArticle, "article.empty", 2, [], graph)], string.Empty));
    }

    private static CommentScalePlan Seal(CommentScalePlan plan)
        => plan with
        {
            ContentDigest = CommentScalePlanContract.ComputeDigest(plan)
        };

    private static CommentScaleGraphFactBindings[] Frames(CommentScalePlan plan)
    {
        int[] articleIds = [7777, 13, 950001, 42, 1000007];
        var result = new List<CommentScaleGraphFactBindings>();
        foreach (CommentScaleScenario scenario in plan.Scenarios)
        {
            for (long repetition = 0; repetition < scenario.Repetitions; repetition++)
            {
                // Supplied synthetic unit IDs, never a factory/native allocation rule.
                int articleId = result.Count < articleIds.Length ? articleIds[result.Count] : 300000 + result.Count;
                var occurrence = new CommentScaleGraphOccurrence(scenario.Role, repetition, scenario.ArticleTargetRole);
                result.Add(new(occurrence, plan.Namespace, plan.ContentDigest, plan.ArticlePlan.ContentDigest,
                    "synthetic-article-" + articleId, articleId,
                    new("fsusblog.article-scale-graph-identity-bindings.v1", SyntheticDigest),
                    scenario.Comments.Select(request => new CommentScaleRequestFactBinding(request.Role, request.ContentRole,
                        request.ContentArtifact, PolicyFacts(request, articleId))).ToArray()));
            }
        }
        return result.ToArray();
    }

    private static CommentScalePolicyFacts PolicyFacts(CommentScaleCommentRequest request, int articleId)
    {
        var site = new AnonymousCommentPolicySnapshot(true, true, true, CommentAuthorModes.ZkAnonymous, ["en"])
        {
            UpdatedAtUtc = s_unitTime,
            SnapshotHash = SyntheticDigest
        };
        var article = new ArticleCommentPolicy
        {
            ArticleId = articleId,
            UpdatedAtUtc = s_unitTime,
            PolicyVersion = 2,
            ModerationMode = ArticleCommentModerationModes.RiskBased
        };
        var actor = new CommentActor(7, CommentAuthorModes.Public, "unit-handle", null,
            "unit-handle", "en", null, null, "unit-subject", "common", false);
        var region = new RegionModerationDecision(true, "GLOBAL", 1d, "synthetic-unit-only", null, [], [], [],
            "synthetic-unit-policy", "unit-reason", "unit-reason", false, false);
        long? rootId = request.ParentRole is null ? null : 123456789;
        return new(articleId, rootId, site, article,
            rootId is null ? null : new CommentThreadPolicy { ArticleId = articleId, RootCommentId = rootId.Value, PolicyVersion = 3 },
            actor, SyntheticDigest, region, SyntheticDigest, true, false, false,
            request.ReplyTargetRole is null ? null : 8);
    }

    private static ResolvedTemporalRoleContext Temporal()
    {
        // In-memory adapter input only; no original producer or artifact admission runs.
        string json = JsonSerializer.Serialize(new
        {
            schema = "fsusblog.resolved-temporal-roles.v1",
            contextIdentity = new
            {
                producerId = "synthetic-unit-only",
                schedulerRunId = "synthetic-unit-only"
            },
            contentDigest = SyntheticDigest,
            roles = new[] { "created", "approved", "rejected", "hidden" }.Select((role, index) => new
            {
                roleId = role,
                clockKind = "business-wall",
                semanticEffect = "included",
                precision = "millisecond",
                instantUtc = s_unitTime.AddMilliseconds(index).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture)
            })
        });
        return ResolvedTemporalRoleContext.Parse(json, SyntheticDigest);
    }

    private sealed class ObservedFacts(IEnumerable<CommentScaleGraphFactBindings> items) : IEnumerable<CommentScaleGraphFactBindings>
    {
        public int GetEnumeratorCalls
        {
            get; private set;
        }
        public int MoveNextCalls
        {
            get; private set;
        }
        public int DisposeCalls
        {
            get; private set;
        }

        public IEnumerator<CommentScaleGraphFactBindings> GetEnumerator()
        {
            GetEnumeratorCalls++;
            return new ObservedEnumerator(this, items.GetEnumerator());
        }

        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();

        private sealed class ObservedEnumerator(ObservedFacts owner, IEnumerator<CommentScaleGraphFactBindings> inner)
            : IEnumerator<CommentScaleGraphFactBindings>
        {
            public CommentScaleGraphFactBindings Current => inner.Current;
            object IEnumerator.Current => Current;

            public bool MoveNext()
            {
                owner.MoveNextCalls++;
                return inner.MoveNext();
            }

            public void Reset() => inner.Reset();

            public void Dispose()
            {
                owner.DisposeCalls++;
                inner.Dispose();
            }
        }
    }
}
