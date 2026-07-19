using System.Data.Common;
using System.Text;

using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Shared.Contracts.Outputs;

using SqlSugar;

namespace FsusBlog.Server.Services;

public interface ICommentQueryService
{
    Task<CursorResponse<CommentTreeRootDto>> GetTreeRootsAsync(
        int articleId,
        CursorPageRequest<long> request,
        int previewLimit = 3,
        string viewerRegion = "GLOBAL");

    Task<CommentChildCursorDto> GetChildrenAsync(
        int articleId,
        long parentId,
        CursorPageRequest<long> request,
        string viewerRegion = "GLOBAL");

    Task<CommentPermalinkContextDto> GetPermalinkContextAsync(
        int articleId,
        long commentId,
        int siblingWindow = 6,
        string viewerRegion = "GLOBAL");

    Task<CursorResponse<CommentThreadItemDto>> GetThreadsAsync(
        int articleId,
        CursorPageRequest<long> request,
        int previewLimit = 3,
        string viewerRegion = "GLOBAL");

    Task<CursorResponse<CommentReplyItemDto>> GetRepliesAsync(
        int articleId,
        long rootId,
        CursorPageRequest<long> request,
        string viewerRegion = "GLOBAL");

    Task<CursorResponse<CommentQueryResultDto>> GetLegacyCommentsAsync(
        int articleId,
        CursorPageRequest<long> request);

    Task<CursorResponse<UserCommentResponse>> GetAttributableAsync(
        int userId,
        CursorPageRequest<long> request,
        int? articleId = null);
}

