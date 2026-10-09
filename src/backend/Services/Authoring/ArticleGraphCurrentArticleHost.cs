using System.Data;
using System.Security.Claims;

using SqlSugar;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Binds one current-root read to the actual authenticated request and revalidates it before delivery.
/// Runtime document epochs and subsequent lease consumption remain with their original owners.
/// </summary>
public sealed class ArticleGraphCurrentArticleHost(
    ISqlSugarClient db,
    SqlArticleGraphAdmissionReader reader,
    IHttpContextAccessor httpContextAccessor,
    IConfiguration configuration)
{
    internal async Task<ArticleGraphCurrentArticleAdmission?> ReadCurrentAsync(
        string articleIdentity,
        string revisionIdentity,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        try
        {
            RequestBinding? binding = BindRequest();
            if (binding is null)
            {
                return null;
            }
            var request = new ArticleGraphCurrentArticleReadRequest(
                binding.Owner, Guid.CreateVersion7(), articleIdentity, revisionIdentity);
            ArticleGraphCurrentArticleAdmission? admission = await reader.ReadCurrentAsync(request, cancellationToken)
                .ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            if (admission is null || !RequestMatches(binding))
            {
                return null;
            }
            ArticleGraphCurrentArticleAdmission? current = await reader.RevalidateCurrentAsync(
                request, admission, cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            return current is not null && RequestMatches(binding) ? current : null;
        }
        catch (Exception)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return null;
        }
    }

    private RequestBinding? BindRequest()
    {
        HttpContext? context = httpContextAccessor.HttpContext;
        ClaimsPrincipal? principal = context?.User;
        string? sessionId = principal.GetAdminSessionId();
        if (context is null || principal?.Identity?.IsAuthenticated != true
            || !principal.IsAdminPrincipal()
            || !principal.TryGetAdminPrincipalId(out long adminPrincipalId)
            || !principal.HasAdminPermission(AdminPermissions.ArticleWrite)
            || string.IsNullOrWhiteSpace(sessionId))
        {
            return null;
        }
        string siteScope = SqlAuthorArticlePinPermissionAuthority.ResolveSiteScope(configuration);
        IDbTransaction? transaction = db.Ado.Transaction;
        if (string.IsNullOrWhiteSpace(siteScope)
            || (transaction is not null && transaction.IsolationLevel != IsolationLevel.ReadCommitted))
        {
            return null;
        }
        string[] permissions = principal.Claims
            .Where(static claim => claim.Type == AdminPermissions.PermissionClaimType)
            .Select(static claim => claim.Value)
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .ToArray();
        return new(context, principal, new(adminPrincipalId, siteScope), sessionId, permissions, transaction);
    }

    private bool RequestMatches(RequestBinding expected)
    {
        RequestBinding? actual = BindRequest();
        return actual is not null
            && ReferenceEquals(actual.Context, expected.Context)
            && ReferenceEquals(actual.Principal, expected.Principal)
            && actual.Owner == expected.Owner
            && string.Equals(actual.SessionId, expected.SessionId, StringComparison.Ordinal)
            && actual.Permissions.SequenceEqual(expected.Permissions, StringComparer.Ordinal)
            && ReferenceEquals(actual.Transaction, expected.Transaction);
    }

    private sealed record RequestBinding(
        HttpContext Context,
        ClaimsPrincipal Principal,
        AuthorArticlePinOwner Owner,
        string SessionId,
        IReadOnlyList<string> Permissions,
        IDbTransaction? Transaction);
}
