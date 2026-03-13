using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Sse;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using SqlSugar;
using StackExchange.Redis;
using System.Data.Common;

namespace FsusBlog.Server.Services.Sse;

/// <summary>
/// 站内信分发器 (SSE 极限物理重构版)
/// </summary>
public sealed class SseMessageService(
    ISqlSugarClient db,
    MessageCacheService cache,
    SseConnectionManager sseManager,
    IConnectionMultiplexer redis) : IMessageService
{
    public async Task SendPrivateNoticeAsync(long userId, string title, string content)
    {
        await SendNoticeInternalAsync(userId, title, content, MessageCategory.Transactional, "提醒");
    }

    public async Task PublishGlobalNoticeAsync(string title, string content)
    {
        var msg = new SysMessage { Title = title, Content = content, Category = MessageCategory.Broadcast, CreateTime = DateTime.UtcNow };
        var msgId = await db.Insertable(msg).ExecuteReturnSnowflakeIdAsync();

        var payload = new GlobalNoticePayload(msgId.ToString(), title, msg.CreateTime);
        sseManager.SendToGroup("AuthenticatedUsersGroup", "ReceiveGlobalNotice", payload);
    }

    public async Task MarkAsReadAsync(long userId, long messageId)
    {
        var msg = await db.Queryable<SysMessage>().InSingleAsync(messageId);
        if (msg == null) return;

        var isExist = await db.Queryable<SysUserMessage>().AnyAsync(it => it.UserId == userId && it.MessageId == messageId);

        bool success = isExist
            ? await db.Updateable<SysUserMessage>()
                .SetColumns(it => new SysUserMessage { IsRead = true, ReadTime = DateTime.UtcNow })
                .Where(it => it.UserId == userId && it.MessageId == messageId && it.IsRead == false)
                .ExecuteCommandAsync() > 0
            : await db.Insertable(new SysUserMessage { UserId = userId, MessageId = messageId, IsRead = true, ReadTime = DateTime.UtcNow }).ExecuteCommandAsync() > 0;

        if (success && msg.Category != MessageCategory.Broadcast)
        {
            await cache.DecrementUnreadAsync(userId);
            var newCount = await cache.GetUnreadCountAsync(userId);
            sseManager.SendToUser(userId.ToString(), "UpdateUnreadCount", newCount);
        }
    }

    public async Task<List<MessageInboxDto>> GetInboxAsync(long userId, int pageIndex, int pageSize)
    {
        var query = db.Queryable<SysMessage>()
            .LeftJoin<SysUserMessage>((m, rel) => m.Id == rel.MessageId && rel.UserId == userId)
            .Where((m, rel) => (m.Category == MessageCategory.Broadcast) || (rel.UserId == userId))
            .OrderByDescending(m => m.CreateTime)
            .Select((m, rel) => new { m.Id, m.Title, m.Content, m.Category, rel.IsRead, m.CreateTime });

        var sqlObj = query.Skip((pageIndex - 1) * pageSize).Take(pageSize).ToSql();
        var list = new List<MessageInboxDto>(pageSize);

        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(sqlObj.Key, sqlObj.Value);
        int fId = reader.GetOrdinal("Id"), fTitle = reader.GetOrdinal("Title"), fContent = reader.GetOrdinal("Content"),
            fCategory = reader.GetOrdinal("Category"), fIsRead = reader.GetOrdinal("IsRead"), fTime = reader.GetOrdinal("CreateTime");

        while (await reader.ReadAsync())
        {
            var category = (MessageCategory)reader.GetInt32(fCategory);
            list.Add(new MessageInboxDto
            {
                Id = reader.GetInt64(fId).ToString(),
                Title = reader.GetString(fTitle),
                Content = reader.GetString(fContent),
                Category = (int)category,
                CategoryName = GetCategoryName(category),
                IsRead = !reader.IsDBNull(fIsRead) && reader.GetBoolean(fIsRead),
                CreateTime = reader.GetDateTime(fTime)
            });
        }
        return list;
    }

    private static string GetCategoryName(MessageCategory category) => category switch
    {
        MessageCategory.Broadcast => "公告",
        MessageCategory.SystemTask => "系统",
        _ => "提醒"
    };

    public async Task MarkAllAsReadAsync(long userId)
    {
        await db.Updateable<SysUserMessage>()
            .SetColumns(it => new SysUserMessage { IsRead = true, ReadTime = DateTime.UtcNow })
            .Where(it => it.UserId == userId && it.IsRead == false)
            .ExecuteCommandAsync();

        await cache.ClearUnreadAsync(userId);
        sseManager.SendToUser(userId.ToString(), "UpdateUnreadCount", 0);
    }

    public async Task PushUserStatusAsync(long userId, int status, string? reason)
    {
        var payload = new UserStatusPayload(status, reason, DateTime.UtcNow);
        sseManager.SendToUser(userId.ToString(), "OnUserStatusChanged", payload);
    }

    public async Task PushCommentRemoveAsync(int articleId, long commentId)
    {
        var payload = new CommentRemovedPayload(articleId, commentId.ToString(), DateTime.UtcNow);
        sseManager.SendToGroup("ContentGovernanceGroup", "OnCommentRemoved", payload);
    }

    public async Task PushCommentAddAsync(CommentAddedNotifyDto payload) => sseManager.SendToGroup("ContentGovernanceGroup", "OnCommentAdded", payload);

    public async Task SendCommentDeletedNoticeAsync(int targetUserId, string articleTitle, string commentSnippet, string reason)
    {
        string title = "评论处理通知", content = $"您在文章《{articleTitle}》下的评论「{commentSnippet}...」已被管理员移除。原因：{reason}";
        await SendNoticeInternalAsync(targetUserId, title, content, MessageCategory.SystemTask, "系统");
    }

    public async Task SendUserBannedNoticeAsync(int userId, string reason)
    {
        string title = "账号处罚通知", content = $"您的账号已被封禁，当前仅保留只读权限。原因：{reason}";
        await SendGovernanceNoticeInternalAsync(userId, 1, title, content, reason);
    }

    public async Task SendUserUnbannedNoticeAsync(int userId)
    {
        string title = "账号恢复通知", content = "您已解除账户管控。";
        await SendGovernanceNoticeInternalAsync(userId, 0, title, content, null);
    }

    public async Task DeleteMessageAsync(long userId, long messageId)
    {
        var messageInfo = await db.Queryable<SysUserMessage>().LeftJoin<SysMessage>((rel, m) => rel.MessageId == m.Id)
            .Where((rel, m) => rel.UserId == userId && rel.MessageId == messageId).Select((rel, m) => new { rel.IsRead, m.Category }).FirstAsync();

        if (messageInfo == null) return;
        bool successInDb = false;

        await db.Ado.BeginTranAsync();
        try
        {
            successInDb = await db.Deleteable<SysUserMessage>().Where(it => it.UserId == userId && it.MessageId == messageId).ExecuteCommandAsync() > 0;
            await db.Ado.CommitTranAsync();
        }
        catch { await db.Ado.RollbackTranAsync(); throw; }

        if (successInDb && !messageInfo.IsRead)
        {
            await cache.DecrementUnreadAsync(userId);
            var newCount = await cache.GetUnreadCountAsync(userId);
            sseManager.SendToUser(userId.ToString(), "UpdateUnreadCount", newCount);
            sseManager.SendToUser(userId.ToString(), "OnMessageRevoked", new MessageRevokedPayload(messageId.ToString()));
        }
    }

    public async Task<List<MessageInboxDto>> GetAdminSentMessagesAsync(int pageIndex, int pageSize)
    {
        var query = db.Queryable<SysMessage>().Where(m => m.Category != MessageCategory.SystemTask).OrderByDescending(m => m.CreateTime)
            .Select(m => new { m.Id, m.Title, m.Content, m.Category, m.CreateTime });

        var sqlObj = query.Skip((pageIndex - 1) * pageSize).Take(pageSize).ToSql();
        var list = new List<MessageInboxDto>(pageSize);

        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(sqlObj.Key, sqlObj.Value);
        int fId = reader.GetOrdinal("Id"), fTitle = reader.GetOrdinal("Title"), fContent = reader.GetOrdinal("Content"),
            fCategory = reader.GetOrdinal("Category"), fTime = reader.GetOrdinal("CreateTime");

        while (await reader.ReadAsync())
        {
            var category = (MessageCategory)reader.GetInt32(fCategory);
            list.Add(new MessageInboxDto { Id = reader.GetInt64(fId).ToString(), Title = reader.GetString(fTitle), Content = reader.GetString(fContent), Category = (int)category, CategoryName = GetCategoryName(category), CreateTime = reader.GetDateTime(fTime) });
        }
        return list;
    }

    public async Task RevokeMessageAsync(long messageId)
    {
        var msg = await db.Queryable<SysMessage>().InSingleAsync(messageId);
        if (msg == null) return;
        var messageIdStr = messageId.ToString();
        List<long> targetUserIds = [];

        await db.Ado.BeginTranAsync();
        try
        {
            if (msg.Category != MessageCategory.Broadcast) targetUserIds = await db.Queryable<SysUserMessage>().Where(it => it.MessageId == messageId && it.IsRead == false).Select(it => it.UserId).ToListAsync();
            await db.Deleteable<SysUserMessage>().Where(it => it.MessageId == messageId).ExecuteCommandAsync();
            await db.Deleteable<SysMessage>().In(messageId).ExecuteCommandAsync();
            await db.Ado.CommitTranAsync();
        }
        catch { await db.Ado.RollbackTranAsync(); throw; }

        if (targetUserIds.Count > 0)
        {
            var redisDb = redis.GetDatabase();
            var batch = redisDb.CreateBatch();
            var tasks = targetUserIds.Select(uid => batch.StringDecrementAsync($"msg:unread:{uid}")).ToList();
            batch.Execute();
            await Task.WhenAll(tasks);

            var userPayload = new MessageRevokedPayload(messageIdStr);
            var userIdsAsString = targetUserIds.Select(id => id.ToString()).ToArray();
            sseManager.SendToUsers(userIdsAsString, "OnMessageRevoked", userPayload);
            sseManager.SendToUsers(userIdsAsString, "DecrementUnreadCount", new { });
        }

        if (msg.Category == MessageCategory.Broadcast) sseManager.SendToGroup("AuthenticatedUsersGroup", "OnMessageRevoked", new MessageRevokedPayload(messageIdStr));
    }

    public async Task PushArticleChangedAsync(ArticleNoticeDto payload) => sseManager.SendToGroup("ContentGovernanceGroup", "ReceiveArticleUpdate", payload);

    private async Task SendNoticeInternalAsync(long userId, string title, string content, MessageCategory category, string categoryName)
    {
        await db.Ado.BeginTranAsync();
        long msgId; DateTime createTime;
        try
        {
            var msg = new SysMessage { Title = title, Content = content, Category = category, CreateTime = DateTime.UtcNow };
            msgId = await db.Insertable(msg).ExecuteReturnSnowflakeIdAsync();
            createTime = msg.CreateTime;
            await db.Insertable(new SysUserMessage { UserId = userId, MessageId = msgId, IsRead = false }).ExecuteCommandAsync();
            await db.Ado.CommitTranAsync();
        }
        catch { await db.Ado.RollbackTranAsync(); throw; }

        await cache.IncrementUnreadAsync(userId);
        var unreadCount = await cache.GetUnreadCountAsync(userId);

        var dto = new MessageInboxDto { Id = msgId.ToString(), Title = title, Content = content, Category = (int)category, CategoryName = categoryName, IsRead = false, CreateTime = createTime };
        sseManager.SendToUser(userId.ToString(), "OnMessageReceived", dto);
        sseManager.SendToUser(userId.ToString(), "ReceiveNotice", new NoticePayload(title, unreadCount, DateTime.UtcNow));
    }

    private async Task SendGovernanceNoticeInternalAsync(int userId, int status, string title, string content, string? reason)
    {
        await SendNoticeInternalAsync(userId, title, content, MessageCategory.SystemTask, "系统");
        sseManager.SendToUser(userId.ToString(), "OnUserStatusChanged", new UserStatusPayload(status, reason, DateTime.UtcNow));
    }
}