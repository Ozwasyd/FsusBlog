using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.DocumentExport.Jobs;

namespace FsusBlog.Server.Services.DocumentExport;

/// <summary>
/// Rechecks the persisted job actor's original administrator session against canonical permission facts.
/// HTTP calls additionally bind the authenticated administrator to the exact stored actor and session;
/// background calls use the sole Jobs actor without manufacturing claims or storing access tokens.
/// </summary>
public sealed class DocumentExportSessionJobAuthorization(
    IAuthorRecentArticleHistoryPersistedPermissionReader permissions,
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
            || string.IsNullOrWhiteSpace(actor.SessionId))
        {
            return false;
        }
        if (context is not null
            && (context.User.Identity?.IsAuthenticated != true
                || !context.User.IsAdminPrincipal()
                || !context.User.TryGetAdminPrincipalId(out long principalId) || principalId != actor.UserId
                || !context.User.HasAdminPermission(AdminPermissions.ArticleWrite)
                || !string.Equals(context.User.GetAdminSessionId(), actor.SessionId, StringComparison.Ordinal)))
        {
            return false;
        }
        try
        {
            DocumentExportContractValidator.RequireOwnerScope(actor.UserId, actor.SiteScope);
            DocumentExportContractValidator.ValidateCoordinate(coordinate);
            var owner = new AuthorRecentArticleHistoryOwner(actor.UserId, actor.SiteScope);
            AuthorRecentArticleHistoryPermissionSnapshot snapshot = await permissions.ResolveAsync(
                new(owner, Guid.CreateVersion7(), [checked((int)coordinate.ArticleId)]), actor.SessionId, cancellationToken)
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
