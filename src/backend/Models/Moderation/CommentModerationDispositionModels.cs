using FsusBlog.Server.Entities;

namespace FsusBlog.Server.Models.Moderation;

public static class CommentModerationDispositionModes
{
    public const string ScoreOnly = "score-only";
    public const string AutoLowRiskApprove = "auto-low-risk-approve";
    public const string AutoHideHighRisk = "auto-hide-high-risk";
    public const string StrictAutoModerate = "strict-auto-moderate";
}

public sealed record CommentModerationDisposition(
    CommentModerationStatus NextStatus,
    string Reason,
    bool AutoApplied,
    bool RequiresHumanReview,
    string Mode,
    IReadOnlyDictionary<string, string> AuditContext);
