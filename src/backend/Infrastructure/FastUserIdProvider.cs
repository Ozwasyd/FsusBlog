using Microsoft.AspNetCore.Http;
using System.Security.Claims;

namespace FsusBlog.Server.Infrastructure;

/// <summary>
/// 极速用户 ID 解析器
/// 作用：以 O(1) 的极限速度直接从 HTTP Claims 中提取用户标识
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
