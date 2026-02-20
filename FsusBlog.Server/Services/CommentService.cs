using FsusBlog.Server.Entities;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using SqlSugar;

namespace FsusBlog.Server.Services;

public class CommentService(ISqlSugarClient _db, ILogger<CommentService> _logger, IMessageService _messageService) : ICommentService
{
    /// <summary>
    /// 发表评论
    /// </summary>
    public async Task<bool> CreateCommentAsync(int userId, CommentDto dto)
    {
        // 获取用户信息（用于推送显示用户名）
        var user = await _db.Queryable<User>().InSingleAsync(userId);
        if (user == null) return false;

        var comment = new Comment
        {
            ArticleId = dto.ArticleId,
            Content = dto.Content,
            UserId = userId,
            CreateTime = DateTime.UtcNow
        };

        // 插入并获取 Snowflake ID
        long generatedId = await _db.Insertable(comment).ExecuteReturnSnowflakeIdAsync();

        bool success = generatedId > 0;

        if (success)
        {
            comment.Id = generatedId;

            // 构造符合协议的嵌套 DTO
            var notifyPayload = new CommentAddedNotifyDto
            {
                ArticleId = dto.ArticleId,
                Comment = new CommentPushDto
                {
                    Id = comment.Id.ToString(), // 统一转字符串防止精度丢失
                    Content = comment.Content,
                    CreateTime = comment.CreateTime,
                    UserName = user.Username
                },
                Time = DateTime.UtcNow
            };

            await _messageService.PushCommentAddAsync(notifyPayload);

            _logger.LogInformation("评论发表成功并广播推送 | 文章: {ArticleId} | ID: {Id}", dto.ArticleId, comment.Id);
        }

        return success;
    }

    /// <summary>
    /// 游标分页获取文章评论 (高性能)
    /// </summary>
    public async Task<CursorResult<Comment>> GetCommentsByCursorAsync(int articleId, long? cursor, int limit)
    {
        // 逻辑：Id 倒序，查询小于当前游标的记录
        var query = _db.Queryable<Comment>()
            .Includes(c => c.User)
            .Where(c => c.ArticleId == articleId);

        if (cursor.HasValue && cursor > 0)
        {
            query = query.Where(c => c.Id < cursor.Value);
        }

        // 取 limit + 1 条，多出的一条作为 HasMore 的判定哨兵
        var list = await query
            .OrderByDescending(c => c.Id)
            .Take(limit + 1)
            .ToListAsync();

        bool hasMore = list.Count > limit;
        if (hasMore)
        {
            list.RemoveAt(limit); // 移除判定哨兵
        }

        // 确定下一个游标位置
        long? nextCursor = hasMore ? list.LastOrDefault()?.Id : null;

        return new CursorResult<Comment>
        {
            Data = list,
            NextCursor = nextCursor, // 这里的 NextCursor 类型也需要在泛型类中改为 long?
            HasMore = hasMore
        };
    }

    /// <summary>
    /// 获取用户的历史评论 (个人中心)
    /// </summary>
    public async Task<CursorResult<UserCommentDto>> GetUserCommentsAsync(int userId, long? cursor, int limit)
    {
        var query = _db.Queryable<Comment, Article>(
                (c, a) => c.ArticleId == a.Id
            )
            .Where((c, a) => c.UserId == userId && !a.IsDeleted) // 过滤已删除或回收站中的文章
            .WhereIF(cursor.HasValue && cursor > 0, (c, a) => c.Id < cursor);

        // 核心优化：投影查询，彻底隔离 Article.Content 这种超大文本字段
        var list = await query
            .OrderByDescending((c, a) => c.Id)
            .Take(limit + 1)
            .Select((c, a) => new UserCommentDto
            {
                Id = c.Id, // 这里的 UserCommentDto.Id 也建议改为 long
                Content = c.Content,
                CreateTime = c.CreateTime,
                ArticleId = a.Id,
                ArticleTitle = a.Title
            })
            .ToListAsync();

        bool hasMore = list.Count > limit;
        if (hasMore) list.RemoveAt(limit);

        return new CursorResult<UserCommentDto>
        {
            Data = list,
            NextCursor = hasMore ? list.LastOrDefault()?.Id : null,
            HasMore = hasMore
        };
    }

    /// <summary>
    /// 安全删除评论 (支持作者自删和管理员强删)
    /// </summary>
    public async Task<bool> DeleteCommentAsync(long id, int currentUserId, bool isAdmin, string reason = "违反社区管理条例")
    {
        // 包含 Article 导航属性以获取标题，用于通知元数据
        var comment = await _db.Queryable<Comment>()
            .Includes(c => c.Article)
            .InSingleAsync(id);

        if (comment == null) return false;

        // 权限熔断
        if (comment.UserId != currentUserId && !isAdmin) return false;

        // 准备通知所需的快照数据（必须在删除前提取）
        int targetUserId = comment.UserId;
        string articleTitle = comment.Article?.Title ?? "未知文章";
        // 截取评论前20个字符作为摘要
        string commentSnippet = comment.Content.Length > 20
            ? comment.Content[..20]
            : comment.Content;

        int articleId = comment.ArticleId;

        // 原子执行删除
        var success = await _db.Deleteable<Comment>().In(id).ExecuteCommandAsync() > 0;

        if (success)
        {
            //实时广播：让所有正在看文章的人 UI 同步移除该评论 (Snowflake ID)
            await _messageService.PushCommentRemoveAsync(articleId, id);

            // 治理通知：仅当管理员删除他人评论时，发送私信通知原作者
            if (isAdmin && currentUserId != targetUserId)
            {
                // 采用异步触发，不阻塞 API 的最终响应，保障高性能
                _ = _messageService.SendCommentDeletedNoticeAsync(targetUserId, articleTitle, commentSnippet, reason);
            }

            _logger.LogInformation("[治理审计] 管理员 {AdminId} 移除了用户 {TargetId} 的评论 | 理由: {Reason} | 评论ID: {Id}", currentUserId, targetUserId, reason, id);
        }

        return success;
    }
}
