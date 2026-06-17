using System.Globalization;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Moderation;

namespace FsusBlog.Server.Services.Moderation;

public sealed class CommentModerationDispositionPolicy(IConfiguration configuration) : ICommentModerationDispositionPolicy
{
    private static readonly HashSet<string> AutoHideSecondRoundCategories = new(StringComparer.Ordinal)
    {
        "advertising",
        "contact_lead",
        "scam",
        "spam_repeat",
        "malicious_link",
        "html_risk"
    };

    public CommentModerationDisposition Decide(
        Comment comment,
        RegionModerationDecision regionDecision,
        AntiSpamModerationResult modelResult)
    {
        string mode = NormalizeMode(configuration["Moderation:AntiSpamModel:Mode"]);
        CommentModerationStatus nextStatus = comment.ModerationStatus;
        bool autoApplied = false;
        string reason = "score_only";

        if (!modelResult.Available || !string.Equals(modelResult.Status, AntiSpamModerationStatuses.Ok, StringComparison.Ordinal))
        {
            reason = "model_unavailable";
        }
        else if (mode == CommentModerationDispositionModes.AutoLowRiskApprove)
        {
            reason = DecideAutoLowRiskApprove(modelResult, regionDecision, out nextStatus, out autoApplied);
        }
        else if (mode == CommentModerationDispositionModes.AutoHideHighRisk)
        {
            reason = DecideAutoHideHighRisk(modelResult, comment.ModerationStatus, out nextStatus, out autoApplied);
        }
        else if (mode == CommentModerationDispositionModes.StrictAutoModerate)
        {
            reason = "strict_auto_moderate_reserved";
        }

        return new CommentModerationDisposition(
            nextStatus,
            reason,
            autoApplied,
            RequiresHumanReview: !autoApplied,
            mode,
            BuildAuditContext(comment, modelResult, mode, reason, nextStatus, autoApplied));
    }

    private string DecideAutoLowRiskApprove(
        AntiSpamModerationResult modelResult,
        RegionModerationDecision regionDecision,
        out CommentModerationStatus nextStatus,
        out bool autoApplied)
    {
        nextStatus = CommentModerationStatus.Pending;
        autoApplied = false;

        if (!regionDecision.CanPublish)
        {
            return "region_blocks_publication";
        }
        if (regionDecision.RequiresManualReview || regionDecision.HideUntilReviewed)
        {
            return "region_requires_human_review";
        }

        double threshold = ResolveThreshold("Moderation:AntiSpamModel:AutoApproveConfidenceThreshold", 0.95d);
        if (IsCleanHighConfidence(modelResult, threshold))
        {
            nextStatus = CommentModerationStatus.Approved;
            autoApplied = true;
            return "model_clean_high_confidence";
        }

        return "model_requires_human_review";
    }

    private string DecideAutoHideHighRisk(
        AntiSpamModerationResult modelResult,
        CommentModerationStatus currentStatus,
        out CommentModerationStatus nextStatus,
        out bool autoApplied)
    {
        nextStatus = currentStatus;
        autoApplied = false;

        double threshold = ResolveThreshold("Moderation:AntiSpamModel:AutoHideConfidenceThreshold", 0.90d);
        bool highRiskLabel = modelResult.Label is "risky" or "blocked_candidate";
        bool highRiskByConfidence = highRiskLabel && modelResult.Confidence >= threshold;
        bool highRiskBySecondRound = modelResult.NeedsSecondRound
            && modelResult.Categories.Any(static category => AutoHideSecondRoundCategories.Contains(category.Id));
        if (highRiskByConfidence || highRiskBySecondRound)
        {
            nextStatus = CommentModerationStatus.Hidden;
            autoApplied = true;
            return "model_high_risk_auto_hide";
        }

        return "model_requires_human_review";
    }

    private static bool IsCleanHighConfidence(AntiSpamModerationResult modelResult, double threshold)
        => string.Equals(modelResult.Label, "clean", StringComparison.Ordinal)
            && string.Equals(modelResult.Severity, "low", StringComparison.Ordinal)
            && modelResult.Confidence >= threshold
            && !modelResult.NeedsSecondRound
            && modelResult.Categories.All(static category => category.Severity is not ("high" or "critical"));

    private double ResolveThreshold(string key, double fallback)
        => Math.Clamp(configuration.GetValue<double?>(key) ?? fallback, 0d, 1d);

    private static string NormalizeMode(string? raw)
        => (raw ?? CommentModerationDispositionModes.ScoreOnly).Trim().ToLowerInvariant() switch
        {
            CommentModerationDispositionModes.AutoLowRiskApprove => CommentModerationDispositionModes.AutoLowRiskApprove,
            CommentModerationDispositionModes.AutoHideHighRisk => CommentModerationDispositionModes.AutoHideHighRisk,
            CommentModerationDispositionModes.StrictAutoModerate => CommentModerationDispositionModes.StrictAutoModerate,
            _ => CommentModerationDispositionModes.ScoreOnly
        };

    private static IReadOnlyDictionary<string, string> BuildAuditContext(
        Comment comment,
        AntiSpamModerationResult modelResult,
        string mode,
        string reason,
        CommentModerationStatus nextStatus,
        bool autoApplied)
        => new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["comment_id"] = comment.Id.ToString(CultureInfo.InvariantCulture),
            ["provider"] = modelResult.Provider,
            ["model"] = modelResult.Model,
            ["contract_version"] = modelResult.ContractVersion,
            ["label"] = modelResult.Label,
            ["confidence"] = modelResult.Confidence.ToString("0.###", CultureInfo.InvariantCulture),
            ["status"] = modelResult.Status,
            ["error_code"] = modelResult.ErrorCode ?? string.Empty,
            ["mode"] = mode,
            ["reason"] = reason,
            ["next_status"] = nextStatus.ToString(),
            ["auto_applied"] = autoApplied ? "true" : "false"
        };
}
