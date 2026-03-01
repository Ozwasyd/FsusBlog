using Microsoft.AspNetCore.SignalR;
using System.Security.Claims;

namespace FsusBlog.Server.Infrastructure;

/// <summary>
/// 极速用户 ID 解析器
/// 作用：以 O(1) 的极限速度直接从 Claims 中提取用户标识，供 SignalR 内部路由使用
/// </summary>
public sealed class FastUserIdProvider : IUserIdProvider
{
    public string? GetUserId(HubConnectionContext connection)
    {
        // 直接读取 NameIdentifier，这是 JWT 中最标准、最快的用户标识存取方式
        return connection.User?.FindFirst(ClaimTypes.NameIdentifier)?.Value;
    }
}