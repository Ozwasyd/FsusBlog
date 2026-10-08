using System.Text.Json;
using System.Text.Json.Nodes;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Services.Fixtures.DataScale;
using FsusBlog.Server.Services.Moderation;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>
/// Synthetic unit inputs exercise structural refusal only. Their digests, authority
/// references and temporal envelope are not canonical artifacts or execution evidence.
/// </summary>
public sealed class CommentScalePlanTests
{
    private const string SyntheticDigest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string OtherSyntheticDigest = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private const string SyntheticSourceCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    [Fact]
    public void Inspect_ReportsOnlyStructuralValidityForSyntheticReferences()
    {
        CommentScalePlan plan = SyntheticPlan();

        CommentScalePlanInspection inspection = Inspect(plan);

        Assert.True(inspection.IsStructurallyValid);
        Assert.Empty(inspection.Errors);
        Assert.Equal(CommentScalePlanContract.Schema, plan.Schema);
        Assert.Equal(CommentScalePlanContract.GraphSchema, plan.GraphSchema);
        Assert.Equal(6, plan.CommentCount);
        Assert.Equal(3, plan.ArticleCount);
        Assert.Equal("synthetic-unit-only", SyntheticTemporal().ProducerId);
        Assert.Equal(SyntheticDigest, plan.Temporal.ContentDigest);
    }

    [Fact]
    public void Digest_BindsCompletePlanAndIgnoresOnlyItsOwnDigestSlot()
    {
        CommentScalePlan plan = SyntheticPlan();

        Assert.Equal(plan.ContentDigest, CommentScalePlanContract.ComputeDigest(plan));
        Assert.Equal(plan.ContentDigest, CommentScalePlanContract.ComputeDigest(plan with
        {
            ContentDigest = OtherSyntheticDigest
        }));
        Assert.NotEqual(plan.ContentDigest, CommentScalePlanContract.ComputeDigest(plan with
        {
            Namespace = "other-unit"
        }));
        Assert.NotEqual(plan.ContentDigest, CommentScalePlanContract.ComputeDigest(ChangeRequest(plan,
            request => request with { ActorEvidenceDigest = OtherSyntheticDigest })));
        Assert.NotEqual(plan.ContentDigest, CommentScalePlanContract.ComputeDigest(ChangeScenario(plan,
            scenario => scenario with
            {
                Graph = scenario.Graph with
                {
                    Authorities = scenario.Graph.Authorities.Select(reference => reference with
                    {
                        ContractDigest = OtherSyntheticDigest
                    }).ToArray()
                }
            })));
        Assert.Contains("plan_digest", Inspect(plan with
        {
            Namespace = "tampered-unit"
        }).Errors);
    }

    [Fact]
    public void Parse_RoundTripsClosedPlanWithoutAdmittingProductionSemantics()
    {
        CommentScalePlan plan = SyntheticPlan();

        CommentScalePlan parsed = CommentScalePlanContract.Parse(JsonSerializer.Serialize(plan));

        Assert.Equal(plan.ContentDigest, CommentScalePlanContract.ComputeDigest(parsed));
        Assert.True(Inspect(parsed).IsStructurallyValid);
    }

    [Theory]
    [InlineData("plan")]
    [InlineData("artifact")]
    [InlineData("scenario")]
    [InlineData("request")]
    [InlineData("step")]
    [InlineData("graph")]
    [InlineData("authority")]
    public void Parse_RejectsUnknownMembersAtEveryContractBoundary(string boundary)
    {
        JsonObject root = JsonNode.Parse(JsonSerializer.Serialize(SyntheticPlan()))!.AsObject();
        JsonObject scenario = root["Scenarios"]![0]!.AsObject();
        JsonObject request = scenario["Comments"]![0]!.AsObject();
        JsonObject graph = scenario["Graph"]!.AsObject();
        JsonObject target = boundary switch
        {
            "plan" => root,
            "artifact" => root["ArticlePlan"]!.AsObject(),
            "scenario" => scenario,
            "request" => request,
            "step" => request["Moderation"]![0]!.AsObject(),
            "graph" => graph,
            "authority" => graph["Authorities"]![0]!.AsObject(),
            _ => throw new InvalidOperationException(boundary)
        };
        target["UnownedField"] = true;

        Assert.Throws<JsonException>(() => CommentScalePlanContract.Parse(root.ToJsonString()));
    }

