using System.Security.Claims;

using Microsoft.AspNetCore.Http;

namespace FsusBlog.Server.Infrastructure;

/// <summary>
/// Parses a user ID from claims and caches the validated value in the current HTTP context.
/// </summary>
public static class FastUserIdProvider
{
    public const string ParsedUserIdItemKey = "__fsus.parsed_user_id";

    public static long? GetOrParseUserId(HttpContext? context)
    {
        if (context is null)
        {
            return null;
        }

        if (context.Items.TryGetValue(ParsedUserIdItemKey, out object? cached))
        {
            return cached switch
            {
                long value => value,
                int value => value,
                _ => null
            };
        }

        long? parsed = TryParseUserId(context.User);
        context.Items[ParsedUserIdItemKey] = parsed;
        return parsed;
    }

    public static int GetOrParseUserIdAsInt(HttpContext? context)
    {
        long? parsed = GetOrParseUserId(context);
        return parsed is > 0 and <= int.MaxValue ? (int)parsed.Value : 0;
    }

    public static long? TryParseUserId(ClaimsPrincipal? user)
    {
        Claim? claim = user?.FindFirst(ClaimTypes.NameIdentifier);
        if (claim is null || string.IsNullOrWhiteSpace(claim.Value))
        {
            return null;
        }

        return long.TryParse(claim.Value.AsSpan().Trim(), out long id) && id > 0
            ? id
            : null;
    }
}
