using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Common;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Integrity;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.Security;

using SqlSugar;

namespace FsusBlog.Server.Modules.Endpoints;

public static partial class AuthoringEndpoints
{
    private static readonly JsonSerializerOptions s_draftConflictJsonOptions = new(JsonSerializerDefaults.Web);

    private static void MapAuthoringWorkflowRoutes(IEndpointRouteBuilder group)
    {
        group.MapPost("/drafts", async (
            HttpContext context,
            IAedsEncoder aeds,
            IAuthoringDraftLifecycle service,
            CancellationToken cancellationToken) =>
        {
            var parsed = await ReadRequestAsync<ServerDraftSaveRequest>(
                context,
                aeds,
                "author_draft_save_request_invalid",
                cancellationToken);
            if (!parsed.IsSuccess)
            {
                return parsed.ToErrorResult(aeds);
            }

            try
            {
                ServerDraftSaveRequest request = parsed.Value!;
                ServerDraftResponse saved = await service.SaveDraftAsync(ResolveRequiredAdminPrincipalId(context), request, cancellationToken);
                return Ok(context, aeds, saved);
            }
            catch (ServerDraftConflictException conflict)
            {
                return DraftConflict(aeds, conflict);
            }
        })
        .RequireAdminPermission(AdminPermissions.ArticleWrite);

        group.MapGet("/drafts/{draftKey}", async (
            string draftKey,
            HttpContext context,
            IAedsEncoder aeds,
            IAuthoringDraftLifecycle service,
            CancellationToken cancellationToken) =>
        {
            ServerDraftResponse? draft = await service.GetDraftAsync(ResolveRequiredAdminPrincipalId(context), draftKey, cancellationToken);
            return Ok(context, aeds, draft);
        })
        .RequireAdminPermission(AdminPermissions.ArticleWrite);

        group.MapDelete("/drafts/{draftKey}", async (
            string draftKey,
            long expectedServerRevision,
            HttpContext context,
            IAedsEncoder aeds,
            IAuthoringDraftLifecycle service,
            CancellationToken cancellationToken) =>
        {
            if (expectedServerRevision <= 0)
            {
                return BinaryResults.FromError(
                    ErrorDetail.Create(ErrorCode.Validation, "expected_server_revision_required"),
                    aeds,
                    StatusCodes.Status400BadRequest);
            }

            try
            {
                bool discarded = await service.DiscardDraftAsync(
                    ResolveRequiredAdminPrincipalId(context),
                    draftKey,
                    expectedServerRevision,
                    cancellationToken);
                return Ok(context, aeds, new
                {
                    discarded
                });
            }
            catch (ServerDraftConflictException conflict)
            {
                return DraftConflict(aeds, conflict);
            }
        })
        .RequireAdminPermission(AdminPermissions.ArticleWrite);

        group.MapPost("/preview", async (
            HttpContext context,
            IAedsEncoder aeds,
            IAuthoringDraftLifecycle service,
            CancellationToken cancellationToken) =>
        {
            var parsed = await ReadRequestAsync<ServerDraftSaveRequest>(
                context,
                aeds,
                "article_preview_request_invalid",
                cancellationToken);
            return parsed.IsSuccess
                ? Ok(context, aeds, await service.PreviewAsync(parsed.Value!))
                : parsed.ToErrorResult(aeds);
        })
        .RequireAdminPermission(AdminPermissions.ArticleWrite);

        group.MapPost("/prepublish-check", async (
            HttpContext context,
            IAedsEncoder aeds,
            IAuthoringPrepublishPolicy service,
            CancellationToken cancellationToken) =>
        {
            var parsed = await ReadRequestAsync<ServerDraftSaveRequest>(
                context,
                aeds,
                "prepublish_check_request_invalid",
                cancellationToken);
            if (!parsed.IsSuccess)
            {
                return parsed.ToErrorResult(aeds);
            }

            ServerDraftSaveRequest request = parsed.Value!;
            return Ok(
                context,
                aeds,
                await service.RunPrepublishCheckAsync(
                    request,
                    context.GetUserId(),
                    cancellationToken));
        })
        .RequireAdminPermission(AdminPermissions.ArticleWrite);

        group.MapGet("/articles/{articleId:int}/revisions", async (
            int articleId,
            HttpContext context,
            IAedsEncoder aeds,
            IAuthoringDraftLifecycle service,
            CancellationToken cancellationToken) =>
        {
            IReadOnlyList<ArticleRevisionSummaryResponse> revisions = await service.GetRevisionsAsync(articleId, cancellationToken);
            return Ok(context, aeds, revisions);
        })
        .RequireAdminPermission(AdminPermissions.ArticleWrite);

        group.MapGet("/articles/{articleId:int}/revisions/{revisionId:long}", async (
            int articleId,
            long revisionId,
            HttpContext context,
            IAedsEncoder aeds,
            IAuthoringDraftLifecycle service,
            CancellationToken cancellationToken) =>
        {
            ArticleRevisionDetailResponse? revision = await service.GetRevisionAsync(articleId, revisionId, cancellationToken);
            return revision is null
                ? AedsJsonResults.NotFound(aeds, "revision_not_found")
                : Ok(context, aeds, revision);
        })
        .RequireAdminPermission(AdminPermissions.ArticleWrite);

        group.MapPost("/articles/{articleId:int}/revisions/{revisionId:long}/rollback", async (
            int articleId,
            long revisionId,
            HttpContext context,
            IAedsEncoder aeds,
            IAdminPrincipalService adminPrincipals,
            IAuthoringDraftLifecycle service,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals, aeds);
            if (stepUp is not null)
            {
                return stepUp;
            }

            var parsed = await ReadRequestAsync<ArticleRevisionRollbackRequest>(
                context,
                aeds,
                "article_revision_rollback_request_invalid",
                cancellationToken);
            if (!parsed.IsSuccess)
            {
                return parsed.ToErrorResult(aeds);
            }

            Result<ArticleRevisionRollbackResponse?> rollback = await service.RollbackRevisionAsync(
                ResolveRequiredAdminPrincipalId(context),
                articleId,
                revisionId,
                parsed.Value!,
                cancellationToken);
            if (!rollback.IsSuccess)
            {
                return BinaryResults.FromError(rollback.Error, aeds);
            }

            return rollback.Value is not null
                ? Ok(context, aeds, rollback.Value)
                : AedsJsonResults.NotFound(aeds, "revision_not_found");
        })
        .RequireAdminPermission(AdminPermissions.ArticleWrite);

