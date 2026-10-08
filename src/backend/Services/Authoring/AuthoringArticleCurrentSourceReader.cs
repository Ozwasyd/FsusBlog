using System.Collections.Immutable;

using FsusBlog.Core.Services.Articles;
using FsusBlog.Shared.Contracts.AuthoringCanvas;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>Backend source stage only; no portable identity, projection or host/runtime authority is inferred.</summary>
public sealed record AuthoringArticleCurrentSource(
    AuthoringCanvasOwner Owner,
    Guid RequestId,
    AuthoringCanvasArticleReadAuthority Authority,
    AuthoringCanvasArticleReferenceRecord Article,
    RevisionComparePackage Package);

/// <summary>Refused reads never expose a package or target existence details.</summary>
public sealed record AuthoringArticleCurrentSourceReadResult(
    RevisionComparePackageReadStatus Status,
    AuthoringArticleCurrentSource? Source,
    string ReasonCode);

public interface IAuthoringArticleCurrentSourceReader
{
    Task<AuthoringArticleCurrentSourceReadResult> ReadCurrentAuthorizedAsync(
        AuthoringCanvasOwner owner, int articleId, Guid requestId,
        CancellationToken cancellationToken = default);
}

/// <summary>
/// Brackets the existing immutable revision package read with real permission, lifecycle and head observations.
/// The caller still needs its authenticated session boundary and a genuine portable/projection authority.
/// </summary>
public sealed class AuthoringArticleCurrentSourceReader(
    IAuthoringCanvasArticleReferenceReader articles,
    IRevisionComparePackageReader packages) : IAuthoringArticleCurrentSourceReader
{
    public async Task<AuthoringArticleCurrentSourceReadResult> ReadCurrentAuthorizedAsync(
        AuthoringCanvasOwner owner, int articleId, Guid requestId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        AuthoringCanvasContract.ValidateOwner(owner);
        if (owner.SiteScope != "primary-site" || articleId <= 0 || requestId == Guid.Empty)
        {
            return Refused(RevisionComparePackageReadStatus.Invalid);
        }
        const AuthoringCanvasReferencePermission permission = AuthoringCanvasReferencePermission.ArticleRead;
        AuthoringCanvasArticleReadAuthority beforeAuthority = await articles.ReadAuthorityAsync(
            owner, permission, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (!beforeAuthority.Authorized)
        {
            return Refused(RevisionComparePackageReadStatus.Unavailable);
        }
        if (!ValidAuthority(beforeAuthority))
        {
            return Refused(RevisionComparePackageReadStatus.Invalid);
        }
        AuthoringCanvasArticleReferenceRecord? before = await articles.ReadCurrentArticleAsync(
            owner, permission, articleId, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (before is null)
        {
            return Refused(RevisionComparePackageReadStatus.Unavailable);
        }
        if (!Enum.IsDefined(before.State))
        {
            return Refused(RevisionComparePackageReadStatus.Invalid);
        }
        if (before.State != AuthoringCanvasArticleState.Current)
        {
            return Refused(RevisionComparePackageReadStatus.Unavailable);
        }
        if (!ValidCurrent(before, articleId))
        {
            return Refused(RevisionComparePackageReadStatus.Invalid);
        }
        before = FreezeCurrent(before);

        // These are the two existing tokens for the configured single primary domain, not portable site identities.
        var reader = new RevisionCompareReadContext(owner.AdminPrincipalId,
            AuthoringRevisionCompareDraftContextProvider.PrimarySiteScope, requestId);
        var selector = new RevisionCompareSourceSelector(RevisionCompareSourceKind.CurrentRevision,
            RevisionId: before.CurrentRevision);
        RevisionComparePackageReadResult result = await packages.ReadAuthorizedAsync(
            reader, articleId, selector, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (!Enum.IsDefined(result.Status))
        {
            return Refused(RevisionComparePackageReadStatus.Invalid);
        }
        if (result.Status != RevisionComparePackageReadStatus.Available)
        {
            return Refused(result.Status);
        }
        RevisionComparePackage? package = result.Package;
        if (package is null || package.RawMarkdown.IsDefault
            || package.Metadata.IsDefault || package.Snapshots.IsDefault
            || package.Metadata.Any(static item => item is null || item.CanonicalValue is null)
            || package.Snapshots.Any(static item => item is null || item.Payload.IsDefault))
        {
            return Refused(RevisionComparePackageReadStatus.Invalid);
        }
        if (package.RawMarkdown.Length > RevisionCompareContract.AbsoluteMaxSourceBytes)
        {
            return Refused(RevisionComparePackageReadStatus.BudgetExceeded);
        }
        if (!RevisionComparePackageSeal.Verify(package)
            || package.ArticleId != articleId || package.SourceKind != RevisionCompareSourceKind.CurrentRevision
            || package.RevisionId != before.CurrentRevision || package.RevisionNo is not > 0)
        {
            return Refused(RevisionComparePackageReadStatus.Invalid);
        }

        AuthoringCanvasArticleReferenceRecord? after = await articles.ReadCurrentArticleAsync(
            owner, permission, articleId, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (after is null)
        {
            return Refused(RevisionComparePackageReadStatus.Unavailable);
        }
        if (!Enum.IsDefined(after.State))
        {
            return Refused(RevisionComparePackageReadStatus.Invalid);
        }
        if (after.State != AuthoringCanvasArticleState.Current)
        {
            return Refused(RevisionComparePackageReadStatus.Unavailable);
        }
        if (!ValidCurrent(after, articleId))
        {
            return Refused(RevisionComparePackageReadStatus.Invalid);
        }
        after = FreezeCurrent(after);
        AuthoringCanvasArticleReadAuthority afterAuthority = await articles.ReadAuthorityAsync(
            owner, permission, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (!afterAuthority.Authorized)
        {
            return Refused(RevisionComparePackageReadStatus.Unavailable);
        }
        if (!ValidAuthority(afterAuthority))
        {
            return Refused(RevisionComparePackageReadStatus.Invalid);
        }
        if (beforeAuthority != afterAuthority || before.CurrentRevision != after.CurrentRevision
            || before.CurrentDisplay != after.CurrentDisplay)
        {
            return Refused(RevisionComparePackageReadStatus.Stale);
        }
        return new(RevisionComparePackageReadStatus.Available,
            new(owner, requestId, afterAuthority, after, package), "accepted");
    }

    private static bool ValidAuthority(AuthoringCanvasArticleReadAuthority value)
        => value.PrincipalGeneration > 0 && value.ContentGeneration > 0
            && value.ArticleCount >= 0 && value.RevisionCount >= 0
            && value.PermissionFingerprint is { Length: 64 }
            && value.PermissionFingerprint.All(static item => item is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static bool ValidCurrent(AuthoringCanvasArticleReferenceRecord value, int articleId)
        => value.ArticleId == articleId && value.CurrentRevision > 0
            && value.CurrentDisplay is not null && value.CurrentDisplay.Revision == value.CurrentRevision
            && value.PinnedDisplays is not null && value.PinnedDisplays.Count == 0;

    private static AuthoringCanvasArticleReferenceRecord FreezeCurrent(AuthoringCanvasArticleReferenceRecord value)
        => value with
        {
            PinnedDisplays = ImmutableDictionary<long, AuthoringCanvasArticleRevisionDisplayFact>.Empty
        };

    private static AuthoringArticleCurrentSourceReadResult Refused(RevisionComparePackageReadStatus status)
        => new(status, null, status switch
        {
            RevisionComparePackageReadStatus.Unavailable => "authoring_current_source_unavailable",
            RevisionComparePackageReadStatus.Stale => "authoring_current_source_stale",
            RevisionComparePackageReadStatus.BudgetExceeded => "authoring_current_source_budget_exceeded",
            _ => "authoring_current_source_invalid"
        });
}
