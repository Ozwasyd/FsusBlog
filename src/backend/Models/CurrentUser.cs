using System.Security.Claims;

namespace FsusBlog.Server.Models;

/// <summary>
/// Represents a validated current-user identifier bound from <see cref="HttpContext.User"/>.
/// </summary>
public readonly record struct CurrentUser(long Id)
{
    // The Minimal API binding convention calls this method directly without reflection-based model discovery.
    public static ValueTask<CurrentUser?> BindAsync(HttpContext context, System.Reflection.ParameterInfo parameter)
    {
        var userIdStr = context.User.FindFirstValue(ClaimTypes.NameIdentifier);

        if (userIdStr == null || !long.TryParse(userIdStr, out var userId))
        {
            return new ValueTask<CurrentUser?>(result: null);
        }

        return new ValueTask<CurrentUser?>(new CurrentUser(userId));
    }
}