        group.MapGet("/articles/{articleId:int}/revisions/{revisionId:long}/responsibility", async (
            int articleId,
            long revisionId,
            HttpContext context,
            IAedsEncoder aeds,
            IArticleResponsibilityAuthoringService service,
            CancellationToken cancellationToken) =>
        {
            IReadOnlyList<ArticleResponsibilityVersionResponse>? response = await service.GetHistoryAsync(
                articleId,
                revisionId,
                cancellationToken);
            return response is null
                ? AedsJsonResults.NotFound(aeds, "revision_not_found")
                : Ok(context, aeds, response);
        })
        .RequireAdminPermission(AdminPermissions.ArticleWrite);

        group.MapPut("/articles/{articleId:int}/revisions/{revisionId:long}/responsibility", async (
            int articleId,
            long revisionId,
            HttpContext context,
            IAedsEncoder aeds,
            IArticleResponsibilityAuthoringService service,
            CancellationToken cancellationToken) =>
        {
            var parsed = await ReadRequestAsync<ArticleResponsibilityDraft>(
                context,
                aeds,
                "article_responsibility_request_invalid",
                cancellationToken);
            if (!parsed.IsSuccess)
            {
                return parsed.ToErrorResult(aeds);
            }

            ArticleResponsibilitySaveResponse? response = await service.SaveAsync(
                articleId,
                revisionId,
                parsed.Value!,
                cancellationToken);
            return response is null
                ? AedsJsonResults.NotFound(aeds, "revision_not_found")
                : response.VersionConflict
                    ? AedsJsonResults.Error(
                        aeds,
                        ErrorCode.Conflict,
                        "article_responsibility_version_conflict",
                        StatusCodes.Status409Conflict)
                : Ok(context, aeds, response);
        })
        .RequireAdminPermission(AdminPermissions.ArticleWrite);

        group.MapPost("/articles/{articleId:int}/assets/reindex", async (
            int articleId,
            HttpContext context,
            IAedsEncoder aeds,
            IAuthoringAssetCommands service,
            CancellationToken cancellationToken) =>
        {
            IReadOnlyList<AssetLibraryItemResponse> assets = await service.ReindexAssetsAsync(articleId, cancellationToken);
            return Ok(context, aeds, assets);
        })
        .RequireAdminPermission(AdminPermissions.ArticleWrite);

        group.MapGet("/assets", async (
            HttpContext context,
            IAedsEncoder aeds,
            IAuthoringAssetQuery service,
            CancellationToken cancellationToken) =>
            Ok(context, aeds, await service.ListAssetsAsync(cancellationToken)))
        .RequireAdminPermission(AdminPermissions.ArticleWrite);

        group.MapDelete("/assets/orphans", async (
            HttpContext context,
            IAedsEncoder aeds,
            IAuthoringAssetCommands service,
            CancellationToken cancellationToken) =>
            Ok(context, aeds, await service.CleanupOrphanAssetsAsync(cancellationToken)))
        .RequireAdminPermission(AdminPermissions.ArticleWrite);

        group.MapGet("/taxonomy/categories", async (
            HttpContext context,
            IAedsEncoder aeds,
            ISqlSugarClient db,
            CancellationToken cancellationToken) =>
            Ok(context, aeds, await ListAdminCategoriesAsync(db, cancellationToken)))
        .RequireAdminPermission(AdminPermissions.ArticleWrite);

        group.MapGet("/taxonomy/tags", async (
            HttpContext context,
            IAedsEncoder aeds,
            ISqlSugarClient db,
            CancellationToken cancellationToken) =>
            Ok(context, aeds, await ListAdminTagsAsync(db, cancellationToken)))
        .RequireAdminPermission(AdminPermissions.ArticleWrite);

        group.MapGet("/analytics", async (
            HttpContext context,
            IAedsEncoder aeds,
            IAuthoringAnalyticsReader service,
            CancellationToken cancellationToken) =>
            Ok(context, aeds, await service.GetAnalyticsAsync(cancellationToken)))
        .RequireAdminPermission(AdminPermissions.ArticleWrite);

    }

    private static BinaryFrameResult DraftConflict(IAedsEncoder aeds, ServerDraftConflictException conflict)
        => BinaryResults.FromError(
            ErrorDetail.Create(
                ErrorCode.Conflict,
                "draft_conflict",
                JsonSerializer.Serialize(conflict.Conflict, s_draftConflictJsonOptions)),
            aeds,
            StatusCodes.Status409Conflict);
}
