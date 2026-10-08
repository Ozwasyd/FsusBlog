using System.Text.Json;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Fixtures.DataScale;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>
/// Explicit synthetic unit IDs, allocation references, role roster and temporal
/// envelope test original transport binding only. No allocator, credential,
/// artifact provenance, complete physical graph or production receipt is claimed.
/// Final normalized comments remain supplied observations, including premoderation.
/// </summary>
public sealed class CommentScaleNativeBindingAdapterTests
{
    private const string UnitDigest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string OtherDigest = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private static readonly DateTime s_time = new(2024, 3, 1, 0, 0, 0, DateTimeKind.Utc);

    [Theory]
    [InlineData("PostgreSql", CommentModerationStatus.Pending)]
    [InlineData("MySql", CommentModerationStatus.Approved)]
    [InlineData("Sqlite", CommentModerationStatus.Rejected)]
    [InlineData("PostgreSql", CommentModerationStatus.Hidden)]
    public void BindInitialOutboxFacts_UsesOriginalMapAndPreservesSuppliedFinalFacts(string provider, CommentModerationStatus status)
    {
        Fixture f = Create(provider);
        f.Comment.ModerationStatus = status;
        f.Comment.ModerationReason = "article_policy_premoderated";
        string original = JsonSerializer.Serialize(f.Comment);

        CommentScaleInitialOutboxFacts result = Bind(f);

        Assert.Equal(900007, result.AllocatedCommentId);
        Assert.NotEqual(f.Comment.Id, result.AllocatedCommentId);
        Assert.Equal(f.Graph.Comments[0].Coordinate, result.Coordinate);
        Assert.Equal(42, result.ArticleId);
        Assert.Same(f.Comment, result.NormalizedComment);
        Assert.Equal("outbox", result.OccurredAtRole);
        Assert.Equal(original, JsonSerializer.Serialize(f.Comment));
        Assert.Equal(CommentScaleCredentialValidity.PublicAuthenticated, f.Graph.Comments[0].Policies.CredentialValidity);
        Assert.Equal(status, result.NormalizedComment.ModerationStatus);
        Assert.Equal("article_policy_premoderated", result.NormalizedComment.ModerationReason);
        // Explicit unit roster, never derived from status.
        Assert.Equal(3, f.Map.Ids.Count);
    }

