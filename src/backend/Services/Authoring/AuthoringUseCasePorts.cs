using FsusBlog.Core.Common;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Requests;

namespace FsusBlog.Server.Services.Authoring;

public interface IAuthoringAnalyticsReader
{
    Task<AuthorAnalyticsResponse> GetAnalyticsAsync(CancellationToken cancellationToken = default);
}

public interface IAuthoringAssetQuery
{
    Task<IReadOnlyList<AssetLibraryItemResponse>> ListAssetsAsync(CancellationToken cancellationToken = default);
}

public interface IAuthoringAssetCommands
{
    Task<IReadOnlyList<AssetLibraryItemResponse>> ReindexAssetsAsync(int articleId, CancellationToken cancellationToken = default);

    Task<AssetCleanupResponse> CleanupOrphanAssetsAsync(CancellationToken cancellationToken = default);
}

public interface IAuthoringDraftLifecycle
{
    Task<ServerDraftResponse> SaveDraftAsync(long ownerAdminPrincipalId, ServerDraftSaveRequest request, CancellationToken cancellationToken = default);

    Task<ServerDraftResponse?> GetDraftAsync(long ownerAdminPrincipalId, string draftKey, CancellationToken cancellationToken = default);

    Task<bool> DiscardDraftAsync(
        long ownerAdminPrincipalId,
        string draftKey,
        long expectedServerRevision,
        CancellationToken cancellationToken = default);

    Task<IReadOnlyList<ArticleRevisionSummaryResponse>> GetRevisionsAsync(int articleId, CancellationToken cancellationToken = default);

    Task<ArticleRevisionDetailResponse?> GetRevisionAsync(int articleId, long revisionId, CancellationToken cancellationToken = default);

    Task<Result<ArticleMutationResult>> RollbackRevisionAsync(
        long actorAdminPrincipalId,
        int articleId,
        long revisionId,
        ArticleRevisionRollbackRequest request,
        CancellationToken cancellationToken = default);

    Task<ArticlePreviewResponse> PreviewAsync(ServerDraftSaveRequest request);
}

public interface IAuthoringPrepublishPolicy
{
    PrepublishCheckResponse RunPrepublishCheck(
        string title,
        string content,
        string? summary,
        string? coverImageUrl,
        int? actorUserId = null,
        string? draftKey = null,
        int? articleId = null,
        string? warningOverrideReason = null);

    Task<PrepublishCheckResponse> RunPrepublishCheckAsync(
        ServerDraftSaveRequest request,
        int? actorUserId = null,
        CancellationToken cancellationToken = default);
}

public interface IAuthoringContentExport
{
    Task<ContentExportResponse?> ExportArticleAsync(int articleId, CancellationToken cancellationToken = default);

    Task<ContentBackupExportResponse> ExportContentBackupAsync(CancellationToken cancellationToken = default);
}

public interface IAuthoringContentImport
{
    Task<ContentImportResponse> ImportArticleAsync(ContentImportRequest request, CancellationToken cancellationToken = default);
}

public interface IAuthoringAiAssist
{
    AiAssistResponse GenerateAiAssist(int actorUserId, AiAssistRequest request);

    AiAssistResponse GenerateAiAssist(AiAssistRequest request);
}

public interface IAuthoringModerationQueue
{
    Task<CommentModerationQueueResponse> ListCommentModerationQueueAsync(
        CommentModerationStatus? status = null,
        int limit = 50,
        CancellationToken cancellationToken = default);

    Task<CommentModerationQueueResponse> ListCommentModerationQueuePageAsync(
        CommentModerationStatus? status,
        int limit,
        string? cursor,
        CancellationToken cancellationToken = default);
}

public interface IAuthoringModerationCommands
{
    Task<bool> ModerateCommentAsync(
        long actorAdminPrincipalId,
        long commentId,
        CommentModerationRequest request,
        CancellationToken cancellationToken = default);

    Task<CommentModerationBulkResponse> ModerateCommentsAsync(
        long actorAdminPrincipalId,
        CommentModerationBulkRequest request,
        CancellationToken cancellationToken = default);
}
