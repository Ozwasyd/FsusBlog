using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using Microsoft.AspNetCore.SignalR;
using SqlSugar;

namespace FsusBlog.Server.Infrastructure.SignalR;

/// <summary>
/// 站内信分发器
/// </summary>
public sealed class SignalRMessageService(
    ISqlSugarClient db,
    MessageCacheService cache,
    IHubContext<NotificationHub> hubContext) : IMessageService
{
    /// <summary>
    /// 管理员手动发送的点对点私信 (归类为 Transactional)
    /// </summary>
    public async Task SendPrivateNoticeAsync(long userId, string title, string content)
    {
        await SendNoticeInternalAsync(userId, title, content, MessageCategory.Transactional, "提醒");
    }

    /// <summary>
    /// 发布全站公告 (归类为 Broadcast)
    /// </summary>
    public async Task PublishGlobalNoticeAsync(string title, string content)
    {
        var msg = new SysMessage
        {
            Title = title,
            Content = content,
            Category = MessageCategory.Broadcast,
            CreateTime = DateTime.UtcNow
        };
        var msgId = await db.Insertable(msg).ExecuteReturnSnowflakeIdAsync();

        // 广播仅通知，不更新具体用户的未读计数
        await hubContext.Clients.Group("AuthenticatedUsersGroup").SendAsync("ReceiveGlobalNotice", new
        {
            id = msgId.ToString(),
            title,
            time = msg.CreateTime
        });
    }

    /// <summary>
    /// 标记单条消息已读
    /// </summary>
    public async Task MarkAsReadAsync(long userId, long messageId)
    {
        var msg = await db.Queryable<SysMessage>().InSingleAsync(messageId);
        if (msg == null) return;

        var isExist = await db.Queryable<SysUserMessage>()
            .AnyAsync(it => it.UserId == userId && it.MessageId == messageId);

        bool success;
        if (isExist)
        {
            success = await db.Updateable<SysUserMessage>()
                .SetColumns(it => it.IsRead == true)
                .SetColumns(it => it.ReadTime == DateTime.UtcNow)
                .Where(it => it.UserId == userId && it.MessageId == messageId && it.IsRead == false)
                .ExecuteCommandAsync() > 0;
        }
        else
        {
            success = await db.Insertable(new SysUserMessage
            {
                UserId = userId,
                MessageId = messageId,
                IsRead = true,
                ReadTime = DateTime.UtcNow
            }).ExecuteCommandAsync() > 0;
        }

        if (success && msg.Category != MessageCategory.Broadcast)
        {
            await cache.DecrementUnreadAsync(userId);
            var newCount = await cache.GetUnreadCountAsync(userId);
            await hubContext.Clients.User(userId.ToString()).SendAsync("UpdateUnreadCount", newCount);
        }
    }

    /// <summary>
    /// 获取用户收件箱 (混合公告和私有消息)
    /// </summary>
    public async Task<List<MessageInboxDto>> GetInboxAsync(long userId, int pageIndex, int pageSize)
    {
        return await db.Queryable<SysMessage>()
            .LeftJoin<SysUserMessage>((m, rel) => m.Id == rel.MessageId && rel.UserId == userId)
            .Where((m, rel) =>
                (m.Category == MessageCategory.Broadcast) ||
                (m.Category != MessageCategory.Broadcast && rel.UserId == userId)
            )
            .OrderByDescending(m => m.CreateTime)
            .Select((m, rel) => new MessageInboxDto
            {
                Id = m.Id.ToString(),
                Title = m.Title,
                Content = m.Content,
                Category = (int)m.Category,
                CategoryName = m.Category == MessageCategory.Broadcast ? "公告" :
                               m.Category == MessageCategory.SystemTask ? "系统" : "提醒",
                IsRead = rel.IsRead == true,
                CreateTime = m.CreateTime
            }).ToPageListAsync(pageIndex, pageSize);
    }

    public async Task MarkAllAsReadAsync(long userId)
    {
        await db.Updateable<SysUserMessage>()
            .SetColumns(it => it.IsRead == true)
            .SetColumns(it => it.ReadTime == DateTime.UtcNow)
            .Where(it => it.UserId == userId && it.IsRead == false)
            .ExecuteCommandAsync();

        await cache.ClearUnreadAsync(userId);
        await hubContext.Clients.User(userId.ToString()).SendAsync("UpdateUnreadCount", 0);
    }

    public async Task PushUserStatusAsync(long userId, int status, string? reason)
    {
        await hubContext.Clients.User(userId.ToString())
            .SendAsync("OnUserStatusChanged", new { status, reason, time = DateTime.UtcNow });
    }

    public async Task PushCommentRemoveAsync(int articleId, long commentId)
    {
        await hubContext.Clients.Group("ContentGovernanceGroup").SendAsync("OnCommentRemoved", new
        {
            articleId,
            commentId = commentId.ToString(),
            time = DateTime.UtcNow
        });
    }

    public async Task PushCommentAddAsync(CommentAddedNotifyDto payload) =>
        await hubContext.Clients.Group("ContentGovernanceGroup").SendAsync("OnCommentAdded", payload);

    /// <summary>
    /// 系统触发：评论被删除通知 (归类为 SystemTask)
    /// </summary>
    public async Task SendCommentDeletedNoticeAsync(int targetUserId, string articleTitle, string commentSnippet, string reason)
    {
        string title = "评论处理通知";
        string content = $"您在文章《{articleTitle}》下的评论「{commentSnippet}...」已被管理员移除。原因：{reason}";
        await SendNoticeInternalAsync(targetUserId, title, content, MessageCategory.SystemTask, "系统");
    }

    /// <summary>
    /// 系统触发：账号封禁通知 (归类为 SystemTask)
    /// </summary>
    public async Task SendUserBannedNoticeAsync(int userId, string reason)
    {
        string title = "账号处罚通知";
        string content = $"您的账号已被封禁，当前仅保留只读权限。原因：{reason}";
        await SendGovernanceNoticeInternalAsync(userId, 1, title, content, reason);
    }

    /// <summary>
    /// 系统触发：账号解封通知 (归类为 SystemTask)
    /// </summary>
    public async Task SendUserUnbannedNoticeAsync(int userId)
    {
        string title = "账号恢复通知";
        string content = "您已解除账户管控。";
        await SendGovernanceNoticeInternalAsync(userId, 0, title, content, null);
    }

    public async Task DeleteMessageAsync(long userId, long messageId)
    {
        var messageInfo = await db.Queryable<SysUserMessage>()
            .LeftJoin<SysMessage>((rel, m) => rel.MessageId == m.Id)
            .Where((rel, m) => rel.UserId == userId && rel.MessageId == messageId)
            .Select((rel, m) => new
            {
                rel.IsRead,
                m.Category
            })
            .FirstAsync();

        if (messageInfo == null) return;

        await db.Ado.BeginTranAsync();
        try
        {
            bool deleted = await db.Deleteable<SysUserMessage>()
                .Where(it => it.UserId == userId && it.MessageId == messageId)
                .ExecuteCommandAsync() > 0;

            if (deleted)
            {
                if (!messageInfo.IsRead)
                {
                    await cache.DecrementUnreadAsync(userId);
                    var newCount = await cache.GetUnreadCountAsync(userId);
                    await hubContext.Clients.User(userId.ToString()).SendAsync("UpdateUnreadCount", newCount);
                }
            }

            await db.Ado.CommitTranAsync();
        }
        catch
        {
            await db.Ado.RollbackTranAsync();
            throw;
        }
    }

    public async Task<List<MessageInboxDto>> GetAdminSentMessagesAsync(int pageIndex, int pageSize)
    {
        return await db.Queryable<SysMessage>()
            .LeftJoin<SysUserMessage>((m, rel) => m.Id == rel.MessageId)
            .Where(m => m.Category != MessageCategory.SystemTask)
            .OrderByDescending(m => m.CreateTime)
            .Select((m, rel) => new MessageInboxDto
            {
                Id = m.Id.ToString(),
                Title = m.Title,
                Content = m.Content,
                Category = (int)m.Category,
                CategoryName = m.Category == MessageCategory.Broadcast ? "全站公告" : "定向私信",
                CreateTime = m.CreateTime
            })
            .ToPageListAsync(pageIndex, pageSize);
    }

    public async Task RevokeMessageAsync(long messageId)
    {
        var msg = await db.Queryable<SysMessage>().InSingleAsync(messageId);
        if (msg == null) return;

        await db.Ado.BeginTranAsync();
        try
        {
            if (msg.Category != MessageCategory.Broadcast)
            {
                var targetUsers = await db.Queryable<SysUserMessage>()
                    .Where(it => it.MessageId == messageId && it.IsRead == false)
                    .Select(it => it.UserId)
                    .ToListAsync();

                foreach (var uid in targetUsers)
                {
                    await cache.DecrementUnreadAsync(uid);
                    var newCount = await cache.GetUnreadCountAsync(uid);
                    await hubContext.Clients.User(uid.ToString()).SendAsync("UpdateUnreadCount", newCount);
                }
            }

            await db.Deleteable<SysUserMessage>().Where(it => it.MessageId == messageId).ExecuteCommandAsync();
            await db.Deleteable<SysMessage>().In(messageId).ExecuteCommandAsync();

            await db.Ado.CommitTranAsync();

            if (msg.Category == MessageCategory.Broadcast)
                await hubContext.Clients.Group("AuthenticatedUsersGroup").SendAsync("OnMessageRevoked", messageId.ToString());
            else
                await hubContext.Clients.All.SendAsync("OnMessageRevoked", messageId.ToString());
        }
        catch
        {
            await db.Ado.RollbackTranAsync();
            throw;
        }
    }

    /// <summary>
    /// 实现文章相关的实时推送
    /// </summary>
    public async Task PushArticleChangedAsync(ArticleNoticeDto payload)
    {
        await hubContext.Clients.Group("ContentGovernanceGroup")
            .SendAsync("ReceiveArticleUpdate", payload);
    }

    /// <summary>
    /// 内部核心方法：处理点对点消息的持久化与推送
    /// </summary>
    private async Task SendNoticeInternalAsync(long userId, string title, string content, MessageCategory category, string categoryName)
    {
        await db.Ado.BeginTranAsync();
        try
        {
            var msg = new SysMessage
            {
                Title = title,
                Content = content,
                Category = category,
                CreateTime = DateTime.UtcNow
            };
            var msgId = await db.Insertable(msg).ExecuteReturnSnowflakeIdAsync();

            await db.Insertable(new SysUserMessage
            {
                UserId = userId,
                MessageId = msgId,
                IsRead = false
            }).ExecuteCommandAsync();

            await db.Ado.CommitTranAsync();

            await cache.IncrementUnreadAsync(userId);
            var unreadCount = await cache.GetUnreadCountAsync(userId);

            var dto = new MessageInboxDto
            {
                Id = msgId.ToString(),
                Title = title,
                Content = content,
                Category = (int)category,
                CategoryName = categoryName,
                IsRead = false,
                CreateTime = msg.CreateTime
            };

            var userProxy = hubContext.Clients.User(userId.ToString());
            await userProxy.SendAsync("OnMessageReceived", dto);
            await userProxy.SendAsync("ReceiveNotice", new { title, unreadCount, time = DateTime.UtcNow });
        }
        catch
        {
            await db.Ado.RollbackTranAsync();
            throw;
        }
    }

    private async Task SendGovernanceNoticeInternalAsync(int userId, int status, string title, string content, string? reason)
    {
        await SendNoticeInternalAsync(userId, title, content, MessageCategory.SystemTask, "系统");

        await hubContext.Clients.User(userId.ToString())
            .SendAsync("OnUserStatusChanged", new { status, reason, time = DateTime.UtcNow });
    }
}