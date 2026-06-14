using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.SignalR;
using System.Security.Claims;

namespace FsusBlog.Server.Infrastructure;

/// <summary>
/// 极速用户 ID 解析器
/// 作用：以 O(1) 的极限速度直接从 Claims 中提取用户标识，供 SignalR 内部路由使用
/// </summary>
public sealed class FastUserIdProvider : IUserIdProvider
{
    public const string ParsedUserIdItemKey = "__fsus.parsed_user_id";

    public string? GetUserId(HubConnectionContext connection)
    {
        // 直接读取 NameIdentifier，这是 JWT 中最标准、最快的用户标识存取方式
        return connection.User?.FindFirst(ClaimTypes.NameIdentifier)?.Value;
    }

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
