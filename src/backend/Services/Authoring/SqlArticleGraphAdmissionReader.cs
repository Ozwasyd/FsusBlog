using SqlSugar;

using FsusBlog.Server.Entities;
using FsusBlog.Shared.Contracts.ArticleEmbeds;

namespace FsusBlog.Server.Services.Authoring;

internal sealed record ArticleGraphCurrentArticleReadRequest(
    AuthorArticlePinOwner Owner,
    Guid RequestId,
    string ArticleIdentity,
    string RevisionIdentity);

internal sealed record ArticleGraphCurrentArticleAdmission(
    Guid ReadId,
    ArticleRelationRevisionCoordinate Source,
    AuthorArticlePinArticleFact Article,
    AuthorArticlePinPermissionSnapshot Permission);

/// <summary>
/// Zero-write admission of one persisted current root. The authenticated host supplies Owner;
/// editor/actor/site binding and graph expansion remain integration responsibilities (#2474).
/// SourceEpoch identifies the durable source incarnation and never supplies a runtime DocumentEpoch.
/// </summary>
public sealed class SqlArticleGraphAdmissionReader(
    ISqlSugarClient db,
    ArticleRelationSourceCoordinateAuthority coordinates,
    IAuthorArticlePinPermissionProjectionProvider permissions,
    IAuthorArticlePinArticleProjectionSource articles)
{
    internal async Task<ArticleGraphCurrentArticleAdmission?> ReadCurrentAsync(
        ArticleGraphCurrentArticleReadRequest request,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        try
        {
            AuthorArticlePinContract.ValidateOwner(request.Owner);
            AuthorArticlePinContract.ValidateRequestId(request.RequestId);
            if (!ArticleEmbedTargetCodec.IsPortableArticleIdentity(request.ArticleIdentity)
                || !IsRevisionIdentity(request.RevisionIdentity))
            {
                return null;
            }

            // Authenticate live context before even resolving the portable identity.
            AuthorArticlePinPermissionSnapshot? preflight = await ReadPermissionAsync(request, [], cancellationToken)
                .ConfigureAwait(false);
            if (preflight is null)
            {
                return null;
            }
            ArticleRelationArticleCoordinate? binding = await coordinates.FindArticleAsync(
                db, request.ArticleIdentity, cancellationToken).ConfigureAwait(false);
            if (binding is null || binding.ArticleId <= 0 || binding.ArticleIdentity != request.ArticleIdentity)
            {
                return null;
            }
            IReadOnlyList<int> articleIds = Array.AsReadOnly(new[] { binding.ArticleId });
            AuthorArticlePinPermissionSnapshot? permission = await ReadPermissionAsync(request, articleIds, cancellationToken)
                .ConfigureAwait(false);
            if (permission is null || !SameContext(preflight, permission))
            {
                return null;
            }

            // Metadata is read only after BOTH projection and opening authority succeed.
            AuthorArticlePinArticleFact? article = await ReadArticleAsync(binding.ArticleId, articleIds, cancellationToken)
                .ConfigureAwait(false);
            if (article is null)
            {
                return null;
            }
            ArticleRelationRevisionCoordinate? source = await coordinates.ReadRevisionAsync(
                db, article.ArticleId, article.CurrentRevisionId, cancellationToken).ConfigureAwait(false);
            if (source is null || source.ArticleId != article.ArticleId
                || source.RevisionId != article.CurrentRevisionId || source.RevisionNo != article.RevisionNo
                || source.ArticleIdentity != request.ArticleIdentity || source.RevisionIdentity != request.RevisionIdentity
                || source.SourceEpoch == Guid.Empty)
            {
                return null;
            }

            // Fresh source reads detect drift; the old permission snapshot is never a validation provider.
            ArticleRelationRevisionCoordinate? currentSource = await coordinates.ReadRevisionAsync(
                db, article.ArticleId, article.CurrentRevisionId, cancellationToken).ConfigureAwait(false);
            if (currentSource != source)
            {
                return null;
            }
            AuthorArticlePinArticleFact? currentArticle = await ReadArticleAsync(binding.ArticleId, articleIds, cancellationToken)
                .ConfigureAwait(false);
            if (currentArticle != article)
            {
                return null;
            }
            AuthorArticlePinPermissionSnapshot? currentPermission = await ReadPermissionAsync(request, articleIds, cancellationToken)
                .ConfigureAwait(false);
            if (currentPermission is null || !SamePermission(permission, currentPermission))
            {
                return null;
            }
            cancellationToken.ThrowIfCancellationRequested();
            return new(Guid.CreateVersion7(), source, currentArticle, currentPermission);
        }
        catch (Exception)
        {
            // A failed source has the same content-free outcome as missing/denied sources.
            // Preserve caller cancellation even if a dependency reports it as a driver failure.
            cancellationToken.ThrowIfCancellationRequested();
            return null;
        }
    }

    internal async Task<ArticleGraphCurrentArticleAdmission?> RevalidateCurrentAsync(
        ArticleGraphCurrentArticleReadRequest request,
        ArticleGraphCurrentArticleAdmission admission,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArticleGraphCurrentArticleAdmission? current = await ReadCurrentAsync(request, cancellationToken).ConfigureAwait(false);
        try
        {
            // Input digests/seals alone grant no authority; compare against actual fresh reads.
            return current is not null && admission.ReadId != Guid.Empty
                && current.Source == admission.Source && current.Article == admission.Article
                && SamePermission(current.Permission, admission.Permission)
                ? current
                : null;
        }
        catch (Exception)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return null;
        }
    }

    private async Task<AuthorArticlePinPermissionSnapshot?> ReadPermissionAsync(
        ArticleGraphCurrentArticleReadRequest request,
        IReadOnlyList<int> articleIds,
        CancellationToken cancellationToken)
    {
        AuthorArticlePinPermissionSnapshot snapshot = await permissions.ResolveAsync(
            new(request.Owner, request.RequestId, articleIds), cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        // Freeze first, then verify the ORIGINAL supplied digest over the copied values.
        snapshot = snapshot with { Decisions = Array.AsReadOnly(snapshot.Decisions.ToArray()) };
        if (snapshot.Status != AuthorArticlePinPermissionSnapshotStatus.Current || snapshot.Owner != request.Owner
            || !AuthorArticlePinProjectionContract.IsRequiredRevisionReference(snapshot.PermissionRevision)
            || !AuthorArticlePinProjectionContract.IsRequiredRevisionReference(snapshot.SiteRevision)
            || !AuthorArticlePinProjectionContract.IsRequiredRevisionReference(snapshot.SessionRevision)
            || snapshot.ContentDigest != AuthorArticlePinProjectionContract.ComputePermissionDigest(snapshot)
            || snapshot.Decisions.Count != articleIds.Count)
        {
            return null;
        }
        if (articleIds.Count == 1)
        {
            AuthorArticlePinPermissionDecision decision = snapshot.Decisions[0];
            if (decision.ArticleId != articleIds[0] || !decision.CanProject || !decision.CanOpen
                || !AuthorArticlePinProjectionContract.IsRequiredRevisionReference(decision.PermissionReference))
            {
                return null;
            }
        }
        return snapshot;
    }

    private async Task<AuthorArticlePinArticleFact?> ReadArticleAsync(
        int articleId,
        IReadOnlyList<int> articleIds,
        CancellationToken cancellationToken)
    {
        IReadOnlyList<AuthorArticlePinArticleFact> facts = await articles.ReadCurrentBatchAsync(articleIds, cancellationToken)
            .ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (facts.Count != 1)
        {
            return null;
        }
        AuthorArticlePinArticleFact fact = facts[0];
        return fact.ArticleId == articleId && fact.Exists && !fact.IsDeleted
            && Enum.IsDefined(fact.Status) && fact.Status != ArticleStatus.Deleted
            && fact.Title is not null && fact.CurrentRevisionId > 0 && fact.RevisionNo > 0
            && AuthorArticlePinProjectionContract.IsRequiredRevisionReference(fact.ArticleVersionReference)
            && AuthorArticlePinProjectionContract.IsRequiredRevisionReference(fact.RevisionVersionReference)
            && fact.ContentDigest == AuthorArticlePinProjectionContract.ComputeArticleFactDigest(fact)
            ? fact
            : null;
    }

    private static bool IsRevisionIdentity(string identity)
        => identity is not null && identity.StartsWith("revision:", StringComparison.Ordinal)
            && Guid.TryParseExact(identity["revision:".Length..], "D", out Guid value)
            && value != Guid.Empty && identity == $"revision:{value:D}";

    private static bool SameContext(AuthorArticlePinPermissionSnapshot first, AuthorArticlePinPermissionSnapshot second)
        => first.Owner == second.Owner && first.PermissionRevision == second.PermissionRevision
            && first.SiteRevision == second.SiteRevision && first.SessionRevision == second.SessionRevision;

    private static bool SamePermission(AuthorArticlePinPermissionSnapshot first, AuthorArticlePinPermissionSnapshot second)
        => SameContext(first, second) && first.Status == second.Status && first.ReasonCode == second.ReasonCode
            && first.ContentDigest == second.ContentDigest
            && second.ContentDigest == AuthorArticlePinProjectionContract.ComputePermissionDigest(second)
            && first.Decisions.SequenceEqual(second.Decisions);
}
