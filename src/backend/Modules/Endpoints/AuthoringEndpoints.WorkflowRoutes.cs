using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Contracts.Articles;
using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Services.Articles;
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
                    aeds, ApiErrorSemanticMapper.RequireTransportMappingId(StatusCodes.Status400BadRequest, ErrorCode.Validation));
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

        group.MapPost("/articles/{articleId:int}/revisions/compare/draft-coordinate", async (
            int articleId,
            HttpContext context,
            IAedsEncoder aeds,
            IAuthoringRevisionCompareAuthority authority,
            IAuthoringRevisionCompareDraftContextAuthority draftContextAuthority,
            CancellationToken cancellationToken) =>
        {
            long adminPrincipalId = ResolveRequiredAdminPrincipalId(context);
            if (adminPrincipalId <= 0)
            {
                return AedsJsonResults.Unauthorized(aeds);
            }
            var parsed = await ReadRequestAsync<ArticleRevisionCompareDraftCoordinateRequest>(
                context, aeds, "article_revision_compare_request_invalid", cancellationToken);
            if (!parsed.IsSuccess)
            {
                return parsed.ToErrorResult(aeds);
            }
            ArticleRevisionCompareDraftCoordinateRequest input = parsed.Value!;
            long? expectedRevision;
            try
            {
                expectedRevision = ArticleRevisionCompareSelector.ParseCoordinate(input.ExpectedServerRevision);
            }
            catch (RevisionCompareContractException)
            {
                return AedsJsonResults.BadRequest(aeds, "article_revision_compare_request_invalid");
            }
            if (articleId <= 0 || expectedRevision is null || string.IsNullOrWhiteSpace(input.DraftKey)
                || input.DraftKey.Length > RevisionCompareContract.MaxIdentityLength || input.DraftKey.Any(char.IsControl))
            {
                return AedsJsonResults.BadRequest(aeds, "article_revision_compare_request_invalid");
            }
            var reader = new RevisionCompareReadContext(adminPrincipalId,
                AuthoringRevisionCompareDraftContextProvider.PrimarySiteScope, Guid.NewGuid());
            if (await authority.GetAuthorizedArticleAsync(reader, articleId, cancellationToken) is null)
            {
                return AedsJsonResults.NotFound(aeds, "article_revision_compare_unavailable");
            }
            ServerDraftResponse? draft = await authority.GetDraftAsync(adminPrincipalId, input.DraftKey, cancellationToken);
            if (draft is null || draft.ArticleId != articleId || draft.ServerRevision != expectedRevision
                || !string.Equals(draft.DraftKey, input.DraftKey, StringComparison.Ordinal))
            {
                return AedsJsonResults.NotFound(aeds, "article_revision_compare_unavailable");
            }
            string documentEpoch = AuthoringRevisionCompareDraftContextProvider.CreateDocumentEpoch(reader, articleId, draft);
            string rightsDigest = Convert.ToHexStringLower(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(draft.Rights)));
            AuthoringRevisionCompareDraftContextResult draftContext = await draftContextAuthority.ReadAsync(
                new AuthoringRevisionCompareDraftContextRequest(reader, articleId, draft.DraftKey,
                    draft.ServerRevision, documentEpoch, rightsDigest), cancellationToken);
            if (draftContext.Status != RevisionComparePackageReadStatus.Available || draftContext.Context is null
                || await authority.GetAuthorizedArticleAsync(reader, articleId, cancellationToken) is null)
            {
                return AedsJsonResults.NotFound(aeds, "article_revision_compare_unavailable");
            }
            cancellationToken.ThrowIfCancellationRequested();
            return Ok(context, aeds, new ArticleRevisionCompareDraftCoordinateResponse(draft.DraftKey,
                articleId, draft.ServerRevision.ToString(System.Globalization.CultureInfo.InvariantCulture), documentEpoch,
                Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(draft.Content)))));
        })
        .RequireAdminPermission(AdminPermissions.ArticleWrite);

        group.MapPost("/articles/{articleId:int}/revisions/compare", async (
            int articleId,
            HttpContext context,
            IAedsEncoder aeds,
            IAuthoringRevisionCompareService service,
            IRevisionMarkdownStructureAuthority structureAuthority,
            RevisionComparePlanVerifier planVerifier,
            TimeProvider timeProvider,
            CancellationToken cancellationToken) =>
        {
            long adminPrincipalId = ResolveRequiredAdminPrincipalId(context);
            if (adminPrincipalId <= 0)
            {
                return AedsJsonResults.Unauthorized(aeds);
            }
            var parsed = await ReadRequestAsync<ArticleRevisionCompareRequest>(
                context, aeds, "article_revision_compare_request_invalid", cancellationToken);
            if (!parsed.IsSuccess)
            {
                return parsed.ToErrorResult(aeds);
            }
            ArticleRevisionCompareRequest input = parsed.Value!;
            if (input.Base is null || input.Compare is null || input.Options is null
                || input.Options.MetadataFieldIds is null || input.Budgets is null)
            {
                return AedsJsonResults.BadRequest(aeds, "article_revision_compare_request_invalid");
            }
            RevisionComparePlanRequest request;
            try
            {
                request = new RevisionComparePlanRequest(articleId,
                    new RevisionCompareReadContext(adminPrincipalId,
                        AuthoringRevisionCompareDraftContextProvider.PrimarySiteScope, Guid.NewGuid()),
                    input.Base.ToSelector(), input.Compare.ToSelector(), input.Options.ToOptions(), input.Budgets,
                    input.CancellationIdentity,
                    timeProvider.GetUtcNow().AddSeconds(150));
                RevisionCompareContract.ValidateRequest(request);
            }
            catch (RevisionCompareContractException)
            {
                return AedsJsonResults.BadRequest(aeds, "article_revision_compare_request_invalid");
            }
            using var timeout = new CancellationTokenSource(request.Budgets.TimeoutMilliseconds);
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, timeout.Token);
            try
            {
                AuthoringRevisionCompareResult result = await service.CompareAsync(request, linked.Token).WaitAsync(linked.Token);
                if (!result.IsReviewable || result.Plan?.Bundle is null || result.Diff is null
                    || (!request.Options.MetadataFields.IsEmpty && result.MetadataDiff is null))
                {
                    // Failed requests do not expose partial package references, sizes, or content.
                    return AedsJsonResults.NotFound(aeds, "article_revision_compare_unavailable");
                }
                RevisionComparePlanBundle bundle = result.Plan.Bundle;
                long metadataOutput = result.MetadataDiff is null ? 0 : RevisionMetadataDiffEngine.EstimateOutputBytes(
                    result.MetadataDiff.Receipt, result.MetadataDiff.Fields, linked.Token);
                long heldSourceMemory = result.Diff.Receipt.EstimatedMemoryBytes + AuthoringRevisionCompareService.TransportOutputReserveBytes;
                long metadataMemory = result.MetadataDiff is null ? 0
                    : RevisionMetadataDiffEngine.EstimateInputReserveBytes(bundle, linked.Token) + metadataOutput * 2;
                // Preserve the original workers' logical storage/workspace gate.
                // Actual JSON publication bytes have their separate gate below.
                if (metadataOutput > request.Budgets.MaxOutputBytes - result.Diff.Receipt.EstimatedOutputBytes
                    - AuthoringRevisionCompareService.TransportOutputReserveBytes
                    || metadataMemory > request.Budgets.MaxMemoryBytes - heldSourceMemory)
                {
                    return AedsJsonResults.NotFound(aeds, "article_revision_compare_unavailable");
                }
                // The combined service pipeline independently verifies both workers
                // within its shared memory reservation. Source-only requests retain
                // their original endpoint verification before final authorization.
                if (result.MetadataDiff is null && !await new RevisionSourceDiffResultVerifier(structureAuthority)
                    .VerifyAsync(bundle, result.Diff, linked.Token).WaitAsync(linked.Token))
                {
                    return AedsJsonResults.NotFound(aeds, "article_revision_compare_unavailable");
                }
                linked.Token.ThrowIfCancellationRequested();
                if (AedsJsonResults.SerializationMemoryReserveBytes > request.Budgets.MaxMemoryBytes - heldSourceMemory - metadataMemory)
                {
                    return AedsJsonResults.NotFound(aeds, "article_revision_compare_unavailable");
                }
                ArticleRevisionCompareResponse response = ArticleRevisionCompareResponse.From(
                    ArticleRevisionComparePlanReceipt.From(result.Plan.Receipt), result.Diff, result.MetadataDiff);
                // The original AEDS JSON writer measures the complete wire object
                // with a bounded discard buffer; logical source storage estimates
                // cannot substitute for its actual publication-byte gate.
                AedsJsonOutputBudgetResult wire = AedsJsonResults.MeasureOutput(response, request.Budgets.MaxOutputBytes, linked.Token);
                if (!AedsJsonResults.MemoryWithinBudget(wire, checked(heldSourceMemory + metadataMemory), request.Budgets.MaxMemoryBytes))
                {
                    return AedsJsonResults.NotFound(aeds, "article_revision_compare_unavailable");
                }
                RevisionComparePlanVerification publication = await planVerifier.VerifyAsync(
                    bundle, timeProvider.GetUtcNow(), linked.Token).WaitAsync(linked.Token);
                if (!publication.Valid || result.Plan.Receipt != bundle.Receipt)
                {
                    return AedsJsonResults.NotFound(aeds, "article_revision_compare_unavailable");
                }
                linked.Token.ThrowIfCancellationRequested();
                return Ok(context, aeds, response);
            }
            catch (OperationCanceledException)
            {
                return AedsJsonResults.NotFound(aeds, "article_revision_compare_unavailable");
            }
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

            Result<ArticleMutationResult> rollback = await service.RollbackRevisionAsync(
                ResolveRequiredAdminPrincipalId(context),
                articleId,
                revisionId,
                parsed.Value!,
                cancellationToken);
            if (!rollback.IsSuccess)
            {
                return BinaryResults.FromError(rollback.Error, aeds);
            }

            return BinaryResults.Frame(
                aeds,
                AedsFrameType.MutationId,
                writer => PodBinaryCodec.WriteArticleMutationResult(rollback.Value, writer));
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
                        ApiErrorTransportMappingId.Default409Conflict,
                        "article_responsibility_version_conflict")
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
            aeds, ApiErrorSemanticMapper.RequireTransportMappingId(StatusCodes.Status409Conflict, ErrorCode.Conflict));
}
