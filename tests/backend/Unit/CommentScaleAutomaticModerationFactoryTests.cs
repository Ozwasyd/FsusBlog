using System.Collections;
using System.Globalization;
using System.Text.Json;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Fixtures.DataScale;
using FsusBlog.Server.Services.Moderation;

using Microsoft.Extensions.Configuration;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>
/// Synthetic unit-only plans, IDs, model signals, policy snapshots and temporal
/// envelopes exercise pure decision binding. They authenticate no content, region,
/// credentials or model output and prove no CAS, event, database write or receipt.
/// </summary>
public sealed class CommentScaleAutomaticModerationFactoryTests
{
    private const string SyntheticDigest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string OtherDigest = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private static readonly DateTime s_unitTime = new(2024, 3, 1, 0, 0, 0, DateTimeKind.Utc);

    [Theory]
    [InlineData("auto-low-risk-approve", false, true, 0.99, false, CommentModerationStatus.Approved, "model_clean_auto_approved", false)]
    [InlineData("strict-auto-moderate", false, true, 0.99, false, CommentModerationStatus.Approved, "model_clean_auto_approved", false)]
    [InlineData("auto-hide-high-risk", true, true, 0.99, false, CommentModerationStatus.Hidden, "model_risk_auto_hidden", false)]
    [InlineData("strict-auto-moderate", true, true, 0.99, false, CommentModerationStatus.Hidden, "model_risk_auto_hidden", false)]
    [InlineData("auto-hide-high-risk", true, true, 0.84, false, CommentModerationStatus.Hidden, "model_risk_borderline_review", true)]
    [InlineData("score-only", false, false, 0.0, true, CommentModerationStatus.Approved, "model_unavailable_fail_open", false)]
    public void ResolveStream_PreservesCompleteOriginalDecisionAndIndependentAuditGolden(
        string mode, bool risk, bool available, double confidence, bool failOpen,
        CommentModerationStatus next, string reason, bool review)
    {
        CommentScalePlan plan = Plan(next: next, commentCount: 1);
        CommentScaleGraphFactBindings[] frames = Frames(plan);
        CommentScaleAutomaticModerationOccurrenceFacts[] selections = Selections(plan, frames);
        CommentScaleAutomaticModerationFacts item = selections[0].Assessments[0];
        item = item with
        {
            ModelResult = Model(risk, confidence, available)
        };
        selections[0] = selections[0] with
        {
            Assessments = [item]
        };
        CommentModerationDispositionPolicy policy = Policy(mode, failOpen);
        string before = JsonSerializer.Serialize(item.CurrentComment);

        CommentScaleResolvedAutomaticModeration actual = Assert.Single(Assert.Single(
            Resolve(plan, frames, selections, policy)).Assessments);

        Assert.Equal(item.Coordinate, actual.Coordinate);
        Assert.Equal(1, actual.ModerationStepIndex);
        Assert.Equal(plan.Scenarios[0].Comments[0].Moderation[1], actual.Step.Request);
        Assert.Equal(Temporal().RequireInstant("approved").UtcDateTime, actual.Step.OccurredAtUtc);
        Assert.Equal(next, actual.Disposition.NextStatus);
        Assert.True(actual.Disposition.AutoApplied);
        Assert.Equal(review, actual.Disposition.RequiresHumanReview);
        Assert.Equal(mode, actual.Disposition.Mode);
        Assert.Equal(reason, actual.Disposition.Reason);
        var golden = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["comment_id"] = "900007",
            ["provider"] = "synthetic-unit-provider",
            ["model"] = "synthetic-unit-model",
            ["contract_version"] = "synthetic-unit-contract",
            ["label"] = risk ? "risky" : "clean",
            ["confidence"] = confidence.ToString("0.###", CultureInfo.InvariantCulture),
            ["status"] = available ? "ok" : "timeout",
            ["error_code"] = available ? string.Empty : "synthetic-unit-timeout",
            ["mode"] = mode,
            ["reason"] = reason,
            ["previous_status"] = "Pending",
            ["requested_status"] = next.ToString(),
            ["next_status"] = next.ToString(),
            ["transition_allowed"] = "true",
            ["auto_applied"] = "true",
            ["requires_human_review"] = review ? "true" : "false"
        };
        Assert.Equal(golden.OrderBy(pair => pair.Key), actual.Disposition.AuditContext.OrderBy(pair => pair.Key));
        AssertDecisionEqual(policy.Decide(item.CurrentComment, item.Region, item.ModelResult), actual.Disposition);
        Assert.Equal(before, JsonSerializer.Serialize(item.CurrentComment));
    }

    [Theory]
    [InlineData("risk-category")]
    [InlineData("high-category")]
    [InlineData("critical-severity")]
    [InlineData("future-model-label-and-severity")]
    [InlineData("future-provider-status-fail-open")]
    [InlineData("normalized-mode")]
    [InlineData("clamped-approval-threshold")]
    public void ResolveStream_ConsumesActualPolicySignalAndConfigurationBranches(string branch)
    {
        bool risk = branch is "risk-category" or "high-category" or "critical-severity";
        CommentScalePlan plan = Plan(next: risk ? CommentModerationStatus.Hidden : CommentModerationStatus.Approved, commentCount: 1);
        CommentScaleGraphFactBindings[] frames = Frames(plan);
        CommentScaleAutomaticModerationOccurrenceFacts[] selections = Selections(plan, frames);
        CommentScaleAutomaticModerationFacts item = selections[0].Assessments[0];
        AntiSpamModerationResult model = Model();
        string mode = risk ? CommentModerationDispositionModes.AutoHideHighRisk : CommentModerationDispositionModes.AutoLowRiskApprove;
        bool failOpen = false;
        string threshold = "0.95";
        switch (branch)
        {
            case "risk-category":
                model = model with
                {
                    Categories = [new("spam_repeat", 0.1, "low", "synthetic-unit-only")]
                };
                break;
            case "high-category":
                model = model with
                {
                    Categories = [new("synthetic-unknown-category", 0.1, "high", "synthetic-unit-only")]
                };
                break;
            case "critical-severity":
                model = model with
                {
                    Severity = "critical"
                };
                break;
            case "future-model-label-and-severity":
                model = model with
                {
                    Label = "future-label",
                    Severity = "future-severity"
                };
                break;
            case "future-provider-status-fail-open":
                model = model with
                {
                    Status = "future-status"
                };
                failOpen = true;
                break;
            case "normalized-mode":
                mode = " AUTO-LOW-RISK-APPROVE ";
                break;
            case "clamped-approval-threshold":
                threshold = "-1";
                model = model with
                {
                    Confidence = 0
                };
                break;
        }
        item = item with
        {
            ModelResult = model
        };
        selections[0] = selections[0] with
        {
            Assessments = [item]
        };
        CommentModerationDispositionPolicy policy = Policy(mode, failOpen, threshold);

        CommentScaleResolvedAutomaticModeration actual = Assert.Single(Assert.Single(
            Resolve(plan, frames, selections, policy)).Assessments);

        Assert.True(actual.Disposition.AutoApplied);
        Assert.Equal(risk ? CommentModerationStatus.Hidden : CommentModerationStatus.Approved, actual.Disposition.NextStatus);
        AssertDecisionEqual(policy.Decide(item.CurrentComment, item.Region, model), actual.Disposition);
    }

    [Theory]
    [InlineData(CommentModerationStatus.Approved, CommentModerationStatus.Hidden)]
    [InlineData(CommentModerationStatus.Rejected, CommentModerationStatus.Approved)]
    [InlineData(CommentModerationStatus.Hidden, CommentModerationStatus.Approved)]
    public void ResolveStream_UsesObservedPreviousStatusRatherThanInitialBaseDecision(
        CommentModerationStatus previous, CommentModerationStatus next)
    {
        CommentScalePlan plan = Plan(previous: previous, next: next, commentCount: 1);
        CommentScaleGraphFactBindings[] frames = Frames(plan);
        CommentScaleAutomaticModerationOccurrenceFacts[] selections = Selections(plan, frames);
        bool risk = next == CommentModerationStatus.Hidden;
        CommentScaleAutomaticModerationFacts item = selections[0].Assessments[0] with
        {
            ModelResult = Model(risk)
        };
        selections[0] = selections[0] with
        {
            Assessments = [item]
        };

        CommentScaleResolvedAutomaticModeration actual = Assert.Single(Assert.Single(
            Resolve(plan, frames, selections, Policy(risk ? "auto-hide-high-risk" : "auto-low-risk-approve"))).Assessments);

        Assert.Equal(previous.ToString(), actual.Disposition.AuditContext["previous_status"]);
        Assert.Equal(next, actual.Disposition.NextStatus);
        Assert.Equal(previous, item.CurrentComment.ModerationStatus);
    }

    [Theory]
    [InlineData("score-clean")]
    [InlineData("score-risk")]
    [InlineData("unknown-mode")]
    [InlineData("below-threshold")]
    [InlineData("unavailable-fail-closed")]
    [InlineData("unavailable-region-review")]
    [InlineData("unavailable-hide-until-review")]
    [InlineData("unavailable-anonymous-review")]
    [InlineData("clean-region-denial")]
    [InlineData("clean-region-review")]
    [InlineData("clean-hide-until-review")]
    [InlineData("different-next")]
    [InlineData("risky-already-hidden")]
    public void ResolveStream_RefusesNoopOrDifferentProductionDecisionBeforeYield(string branch)
    {
        CommentScalePlan plan = Plan(
            previous: branch == "risky-already-hidden" ? CommentModerationStatus.Hidden : CommentModerationStatus.Pending,
            next: branch == "different-next" ? CommentModerationStatus.Hidden : CommentModerationStatus.Approved,
            commentCount: 1);
        CommentScaleGraphFactBindings[] frames = Frames(plan);
        CommentScaleAutomaticModerationOccurrenceFacts[] selections = Selections(plan, frames);
        CommentScaleAutomaticModerationFacts item = selections[0].Assessments[0];
        string mode = "auto-low-risk-approve";
        bool failOpen = branch.StartsWith("unavailable-", StringComparison.Ordinal)
            && branch != "unavailable-fail-closed";
        AntiSpamModerationResult model = Model(available: !branch.StartsWith("unavailable-", StringComparison.Ordinal));
        RegionModerationDecision region = item.Region;
        switch (branch)
        {
            case "score-clean":
                mode = "score-only";
                break;
            case "score-risk":
                mode = "score-only";
                model = Model(risk: true);
                break;
            case "unknown-mode":
                mode = "future-mode";
                break;
            case "below-threshold":
                model = Model(confidence: 0.8);
                break;
            case "unavailable-region-review":
            case "clean-region-review":
                region = region with
                {
                    RequiresManualReview = true
                };
                break;
            case "unavailable-hide-until-review":
            case "clean-hide-until-review":
                region = region with
                {
                    HideUntilReviewed = true
                };
                break;
            case "unavailable-anonymous-review":
                item.CurrentComment.AnonymousRequiresModeration = true;
                frames[0] = frames[0] with
                {
                    Comments = frames[0].Comments.Select(binding => binding with
                    {
                        PolicyFacts = binding.PolicyFacts with
                        {
                            Actor = binding.PolicyFacts.Actor with
                            {
                                RequiresModeration = true
                            }
                        }
                    }).ToArray()
                };
                break;
            case "clean-region-denial":
                region = region with
                {
                    CanPublish = false
                };
                break;
            case "risky-already-hidden":
                mode = "auto-hide-high-risk";
                model = Model(risk: true);
                break;
        }
        frames[0] = ReplaceRegion(frames[0], region);
        item = item with
        {
            Region = region,
            ModelResult = model
        };
        selections[0] = selections[0] with
        {
            Assessments = [item]
        };
        CommentModerationDispositionPolicy policy = Policy(mode, failOpen);
        CommentModerationDisposition original = policy.Decide(item.CurrentComment, region, model);
        Assert.True(!original.AutoApplied || original.NextStatus != plan.Scenarios[0].Comments[0].Moderation[1].Next);
        using IEnumerator<CommentScaleResolvedAutomaticModerationGraph> output = Resolve(plan, frames, selections, policy).GetEnumerator();

        InvalidOperationException failure = Assert.Throws<InvalidOperationException>(() => output.MoveNext());

        Assert.Equal(branch == "clean-region-denial"
            ? "comment_automatic_moderation_request_binding_invalid"
            : "comment_automatic_moderation_production_decision_mismatch", failure.Message);
    }

    [Fact]
    public void ResolveStream_PreservesOrderedExplicitSubsetAndSkipsManualSteps()
    {
        CommentScalePlan plan = Plan(commentCount: 2);
        CommentScaleGraphFactBindings[] frames = Frames(plan);
        var selections = new List<CommentScaleAutomaticModerationFacts>();
        foreach (CommentScaleCommentRequest request in plan.Scenarios[0].Comments)
        {
            foreach (int stepIndex in new[] { 1, 2, 4 })
            {
                selections.Add(Selection(plan, frames[0], request, stepIndex));
            }
        }
        var frame = new CommentScaleAutomaticModerationOccurrenceFacts(frames[0].Occurrence, selections);

        CommentScaleResolvedAutomaticModerationGraph actual = Assert.Single(Resolve(plan, frames, [frame], Policy("strict-auto-moderate")));

        Assert.Equal(new[] { "comment.0", "comment.0", "comment.0", "comment.1", "comment.1", "comment.1" },
            actual.Assessments.Select(item => item.Coordinate.CommentRole));
        Assert.Equal(new[] { 1, 2, 4, 1, 2, 4 }, actual.Assessments.Select(item => item.ModerationStepIndex));
        Assert.Equal(new[] { "approved", "hidden", "restored", "approved", "hidden", "restored" },
            actual.Assessments.Select(item => item.Step.Request.OccurredAtRole));
        Assert.All(actual.Assessments, item => Assert.Equal(
            Temporal().RequireInstant(item.Step.Request.OccurredAtRole).UtcDateTime, item.Step.OccurredAtUtc));
        Assert.DoesNotContain(actual.Assessments, item => item.ModerationStepIndex == 3);
        Assert.Equal(5, actual.Intent.Comments[0].Moderation.Count);
    }

    [Theory]
    [InlineData("null-item")]
    [InlineData("null-coordinate")]
    [InlineData("cross-occurrence")]
    [InlineData("unknown-comment")]
    [InlineData("initial-step")]
    [InlineData("negative-step")]
    [InlineData("step-out-of-range")]
    [InlineData("content-role")]
    [InlineData("content-schema")]
    [InlineData("content-digest")]
    [InlineData("null-content-artifact")]
    [InlineData("null-comment")]
    [InlineData("zero-native-id")]
    [InlineData("negative-native-id")]
    [InlineData("article")]
    [InlineData("previous-status")]
    [InlineData("future-status")]
    [InlineData("null-region")]
    [InlineData("region-cross-binding")]
    [InlineData("actor-mode")]
    [InlineData("actor-account")]
    [InlineData("anonymous-moderation")]
    [InlineData("null-anonymous-moderation")]
    [InlineData("null-model")]
    public void ResolveStream_RejectsInvalidSelectedFactBindings(string drift)
    {
        CommentScalePlan plan = Plan(commentCount: 1);
        CommentScaleGraphFactBindings[] frames = Frames(plan);
        CommentScaleAutomaticModerationOccurrenceFacts[] selections = Selections(plan, frames);
        CommentScaleAutomaticModerationFacts item = selections[0].Assessments[0];
        switch (drift)
        {
            case "null-item":
                item = null!;
                break;
            case "null-coordinate":
                item = item with
                {
                    Coordinate = null!
                };
                break;
            case "cross-occurrence":
                item = item with
                {
                    Coordinate = item.Coordinate with
                    {
                        Occurrence = item.Coordinate.Occurrence with
                        {
                            Repetition = 1
                        }
                    }
                };
                break;
            case "unknown-comment":
                item = item with
                {
                    Coordinate = item.Coordinate with
                    {
                        CommentRole = "unknown"
                    }
                };
                break;
            case "initial-step":
                item = item with
                {
                    ModerationStepIndex = 0
                };
                break;
            case "negative-step":
                item = item with
                {
                    ModerationStepIndex = -1
                };
                break;
            case "step-out-of-range":
                item = item with
                {
                    ModerationStepIndex = 5
                };
                break;
            case "content-role":
                item = item with
                {
                    ContentRole = "other.content"
                };
                break;
            case "content-schema":
                item = item with
                {
                    ContentArtifact = item.ContentArtifact with
                    {
                        Schema = "other.schema"
                    }
                };
                break;
            case "content-digest":
                item = item with
                {
                    ContentArtifact = item.ContentArtifact with
                    {
                        ContentDigest = OtherDigest
                    }
                };
                break;
            case "null-content-artifact":
                item = item with
                {
                    ContentArtifact = null!
                };
                break;
            case "null-comment":
                item = item with
                {
                    CurrentComment = null!
                };
                break;
            case "zero-native-id":
                item.CurrentComment.Id = 0;
                break;
            case "negative-native-id":
                item.CurrentComment.Id = -7;
                break;
            case "article":
                item.CurrentComment.ArticleId++;
                break;
            case "previous-status":
                item.CurrentComment.ModerationStatus = CommentModerationStatus.Approved;
                break;
            case "future-status":
                item.CurrentComment.ModerationStatus = (CommentModerationStatus)999;
                break;
            case "null-region":
                item = item with
                {
                    Region = null!
                };
                break;
            case "region-cross-binding":
                item = item with
                {
                    Region = item.Region with
                    {
                        RequiresManualReview = true
                    }
                };
                break;
            case "actor-mode":
                item.CurrentComment.AuthorMode = CommentAuthorModes.ZkAnonymous;
                break;
            case "actor-account":
                item.CurrentComment.UserId = 8;
                break;
            case "anonymous-moderation":
                item.CurrentComment.AnonymousRequiresModeration = true;
                break;
            case "null-anonymous-moderation":
                item.CurrentComment.AnonymousRequiresModeration = null;
                break;
            case "null-model":
                item = item with
                {
                    ModelResult = null!
                };
                break;
        }
        selections[0] = selections[0] with
        {
            Assessments = [item]
        };

        Assert.Throws<InvalidOperationException>(() => Resolve(plan, frames, selections).ToArray());
    }

    [Theory]
    [InlineData("duplicate")]
    [InlineData("descending-comment")]
    [InlineData("descending-step")]
    public void ResolveStream_RejectsNonincreasingSelectionOrderBeforeOccurrenceYield(string drift)
    {
        CommentScalePlan plan = Plan();
        CommentScaleGraphFactBindings[] frames = Frames(plan);
        CommentScaleAutomaticModerationFacts first = Selection(plan, frames[0], plan.Scenarios[0].Comments[0], 1);
        CommentScaleAutomaticModerationFacts second = first;
        if (drift == "descending-comment")
        {
            first = Selection(plan, frames[0], plan.Scenarios[0].Comments[1], 1);
        }
        else if (drift == "descending-step")
        {
            first = Selection(plan, frames[0], plan.Scenarios[0].Comments[0], 2);
        }
        var frame = new CommentScaleAutomaticModerationOccurrenceFacts(frames[0].Occurrence, [first, second]);
        using IEnumerator<CommentScaleResolvedAutomaticModerationGraph> output = Resolve(plan, frames, [frame], Policy("strict-auto-moderate")).GetEnumerator();

        InvalidOperationException failure = Assert.Throws<InvalidOperationException>(() => output.MoveNext());

        Assert.Equal("comment_automatic_moderation_selection_order_invalid", failure.Message);
    }

    [Theory]
    [InlineData("same-comment-id-drift")]
    [InlineData("different-comments-id-alias")]
    public void ResolveStream_RejectsObservedNativeIdentityDriftWithinOccurrence(string drift)
    {
        CommentScalePlan plan = Plan();
        CommentScaleGraphFactBindings[] frames = Frames(plan);
        CommentScaleAutomaticModerationFacts first = Selection(plan, frames[0], plan.Scenarios[0].Comments[0], 1);
        CommentScaleAutomaticModerationFacts second = drift == "same-comment-id-drift"
            ? Selection(plan, frames[0], plan.Scenarios[0].Comments[0], 2)
            : Selection(plan, frames[0], plan.Scenarios[0].Comments[1], 1);
        second.CurrentComment.Id = drift == "same-comment-id-drift" ? first.CurrentComment.Id + 1 : first.CurrentComment.Id;
        var frame = new CommentScaleAutomaticModerationOccurrenceFacts(frames[0].Occurrence, [first, second]);
        using IEnumerator<CommentScaleResolvedAutomaticModerationGraph> output = Resolve(plan, frames, [frame], Policy("strict-auto-moderate")).GetEnumerator();

        InvalidOperationException failure = Assert.Throws<InvalidOperationException>(() => output.MoveNext());

        Assert.Equal("comment_automatic_moderation_request_binding_invalid", failure.Message);
    }

    [Fact]
    public void ResolveStream_LaterSelectedDecisionFailureDoesNotYieldPartialOccurrence()
    {
        CommentScalePlan plan = Plan();
        CommentScaleGraphFactBindings[] frames = Frames(plan);
        CommentScaleAutomaticModerationOccurrenceFacts frame = Selections(plan, frames)[0];
        frame = frame with
        {
            Assessments = [frame.Assessments[0], frame.Assessments[1] with { ModelResult = Model(confidence: 0.1) }]
        };
        using IEnumerator<CommentScaleResolvedAutomaticModerationGraph> output = Resolve(plan, frames, [frame]).GetEnumerator();

        Assert.Throws<InvalidOperationException>(() => output.MoveNext());
    }

    [Theory]
    [InlineData("author-refusal")]
    [InlineData("article-refusal")]
    public void ResolveStream_RefusesKnownOriginalPolicyDenial(string refusal)
    {
        CommentScalePlan plan = Plan(commentCount: 1);
        CommentScaleGraphFactBindings[] frames = Frames(plan);
        CommentScaleRequestFactBinding binding = frames[0].Comments[0];
        if (refusal == "author-refusal")
        {
            binding = binding with
            {
                PolicyFacts = binding.PolicyFacts with
                {
                    PublicSendExplicitlySelected = false
                }
            };
        }
        else
        {
            binding.PolicyFacts.ArticlePolicy!.PublicCommentsEnabled = false;
        }
        frames[0] = frames[0] with
        {
            Comments = [binding]
        };

        Assert.Throws<InvalidOperationException>(() => Resolve(plan, frames, Selections(plan, frames)).ToArray());
    }

    [Theory]
    [InlineData(-1, 1)]
    [InlineData(0, 1)]
    [InlineData(1, 0)]
    [InlineData(1, 2)]
    [InlineData(5, 1)]
    public void ResolveStream_RejectsDeclaredCountAndActualEnumerationDrift(int declaredCount, int actualCount)
    {
        CommentScalePlan plan = Plan(commentCount: 1);
        CommentScaleGraphFactBindings[] frames = Frames(plan);
        CommentScaleAutomaticModerationFacts item = Selections(plan, frames)[0].Assessments[0];
        var roster = new MisreportedList<CommentScaleAutomaticModerationFacts>
        {
            ReportedCount = declaredCount,
            Items = Enumerable.Repeat(item, actualCount).ToArray()
        };
        var frame = new CommentScaleAutomaticModerationOccurrenceFacts(frames[0].Occurrence, roster);

        InvalidOperationException failure = Assert.Throws<InvalidOperationException>(() => Resolve(plan, frames, [frame]).ToArray());

        Assert.Equal("comment_automatic_moderation_selection_count_invalid", failure.Message);
    }

    [Theory]
    [InlineData("null-frame")]
    [InlineData("null-roster")]
    [InlineData("cross-scenario")]
    [InlineData("cross-repetition")]
    [InlineData("cross-target")]
    public void ResolveStream_RejectsMalformedOccurrenceFrames(string drift)
    {
        CommentScalePlan plan = Plan(commentCount: 1);
        CommentScaleGraphFactBindings[] frames = Frames(plan);
        CommentScaleAutomaticModerationOccurrenceFacts frame = Selections(plan, frames)[0];
        frame = drift switch
        {
            "null-frame" => null!,
            "null-roster" => frame with { Assessments = null! },
            "cross-scenario" => frame with { Occurrence = frame.Occurrence with { ScenarioRole = "other" } },
            "cross-repetition" => frame with { Occurrence = frame.Occurrence with { Repetition = 7 } },
            _ => frame with { Occurrence = frame.Occurrence with { ArticleTargetRole = "other" } }
        };

        Assert.Throws<InvalidOperationException>(() => Resolve(plan, frames, [frame]).ToArray());
    }

    [Fact]
    public void ResolveStream_EmptySelectionsStillConsumeZeroAndNonzeroOccurrencesInExactOrder()
    {
        CommentScalePlan plan = Plan(repetitions: 2, includeZero: true);
        CommentScaleGraphFactBindings[] frames = Frames(plan);
        CommentScaleAutomaticModerationOccurrenceFacts[] selections = frames.Select(frame =>
            new CommentScaleAutomaticModerationOccurrenceFacts(frame.Occurrence, [])).ToArray();

        CommentScaleResolvedAutomaticModerationGraph[] result = Resolve(plan, frames, selections).ToArray();

        Assert.Equal(frames.Select(frame => frame.Occurrence), result.Select(item => item.Intent.Occurrence));
        Assert.Equal(new[] { 2, 2, 0 }, result.Select(item => item.Intent.Comments.Count));
        Assert.All(result, item => Assert.Empty(item.Assessments));
    }

    [Fact]
    public void ResolveStream_ZeroCommentOccurrenceCannotCarryAutomaticSelections()
    {
        CommentScalePlan plan = Plan(includeZero: true);
        CommentScaleGraphFactBindings[] frames = Frames(plan);
        CommentScaleAutomaticModerationOccurrenceFacts[] selections = Selections(plan, frames);
        selections[1] = selections[1] with
        {
            Assessments = [selections[0].Assessments[0] with
            {
                Coordinate = selections[0].Assessments[0].Coordinate with { Occurrence = frames[1].Occurrence }
            }]
        };
        using IEnumerator<CommentScaleResolvedAutomaticModerationGraph> output = Resolve(plan, frames, selections).GetEnumerator();
        Assert.True(output.MoveNext());

        InvalidOperationException failure = Assert.Throws<InvalidOperationException>(() => output.MoveNext());

        Assert.Equal("comment_automatic_moderation_selection_count_invalid", failure.Message);
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("extra")]
    [InlineData("reordered")]
    [InlineData("duplicate-occurrence")]
    public void ResolveStream_FullEnumerationRefusesIncompleteOrCrossedFrameCoverage(string drift)
    {
        CommentScalePlan plan = Plan(repetitions: 2, commentCount: 1);
        CommentScaleGraphFactBindings[] frames = Frames(plan);
        CommentScaleAutomaticModerationOccurrenceFacts[] selections = Selections(plan, frames);
        selections = drift switch
        {
            "missing" => [selections[0]],
            "extra" => [selections[0], selections[1], selections[1]],
            "reordered" => [selections[1], selections[0]],
            _ => [selections[0], selections[0]]
        };

        Assert.Throws<InvalidOperationException>(() => Resolve(plan, frames, selections).ToArray());
    }

    [Fact]
    public void ResolveStream_LateFailureKeepsOnlyObservedPrefixAndDisposesBothInputs()
    {
        CommentScalePlan plan = Plan(repetitions: 2, commentCount: 1);
        CommentScaleGraphFactBindings[] frames = Frames(plan);
        CommentScaleAutomaticModerationOccurrenceFacts[] selections = Selections(plan, frames);
        selections[1] = selections[1] with
        {
            Assessments = [selections[1].Assessments[0] with { ModelResult = Model(confidence: 0.1) }]
        };
        var graphInput = new ObservedSequence<CommentScaleGraphFactBindings> { Items = frames };
        var automaticInput = new ObservedSequence<CommentScaleAutomaticModerationOccurrenceFacts> { Items = selections };
        using (IEnumerator<CommentScaleResolvedAutomaticModerationGraph> output = Resolve(plan, graphInput, automaticInput).GetEnumerator())
        {
            Assert.True(output.MoveNext());
            Assert.Equal(frames[0].Occurrence, output.Current.Intent.Occurrence);
            Assert.Throws<InvalidOperationException>(() => output.MoveNext());
        }
        Assert.Equal(1, graphInput.DisposeCalls);
        Assert.Equal(1, automaticInput.DisposeCalls);
        Assert.Equal(2, graphInput.MoveNextCalls);
        Assert.Equal(2, automaticInput.MoveNextCalls);
        // A delivered prefix is not full-plan success or admission evidence.
    }

    [Theory]
    [InlineData("graph")]
    [InlineData("automatic")]
    public void ResolveStream_PropagatesOwnerEnumerationFailureWithoutPromotingPrefix(string owner)
    {
        CommentScalePlan plan = Plan(repetitions: 2, commentCount: 1);
        CommentScaleGraphFactBindings[] frames = Frames(plan);
        var failure = new InvalidOperationException("synthetic-unit-owner-failure");
        var graph = new ObservedSequence<CommentScaleGraphFactBindings>
        {
            Items = frames,
            FailureIndex = owner == "graph" ? 1 : null,
            Failure = failure
        };
        var automatic = new ObservedSequence<CommentScaleAutomaticModerationOccurrenceFacts>
        {
            Items = Selections(plan, frames),
            FailureIndex = owner == "automatic" ? 1 : null,
            Failure = failure
        };
        using (IEnumerator<CommentScaleResolvedAutomaticModerationGraph> output = Resolve(plan, graph, automatic).GetEnumerator())
        {
            Assert.True(output.MoveNext());
            Assert.Same(failure, Assert.Throws<InvalidOperationException>(() => output.MoveNext()));
        }
        Assert.Equal(1, graph.DisposeCalls);
        Assert.Equal(1, automatic.DisposeCalls);
    }

    [Fact]
    public void ResolveStream_IsLazyAndDoesNotReadNextOccurrenceWhenConsumerStops()
    {
        CommentScalePlan plan = Plan(repetitions: 2);
        CommentScaleGraphFactBindings[] frames = Frames(plan);
        var graph = new ObservedSequence<CommentScaleGraphFactBindings> { Items = frames };
        var automatic = new ObservedSequence<CommentScaleAutomaticModerationOccurrenceFacts> { Items = Selections(plan, frames) };
        IEnumerable<CommentScaleResolvedAutomaticModerationGraph> result = Resolve(plan, graph, automatic);
        Assert.Equal(0, graph.GetEnumeratorCalls);
        Assert.Equal(0, automatic.GetEnumeratorCalls);
        using (IEnumerator<CommentScaleResolvedAutomaticModerationGraph> output = result.GetEnumerator())
        {
            Assert.Equal(0, graph.GetEnumeratorCalls);
            Assert.Equal(0, automatic.GetEnumeratorCalls);
            Assert.True(output.MoveNext());
            Assert.Equal(1, graph.MoveNextCalls);
            Assert.Equal(1, automatic.MoveNextCalls);
            Assert.Equal(2, output.Current.Assessments.Count);
        }
        Assert.Equal(1, graph.DisposeCalls);
        Assert.Equal(1, automatic.DisposeCalls);
    }

    [Fact]
    public void ResolveStream_SnapshotsPlanAndExposesReadonlySelectionLists()
    {
        CommentScalePlan original = Plan(repetitions: 2);
        var requests = original.Scenarios[0].Comments.ToList();
        var scenarios = new List<CommentScaleScenario> { original.Scenarios[0] with { Comments = requests } };
        CommentScalePlan plan = Seal(original with
        {
            Scenarios = scenarios
        });
        CommentScaleGraphFactBindings[] frames = Frames(plan);
        CommentScaleAutomaticModerationOccurrenceFacts[] selections = Selections(plan, frames);
        using IEnumerator<CommentScaleResolvedAutomaticModerationGraph> output = Resolve(plan, frames, selections).GetEnumerator();
        Assert.True(output.MoveNext());
        CommentScaleResolvedAutomaticModerationGraph first = output.Current;
        requests.Clear();
        scenarios.Clear();
        Assert.Throws<NotSupportedException>(() => ((IList<CommentScaleResolvedAutomaticModeration>)first.Assessments).Clear());

        Assert.True(output.MoveNext());

        Assert.Equal(first.Intent.CommentPlanDigest, output.Current.Intent.CommentPlanDigest);
        Assert.Equal(2, output.Current.Intent.Comments.Count);
        Assert.Equal(2, output.Current.Assessments.Count);
        Assert.False(output.MoveNext());
    }

    [Fact]
    public void ResolveStream_InvalidPlanFailsBeforeReadingEitherOwnerFrame()
    {
        CommentScalePlan plan = Plan() with
        {
            ContentDigest = OtherDigest
        };
        var graph = new ObservedSequence<CommentScaleGraphFactBindings>();
        var automatic = new ObservedSequence<CommentScaleAutomaticModerationOccurrenceFacts>();

        Assert.Throws<InvalidOperationException>(() => Resolve(plan, graph, automatic).ToArray());

        Assert.Equal(0, graph.MoveNextCalls);
        Assert.Equal(0, automatic.MoveNextCalls);
    }

    [Fact]
    public void ResolveStream_EmptyPlanRequiresBothInputsEmpty()
    {
        CommentScalePlan plan = Seal(Plan() with
        {
            Scenarios = [],
            ArticleCount = 0,
            CommentCount = 0
        });
        Assert.Empty(Resolve(plan, [], []));
        Assert.Empty(CanonicalCommentGraphFactory.ResolveAutomaticModerationBatches(plan, Temporal(), [], [], Policy(), 256));
        CommentScaleGraphFactBindings[] extra = Frames(Plan());
        Assert.Throws<InvalidOperationException>(() => Resolve(plan, extra, []).ToArray());
        Assert.Throws<InvalidOperationException>(() => Resolve(plan, [], Selections(Plan(), extra)).ToArray());
    }

    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(256)]
    public void ResolveBatches_BoundsWholeOccurrenceGroupsAndPreservesAllSelections(int batchSize)
    {
        CommentScalePlan plan = Plan(repetitions: 257);
        CommentScaleGraphFactBindings[] frames = Frames(plan);

        IReadOnlyList<CommentScaleResolvedAutomaticModerationGraph>[] batches = CanonicalCommentGraphFactory
            .ResolveAutomaticModerationBatches(plan, Temporal(), frames, Selections(plan, frames), Policy(), batchSize).ToArray();

        Assert.Equal((257 + batchSize - 1) / batchSize, batches.Length);
        Assert.Equal(frames.Select(frame => frame.Occurrence), batches.SelectMany(batch => batch).Select(item => item.Intent.Occurrence));
        Assert.All(batches, batch =>
        {
            Assert.InRange(batch.Count, 1, batchSize);
            Assert.Throws<NotSupportedException>(() => ((IList<CommentScaleResolvedAutomaticModerationGraph>)batch).Clear());
            Assert.All(batch, item => Assert.Equal(2, item.Assessments.Count));
        });
        if (batchSize == 256)
        {
            Assert.Equal(new[] { 256, 1 }, batches.Select(batch => batch.Count));
        }
    }

    [Fact]
    public void ResolveBatches_StoppedConsumerReadsOnlyRequestedBoundedOccurrences()
    {
        CommentScalePlan plan = Plan(repetitions: 5);
        CommentScaleGraphFactBindings[] frames = Frames(plan);
        var graph = new ObservedSequence<CommentScaleGraphFactBindings> { Items = frames };
        var automatic = new ObservedSequence<CommentScaleAutomaticModerationOccurrenceFacts> { Items = Selections(plan, frames) };
        using (IEnumerator<IReadOnlyList<CommentScaleResolvedAutomaticModerationGraph>> output = CanonicalCommentGraphFactory
            .ResolveAutomaticModerationBatches(plan, Temporal(), graph, automatic, Policy(), 2).GetEnumerator())
        {
            Assert.True(output.MoveNext());
            Assert.Equal(2, output.Current.Count);
            Assert.Equal(2, graph.MoveNextCalls);
            Assert.Equal(2, automatic.MoveNextCalls);
        }
        Assert.Equal(1, graph.DisposeCalls);
        Assert.Equal(1, automatic.DisposeCalls);
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(0)]
    [InlineData(257)]
    public void ResolveBatches_RejectsInvalidBoundsBeforeOpeningInputs(int batchSize)
    {
        var graph = new ObservedSequence<CommentScaleGraphFactBindings>();
        var automatic = new ObservedSequence<CommentScaleAutomaticModerationOccurrenceFacts>();

        Assert.Throws<ArgumentOutOfRangeException>(() => CanonicalCommentGraphFactory
            .ResolveAutomaticModerationBatches(Plan(), Temporal(), graph, automatic, Policy(), batchSize).ToArray());

        Assert.Equal(0, graph.GetEnumeratorCalls);
        Assert.Equal(0, automatic.GetEnumeratorCalls);
    }

    [Theory]
    [InlineData("plan")]
    [InlineData("temporal")]
    [InlineData("graph")]
    [InlineData("automatic")]
    [InlineData("policy")]
    public void ResolveStream_RejectsNullDependencies(string missing)
    {
        CommentScalePlan plan = Plan();
        CommentScaleGraphFactBindings[] frames = Frames(plan);
        Assert.Throws<ArgumentNullException>(() => CanonicalCommentGraphFactory.ResolveAutomaticModerationStream(
            missing == "plan" ? null! : plan, missing == "temporal" ? null! : Temporal(),
            missing == "graph" ? null! : frames, missing == "automatic" ? null! : Selections(plan, frames),
            missing == "policy" ? null! : Policy()).ToArray());
    }

    private static IEnumerable<CommentScaleResolvedAutomaticModerationGraph> Resolve(
        CommentScalePlan plan, IEnumerable<CommentScaleGraphFactBindings> frames,
        IEnumerable<CommentScaleAutomaticModerationOccurrenceFacts> selections,
        CommentModerationDispositionPolicy? policy = null)
        => CanonicalCommentGraphFactory.ResolveAutomaticModerationStream(plan, Temporal(), frames, selections, policy ?? Policy());

    private static void AssertDecisionEqual(CommentModerationDisposition expected, CommentModerationDisposition actual)
    {
        Assert.Equal(expected.NextStatus, actual.NextStatus);
        Assert.Equal(expected.Reason, actual.Reason);
        Assert.Equal(expected.AutoApplied, actual.AutoApplied);
        Assert.Equal(expected.RequiresHumanReview, actual.RequiresHumanReview);
        Assert.Equal(expected.Mode, actual.Mode);
        Assert.Equal(expected.AuditContext.OrderBy(pair => pair.Key), actual.AuditContext.OrderBy(pair => pair.Key));
    }

    private static CommentModerationDispositionPolicy Policy(string mode = "auto-low-risk-approve", bool failOpen = false, string approvalThreshold = "0.95")
        => new(new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Moderation:AntiSpamModel:Mode"] = mode,
            ["Moderation:AntiSpamModel:FailOpen"] = failOpen ? "true" : "false",
            ["Moderation:AntiSpamModel:AutoApproveConfidenceThreshold"] = approvalThreshold,
            ["Moderation:AntiSpamModel:BorderlineRiskConfidenceThreshold"] = "0.90"
        }).Build());

    private static AntiSpamModerationResult Model(bool risk = false, double confidence = 0.99, bool available = true)
        => new(available, "synthetic-unit-provider", "synthetic-unit-model", "synthetic-unit-contract",
            risk ? "risky" : "clean", confidence, risk ? "high" : "low", null, false, [], [], null,
            TimeSpan.Zero, available ? "ok" : "timeout", available ? null : "synthetic-unit-timeout", null,
            new Dictionary<string, string>(StringComparer.Ordinal));

    private static CommentScalePlan Plan(long repetitions = 1, int commentCount = 2,
        CommentModerationStatus previous = CommentModerationStatus.Pending,
        CommentModerationStatus next = CommentModerationStatus.Approved, bool includeZero = false)
    {
        CommentScaleCommentRequest[] comments = Enumerable.Range(0, commentCount).Select(index =>
            new CommentScaleCommentRequest("comment." + index, null, null, CommentAuthorModes.Public,
                CommentScaleCredentialValidity.PublicAuthenticated, SyntheticDigest, "content." + index,
                new("fsusblog.generated-content-shape.v1", SyntheticDigest), SyntheticDigest, "created",
                [new(null, previous, "initial", "created"),
                 new(previous, next, "approve", "approved"),
                 new(next, next == CommentModerationStatus.Hidden ? CommentModerationStatus.Rejected : CommentModerationStatus.Hidden, "hide", "hidden"),
                 new(next == CommentModerationStatus.Hidden ? CommentModerationStatus.Rejected : CommentModerationStatus.Hidden,
                     next == CommentModerationStatus.Hidden ? CommentModerationStatus.Approved : CommentModerationStatus.Rejected, "reject", "rejected"),
                 new(next == CommentModerationStatus.Hidden ? CommentModerationStatus.Approved : CommentModerationStatus.Rejected,
                     next == CommentModerationStatus.Hidden ? CommentModerationStatus.Hidden : CommentModerationStatus.Approved, "restore", "restored")])).ToArray();
        var requirements = new CommentScaleGraphRequirements(Enum.GetValues<CommentScaleRelation>(),
            Enum.GetValues<CommentScaleAuthority>().Select(authority => new CommentScaleAuthorityReference(
                authority, new string('a', 40), SyntheticDigest)).ToArray());
        var scenarios = new List<CommentScaleScenario>
        {
            new("thread", CommentScaleThreadShape.WideRoots, "article.thread", repetitions, comments, requirements)
        };
        if (includeZero)
        {
            scenarios.Add(new("empty", CommentScaleThreadShape.ZeroCommentArticle, "article.empty", 1, [], requirements));
        }
        return Seal(new(CommentScalePlanContract.Schema, CommentScalePlanContract.GraphSchema, "synthetic-unit-only", "unit-tier",
            repetitions * commentCount, repetitions + (includeZero ? 1 : 0),
            new(ArticleScaleContractIds.PlanSchema, SyntheticDigest),
            new(ArticleScaleContractIds.ContentShapeCatalogSchema, SyntheticDigest),
            new(ArticleScaleContractIds.TemporalArtifactSchema, SyntheticDigest), scenarios, string.Empty));
    }

    private static CommentScalePlan Seal(CommentScalePlan plan)
        => plan with
        {
            ContentDigest = CommentScalePlanContract.ComputeDigest(plan)
        };

    private static CommentScaleGraphFactBindings[] Frames(CommentScalePlan plan)
    {
        var frames = new List<CommentScaleGraphFactBindings>();
        foreach (CommentScaleScenario scenario in plan.Scenarios)
        {
            for (long repetition = 0; repetition < scenario.Repetitions; repetition++)
            {
                int articleId = 701 + frames.Count * 17;
                var occurrence = new CommentScaleGraphOccurrence(scenario.Role, repetition, scenario.ArticleTargetRole);
                frames.Add(new(occurrence, plan.Namespace, plan.ContentDigest, plan.ArticlePlan.ContentDigest,
                    "synthetic-article." + frames.Count, articleId,
                    new("fsusblog.article-scale-graph-identity-bindings.v1", SyntheticDigest),
                    scenario.Comments.Select(request => new CommentScaleRequestFactBinding(request.Role, request.ContentRole,
                        request.ContentArtifact, PolicyFacts(articleId))).ToArray()));
            }
        }
        return frames.ToArray();
    }

    private static CommentScalePolicyFacts PolicyFacts(int articleId)
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
        return new(articleId, null, site, article, null, actor, SyntheticDigest, region, SyntheticDigest, true, false, false, null);
    }

    private static CommentScaleGraphFactBindings ReplaceRegion(CommentScaleGraphFactBindings frame, RegionModerationDecision region)
        => frame with
        {
            Comments = frame.Comments.Select(item => item with { PolicyFacts = item.PolicyFacts with { Region = region } }).ToArray()
        };

    private static CommentScaleAutomaticModerationOccurrenceFacts[] Selections(CommentScalePlan plan, CommentScaleGraphFactBindings[] frames)
        => frames.Select(frame => new CommentScaleAutomaticModerationOccurrenceFacts(frame.Occurrence,
            plan.Scenarios.Single(scenario => scenario.Role == frame.Occurrence.ScenarioRole).Comments
                .Select(request => Selection(plan, frame, request, 1)).ToArray())).ToArray();

    private static CommentScaleAutomaticModerationFacts Selection(CommentScalePlan plan, CommentScaleGraphFactBindings frame,
        CommentScaleCommentRequest request, int stepIndex)
    {
        CommentScaleModerationStep step = request.Moderation[stepIndex];
        var comment = new Comment
        {
            // Explicit synthetic IDs test bindings; they are not allocator evidence.
            Id = 900007 + Array.FindIndex(frame.Comments.ToArray(), binding => binding.CommentRole == request.Role) * 101,
            ArticleId = frame.ArticleId,
            Content = "synthetic unit-only owner content",
            CreateTime = s_unitTime,
            ModerationStatus = step.Previous ?? throw new InvalidOperationException("Synthetic selection requires a noninitial step."),
            ModerationReason = "owner-observed-reason",
            AuthorMode = CommentAuthorModes.Public,
            UserId = 7,
            RootId = null,
            ParentId = null,
            Depth = 0,
            AnonymousScope = "synthetic-unit-only-scope",
            AnonymousRequiresModeration = false,
            CurrentVersion = 19
        };
        return new(new(frame.Occurrence, request.Role), stepIndex, request.ContentRole, request.ContentArtifact,
            comment, frame.Comments.Single(item => item.CommentRole == request.Role).PolicyFacts.Region,
            Model(risk: step.Next == CommentModerationStatus.Hidden));
    }

    private static ResolvedTemporalRoleContext Temporal()
        => ResolvedTemporalRoleContext.Parse(JsonSerializer.Serialize(new
        {
            schema = "fsusblog.resolved-temporal-roles.v1",
            contextIdentity = new
            {
                producerId = "synthetic-unit-only",
                schedulerRunId = "synthetic-unit-only"
            },
            contentDigest = SyntheticDigest,
            roles = new[] { "created", "approved", "hidden", "rejected", "restored" }.Select((role, index) => new
            {
                roleId = role,
                clockKind = "business-wall",
                semanticEffect = "included",
                precision = "millisecond",
                instantUtc = s_unitTime.AddMilliseconds(index).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture)
            })
        }), SyntheticDigest);

    private sealed class MisreportedList<T> : IReadOnlyList<T>
    {
        public IReadOnlyList<T> Items { get; init; } = [];
        public int ReportedCount
        {
            get; init;
        }
        public int Count => ReportedCount;
        public T this[int index] => Items[index];
        public IEnumerator<T> GetEnumerator() => Items.GetEnumerator();
        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }

    private sealed class ObservedSequence<T> : IEnumerable<T>
    {
        public IReadOnlyList<T> Items { get; init; } = [];
        public int? FailureIndex
        {
            get; init;
        }
        public InvalidOperationException? Failure
        {
            get; init;
        }
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

        public IEnumerator<T> GetEnumerator()
        {
            GetEnumeratorCalls++;
            return Enumerate().GetEnumerator();
        }

        private IEnumerable<T> Enumerate()
        {
            try
            {
                for (int index = 0; index <= Items.Count; index++)
                {
                    MoveNextCalls++;
                    if (index == FailureIndex)
                    {
                        throw Failure!;
                    }
                    if (index == Items.Count)
                    {
                        yield break;
                    }
                    yield return Items[index];
                }
            }
            finally
            {
                DisposeCalls++;
            }
        }

        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }
}
