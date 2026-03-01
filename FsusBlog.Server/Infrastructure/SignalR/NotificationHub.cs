using Microsoft.AspNetCore.SignalR;

namespace FsusBlog.Server.Infrastructure.SignalR;

/// <summary>
/// SignalR Hub
/// 终极优化版: 2026-02-22 (优化用户ID获取逻辑)
/// </summary>
public sealed class NotificationHub : Hub
{
    public override async Task OnConnectedAsync()
    {
        await Groups.AddToGroupAsync(Context.ConnectionId, "ContentGovernanceGroup");

        if (!string.IsNullOrEmpty(Context.UserIdentifier))
        {
            await Groups.AddToGroupAsync(Context.ConnectionId, "AuthenticatedUsersGroup");
        }

        await base.OnConnectedAsync();
    }
}
