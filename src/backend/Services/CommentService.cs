using System.Data.Common;
using System.Text;
using System.Text.Json;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Server.Services.Moderation;
using SqlSugar;

namespace FsusBlog.Server.Services;

public partial class CommentService(
    ISqlSugarClient db,
    ILogger<CommentService> logger,
    IMessageRealtimePublisher messageService,
    IMessageCommandService messageCommandService,
    ICacheInvalidationDispatcher cacheInvalidationDispatcher,
    IRegionLegalModerationService regionLegalModerationService,
    IAntiSpamModerationService? antiSpamModerationService = null) : ICommentService, ICommentEndpointService
{
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
        if (!IsCommentContentWithinLimit(normalizedContent))
        {
            return false;
        }

        DateTime now = DateTime.UtcNow;
        bool articleExists = await db.Queryable<Article>()
            .Where(a => a.Id == dto.ArticleId
                && !a.IsDeleted
                && a.Status == ArticleStatus.Published
                && (a.PublishedAt == null || a.PublishedAt <= now)
                && (a.ScheduledPublishAt == null || a.ScheduledPublishAt <= now))
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
                .Where((c, u) => c.Id == parsedParentId
                    && c.ArticleId == dto.ArticleId
                    && c.ModerationStatus == CommentModerationStatus.Approved
                    && !c.IsDeleted)
                .Select((c, u) => new
                {
                    c.Id,
                    c.ArticleId,
                    c.RootId,
                    c.ParentId,
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

            bool rootIsVisible = await db.Queryable<Comment>()
                .Where(c => c.Id == rootId.Value
                    && c.ArticleId == dto.ArticleId
                    && c.ParentId == null
                    && c.ModerationStatus == CommentModerationStatus.Approved
                    && !c.IsDeleted)
                .AnyAsync();
            if (!rootIsVisible)
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

        RegionModerationDecision regionDecision = dto.RegionDecision ?? regionLegalModerationService.EvaluateOnSubmit(new RegionModerationRequest(
            normalizedContent,
            dto.ArticleId,
            userId,
            RegionCodes.Unknown,
            0d,
            "fallback",
            null,
            null,
            DateTime.UtcNow));
        if (!regionDecision.CanPublish)
        {
            return false;
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
            ModerationReason = regionDecision.HideUntilReviewed
                ? "region_policy:manual_review_no_public_display"
                : "pending_review"
        };

        long generatedId = 0;
        var insertResult = await db.Ado.UseTranAsync(async () =>
        {
            generatedId = await db.Insertable(comment).ExecuteReturnSnowflakeIdAsync();
            if (generatedId <= 0)
            {
                throw new InvalidOperationException("Failed to create comment id.");
            }

            await db.Insertable(BuildRegionCompliance(generatedId, regionDecision)).ExecuteCommandAsync();
        });
        if (!insertResult.IsSuccess || generatedId <= 0)
        {
            logger.LogWarning(insertResult.ErrorException, "评论创建或地区合规记录写入失败 | Article: {ArticleId} | User: {UserId}", dto.ArticleId, userId);
            return false;
        }

        comment.Id = generatedId;
        if (antiSpamModerationService is not null)
        {
            await antiSpamModerationService.ScoreCommentAsync(
                new AntiSpamCommentModerationContext(
                    comment.Id,
                    comment.ArticleId,
                    comment.UserId,
                    comment.Content,
                    comment.ParentId,
                    regionDecision.SubmitIpHash,
                    regionDecision.SubmitRegion,
                    regionDecision.PolicyVersion,
                    comment.CreateTime),
                CancellationToken.None);
        }

        await cacheInvalidationDispatcher.InvalidateCommentMutationAsync(
            new CommentCacheInvalidationScope(
                ArticleId: comment.ArticleId,
                RootId: comment.RootId ?? comment.Id,
                UserId: userId,
                PublicArticleChanged: false,
                UserCommentsChanged: true));

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
        int previewLimit = DefaultReplyPreviewLimit,
        string viewerRegion = RegionCodes.Global)
    {
        if (articleId <= 0)
        {
            return new CursorResponse<CommentThreadItemDto> { Data = [], NextCursor = null, HasMore = false };
        }

        int normalizedPreviewLimit = Math.Clamp(previewLimit, 1, 10);

        string normalizedViewerRegion = regionLegalModerationService.NormalizeRegion(viewerRegion);
        string blockedToken = RegionLegalModerationService.SerializeRegions([normalizedViewerRegion]);
        bool conservativeUnknownViewer = normalizedViewerRegion == RegionCodes.Unknown;

        var rootQuery = db.Queryable<Comment, User>((c, u) => c.UserId == u.Id)
            .Where((c, u) => c.ArticleId == articleId && c.ParentId == null)
            .Where((c, u) => c.ModerationStatus == CommentModerationStatus.Approved)
            .Where((c, u) => !c.IsDeleted);

        rootQuery = conservativeUnknownViewer
            ? rootQuery.Where((c, u) => !SqlFunc.Subqueryable<CommentRegionCompliance>()
                .Where(rc => rc.CommentId == c.Id
                    && rc.BlockedRegions != string.Empty)
                .Any())
            : rootQuery.Where((c, u) => !SqlFunc.Subqueryable<CommentRegionCompliance>()
                .Where(rc => rc.CommentId == c.Id
                    && rc.BlockedRegions.Contains(blockedToken))
                .Any());

        var roots = await rootQuery
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

        Dictionary<long, List<CommentReplyPreviewItemDto>> previewMap = await QueryThreadRepliesPreviewMapAsync(articleId, rootIds, normalizedPreviewLimit + 1, normalizedViewerRegion);

        return CursorPagination.SliceMapToResponse(roots, request.Limit, root => root.Id, root =>
        {
            long rootId = root.Id;
            List<CommentReplyPreviewItemDto> loadedReplies = previewMap.GetValueOrDefault(rootId, []);
            bool hasMoreReplies = loadedReplies.Count > normalizedPreviewLimit;
            List<CommentReplyPreviewItemDto> previewReplies = hasMoreReplies
                ? loadedReplies.Take(normalizedPreviewLimit).ToList()
                : loadedReplies;
            int replyCount = previewReplies.Count + (hasMoreReplies ? 1 : 0);

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

    public async Task<CursorResponse<CommentReplyItemDto>> GetThreadRepliesByCursorAsync(
        int articleId,
        long rootId,
        CursorPageRequest<long> request,
        string viewerRegion = RegionCodes.Global)
    {
        if (articleId <= 0 || rootId <= 0)
        {
            return new CursorResponse<CommentReplyItemDto> { Data = [], NextCursor = null, HasMore = false };
        }

        string normalizedViewerRegion = regionLegalModerationService.NormalizeRegion(viewerRegion);
        string blockedToken = RegionLegalModerationService.SerializeRegions([normalizedViewerRegion]);
        bool conservativeUnknownViewer = normalizedViewerRegion == RegionCodes.Unknown;

        var rootExistsQuery = db.Queryable<Comment>()
            .Where(c => c.Id == rootId && c.ArticleId == articleId && c.ParentId == null && c.ModerationStatus == CommentModerationStatus.Approved && !c.IsDeleted)
            ;

        rootExistsQuery = conservativeUnknownViewer
            ? rootExistsQuery.Where(c => !SqlFunc.Subqueryable<CommentRegionCompliance>()
                .Where(rc => rc.CommentId == c.Id
                    && rc.BlockedRegions != string.Empty)
                .Any())
            : rootExistsQuery.Where(c => !SqlFunc.Subqueryable<CommentRegionCompliance>()
                .Where(rc => rc.CommentId == c.Id
                    && rc.BlockedRegions.Contains(blockedToken))
                .Any());

        bool rootExists = await rootExistsQuery
            .AnyAsync();
        if (!rootExists)
        {
            return new CursorResponse<CommentReplyItemDto> { Data = [], NextCursor = null, HasMore = false };
        }

        var replyQuery = db.Queryable<Comment, User, User>((c, u, ru) => new object[]
            {
                JoinType.Left, c.UserId == u.Id,
                JoinType.Left, c.ReplyToUserId == ru.Id
            })
            .Where((c, u, ru) => c.ArticleId == articleId && c.RootId == rootId && c.ParentId != null)
            .Where((c, u, ru) => c.ModerationStatus == CommentModerationStatus.Approved)
            .Where((c, u, ru) => !c.IsDeleted);

        replyQuery = conservativeUnknownViewer
            ? replyQuery.Where((c, u, ru) => !SqlFunc.Subqueryable<CommentRegionCompliance>()
                .Where(rc => rc.CommentId == c.Id
                    && rc.BlockedRegions != string.Empty)
                .Any())
            : replyQuery.Where((c, u, ru) => !SqlFunc.Subqueryable<CommentRegionCompliance>()
                .Where(rc => rc.CommentId == c.Id
                    && rc.BlockedRegions.Contains(blockedToken))
                .Any());

        var rows = await replyQuery
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
            DateTime deletedAt = DateTime.UtcNow;
            string? normalizedReason = NormalizeNullable(reason, 256);
            int affected = await db.Updateable<Comment>()
                .SetColumns(c => new Comment
                {
                    IsDeleted = true,
                    DeleteReason = reason,
                    DeleteTime = deletedAt,
                    ModerationStatus = CommentModerationStatus.Hidden,
                    ModerationReason = normalizedReason
                })
                .Where(c => c.Id == id)
                .ExecuteCommandAsync();

            if (affected <= 0)
            {
                return false;
            }
        }

        await cacheInvalidationDispatcher.InvalidateCommentMutationAsync(
            new CommentCacheInvalidationScope(
                ArticleId: row.ArticleId,
                RootId: row.RootId ?? row.Id,
                UserId: row.UserId,
                PublicArticleChanged: true,
                UserCommentsChanged: true));
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
            .Where((c, u, ru) => !c.IsDeleted)
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

    private async Task<Dictionary<long, List<CommentReplyPreviewItemDto>>> QueryThreadRepliesPreviewMapAsync(
        int articleId,
        long[] rootIds,
        int limit,
        string viewerRegion)
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
        string normalizedViewerRegion = regionLegalModerationService.NormalizeRegion(viewerRegion);
        var parameters = new List<SugarParameter>(rootIds.Length + 5)
        {
            new("@ArticleId", articleId),
            new("@Approved", (int)CommentModerationStatus.Approved),
            new("@PreviewLimit", limit),
            new("@BlockedToken", RegionLegalModerationService.SerializeRegions([normalizedViewerRegion])),
            new("@ConservativeUnknownViewer", normalizedViewerRegion == RegionCodes.Unknown)
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
      AND c.is_deleted = false
      AND NOT EXISTS (
          SELECT 1
          FROM comment_region_compliance crc
          WHERE crc.comment_id = c.id
            AND (
                (@ConservativeUnknownViewer = true AND crc.blocked_regions <> '')
                OR (@ConservativeUnknownViewer = false AND position(@BlockedToken in crc.blocked_regions) > 0)
            )
      )
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

        return content.Trim();
    }

    private static bool IsCommentContentWithinLimit(string content)
        => !string.IsNullOrWhiteSpace(content)
            && content.Length <= CommentLimits.ContentMaxChars
            && Encoding.UTF8.GetByteCount(content) <= CommentLimits.ContentMaxUtf8Bytes;

    private static string? NormalizeNullable(string? value, int maxLength)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        string trimmed = value.Trim();
        return trimmed.Length <= maxLength ? trimmed : trimmed[..maxLength];
    }

    private static CommentRegionCompliance BuildRegionCompliance(long commentId, RegionModerationDecision decision)
    {
        DateTime now = DateTime.UtcNow;
        return new CommentRegionCompliance
        {
            CommentId = commentId,
            SubmitRegion = NormalizeNullable(decision.SubmitRegion, 64) ?? RegionCodes.Unknown,
            SubmitRegionConfidence = Math.Clamp(decision.SubmitRegionConfidence, 0d, 1d),
            RegionProvider = NormalizeNullable(decision.RegionProvider, 64) ?? "unknown",
            SubmitIpHash = NormalizeNullable(decision.SubmitIpHash, 64),
            PolicyVersion = NormalizeNullable(decision.PolicyVersion, 64) ?? RegionLegalModerationService.CurrentPolicyVersion,
            CanPublish = decision.CanPublish,
            RequiresManualReview = decision.RequiresManualReview,
            HideUntilReviewed = decision.HideUntilReviewed,
            BlockedRegions = RegionLegalModerationService.SerializeRegions(decision.BlockedRegions),
            RiskLabels = string.Join(',', decision.RiskLabels
                .Where(static label => !string.IsNullOrWhiteSpace(label))
                .Select(static label => label.Trim())
                .Distinct(StringComparer.Ordinal)
                .OrderBy(static label => label, StringComparer.Ordinal)),
            DecisionReason = NormalizeNullable(decision.DecisionReason, 256),
            RuleHitsJson = decision.RuleHits.Count == 0 ? null : JsonSerializer.Serialize(decision.RuleHits),
            CreatedAtUtc = now,
            UpdatedAtUtc = now
        };
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
