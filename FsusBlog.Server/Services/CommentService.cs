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
    IServiceScopeFactory scopeFactory,
    ICacheInvalidationDispatcher cacheInvalidationDispatcher) : ICommentService
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
        string? replyToUserName = null;
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
                    c.UserId,
                    ParentUserName = u.Username
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

            replyToUserName = parent.ParentUserName;
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
            DeleteTime = null
        };

        long generatedId = await db.Insertable(comment).ExecuteReturnSnowflakeIdAsync();
        if (generatedId <= 0)
        {
            return false;
        }

        await cacheInvalidationDispatcher.InvalidateStatsAsync();

        comment.Id = generatedId;
        long resolvedRootId = comment.RootId ?? comment.Id;
        var notifyPayload = new CommentAddedNotifyDto
        {
            ArticleId = dto.ArticleId,
            Comment = new CommentPushDto
            {
                Id = comment.Id.ToString(),
                Content = comment.Content,
                CreateTime = comment.CreateTime,
                UserName = actorUserName,
                ParentId = comment.ParentId?.ToString(),
                RootId = resolvedRootId.ToString(),
                ReplyToUserId = replyToUserId,
                ReplyToCommentId = replyToCommentId?.ToString(),
                Depth = comment.Depth,
                IsDeleted = false
            },
            Time = DateTime.UtcNow
        };

        await messageService.PushCommentAddAsync(notifyPayload);

        if (replyToUserId.HasValue && replyToUserId.Value > 0 && replyToUserId.Value != userId)
        {
            _ = NotifyReplyAsync(replyToUserId.Value, dto.ArticleId, actorUserName, replyToUserName, normalizedContent);
        }

        logger.LogInformation("评论发表成功 | Article: {ArticleId} | CommentId: {CommentId} | Root: {RootId} | Parent: {ParentId}",
            dto.ArticleId,
            comment.Id,
            resolvedRootId,
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

        CursorEnvelope<long, ThreadRootRow> slice = CursorPagination.Slice(roots, request.Limit, root => root.Id);
        CursorEnvelope<long, CommentThreadItemDto> mapped = await CursorPagination.MapAsync(slice, async root =>
        {
            long rootId = root.Id;
            int replyCount = await db.Queryable<Comment>()
                .Where(c => c.ArticleId == articleId && c.RootId == rootId && c.ParentId != null)
                .CountAsync();

            List<CommentReplyPreviewItemDto> previewReplies = await QueryThreadRepliesPreviewAsync(articleId, rootId, normalizedPreviewLimit);
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
        });

        return CursorPagination.ToResponse(mapped, CursorCodec);
    }

    public async Task<CursorResponse<CommentReplyItemDto>> GetThreadRepliesByCursorAsync(int articleId, long rootId, CursorPageRequest<long> request)
    {
        if (articleId <= 0 || rootId <= 0)
        {
            return new CursorResponse<CommentReplyItemDto> { Data = [], NextCursor = null, HasMore = false };
        }

        bool rootExists = await db.Queryable<Comment>()
            .Where(c => c.Id == rootId && c.ArticleId == articleId && c.ParentId == null)
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

        CursorEnvelope<long, ReplyRow> slice = CursorPagination.Slice(rows, request.Limit, row => row.Id);
        CursorEnvelope<long, CommentReplyItemDto> mapped = CursorPagination.Map(slice, MapReplyRow);
        return CursorPagination.ToResponse(mapped, CursorCodec);
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

        CursorEnvelope<long, UserCommentRow> slice = CursorPagination.Slice(rows, request.Limit, item => item.Id);
        var envelope = CursorPagination.Map(slice, item => CommentProjection.ToResponse(new UserCommentReadModel
        {
            Id = item.Id,
            Content = ToDisplayContent(item.IsDeleted, item.Content),
            CreateTime = item.CreateTime,
            ArticleId = item.ArticleId,
            ArticleTitle = item.ArticleTitle ?? string.Empty,
            RootId = item.RootId,
            ReplyToUserName = item.ReplyToUserName
        }));

        return CursorPagination.ToResponse(envelope, CursorCodec);
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

        await cacheInvalidationDispatcher.InvalidateStatsAsync();
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
                await using var scope = scopeFactory.CreateAsyncScope();
                var msgSvc = scope.ServiceProvider.GetRequiredService<IMessageCommandService>();
                await msgSvc.SendCommentDeletedNoticeAsync(userId, articleTitle, commentSnippet, reason);
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
                await using var scope = scopeFactory.CreateAsyncScope();
                var msgSvc = scope.ServiceProvider.GetRequiredService<IMessageCommandService>();
                string targetName = string.IsNullOrWhiteSpace(targetUserName) ? "您" : targetUserName!;
                string snippet = content.Length > 40 ? content[..40] : content;
                await msgSvc.SendUserTransactionalNoticeAsync(userId, "收到新的评论回复", $"{actor} 回复了 {targetName}：{snippet}");
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
