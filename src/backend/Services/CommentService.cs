using System.Data.Common;
using System.Text;
using System.Text.Json;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Server.Services.Moderation;
using FsusBlog.Server.Services.Security;
using SqlSugar;

namespace FsusBlog.Server.Services;

public partial class CommentService(
    ISqlSugarClient db,
    ILogger<CommentService> logger,
    IMessageRealtimePublisher messageService,
    IMessageCommandService messageCommandService,
    ICacheInvalidationDispatcher cacheInvalidationDispatcher,
    IRegionLegalModerationService regionLegalModerationService,
    IAntiSpamModerationService? antiSpamModerationService = null,
    ICommentActorResolver? commentActorResolver = null,
    IAnonymousCommentPolicyService? anonymousCommentPolicyService = null) : ICommentService, ICommentEndpointService
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

        if (commentActorResolver is null)
        {
            return false;
        }

        CommentActorResolveResult actorResult = await commentActorResolver.ResolveAsync(
            new CommentActorResolveRequest(
                UserId: userId > 0 ? userId : null,
                ArticleId: dto.ArticleId,
                AuthorMode: dto.AuthorMode,
                PublicSendExplicitlySelected: dto.PublicSendExplicitlySelected,
                AnonymousScope: dto.AnonymousScope,
                DisplayLanguage: dto.DisplayLanguage,
                ProofToken: dto.ProofToken,
                ZkProof: dto.ZkProof,
                SubmitRegion: regionDecision.SubmitRegion),
            CancellationToken.None);
        if (!actorResult.Allowed || actorResult.Actor is null)
        {
            return false;
        }

        CommentActor actor = actorResult.Actor;

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

            var parent = await db.Queryable<Comment>()
                .Where(c => c.Id == parsedParentId
                    && c.ArticleId == dto.ArticleId
                    && c.ModerationStatus == CommentModerationStatus.Approved
                    && !c.IsDeleted)
                .Select(c => new
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

        var comment = new Comment
        {
            ArticleId = dto.ArticleId,
            Content = normalizedContent,
            UserId = actor.UserId,
            AuthorMode = actor.AuthorMode,
            PublicHandle = actor.PublicHandle,
            AnonymousHandle = actor.AnonymousHandle,
            AnonymousDisplayName = actor.DisplayName,
            AnonymousDisplayLanguage = actor.DisplayLanguage,
            AnonymousNullifierHash = actor.AnonymousNullifierHash,
            AnonymousScope = actor.AnonymousScope,
            ModerationSubjectHash = actor.ModerationSubjectHash,
            CredentialLevel = actor.CredentialLevel,
            ReputationBucket = actor.ReputationBucket,
            AccountAgeBucket = actor.AccountAgeBucket,
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
            AnonymousCommentPolicySnapshot? policySnapshot = anonymousCommentPolicyService?.Current;
            await antiSpamModerationService.ScoreCommentAsync(
                new AntiSpamCommentModerationContext(
                    comment.Id,
                    comment.ArticleId,
                    actor.UserId,
                    actor.AuthorMode,
                    actor.DisplayLanguage,
                    actor.ModerationSubjectHash,
                    actor.AnonymousNullifierHash,
                    actor.AnonymousScope,
                    actor.CredentialLevel,
                    actor.ReputationBucket,
                    actor.AccountAgeBucket,
                    policySnapshot?.AnonymousCommentsEnabled,
                    policySnapshot?.ZkAnonymousEnabled,
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
                UserId: actor.UserId,
                PublicArticleChanged: false,
                UserCommentsChanged: true));

        logger.LogInformation("评论已进入审核队列 | Article: {ArticleId} | CommentId: {CommentId} | Root: {RootId} | Parent: {ParentId}",
            dto.ArticleId,
            comment.Id,
            comment.RootId ?? comment.Id,
            comment.ParentId);

        return true;
    }

    public Task<bool> CreateCommentV2Async(int userId, CommentCreateV2RequestCoreModel request, RegionModerationDecision? regionDecision = null)
        => CreateCommentAsync(userId, new CommentDto
        {
            ArticleId = request.ArticleId,
            Content = request.Content,
            ParentId = request.ParentId,
            RootId = request.RootId,
            ReplyToCommentId = request.ReplyToCommentId,
            ReplyToUserId = request.ReplyToUserId,
            AuthorMode = request.AuthorMode,
            PublicSendExplicitlySelected = request.PublicSendExplicitlySelected,
            AnonymousScope = request.AnonymousScope,
            DisplayLanguage = request.DisplayLanguage,
            ProofToken = request.ProofToken,
            ZkProof = request.ZkProof,
            RegionDecision = regionDecision
        });

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
        List<ThreadRootRow> roots = await QueryThreadRootsAsync(articleId, request, normalizedViewerRegion);

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
        bool rootExists = await QueryVisibleThreadRootExistsAsync(articleId, rootId, normalizedViewerRegion);
        if (!rootExists)
        {
            return new CursorResponse<CommentReplyItemDto> { Data = [], NextCursor = null, HasMore = false };
        }

        List<ReplyRow> rows = await QueryThreadRepliesAsync(articleId, rootId, request, normalizedViewerRegion);

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

        if (isAdmin && row.UserId.HasValue && currentUserId != row.UserId.Value)
        {
            string commentSnippet = row.Content.Length > 20 ? row.Content[..20] : row.Content;
            _ = NotifyDeletionAsync(row.UserId.Value, row.ArticleTitle ?? "未知文章", commentSnippet, reason);
        }

        logger.LogInformation("评论软删除成功 | CommentId: {CommentId} | Article: {ArticleId} | Root: {RootId} | Parent: {ParentId}",
            id,
            row.ArticleId,
            row.RootId ?? id,
            row.ParentId);

        return true;
    }

    private async Task<List<ThreadRootRow>> QueryThreadRootsAsync(
        int articleId,
        CursorPageRequest<long> request,
        string normalizedViewerRegion)
    {
        var sql = new StringBuilder("""
SELECT
    c.id AS "Id",
    c.article_id AS "ArticleId",
    c.content AS "Content",
    c.create_time AS "CreateTime",
    COALESCE(NULLIF(c.anonymous_display_name, ''), NULLIF(c.public_handle, ''), u.username, '') AS "UserName",
    c.depth AS "Depth",
    c.is_deleted AS "IsDeleted"
FROM comment c
LEFT JOIN sys_user u ON c.user_id = u.id
WHERE c.article_id = @ArticleId
  AND c.parent_id IS NULL
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
""");
        List<SugarParameter> parameters = BuildPublicCommentReadParameters(articleId, normalizedViewerRegion);
        parameters.Add(new SugarParameter("@Limit", request.Limit + 1));
        if (request.Cursor.HasValue)
        {
            sql.AppendLine("  AND c.id < @Cursor");
            parameters.Add(new SugarParameter("@Cursor", request.Cursor.Value));
        }

        sql.AppendLine("ORDER BY c.id DESC");
        sql.AppendLine("LIMIT @Limit;");

        var rows = new List<ThreadRootRow>(request.Limit + 1);
        using (var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(sql.ToString(), parameters))
        {
            int fId = reader.GetOrdinal("Id");
            int fArticleId = reader.GetOrdinal("ArticleId");
            int fContent = reader.GetOrdinal("Content");
            int fCreateTime = reader.GetOrdinal("CreateTime");
            int fUserName = reader.GetOrdinal("UserName");
            int fDepth = reader.GetOrdinal("Depth");
            int fIsDeleted = reader.GetOrdinal("IsDeleted");

            while (await reader.ReadAsync())
            {
                rows.Add(new ThreadRootRow
                {
                    Id = reader.GetInt64(fId),
                    ArticleId = reader.GetInt32(fArticleId),
                    Content = reader.IsDBNull(fContent) ? string.Empty : reader.GetString(fContent),
                    CreateTime = reader.GetDateTime(fCreateTime),
                    UserName = reader.IsDBNull(fUserName) ? string.Empty : reader.GetString(fUserName),
                    Depth = reader.IsDBNull(fDepth) ? 1 : reader.GetInt32(fDepth),
                    IsDeleted = reader.GetBoolean(fIsDeleted)
                });
            }
        }

        return rows;
    }

    private async Task<bool> QueryVisibleThreadRootExistsAsync(
        int articleId,
        long rootId,
        string normalizedViewerRegion)
    {
        const string sql = """
SELECT 1
FROM comment c
WHERE c.id = @RootId
  AND c.article_id = @ArticleId
  AND c.parent_id IS NULL
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
LIMIT 1;
""";
        List<SugarParameter> parameters = BuildPublicCommentReadParameters(articleId, normalizedViewerRegion);
        parameters.Add(new SugarParameter("@RootId", rootId));

        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(sql, parameters);
        return await reader.ReadAsync();
    }

    private async Task<List<ReplyRow>> QueryThreadRepliesAsync(
        int articleId,
        long rootId,
        CursorPageRequest<long> request,
        string normalizedViewerRegion)
    {
        var sql = new StringBuilder("""
SELECT
    c.id AS "Id",
    c.parent_id AS "ParentId",
    c.root_id AS "RootId",
    c.reply_to_user_id AS "ReplyToUserId",
    c.reply_to_comment_id AS "ReplyToCommentId",
    c.content AS "Content",
    c.create_time AS "CreateTime",
    COALESCE(NULLIF(c.anonymous_display_name, ''), NULLIF(c.public_handle, ''), u.username, '') AS "UserName",
    COALESCE(NULLIF(pc.anonymous_display_name, ''), NULLIF(pc.public_handle, ''), ru.username, '') AS "ReplyToUserName",
    c.depth AS "Depth",
    c.is_deleted AS "IsDeleted"
FROM comment c
LEFT JOIN sys_user u ON c.user_id = u.id
LEFT JOIN comment pc ON c.reply_to_comment_id = pc.id
LEFT JOIN sys_user ru ON pc.user_id = ru.id
WHERE c.article_id = @ArticleId
  AND c.root_id = @RootId
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
""");
        List<SugarParameter> parameters = BuildPublicCommentReadParameters(articleId, normalizedViewerRegion);
        parameters.Add(new SugarParameter("@RootId", rootId));
        parameters.Add(new SugarParameter("@Limit", request.Limit + 1));
        if (request.Cursor.HasValue)
        {
            sql.AppendLine("  AND c.id > @Cursor");
            parameters.Add(new SugarParameter("@Cursor", request.Cursor.Value));
        }

        sql.AppendLine("ORDER BY c.id");
        sql.AppendLine("LIMIT @Limit;");

        var rows = new List<ReplyRow>(request.Limit + 1);
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
                    Depth = reader.IsDBNull(fDepth) ? 2 : reader.GetInt32(fDepth),
                    IsDeleted = reader.GetBoolean(fIsDeleted)
                });
            }
        }

        return rows;
    }

    private static List<SugarParameter> BuildPublicCommentReadParameters(
        int articleId,
        string normalizedViewerRegion)
        => new(4)
        {
            new("@ArticleId", articleId),
            new("@Approved", (int)CommentModerationStatus.Approved),
            new("@BlockedToken", RegionLegalModerationService.SerializeRegions([normalizedViewerRegion])),
            new("@ConservativeUnknownViewer", normalizedViewerRegion == RegionCodes.Unknown)
        };

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
                UserName = c.AnonymousDisplayName ?? c.PublicHandle ?? u.Username,
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
        COALESCE(NULLIF(c.anonymous_display_name, ''), NULLIF(c.public_handle, ''), u.username, '') AS user_name,
        COALESCE(NULLIF(pc.anonymous_display_name, ''), NULLIF(pc.public_handle, ''), ru.username, '') AS reply_to_user_name,
        c.depth,
        c.is_deleted,
        ROW_NUMBER() OVER (PARTITION BY c.root_id ORDER BY c.id) AS rn
    FROM comment c
    LEFT JOIN sys_user u ON c.user_id = u.id
    LEFT JOIN comment pc ON c.reply_to_comment_id = pc.id
    LEFT JOIN sys_user ru ON pc.user_id = ru.id
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
