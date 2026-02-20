using Microsoft.AspNetCore.SignalR;

namespace FsusBlog.Server.Infrastructure.SignalR;

public sealed class NotificationHub : Hub
{
    public override async Task OnConnectedAsync()
    {
        // 1. 基础组：内容治理组 (所有连接包括游客都加入)
        // 用于：实时删除评论、实时更新热度等全连接指令
        await Groups.AddToGroupAsync(Context.ConnectionId, "ContentGovernanceGroup");

        // 2. 身份识别分流
        if (Context.User?.Identity?.IsAuthenticated == true)
        {
            var userId = Context.User.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value;
            if (!string.IsNullOrEmpty(userId))
            {
                // 加入登录用户组：用于接收全站公告、系统私信
                await Groups.AddToGroupAsync(Context.ConnectionId, "AuthenticatedUsersGroup");
            }
        }

        await base.OnConnectedAsync();
    }
}
