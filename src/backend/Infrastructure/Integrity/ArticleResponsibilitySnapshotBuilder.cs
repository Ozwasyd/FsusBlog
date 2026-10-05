using FsusBlog.Contracts.Articles;
using FsusBlog.Server.Entities;

namespace FsusBlog.Server.Infrastructure.Integrity;

public static class ArticleResponsibilitySnapshotBuilder
{
    public static ArticleResponsibilitySnapshot Build(
        int articleId,
        long revisionId,
        int revisionNo,
        int responsibilityVersion,
        long? previousSnapshotId,
        ArticleResponsibilityDraft draft,
        DateTime createdAt)
    {
        ArgumentNullException.ThrowIfNull(draft);

        IReadOnlyList<PrepublishIssue> issues = ArticleResponsibilityGovernance.Evaluate(draft);
        if (issues.Any(static issue => string.Equals(issue.Severity, "error", StringComparison.OrdinalIgnoreCase)))
        {
            var firstError = issues.First(static issue => string.Equals(issue.Severity, "error", StringComparison.OrdinalIgnoreCase));
            throw new InvalidOperationException($"responsibility_evaluation_failed:{firstError.Code}");
        }

        ArticleResponsibilityStorageEncoding encoded = ArticleResponsibilityStorageEncoding.Encode(draft);

        return new ArticleResponsibilitySnapshot
        {
            ArticleId = articleId,
            ArticleRevisionId = revisionId,
            RevisionNo = revisionNo,
            ResponsibilityVersion = responsibilityVersion,
            PreviousSnapshotId = previousSnapshotId,
            InheritSiteAuthor = draft.InheritSiteAuthor,
            AuthorsJson = encoded.AuthorsJson,
            ReviewerJson = encoded.ReviewerJson,
            SourcesJson = encoded.SourcesJson,
            UpdateSummary = draft.UpdateSummary,
            UpdateReason = draft.UpdateReason,
            EffectiveAt = draft.EffectiveAt,
            ConclusionImpact = draft.ConclusionImpact,
            Methodology = draft.Methodology,
            Applicability = draft.Applicability,
            Limitations = draft.Limitations,
            ResponsiblePersonConfirmed = draft.ResponsiblePersonConfirmed,
            CreatedAt = createdAt
        };
    }
}
