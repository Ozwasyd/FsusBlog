using System.Data.Common;
using System.Text;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.ReadModels;
using SqlSugar;

namespace FsusBlog.Server.Services;

public partial class CommentService(
    ISqlSugarClient db,
    ILogger<CommentService> logger,
    IMessageRealtimePublisher messageService,
    IMessageCommandService messageCommandService,
    ICacheInvalidationDispatcher cacheInvalidationDispatcher) : ICommentService, ICommentEndpointService
{
    private const int MaxCommentLength = 4000;
    private const int DefaultReplyPreviewLimit = 3;
    private const string DeletedPlaceholder = "该回复已删除";
    private static readonly Int64CursorCodec CursorCodec = Int64CursorCodec.Instance;

    private static bool TryParsePositiveCommentId(string? raw, out long value)
    {
        value = 0;
        return !string.IsNullOrWhiteSpace(raw)
            && long.TryParse(raw, out value)
            && value > 0;
    }

    public async Task<bool> CreateCommentAsync(int userId, CommentDto dto)
    {
        if (dto.ArticleId <= 0)
        {
            return false;
        }

        string normalizedContent = NormalizeCommentContent(dto.Content);
        if (normalizedContent.Length == 0)
        {
            return false;
        }

        bool articleExists = await db.Queryable<Article>()
            .Where(a => a.Id == dto.ArticleId && !a.IsDeleted)
            .AnyAsync();
        if (!articleExists)
        {
            return false;
        }

        string? actorUserName = await db.Queryable<User>()
            .Where(u => u.Id == userId)
            .Select(u => u.Username)
            .FirstAsync();
        if (string.IsNullOrWhiteSpace(actorUserName))
        {
            return false;
        }

        bool hasReplyContext = !string.IsNullOrWhiteSpace(dto.ParentId)
            || !string.IsNullOrWhiteSpace(dto.RootId)
            || !string.IsNullOrWhiteSpace(dto.ReplyToCommentId);
        long? parentId = null;
        long? rootId = null;
        int? replyToUserId = null;
        long? replyToCommentId = null;
        int depth = 0;

        if (hasReplyContext)
        {
            if (!TryParsePositiveCommentId(dto.ParentId, out long parsedParentId))
            {
                return false;
            }

            long? requestedRootId = null;
            if (!string.IsNullOrWhiteSpace(dto.RootId))
            {
                if (!TryParsePositiveCommentId(dto.RootId, out long parsedRootId))
                {
                    return false;
                }

                requestedRootId = parsedRootId;
            }

            long? requestedReplyToCommentId = null;
            if (!string.IsNullOrWhiteSpace(dto.ReplyToCommentId))
            {
                if (!TryParsePositiveCommentId(dto.ReplyToCommentId, out long parsedReplyToCommentId))
                {
                    return false;
                }

                requestedReplyToCommentId = parsedReplyToCommentId;
            }

            var parent = await db.Queryable<Comment, User>((c, u) => c.UserId == u.Id)
                .Where((c, u) => c.Id == parsedParentId && c.ArticleId == dto.ArticleId)
                .Select((c, u) => new
                {
                    c.Id,
                    c.ArticleId,
                    c.RootId,
                    c.Depth,
                    c.UserId
                })
                .FirstAsync();

            if (parent is null || parent.ArticleId != dto.ArticleId)
            {
                return false;
            }

            parentId = parent.Id;
            rootId = parent.RootId ?? parent.Id;
            if (requestedRootId.HasValue && requestedRootId.Value != rootId.Value)
            {
                return false;
            }

            replyToUserId = parent.UserId;
            replyToCommentId = parent.Id;
            if (requestedReplyToCommentId.HasValue && requestedReplyToCommentId.Value != replyToCommentId.Value)
            {
                return false;
            }

            depth = Math.Max(1, parent.Depth + 1);
        }

        var comment = new Comment
        {
            ArticleId = dto.ArticleId,
            Content = normalizedContent,
            UserId = userId,
            CreateTime = DateTime.UtcNow,
            ParentId = parentId,
            RootId = rootId,
            ReplyToUserId = replyToUserId,
            ReplyToCommentId = replyToCommentId,
            Depth = depth,
            IsDeleted = false,
            DeleteReason = null,
            DeleteTime = null,
            ModerationStatus = CommentModerationStatus.Pending,
            ModerationReason = "pending_review"
        };

        long generatedId = await db.Insertable(comment).ExecuteReturnSnowflakeIdAsync();
        if (generatedId <= 0)
        {
            return false;
        }

        await cacheInvalidationDispatcher.InvalidateCommentMutationAsync();

        comment.Id = generatedId;

        logger.LogInformation("评论已进入审核队列 | Article: {ArticleId} | CommentId: {CommentId} | Root: {RootId} | Parent: {ParentId}",
            dto.ArticleId,
            comment.Id,
            comment.RootId ?? comment.Id,
            comment.ParentId);

        return true;
    }

    public async Task<CursorResponse<CommentThreadItemDto>> GetCommentThreadsByCursorAsync(
        int articleId,
        CursorPageRequest<long> request,
        int previewLimit = DefaultReplyPreviewLimit)
    {
        if (articleId <= 0)
        {
            return new CursorResponse<CommentThreadItemDto> { Data = [], NextCursor = null, HasMore = false };
        }

        int normalizedPreviewLimit = Math.Clamp(previewLimit, 1, 10);

        var roots = await db.Queryable<Comment, User>((c, u) => c.UserId == u.Id)
            .Where((c, u) => c.ArticleId == articleId && c.ParentId == null)
            .Where((c, u) => c.ModerationStatus == CommentModerationStatus.Approved)
            .WhereIF(request.Cursor.HasValue, (c, u) => c.Id < request.Cursor!.Value)
            .OrderByDescending((c, u) => c.Id)
            .Take(request.Limit + 1)
            .Select((c, u) => new ThreadRootRow
            {
                Id = c.Id,
                ArticleId = c.ArticleId,
                Content = c.Content,
                CreateTime = c.CreateTime,
                UserName = u.Username,
                Depth = c.Depth,
                IsDeleted = c.IsDeleted
            })
            .ToListAsync();

        int rootWindowCount = CursorPagination.WindowCount(roots, request.Limit);
        long[] rootIds = new long[rootWindowCount];
        for (int i = 0; i < rootWindowCount; i++)
        {
            rootIds[i] = roots[i].Id;
        }

        Dictionary<long, int> replyCountMap = await LoadThreadReplyCountMapAsync(articleId, rootIds);
        Dictionary<long, List<CommentReplyPreviewItemDto>> previewMap = await QueryThreadRepliesPreviewMapAsync(articleId, rootIds, normalizedPreviewLimit);

        return CursorPagination.SliceMapToResponse(roots, request.Limit, root => root.Id, root =>
        {
            long rootId = root.Id;
            int replyCount = replyCountMap.GetValueOrDefault(rootId, 0);
            List<CommentReplyPreviewItemDto> previewReplies = previewMap.GetValueOrDefault(rootId, []);
            bool hasMoreReplies = replyCount > previewReplies.Count;

            return new CommentThreadItemDto(
                root.Id.ToString(),
                ToDisplayContent(root.IsDeleted, root.Content),
                root.CreateTime,
                string.IsNullOrWhiteSpace(root.UserName) ? "匿名用户" : root.UserName,
                rootId.ToString(),
                root.IsDeleted,
                replyCount,
                hasMoreReplies,
                previewReplies);
        }, CursorCodec);
    }

    public async Task<CursorResponse<CommentReplyItemDto>> GetThreadRepliesByCursorAsync(int articleId, long rootId, CursorPageRequest<long> request)
    {
        if (articleId <= 0 || rootId <= 0)
        {
            return new CursorResponse<CommentReplyItemDto> { Data = [], NextCursor = null, HasMore = false };
        }

        bool rootExists = await db.Queryable<Comment>()
            .Where(c => c.Id == rootId && c.ArticleId == articleId && c.ParentId == null && c.ModerationStatus == CommentModerationStatus.Approved)
            .AnyAsync();
        if (!rootExists)
        {
            return new CursorResponse<CommentReplyItemDto> { Data = [], NextCursor = null, HasMore = false };
        }

        var rows = await db.Queryable<Comment, User, User>((c, u, ru) => new object[]
            {
                JoinType.Left, c.UserId == u.Id,
                JoinType.Left, c.ReplyToUserId == ru.Id
            })
            .Where((c, u, ru) => c.ArticleId == articleId && c.RootId == rootId && c.ParentId != null)
            .Where((c, u, ru) => c.ModerationStatus == CommentModerationStatus.Approved)
            .WhereIF(request.Cursor.HasValue, (c, u, ru) => c.Id > request.Cursor!.Value)
            .OrderBy((c, u, ru) => c.Id)
            .Take(request.Limit + 1)
            .Select((c, u, ru) => new ReplyRow
            {
                Id = c.Id,
                ParentId = c.ParentId,
                RootId = c.RootId,
                ReplyToUserId = c.ReplyToUserId,
                ReplyToCommentId = c.ReplyToCommentId,
                Content = c.Content,
                CreateTime = c.CreateTime,
                UserName = u.Username,
                ReplyToUserName = ru.Username,
                Depth = c.Depth,
                IsDeleted = c.IsDeleted
            })
            .ToListAsync();

        return CursorPagination.SliceMapToResponse(rows, request.Limit, row => row.Id, MapReplyRow, CursorCodec);
    }

    public async Task<CursorResponse<CommentQueryResultDto>> GetCommentsByCursorAsync(int articleId, CursorPageRequest<long> request)
    {
        CursorResponse<CommentThreadItemDto> threads = await GetCommentThreadsByCursorAsync(articleId, request, 1);
        var data = new List<CommentQueryResultDto>(threads.Data.Count);
        foreach (CommentThreadItemDto item in threads.Data)
        {
            data.Add(new CommentQueryResultDto(
                long.TryParse(item.Id, out long id) ? id : 0,
                item.Content,
                item.CreateTime,
                item.UserName));
        }

        return new CursorResponse<CommentQueryResultDto>
        {
            Data = data,
            NextCursor = threads.NextCursor,
            HasMore = threads.HasMore
        };
    }

    public async Task<CursorResponse<UserCommentResponse>> GetUserCommentsAsync(int userId, CursorPageRequest<long> request)
    {
        if (userId <= 0)
        {
            return new CursorResponse<UserCommentResponse> { Data = [], NextCursor = null, HasMore = false };
        }

        var rows = await db.Queryable<Comment, Article, User>((c, a, ru) => new object[]
            {
                JoinType.Left, c.ArticleId == a.Id,
                JoinType.Left, c.ReplyToUserId == ru.Id
            })
            .Where((c, a, ru) => c.UserId == userId && !a.IsDeleted)
            .WhereIF(request.Cursor.HasValue, (c, a, ru) => c.Id < request.Cursor!.Value)
            .OrderByDescending((c, a, ru) => c.Id)
            .Take(request.Limit + 1)
            .Select((c, a, ru) => new UserCommentRow
            {
                Id = c.Id,
                Content = c.Content,
                CreateTime = c.CreateTime,
                IsDeleted = c.IsDeleted,
                RootId = c.RootId,
                ArticleId = a.Id,
                ArticleTitle = a.Title,
                ReplyToUserName = ru.Username
            })
            .ToListAsync();

        return CursorPagination.SliceMapToResponse(rows, request.Limit, item => item.Id, item => CommentProjection.ToResponse(new UserCommentReadModel
        {
            Id = item.Id,
            Content = ToDisplayContent(item.IsDeleted, item.Content),
            CreateTime = item.CreateTime,
            ArticleId = item.ArticleId,
            ArticleTitle = item.ArticleTitle ?? string.Empty,
            RootId = item.RootId,
            ReplyToUserName = item.ReplyToUserName
        }), CursorCodec);
    }

    public async Task<bool> DeleteCommentAsync(long id, int currentUserId, bool isAdmin, string reason = "违反社区管理条例")
    {
        var row = await db.Queryable<Comment, Article>((c, a) => c.ArticleId == a.Id)
            .Where((c, a) => c.Id == id)
            .Select((c, a) => new
            {
                c.Id,
                c.UserId,
                c.ArticleId,
                c.ParentId,
                c.RootId,
                c.Content,
                c.IsDeleted,
                ArticleTitle = a.Title
            })
            .FirstAsync();

        if (row is null)
        {
            return false;
        }

        if (row.UserId != currentUserId && !isAdmin)
        {
            return false;
        }

        if (!row.IsDeleted)
        {
            int affected = await db.Updateable<Comment>()
                .SetColumns(c => new Comment
                {
                    IsDeleted = true,
                    DeleteReason = reason,
                    DeleteTime = DateTime.UtcNow
                })
                .Where(c => c.Id == id)
                .ExecuteCommandAsync();

            if (affected <= 0)
            {
                return false;
            }
        }

        await cacheInvalidationDispatcher.InvalidateCommentMutationAsync();
        await messageService.PushCommentRemoveAsync(row.ArticleId, id, row.RootId ?? id, row.ParentId);

        if (isAdmin && currentUserId != row.UserId)
        {
            string commentSnippet = row.Content.Length > 20 ? row.Content[..20] : row.Content;
            _ = NotifyDeletionAsync(row.UserId, row.ArticleTitle ?? "未知文章", commentSnippet, reason);
        }

        logger.LogInformation("评论软删除成功 | CommentId: {CommentId} | Article: {ArticleId} | Root: {RootId} | Parent: {ParentId}",
            id,
            row.ArticleId,
            row.RootId ?? id,
            row.ParentId);

        return true;
    }

    private async Task<List<CommentReplyPreviewItemDto>> QueryThreadRepliesPreviewAsync(int articleId, long rootId, int limit)
    {
        var rows = await db.Queryable<Comment, User, User>((c, u, ru) => new object[]
            {
                JoinType.Left, c.UserId == u.Id,
                JoinType.Left, c.ReplyToUserId == ru.Id
            })
            .Where((c, u, ru) => c.ArticleId == articleId && c.RootId == rootId && c.ParentId != null)
            .Where((c, u, ru) => c.ModerationStatus == CommentModerationStatus.Approved)
            .OrderBy((c, u, ru) => c.Id)
            .Take(limit)
            .Select((c, u, ru) => new ReplyRow
            {
                Id = c.Id,
                ParentId = c.ParentId,
                RootId = c.RootId,
                ReplyToUserId = c.ReplyToUserId,
                ReplyToCommentId = c.ReplyToCommentId,
                Content = c.Content,
                CreateTime = c.CreateTime,
                UserName = u.Username,
                ReplyToUserName = ru.Username,
                Depth = c.Depth,
                IsDeleted = c.IsDeleted
            })
            .ToListAsync();

        return rows.Select(MapReplyPreviewRow).ToList();
    }

    private async Task<Dictionary<long, int>> LoadThreadReplyCountMapAsync(int articleId, long[] rootIds)
    {
        if (rootIds.Length == 0)
        {
            return [];
        }

        List<ReplyCountRow> rows = await db.Queryable<Comment>()
            .Where(c => c.ArticleId == articleId && c.RootId != null && rootIds.Contains(c.RootId.Value) && c.ParentId != null && c.ModerationStatus == CommentModerationStatus.Approved)
            .GroupBy(c => c.RootId)
            .Select(c => new ReplyCountRow
            {
                RootId = c.RootId!.Value,
                Count = SqlFunc.AggregateCount(c.Id)
            })
            .ToListAsync();

        var map = new Dictionary<long, int>(rows.Count);
        foreach (ReplyCountRow row in rows)
        {
            map[row.RootId] = row.Count;
        }

        return map;
    }

    private async Task<Dictionary<long, List<CommentReplyPreviewItemDto>>> QueryThreadRepliesPreviewMapAsync(int articleId, long[] rootIds, int limit)
    {
        if (rootIds.Length == 0)
        {
            return [];
        }

        var sql = new StringBuilder("""
SELECT
    x.id AS "Id",
    x.parent_id AS "ParentId",
    x.root_id AS "RootId",
    x.reply_to_user_id AS "ReplyToUserId",
    x.reply_to_comment_id AS "ReplyToCommentId",
    x.content AS "Content",
    x.create_time AS "CreateTime",
    x.user_name AS "UserName",
    x.reply_to_user_name AS "ReplyToUserName",
    x.depth AS "Depth",
    x.is_deleted AS "IsDeleted"
FROM (
    SELECT
        c.id,
        c.parent_id,
        c.root_id,
        c.reply_to_user_id,
        c.reply_to_comment_id,
        c.content,
        c.create_time,
        u.username AS user_name,
        ru.username AS reply_to_user_name,
        c.depth,
        c.is_deleted,
        ROW_NUMBER() OVER (PARTITION BY c.root_id ORDER BY c.id) AS rn
    FROM comment c
    LEFT JOIN sys_user u ON c.user_id = u.id
    LEFT JOIN sys_user ru ON c.reply_to_user_id = ru.id
    WHERE c.article_id = @ArticleId
      AND c.root_id IS NOT NULL
      AND c.root_id IN (
""");
        var parameters = new List<SugarParameter>(rootIds.Length + 3)
        {
            new("@ArticleId", articleId),
            new("@Approved", (int)CommentModerationStatus.Approved),
            new("@PreviewLimit", limit)
        };
        for (int i = 0; i < rootIds.Length; i++)
        {
            if (i > 0)
            {
                sql.Append(',');
            }

            string parameterName = $"@RootId{i}";
            sql.Append(parameterName);
            parameters.Add(new SugarParameter(parameterName, rootIds[i]));
        }

        sql.Append("""
)
      AND c.parent_id IS NOT NULL
      AND c.moderation_status = @Approved
) x
WHERE x.rn <= @PreviewLimit
ORDER BY x.root_id, x.id;
""");

        var rows = new List<ReplyRow>(rootIds.Length * limit);
        using (var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(sql.ToString(), parameters))
        {
            int fId = reader.GetOrdinal("Id");
            int fParentId = reader.GetOrdinal("ParentId");
            int fRootId = reader.GetOrdinal("RootId");
            int fReplyToUserId = reader.GetOrdinal("ReplyToUserId");
            int fReplyToCommentId = reader.GetOrdinal("ReplyToCommentId");
            int fContent = reader.GetOrdinal("Content");
            int fCreateTime = reader.GetOrdinal("CreateTime");
            int fUserName = reader.GetOrdinal("UserName");
            int fReplyToUserName = reader.GetOrdinal("ReplyToUserName");
            int fDepth = reader.GetOrdinal("Depth");
            int fIsDeleted = reader.GetOrdinal("IsDeleted");

            while (await reader.ReadAsync())
            {
                rows.Add(new ReplyRow
                {
                    Id = reader.GetInt64(fId),
                    ParentId = reader.IsDBNull(fParentId) ? null : reader.GetInt64(fParentId),
                    RootId = reader.IsDBNull(fRootId) ? null : reader.GetInt64(fRootId),
                    ReplyToUserId = reader.IsDBNull(fReplyToUserId) ? null : reader.GetInt32(fReplyToUserId),
                    ReplyToCommentId = reader.IsDBNull(fReplyToCommentId) ? null : reader.GetInt64(fReplyToCommentId),
                    Content = reader.IsDBNull(fContent) ? string.Empty : reader.GetString(fContent),
                    CreateTime = reader.GetDateTime(fCreateTime),
                    UserName = reader.IsDBNull(fUserName) ? string.Empty : reader.GetString(fUserName),
                    ReplyToUserName = reader.IsDBNull(fReplyToUserName) ? null : reader.GetString(fReplyToUserName),
                    Depth = reader.GetInt32(fDepth),
                    IsDeleted = reader.GetBoolean(fIsDeleted)
                });
            }
        }

        var map = new Dictionary<long, List<CommentReplyPreviewItemDto>>(rootIds.Length);
        foreach (ReplyRow row in rows)
        {
            long resolvedRootId = row.RootId ?? row.Id;
            if (!map.TryGetValue(resolvedRootId, out List<CommentReplyPreviewItemDto>? previews))
            {
                previews = [];
                map[resolvedRootId] = previews;
            }

            previews.Add(MapReplyPreviewRow(row));
        }

        return map;
    }

    private static CommentReplyItemDto MapReplyRow(ReplyRow row)
    {
        long resolvedRootId = row.RootId ?? row.Id;
        int viewDepth = Math.Min(2, Math.Max(1, row.Depth));

        return new CommentReplyItemDto(
            row.Id.ToString(),
            ToDisplayContent(row.IsDeleted, row.Content),
            row.CreateTime,
            string.IsNullOrWhiteSpace(row.UserName) ? "匿名用户" : row.UserName,
            row.ReplyToUserId,
            string.IsNullOrWhiteSpace(row.ReplyToUserName) ? null : row.ReplyToUserName,
            row.ParentId?.ToString(),
            resolvedRootId.ToString(),
            row.ReplyToCommentId?.ToString(),
            viewDepth,
            row.IsDeleted);
    }

    private static CommentReplyPreviewItemDto MapReplyPreviewRow(ReplyRow row)
        => new(
            row.Id.ToString(),
            ToDisplayContent(row.IsDeleted, row.Content),
            row.CreateTime,
            string.IsNullOrWhiteSpace(row.UserName) ? "匿名用户" : row.UserName,
            string.IsNullOrWhiteSpace(row.ReplyToUserName) ? null : row.ReplyToUserName,
            row.IsDeleted);

    private static string ToDisplayContent(bool isDeleted, string content)
        => isDeleted ? DeletedPlaceholder : content;

    private static string NormalizeCommentContent(string? content)
    {
        if (string.IsNullOrWhiteSpace(content))
        {
            return string.Empty;
        }

        string trimmed = content.Trim();
        return trimmed.Length > MaxCommentLength ? trimmed[..MaxCommentLength] : trimmed;
    }

    private async Task NotifyDeletionAsync(int userId, string articleTitle, string commentSnippet, string reason)
    {
        await BoundaryExecutor.ExecuteAsync(
            async () =>
            {
                await messageCommandService.SendCommentDeletedNoticeAsync(userId, articleTitle, commentSnippet, reason);
            },
            logger,
            $"comment-notify-delete:{userId}",
            LogLevel.Error);
    }

    private async Task NotifyReplyAsync(int userId, int articleId, string actor, string? targetUserName, string content)
    {
        await BoundaryExecutor.ExecuteAsync(
            async () =>
            {
                string targetName = string.IsNullOrWhiteSpace(targetUserName) ? "您" : targetUserName!;
                string snippet = content.Length > 40 ? content[..40] : content;
                await messageCommandService.SendUserTransactionalNoticeAsync(userId, "收到新的评论回复", $"{actor} 回复了 {targetName}：{snippet}");
            },
            logger,
            $"comment-notify-reply:{userId}",
            LogLevel.Warning);
    }

    private sealed record ThreadRootRow
    {
        public long Id { get; init; }
        public int ArticleId { get; init; }
        public string Content { get; init; } = string.Empty;
        public DateTime CreateTime { get; init; }
        public string UserName { get; init; } = string.Empty;
        public int Depth { get; init; }
        public bool IsDeleted { get; init; }
    }

    private sealed record ReplyRow
    {
        public long Id { get; init; }
        public long? ParentId { get; init; }
        public long? RootId { get; init; }
        public int? ReplyToUserId { get; init; }
        public long? ReplyToCommentId { get; init; }
        public string Content { get; init; } = string.Empty;
        public DateTime CreateTime { get; init; }
        public string UserName { get; init; } = string.Empty;
        public string? ReplyToUserName { get; init; }
        public int Depth { get; init; }
        public bool IsDeleted { get; init; }
    }

    private sealed record ReplyCountRow
    {
        public long RootId { get; init; }
        public int Count { get; init; }
    }

    private sealed record UserCommentRow
    {
        public long Id { get; init; }
        public string Content { get; init; } = string.Empty;
        public DateTime CreateTime { get; init; }
        public bool IsDeleted { get; init; }
        public long? RootId { get; init; }
        public int ArticleId { get; init; }
        public string? ArticleTitle { get; init; }
        public string? ReplyToUserName { get; init; }
    }
}
