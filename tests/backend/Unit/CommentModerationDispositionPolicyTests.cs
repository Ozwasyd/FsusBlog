using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Services.Moderation;
using Microsoft.Extensions.Configuration;

namespace FsusBlog.Server.Tests.Unit;

public sealed class CommentModerationDispositionPolicyTests
{
    [Fact]
    public void Decide_DefaultScoreOnly_KeepsCommentPending()
    {
        CommentModerationDispositionPolicy policy = BuildPolicy();

        CommentModerationDisposition disposition = policy.Decide(
            CreateComment(),
            CreateRegionDecision(canPublish: true),
            CreateModelResult(label: "clean", confidence: 0.99d, severity: "low"));

        Assert.False(disposition.AutoApplied);
        Assert.True(disposition.RequiresHumanReview);
        Assert.Equal(CommentModerationStatus.Pending, disposition.NextStatus);
        Assert.Equal(CommentModerationDispositionModes.ScoreOnly, disposition.Mode);
        Assert.Equal("score_only", disposition.Reason);
    }

    [Fact]
    public void Decide_AutoLowRiskApprove_ApprovesCleanHighConfidenceWhenRegionAllows()
    {
        CommentModerationDispositionPolicy policy = BuildPolicy(
            Setting("Moderation:AntiSpamModel:Mode", CommentModerationDispositionModes.AutoLowRiskApprove),
            Setting("Moderation:AntiSpamModel:AutoApproveConfidenceThreshold", "0.95"));

        CommentModerationDisposition disposition = policy.Decide(
            CreateComment(),
            CreateRegionDecision(canPublish: true),
            CreateModelResult(label: "clean", confidence: 0.98d, severity: "low"));

        Assert.True(disposition.AutoApplied);
        Assert.False(disposition.RequiresHumanReview);
        Assert.Equal(CommentModerationStatus.Approved, disposition.NextStatus);
        Assert.Equal("model_clean_high_confidence", disposition.Reason);
    }

    [Fact]
    public void Decide_AutoLowRiskApprove_DoesNotOverrideRegionManualReview()
    {
        CommentModerationDispositionPolicy policy = BuildPolicy(
            Setting("Moderation:AntiSpamModel:Mode", CommentModerationDispositionModes.AutoLowRiskApprove));

        CommentModerationDisposition disposition = policy.Decide(
            CreateComment(),
            CreateRegionDecision(canPublish: true, requiresManualReview: true),
            CreateModelResult(label: "clean", confidence: 0.99d, severity: "low"));

        Assert.False(disposition.AutoApplied);
        Assert.True(disposition.RequiresHumanReview);
        Assert.Equal(CommentModerationStatus.Pending, disposition.NextStatus);
        Assert.Equal("region_requires_human_review", disposition.Reason);
    }

    [Fact]
    public void Decide_AutoHideHighRisk_HidesRiskyHighConfidenceComment()
    {
        CommentModerationDispositionPolicy policy = BuildPolicy(
            Setting("Moderation:AntiSpamModel:Mode", CommentModerationDispositionModes.AutoHideHighRisk),
            Setting("Moderation:AntiSpamModel:AutoHideConfidenceThreshold", "0.9"));

        CommentModerationDisposition disposition = policy.Decide(
            CreateComment(),
            CreateRegionDecision(canPublish: true),
            CreateModelResult(
                label: "blocked_candidate",
                confidence: 0.94d,
                severity: "high",
                categories: [new AntiSpamModerationCategorySignal("spam_repeat", 0.94d, "high", "show_category_only")]));

        Assert.True(disposition.AutoApplied);
        Assert.False(disposition.RequiresHumanReview);
        Assert.Equal(CommentModerationStatus.Hidden, disposition.NextStatus);
        Assert.Equal("model_high_risk_auto_hide", disposition.Reason);
    }

    [Fact]
    public void Decide_ProviderUnavailable_DoesNotAutoApply()
    {
        CommentModerationDispositionPolicy policy = BuildPolicy(
            Setting("Moderation:AntiSpamModel:Mode", CommentModerationDispositionModes.AutoLowRiskApprove));

        CommentModerationDisposition disposition = policy.Decide(
            CreateComment(),
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
        Assert.Equal("model_unavailable", disposition.Reason);
    }

    [Fact]
    public void Decide_AutoDisposition_CarriesAuditContext()
    {
        CommentModerationDispositionPolicy policy = BuildPolicy(
            Setting("Moderation:AntiSpamModel:Mode", CommentModerationDispositionModes.AutoHideHighRisk));

        CommentModerationDisposition disposition = policy.Decide(
            CreateComment(42),
            CreateRegionDecision(canPublish: true),
            CreateModelResult(label: "risky", confidence: 0.95d, severity: "high"));

        Assert.Equal("42", disposition.AuditContext["comment_id"]);
        Assert.Equal("mock", disposition.AuditContext["provider"]);
        Assert.Equal("fsusblog-mock-moderation", disposition.AuditContext["model"]);
        Assert.Equal("risky", disposition.AuditContext["label"]);
        Assert.Equal("0.95", disposition.AuditContext["confidence"]);
        Assert.Equal(CommentModerationDispositionModes.AutoHideHighRisk, disposition.AuditContext["mode"]);
        Assert.Equal("model_high_risk_auto_hide", disposition.AuditContext["reason"]);
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

    private static Comment CreateComment(long id = 1)
        => new()
        {
            Id = id,
            ArticleId = 10,
            Content = "hello",
            CreateTime = DateTime.UtcNow,
            ModerationStatus = CommentModerationStatus.Pending,
            ModerationReason = "pending_review"
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
