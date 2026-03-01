using FsusBlog.Server.Entities;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using SqlSugar;
using System.Data.Common;

namespace FsusBlog.Server.Services;

/// <summary>
/// 评论核心服务
/// 修复日期: 2026-02-23 
/// </summary>
public class CommentService(
    ISqlSugarClient _db,
    ILogger<CommentService> _logger,
    IMessageService _messageService,
    IServiceScopeFactory _scopeFactory) : ICommentService
{
    /// <summary>
    /// 发表评论
    /// </summary>
    public async Task<bool> CreateCommentAsync(int userId, CommentDto dto)
    {
        var userQuery = _db.Queryable<User>()
            .Where(u => u.Id == userId)
            .Select(u => new { u.Username });

        var sqlObj = userQuery.ToSql();
        string? username = null;

        using (var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(sqlObj.Key, sqlObj.Value))
        {
            if (await reader.ReadAsync())
            {
                username = reader.IsDBNull(0) ? "匿名用户" : reader.GetString(0);
            }
        }

        if (username == null) return false;

        var comment = new Comment
        {
            ArticleId = dto.ArticleId,
            Content = dto.Content,
            UserId = userId,
            CreateTime = DateTime.UtcNow
        };

        long generatedId = await _db.Insertable(comment).ExecuteReturnSnowflakeIdAsync();

        if (generatedId > 0)
        {
            comment.Id = generatedId;

            var notifyPayload = new CommentAddedNotifyDto
            {
                ArticleId = dto.ArticleId,
                Comment = new CommentPushDto
                {
                    Id = comment.Id.ToString(),
                    Content = comment.Content,
                    CreateTime = comment.CreateTime,
                    UserName = username
                },
                Time = DateTime.UtcNow
            };

            await _messageService.PushCommentAddAsync(notifyPayload);

            _logger.LogInformation("评论发表成功并广播推送 | 文章: {ArticleId} | ID: {Id}", dto.ArticleId, comment.Id);
            return true;
        }

        return false;
    }

    /// <summary>
    /// 游标分页获取文章评论 (Dapper 级物理映射)
    /// </summary>
    public async Task<CursorResult<CommentQueryResultDto>> GetCommentsByCursorAsync(int articleId, long? cursor, int limit)
    {
        var query = _db.Queryable<Comment, User>((c, u) => c.UserId == u.Id)
            .Where(c => c.ArticleId == articleId)
            .WhereIF(cursor.HasValue && cursor > 0, c => c.Id < cursor!.Value)
            .OrderByDescending(c => c.Id)
            .Take(limit + 1) // 取 limit + 1 条作为 HasMore 哨兵
            .Select((c, u) => new
            {
                c.Id,
                c.Content,
                c.CreateTime,
                u.Username
            });

        var sqlObj = query.ToSql();
        var list = new List<CommentQueryResultDto>(limit + 1);

        using (var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(sqlObj.Key, sqlObj.Value))
        {
            int fId = reader.GetOrdinal("Id");
            int fContent = reader.GetOrdinal("Content");
            int fTime = reader.GetOrdinal("CreateTime");
            int fName = reader.GetOrdinal("Username");

            while (await reader.ReadAsync())
            {
                list.Add(new CommentQueryResultDto
                {
                    Id = reader.GetInt64(fId),
                    Content = reader.GetString(fContent),
                    CreateTime = reader.GetDateTime(fTime),
                    UserName = reader.IsDBNull(fName) ? "匿名用户" : reader.GetString(fName)
                });
            }
        }

        bool hasMore = list.Count > limit;
        long? nextCursor = null;

        if (hasMore)
        {
            list.RemoveAt(limit);
            nextCursor = list[^1].Id;
        }

        return new CursorResult<CommentQueryResultDto>
        {
            Data = list,
            NextCursor = nextCursor,
            HasMore = hasMore
        };
    }

    /// <summary>
    /// 获取用户的历史评论 (个人中心)
    /// </summary>
    public async Task<CursorResult<UserCommentDto>> GetUserCommentsAsync(int userId, long? cursor, int limit)
    {
        var query = _db.Queryable<Comment, Article>((c, a) => c.ArticleId == a.Id)
            .Where((c, a) => c.UserId == userId && !a.IsDeleted)
            .WhereIF(cursor.HasValue && cursor > 0, (c, a) => c.Id < cursor)
            .OrderByDescending((c, a) => c.Id)
            .Take(limit + 1)
            .Select((c, a) => new
            {
                c.Id,
                c.Content,
                c.CreateTime,
                ArticleId = a.Id,
                ArticleTitle = a.Title
            });

        var sqlObj = query.ToSql();
        var list = new List<UserCommentDto>(limit + 1);

        using (var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(sqlObj.Key, sqlObj.Value))
        {
            int fId = reader.GetOrdinal("Id");
            int fContent = reader.GetOrdinal("Content");
            int fTime = reader.GetOrdinal("CreateTime");
            int fArtId = reader.GetOrdinal("ArticleId");
            int fTitle = reader.GetOrdinal("ArticleTitle");

            while (await reader.ReadAsync())
            {
                list.Add(new UserCommentDto
                {
                    Id = reader.GetInt64(fId),
                    Content = reader.GetString(fContent),
                    CreateTime = reader.GetDateTime(fTime),
                    ArticleId = reader.GetInt32(fArtId),
                    ArticleTitle = reader.IsDBNull(fTitle) ? string.Empty : reader.GetString(fTitle)
                });
            }
        }

        bool hasMore = list.Count > limit;
        long? nextCursor = null;

        if (hasMore)
        {
            list.RemoveAt(limit);
            nextCursor = list[^1].Id;
        }

        return new CursorResult<UserCommentDto>
        {
            Data = list,
            NextCursor = nextCursor,
            HasMore = hasMore
        };
    }

    /// <summary>
    /// 安全删除评论 (支持作者自删和管理员强删)
    /// </summary>
    public async Task<bool> DeleteCommentAsync(long id, int currentUserId, bool isAdmin, string reason = "违反社区管理条例")
    {
        var infoQuery = _db.Queryable<Comment, Article>((c, a) => c.ArticleId == a.Id)
            .Where(c => c.Id == id)
            .Select((c, a) => new
            {
                c.UserId,
                c.ArticleId,
                c.Content,
                ArticleTitle = a.Title
            });

        var sqlObj = infoQuery.ToSql();

        int? targetUserId = null;
        int articleId = 0;
        string content = string.Empty;
        string articleTitle = string.Empty;

        using (var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(sqlObj.Key, sqlObj.Value))
        {
            if (await reader.ReadAsync())
            {
                targetUserId = reader.GetInt32(0);
                articleId = reader.GetInt32(1);
                content = reader.GetString(2);
                articleTitle = reader.IsDBNull(3) ? "未知文章" : reader.GetString(3);
            }
        }

        if (targetUserId == null) return false;
        if (targetUserId.Value != currentUserId && !isAdmin) return false;

        // 🌟 核心修复：直接使用 C# 8 切片语法，最干净且无编译错误的实现方式
        string commentSnippet = content.Length > 20 ? content[..20] : content;

        var success = await _db.Deleteable<Comment>().In(id).ExecuteCommandAsync() > 0;

        if (success)
        {
            await _messageService.PushCommentRemoveAsync(articleId, id);

            if (isAdmin && currentUserId != targetUserId.Value)
            {
                _ = Task.Run(async () =>
                {
                    try
                    {
                        using var scope = _scopeFactory.CreateScope();
                        var msgSvc = scope.ServiceProvider.GetRequiredService<IMessageService>();
                        await msgSvc.SendCommentDeletedNoticeAsync(targetUserId.Value, articleTitle, commentSnippet, reason);
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError(ex, "后台异步发送评论删除通知失败");
                    }
                });
            }

            _logger.LogInformation("[治理审计] 管理员 {AdminId} 移除了用户 {TargetId} 的评论 | 理由: {Reason} | 评论ID: {Id}", currentUserId, targetUserId, reason, id);
        }

        return success;
    }
}