public sealed class CommentQueryService(
    ISqlSugarClient db,
    IRegionLegalModerationService regionLegalModerationService) : ICommentQueryService
{
    private const int DefaultReplyPreviewLimit = 3;
    private const int MaxReplyPreviewRootIds = 50;
    private const string DeletedPlaceholder = "该回复已删除";
    private const string DeletedAuthorPlaceholder = "已删除评论";
    private const string PublicVisibleChainCte = """
WITH RECURSIVE directly_visible AS (
    SELECT c.id, c.parent_id, c.root_id
    FROM comment c
    INNER JOIN article a
      ON a.id = c.article_id
     AND a.isdeleted = false
     AND a.status = @PublishedStatus
     AND a.current_publication_id IS NOT NULL
    INNER JOIN article_publication publication
      ON publication.id = a.current_publication_id
     AND publication.article_id = a.id
     AND publication.published_at <= @Now
    WHERE c.article_id = @ArticleId
      AND c.moderation_status = @Approved
      AND c.is_deleted = false
      AND NOT EXISTS (
          SELECT 1
          FROM comment_blocked_region br
          WHERE br.comment_id = c.id
            AND (
                @ConservativeUnknownViewer = true
                OR br.region_code = @ViewerRegion
            )
      )
),
visible_chain AS (
    SELECT id, parent_id, root_id
    FROM directly_visible
    UNION
    SELECT parent.id, parent.parent_id, parent.root_id
    FROM comment parent
    INNER JOIN visible_chain child ON child.parent_id = parent.id
    WHERE parent.article_id = @ArticleId
)

""";
    private static readonly Int64CursorCodec s_cursorCodec = Int64CursorCodec.Instance;

    public async Task<CursorResponse<CommentTreeRootDto>> GetTreeRootsAsync(
        int articleId,
        CursorPageRequest<long> request,
        int previewLimit = DefaultReplyPreviewLimit,
        string viewerRegion = RegionCodes.Global)
    {
        if (articleId <= 0)
        {
            return new CursorResponse<CommentTreeRootDto> { Data = [], NextCursor = null, HasMore = false };
        }

        string normalizedViewerRegion = regionLegalModerationService.NormalizeRegion(viewerRegion);
        List<ThreadRootRow> roots = await QueryThreadRootsAsync(articleId, request, normalizedViewerRegion);
        int rootWindowCount = CursorPagination.WindowCount(roots, request.Limit);
        long[] rootIds = roots.Take(rootWindowCount).Select(static root => root.Id).ToArray();
        DirectChildProjection children = await QueryDirectChildProjectionAsync(
            articleId,
            rootIds,
            Math.Clamp(previewLimit, 1, 10),
            normalizedViewerRegion);

        return CursorPagination.SliceMapToResponse(roots, request.Limit, root => root.Id, root =>
        {
            List<CommentTreeNodeDto> preview = children.PreviewMap.GetValueOrDefault(root.Id, []);
            int childCount = children.CountMap.GetValueOrDefault(root.Id, 0);
            CommentTreeNodeDto node = MapTreeRoot(root, childCount, childCount > preview.Count);
            return new CommentTreeRootDto(node, preview);
        }, s_cursorCodec);
    }

    public async Task<CommentChildCursorDto> GetChildrenAsync(
        int articleId,
        long parentId,
        CursorPageRequest<long> request,
        string viewerRegion = RegionCodes.Global)
    {
        if (articleId <= 0 || parentId <= 0)
        {
            return new CommentChildCursorDto(
                parentId.ToString(),
                "0",
                new CursorResponse<CommentTreeNodeDto> { Data = [], NextCursor = null, HasMore = false });
        }

        string normalizedViewerRegion = regionLegalModerationService.NormalizeRegion(viewerRegion);
        VisibleParentContext? parent = await QueryVisibleParentContextAsync(articleId, parentId, normalizedViewerRegion);
        if (parent is null)
        {
            return new CommentChildCursorDto(
                parentId.ToString(),
                "0",
                new CursorResponse<CommentTreeNodeDto> { Data = [], NextCursor = null, HasMore = false });
        }

        List<ReplyRow> rows = await QueryDirectChildrenAsync(articleId, parentId, request, normalizedViewerRegion);
        await HydrateChildCountsAsync(articleId, rows, normalizedViewerRegion);
        CursorResponse<CommentTreeNodeDto> cursor = CursorPagination.SliceMapToResponse(
            rows,
            request.Limit,
            row => row.Id,
            MapTreeNode,
            s_cursorCodec);
        return new CommentChildCursorDto(parent.ParentId.ToString(), parent.RootId.ToString(), cursor);
    }

    public async Task<CommentPermalinkContextDto> GetPermalinkContextAsync(
        int articleId,
        long commentId,
        int siblingWindow = 6,
        string viewerRegion = RegionCodes.Global)
    {
        if (articleId <= 0 || commentId <= 0)
        {
            return UnavailablePermalink();
        }

        string normalizedViewerRegion = regionLegalModerationService.NormalizeRegion(viewerRegion);
        List<ReplyRow> path = await QueryAncestorPathAsync(articleId, commentId, normalizedViewerRegion);
        if (!IsValidAncestorPath(path, commentId))
        {
            return UnavailablePermalink();
        }

        ReplyRow targetRow = path[^1];
        int normalizedWindow = Math.Clamp(siblingWindow, 2, 20);
        SiblingWindowResult siblingResult = await QuerySiblingWindowAsync(
            articleId,
            targetRow.ParentId,
            targetRow.Id,
            normalizedWindow,
            normalizedViewerRegion);
        await HydrateChildCountsAsync(articleId, path, normalizedViewerRegion);
        await HydrateChildCountsAsync(articleId, siblingResult.Rows, normalizedViewerRegion);
        List<CommentTreeNodeDto> mappedPath = path.Select(MapTreeNode).ToList();
        CommentTreeNodeDto target = mappedPath[^1];
        mappedPath.RemoveAt(mappedPath.Count - 1);

        return new CommentPermalinkContextDto(
            "found",
            target.Id,
            target.RootId,
            mappedPath,
            target,
            siblingResult.Rows.Where(row => row.Id != targetRow.Id).Select(MapTreeNode).ToList(),
            siblingResult.HasPrevious,
            siblingResult.HasNext);
    }

    public async Task<CursorResponse<CommentThreadItemDto>> GetThreadsAsync(
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

        ThreadReplyProjection replyProjection = await QueryThreadRepliesProjectionAsync(
            articleId,
            rootIds,
            normalizedPreviewLimit,
            normalizedViewerRegion);

        return CursorPagination.SliceMapToResponse(roots, request.Limit, root => root.Id, root =>
        {
            long rootId = root.Id;
            List<CommentReplyPreviewItemDto> previewReplies = replyProjection.PreviewMap.GetValueOrDefault(rootId, []);
            int replyCount = replyProjection.CountMap.GetValueOrDefault(rootId, 0);
            bool hasMoreReplies = replyCount > previewReplies.Count;

            return new CommentThreadItemDto(
                root.Id.ToString(),
                ToDisplayContent(root.IsDeleted, root.Content),
                root.CreateTime,
                root.IsDeleted
                    ? BuildDeletedAuthorView()
                    : BuildAuthorView(root.AuthorMode, root.AuthorDisplayName, root.AnonymousDisplayLanguage, root.AnonymousScope),
                rootId.ToString(),
                root.IsDeleted,
                replyCount,
                hasMoreReplies,
                previewReplies);
        }, s_cursorCodec);
    }

    public async Task<CursorResponse<CommentReplyItemDto>> GetRepliesAsync(
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

        return CursorPagination.SliceMapToResponse(rows, request.Limit, row => row.Id, MapReplyRow, s_cursorCodec);
    }

    public async Task<CursorResponse<CommentQueryResultDto>> GetLegacyCommentsAsync(int articleId, CursorPageRequest<long> request)
    {
        CursorResponse<CommentThreadItemDto> threads = await GetThreadsAsync(articleId, request, 1);
        var data = new List<CommentQueryResultDto>(threads.Data.Count);
        foreach (CommentThreadItemDto item in threads.Data)
        {
            data.Add(new CommentQueryResultDto(
                long.TryParse(item.Id, out long id) ? id : 0,
                item.Content,
                item.CreateTime,
                item.Author));
        }

        return new CursorResponse<CommentQueryResultDto>
        {
            Data = data,
            NextCursor = threads.NextCursor,
            HasMore = threads.HasMore
        };
    }

    public async Task<CursorResponse<UserCommentResponse>> GetAttributableAsync(
        int userId,
        CursorPageRequest<long> request,
        int? articleId = null)
    {
        if (userId <= 0)
        {
            return new CursorResponse<UserCommentResponse> { Data = [], NextCursor = null, HasMore = false };
        }

        int scopedArticleId = articleId.GetValueOrDefault();

        var rows = await db.Queryable<Comment, Article, Comment, CommentRegionCompliance>((c, a, pc, crc) => new object[]
            {
                JoinType.Left, c.ArticleId == a.Id,
                JoinType.Left, c.ReplyToCommentId == pc.Id,
                JoinType.Left, c.Id == crc.CommentId
            })
            .Where((c, a, pc, crc) => c.UserId == userId
                && c.AuthorMode == CommentAuthorModes.Public
                && !a.IsDeleted)
            .WhereIF(scopedArticleId > 0, (c, a, pc, crc) => c.ArticleId == scopedArticleId)
            .WhereIF(request.Cursor.HasValue, (c, a, pc, crc) => c.Id < request.Cursor!.Value)
            .OrderByDescending((c, a, pc, crc) => c.Id)
            .Take(request.Limit + 1)
            .Select((c, a, pc, crc) => new UserCommentRow
            {
                Id = c.Id,
                Content = c.Content,
                CreateTime = c.CreateTime,
                IsDeleted = c.IsDeleted,
                ModerationStatus = c.ModerationStatus,
                BlockedRegions = crc.BlockedRegions,
                RootId = c.RootId,
                ArticleId = a.Id,
                ArticleTitle = a.Title,
                ReplyToCommentId = c.ReplyToCommentId,
                AuthorMode = c.AuthorMode,
                PublicHandle = c.PublicHandle,
                AnonymousDisplayName = c.AnonymousDisplayName,
                AnonymousDisplayLanguage = c.AnonymousDisplayLanguage,
                AnonymousScope = c.AnonymousScope,
                ReplyToAuthorMode = pc.AuthorMode,
                ReplyToPublicHandle = pc.PublicHandle,
                ReplyToAnonymousDisplayName = pc.AnonymousDisplayName,
                ReplyToAnonymousDisplayLanguage = pc.AnonymousDisplayLanguage
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
            Author = BuildAuthorView(item.AuthorMode, item.PublicHandle, item.AnonymousDisplayLanguage, item.AnonymousScope),
            ReplyToAuthor = item.ReplyToCommentId.HasValue
                ? BuildAuthorView(item.ReplyToAuthorMode, item.ReplyToPublicHandle, item.ReplyToAnonymousDisplayLanguage, null)
                : null,
            ModerationStatus = (int)item.ModerationStatus,
            IsDeleted = item.IsDeleted,
            HasBlockedRegions = !string.IsNullOrWhiteSpace(item.BlockedRegions)
        }), s_cursorCodec);
    }


    private async Task<List<ThreadRootRow>> QueryThreadRootsAsync(
        int articleId,
        CursorPageRequest<long> request,
        string normalizedViewerRegion)
    {
        var sql = new StringBuilder(PublicVisibleChainCte);
        sql.AppendLine("""
SELECT
    c.id AS "Id",
    c.article_id AS "ArticleId",
    c.content AS "Content",
    c.create_time AS "CreateTime",
    CASE
        WHEN c.author_mode = 'public' THEN COALESCE(NULLIF(c.public_handle, ''), '未署名用户')
        WHEN lower(COALESCE(c.anonymous_display_language, '')) = 'en' THEN COALESCE(NULLIF(c.anonymous_display_name, ''), 'Anonymous User')
        ELSE COALESCE(NULLIF(c.anonymous_display_name, ''), '匿名用户')
    END AS "AuthorDisplayName",
    c.author_mode AS "AuthorMode",
    c.anonymous_display_language AS "AnonymousDisplayLanguage",
    c.anonymous_scope AS "AnonymousScope",
    c.depth AS "Depth",
    (directly_visible.id IS NULL) AS "IsDeleted"
FROM comment c
INNER JOIN visible_chain ON visible_chain.id = c.id
LEFT JOIN directly_visible ON directly_visible.id = c.id
WHERE c.article_id = @ArticleId
  AND c.parent_id IS NULL
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
            int fAuthorDisplayName = reader.GetOrdinal("AuthorDisplayName");
            int fAuthorMode = reader.GetOrdinal("AuthorMode");
            int fAnonymousDisplayLanguage = reader.GetOrdinal("AnonymousDisplayLanguage");
            int fAnonymousScope = reader.GetOrdinal("AnonymousScope");
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
                    AuthorDisplayName = reader.IsDBNull(fAuthorDisplayName) ? string.Empty : reader.GetString(fAuthorDisplayName),
                    AuthorMode = reader.IsDBNull(fAuthorMode) ? null : reader.GetString(fAuthorMode),
                    AnonymousDisplayLanguage = reader.IsDBNull(fAnonymousDisplayLanguage) ? null : reader.GetString(fAnonymousDisplayLanguage),
                    AnonymousScope = reader.IsDBNull(fAnonymousScope) ? null : reader.GetString(fAnonymousScope),
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
        const string Sql = PublicVisibleChainCte + """
SELECT 1
FROM comment c
INNER JOIN visible_chain ON visible_chain.id = c.id
WHERE c.id = @RootId
  AND c.article_id = @ArticleId
  AND c.parent_id IS NULL
LIMIT 1;
""";
        List<SugarParameter> parameters = BuildPublicCommentReadParameters(articleId, normalizedViewerRegion);
        parameters.Add(new SugarParameter("@RootId", rootId));

        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(Sql, parameters);
        return await reader.ReadAsync();
    }

    private async Task<List<ReplyRow>> QueryThreadRepliesAsync(
        int articleId,
        long rootId,
        CursorPageRequest<long> request,
        string normalizedViewerRegion)
    {
        var sql = new StringBuilder(PublicVisibleChainCte);
        sql.AppendLine("""
SELECT
    c.id AS "Id",
    c.parent_id AS "ParentId",
    c.root_id AS "RootId",
    c.reply_to_comment_id AS "ReplyToCommentId",
    c.content AS "Content",
    c.create_time AS "CreateTime",
    CASE
        WHEN c.author_mode = 'public' THEN COALESCE(NULLIF(c.public_handle, ''), '未署名用户')
        WHEN lower(COALESCE(c.anonymous_display_language, '')) = 'en' THEN COALESCE(NULLIF(c.anonymous_display_name, ''), 'Anonymous User')
        ELSE COALESCE(NULLIF(c.anonymous_display_name, ''), '匿名用户')
    END AS "AuthorDisplayName",
    c.author_mode AS "AuthorMode",
    c.anonymous_display_language AS "AnonymousDisplayLanguage",
    c.anonymous_scope AS "AnonymousScope",
    CASE
        WHEN pc.id IS NULL THEN NULL
        WHEN pc.author_mode = 'public' THEN COALESCE(NULLIF(pc.public_handle, ''), '未署名用户')
        WHEN lower(COALESCE(pc.anonymous_display_language, '')) = 'en' THEN COALESCE(NULLIF(pc.anonymous_display_name, ''), 'Anonymous User')
        ELSE COALESCE(NULLIF(pc.anonymous_display_name, ''), '匿名用户')
    END AS "ReplyToDisplayName",
    pc.author_mode AS "ReplyToAuthorMode",
    pc.anonymous_display_language AS "ReplyToAnonymousDisplayLanguage",
    pc.anonymous_scope AS "ReplyToAnonymousScope",
    (pc.id IS NOT NULL AND reply_target_visible.id IS NULL) AS "ReplyTargetIsDeleted",
    c.depth AS "Depth",
    (directly_visible.id IS NULL) AS "IsDeleted"
FROM comment c
INNER JOIN visible_chain ON visible_chain.id = c.id
LEFT JOIN directly_visible ON directly_visible.id = c.id
LEFT JOIN comment pc ON c.reply_to_comment_id = pc.id
LEFT JOIN directly_visible reply_target_visible ON reply_target_visible.id = pc.id
WHERE c.article_id = @ArticleId
  AND c.root_id = @RootId
  AND c.parent_id IS NOT NULL
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
            int fReplyToCommentId = reader.GetOrdinal("ReplyToCommentId");
            int fContent = reader.GetOrdinal("Content");
            int fCreateTime = reader.GetOrdinal("CreateTime");
            int fAuthorDisplayName = reader.GetOrdinal("AuthorDisplayName");
            int fAuthorMode = reader.GetOrdinal("AuthorMode");
            int fAnonymousDisplayLanguage = reader.GetOrdinal("AnonymousDisplayLanguage");
            int fAnonymousScope = reader.GetOrdinal("AnonymousScope");
            int fReplyToDisplayName = reader.GetOrdinal("ReplyToDisplayName");
            int fReplyToAuthorMode = reader.GetOrdinal("ReplyToAuthorMode");
            int fReplyToAnonymousDisplayLanguage = reader.GetOrdinal("ReplyToAnonymousDisplayLanguage");
            int fReplyToAnonymousScope = reader.GetOrdinal("ReplyToAnonymousScope");
            int fReplyTargetIsDeleted = reader.GetOrdinal("ReplyTargetIsDeleted");
            int fDepth = reader.GetOrdinal("Depth");
            int fIsDeleted = reader.GetOrdinal("IsDeleted");

            while (await reader.ReadAsync())
            {
                rows.Add(new ReplyRow
                {
                    Id = reader.GetInt64(fId),
                    ParentId = reader.IsDBNull(fParentId) ? null : reader.GetInt64(fParentId),
                    RootId = reader.IsDBNull(fRootId) ? null : reader.GetInt64(fRootId),
                    ReplyToCommentId = reader.IsDBNull(fReplyToCommentId) ? null : reader.GetInt64(fReplyToCommentId),
                    Content = reader.IsDBNull(fContent) ? string.Empty : reader.GetString(fContent),
                    CreateTime = reader.GetDateTime(fCreateTime),
                    AuthorDisplayName = reader.IsDBNull(fAuthorDisplayName) ? string.Empty : reader.GetString(fAuthorDisplayName),
                    AuthorMode = reader.IsDBNull(fAuthorMode) ? null : reader.GetString(fAuthorMode),
                    AnonymousDisplayLanguage = reader.IsDBNull(fAnonymousDisplayLanguage) ? null : reader.GetString(fAnonymousDisplayLanguage),
                    AnonymousScope = reader.IsDBNull(fAnonymousScope) ? null : reader.GetString(fAnonymousScope),
                    ReplyToDisplayName = reader.IsDBNull(fReplyToDisplayName) ? null : reader.GetString(fReplyToDisplayName),
                    ReplyToAuthorMode = reader.IsDBNull(fReplyToAuthorMode) ? null : reader.GetString(fReplyToAuthorMode),
                    ReplyToAnonymousDisplayLanguage = reader.IsDBNull(fReplyToAnonymousDisplayLanguage) ? null : reader.GetString(fReplyToAnonymousDisplayLanguage),
                    ReplyToAnonymousScope = reader.IsDBNull(fReplyToAnonymousScope) ? null : reader.GetString(fReplyToAnonymousScope),
                    ReplyTargetIsDeleted = reader.GetBoolean(fReplyTargetIsDeleted),
                    Depth = reader.IsDBNull(fDepth) ? 2 : reader.GetInt32(fDepth),
                    IsDeleted = reader.GetBoolean(fIsDeleted)
                });
            }
        }

        return rows;
    }

    private async Task<VisibleParentContext?> QueryVisibleParentContextAsync(
        int articleId,
        long parentId,
        string normalizedViewerRegion)
    {
        const string Sql = PublicVisibleChainCte + """
SELECT c.id AS "Id", COALESCE(c.root_id, c.id) AS "RootId"
FROM comment c
INNER JOIN visible_chain ON visible_chain.id = c.id
WHERE c.article_id = @ArticleId
  AND c.id = @ParentId
LIMIT 1;
""";
        List<SugarParameter> parameters = BuildPublicCommentReadParameters(articleId, normalizedViewerRegion);
        parameters.Add(new SugarParameter("@ParentId", parentId));
        await using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(Sql, parameters);
        return await reader.ReadAsync()
            ? new VisibleParentContext(reader.GetInt64(reader.GetOrdinal("Id")), reader.GetInt64(reader.GetOrdinal("RootId")))
            : null;
    }

    private async Task<List<ReplyRow>> QueryDirectChildrenAsync(
        int articleId,
        long parentId,
        CursorPageRequest<long> request,
        string normalizedViewerRegion)
    {
        var sql = new StringBuilder(PublicVisibleChainCte);
        sql.AppendLine(BuildTreeNodeSelectSql("c.parent_id = @ParentId"));
        List<SugarParameter> parameters = BuildPublicCommentReadParameters(articleId, normalizedViewerRegion);
        parameters.Add(new SugarParameter("@ParentId", parentId));
        parameters.Add(new SugarParameter("@Limit", request.Limit + 1));
        if (request.Cursor.HasValue)
        {
            sql.AppendLine("  AND c.id > @Cursor");
            parameters.Add(new SugarParameter("@Cursor", request.Cursor.Value));
        }
        sql.AppendLine("ORDER BY c.id");
        sql.AppendLine("LIMIT @Limit;");
        return await ReadTreeRowsAsync(sql.ToString(), parameters);
    }

    private async Task<DirectChildProjection> QueryDirectChildProjectionAsync(
        int articleId,
        long[] parentIds,
        int previewLimit,
        string normalizedViewerRegion)
    {
        if (parentIds.Length == 0)
        {
            return new DirectChildProjection([], []);
        }

        var sql = new StringBuilder(PublicVisibleChainCte);
        sql.AppendLine("SELECT * FROM (");
        sql.AppendLine(BuildTreeNodeSelectSql("c.parent_id IN (" + string.Join(',', parentIds.Select((_, index) => $"@ParentId{index}")) + ")", includeWindowColumns: true));
        sql.AppendLine(") child_window WHERE child_window.\"RowNumber\" <= @PreviewLimit ORDER BY child_window.\"ParentId\", child_window.\"Id\";");
        List<SugarParameter> parameters = BuildPublicCommentReadParameters(articleId, normalizedViewerRegion);
        parameters.Add(new SugarParameter("@PreviewLimit", previewLimit));
        for (int i = 0; i < parentIds.Length; i++)
        {
            parameters.Add(new SugarParameter($"@ParentId{i}", parentIds[i]));
        }

        List<ReplyRow> rows = await ReadTreeRowsAsync(sql.ToString(), parameters, hasSiblingCount: true);
        await HydrateChildCountsAsync(articleId, rows, normalizedViewerRegion);
        var previewMap = new Dictionary<long, List<CommentTreeNodeDto>>(parentIds.Length);
        var countMap = new Dictionary<long, int>(parentIds.Length);
        foreach (ReplyRow row in rows)
        {
            long parentId = row.ParentId ?? 0;
            if (!previewMap.TryGetValue(parentId, out List<CommentTreeNodeDto>? preview))
            {
                preview = [];
                previewMap[parentId] = preview;
            }
            preview.Add(MapTreeNode(row));
            countMap[parentId] = row.SiblingCount;
        }
        return new DirectChildProjection(previewMap, countMap);
    }

    private async Task<List<ReplyRow>> QueryAncestorPathAsync(
        int articleId,
        long commentId,
        string normalizedViewerRegion)
    {
        var sql = new StringBuilder(PublicVisibleChainCte);
        sql.AppendLine("""
, ancestor_path AS (
    SELECT c.id, c.parent_id, ARRAY[c.id]::bigint[] AS visited
    FROM comment c
    INNER JOIN directly_visible ON directly_visible.id = c.id
    WHERE c.article_id = @ArticleId AND c.id = @CommentId
    UNION ALL
    SELECT parent.id, parent.parent_id, child.visited || parent.id
    FROM comment parent
    INNER JOIN ancestor_path child ON child.parent_id = parent.id
    INNER JOIN visible_chain ON visible_chain.id = parent.id
    WHERE parent.article_id = @ArticleId
      AND NOT parent.id = ANY(child.visited)
      AND cardinality(child.visited) < 257
)
""");
        sql.AppendLine(BuildTreeNodeSelectSql("c.id IN (SELECT id FROM ancestor_path)"));
        sql.AppendLine("ORDER BY c.depth, c.id;");
        List<SugarParameter> parameters = BuildPublicCommentReadParameters(articleId, normalizedViewerRegion);
        parameters.Add(new SugarParameter("@CommentId", commentId));
        return await ReadTreeRowsAsync(sql.ToString(), parameters);
    }

    private async Task<SiblingWindowResult> QuerySiblingWindowAsync(
        int articleId,
        long? parentId,
        long targetId,
        int window,
        string normalizedViewerRegion)
    {
        int halfWindow = Math.Max(1, window / 2);
        string parentPredicate = parentId.HasValue ? "c.parent_id = @ParentId" : "c.parent_id IS NULL";
        var sql = new StringBuilder(PublicVisibleChainCte);
        sql.AppendLine("SELECT * FROM (");
        sql.AppendLine(BuildTreeNodeSelectSql($"{parentPredicate} AND c.id < @TargetId"));
        sql.AppendLine("ORDER BY c.id DESC LIMIT @HalfWindow) previous_window");
        sql.AppendLine("UNION ALL");
        sql.AppendLine("SELECT * FROM (");
        sql.AppendLine(BuildTreeNodeSelectSql($"{parentPredicate} AND c.id >= @TargetId"));
        sql.AppendLine("ORDER BY c.id LIMIT @CurrentAndNextWindow) next_window");
        sql.AppendLine("ORDER BY \"Id\";");
        List<SugarParameter> parameters = BuildPublicCommentReadParameters(articleId, normalizedViewerRegion);
        parameters.Add(new SugarParameter("@TargetId", targetId));
        parameters.Add(new SugarParameter("@HalfWindow", halfWindow + 1));
        parameters.Add(new SugarParameter("@CurrentAndNextWindow", halfWindow + 2));
        if (parentId.HasValue)
        {
            parameters.Add(new SugarParameter("@ParentId", parentId.Value));
        }
        List<ReplyRow> rows = await ReadTreeRowsAsync(sql.ToString(), parameters);
        int previousCount = rows.Count(row => row.Id < targetId);
        int nextCount = rows.Count(row => row.Id > targetId);
        bool hasPrevious = previousCount > halfWindow;
        bool hasNext = nextCount > halfWindow;
        List<ReplyRow> bounded = rows
            .Where(row => row.Id == targetId)
            .Concat(rows.Where(row => row.Id < targetId).TakeLast(halfWindow))
            .Concat(rows.Where(row => row.Id > targetId).Take(halfWindow))
            .OrderBy(row => row.Id)
            .ToList();
        return new SiblingWindowResult(bounded, hasPrevious, hasNext);
    }

    private static string BuildTreeNodeSelectSql(string predicate, bool includeWindowColumns = false)
        => $$"""
SELECT
    c.id AS "Id",
    c.parent_id AS "ParentId",
    c.root_id AS "RootId",
    c.reply_to_comment_id AS "ReplyToCommentId",
    c.content AS "Content",
    c.create_time AS "CreateTime",
    CASE
        WHEN c.author_mode = 'public' THEN COALESCE(NULLIF(c.public_handle, ''), '未署名用户')
        WHEN lower(COALESCE(c.anonymous_display_language, '')) = 'en' THEN COALESCE(NULLIF(c.anonymous_display_name, ''), 'Anonymous User')
        ELSE COALESCE(NULLIF(c.anonymous_display_name, ''), '匿名用户')
    END AS "AuthorDisplayName",
    c.author_mode AS "AuthorMode",
    c.anonymous_display_language AS "AnonymousDisplayLanguage",
    c.anonymous_scope AS "AnonymousScope",
    CASE
        WHEN pc.id IS NULL THEN NULL
        WHEN pc.author_mode = 'public' THEN COALESCE(NULLIF(pc.public_handle, ''), '未署名用户')
        WHEN lower(COALESCE(pc.anonymous_display_language, '')) = 'en' THEN COALESCE(NULLIF(pc.anonymous_display_name, ''), 'Anonymous User')
        ELSE COALESCE(NULLIF(pc.anonymous_display_name, ''), '匿名用户')
    END AS "ReplyToDisplayName",
    pc.author_mode AS "ReplyToAuthorMode",
    pc.anonymous_display_language AS "ReplyToAnonymousDisplayLanguage",
    pc.anonymous_scope AS "ReplyToAnonymousScope",
    (pc.id IS NOT NULL AND reply_target_visible.id IS NULL) AS "ReplyTargetIsDeleted",
    c.depth AS "Depth",
    (directly_visible.id IS NULL) AS "IsDeleted"
    {{(includeWindowColumns ? ", COUNT(*) OVER (PARTITION BY c.parent_id) AS \"SiblingCount\", ROW_NUMBER() OVER (PARTITION BY c.parent_id ORDER BY c.id) AS \"RowNumber\"" : string.Empty)}}
FROM comment c
INNER JOIN visible_chain ON visible_chain.id = c.id
LEFT JOIN directly_visible ON directly_visible.id = c.id
LEFT JOIN comment pc ON c.reply_to_comment_id = pc.id
LEFT JOIN directly_visible reply_target_visible ON reply_target_visible.id = pc.id
WHERE c.article_id = @ArticleId
  AND {{predicate}}
""";

    private async Task<List<ReplyRow>> ReadTreeRowsAsync(
        string sql,
        List<SugarParameter> parameters,
        bool hasSiblingCount = false)
    {
        var rows = new List<ReplyRow>();
        await using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(sql, parameters);
        int fSiblingCount = hasSiblingCount ? reader.GetOrdinal("SiblingCount") : -1;
        while (await reader.ReadAsync())
        {
            long siblingCount = hasSiblingCount ? reader.GetInt64(fSiblingCount) : 0;
            rows.Add(new ReplyRow
            {
                Id = reader.GetInt64(reader.GetOrdinal("Id")),
                ParentId = reader.IsDBNull(reader.GetOrdinal("ParentId")) ? null : reader.GetInt64(reader.GetOrdinal("ParentId")),
                RootId = reader.IsDBNull(reader.GetOrdinal("RootId")) ? null : reader.GetInt64(reader.GetOrdinal("RootId")),
                ReplyToCommentId = reader.IsDBNull(reader.GetOrdinal("ReplyToCommentId")) ? null : reader.GetInt64(reader.GetOrdinal("ReplyToCommentId")),
                Content = reader.IsDBNull(reader.GetOrdinal("Content")) ? string.Empty : reader.GetString(reader.GetOrdinal("Content")),
                CreateTime = reader.GetDateTime(reader.GetOrdinal("CreateTime")),
                AuthorDisplayName = reader.IsDBNull(reader.GetOrdinal("AuthorDisplayName")) ? string.Empty : reader.GetString(reader.GetOrdinal("AuthorDisplayName")),
                AuthorMode = reader.IsDBNull(reader.GetOrdinal("AuthorMode")) ? null : reader.GetString(reader.GetOrdinal("AuthorMode")),
                AnonymousDisplayLanguage = reader.IsDBNull(reader.GetOrdinal("AnonymousDisplayLanguage")) ? null : reader.GetString(reader.GetOrdinal("AnonymousDisplayLanguage")),
                AnonymousScope = reader.IsDBNull(reader.GetOrdinal("AnonymousScope")) ? null : reader.GetString(reader.GetOrdinal("AnonymousScope")),
                ReplyToDisplayName = reader.IsDBNull(reader.GetOrdinal("ReplyToDisplayName")) ? null : reader.GetString(reader.GetOrdinal("ReplyToDisplayName")),
                ReplyToAuthorMode = reader.IsDBNull(reader.GetOrdinal("ReplyToAuthorMode")) ? null : reader.GetString(reader.GetOrdinal("ReplyToAuthorMode")),
                ReplyToAnonymousDisplayLanguage = reader.IsDBNull(reader.GetOrdinal("ReplyToAnonymousDisplayLanguage")) ? null : reader.GetString(reader.GetOrdinal("ReplyToAnonymousDisplayLanguage")),
                ReplyToAnonymousScope = reader.IsDBNull(reader.GetOrdinal("ReplyToAnonymousScope")) ? null : reader.GetString(reader.GetOrdinal("ReplyToAnonymousScope")),
                ReplyTargetIsDeleted = reader.GetBoolean(reader.GetOrdinal("ReplyTargetIsDeleted")),
                Depth = reader.GetInt32(reader.GetOrdinal("Depth")),
                IsDeleted = reader.GetBoolean(reader.GetOrdinal("IsDeleted")),
                SiblingCount = siblingCount > int.MaxValue ? int.MaxValue : (int)siblingCount
            });
        }
        return rows;
    }

    private async Task HydrateChildCountsAsync(
        int articleId,
        List<ReplyRow> rows,
        string normalizedViewerRegion)
    {
        long[] nodeIds = rows.Select(static row => row.Id).Distinct().ToArray();
        if (nodeIds.Length == 0)
        {
            return;
        }

        var sql = new StringBuilder(PublicVisibleChainCte);
        sql.Append("SELECT parent_id AS \"ParentId\", COUNT(*) AS \"ChildCount\" FROM visible_chain WHERE parent_id IN (");
        List<SugarParameter> parameters = BuildPublicCommentReadParameters(articleId, normalizedViewerRegion);
        for (int i = 0; i < nodeIds.Length; i++)
        {
            if (i > 0)
            {
                sql.Append(',');
            }
            string parameterName = $"@NodeId{i}";
            sql.Append(parameterName);
            parameters.Add(new SugarParameter(parameterName, nodeIds[i]));
        }
        sql.AppendLine(") GROUP BY parent_id;");

        var counts = new Dictionary<long, int>(nodeIds.Length);
        await using (var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(sql.ToString(), parameters))
        {
            while (await reader.ReadAsync())
            {
                long count = reader.GetInt64(reader.GetOrdinal("ChildCount"));
                counts[reader.GetInt64(reader.GetOrdinal("ParentId"))] = count > int.MaxValue ? int.MaxValue : (int)count;
            }
        }
        for (int i = 0; i < rows.Count; i++)
        {
            ReplyRow row = rows[i];
            rows[i] = row with
            {
                ChildCount = counts.GetValueOrDefault(row.Id, 0)
            };
        }
    }

    private static List<SugarParameter> BuildPublicCommentReadParameters(
        int articleId,
        string normalizedViewerRegion)
        => new(6)
        {
            new("@ArticleId", articleId),
            new("@Approved", (int)CommentModerationStatus.Approved),
            new("@PublishedStatus", (int)ArticleStatus.Published),
            new("@Now", DateTime.UtcNow),
            new("@ViewerRegion", normalizedViewerRegion),
            new("@ConservativeUnknownViewer", normalizedViewerRegion == RegionCodes.Unknown)
        };

    private async Task<ThreadReplyProjection> QueryThreadRepliesProjectionAsync(
        int articleId,
        long[] rootIds,
        int limit,
        string viewerRegion)
    {
        if (rootIds.Length == 0)
        {
            return new ThreadReplyProjection([], []);
        }

        var sql = new StringBuilder(PublicVisibleChainCte);
        sql.Append("""
SELECT
    x.id AS "Id",
    x.parent_id AS "ParentId",
    x.root_id AS "RootId",
    x.reply_to_comment_id AS "ReplyToCommentId",
    x.content AS "Content",
    x.create_time AS "CreateTime",
    x.author_display_name AS "AuthorDisplayName",
    x.author_mode AS "AuthorMode",
    x.anonymous_display_language AS "AnonymousDisplayLanguage",
    x.anonymous_scope AS "AnonymousScope",
    x.reply_to_display_name AS "ReplyToDisplayName",
    x.reply_to_author_mode AS "ReplyToAuthorMode",
    x.reply_to_anonymous_display_language AS "ReplyToAnonymousDisplayLanguage",
    x.reply_to_anonymous_scope AS "ReplyToAnonymousScope",
    x.reply_target_is_deleted AS "ReplyTargetIsDeleted",
    x.depth AS "Depth",
    x.is_deleted AS "IsDeleted",
    x.reply_count AS "ReplyCount"
FROM (
    SELECT
        c.id,
        c.parent_id,
        c.root_id,
        c.reply_to_comment_id,
        c.content,
        c.create_time,
        CASE
            WHEN c.author_mode = 'public' THEN COALESCE(NULLIF(c.public_handle, ''), '未署名用户')
            WHEN lower(COALESCE(c.anonymous_display_language, '')) = 'en' THEN COALESCE(NULLIF(c.anonymous_display_name, ''), 'Anonymous User')
            ELSE COALESCE(NULLIF(c.anonymous_display_name, ''), '匿名用户')
        END AS author_display_name,
        c.author_mode,
        c.anonymous_display_language,
        c.anonymous_scope,
        CASE
            WHEN pc.id IS NULL THEN NULL
            WHEN pc.author_mode = 'public' THEN COALESCE(NULLIF(pc.public_handle, ''), '未署名用户')
            WHEN lower(COALESCE(pc.anonymous_display_language, '')) = 'en' THEN COALESCE(NULLIF(pc.anonymous_display_name, ''), 'Anonymous User')
            ELSE COALESCE(NULLIF(pc.anonymous_display_name, ''), '匿名用户')
        END AS reply_to_display_name,
        pc.author_mode AS reply_to_author_mode,
        pc.anonymous_display_language AS reply_to_anonymous_display_language,
        pc.anonymous_scope AS reply_to_anonymous_scope,
        (pc.id IS NOT NULL AND reply_target_visible.id IS NULL) AS reply_target_is_deleted,
        c.depth,
        (directly_visible.id IS NULL) AS is_deleted,
        COUNT(*) OVER (PARTITION BY c.root_id) AS reply_count,
        ROW_NUMBER() OVER (PARTITION BY c.root_id ORDER BY c.id) AS rn
    FROM comment c
    INNER JOIN visible_chain ON visible_chain.id = c.id
    LEFT JOIN directly_visible ON directly_visible.id = c.id
    LEFT JOIN comment pc ON c.reply_to_comment_id = pc.id
    LEFT JOIN directly_visible reply_target_visible ON reply_target_visible.id = pc.id
    WHERE c.article_id = @ArticleId
      AND c.root_id IS NOT NULL
      AND c.root_id IN (
""");
        string normalizedViewerRegion = regionLegalModerationService.NormalizeRegion(viewerRegion);
        var parameters = new List<SugarParameter>(rootIds.Length + 7)
        {
            new("@ArticleId", articleId),
            new("@Approved", (int)CommentModerationStatus.Approved),
            new("@PublishedStatus", (int)ArticleStatus.Published),
            new("@Now", DateTime.UtcNow),
            new("@PreviewLimit", limit),
            new("@ViewerRegion", normalizedViewerRegion),
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
) x
WHERE x.rn <= @PreviewLimit
ORDER BY x.root_id, x.id;
""");

        var rows = new List<ReplyRow>(Math.Min(rootIds.Length, MaxReplyPreviewRootIds) * limit);
        using (var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(sql.ToString(), parameters))
        {
            int fId = reader.GetOrdinal("Id");
            int fParentId = reader.GetOrdinal("ParentId");
            int fRootId = reader.GetOrdinal("RootId");
            int fReplyToCommentId = reader.GetOrdinal("ReplyToCommentId");
            int fContent = reader.GetOrdinal("Content");
            int fCreateTime = reader.GetOrdinal("CreateTime");
            int fAuthorDisplayName = reader.GetOrdinal("AuthorDisplayName");
            int fAuthorMode = reader.GetOrdinal("AuthorMode");
            int fAnonymousDisplayLanguage = reader.GetOrdinal("AnonymousDisplayLanguage");
            int fAnonymousScope = reader.GetOrdinal("AnonymousScope");
            int fReplyToDisplayName = reader.GetOrdinal("ReplyToDisplayName");
            int fReplyToAuthorMode = reader.GetOrdinal("ReplyToAuthorMode");
            int fReplyToAnonymousDisplayLanguage = reader.GetOrdinal("ReplyToAnonymousDisplayLanguage");
            int fReplyToAnonymousScope = reader.GetOrdinal("ReplyToAnonymousScope");
            int fReplyTargetIsDeleted = reader.GetOrdinal("ReplyTargetIsDeleted");
            int fDepth = reader.GetOrdinal("Depth");
            int fIsDeleted = reader.GetOrdinal("IsDeleted");
            int fReplyCount = reader.GetOrdinal("ReplyCount");

            var countMap = new Dictionary<long, int>(rootIds.Length);

            while (await reader.ReadAsync())
            {
                var row = new ReplyRow
                {
                    Id = reader.GetInt64(fId),
                    ParentId = reader.IsDBNull(fParentId) ? null : reader.GetInt64(fParentId),
                    RootId = reader.IsDBNull(fRootId) ? null : reader.GetInt64(fRootId),
                    ReplyToCommentId = reader.IsDBNull(fReplyToCommentId) ? null : reader.GetInt64(fReplyToCommentId),
                    Content = reader.IsDBNull(fContent) ? string.Empty : reader.GetString(fContent),
                    CreateTime = reader.GetDateTime(fCreateTime),
                    AuthorDisplayName = reader.IsDBNull(fAuthorDisplayName) ? string.Empty : reader.GetString(fAuthorDisplayName),
                    AuthorMode = reader.IsDBNull(fAuthorMode) ? null : reader.GetString(fAuthorMode),
                    AnonymousDisplayLanguage = reader.IsDBNull(fAnonymousDisplayLanguage) ? null : reader.GetString(fAnonymousDisplayLanguage),
                    AnonymousScope = reader.IsDBNull(fAnonymousScope) ? null : reader.GetString(fAnonymousScope),
                    ReplyToDisplayName = reader.IsDBNull(fReplyToDisplayName) ? null : reader.GetString(fReplyToDisplayName),
                    ReplyToAuthorMode = reader.IsDBNull(fReplyToAuthorMode) ? null : reader.GetString(fReplyToAuthorMode),
                    ReplyToAnonymousDisplayLanguage = reader.IsDBNull(fReplyToAnonymousDisplayLanguage) ? null : reader.GetString(fReplyToAnonymousDisplayLanguage),
                    ReplyToAnonymousScope = reader.IsDBNull(fReplyToAnonymousScope) ? null : reader.GetString(fReplyToAnonymousScope),
                    ReplyTargetIsDeleted = reader.GetBoolean(fReplyTargetIsDeleted),
                    Depth = reader.GetInt32(fDepth),
                    IsDeleted = reader.GetBoolean(fIsDeleted)
                };
                rows.Add(row);
                long count = reader.GetInt64(fReplyCount);
                countMap[row.RootId ?? row.Id] = count > int.MaxValue ? int.MaxValue : (int)count;
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

            return new ThreadReplyProjection(map, countMap);
        }
    }

    private static CommentReplyItemDto MapReplyRow(ReplyRow row)
    {
        long resolvedRootId = row.RootId ?? row.Id;
        int viewDepth = Math.Max(1, row.Depth);

        return new CommentReplyItemDto(
            row.Id.ToString(),
            ToDisplayContent(row.IsDeleted, row.Content),
            row.CreateTime,
            row.IsDeleted
                ? BuildDeletedAuthorView()
                : BuildAuthorView(row.AuthorMode, row.AuthorDisplayName, row.AnonymousDisplayLanguage, row.AnonymousScope),
            BuildReplyToAuthorView(row),
            row.ParentId?.ToString(),
            resolvedRootId.ToString(),
            row.ReplyToCommentId?.ToString(),
            viewDepth,
            row.IsDeleted);
    }

    private static CommentTreeNodeDto MapTreeRoot(ThreadRootRow row, int childCount, bool hasMoreChildren)
        => new(
            row.Id.ToString(),
            ToDisplayContent(row.IsDeleted, row.Content),
            row.CreateTime,
            row.IsDeleted
                ? BuildDeletedAuthorView()
                : BuildAuthorView(row.AuthorMode, row.AuthorDisplayName, row.AnonymousDisplayLanguage, row.AnonymousScope),
            null,
            null,
            row.Id.ToString(),
            null,
            0,
            row.IsDeleted,
            childCount,
            hasMoreChildren);

    private static CommentTreeNodeDto MapTreeNode(ReplyRow row)
    {
        long rootId = row.RootId ?? row.Id;
        return new CommentTreeNodeDto(
            row.Id.ToString(),
            ToDisplayContent(row.IsDeleted, row.Content),
            row.CreateTime,
            row.IsDeleted
                ? BuildDeletedAuthorView()
                : BuildAuthorView(row.AuthorMode, row.AuthorDisplayName, row.AnonymousDisplayLanguage, row.AnonymousScope),
            BuildReplyToAuthorView(row),
            row.ParentId?.ToString(),
            rootId.ToString(),
            row.ReplyToCommentId?.ToString(),
            Math.Max(0, row.Depth),
            row.IsDeleted,
            row.ChildCount,
            row.ChildCount > 0);
    }

    private static CommentPermalinkContextDto UnavailablePermalink()
        => new("unavailable", null, null, [], null, [], false, false);

    private static bool IsValidAncestorPath(List<ReplyRow> path, long targetId)
    {
        if (path.Count == 0 || path.Count > 257 || path[^1].Id != targetId)
        {
            return false;
        }

        ReplyRow root = path[0];
        if (root.ParentId.HasValue || root.Depth != 0)
        {
            return false;
        }

        for (int index = 1; index < path.Count; index++)
        {
            ReplyRow parent = path[index - 1];
            ReplyRow child = path[index];
            if (child.ParentId != parent.Id
                || child.Depth != parent.Depth + 1
                || (child.RootId ?? child.Id) != root.Id)
            {
                return false;
            }
        }

        return true;
    }

    private static CommentReplyPreviewItemDto MapReplyPreviewRow(ReplyRow row)
        => new(
            row.Id.ToString(),
            ToDisplayContent(row.IsDeleted, row.Content),
            row.CreateTime,
            row.IsDeleted
                ? BuildDeletedAuthorView()
                : BuildAuthorView(row.AuthorMode, row.AuthorDisplayName, row.AnonymousDisplayLanguage, row.AnonymousScope),
            BuildReplyToAuthorView(row),
            row.IsDeleted);

    private static CommentAuthorViewDto? BuildReplyToAuthorView(ReplyRow row)
    {
        if (row.ReplyTargetIsDeleted)
        {
            return BuildDeletedAuthorView();
        }

        if (string.IsNullOrWhiteSpace(row.ReplyToDisplayName))
        {
            return null;
        }

        string mode = string.IsNullOrWhiteSpace(row.ReplyToAuthorMode)
            ? CommentAuthorModes.Public
            : row.ReplyToAuthorMode;
        return BuildAuthorView(
            mode,
            row.ReplyToDisplayName!,
            row.ReplyToAnonymousDisplayLanguage,
            row.ReplyToAnonymousScope);
    }

    private static CommentAuthorViewDto BuildDeletedAuthorView()
        => new(
            CommentAuthorModes.LegacyServerVisiblePseudonymous,
            DeletedAuthorPlaceholder,
            "zh-CN",
            null,
            null);

    private static CommentAuthorViewDto BuildAuthorView(
        string? authorMode,
        string? displayName,
        string? displayLanguage,
        string? anonymousScope)
    {
        string mode = NormalizeAuthorModeForView(authorMode);
        string fallbackName = string.Equals(mode, CommentAuthorModes.Public, StringComparison.Ordinal)
            ? "未署名用户"
            : ResolveAnonymousDisplayFallback(displayLanguage);
        string resolvedDisplayName = TextHelpers.NormalizeNullable(displayName, 96) ?? fallbackName;

        return new CommentAuthorViewDto(
            mode,
            resolvedDisplayName,
            NormalizeAuthorDisplayLanguage(displayLanguage),
            null,
            string.Equals(mode, CommentAuthorModes.Public, StringComparison.Ordinal) ? null : TextHelpers.NormalizeNullable(anonymousScope, 128));
    }

    private static string NormalizeAuthorModeForView(string? authorMode)
    {
        string? normalized = TextHelpers.NormalizeModeToken(authorMode);
        return normalized is CommentAuthorModes.Public or CommentAuthorModes.ZkAnonymous
            ? normalized
            : CommentAuthorModes.LegacyServerVisiblePseudonymous;
    }

    private static string NormalizeAuthorDisplayLanguage(string? displayLanguage)
        => string.Equals(displayLanguage, "en", StringComparison.OrdinalIgnoreCase) ? "en" : "zh-CN";

    private static string ResolveCommentAuthorDisplayName(
        string? authorMode,
        string? publicHandle,
        string? anonymousDisplayName,
        string? anonymousDisplayLanguage)
    {
        string mode = NormalizeAuthorModeForView(authorMode);
        if (string.Equals(mode, CommentAuthorModes.Public, StringComparison.Ordinal))
        {
            return TextHelpers.NormalizeNullable(publicHandle, 96) ?? "未署名用户";
        }

        return TextHelpers.NormalizeNullable(anonymousDisplayName, 96)
            ?? ResolveAnonymousDisplayFallback(anonymousDisplayLanguage);
    }

    private static string ResolveAnonymousDisplayFallback(string? displayLanguage)
        => string.Equals(displayLanguage, "en", StringComparison.OrdinalIgnoreCase)
            ? "Anonymous User"
            : "匿名用户";

    private static string ToDisplayContent(bool isDeleted, string content)
        => isDeleted ? DeletedPlaceholder : content;


    private sealed record ThreadRootRow
    {
        public long Id
        {
            get; init;
        }
        public int ArticleId
        {
            get; init;
        }
        public string Content { get; init; } = string.Empty;
        public DateTime CreateTime
        {
            get; init;
        }
        public string AuthorDisplayName { get; init; } = string.Empty;
        public string? AuthorMode
        {
            get; init;
        }
        public string? AnonymousDisplayLanguage
        {
            get; init;
        }
        public string? AnonymousScope
        {
            get; init;
        }
        public int Depth
        {
            get; init;
        }
        public bool IsDeleted
        {
            get; init;
        }
    }

    private sealed record ReplyRow
    {
        public long Id
        {
            get; init;
        }
        public long? ParentId
        {
            get; init;
        }
        public long? RootId
        {
            get; init;
        }
        public long? ReplyToCommentId
        {
            get; init;
        }
        public string Content { get; init; } = string.Empty;
        public DateTime CreateTime
        {
            get; init;
        }
        public string AuthorDisplayName { get; init; } = string.Empty;
        public string? AuthorMode
        {
            get; init;
        }
        public string? AnonymousDisplayLanguage
        {
            get; init;
        }
        public string? AnonymousScope
        {
            get; init;
        }
        public string? ReplyToDisplayName
        {
            get; init;
        }
        public string? ReplyToAuthorMode
        {
            get; init;
        }
        public string? ReplyToAnonymousDisplayLanguage
        {
            get; init;
        }
        public string? ReplyToAnonymousScope
        {
            get; init;
        }
        public bool ReplyTargetIsDeleted
        {
            get;
            init;
        }
        public int Depth
        {
            get; init;
        }
        public bool IsDeleted
        {
            get; init;
        }
        public int ChildCount
        {
            get; init;
        }
        public int SiblingCount
        {
            get; init;
        }
    }

    private sealed record ThreadReplyProjection(
        Dictionary<long, List<CommentReplyPreviewItemDto>> PreviewMap,
        Dictionary<long, int> CountMap);

    private sealed record DirectChildProjection(
        Dictionary<long, List<CommentTreeNodeDto>> PreviewMap,
        Dictionary<long, int> CountMap);

    private sealed record VisibleParentContext(long ParentId, long RootId);

    private sealed record SiblingWindowResult(List<ReplyRow> Rows, bool HasPrevious, bool HasNext);

    private sealed record UserCommentRow
    {
        public long Id
        {
            get; init;
        }
        public string Content { get; init; } = string.Empty;
        public DateTime CreateTime
        {
            get; init;
        }
        public bool IsDeleted
        {
            get; init;
        }
        public CommentModerationStatus ModerationStatus { get; init; } = CommentModerationStatus.Approved;
        public string? BlockedRegions
        {
            get; init;
        }
        public long? RootId
        {
            get; init;
        }
        public int ArticleId
        {
            get; init;
        }
        public string? ArticleTitle
        {
            get; init;
        }
        public long? ReplyToCommentId
        {
            get; init;
        }
        public string? AuthorMode
        {
            get; init;
        }
        public string? PublicHandle
        {
            get; init;
        }
        public string? AnonymousDisplayName
        {
            get; init;
        }
        public string? AnonymousDisplayLanguage
        {
            get; init;
        }
        public string? AnonymousScope
        {
            get; init;
        }
        public string? ReplyToAuthorMode
        {
            get; init;
        }
        public string? ReplyToPublicHandle
        {
            get; init;
        }
        public string? ReplyToAnonymousDisplayName
        {
            get; init;
        }
        public string? ReplyToAnonymousDisplayLanguage
        {
            get; init;
        }
    }

}
