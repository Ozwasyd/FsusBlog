using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Services.Moderation;

using Microsoft.Extensions.Configuration;
namespace FsusBlog.Server.Tests.Unit;

public sealed class CommentModerationDispositionPolicyTests
{
    [Theory]
    [InlineData(CommentModerationStatus.Pending, CommentModerationStatus.Pending, false)]
    [InlineData(CommentModerationStatus.Pending, CommentModerationStatus.Approved, true)]
    [InlineData(CommentModerationStatus.Pending, CommentModerationStatus.Rejected, true)]
    [InlineData(CommentModerationStatus.Pending, CommentModerationStatus.Hidden, true)]
    [InlineData(CommentModerationStatus.Approved, CommentModerationStatus.Pending, false)]
    [InlineData(CommentModerationStatus.Approved, CommentModerationStatus.Approved, false)]
    [InlineData(CommentModerationStatus.Approved, CommentModerationStatus.Rejected, true)]
    [InlineData(CommentModerationStatus.Approved, CommentModerationStatus.Hidden, true)]
    [InlineData(CommentModerationStatus.Rejected, CommentModerationStatus.Pending, false)]
    [InlineData(CommentModerationStatus.Rejected, CommentModerationStatus.Approved, true)]
    [InlineData(CommentModerationStatus.Rejected, CommentModerationStatus.Rejected, false)]
    [InlineData(CommentModerationStatus.Rejected, CommentModerationStatus.Hidden, true)]
    [InlineData(CommentModerationStatus.Hidden, CommentModerationStatus.Pending, false)]
    [InlineData(CommentModerationStatus.Hidden, CommentModerationStatus.Approved, true)]
    [InlineData(CommentModerationStatus.Hidden, CommentModerationStatus.Rejected, true)]
    [InlineData(CommentModerationStatus.Hidden, CommentModerationStatus.Hidden, false)]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Boundary)]
    public void TransitionMatrix_ExplicitlyCoversEveryKnownStatePair(
        CommentModerationStatus from,
        CommentModerationStatus to,
        bool expected)
    {
        Assert.Equal(expected, CommentModerationTransitions.IsAllowed(from, to));
    }

    [Fact]
    public void Decide_ScoreOnlyCleanResult_KeepsPendingForHumanReview()
    {
        CommentModerationDispositionPolicy policy = BuildPolicy();

        CommentModerationDisposition disposition = policy.Decide(
            CreateComment(status: CommentModerationStatus.Pending),
            CreateRegionDecision(canPublish: true),
            CreateModelResult(label: "clean", confidence: 0.99d, severity: "low"));

        Assert.False(disposition.AutoApplied);
        Assert.True(disposition.RequiresHumanReview);
        Assert.Equal(CommentModerationStatus.Pending, disposition.NextStatus);
        Assert.Equal(CommentModerationDispositionModes.ScoreOnly, disposition.Mode);
        Assert.Equal("model_clean_pending_policy", disposition.Reason);
    }

    [Fact]
    public void Decide_RiskyHighConfidence_AutoHidesWithoutHumanReviewQueue()
    {
        CommentModerationDispositionPolicy policy = BuildPolicy(
            Setting("Moderation:AntiSpamModel:Mode", CommentModerationDispositionModes.AutoHideHighRisk),
            Setting("Moderation:AntiSpamModel:BorderlineRiskConfidenceThreshold", "0.90"));

        CommentModerationDisposition disposition = policy.Decide(
            CreateComment(status: CommentModerationStatus.Pending),
            CreateRegionDecision(canPublish: true),
            CreateModelResult(label: "blocked_candidate", confidence: 0.94d, severity: "high"));

        Assert.True(disposition.AutoApplied);
        Assert.False(disposition.RequiresHumanReview);
        Assert.Equal(CommentModerationStatus.Hidden, disposition.NextStatus);
        Assert.Equal("model_risk_auto_hidden", disposition.Reason);
    }

    [Fact]
    public void Decide_RiskyBorderlineConfidence_AutoHidesAndQueuesHumanReview()
    {
        CommentModerationDispositionPolicy policy = BuildPolicy(
            Setting("Moderation:AntiSpamModel:Mode", CommentModerationDispositionModes.AutoHideHighRisk),
            Setting("Moderation:AntiSpamModel:BorderlineRiskConfidenceThreshold", "0.90"));

        CommentModerationDisposition disposition = policy.Decide(
            CreateComment(status: CommentModerationStatus.Pending),
            CreateRegionDecision(canPublish: true),
            CreateModelResult(label: "risky", confidence: 0.84d, severity: "high"));

        Assert.True(disposition.AutoApplied);
        Assert.True(disposition.RequiresHumanReview);
        Assert.Equal(CommentModerationStatus.Hidden, disposition.NextStatus);
        Assert.Equal("model_risk_borderline_review", disposition.Reason);
    }

    [Fact]
    public void Decide_HighSeverityCategory_AutoHidesEvenWhenLabelIsNotBlockedCandidate()
    {
        CommentModerationDispositionPolicy policy = BuildPolicy(
            Setting("Moderation:AntiSpamModel:Mode", CommentModerationDispositionModes.AutoHideHighRisk));

        CommentModerationDisposition disposition = policy.Decide(
            CreateComment(status: CommentModerationStatus.Pending),
            CreateRegionDecision(canPublish: true),
            CreateModelResult(
                label: "suspicious",
                confidence: 0.91d,
                severity: "high",
                categories: [new AntiSpamModerationCategorySignal("spam_repeat", 0.91d, "high", "show_category_only")]));

        Assert.True(disposition.AutoApplied);
        Assert.False(disposition.RequiresHumanReview);
        Assert.Equal(CommentModerationStatus.Hidden, disposition.NextStatus);
        Assert.Equal("model_risk_auto_hidden", disposition.Reason);
    }

    [Fact]
    public void Decide_ProviderUnavailable_DefaultsFailClosedAndKeepsPending()
    {
        CommentModerationDispositionPolicy policy = BuildPolicy();

        CommentModerationDisposition disposition = policy.Decide(
            CreateComment(status: CommentModerationStatus.Pending),
            CreateRegionDecision(canPublish: true),
            CreateModelResult(
                available: false,
                label: "clean",
                confidence: 1d,
                status: AntiSpamModerationStatuses.Timeout,
                errorCode: "model_timeout"));

        Assert.False(disposition.AutoApplied);
        Assert.True(disposition.RequiresHumanReview);
        Assert.Equal(CommentModerationStatus.Pending, disposition.NextStatus);
        Assert.Equal("model_unavailable_pending", disposition.Reason);
    }

    [Fact]
    public void Decide_ProviderUnavailable_ExplicitFailOpenApprovesOnlySafeComment()
    {
        CommentModerationDispositionPolicy policy = BuildPolicy(
            Setting("Moderation:AntiSpamModel:FailOpen", "true"));

        CommentModerationDisposition disposition = policy.Decide(
            CreateComment(status: CommentModerationStatus.Pending),
            CreateRegionDecision(canPublish: true),
            CreateModelResult(
                available: false,
                label: "clean",
                confidence: 0d,
                status: AntiSpamModerationStatuses.Timeout));

        Assert.True(disposition.AutoApplied);
        Assert.Equal(CommentModerationStatus.Approved, disposition.NextStatus);
        Assert.Equal("model_unavailable_fail_open", disposition.Reason);
    }

    [Fact]
    public void Decide_AutoLowRiskApprove_CleanHighConfidenceApprovesPending()
    {
        CommentModerationDispositionPolicy policy = BuildPolicy(
            Setting("Moderation:AntiSpamModel:Mode", CommentModerationDispositionModes.AutoLowRiskApprove),
            Setting("Moderation:AntiSpamModel:AutoApproveConfidenceThreshold", "0.95"));

        CommentModerationDisposition disposition = policy.Decide(
            CreateComment(status: CommentModerationStatus.Pending),
            CreateRegionDecision(canPublish: true),
            CreateModelResult(label: "clean", confidence: 0.98d));

        Assert.True(disposition.AutoApplied);
        Assert.False(disposition.RequiresHumanReview);
        Assert.Equal(CommentModerationStatus.Approved, disposition.NextStatus);
        Assert.Equal("model_clean_auto_approved", disposition.Reason);
    }

    [Fact]
    public void Decide_AutoDisposition_CarriesAuditContext()
    {
        CommentModerationDispositionPolicy policy = BuildPolicy(
            Setting("Moderation:AntiSpamModel:Mode", CommentModerationDispositionModes.AutoHideHighRisk));

        CommentModerationDisposition disposition = policy.Decide(
            CreateComment(42, CommentModerationStatus.Pending),
            CreateRegionDecision(canPublish: true),
            CreateModelResult(label: "risky", confidence: 0.95d, severity: "high"));

        Assert.Equal("42", disposition.AuditContext["comment_id"]);
        Assert.Equal("mock", disposition.AuditContext["provider"]);
        Assert.Equal("fsusblog-mock-moderation", disposition.AuditContext["model"]);
        Assert.Equal("risky", disposition.AuditContext["label"]);
        Assert.Equal("0.95", disposition.AuditContext["confidence"]);
        Assert.Equal(CommentModerationDispositionModes.AutoHideHighRisk, disposition.AuditContext["mode"]);
        Assert.Equal("model_risk_auto_hidden", disposition.AuditContext["reason"]);
        Assert.Equal(CommentModerationStatus.Pending.ToString(), disposition.AuditContext["previous_status"]);
        Assert.Equal(CommentModerationStatus.Hidden.ToString(), disposition.AuditContext["next_status"]);
        Assert.Equal("true", disposition.AuditContext["transition_allowed"]);
        Assert.Equal("false", disposition.AuditContext["requires_human_review"]);
    }

    [Fact]
    public void Decide_RiskyAlreadyHidden_DoesNotRepeatTransitionOrAuditAction()
    {
        CommentModerationDispositionPolicy policy = BuildPolicy(
            Setting("Moderation:AntiSpamModel:Mode", CommentModerationDispositionModes.AutoHideHighRisk));

        CommentModerationDisposition disposition = policy.Decide(
            CreateComment(status: CommentModerationStatus.Hidden),
            CreateRegionDecision(canPublish: true),
            CreateModelResult(label: "risky", confidence: 0.95d, severity: "high"));

        Assert.False(disposition.AutoApplied);
        Assert.Equal(CommentModerationStatus.Hidden, disposition.NextStatus);
        Assert.Equal("model_risk_noop_state", disposition.Reason);
        Assert.Equal("false", disposition.AuditContext["transition_allowed"]);
    }

    private static CommentModerationDispositionPolicy BuildPolicy(params KeyValuePair<string, string?>[] settings)
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(settings)
            .Build();
        return new CommentModerationDispositionPolicy(configuration);
    }

    private static KeyValuePair<string, string?> Setting(string key, string value)
        => new(key, value);

    private static Comment CreateComment(
        long id = 1,
        CommentModerationStatus status = CommentModerationStatus.Approved)
        => new()
        {
            Id = id,
            ArticleId = 10,
            Content = "hello",
            CreateTime = DateTime.UtcNow,
            ModerationStatus = status,
            ModerationReason = "published_pending_review"
        };

    private static RegionModerationDecision CreateRegionDecision(
        bool canPublish,
        bool requiresManualReview = false,
        bool hideUntilReviewed = false)
        => new(
            canPublish,
            RegionCodes.Global,
            1d,
            "unit",
            "ip-hash",
            [],
            [],
            [],
            "unit-policy",
            canPublish ? "allow" : "blocked",
            canPublish ? "allow" : "blocked",
            requiresManualReview,
            hideUntilReviewed);

    private static AntiSpamModerationResult CreateModelResult(
        string label,
        double confidence,
        string severity = "low",
        bool available = true,
        string status = AntiSpamModerationStatuses.Ok,
        string? errorCode = null,
        IReadOnlyList<AntiSpamModerationCategorySignal>? categories = null)
        => new(
            available,
            "mock",
            "fsusblog-mock-moderation",
            AntiSpamModerationContract.DefaultVersion,
            label,
            confidence,
            severity,
            categories?.FirstOrDefault()?.Id,
            false,
            categories ?? [],
            [],
            label,
            TimeSpan.Zero,
            status,
            errorCode,
            "default",
            new Dictionary<string, string>(StringComparer.Ordinal));
}
