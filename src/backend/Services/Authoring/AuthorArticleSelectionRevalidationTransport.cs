using FsusBlog.Contracts.AuthoringNavigation;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>Maps the single authenticated application facade to the closed transport shape.</summary>
public sealed class AuthorArticleSelectionRevalidationTransport(IAuthorRecentArticleHistoryApplicationFacade facade)
{
    public async Task<AuthorArticleSelectionRevalidationResponse> RevalidateAsync(
        AuthorArticleSelectionRevalidationRequest request, CancellationToken cancellationToken)
    {
        if (!AuthorArticleSelectionRevalidationContract.IsValidRequest(request))
            throw new ArgumentException("author_article_selection_request_invalid", nameof(request));
        cancellationToken.ThrowIfCancellationRequested();
        AuthorArticleQuerySelectionRevalidationResult result = await facade.RevalidateSelectionAsync(
            request.ArticleId, request.ServerRevision, request.PermissionToken, request.RequestId, cancellationToken)
            .ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        var response = new AuthorArticleSelectionRevalidationResponse(
            AuthorArticleSelectionRevalidationContract.SchemaVersion, result.Current,
            new(result.Owner.AdminPrincipalId, result.Owner.SiteScope), result.ArticleId,
            result.ServerRevision, result.RequestId, result.PermissionToken);
        if (!AuthorArticleSelectionRevalidationContract.MatchesRequest(request, response))
            throw new InvalidOperationException("author_article_selection_facade_correlation_invalid");
        return response;
    }
}
