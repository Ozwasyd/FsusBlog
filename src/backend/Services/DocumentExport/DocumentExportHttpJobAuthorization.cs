using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.DocumentExport.Jobs;

namespace FsusBlog.Server.Services.DocumentExport;

/// <summary>
/// HTTP adapter to the original SQL-backed current principal/session/site/article
/// permission projection. It issues no permission snapshot, performs no parallel
/// SQL query and caches no decision. A worker without the original authenticated
/// HTTP context is denied; this adapter does not manufacture a worker principal.
/// </summary>
public sealed class DocumentExportHttpJobAuthorization(
    IAuthorRecentArticleHistoryPermissionProjectionProvider permissions,
    IHttpContextAccessor contextAccessor) : IDocumentExportJobAuthorization
{
    public async ValueTask<bool> IsAllowedAsync(DocumentExportJobActor actor,
        DocumentExportArticleCoordinate coordinate, DocumentExportJobOperation operation,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArgumentNullException.ThrowIfNull(actor);
        ArgumentNullException.ThrowIfNull(coordinate);
        HttpContext? context = contextAccessor.HttpContext;
        if (!Enum.IsDefined(operation) || coordinate.ArticleId is <= 0 or > int.MaxValue
            || context is null || context.User.Identity?.IsAuthenticated != true
            || !context.User.IsAdminPrincipal()
            || !context.User.TryGetAdminPrincipalId(out long principalId) || principalId != actor.UserId
            || string.IsNullOrWhiteSpace(actor.SessionId)
            || context.User.GetAdminSessionId() != actor.SessionId)
        {
            return false;
        }
        try
        {
            DocumentExportContractValidator.RequireOwnerScope(actor.UserId, actor.SiteScope);
            DocumentExportContractValidator.ValidateCoordinate(coordinate);
            var owner = new AuthorRecentArticleHistoryOwner(actor.UserId, actor.SiteScope);
            AuthorRecentArticleHistoryPermissionSnapshot snapshot = await permissions.ResolveAsync(
                new(owner, Guid.CreateVersion7(), [checked((int)coordinate.ArticleId)]), cancellationToken)
                .ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            if (snapshot.Status != AuthorRecentArticleHistoryPermissionSnapshotStatus.Current
                || snapshot.Owner != owner || snapshot.Decisions.Count != 1
                || snapshot.ContentDigest != AuthorRecentArticleHistoryContract.ComputePermissionDigest(snapshot))
            {
                return false;
            }
            AuthorRecentArticleHistoryPermissionDecision decision = snapshot.Decisions[0];
            return decision.ArticleId == coordinate.ArticleId
                && (operation is DocumentExportJobOperation.Read or DocumentExportJobOperation.Download
                    ? decision.CanProject : decision.CanWrite);
        }
        catch (Exception exception) when (exception is ArgumentException or AuthorRecentArticleHistoryValidationException)
        {
            return false;
        }
    }
}
