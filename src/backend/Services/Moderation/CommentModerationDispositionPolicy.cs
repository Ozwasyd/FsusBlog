using System.Globalization;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Moderation;

namespace FsusBlog.Server.Services.Moderation;

public sealed class CommentModerationDispositionPolicy(IConfiguration configuration) : ICommentModerationDispositionPolicy
{
    private static readonly HashSet<string> s_riskCategoryIds = new(StringComparer.Ordinal)
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
        CommentModerationStatus requestedStatus = comment.ModerationStatus;
        bool requiresHumanReview = false;
        string reason = "score_only";

        if (!modelResult.Available || !string.Equals(modelResult.Status, AntiSpamModerationStatuses.Ok, StringComparison.Ordinal))
        {
            bool failOpen = configuration.GetValue<bool?>("Moderation:AntiSpamModel:FailOpen") ?? false;
            bool mayPublish = failOpen
                && regionDecision.CanPublish
                && !regionDecision.RequiresManualReview
                && !regionDecision.HideUntilReviewed
                && comment.AnonymousRequiresModeration != true;
            requestedStatus = mayPublish ? CommentModerationStatus.Approved : comment.ModerationStatus;
            requiresHumanReview = !mayPublish;
            reason = mayPublish ? "model_unavailable_fail_open" : "model_unavailable_pending";
        }
        else if (IsModelRiskHit(modelResult))
        {
            double borderlineThreshold = ResolveThreshold("Moderation:AntiSpamModel:BorderlineRiskConfidenceThreshold", 0.90d);
            requiresHumanReview = modelResult.Confidence < borderlineThreshold;
            if (mode is CommentModerationDispositionModes.AutoHideHighRisk
                or CommentModerationDispositionModes.StrictAutoModerate)
            {
                requestedStatus = CommentModerationStatus.Hidden;
                reason = requiresHumanReview ? "model_risk_borderline_review" : "model_risk_auto_hidden";
            }
            else
            {
                requiresHumanReview = true;
                reason = "model_risk_pending_review";
            }
        }
        else
        {
            bool mayAutoApprove = mode is CommentModerationDispositionModes.AutoLowRiskApprove
                or CommentModerationDispositionModes.StrictAutoModerate;
            bool regionAllowsApproval = regionDecision.CanPublish
                && !regionDecision.RequiresManualReview
                && !regionDecision.HideUntilReviewed;
            if (mayAutoApprove && regionAllowsApproval)
            {
                double threshold = ResolveThreshold("Moderation:AntiSpamModel:AutoApproveConfidenceThreshold", 0.95d);
                if (modelResult.Confidence >= threshold)
                {
                    requestedStatus = CommentModerationStatus.Approved;
                    reason = "model_clean_auto_approved";
                }
                else
                {
                    requiresHumanReview = true;
                    reason = "model_clean_below_approval_threshold";
                }
            }
            else
            {
                requiresHumanReview = comment.ModerationStatus == CommentModerationStatus.Pending;
                reason = regionAllowsApproval ? "model_clean_pending_policy" : "model_clean_region_review";
            }
        }

        bool transitionAllowed = CommentModerationTransitions.IsAllowed(comment.ModerationStatus, requestedStatus);
        CommentModerationStatus nextStatus = transitionAllowed ? requestedStatus : comment.ModerationStatus;
        bool autoApplied = transitionAllowed;
        if (requestedStatus == comment.ModerationStatus
            && reason is "model_risk_auto_hidden" or "model_risk_borderline_review")
        {
            reason = "model_risk_noop_state";
        }
        if (requestedStatus != comment.ModerationStatus && !transitionAllowed)
        {
            requiresHumanReview = true;
            reason = "model_transition_not_allowed";
        }

        return new CommentModerationDisposition(
            nextStatus,
            reason,
            autoApplied,
            requiresHumanReview,
            mode,
            BuildAuditContext(
                comment,
                modelResult,
                mode,
                reason,
                requestedStatus,
                nextStatus,
                autoApplied,
                transitionAllowed,
                requiresHumanReview));
    }

    private static bool IsModelRiskHit(AntiSpamModerationResult modelResult)
        => modelResult.Label is "risky" or "blocked_candidate"
            || modelResult.Severity is "high" or "critical"
            || modelResult.Categories.Any(static category =>
                category.Severity is "high" or "critical"
                || s_riskCategoryIds.Contains(category.Id));

    private double ResolveThreshold(string key, double fallback)
        => Math.Clamp(configuration.GetValue<double?>(key) ?? fallback, 0d, 1d);

    private static string NormalizeMode(string? raw)
        => (TextHelpers.LowerTrimmed(raw) ?? CommentModerationDispositionModes.ScoreOnly) switch
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
        CommentModerationStatus requestedStatus,
        CommentModerationStatus nextStatus,
        bool autoApplied,
        bool transitionAllowed,
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
            ["previous_status"] = comment.ModerationStatus.ToString(),
            ["requested_status"] = requestedStatus.ToString(),
            ["next_status"] = nextStatus.ToString(),
            ["transition_allowed"] = transitionAllowed ? "true" : "false",
            ["auto_applied"] = autoApplied ? "true" : "false",
            ["requires_human_review"] = requiresHumanReview ? "true" : "false"
        };
}