    [Fact]
    public void Parse_RejectsMissingRootNullInputAndOversizedPayload()
    {
        Assert.Throws<JsonException>(() => CommentScalePlanContract.Parse("null"));
        Assert.Throws<ArgumentNullException>(() => CommentScalePlanContract.Parse(null!));
        InvalidOperationException failure = Assert.Throws<InvalidOperationException>(
            () => CommentScalePlanContract.Parse(new string(' ', 1024 * 1024 + 1)));
        Assert.Equal("comment_scale_plan_size_limit", failure.Message);
    }

    [Theory]
    [InlineData("plan", "Schema")]
    [InlineData("artifact", "ContentDigest")]
    [InlineData("scenario", "Repetitions")]
    [InlineData("request", "ParentRole")]
    [InlineData("step", "Previous")]
    [InlineData("graph", "Authorities")]
    [InlineData("authority", "SourceCommit")]
    public void Parse_RejectsMissingRequiredMembersIncludingNullableConstructorSlots(string boundary, string member)
    {
        JsonObject root = JsonNode.Parse(JsonSerializer.Serialize(SyntheticPlan()))!.AsObject();
        JsonObject target = JsonBoundary(root, boundary);
        Assert.True(target.Remove(member));

        Assert.Throws<JsonException>(() => CommentScalePlanContract.Parse(root.ToJsonString()));
    }

    [Theory]
    [InlineData("plan")]
    [InlineData("artifact")]
    [InlineData("scenario")]
    [InlineData("request")]
    [InlineData("step")]
    [InlineData("graph")]
    [InlineData("authority")]
    public void Parse_RejectsDuplicateMembersEvenWhenTheirValuesAreIdentical(string boundary)
    {
        JsonObject root = JsonNode.Parse(JsonSerializer.Serialize(SyntheticPlan()))!.AsObject();
        JsonObject target = JsonBoundary(root, boundary);
        KeyValuePair<string, JsonNode?> member = target.First();
        string original = target.ToJsonString();
        string duplicate = original[..^1] + "," + JsonSerializer.Serialize(member.Key)
            + ":" + (member.Value?.ToJsonString() ?? "null") + "}";
        string json = root.ToJsonString().Replace(original, duplicate, StringComparison.Ordinal);

        Assert.Throws<JsonException>(() => CommentScalePlanContract.Parse(json));
    }

    [Theory]
    [InlineData("plan-schema", "plan_schema")]
    [InlineData("graph-schema", "graph_schema")]
    [InlineData("namespace", "plan_identity")]
    [InlineData("tier", "plan_identity")]
    [InlineData("negative-count", "plan_counts")]
    [InlineData("count-mismatch", "allocation_counts")]
    [InlineData("article-schema", "article_artifact")]
    [InlineData("content-digest", "content_artifact")]
    [InlineData("temporal-binding", "temporal_artifact")]
    public void Inspect_RejectsInvalidTopLevelBindings(string mutation, string expectedError)
    {
        CommentScalePlan plan = SyntheticPlan();
        plan = mutation switch
        {
            "plan-schema" => plan with { Schema = "unowned.v2" },
            "graph-schema" => plan with { GraphSchema = "unowned.v2" },
            "namespace" => plan with { Namespace = "contains spaces" },
            "tier" => plan with { ScaleTier = new string('a', 129) },
            "negative-count" => plan with { CommentCount = -1 },
            "count-mismatch" => plan with { ArticleCount = 4 },
            "article-schema" => plan with { ArticlePlan = plan.ArticlePlan with { Schema = "unowned.v2" } },
            "content-digest" => plan with { Content = plan.Content with { ContentDigest = "sha256:invalid" } },
            "temporal-binding" => plan with { Temporal = plan.Temporal with { ContentDigest = OtherSyntheticDigest } },
            _ => throw new InvalidOperationException(mutation)
        };

        Assert.Contains(expectedError, Inspect(Seal(plan)).Errors);
    }

