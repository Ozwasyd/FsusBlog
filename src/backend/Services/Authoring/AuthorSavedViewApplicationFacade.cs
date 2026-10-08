using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Admits saved-view domain commands only for the administrator and site of the authenticated
/// server request. Session validation remains with the existing authentication middleware;
/// storage, dependency validation, revisions and idempotency remain with the unique store.
/// </summary>
public sealed class AuthorSavedViewApplicationFacade(
    IAuthorSavedViewStore store,
    IHttpContextAccessor httpContextAccessor,
    IConfiguration configuration)
{
    public Task<AuthorSavedView?> GetAsync(Guid viewId, CancellationToken cancellationToken = default)
        => ExecuteAsync(null, (owner, token) => store.GetAsync(owner, viewId, token), cancellationToken);

    public Task<AuthorSavedViewPage> ListAsync(
        AuthorSavedViewPageCursor? cursor,
        int limit,
        CancellationToken cancellationToken = default)
        => ExecuteAsync(null, (owner, token) => store.ListAsync(owner, cursor, limit, token), cancellationToken);

    public Task<AuthorSavedViewVerificationResult> VerifyAsync(CancellationToken cancellationToken = default)
        => ExecuteAsync(null, (owner, token) => store.VerifyAsync(owner, token), cancellationToken);

    public Task<AuthorSavedViewWriteReceipt> CreateAsync(
        CreateAuthorSavedViewCommand command,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);
        return ExecuteAsync(command.Owner, (_, token) => store.CreateAsync(command, token), cancellationToken);
    }

    public Task<AuthorSavedViewWriteReceipt> UpdateAsync(
        UpdateAuthorSavedViewCommand command,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);
        return ExecuteAsync(command.Owner, (_, token) => store.UpdateAsync(command, token), cancellationToken);
    }

    public Task<AuthorSavedViewWriteReceipt> RenameAsync(
        RenameAuthorSavedViewCommand command,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);
        return ExecuteAsync(command.Owner, (_, token) => store.RenameAsync(command, token), cancellationToken);
    }

    public Task<AuthorSavedViewWriteReceipt> SetPinnedAsync(
        SetAuthorSavedViewPinnedCommand command,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);
        return ExecuteAsync(command.Owner, (_, token) => store.SetPinnedAsync(command, token), cancellationToken);
    }

    public Task<AuthorSavedViewWriteReceipt> ReorderPinnedAsync(
        ReorderAuthorSavedViewsCommand command,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);
        return ExecuteAsync(command.Owner, (_, token) => store.ReorderPinnedAsync(command, token), cancellationToken);
    }

    public Task<AuthorSavedViewWriteReceipt> MovePinnedAsync(
        MoveAuthorSavedViewsCommand command,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);
        return ExecuteAsync(command.Owner, (_, token) => store.MovePinnedAsync(command, token), cancellationToken);
    }

    public Task<AuthorSavedViewWriteReceipt> SetDefaultAsync(
        SetDefaultAuthorSavedViewCommand command,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);
        return ExecuteAsync(command.Owner, (_, token) => store.SetDefaultAsync(command, token), cancellationToken);
    }

    public Task<AuthorSavedViewWriteReceipt> RetireAsync(
        RetireAuthorSavedViewCommand command,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);
        return ExecuteAsync(command.Owner, (_, token) => store.RetireAsync(command, token), cancellationToken);
    }

    public Task<AuthorSavedViewWriteReceipt> DeleteAsync(
        DeleteAuthorSavedViewCommand command,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);
        return ExecuteAsync(command.Owner, (_, token) => store.DeleteAsync(command, token), cancellationToken);
    }

    private async Task<T> ExecuteAsync<T>(
        AuthorSavedViewOwner? assertedOwner,
        Func<AuthorSavedViewOwner, CancellationToken, Task<T>> operation,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        RequestIdentity identity = ResolveIdentity();
        if (assertedOwner.HasValue && assertedOwner.Value != identity.Owner)
        {
            throw new AuthorSavedViewAccessDeniedException();
        }

        T result = await operation(identity.Owner, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (ResolveIdentity() != identity)
        {
            // A committed write is recovered with its original idempotency key. A changed
            // request identity must never receive the prior user's private response.
            throw new AuthorSavedViewAccessDeniedException();
        }
        return result;
    }

    private RequestIdentity ResolveIdentity()
    {
        HttpContext? context = httpContextAccessor.HttpContext;
        if (context?.User.Identity?.IsAuthenticated != true
            || !context.User.IsAdminPrincipal()
            || !context.User.TryGetAdminPrincipalId(out long adminPrincipalId)
            || !context.User.HasAdminPermission(AdminPermissions.ArticleWrite)
            || string.IsNullOrWhiteSpace(context.User.GetAdminSessionId()))
        {
            throw new AuthorSavedViewAccessDeniedException();
        }

        var owner = new AuthorSavedViewOwner(
            adminPrincipalId,
            SqlAuthorRecentArticleHistoryPermissionAuthority.ResolveSiteScope(configuration));
        AuthorSavedViewContract.ValidateOwner(owner);
        return new RequestIdentity(owner, context.User.GetAdminSessionId()!);
    }

    private sealed record RequestIdentity(AuthorSavedViewOwner Owner, string SessionId);
}
