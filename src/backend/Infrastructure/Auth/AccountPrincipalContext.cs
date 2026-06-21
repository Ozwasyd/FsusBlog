using System.Reflection;

namespace FsusBlog.Server.Infrastructure.Auth;

public readonly record struct AccountPrincipalContext(int AccountId, string? SessionId)
{
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
