using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.Security;

namespace FsusBlog.Server.Modules.Endpoints;

public static class AuthoringEndpoints
{
    private const string AdminSensitiveAction = "admin-sensitive";
    private const string MfaProofHeader = "X-Fsus-Mfa-Proof";

    public static IEndpointRouteBuilder MapAuthoringEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/author")
            .WithTags("Authoring")
            .RequireAuthorization(policy => policy.RequireRole("admin"));

        group.MapPost("/drafts", async (
            ServerDraftSaveRequest request,
            HttpContext context,
            AuthoringWorkflowService service,
            CancellationToken cancellationToken) =>
        {
            ServerDraftResponse saved = await service.SaveDraftAsync(context.User.GetUserId(), request, cancellationToken);
            return Results.Ok(JsonApiResponse<ServerDraftResponse>.Ok(saved));
        });

        group.MapGet("/drafts/{draftKey}", async (
            string draftKey,
            HttpContext context,
            AuthoringWorkflowService service,
            CancellationToken cancellationToken) =>
        {
            ServerDraftResponse? draft = await service.GetDraftAsync(context.User.GetUserId(), draftKey, cancellationToken);
            return Results.Ok(JsonApiResponse<ServerDraftResponse?>.Ok(draft));
        });

        group.MapDelete("/drafts/{draftKey}", async (
            string draftKey,
            HttpContext context,
            AuthoringWorkflowService service,
            CancellationToken cancellationToken) =>
        {
            bool discarded = await service.DiscardDraftAsync(context.User.GetUserId(), draftKey, cancellationToken);
            return Results.Ok(JsonApiResponse<object>.Ok(new { discarded }));
        });

        group.MapPost("/preview", async (ServerDraftSaveRequest request, AuthoringWorkflowService service) =>
            Results.Ok(JsonApiResponse<ArticlePreviewResponse>.Ok(await service.PreviewAsync(request))));

        group.MapPost("/prepublish-check", (ServerDraftSaveRequest request, HttpContext context, AuthoringWorkflowService service) =>
            Results.Ok(JsonApiResponse<PrepublishCheckResponse>.Ok(
                service.RunPrepublishCheck(
                    request.Title,
                    request.Content,
                    request.Summary,
                    request.CoverImageUrl,
                    context.User.GetUserId(),
                    request.DraftKey,
                    request.ArticleId,
                    request.WarningOverrideReason))));

        group.MapGet("/articles/{articleId:int}/revisions", async (
            int articleId,
            AuthoringWorkflowService service,
            CancellationToken cancellationToken) =>
        {
            IReadOnlyList<ArticleRevisionSummaryResponse> revisions = await service.GetRevisionsAsync(articleId, cancellationToken);
            return Results.Ok(JsonApiResponse<IReadOnlyList<ArticleRevisionSummaryResponse>>.Ok(revisions));
        });

        group.MapGet("/articles/{articleId:int}/revisions/{revisionId:long}", async (
            int articleId,
            long revisionId,
            AuthoringWorkflowService service,
            CancellationToken cancellationToken) =>
        {
            ArticleRevisionDetailResponse? revision = await service.GetRevisionAsync(articleId, revisionId, cancellationToken);
            return revision is null
                ? Results.NotFound(JsonApiResponse<ArticleRevisionDetailResponse>.Fail("revision_not_found"))
                : Results.Ok(JsonApiResponse<ArticleRevisionDetailResponse>.Ok(revision));
        });

        group.MapPost("/articles/{articleId:int}/revisions/{revisionId:long}/rollback", async (
            int articleId,
            long revisionId,
            HttpContext context,
            AuthoringWorkflowService service,
            CancellationToken cancellationToken) =>
        {
            bool rolledBack = await service.RollbackRevisionAsync(context.User.GetUserId(), articleId, revisionId, cancellationToken);
            return rolledBack
                ? Results.Ok(JsonApiResponse<object>.Ok(new { rolledBack }))
                : Results.NotFound(JsonApiResponse<object>.Fail("revision_not_found"));
        });

        group.MapPost("/articles/{articleId:int}/assets/reindex", async (
            int articleId,
            AuthoringWorkflowService service,
            CancellationToken cancellationToken) =>
        {
            IReadOnlyList<AssetLibraryItemResponse> assets = await service.ReindexAssetsAsync(articleId, cancellationToken);
            return Results.Ok(JsonApiResponse<IReadOnlyList<AssetLibraryItemResponse>>.Ok(assets));
        });

        group.MapGet("/assets", async (AuthoringWorkflowService service, CancellationToken cancellationToken) =>
            Results.Ok(JsonApiResponse<IReadOnlyList<AssetLibraryItemResponse>>.Ok(await service.ListAssetsAsync(cancellationToken))));

        group.MapDelete("/assets/orphans", async (AuthoringWorkflowService service, CancellationToken cancellationToken) =>
            Results.Ok(JsonApiResponse<AssetCleanupResponse>.Ok(await service.CleanupOrphanAssetsAsync(cancellationToken))));

