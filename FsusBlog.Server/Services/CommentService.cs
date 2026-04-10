using FsusBlog.Server.Entities;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using SqlSugar;
using StackExchange.Redis;
using System.Data.Common;

namespace FsusBlog.Server.Services;

/// <summary>
/// 评论核心服务
/// 修复日期: 2026-02-23 
/// </summary>
public partial class CommentService(
    ISqlSugarClient _db,
    ILogger<CommentService> _logger,
    IMessageService _messageService,
    IServiceScopeFactory _scopeFactory,
    IConnectionMultiplexer _redisConnection) : ICommentService
{
    private readonly IDatabase _redis = _redisConnection.GetDatabase();
    private const string StatsCacheKey = "admin:dashboard:stats";
    private const int MaxCommentLength = 4000;
    private const int MaxCursorLimit = 100;

    /// <summary>
    /// 发表评论
    /// </summary>
    public async Task<bool> CreateCommentAsync(int userId, CommentDto dto)
    {
        if (dto.ArticleId <= 0)
        {
            return false;
        }

        var normalizedContent = NormalizeCommentContent(dto.Content);
        if (normalizedContent.Length == 0)
        {
            return false;
        }

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
            Content = normalizedContent,
            UserId = userId,
            CreateTime = DateTime.UtcNow
        };

        long generatedId = await _db.Insertable(comment).ExecuteReturnSnowflakeIdAsync();

        if (generatedId > 0)
        {
            await _redis.KeyDeleteAsync(StatsCacheKey);

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
        if (articleId <= 0)
        {
            return new CursorResult<CommentQueryResultDto> { Data = [], NextCursor = null, HasMore = false };
        }

        limit = NormalizeLimit(limit);

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

        return BuildCursorResult(list, limit, static item => item.Id);
    }

    /// <summary>
    /// 获取用户的历史评论 (个人中心)
    /// </summary>
    public async Task<CursorResult<UserCommentDto>> GetUserCommentsAsync(int userId, long? cursor, int limit)
    {
        if (userId <= 0)
        {
            return new CursorResult<UserCommentDto> { Data = [], NextCursor = null, HasMore = false };
        }

        limit = NormalizeLimit(limit);

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

        return BuildCursorResult(list, limit, static item => item.Id);
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

        // 核心修复：直接使用 C# 8 切片语法，最干净且无编译错误的实现方式
        string commentSnippet = content.Length > 20 ? content[..20] : content;

        var success = await _db.Deleteable<Comment>().In(id).ExecuteCommandAsync() > 0;

        if (success)
        {
            await _redis.KeyDeleteAsync(StatsCacheKey);

            await _messageService.PushCommentRemoveAsync(articleId, id);

            if (isAdmin && currentUserId != targetUserId.Value)
            {
                _ = NotifyDeletionAsync(targetUserId.Value, articleTitle, commentSnippet, reason);
            }

            _logger.LogInformation("[治理审计] 管理员 {AdminId} 移除了用户 {TargetId} 的评论 | 理由: {Reason} | 评论ID: {Id}", currentUserId, targetUserId, reason, id);
        }

        return success;
    }

    private int NormalizeLimit(int limit) => limit switch
    {
        < 1 => 20,
        > MaxCursorLimit => MaxCursorLimit,
        _ => limit
    };

    private static string NormalizeCommentContent(string? content)
    {
        if (string.IsNullOrWhiteSpace(content))
        {
            return string.Empty;
        }

        var trimmed = content.Trim();
        return trimmed.Length > MaxCommentLength ? trimmed[..MaxCommentLength] : trimmed;
    }

    private async Task NotifyDeletionAsync(int userId, string articleTitle, string commentSnippet, string reason)
    {
        try
        {
            using var scope = _scopeFactory.CreateScope();
            var msgSvc = scope.ServiceProvider.GetRequiredService<IMessageService>();
            await msgSvc.SendCommentDeletedNoticeAsync(userId, articleTitle, commentSnippet, reason);
        }
        catch (Exception ex)
        {
            LogNotifyDeletionFailed(ex);
        }
    }

    private static CursorResult<T> BuildCursorResult<T>(List<T> list, int limit, Func<T, long> idSelector)
    {
        bool hasMore = list.Count > limit;
        string? nextCursor = null;
        if (hasMore)
        {
            list.RemoveAt(limit);
            nextCursor = idSelector(list[^1]).ToString();
        }

        return new CursorResult<T>
        {
            Data = list,
            NextCursor = nextCursor,
            HasMore = hasMore
        };
    }

    [LoggerMessage(EventId = 1, Level = LogLevel.Error, Message = "后台异步发送评论删除通知失败")]
    private partial void LogNotifyDeletionFailed(Exception ex);
}
