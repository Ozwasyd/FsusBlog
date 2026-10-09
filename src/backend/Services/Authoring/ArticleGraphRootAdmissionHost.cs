using System.Data;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

internal sealed record ArticleGraphRootRead(
    ArticleGraphCurrentArticleReadRequest Request,
    ArticleGraphCurrentArticleAdmission Admission);

/// <summary>
/// Binds current-root reads to the authenticated administrator and configured site. Admission
/// remains the native reader's responsibility and grants no authority over adjacent articles.
/// No durable source coordinate is converted into an editor document epoch.
/// </summary>
public sealed class ArticleGraphRootAdmissionHost(
    IHttpContextAccessor httpContextAccessor,
    IConfiguration configuration,
    ISqlSugarClient db,
    SqlArticleGraphAdmissionReader reader)
{
    internal async Task<ArticleGraphRootRead?> ReadCurrentAsync(
        string articleIdentity,
        string revisionIdentity,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        HostContext? context = ReadHostContext();
        if (context is null || !CanReadFreshState())
        {
            return null;
        }
        var request = new ArticleGraphCurrentArticleReadRequest(
            context.Owner, Guid.CreateVersion7(), articleIdentity, revisionIdentity);
        ArticleGraphCurrentArticleAdmission? admission = await reader.ReadCurrentAsync(
            request, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        return admission is not null && context == ReadHostContext() && CanReadFreshState()
            ? new ArticleGraphRootRead(request, admission)
            : null;
    }

    internal async Task<ArticleGraphRootRead?> RevalidateCurrentAsync(
        ArticleGraphRootRead read,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        HostContext? context = ReadHostContext();
        if (context is null || context.Owner != read.Request.Owner
            || context.Owner != read.Admission.Permission.Owner || !CanReadFreshState())
        {
            return null;
        }
        ArticleGraphCurrentArticleAdmission? admission = await reader.RevalidateCurrentAsync(
            read.Request, read.Admission, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        return admission is not null && context == ReadHostContext() && CanReadFreshState()
            ? new ArticleGraphRootRead(read.Request, admission)
            : null;
    }

    private HostContext? ReadHostContext()
    {
        HttpContext? context = httpContextAccessor.HttpContext;
        if (context?.User.Identity?.IsAuthenticated != true
            || !context.User.IsAdminPrincipal()
            || !context.User.TryGetAdminPrincipalId(out long adminPrincipalId)
            || !context.User.HasAdminPermission(AdminPermissions.ArticleWrite))
        {
            return null;
        }
        string? sessionId = context.User.GetAdminSessionId();
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return null;
        }
        try
        {
            var owner = new AuthorArticlePinOwner(
                adminPrincipalId, SqlAuthorArticlePinPermissionAuthority.ResolveSiteScope(configuration));
            AuthorArticlePinContract.ValidateOwner(owner);
            return new HostContext(owner, sessionId);
        }
        catch (AuthorArticlePinValidationException)
        {
            return null;
        }
    }

    private bool CanReadFreshState()
    {
        try
        {
            // A pinned snapshot can hide a committed permission/session revocation from the
            // reader's final reads. The host never begins, commits or modifies a transaction.
            IDbTransaction? transaction = db.Ado.Transaction;
            return transaction is null || transaction.IsolationLevel == IsolationLevel.ReadCommitted;
        }
        catch (InvalidOperationException)
        {
            return false;
        }
    }

    private sealed record HostContext(AuthorArticlePinOwner Owner, string SessionId);
}