    [Theory]
    [InlineData("scenarios", "scenarios_missing")]
    [InlineData("scenario", "scenario_missing")]
    [InlineData("comments", "comments_missing")]
    [InlineData("request", "comment_request_missing")]
    [InlineData("moderation", "moderation_missing")]
    [InlineData("step", "moderation_step_missing")]
    [InlineData("graph", "graph_requirements_missing")]
    [InlineData("relations", "graph_requirements_missing")]
    [InlineData("authorities", "graph_requirements_missing")]
    [InlineData("authority", "graph_authorities")]
    [InlineData("article", "article_artifact")]
    [InlineData("content", "content_artifact")]
    [InlineData("generated-content", "generated_content_artifact")]
    [InlineData("temporal", "temporal_artifact")]
    public void Inspect_FailsClosedForNullMembersWithoutDereferencingThem(string member, string expectedError)
    {
        CommentScalePlan plan = SyntheticPlan();
        plan = member switch
        {
            "scenarios" => plan with { Scenarios = null! },
            "scenario" => plan with { Scenarios = [null!] },
            "comments" => ChangeScenario(plan, scenario => scenario with { Comments = null! }),
            "request" => ChangeScenario(plan, scenario => scenario with { Comments = [null!] }),
            "moderation" => ChangeRequest(plan, request => request with { Moderation = null! }),
            "step" => ChangeRequest(plan, request => request with { Moderation = [null!] }),
            "graph" => ChangeScenario(plan, scenario => scenario with { Graph = null! }),
            "relations" => ChangeScenario(plan, scenario => scenario with { Graph = scenario.Graph with { Relations = null! } }),
            "authorities" => ChangeScenario(plan, scenario => scenario with { Graph = scenario.Graph with { Authorities = null! } }),
            "authority" => ChangeScenario(plan, scenario => scenario with { Graph = scenario.Graph with { Authorities = [null!] } }),
            "article" => plan with { ArticlePlan = null! },
            "content" => plan with { Content = null! },
            "generated-content" => ChangeRequest(plan, request => request with { ContentArtifact = null! }),
            "temporal" => plan with { Temporal = null! },
            _ => throw new InvalidOperationException(member)
        };

        Assert.Contains(expectedError, Inspect(Seal(plan)).Errors);
    }

    [Fact]
    public void Inspect_RejectsOverflowBeforeAnyGraphRowAllocation()
    {
        CommentScalePlan plan = ChangeScenario(SyntheticPlan(), scenario => scenario with { Repetitions = long.MaxValue });

        Assert.Contains("allocation_overflow", Inspect(Seal(plan)).Errors);
    }

    [Theory]
    [InlineData("zero-repetitions", "scenario_repetitions")]
    [InlineData("unknown-shape", "thread_shape")]
    [InlineData("empty-nonzero-shape", "zero_comment_allocation")]
    [InlineData("nonempty-zero-shape", "zero_comment_allocation")]
    [InlineData("scenario-role", "scenario_role")]
    [InlineData("article-role", "article_target_role")]
    public void Inspect_RejectsInvalidScenarioAllocation(string mutation, string expectedError)
    {
        CommentScalePlan plan = ChangeScenario(SyntheticPlan(), scenario => mutation switch
        {
            "zero-repetitions" => scenario with { Repetitions = 0 },
            "unknown-shape" => scenario with { ThreadShape = (CommentScaleThreadShape)999 },
            "empty-nonzero-shape" => scenario with { Comments = [] },
            "nonempty-zero-shape" => scenario with { ThreadShape = CommentScaleThreadShape.ZeroCommentArticle },
            "scenario-role" => scenario with { Role = "" },
            "article-role" => scenario with { ArticleTargetRole = "unowned role" },
            _ => throw new InvalidOperationException(mutation)
        });

        Assert.Contains(expectedError, Inspect(Seal(plan)).Errors);
    }

    [Fact]
    public void Inspect_AcceptsZeroCommentArticlesAndRejectsDuplicateScenarioRoles()
    {
        CommentScalePlan plan = SyntheticPlan();
        CommentScaleScenario zero = plan.Scenarios[0] with
        {
            ThreadShape = CommentScaleThreadShape.ZeroCommentArticle,
            Comments = []
        };
        Assert.True(Inspect(Seal(plan with
        {
            Scenarios = [zero],
            CommentCount = 0
        })).IsStructurallyValid);
        Assert.Contains("scenario_role", Inspect(Seal(plan with
        {
            Scenarios = [plan.Scenarios[0], plan.Scenarios[0]],
            CommentCount = 12,
            ArticleCount = 6
        })).Errors);
    }

