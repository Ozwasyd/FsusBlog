using SqlSugar;

using FsusBlog.Core.Services.Articles;
using FsusBlog.Shared.Contracts.ArticleEmbeds;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Internal authorized source, bound to its persisted immutable incarnation. This is neither
/// an editor epoch nor a publication coordinate or a renderer projection grant.
/// </summary>
public sealed record CurrentArticleEmbedTargetSource(
    ArticleRelationRevisionCoordinate Coordinate,
    RevisionComparePackage Package);

/// <summary>
/// Zero-write portable article lookup through the canonical coordinate and authorized source
/// readers. Missing, denied, unbound and drifting targets return the same content-free null.
/// Heading/block targets require canonical projection facts and are not admitted here.
/// </summary>
public sealed class CurrentArticleEmbedTargetReader(
    ISqlSugarClient db,
    ArticleRelationSourceCoordinateAuthority coordinates,
    IAuthoringRevisionCompareAuthority authority,
    IRevisionComparePackageReader packages)
{
    public async Task<CurrentArticleEmbedTargetSource?> ReadAsync(
        RevisionCompareReadContext context,
        ArticleEmbedTargetIdentity target,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!ArticleEmbedTargetCodec.Validate(target).IsValid || target.Kind != ArticleEmbedTargetKind.Article)
        {
            return null;
        }

        ArticleRelationArticleCoordinate? article = await coordinates.FindArticleAsync(
            db, target.PortableArticleIdentity, cancellationToken).ConfigureAwait(false);
        if (article is null)
        {
            return null;
        }
        AuthoringRevisionCompareArticle? admitted = await authority.GetAuthorizedArticleAsync(
            context, article.ArticleId, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (admitted?.ArticleId != article.ArticleId || admitted.CurrentRevisionId is not > 0)
        {
            return null;
        }
        long revisionId = admitted.CurrentRevisionId.Value;
        ArticleRelationRevisionCoordinate? before = await coordinates.ReadRevisionAsync(
            db, article.ArticleId, revisionId, cancellationToken).ConfigureAwait(false);
        if (before is null || before.ArticleIdentity != target.PortableArticleIdentity)
        {
            return null;
        }

        RevisionComparePackageReadResult read = await packages.ReadAuthorizedAsync(
            context, article.ArticleId,
            new RevisionCompareSourceSelector(RevisionCompareSourceKind.CurrentRevision, RevisionId: revisionId),
            cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        RevisionComparePackage? package = read.Package;
        if (read.Status != RevisionComparePackageReadStatus.Available || package is null
            || package.ArticleId != before.ArticleId || package.RevisionId != before.RevisionId
            || package.RevisionNo != before.RevisionNo || package.SourceKind != RevisionCompareSourceKind.CurrentRevision
            || package.ServerRevision is not null || package.DocumentEpoch is not null
            || !RevisionComparePackageSeal.Verify(package))
        {
            return null;
        }

        ArticleRelationRevisionCoordinate? after = await coordinates.ReadRevisionAsync(
            db, article.ArticleId, revisionId, cancellationToken).ConfigureAwait(false);
        ArticleRelationArticleCoordinate? mapped = await coordinates.FindArticleAsync(
            db, target.PortableArticleIdentity, cancellationToken).ConfigureAwait(false);
        AuthoringRevisionCompareArticle? current = await authority.GetAuthorizedArticleAsync(
            context, article.ArticleId, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        return after == before && mapped == article && current == admitted
            ? new CurrentArticleEmbedTargetSource(before, package)
            : null;
    }
}
