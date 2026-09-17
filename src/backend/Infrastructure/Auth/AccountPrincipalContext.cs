using System.Reflection;

namespace FsusBlog.Server.Infrastructure.Auth;

/// <summary>Identifies the authenticated anonymous account and its active session at an endpoint boundary.</summary>
public readonly record struct AccountPrincipalContext(int AccountId, string? SessionId)
{
    /// <summary>Binds a principal context only when the request carries an authenticated anonymous-account identity.</summary>
    public static ValueTask<AccountPrincipalContext?> BindAsync(HttpContext context, ParameterInfo parameter)
    {
        EndpointUserContext user = EndpointUserContext.From(context);
        if (!user.IsAuthenticated || !user.IsAnonymousAccount || user.AccountId <= 0)
        {
            return new ValueTask<AccountPrincipalContext?>(result: null);
        }

        return new ValueTask<AccountPrincipalContext?>(new AccountPrincipalContext(user.AccountId, user.SessionId));
    }
}