        group.MapGet("/analytics", async (AuthoringWorkflowService service, CancellationToken cancellationToken) =>
            Results.Ok(JsonApiResponse<AuthorAnalyticsResponse>.Ok(await service.GetAnalyticsAsync(cancellationToken))));

        group.MapGet("/comments/moderation", async (
            int? status,
            int? limit,
            AuthoringWorkflowService service,
            CancellationToken cancellationToken) =>
        {
            if (!TryResolveModerationStatus(status, out CommentModerationStatus? resolvedStatus))
            {
                return Results.BadRequest(JsonApiResponse<object>.Fail("comment_status_invalid"));
            }

            CommentModerationQueueResponse queue = await service.ListCommentModerationQueueAsync(resolvedStatus, limit ?? 50, cancellationToken);
            return Results.Ok(JsonApiResponse<CommentModerationQueueResponse>.Ok(queue));
        })
        .RequireRateLimiting("fixed_ip");

        group.MapPost("/comments/moderation/bulk", async (
            CommentModerationBulkRequest request,
            HttpContext context,
            IMfaChallengeService mfaChallengeService,
            AuthoringWorkflowService service,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, mfaChallengeService);
            if (stepUp is not null)
            {
                return stepUp;
            }

            CommentModerationBulkResponse response = await service.ModerateCommentsAsync(context.User.GetUserId(), request, cancellationToken);
            return Results.Ok(JsonApiResponse<CommentModerationBulkResponse>.Ok(response));
        })
        .RequireRateLimiting("fixed_ip");

        group.MapPost("/comments/{commentId:long}/moderation", async (
            long commentId,
            CommentModerationRequest request,
            HttpContext context,
            IMfaChallengeService mfaChallengeService,
            AuthoringWorkflowService service,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, mfaChallengeService);
            if (stepUp is not null)
            {
                return stepUp;
            }

            bool moderated = await service.ModerateCommentAsync(context.User.GetUserId(), commentId, request, cancellationToken);
            return moderated
                ? Results.Ok(JsonApiResponse<object>.Ok(new { moderated }))
                : Results.NotFound(JsonApiResponse<object>.Fail("comment_not_found"));
        })
        .RequireRateLimiting("fixed_ip");

        group.MapGet("/content/export", async (
            AuthoringWorkflowService service,
            CancellationToken cancellationToken) =>
            Results.Ok(JsonApiResponse<ContentBackupExportResponse>.Ok(await service.ExportContentBackupAsync(cancellationToken))));

        group.MapGet("/articles/{articleId:int}/export", async (
            int articleId,
            AuthoringWorkflowService service,
            CancellationToken cancellationToken) =>
        {
            ContentExportResponse? exported = await service.ExportArticleAsync(articleId, cancellationToken);
            return exported is null
                ? Results.NotFound(JsonApiResponse<ContentExportResponse>.Fail("article_not_found"))
                : Results.Ok(JsonApiResponse<ContentExportResponse>.Ok(exported));
        });

        group.MapPost("/articles/import", async (
            ContentImportRequest request,
            AuthoringWorkflowService service,
            CancellationToken cancellationToken) =>
        {
            ContentImportResponse response = await service.ImportArticleAsync(request, cancellationToken);
            return Results.Ok(JsonApiResponse<ContentImportResponse>.Ok(response));
        });

        group.MapPost("/ai-assist", (AiAssistRequest request, HttpContext context, AuthoringWorkflowService service) =>
            Results.Ok(JsonApiResponse<AiAssistResponse>.Ok(service.GenerateAiAssist(context.User.GetUserId(), request))));

        return app;
    }

    private static bool TryResolveModerationStatus(int? raw, out CommentModerationStatus? status)
    {
        status = null;
        if (raw is null)
        {
            return true;
        }

        CommentModerationStatus resolved = (CommentModerationStatus)raw.Value;
        if (!IsValidModerationStatus(resolved))
        {
            return false;
        }

        status = resolved;
        return true;
    }

    private static async Task<IResult?> RequireAdminSensitiveStepUpAsync(HttpContext context, IMfaChallengeService mfaChallengeService)
    {
        int userId = context.User.GetUserId();
        if (userId <= 0)
        {
            return Results.Unauthorized();
        }

        if (!context.User.IsMfaVerified())
        {
            return Results.Json(
                JsonApiResponse<object>.Fail("MFA_REQUIRED"),
                statusCode: StatusCodes.Status403Forbidden);
        }

        string proofToken = context.Request.Headers.TryGetValue(MfaProofHeader, out var values)
            ? values.ToString().Trim()
            : string.Empty;
        if (string.IsNullOrWhiteSpace(proofToken) ||
            !await mfaChallengeService.ValidateAndConsumeProofTokenAsync(userId, AdminSensitiveAction, proofToken))
        {
            return Results.Json(
                JsonApiResponse<object>.Fail("MFA_PROOF_REQUIRED"),
                statusCode: StatusCodes.Status428PreconditionRequired);
        }

        return null;
    }

    private static bool IsValidModerationStatus(CommentModerationStatus status)
        => status is CommentModerationStatus.Pending
            or CommentModerationStatus.Approved
            or CommentModerationStatus.Rejected
            or CommentModerationStatus.Hidden;
}
