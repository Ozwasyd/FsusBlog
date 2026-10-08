using System.Collections;
using System.Text.Json;
using System.Text.Json.Nodes;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Fixtures;
using FsusBlog.Server.Services.Fixtures.DataScale;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>
/// Synthetic unit-only reference schedules and temporal inputs test closed shape,
/// ordering and preservation. They construct no production command, secret, graph
/// row, owner observation, canonical artifact or qualification receipt.
/// </summary>
public sealed class CommentScaleMutationScheduleTests
{
    private const string SyntheticDigest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string DifferentSyntheticDigest = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private const string SyntheticSource = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static readonly DateTime s_unitTime = new(2024, 3, 1, 0, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void Intents_ReferenceAllSixOriginalCommandTypesWithoutSerializingCommands()
    {
        (CommentScaleMutationIntent Intent, Type Command, string Operation)[] cases =
        [
            (new CommentScaleEditIntent("content.edit", ContentArtifact()), typeof(CommentFixtureEdit), "edit"),
            (new CommentScaleSoftDeleteIntent(), typeof(CommentFixtureSoftDelete), "soft-delete"),
            (new CommentScaleModerateIntent(CommentModerationStatus.Hidden, "actor.admin", null, "claim.root"), typeof(CommentFixtureModerate), "moderate"),
            (new CommentScaleReportIntent("actor.reporter", "reason.report", null), typeof(CommentFixtureReport), "report"),
            (new CommentScaleAppealIntent("reason.appeal", "decision.root"), typeof(CommentFixtureAppeal), "appeal"),
            (new CommentScaleReviewAppealIntent("appeal.root", "actor.reviewer", "decision.review", "reason.review", "decision.root"), typeof(CommentFixtureReviewAppeal), "review-appeal")
        ];

        foreach ((CommentScaleMutationIntent intent, Type command, string operation) in cases)
        {
            Assert.Equal(command, intent.ProductionCommandType);
            string json = JsonSerializer.Serialize<CommentScaleMutationIntent>(intent);
            using JsonDocument document = JsonDocument.Parse(json);
            Assert.Equal(operation, document.RootElement.GetProperty("operation").GetString());
            Assert.False(document.RootElement.TryGetProperty("ProductionCommandType", out _));
            Assert.DoesNotContain("ClaimToken", json, StringComparison.Ordinal);
            Assert.DoesNotContain("CapabilitySecret", json, StringComparison.Ordinal);
            Assert.DoesNotContain("Challenge", json, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void Parse_RoundTripsTheOneVersionTwoPlanWithItsCompleteInterleavedSchedule()
    {
        CommentScalePlan plan = Plan();

        CommentScalePlan parsed = CommentScalePlanContract.Parse(JsonSerializer.Serialize(plan));

        Assert.Equal("fsusblog.comment-scale-plan.v2", parsed.Schema);
        Assert.Equal(plan.ContentDigest, parsed.ContentDigest);
        Assert.Equal(plan.Scenarios[0].Mutations, parsed.Scenarios[0].Mutations);
        Assert.True(Inspect(parsed).IsStructurallyValid);
        Assert.Equal(new[] { "edit.root", "report.child", "moderate.root", "appeal.root", "review.root", "delete.root" },
            parsed.Scenarios[0].Mutations.Select(item => item.Role));
        Assert.Equal(new[] { "root", "child", "edit.root", "moderate.root", "appeal.root", "review.root" },
            parsed.Scenarios[0].Mutations.Select(item => item.PreviousStateRole));
    }

    [Fact]
    public void InspectAndFactory_RejectOldVersionOneBeforeAnyFactEnumeration()
    {
        CommentScalePlan plan = Seal(Plan() with
        {
            Schema = "fsusblog.comment-scale-plan.v1"
        });
        var facts = new ObservedFacts([]);

        Assert.Contains("plan_schema", Inspect(plan).Errors);
        Assert.Throws<InvalidOperationException>(() => CanonicalCommentGraphFactory
            .ResolveIntentStream(plan, Temporal(), facts).ToArray());
        Assert.Equal(0, facts.GetEnumeratorCalls);
    }

    [Fact]
    public void Parse_RequiresExplicitMutationScheduleIncludingAnEmptySchedule()
    {
        CommentScalePlan plan = ChangeSchedule(Plan(), []);
        JsonObject root = JsonPlan(plan);
        JsonObject scenario = ScenarioJson(root);
        Assert.Empty(scenario["Mutations"]!.AsArray());
        Assert.True(Inspect(CommentScalePlanContract.Parse(root.ToJsonString())).IsStructurallyValid);
        Assert.True(scenario.Remove("Mutations"));

        Assert.Throws<JsonException>(() => CommentScalePlanContract.Parse(root.ToJsonString()));
    }

    [Theory]
    [InlineData("scenario")]
    [InlineData("mutation")]
    [InlineData("payload")]
    [InlineData("artifact")]
    public void Parse_RejectsUnknownMembersAcrossScheduleBoundaries(string boundary)
    {
        JsonObject root = JsonPlan(Plan());
        JsonObject target = Boundary(root, boundary);
        target["InventedAdmission"] = true;

        Assert.Throws<JsonException>(() => CommentScalePlanContract.Parse(root.ToJsonString()));
    }

    [Theory]
    [InlineData("scenario")]
    [InlineData("mutation")]
    [InlineData("payload")]
    [InlineData("artifact")]
    public void Parse_RejectsDuplicateJsonMembersEvenWithIdenticalValues(string boundary)
    {
        JsonObject root = JsonPlan(Plan());
        JsonObject target = Boundary(root, boundary);
        KeyValuePair<string, JsonNode?> member = target.First();
        string original = target.ToJsonString();
        string duplicate = original[..^1] + "," + JsonSerializer.Serialize(member.Key)
            + ":" + (member.Value?.ToJsonString() ?? "null") + "}";
        string json = root.ToJsonString().Replace(original, duplicate, StringComparison.Ordinal);

        Assert.Throws<JsonException>(() => CommentScalePlanContract.Parse(json));
    }

    [Theory]
    [InlineData("Role")]
    [InlineData("CommentRole")]
    [InlineData("PreviousStateRole")]
    [InlineData("OccurredAtRole")]
    [InlineData("ActorEvidenceDigest")]
    [InlineData("SecurityEvidenceDigest")]
    [InlineData("PolicyDigest")]
    [InlineData("CommandSourceCommit")]
    [InlineData("CommandContractDigest")]
    [InlineData("Intent")]
    public void Parse_RejectsMissingRequiredMutationFields(string member)
    {
        JsonObject root = JsonPlan(Plan());
        Assert.True(MutationJson(root).Remove(member));

        Assert.Throws<JsonException>(() => CommentScalePlanContract.Parse(root.ToJsonString()));
    }

    [Theory]
    [InlineData("edit", "ContentRole")]
    [InlineData("edit", "ContentArtifact")]
    [InlineData("moderate", "ReasonRole")]
    [InlineData("report", "DetailRole")]
    [InlineData("appeal", "TargetDecisionFactsRole")]
    [InlineData("review-appeal", "AppealRole")]
    public void Parse_RejectsMissingPayloadFieldsIncludingNullableSlots(string operation, string member)
    {
        JsonObject root = JsonPlan(Plan());
        JsonObject payload = ScenarioJson(root)["Mutations"]!.AsArray()
            .Select(item => item!["Intent"]!.AsObject())
            .Single(item => item["operation"]!.GetValue<string>() == operation);
        Assert.True(payload.Remove(member));

        Assert.Throws<JsonException>(() => CommentScalePlanContract.Parse(root.ToJsonString()));
    }

    [Fact]
    public void Parse_RejectsAnUnknownOperationDiscriminator()
    {
        JsonObject root = JsonPlan(Plan());
        MutationJson(root)["Intent"]!["operation"] = "unregistered-operation";

        Assert.Throws<JsonException>(() => CommentScalePlanContract.Parse(root.ToJsonString()));
    }

    [Theory]
    [InlineData("schedule", "mutation_schedule_missing")]
    [InlineData("step", "mutation_step_missing")]
    [InlineData("role-blank", "mutation_role")]
    [InlineData("role-invalid", "mutation_role")]
    [InlineData("role-comment", "mutation_role")]
    [InlineData("role-duplicate", "mutation_role")]
    [InlineData("target", "mutation_target")]
    [InlineData("predecessor-initial", "mutation_predecessor")]
    [InlineData("predecessor-stale", "mutation_predecessor")]
    [InlineData("predecessor-other-comment", "mutation_predecessor")]
    [InlineData("predecessor-future", "mutation_predecessor")]
    [InlineData("actor-digest", "mutation_evidence")]
    [InlineData("security-digest", "mutation_evidence")]
    [InlineData("policy-digest", "mutation_evidence")]
    [InlineData("source", "mutation_authority")]
    [InlineData("source-uppercase", "mutation_authority")]
    [InlineData("contract-digest", "mutation_authority")]
    [InlineData("intent", "mutation_intent")]
    public void Inspect_RejectsMalformedScheduleIdentityAndAuthorityReferences(string mutation, string error)
    {
        CommentScalePlan plan = Plan();
        CommentScaleMutationRequest[] steps = plan.Scenarios[0].Mutations.ToArray();
        switch (mutation)
        {
            case "schedule":
                plan = ChangeSchedule(plan, null!);
                break;
            case "step":
                steps[0] = null!;
                break;
            case "role-blank":
                steps[0] = steps[0] with
                {
                    Role = ""
                };
                break;
            case "role-invalid":
                steps[0] = steps[0] with
                {
                    Role = "invalid role"
                };
                break;
            case "role-comment":
                steps[0] = steps[0] with
                {
                    Role = "root"
                };
                break;
            case "role-duplicate":
                steps[1] = steps[1] with
                {
                    Role = steps[0].Role
                };
                break;
            case "target":
                steps[0] = steps[0] with
                {
                    CommentRole = "unobserved-comment"
                };
                break;
            case "predecessor-initial":
                steps[0] = steps[0] with
                {
                    PreviousStateRole = "unobserved-state"
                };
                break;
            case "predecessor-stale":
                steps[2] = steps[2] with
                {
                    PreviousStateRole = "root"
                };
                break;
            case "predecessor-other-comment":
                steps[2] = steps[2] with
                {
                    PreviousStateRole = "report.child"
                };
                break;
            case "predecessor-future":
                steps[0] = steps[0] with
                {
                    PreviousStateRole = "moderate.root"
                };
                break;
            case "actor-digest":
                steps[0] = steps[0] with
                {
                    ActorEvidenceDigest = "invalid"
                };
                break;
            case "security-digest":
                steps[0] = steps[0] with
                {
                    SecurityEvidenceDigest = "invalid"
                };
                break;
            case "policy-digest":
                steps[0] = steps[0] with
                {
                    PolicyDigest = "invalid"
                };
                break;
            case "source":
                steps[0] = steps[0] with
                {
                    CommandSourceCommit = "unresolved"
                };
                break;
            case "source-uppercase":
                steps[0] = steps[0] with
                {
                    CommandSourceCommit = new string('A', 40)
                };
                break;
            case "contract-digest":
                steps[0] = steps[0] with
                {
                    CommandContractDigest = "invalid"
                };
                break;
            case "intent":
                steps[0] = steps[0] with
                {
                    Intent = null!
                };
                break;
            default:
                throw new InvalidOperationException(mutation);
        }
        if (mutation != "schedule")
        {
            plan = ChangeSchedule(plan, steps);
        }

        Assert.Contains(error, Inspect(plan).Errors);
    }

    [Theory]
    [InlineData("edit-role")]
    [InlineData("edit-schema")]
    [InlineData("edit-digest")]
    [InlineData("edit-artifact-null")]
    [InlineData("moderate-status")]
    [InlineData("moderate-admin")]
    [InlineData("moderate-reason")]
    [InlineData("moderate-claim")]
    [InlineData("report-actor")]
    [InlineData("report-reason")]
    [InlineData("report-detail")]
    [InlineData("appeal-reason")]
    [InlineData("appeal-decision")]
    [InlineData("review-actor")]
    [InlineData("review-decision")]
    [InlineData("review-reason")]
    [InlineData("review-target")]
    public void Inspect_RejectsMalformedFieldsInEveryReferencePayload(string mutation)
    {
        CommentScalePlan plan = Plan();
        CommentScaleMutationRequest[] steps = plan.Scenarios[0].Mutations.ToArray();
        int index = mutation.StartsWith("edit", StringComparison.Ordinal) ? 0
            : mutation.StartsWith("report", StringComparison.Ordinal) ? 1
            : mutation.StartsWith("moderate", StringComparison.Ordinal) ? 2
            : mutation.StartsWith("appeal", StringComparison.Ordinal) ? 3 : 4;
        CommentScaleMutationIntent intent = steps[index].Intent;
        intent = mutation switch
        {
            "edit-role" => ((CommentScaleEditIntent)intent) with { ContentRole = "invalid role" },
            "edit-schema" => ((CommentScaleEditIntent)intent) with { ContentArtifact = new("unowned.v2", SyntheticDigest) },
            "edit-digest" => ((CommentScaleEditIntent)intent) with { ContentArtifact = new("fsusblog.generated-content-shape.v1", "invalid") },
            "edit-artifact-null" => ((CommentScaleEditIntent)intent) with { ContentArtifact = null! },
            "moderate-status" => ((CommentScaleModerateIntent)intent) with { Status = (CommentModerationStatus)999 },
            "moderate-admin" => ((CommentScaleModerateIntent)intent) with { AdminActorRole = "" },
            "moderate-reason" => ((CommentScaleModerateIntent)intent) with { ReasonRole = "invalid role" },
            "moderate-claim" => ((CommentScaleModerateIntent)intent) with { ClaimFactsRole = "" },
            "report-actor" => ((CommentScaleReportIntent)intent) with { ReporterActorRole = "" },
            "report-reason" => ((CommentScaleReportIntent)intent) with { ReasonCodeRole = "" },
            "report-detail" => ((CommentScaleReportIntent)intent) with { DetailRole = "invalid role" },
            "appeal-reason" => ((CommentScaleAppealIntent)intent) with { ReasonRole = "" },
            "appeal-decision" => ((CommentScaleAppealIntent)intent) with { TargetDecisionFactsRole = "" },
            "review-actor" => ((CommentScaleReviewAppealIntent)intent) with { ReviewerActorRole = "" },
            "review-decision" => ((CommentScaleReviewAppealIntent)intent) with { DecisionRole = "" },
            "review-reason" => ((CommentScaleReviewAppealIntent)intent) with { ReasonRole = "" },
            "review-target" => ((CommentScaleReviewAppealIntent)intent) with { TargetDecisionFactsRole = "" },
            _ => throw new InvalidOperationException(mutation)
        };
        steps[index] = steps[index] with
        {
            Intent = intent
        };

        Assert.Contains("mutation_payload", Inspect(ChangeSchedule(plan, steps)).Errors);
    }

    [Theory]
    [InlineData("unknown")]
    [InlineData("not-appeal")]
    [InlineData("future")]
    [InlineData("other-comment")]
    public void Inspect_ReviewRequiresAPriorAppealForTheSameComment(string reference)
    {
        CommentScalePlan plan = Plan();
        CommentScaleMutationRequest[] steps = plan.Scenarios[0].Mutations.ToArray();
        string role = reference switch
        {
            "unknown" => "unobserved-appeal",
            "not-appeal" => "moderate.root",
            "future" => "delete.root",
            "other-comment" => "appeal.root",
            _ => throw new InvalidOperationException(reference)
        };
        if (reference == "other-comment")
        {
            steps[3] = steps[3] with
            {
                CommentRole = "child",
                PreviousStateRole = "report.child"
            };
            steps[4] = steps[4] with
            {
                PreviousStateRole = "moderate.root"
            };
        }
        steps[4] = steps[4] with
        {
            Intent = ((CommentScaleReviewAppealIntent)steps[4].Intent) with
            {
                AppealRole = role
            }
        };

        Assert.Contains("mutation_appeal_reference", Inspect(ChangeSchedule(plan, steps)).Errors);
    }

    [Theory]
    [InlineData("before-target", "mutation_time_order")]
    [InlineData("before-global-predecessor", "mutation_time_order")]
    [InlineData("missing", "temporal_role_missing")]
    [InlineData("invalid", "temporal_role_invalid")]
    public void Inspect_UsesOnlyExistingTemporalRolesAndGlobalScheduleOrder(string mutation, string error)
    {
        CommentScalePlan plan = Plan();
        CommentScaleMutationRequest[] steps = plan.Scenarios[0].Mutations.ToArray();
        int index = mutation == "before-global-predecessor" ? 1 : 0;
        string role = mutation switch
        {
            "before-target" => "before",
            "before-global-predecessor" => "created",
            "missing" => "unresolved-instant",
            "invalid" => "invalid role",
            _ => throw new InvalidOperationException(mutation)
        };
        steps[index] = steps[index] with
        {
            OccurredAtRole = role
        };

        Assert.Contains(error, Inspect(ChangeSchedule(plan, steps)).Errors);
    }

    [Fact]
    public void Inspect_AllowsEqualOriginalInstantsWithoutInventingOffsets()
    {
        CommentScalePlan plan = Plan();
        CommentScaleMutationRequest[] steps = plan.Scenarios[0].Mutations
            .Select(step => step with { OccurredAtRole = "created" }).ToArray();

        Assert.True(Inspect(ChangeSchedule(plan, steps)).IsStructurallyValid);
    }

    [Fact]
    public void Digest_BindsEveryMutationReferenceAndOrderedPayload()
    {
        CommentScalePlan plan = Plan();
        CommentScaleMutationRequest[] original = plan.Scenarios[0].Mutations.ToArray();
        CommentScaleMutationRequest[] changed = original.ToArray();
        changed[0] = changed[0] with
        {
            SecurityEvidenceDigest = DifferentSyntheticDigest
        };
        Assert.NotEqual(plan.ContentDigest, ChangeSchedule(plan, changed).ContentDigest);
        changed = original.ToArray();
        changed[0] = changed[0] with
        {
            CommandContractDigest = DifferentSyntheticDigest
        };
        Assert.NotEqual(plan.ContentDigest, ChangeSchedule(plan, changed).ContentDigest);
        changed = original.ToArray();
        changed[0] = changed[0] with
        {
            Intent = ((CommentScaleEditIntent)changed[0].Intent) with
            {
                ContentRole = "content.other"
            }
        };
        Assert.NotEqual(plan.ContentDigest, ChangeSchedule(plan, changed).ContentDigest);
        Assert.NotEqual(plan.ContentDigest, ChangeSchedule(plan, original.Reverse().ToArray()).ContentDigest);
        Assert.Contains("plan_digest", Inspect(plan with
        {
            Scenarios = [plan.Scenarios[0] with { Mutations = changed }]
        }).Errors);
    }

    [Fact]
    public void Inspect_ZeroCommentScenarioCannotInventAMutationTarget()
    {
        CommentScalePlan plan = Plan();
        plan = Seal(plan with
        {
            CommentCount = 0,
            Scenarios = [plan.Scenarios[0] with { Comments = [], ThreadShape = CommentScaleThreadShape.ZeroCommentArticle }]
        });

        Assert.Contains("mutation_target", Inspect(plan).Errors);
    }

    [Fact]
    public void Factory_PreservesReferenceRequestsAndRoleInstantsInAReadonlyList()
    {
        CommentScalePlan plan = Plan();
        ResolvedTemporalRoleContext temporal = Temporal();

        CommentScaleResolvedGraphIntent result = Assert.Single(CanonicalCommentGraphFactory
            .ResolveIntentStream(plan, temporal, Frames(plan)));

        Assert.Equal(plan.Scenarios[0].Mutations, result.Mutations.Select(item => item.Request));
        Assert.Equal(plan.Scenarios[0].Mutations.Select(item => temporal.RequireInstant(item.OccurredAtRole).UtcDateTime),
            result.Mutations.Select(item => item.OccurredAtUtc));
        Assert.True(((IList<CommentScaleResolvedMutationRequest>)result.Mutations).IsReadOnly);
        Assert.Throws<NotSupportedException>(() => ((IList<CommentScaleResolvedMutationRequest>)result.Mutations).Clear());
        Assert.Equal(new[] { "root", "child", "root", "root", "root", "root" },
            result.Mutations.Select(item => item.Request.CommentRole));
        Assert.Equal(plan.ContentDigest, result.CommentPlanDigest);
        // A resolved request remains a request; no command execution or success is inferred.
    }

    [Fact]
    public void Inspect_ReferenceContinuityDoesNotPredictSuccessfulExecutionAfterDelete()
    {
        CommentScalePlan plan = ChangeSchedule(Plan(),
        [
            Step("delete.root", "root", "root", 1, new CommentScaleSoftDeleteIntent()),
            Step("edit.after-delete", "root", "delete.root", 2, new CommentScaleEditIntent("content.edit", ContentArtifact()))
        ]);

        // The actual author command must decide deletion eligibility; these are requests.
        Assert.True(Inspect(plan).IsStructurallyValid);
    }

    [Fact]
    public void Inspect_AppealReferencesDoNotProveTargetStatusOrReviewDecisionFacts()
    {
        CommentScalePlan plan = ChangeSchedule(Plan(),
        [
            Step("appeal.root", "root", "root", 1, new CommentScaleAppealIntent("reason.appeal", "decision.root")),
            Step("review.root", "root", "appeal.root", 2,
                new CommentScaleReviewAppealIntent("appeal.root", "actor.reviewer", "decision.unresolved", "reason.review", "decision.root"))
        ]);

        // Initial requested status is Pending; actual target/decision facts remain absent.
        Assert.True(Inspect(plan).IsStructurallyValid);
    }

    [Fact]
    public void Factory_FreezesOriginalScheduleListsBeforeTheFirstYield()
    {
        CommentScalePlan initial = Plan();
        var steps = initial.Scenarios[0].Mutations.ToList();
        CommentScalePlan plan = Seal(initial with
        {
            ArticleCount = 2,
            CommentCount = 4,
            Scenarios = [initial.Scenarios[0] with { Repetitions = 2, Mutations = steps }]
        });
        CommentScaleMutationRequest[] expected = steps.ToArray();
        using IEnumerator<CommentScaleResolvedGraphIntent> input = CanonicalCommentGraphFactory
            .ResolveIntentStream(plan, Temporal(), Frames(plan)).GetEnumerator();
        Assert.True(input.MoveNext());

        steps.Clear();

        Assert.True(input.MoveNext());
        Assert.Equal(expected, input.Current.Mutations.Select(item => item.Request));
        Assert.Equal(6, input.Current.Mutations.Count);
        Assert.False(input.MoveNext());
    }

    [Fact]
    public void Factory_RejectsInvalidScheduleBeforeEnumeratingCallerFacts()
    {
        CommentScalePlan plan = Plan();
        CommentScaleMutationRequest[] steps = plan.Scenarios[0].Mutations.ToArray();
        steps[^1] = steps[^1] with
        {
            PreviousStateRole = "stale-state"
        };
        var facts = new ObservedFacts([]);

        InvalidOperationException failure = Assert.Throws<InvalidOperationException>(() => CanonicalCommentGraphFactory
            .ResolveIntentStream(ChangeSchedule(plan, steps), Temporal(), facts).ToArray());

        Assert.Contains("mutation_predecessor", failure.Message);
        Assert.Equal(0, facts.GetEnumeratorCalls);
    }

    private static CommentScalePlanInspection Inspect(CommentScalePlan plan)
        => CommentScalePlanContract.Inspect(plan, Temporal());

    private static JsonObject JsonPlan(CommentScalePlan plan)
        => JsonNode.Parse(JsonSerializer.Serialize(plan))!.AsObject();

    private static JsonObject ScenarioJson(JsonObject root) => root["Scenarios"]![0]!.AsObject();

    private static JsonObject MutationJson(JsonObject root) => ScenarioJson(root)["Mutations"]![0]!.AsObject();

    private static JsonObject Boundary(JsonObject root, string boundary)
        => boundary switch
        {
            "scenario" => ScenarioJson(root),
            "mutation" => MutationJson(root),
            "payload" => MutationJson(root)["Intent"]!.AsObject(),
            "artifact" => MutationJson(root)["Intent"]!["ContentArtifact"]!.AsObject(),
            _ => throw new InvalidOperationException(boundary)
        };

    private static CommentScalePlan ChangeSchedule(CommentScalePlan plan, IReadOnlyList<CommentScaleMutationRequest> steps)
        => Seal(plan with
        {
            Scenarios = [plan.Scenarios[0] with { Mutations = steps }]
        });

    private static CommentScalePlan Seal(CommentScalePlan plan)
        => plan with
        {
            ContentDigest = CommentScalePlanContract.ComputeDigest(plan)
        };

    private static CommentScaleArtifactReference ContentArtifact()
        => new("fsusblog.generated-content-shape.v1", SyntheticDigest);

    private static CommentScaleMutationRequest Step(string role, string target, string previous, int timeIndex, CommentScaleMutationIntent intent)
        => new(role, target, previous, "mutation." + timeIndex, SyntheticDigest, SyntheticDigest,
            SyntheticDigest, SyntheticSource, SyntheticDigest, intent);

    private static CommentScalePlan Plan()
    {
        var root = new CommentScaleCommentRequest("root", null, null, CommentAuthorModes.Public,
            CommentScaleCredentialValidity.PublicAuthenticated, SyntheticDigest, "content.root", ContentArtifact(),
            SyntheticDigest, "created", [new(null, CommentModerationStatus.Pending, "initial", "created")]);
        var child = root with
        {
            Role = "child",
            ParentRole = "root",
            ReplyTargetRole = "root",
            ContentRole = "content.child"
        };
        var graph = new CommentScaleGraphRequirements(Enum.GetValues<CommentScaleRelation>(),
            Enum.GetValues<CommentScaleAuthority>().Select(authority => new CommentScaleAuthorityReference(authority, SyntheticSource, SyntheticDigest)).ToArray());
        var scenario = new CommentScaleScenario("thread", CommentScaleThreadShape.DeepChain, "article.target", 1, [root, child], graph)
        {
            Mutations =
            [
                Step("edit.root", "root", "root", 1, new CommentScaleEditIntent("content.edit", ContentArtifact())),
                Step("report.child", "child", "child", 2, new CommentScaleReportIntent("actor.reporter", "reason.report", null)),
                Step("moderate.root", "root", "edit.root", 3, new CommentScaleModerateIntent(CommentModerationStatus.Hidden, "actor.admin", null, "claim.root")),
                Step("appeal.root", "root", "moderate.root", 4, new CommentScaleAppealIntent("reason.appeal", "decision.root")),
                Step("review.root", "root", "appeal.root", 5, new CommentScaleReviewAppealIntent("appeal.root", "actor.reviewer", "decision.review", "reason.review", "decision.root")),
                Step("delete.root", "root", "review.root", 6, new CommentScaleSoftDeleteIntent())
            ]
        };
        return Seal(new(CommentScalePlanContract.Schema, CommentScalePlanContract.GraphSchema,
            "synthetic-unit-only", "unit-tier", 2, 1,
            new(ArticleScaleContractIds.PlanSchema, SyntheticDigest),
            new(ArticleScaleContractIds.ContentShapeCatalogSchema, SyntheticDigest),
            new(ArticleScaleContractIds.TemporalArtifactSchema, SyntheticDigest), [scenario], string.Empty));
    }

    private static CommentScaleGraphFactBindings[] Frames(CommentScalePlan plan)
        => Enumerable.Range(0, checked((int)plan.Scenarios[0].Repetitions)).Select(index =>
            new CommentScaleGraphFactBindings(new("thread", index, "article.target"), plan.Namespace,
                plan.ContentDigest, plan.ArticlePlan.ContentDigest, "synthetic-article-" + index, index == 0 ? 7777 : 13,
                new("fsusblog.article-scale-graph-identity-bindings.v1", SyntheticDigest),
                plan.Scenarios[0].Comments.Select(request => new CommentScaleRequestFactBinding(request.Role, request.ContentRole,
                    request.ContentArtifact, PolicyFacts(request, index == 0 ? 7777 : 13))).ToArray())).ToArray();

    private static CommentScalePolicyFacts PolicyFacts(CommentScaleCommentRequest request, int articleId)
    {
        var site = new AnonymousCommentPolicySnapshot(true, true, true, CommentAuthorModes.ZkAnonymous, ["en"])
        {
            UpdatedAtUtc = s_unitTime,
            SnapshotHash = SyntheticDigest
        };
        var article = new ArticleCommentPolicy { ArticleId = articleId, UpdatedAtUtc = s_unitTime, PolicyVersion = 2, ModerationMode = ArticleCommentModerationModes.RiskBased };
        var actor = new CommentActor(7, CommentAuthorModes.Public, "unit-handle", null, "unit-handle", "en", null, null, "unit-subject", "common", false);
        var region = new RegionModerationDecision(true, "GLOBAL", 1d, "synthetic-unit-only", null, [], [], [], "synthetic-unit-policy", "unit-reason", "unit-reason", false, false);
        long? rootId = request.ParentRole is null ? null : 123456789;
        return new(articleId, rootId, site, article,
            rootId is null ? null : new CommentThreadPolicy { ArticleId = articleId, RootCommentId = rootId.Value, PolicyVersion = 3 },
            actor, SyntheticDigest, region, SyntheticDigest, true, false, false, request.ReplyTargetRole is null ? null : 8);
    }

    private static ResolvedTemporalRoleContext Temporal()
    {
        // Synthetic adapter envelope only; its digest grants no owner admission.
        string json = JsonSerializer.Serialize(new
        {
            schema = "fsusblog.resolved-temporal-roles.v1",
            contextIdentity = new
            {
                producerId = "synthetic-unit-only",
                schedulerRunId = "synthetic-unit-only"
            },
            contentDigest = SyntheticDigest,
            roles = new[] { "before", "created", "mutation.1", "mutation.2", "mutation.3", "mutation.4", "mutation.5", "mutation.6" }
                .Select((role, index) => new
                {
                    roleId = role,
                    clockKind = "business-wall",
                    semanticEffect = "included",
                    precision = "millisecond",
                    instantUtc = s_unitTime.AddMilliseconds(index - 1).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture)
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

        public IEnumerator<CommentScaleGraphFactBindings> GetEnumerator()
        {
            GetEnumeratorCalls++;
            return items.GetEnumerator();
        }

        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }
}