    [Theory]
    [InlineData("run")]
    [InlineData("namespace")]
    [InlineData("runtime")]
    [InlineData("provider")]
    [InlineData("comment-plan")]
    [InlineData("article-plan")]
    [InlineData("allocation-owner")]
    [InlineData("allocation-commit")]
    [InlineData("allocation-digest")]
    public void BindInitialOutboxFacts_RefusesScopeAndIndependentAllocationCrossings(string change)
    {
        Fixture f = Create();
        DataScaleNativeAllocationReference allocation = change switch
        {
            "allocation-owner" => f.Map.Allocation with { OwnerContractId = "crossed-unit-owner" },
            "allocation-commit" => f.Map.Allocation with { SourceCommit = new string('b', 40) },
            "allocation-digest" => f.Map.Allocation with { ContentDigest = OtherDigest },
            _ => f.Map.Allocation
        };
        var map = new DataScaleNativeCommentBindings(change == "run" ? "crossed-run" : f.Map.RunId,
            change == "namespace" ? "crossed-namespace" : f.Map.Namespace,
            change == "runtime" ? "crossed-runtime" : f.Map.RuntimeIdentity,
            change == "provider" ? "MySql" : f.Map.Provider,
            change == "comment-plan" ? OtherDigest : f.Map.CommentPlanDigest,
            change == "article-plan" ? OtherDigest : f.Map.ArticlePlanDigest, allocation, f.Map.Ids);
        // Match the new transport digest independently so the crossed scope/allocation
        // remains the refusal, rather than an incidental stale map reference.
        f = f with
        {
            Map = map,
            Expected = f.Expected with
            {
                BindingReference = new(DataScaleNativeCommentBindings.Schema, map.Digest)
            }
        };

        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() => Bind(f));
        Assert.Equal("comment_native_binding_scope_or_reference_mismatch", error.Message);
    }

    [Theory]
    [InlineData("schema")]
    [InlineData("digest")]
    [InlineData("missing-roster")]
    [InlineData("extra-roster")]
    [InlineData("duplicate-roster")]
    [InlineData("crossed-roster")]
    public void BindInitialOutboxFacts_RequiresTheWholeIndependentOriginalRosterAndReference(string change)
    {
        Fixture f = Create();
        DataScaleNativeCommentRole[] roles = f.Expected.FactoryRoles.ToArray();
        CommentScaleNativeBindingExpectation expected = change switch
        {
            "schema" => f.Expected with { BindingReference = f.Expected.BindingReference with { Schema = "unowned.v1" } },
            "digest" => f.Expected with { BindingReference = f.Expected.BindingReference with { ContentDigest = OtherDigest } },
            "missing-roster" => f.Expected with { FactoryRoles = roles.Take(2).ToArray() },
            "extra-roster" => f.Expected with { FactoryRoles = [.. roles, roles[0] with { EntityRole = "extra" }] },
            "duplicate-roster" => f.Expected with { FactoryRoles = [roles[0], roles[0], roles[2]] },
            "crossed-roster" => f.Expected with { FactoryRoles = [roles[0], roles[1] with { EntityRole = "crossed" }, roles[2]] },
            _ => throw new InvalidOperationException(change)
        };
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() => Bind(f with { Expected = expected }));
        Assert.Equal(change is "duplicate-roster" or "crossed-roster"
            ? "native_comment_factory_role_coverage_mismatch" : "comment_native_binding_scope_or_reference_mismatch", error.Message);
    }

    [Theory]
    [InlineData("entity-role")]
    [InlineData("entity-kind")]
    public void BindInitialOutboxFacts_ResolvesOnlyTheExactCallerSuppliedCommentEntityRole(string change)
    {
        Fixture f = Create();
        if (change == "entity-kind")
        {
            var ids = f.Map.Ids.ToDictionary(pair => pair.Key.Entity == DataScaleNativeCommentEntity.Comment
                ? pair.Key with
                {
                    Entity = DataScaleNativeCommentEntity.ModerationEvent
                } : pair.Key, pair => pair.Value);
            var map = new DataScaleNativeCommentBindings(f.Map.RunId, f.Map.Namespace, f.Map.RuntimeIdentity, f.Map.Provider,
                f.Map.CommentPlanDigest, f.Map.ArticlePlanDigest, f.Map.Allocation, ids);
            f = f with
            {
                Map = map,
                Expected = f.Expected with
                {
                    FactoryRoles = ids.Keys.ToArray(),
                    BindingReference = new(DataScaleNativeCommentBindings.Schema, map.Digest)
                }
            };
        }
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() => CommentScaleNativeBindingAdapter.BindInitialOutboxFacts(
            f.Plan, f.Graph, "root", change == "entity-role" ? "not-present" : "initial.comment",
            f.Comment, "outbox", f.Temporal, f.Map, f.Expected));
        Assert.Equal("native_comment_role_missing", error.Message);
    }

    [Theory]
    [InlineData("plan-digest")]
    [InlineData("article-digest")]
    [InlineData("article-id")]
    [InlineData("normalized-article")]
    [InlineData("undefined-status")]
    [InlineData("scenario")]
    [InlineData("target")]
    [InlineData("repetition")]
    [InlineData("negative-repetition")]
    [InlineData("comment")]
    [InlineData("graph-comment-coordinate")]
    [InlineData("missing-graph-comment")]
    [InlineData("duplicate-graph-comment")]
    [InlineData("null-graph-comment")]
    public void BindInitialOutboxFacts_RefusesPlanAndExactOccurrenceRequestDrift(string change)
    {
        Fixture f = Create();
        CommentScaleResolvedGraphIntent graph = change switch
        {
            "plan-digest" => f.Graph with { CommentPlanDigest = OtherDigest },
            "article-digest" => f.Graph with { ArticlePlanDigest = OtherDigest },
            "article-id" => f.Graph with { ArticleId = 0 },
            "scenario" => f.Graph with { Occurrence = f.Graph.Occurrence with { ScenarioRole = "crossed" } },
            "target" => f.Graph with { Occurrence = f.Graph.Occurrence with { ArticleTargetRole = "crossed" } },
            "repetition" => f.Graph with { Occurrence = f.Graph.Occurrence with { Repetition = 1 } },
            "negative-repetition" => f.Graph with { Occurrence = f.Graph.Occurrence with { Repetition = -1 } },
            "graph-comment-coordinate" => f.Graph with { Comments = [f.Graph.Comments[0] with { Coordinate = f.Graph.Comments[0].Coordinate with { CommentRole = "crossed" } }] },
            "missing-graph-comment" => f.Graph with { Comments = [] },
            "null-graph-comment" => f.Graph with { Comments = [null!] },
            "duplicate-graph-comment" => f.Graph with { Comments = [f.Graph.Comments[0], f.Graph.Comments[0]] },
            _ => f.Graph
        };
        if (change == "normalized-article")
        {
            f.Comment.ArticleId = 43;
        }
        if (change == "undefined-status")
        {
            f.Comment.ModerationStatus = (CommentModerationStatus)999;
        }
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() => CommentScaleNativeBindingAdapter.BindInitialOutboxFacts(
            f.Plan, graph, change == "comment" ? "not-planned" : "root", "initial.comment", f.Comment, "outbox", f.Temporal, f.Map, f.Expected));
        Assert.Equal(change is "plan-digest" or "article-digest" or "article-id" or "normalized-article" or "undefined-status"
            ? "comment_native_binding_plan_or_article_mismatch" : "comment_native_binding_request_coordinate_mismatch", error.Message);
    }

    [Theory]
    [InlineData("policies-null")]
    [InlineData("author-null")]
    [InlineData("author-denied")]
    [InlineData("article-null")]
    [InlineData("article-denied")]
    [InlineData("region-denied")]
    public void BindInitialOutboxFacts_RefusesKnownPolicyDenialWithoutInferringFinalModeration(string change)
    {
        Fixture f = Create();
        CommentScalePolicyResolution policies = f.Graph.Comments[0].Policies;
        policies = change switch
        {
            "policies-null" => null!,
            "author-null" => policies with { AuthorMode = null! },
            "author-denied" => policies with { AuthorMode = CommentAuthorModeDecision.Reject(CommentAuthorModes.Public, "unit-denial", "unit-only") },
            "article-null" => policies with { ArticleWrite = null },
            "article-denied" => policies with { ArticleWrite = policies.ArticleWrite! with { Allowed = false } },
            "region-denied" => policies with { RegionCanPublish = false },
            _ => throw new InvalidOperationException(change)
        };
        var graph = f.Graph with
        {
            Comments = [f.Graph.Comments[0] with { Policies = policies }]
        };
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() => Bind(f with { Graph = graph }));
        Assert.Equal("comment_native_binding_known_policy_refusal", error.Message);
    }

    [Fact]
    public void BindInitialOutboxFacts_InspectsTheWholePlanRatherThanOnlyTheSelectedComment()
    {
        Fixture f = Create();
        CommentScaleScenario scenario = f.Plan.Scenarios[0] with
        {
            Graph = f.Plan.Scenarios[0].Graph with
            {
                Authorities = []
            }
        };
        CommentScalePlan plan = f.Plan with
        {
            Scenarios = [scenario]
        };
        plan = plan with
        {
            ContentDigest = CommentScalePlanContract.ComputeDigest(plan)
        };
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() => Bind(f with { Plan = plan }));
        Assert.Equal("comment_native_binding_plan_or_article_mismatch", error.Message);
    }

    [Theory]
    [InlineData("temporal-digest")]
    [InlineData("legacy-schema")]
    [InlineData("public-synthetic-credential")]
    public void BindInitialOutboxFacts_RefusesOriginalPlanInspectionFailures(string change)
    {
        Fixture f = Create();
        CommentScalePlan plan = change switch
        {
            "legacy-schema" => f.Plan with { Schema = "fsusblog.comment-scale-plan.v1" },
            "public-synthetic-credential" => f.Plan with
            {
                Scenarios = [f.Plan.Scenarios[0] with
                { Comments = [f.Plan.Scenarios[0].Comments[0] with { CredentialValidity = CommentScaleCredentialValidity.ScaleSyntheticTestOnly }] }]
            },
            _ => f.Plan
        };
        plan = plan with
        {
            ContentDigest = CommentScalePlanContract.ComputeDigest(plan)
        };
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() => Bind(f with
        {
            Plan = plan,
            Temporal = change == "temporal-digest" ? Temporal(OtherDigest) : f.Temporal
        }));
        Assert.Equal("comment_native_binding_plan_or_article_mismatch", error.Message);
    }

    [Fact]
    public void BindInitialOutboxFacts_RequiresTheExplicitResolvedTemporalRole()
    {
        Fixture f = Create();
        Assert.NotEqual(f.Comment.CreateTime, f.Temporal.RequireInstant("outbox").UtcDateTime);
        Assert.Throws<InvalidOperationException>(() => CommentScaleNativeBindingAdapter.BindInitialOutboxFacts(
            f.Plan, f.Graph, "root", "initial.comment", f.Comment, "missing-time", f.Temporal, f.Map, f.Expected));
    }

    [Theory]
    [InlineData("scenario")]
    [InlineData("target")]
    [InlineData("repetition")]
    [InlineData("comment")]
    public void BindInitialOutboxFacts_DoesNotSubstituteAnIdentityFromAnotherCoordinate(string change)
    {
        Fixture f = Create();
        var ids = f.Map.Ids.ToDictionary(pair => pair.Key.Entity == DataScaleNativeCommentEntity.Comment
            ? change switch
            {
                "scenario" => pair.Key with { ScenarioRole = "other-thread" },
                "target" => pair.Key with { ArticleTargetRole = "other-article" },
                "repetition" => pair.Key with { Repetition = 1 },
                "comment" => pair.Key with { CommentRole = "other-root" },
                _ => throw new InvalidOperationException(change)
            } : pair.Key, pair => pair.Value);
        var map = new DataScaleNativeCommentBindings(f.Map.RunId, f.Map.Namespace, f.Map.RuntimeIdentity, f.Map.Provider,
            f.Map.CommentPlanDigest, f.Map.ArticlePlanDigest, f.Map.Allocation, ids);
        var expected = f.Expected with
        {
            FactoryRoles = ids.Keys.ToArray(),
            BindingReference = new(DataScaleNativeCommentBindings.Schema, map.Digest)
        };
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() => Bind(f with { Map = map, Expected = expected }));
        Assert.Equal("native_comment_role_missing", error.Message);
    }

    [Theory]
    [InlineData("comment-role")]
    [InlineData("entity-role")]
    [InlineData("time-role")]
    public void BindInitialOutboxFacts_RejectsBlankRequestedRoleNames(string member)
    {
        Fixture f = Create();
        Assert.Throws<ArgumentException>(() => CommentScaleNativeBindingAdapter.BindInitialOutboxFacts(f.Plan, f.Graph,
            member == "comment-role" ? " " : "root", member == "entity-role" ? " " : "initial.comment",
            f.Comment, member == "time-role" ? " " : "outbox", f.Temporal, f.Map, f.Expected));
    }

    [Fact]
    public void OriginalNativeMapSnapshotsCallerDictionaryAndRejectsReadonlyMutation()
    {
        Fixture f = Create();
        string digest = f.Map.Digest;
        f.SourceIds.Clear();
        Assert.Equal(900007, Bind(f).AllocatedCommentId);
        Assert.Equal(digest, f.Map.Digest);
        Assert.Equal(3, f.Map.Ids.Count);
        Assert.Throws<NotSupportedException>(() => ((IDictionary<DataScaleNativeCommentRole, long>)f.Map.Ids).Clear());
    }

    [Theory]
    [InlineData("plan")]
    [InlineData("graph")]
    [InlineData("occurrence")]
    [InlineData("comments")]
    [InlineData("comment")]
    [InlineData("temporal")]
    [InlineData("map")]
    [InlineData("expected")]
    [InlineData("allocation")]
    [InlineData("reference")]
    [InlineData("roster")]
    public void BindInitialOutboxFacts_RejectsNullRequiredInputs(string member)
    {
        Fixture f = Create();
        f = member switch
        {
            "plan" => f with { Plan = null! },
            "graph" => f with { Graph = null! },
            "occurrence" => f with { Graph = f.Graph with { Occurrence = null! } },
            "comments" => f with { Graph = f.Graph with { Comments = null! } },
            "comment" => f with { Comment = null! },
            "temporal" => f with { Temporal = null! },
            "map" => f with { Map = null! },
            "expected" => f with { Expected = null! },
            "allocation" => f with { Expected = f.Expected with { Allocation = null! } },
            "reference" => f with { Expected = f.Expected with { BindingReference = null! } },
            "roster" => f with { Expected = f.Expected with { FactoryRoles = null! } },
            _ => throw new InvalidOperationException(member)
        };
        Assert.Throws<ArgumentNullException>(() => Bind(f));
    }

    private static CommentScaleInitialOutboxFacts Bind(Fixture f)
        => CommentScaleNativeBindingAdapter.BindInitialOutboxFacts(f.Plan, f.Graph, "root", "initial.comment",
            f.Comment, "outbox", f.Temporal, f.Map, f.Expected);

    private sealed record Fixture(CommentScalePlan Plan, CommentScaleResolvedGraphIntent Graph, Comment Comment,
        ResolvedTemporalRoleContext Temporal, DataScaleNativeCommentBindings Map, CommentScaleNativeBindingExpectation Expected,
        Dictionary<DataScaleNativeCommentRole, long> SourceIds);

    private static Fixture Create(string provider = "PostgreSql")
    {
        var request = new CommentScaleCommentRequest("root", null, null, CommentAuthorModes.Public,
            CommentScaleCredentialValidity.PublicAuthenticated, UnitDigest, "content.root",
            new("fsusblog.generated-content-shape.v1", UnitDigest), UnitDigest, "created",
            [new(null, CommentModerationStatus.Pending, "reason.initial", "created")]);
        var requirements = new CommentScaleGraphRequirements(Enum.GetValues<CommentScaleRelation>(),
            Enum.GetValues<CommentScaleAuthority>().Select(authority => new CommentScaleAuthorityReference(authority, new string('a', 40), UnitDigest)).ToArray());
        CommentScalePlan plan = new(CommentScalePlanContract.Schema, CommentScalePlanContract.GraphSchema,
            "unit-native", "scale-xs", 1, 1, new(ArticleScaleContractIds.PlanSchema, UnitDigest),
            new(ArticleScaleContractIds.ContentShapeCatalogSchema, UnitDigest), new(ArticleScaleContractIds.TemporalArtifactSchema, UnitDigest),
            [new("thread", CommentScaleThreadShape.WideRoots, "article.target", 1, [request], requirements)], string.Empty);
        plan = plan with
        {
            ContentDigest = CommentScalePlanContract.ComputeDigest(plan)
        };
        var occurrence = new CommentScaleGraphOccurrence("thread", 0, "article.target");
        ResolvedTemporalRoleContext temporal = Temporal();
        var site = new AnonymousCommentPolicySnapshot(true, true, true, CommentAuthorModes.ZkAnonymous, ["en"])
        {
            UpdatedAtUtc = s_time,
            SnapshotHash = UnitDigest
        };
        var article = new ArticleCommentPolicy
        {
            ArticleId = 42,
            UpdatedAtUtc = s_time,
            PolicyVersion = 2,
            ModerationMode = ArticleCommentModerationModes.RiskBased
        };
        var actor = new CommentActor(7, CommentAuthorModes.Public, "unit-handle", null, "unit-handle", "en", null, null, "unit-subject", "common", false);
        var region = new RegionModerationDecision(true, "GLOBAL", 1d, "synthetic-unit-only", null, [], [], [],
            "synthetic-unit-policy", "unit-reason", "unit-reason", false, false);
        var policies = new CommentScalePolicyFacts(42, null, site, article, null, actor, UnitDigest, region, UnitDigest, true, false, false, null);
        var frame = new CommentScaleGraphFactBindings(occurrence, plan.Namespace, plan.ContentDigest, plan.ArticlePlan.ContentDigest,
            "synthetic-article-owner-role", 42, new(ArticleScaleGraphIdentityBindings.Schema, UnitDigest),
            [new("root", request.ContentRole, request.ContentArtifact, policies)]);
        CommentScaleResolvedGraphIntent graph = Assert.Single(CanonicalCommentGraphFactory.ResolveIntentStream(plan, temporal, [frame]));
        var allocation = new DataScaleNativeAllocationReference("synthetic-unit-only-owner", new string('a', 40), UnitDigest);
        var ids = new Dictionary<DataScaleNativeCommentRole, long>
        {
            [new("thread", 0, "article.target", "root", DataScaleNativeCommentEntity.Comment, "initial.comment")] = 900007,
            [new("thread", 0, "article.target", "root", DataScaleNativeCommentEntity.Revision, "unit.revision")] = 910003,
            [new("thread", 0, "article.target", "root", DataScaleNativeCommentEntity.OutboxEnvelope, "unit.outbox")] = 920009
        };
        var map = new DataScaleNativeCommentBindings("unit-run", plan.Namespace, "unit-runtime", provider,
            plan.ContentDigest, plan.ArticlePlan.ContentDigest, allocation, ids);
        var expected = new CommentScaleNativeBindingExpectation(map.RunId, map.RuntimeIdentity, map.Provider, allocation,
            new(DataScaleNativeCommentBindings.Schema, map.Digest), ids.Keys.ToArray());
        var comment = new Comment
        {
            Id = 123,
            ArticleId = 42,
            CreateTime = s_time,
            Content = "synthetic normalized unit content",
            UserId = 7,
            AuthorMode = CommentAuthorModes.Public,
            ModerationStatus = CommentModerationStatus.Pending,
            ModerationReason = "article_policy_premoderated"
        };
        return new(plan, graph, comment, temporal, map, expected, ids);
    }

    private static ResolvedTemporalRoleContext Temporal(string digest = UnitDigest)
        => ResolvedTemporalRoleContext.Parse(JsonSerializer.Serialize(new
        {
            schema = "fsusblog.resolved-temporal-roles.v1",
            contextIdentity = new
            {
                producerId = "synthetic-unit-only",
                schedulerRunId = "synthetic-unit-only"
            },
            contentDigest = digest,
            roles = new[] { "created", "outbox" }.Select((role, index) => new
            {
                roleId = role,
                clockKind = "business-wall",
                semanticEffect = "included",
                precision = "millisecond",
                instantUtc = s_time.AddMilliseconds(index).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture)
            })
        }), digest);
}
