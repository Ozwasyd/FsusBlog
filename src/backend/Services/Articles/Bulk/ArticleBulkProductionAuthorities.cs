using System.Collections.Immutable;
using System.Runtime.CompilerServices;

using FsusBlog.Server.Services.Authoring;

namespace FsusBlog.Server.Services.Articles.Bulk;

internal sealed record ArticleBulkSelectionDependency(
    string Id,
    bool Available,
    string ReasonCode);

internal static class ArticleBulkProductionAuthorityAvailability
{
    internal static ImmutableArray<ArticleBulkSelectionDependency> SelectionDependencies
    {
        get;
    } =
    [
        new("author-saved-view-store", true, "available"),
        new("author-saved-view-query-validator", true, "available"),
        new("author-article-query", false, "article-bulk.query-selection-authority-unavailable"),
        new("author-search-query", false, "article-bulk.author-search-query-authority-unavailable"),
        new("article-property-query", false, "article-bulk.property-query-authority-unavailable")
    ];
}

internal interface IArticleBulkQuerySelectionAuthority
{
    Task<ArticleBulkSelectionResolution> ResolveSavedViewAsync(
        AuthorSavedViewOwner owner,
        AuthorSavedView view,
        AuthorSavedViewQueryValidationResult validation,
        CancellationToken cancellationToken);
}

internal sealed class ArticleBulkSelectionAuthority(
    IAuthorSavedViewStore savedViewStore,
    IAuthorSavedViewQueryValidator savedViewQueryValidator,
    IArticleBulkQuerySelectionAuthority querySelectionAuthority) : IArticleBulkSelectionAuthority
{
    public async Task<ArticleBulkSelectionResolution> ResolveAsync(
        ArticleBulkSelection selection,
        ArticleBulkActor actor,
        CancellationToken cancellationToken)
    {
        if (selection.Kind is ArticleBulkSelectionKind.Explicit or ArticleBulkSelectionKind.CurrentPage)
        {
            string authorityDigest = ArticleBulkDigest.Of(new
            {
                Authority = "caller-frozen-article-identities",
                selection.Kind,
                actor.SiteId
            });
            string resolutionDigest = ArticleBulkDigest.Of(new
            {
                selection.Kind,
                selection.ArticleIds,
                actor.SiteId
            });
            if (selection.IdentityDigest != resolutionDigest)
            {
                throw new ArticleBulkContractException("article-bulk.selection-identity-drift");
            }
            return new ArticleBulkSelectionResolution(
                authorityDigest,
                resolutionDigest,
                Stream(selection.ArticleIds, cancellationToken));
        }

        if (selection.Kind == ArticleBulkSelectionKind.Query)
        {
            // The repository has no private author-scoped query snapshot store. Public search is not
            // permission-equivalent and must not be adapted into a bulk authority.
            throw new ArticleBulkContractException("article-bulk.query-selection-authority-unavailable");
        }

        if (selection.Kind != ArticleBulkSelectionKind.SavedView
            || !long.TryParse(actor.UserId, out long adminPrincipalId)
            || adminPrincipalId <= 0
            || !Guid.TryParseExact(selection.AuthorityId, "D", out Guid viewId))
        {
            throw new ArticleBulkContractException("article-bulk.selection-authority-invalid");
        }

        var owner = new AuthorSavedViewOwner(adminPrincipalId, actor.SiteId);
        AuthorSavedView? view = await savedViewStore.GetAsync(owner, viewId, cancellationToken).ConfigureAwait(false);
        if (view is null || view.LifecycleState != AuthorSavedViewLifecycleState.Active)
        {
            throw new ArticleBulkContractException("article-bulk.saved-view-unavailable");
        }
        string identityDigest = ArticleBulkDigest.Of(new
        {
            view.Id,
            view.Revision,
            view.QueryDigest,
            view.DependencyDigest,
            view.ContentDigest
        });
        if (selection.IdentityDigest != identityDigest)
        {
            throw new ArticleBulkContractException("article-bulk.selection-identity-drift");
        }

        AuthorSavedViewQueryValidationResult validation = await savedViewQueryValidator
            .ValidateAsync(owner, view.Query, cancellationToken).ConfigureAwait(false);
        if (!validation.IsValid
            || validation.QueryDigest != view.QueryDigest
            || validation.DependencyDigest != view.DependencyDigest)
        {
            throw new ArticleBulkContractException("article-bulk.saved-view-query-drift");
        }

        return await querySelectionAuthority
            .ResolveSavedViewAsync(owner, view, validation, cancellationToken).ConfigureAwait(false);
    }

    private static async IAsyncEnumerable<string> Stream(
        ImmutableArray<string> articleIds,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        foreach (string articleId in articleIds)
        {
            cancellationToken.ThrowIfCancellationRequested();
            yield return articleId;
        }
        await Task.CompletedTask;
    }
}

internal sealed class UnavailableArticleBulkQuerySelectionAuthority : IArticleBulkQuerySelectionAuthority
{
    public Task<ArticleBulkSelectionResolution> ResolveSavedViewAsync(
        AuthorSavedViewOwner owner,
        AuthorSavedView view,
        AuthorSavedViewQueryValidationResult validation,
        CancellationToken cancellationToken)
        => throw new ArticleBulkContractException("article-bulk.query-selection-authority-unavailable");
}

internal sealed class UnavailableArticleBulkPreflightAuthority : IArticleBulkPreflightAuthority
{
    public IAsyncEnumerable<ArticleBulkArticleObservation> ObserveAsync(
        IReadOnlyList<string> orderedArticleIds,
        ArticleBulkOperation operation,
        IReadOnlyDictionary<string, object> normalizedParameters,
        ArticleBulkActor actor,
        CancellationToken cancellationToken)
        => throw new ArticleBulkContractException("article-bulk.preflight-authority-unavailable");
}
