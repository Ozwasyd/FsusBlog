using System.Globalization;

using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Infrastructure.Integrity;
using FsusBlog.Server.Models.Dtos;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>Outcome of a read bounded by the existing current authoring authority.</summary>
public enum CurrentAuthoringResponsibilityReadStatus
{
    Current,
    Absent,
    Stale,
    Unavailable
}

/// <summary>
/// Contains responsibility only when both observations agree and the existing
/// responsibility history contains an explicitly confirmed current version.
/// Unavailable deliberately shares the denied and missing information shape.
/// </summary>
public sealed record CurrentAuthoringResponsibilityReadResult(
    CurrentAuthoringResponsibilityReadStatus Status,
    ArticleResponsibilityVersionResponse? Responsibility);

/// <summary>
/// Composes existing article/revision/ArticleWrite authority with responsibility
/// history. Historical packages and publication-pinned responsibility do not
/// establish current authority. This reader neither writes nor caches responsibility.
/// </summary>
/// <remarks>
/// The original DI owner can register AddScoped&lt;CurrentAuthoringResponsibilityReader&gt;().
/// An authorized authoring caller supplies its existing reader context and current
/// revision ID; ServerDraftSaveRequest has no responsibility input to compose.
/// Matching observations are read acceptance, not a transactional lease.
/// </remarks>
public sealed class CurrentAuthoringResponsibilityReader(
    IAuthoringRevisionCompareAuthority authority,
    IArticleResponsibilityAuthoringService responsibilityService)
{
    /// <summary>
    /// Reads the latest responsibility version for the expected current revision,
    /// rechecking current permission, head, revision and responsibility after reading.
    /// Cancellation propagates; denied/missing reads return no responsibility data.
    /// </summary>
    public async Task<CurrentAuthoringResponsibilityReadResult> ReadAuthorizedAsync(
        RevisionCompareReadContext context,
        int articleId,
        long expectedCurrentRevisionId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (articleId <= 0 || expectedCurrentRevisionId <= 0)
        {
            return Result(CurrentAuthoringResponsibilityReadStatus.Unavailable);
        }

        AuthoringRevisionCompareArticle? beforeArticle = await authority.GetAuthorizedArticleAsync(
                context, articleId, cancellationToken)
            .ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (beforeArticle is null || beforeArticle.ArticleId != articleId)
        {
            return Result(CurrentAuthoringResponsibilityReadStatus.Unavailable);
        }
        if (beforeArticle.CurrentRevisionId != expectedCurrentRevisionId)
        {
            return Result(CurrentAuthoringResponsibilityReadStatus.Stale);
        }

        ArticleRevisionDetailResponse? beforeRevision = await authority.GetRevisionAsync(
                articleId, expectedCurrentRevisionId, cancellationToken)
            .ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (!MatchesRevision(beforeRevision, articleId, expectedCurrentRevisionId))
        {
            return Result(CurrentAuthoringResponsibilityReadStatus.Unavailable);
        }

        IReadOnlyList<ArticleResponsibilityVersionResponse>? beforeHistory = await responsibilityService.GetHistoryAsync(
                articleId, expectedCurrentRevisionId, cancellationToken)
            .ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (!TryReadLatest(beforeHistory, articleId, expectedCurrentRevisionId, beforeRevision!.RevisionNo, out var before))
        {
            return Result(CurrentAuthoringResponsibilityReadStatus.Unavailable);
        }

        // Freeze collection payloads before awaiting another authority observation.
        // The revision package's responsibility can be publication-pinned and is ignored.
        IReadOnlyList<ArticleResponsibilityVersionResponse>? afterHistory = await responsibilityService.GetHistoryAsync(
                articleId, expectedCurrentRevisionId, cancellationToken)
            .ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (!TryReadLatest(afterHistory, articleId, expectedCurrentRevisionId, beforeRevision.RevisionNo, out var after))
        {
            return Result(CurrentAuthoringResponsibilityReadStatus.Unavailable);
        }
        ArticleRevisionDetailResponse? afterRevision = await authority.GetRevisionAsync(
                articleId, expectedCurrentRevisionId, cancellationToken)
            .ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        AuthoringRevisionCompareArticle? afterArticle = await authority.GetAuthorizedArticleAsync(
                context, articleId, cancellationToken)
            .ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (afterArticle is null || afterArticle.ArticleId != articleId
            || !MatchesRevision(afterRevision, articleId, expectedCurrentRevisionId))
        {
            return Result(CurrentAuthoringResponsibilityReadStatus.Unavailable);
        }
        if (afterArticle.CurrentRevisionId != expectedCurrentRevisionId
            || afterRevision!.RevisionNo != beforeRevision.RevisionNo
            || !SameResponsibility(before, after))
        {
            return Result(CurrentAuthoringResponsibilityReadStatus.Stale);
        }
        if (before is null || !before.ResponsiblePersonConfirmed
            || (!before.InheritSiteAuthor && before.Authors.Count == 0))
        {
            return Result(CurrentAuthoringResponsibilityReadStatus.Absent);
        }

        return new CurrentAuthoringResponsibilityReadResult(
            CurrentAuthoringResponsibilityReadStatus.Current, before);
    }

    private static bool MatchesRevision(ArticleRevisionDetailResponse? revision, int articleId, long revisionId)
        => revision is not null
            && revision.ArticleId == articleId
            && revision.Id == revisionId.ToString(CultureInfo.InvariantCulture)
            && revision.RevisionNo > 0;

    private static bool TryReadLatest(
        IReadOnlyList<ArticleResponsibilityVersionResponse>? history,
        int articleId,
        long revisionId,
        int revisionNo,
        out ArticleResponsibilityVersionResponse? latest)
    {
        latest = null;
        if (history is null)
        {
            return false;
        }
        string expectedRevisionId = revisionId.ToString(CultureInfo.InvariantCulture);
        var versions = new HashSet<int>();
        foreach (ArticleResponsibilityVersionResponse version in history)
        {
            if (version.ArticleId != articleId || version.ArticleRevisionId != expectedRevisionId
                || version.RevisionNo != revisionNo || version.ResponsibilityVersion <= 0
                || !long.TryParse(version.Id, NumberStyles.None, CultureInfo.InvariantCulture, out long snapshotId)
                || snapshotId <= 0 || !versions.Add(version.ResponsibilityVersion))
            {
                return false;
            }
            if (latest is null || version.ResponsibilityVersion > latest.ResponsibilityVersion)
            {
                latest = version;
            }
        }
        if (latest is not null)
        {
            latest = latest with
            {
                Authors = Array.AsReadOnly(latest.Authors.ToArray()),
                Sources = Array.AsReadOnly(latest.Sources.ToArray())
            };
        }
        return true;
    }

    private static bool SameResponsibility(
        ArticleResponsibilityVersionResponse? before,
        ArticleResponsibilityVersionResponse? after)
    {
        if (before is null || after is null)
        {
            return before is null && after is null;
        }
        return (before with
        {
            Authors = after.Authors,
            Sources = after.Sources
        }) == after
            && before.Authors.SequenceEqual(after.Authors)
            && before.Sources.SequenceEqual(after.Sources);
    }

    private static CurrentAuthoringResponsibilityReadResult Result(CurrentAuthoringResponsibilityReadStatus status)
        => new(status, null);
}
