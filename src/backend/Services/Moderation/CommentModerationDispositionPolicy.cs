using System.Globalization;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Moderation;

namespace FsusBlog.Server.Services.Moderation;

public sealed class CommentModerationDispositionPolicy(IConfiguration configuration) : ICommentModerationDispositionPolicy
{
    private static readonly HashSet<string> RiskCategoryIds = new(StringComparer.Ordinal)
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
        _ = regionDecision;
        string mode = NormalizeMode(configuration["Moderation:AntiSpamModel:Mode"]);
        CommentModerationStatus nextStatus = comment.ModerationStatus;
        bool autoApplied = false;
        bool requiresHumanReview = false;
        string reason = "score_only";

        if (!modelResult.Available || !string.Equals(modelResult.Status, AntiSpamModerationStatuses.Ok, StringComparison.Ordinal))
        {
            reason = "model_unavailable";
        }
        else if (IsModelRiskHit(modelResult))
        {
            nextStatus = CommentModerationStatus.Hidden;
            autoApplied = nextStatus != comment.ModerationStatus;
            double borderlineThreshold = ResolveThreshold("Moderation:AntiSpamModel:BorderlineRiskConfidenceThreshold", 0.90d);
            requiresHumanReview = modelResult.Confidence < borderlineThreshold;
            reason = requiresHumanReview ? "model_risk_borderline_review" : "model_risk_auto_hidden";
        }
        else
        {
            reason = "model_clean";
        }

        return new CommentModerationDisposition(
            nextStatus,
            reason,
            autoApplied,
            requiresHumanReview,
            mode,
            BuildAuditContext(comment, modelResult, mode, reason, nextStatus, autoApplied, requiresHumanReview));
    }

    private static bool IsModelRiskHit(AntiSpamModerationResult modelResult)
        => modelResult.Label is "risky" or "blocked_candidate"
            || modelResult.Severity is "high" or "critical"
            || modelResult.Categories.Any(static category =>
                category.Severity is "high" or "critical"
                || RiskCategoryIds.Contains(category.Id));

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
        bool autoApplied,
        bool requiresHumanReview)
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
            ["auto_applied"] = autoApplied ? "true" : "false",
            ["requires_human_review"] = requiresHumanReview ? "true" : "false"
        };
}