    [Fact]
    public void Inspect_RejectsOverlappingArticleTargetsAcrossDistinctScenarioRoles()
    {
        CommentScalePlan plan = SyntheticPlan();
        CommentScaleScenario second = plan.Scenarios[0] with
        {
            Role = "other-thread"
        };

        Assert.Contains("article_target_role", Inspect(Seal(plan with
        {
            Scenarios = [plan.Scenarios[0], second],
            CommentCount = 12,
            ArticleCount = 6
        })).Errors);
    }

    [Theory]
    [InlineData("missing-relation", "graph_relations")]
    [InlineData("duplicate-relation", "graph_relations")]
    [InlineData("unknown-relation", "graph_relations")]
    [InlineData("missing-authority", "graph_authorities")]
    [InlineData("duplicate-authority", "graph_authorities")]
    [InlineData("unknown-authority", "graph_authorities")]
    [InlineData("commit", "graph_authorities")]
    [InlineData("contract-digest", "graph_authorities")]
    public void Inspect_RequiresEveryRelationAndExactAuthorityIdentity(string mutation, string expectedError)
    {
        CommentScalePlan plan = ChangeScenario(SyntheticPlan(), scenario => scenario with
        {
            Graph = mutation switch
            {
                "missing-relation" => scenario.Graph with { Relations = scenario.Graph.Relations.Skip(1).ToArray() },
                "duplicate-relation" => scenario.Graph with { Relations = scenario.Graph.Relations.Select(_ => CommentScaleRelation.ArticleTarget).ToArray() },
                "unknown-relation" => scenario.Graph with { Relations = scenario.Graph.Relations.Select(_ => (CommentScaleRelation)999).ToArray() },
                "missing-authority" => scenario.Graph with { Authorities = scenario.Graph.Authorities.Skip(1).ToArray() },
                "duplicate-authority" => scenario.Graph with { Authorities = scenario.Graph.Authorities.Select(reference => reference with { Authority = CommentScaleAuthority.Thread }).ToArray() },
                "unknown-authority" => scenario.Graph with { Authorities = scenario.Graph.Authorities.Select(reference => reference with { Authority = (CommentScaleAuthority)999 }).ToArray() },
                "commit" => scenario.Graph with { Authorities = scenario.Graph.Authorities.Select(reference => reference with { SourceCommit = "branch-name" }).ToArray() },
                "contract-digest" => scenario.Graph with { Authorities = scenario.Graph.Authorities.Select(reference => reference with { ContractDigest = "sha256:" + new string('A', 64) }).ToArray() },
                _ => throw new InvalidOperationException(mutation)
            }
        });

        Assert.Contains(expectedError, Inspect(Seal(plan)).Errors);
    }

    [Theory]
    [InlineData("public", CommentScaleCredentialValidity.PublicAuthenticated, true)]
    [InlineData("public", CommentScaleCredentialValidity.VerifiedTestCredential, false)]
    [InlineData("public", CommentScaleCredentialValidity.ScaleSyntheticTestOnly, false)]
    [InlineData("zk_anonymous", CommentScaleCredentialValidity.PublicAuthenticated, false)]
    [InlineData("zk_anonymous", CommentScaleCredentialValidity.VerifiedTestCredential, true)]
    [InlineData("zk_anonymous", CommentScaleCredentialValidity.ScaleSyntheticTestOnly, true)]
    [InlineData("public", (CommentScaleCredentialValidity)999, false)]
    public void Inspect_KeepsCredentialClassesExplicitWithoutAuthenticatingEvidence(
        string actorMode,
        CommentScaleCredentialValidity validity,
        bool structurallyAllowed)
    {
        CommentScalePlan plan = Seal(ChangeRequest(SyntheticPlan(), request => request with
        {
            ActorMode = actorMode,
            CredentialValidity = validity
        }));

        Assert.Equal(structurallyAllowed, Inspect(plan).IsStructurallyValid);
        if (!structurallyAllowed)
        {
            Assert.Contains("credential_class", Inspect(plan).Errors);
        }
    }

    [Theory]
    [InlineData("anonymous")]
    [InlineData("legacy_server_visible_pseudonymous")]
    [InlineData("Public")]
    [InlineData("")]
    public void Inspect_RejectsLegacyUnknownAndCaseVariantActors(string actorMode)
    {
        CommentScalePlan plan = ChangeRequest(SyntheticPlan(), request => request with { ActorMode = actorMode });

        Assert.Contains("actor_mode", Inspect(Seal(plan)).Errors);
    }

