using System.Text.Json;

using FsusBlog.Server.Entities;

namespace FsusBlog.Server.Infrastructure.Integrity;

public static class ArticleResponsibilitySnapshotBuilder
{
    private static readonly JsonSerializerOptions s_jsonOptions = new(JsonSerializerDefaults.Web);

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

        IReadOnlyList<Models.Dtos.PrepublishIssue> issues = ArticleResponsibilityGovernance.Evaluate(draft);
        if (issues.Any(static issue => string.Equals(issue.Severity, "error", StringComparison.OrdinalIgnoreCase)))
        {
            var firstError = issues.First(static issue => string.Equals(issue.Severity, "error", StringComparison.OrdinalIgnoreCase));
            throw new InvalidOperationException($"responsibility_evaluation_failed:{firstError.Code}");
        }

        string authorsJson = JsonSerializer.Serialize(draft.Authors, s_jsonOptions);
        string? reviewerJson = draft.Reviewer is null ? null : JsonSerializer.Serialize(draft.Reviewer, s_jsonOptions);
        string sourcesJson = JsonSerializer.Serialize(draft.Sources, s_jsonOptions);

        return new ArticleResponsibilitySnapshot
        {
            ArticleId = articleId,
            ArticleRevisionId = revisionId,
            RevisionNo = revisionNo,
            ResponsibilityVersion = responsibilityVersion,
            PreviousSnapshotId = previousSnapshotId,
            InheritSiteAuthor = draft.InheritSiteAuthor,
            AuthorsJson = authorsJson,
            ReviewerJson = reviewerJson,
            SourcesJson = sourcesJson,
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
