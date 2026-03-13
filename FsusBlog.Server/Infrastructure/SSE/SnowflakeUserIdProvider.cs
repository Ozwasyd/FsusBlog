using Microsoft.AspNetCore.SignalR;
using System.Security.Claims;

namespace FsusBlog.Server.Infrastructure.Sse;

/// <summary>
/// 高性能用户标识提供者
/// </summary>
public sealed class SnowflakeUserIdProvider : IUserIdProvider
{
    public string? GetUserId(HubConnectionContext connection) =>
        // 直接从 Claims 中提取 UserId。这是 O(1) 操作，极其快速。
        connection.User?.FindFirst(ClaimTypes.NameIdentifier)?.Value;
}