    [Theory]
    [InlineData("self-parent", "parent_role")]
    [InlineData("future-parent", "parent_role")]
    [InlineData("future-reply", "reply_target_role")]
    [InlineData("half-reply", "reply_request")]
    [InlineData("content-role", "content_role")]
    [InlineData("evidence", "evidence_digest")]
    [InlineData("generated-content-schema", "generated_content_artifact")]
    [InlineData("generated-content-digest", "generated_content_artifact")]
    [InlineData("missing-time", "temporal_role_missing")]
    [InlineData("invalid-time", "temporal_role_invalid")]
    public void Inspect_RejectsUnresolvedRequestBindings(string mutation, string expectedError)
    {
        CommentScalePlan plan = ChangeRequest(SyntheticPlan(), request => mutation switch
        {
            "self-parent" => request with { ParentRole = request.Role, ReplyTargetRole = request.Role },
            "future-parent" => request with { ParentRole = "reply", ReplyTargetRole = "reply" },
            "future-reply" => request with { ParentRole = null, ReplyTargetRole = "future" },
            "half-reply" => request with { ParentRole = null, ReplyTargetRole = "root" },
            "content-role" => request with { ContentRole = "content with spaces" },
            "evidence" => request with { RegionEvidenceDigest = "" },
            "generated-content-schema" => request with { ContentArtifact = request.ContentArtifact with { Schema = "unowned.v2" } },
            "generated-content-digest" => request with { ContentArtifact = request.ContentArtifact with { ContentDigest = "sha256:invalid" } },
            "missing-time" => request with { CreatedAtRole = "unresolved" },
            "invalid-time" => request with { CreatedAtRole = "invalid time" },
            _ => throw new InvalidOperationException(mutation)
        });

        Assert.Contains(expectedError, Inspect(Seal(plan)).Errors);
    }

    [Fact]
    public void Inspect_RejectsDuplicateCommentRolesWithinTheTemplate()
    {
        CommentScalePlan plan = ChangeScenario(SyntheticPlan(), scenario => scenario with
        {
            Comments = [scenario.Comments[0], scenario.Comments[0]]
        });

        Assert.Contains("comment_role", Inspect(Seal(plan)).Errors);
    }

    [Fact]
    public void Inspect_UsesActualProductionTransitionsForEveryStatusPair()
    {
        foreach (CommentModerationStatus from in Enum.GetValues<CommentModerationStatus>())
        {
            foreach (CommentModerationStatus to in Enum.GetValues<CommentModerationStatus>())
            {
                CommentScalePlan plan = ChangeRequest(SyntheticPlan(), request => request with
                {
                    Moderation =
                    [
                        new(null, from, "initial", "created"),
                        new(from, to, "decision", "later")
                    ]
                });

                Assert.Equal(CommentModerationTransitions.IsAllowed(from, to), Inspect(Seal(plan)).IsStructurallyValid);
            }
        }
    }

    [Theory]
    [InlineData("initial-previous", "moderation_continuity")]
    [InlineData("disconnected", "moderation_continuity")]
    [InlineData("unknown-status", "moderation_continuity")]
    [InlineData("empty", "moderation_missing")]
    [InlineData("invalid-reason", "moderation_reason_role")]
    [InlineData("before-created", "moderation_time_order")]
    [InlineData("reverse-time", "moderation_time_order")]
    public void Inspect_RejectsTimelineGapsAndTemporalDrift(string mutation, string expectedError)
    {
        CommentScalePlan plan = ChangeRequest(SyntheticPlan(), request => request with
        {
            Moderation = mutation switch
            {
                "initial-previous" => [new(CommentModerationStatus.Hidden, CommentModerationStatus.Pending, "initial", "created")],
                "disconnected" => [new(null, CommentModerationStatus.Pending, "initial", "created"), new(CommentModerationStatus.Hidden, CommentModerationStatus.Approved, "decision", "later")],
                "unknown-status" => [new(null, (CommentModerationStatus)999, "initial", "created")],
                "empty" => [],
                "invalid-reason" => [new(null, CommentModerationStatus.Pending, "", "created")],
                "before-created" => [new(null, CommentModerationStatus.Pending, "initial", "earlier")],
                "reverse-time" => [new(null, CommentModerationStatus.Pending, "initial", "later"), new(CommentModerationStatus.Pending, CommentModerationStatus.Approved, "decision", "created")],
                _ => throw new InvalidOperationException(mutation)
            }
        });

        Assert.Contains(expectedError, Inspect(Seal(plan)).Errors);
    }

    private static CommentScalePlanInspection Inspect(CommentScalePlan plan)
        => CommentScalePlanContract.Inspect(plan, SyntheticTemporal());

    private static JsonObject JsonBoundary(JsonObject root, string boundary)
    {
        JsonObject scenario = root["Scenarios"]![0]!.AsObject();
        JsonObject request = scenario["Comments"]![0]!.AsObject();
        JsonObject graph = scenario["Graph"]!.AsObject();
        return boundary switch
        {
            "plan" => root,
            "artifact" => root["ArticlePlan"]!.AsObject(),
            "scenario" => scenario,
            "request" => request,
            "step" => request["Moderation"]![0]!.AsObject(),
            "graph" => graph,
            "authority" => graph["Authorities"]![0]!.AsObject(),
            _ => throw new InvalidOperationException(boundary)
        };
    }

    private static CommentScalePlan Seal(CommentScalePlan plan)
        => plan with
        {
            ContentDigest = CommentScalePlanContract.ComputeDigest(plan)
        };

    private static CommentScalePlan ChangeScenario(
        CommentScalePlan plan,
        Func<CommentScaleScenario, CommentScaleScenario> change)
        => plan with
        {
            Scenarios = [change(plan.Scenarios[0])]
        };

    private static CommentScalePlan ChangeRequest(
        CommentScalePlan plan,
        Func<CommentScaleCommentRequest, CommentScaleCommentRequest> change)
        => ChangeScenario(plan, scenario => scenario with
        {
            Comments = [change(scenario.Comments[0]), scenario.Comments[1]]
        });

    private static CommentScalePlan SyntheticPlan()
    {
        var root = new CommentScaleCommentRequest(
            "root", null, null, CommentAuthorModes.Public,
            CommentScaleCredentialValidity.PublicAuthenticated,
            SyntheticDigest, "content.root",
            new("fsusblog.generated-content-shape.v1", SyntheticDigest),
            SyntheticDigest, "created",
            [new(null, CommentModerationStatus.Pending, "initial", "created")]);
        var reply = root with
        {
            Role = "reply",
            ParentRole = "root",
            ReplyTargetRole = "root"
        };
        var graph = new CommentScaleGraphRequirements(
            Enum.GetValues<CommentScaleRelation>(),
            Enum.GetValues<CommentScaleAuthority>().Select(authority =>
                new CommentScaleAuthorityReference(authority, SyntheticSourceCommit, SyntheticDigest)).ToArray());
        return Seal(new CommentScalePlan(
            CommentScalePlanContract.Schema,
            CommentScalePlanContract.GraphSchema,
            "synthetic-unit-only",
            "unit-tier",
            6,
            3,
            new(ArticleScaleContractIds.PlanSchema, SyntheticDigest),
            new(ArticleScaleContractIds.ContentShapeCatalogSchema, SyntheticDigest),
            new(ArticleScaleContractIds.TemporalArtifactSchema, SyntheticDigest),
            [new("thread", CommentScaleThreadShape.DeepChain, "article.target", 3, [root, reply], graph)],
            string.Empty));
    }

    private static ResolvedTemporalRoleContext SyntheticTemporal()
    {
        // No artifact is written, scheduler invoked or authority receipt produced.
        string envelope = JsonSerializer.Serialize(new
        {
            schema = "fsusblog.resolved-temporal-roles.v1",
            contextIdentity = new
            {
                producerId = "synthetic-unit-only",
                schedulerRunId = "synthetic-unit-only"
            },
            roles = new[]
            {
                (Role: "earlier", Instant: "2024-02-29T23:59:58.000Z"),
                (Role: "created", Instant: "2024-02-29T23:59:59.000Z"),
                (Role: "later", Instant: "2024-03-01T00:00:00.000Z")
            }.Select(role => new
            {
                roleId = role.Role,
                clockKind = "business-wall",
                semanticEffect = "included",
                precision = "millisecond",
                instantUtc = role.Instant
            }),
            contentDigest = SyntheticDigest
        });
        return ResolvedTemporalRoleContext.Parse(envelope, SyntheticDigest);
    }
}
