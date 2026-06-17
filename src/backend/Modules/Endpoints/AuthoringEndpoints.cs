using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.Security;
using FsusBlog.Core.Common;
using SqlSugar;

namespace FsusBlog.Server.Modules.Endpoints;

public static class AuthoringEndpoints
{
    private const string AdminSensitiveAction = "admin-sensitive";
    private const string MfaProofHeader = "X-Fsus-Mfa-Proof";
    private static readonly string[] MainlandMandatoryDictionaryIds =
    [
        "cn-mainland.political-sensitive",
        "cn-mainland.porn-strict",
        "cn-mainland.public-order",
        "cn-mainland.national-security"
    ];

    public static IEndpointRouteBuilder MapAuthoringEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup(BinaryBridgeInternalRequest.AuthoringPrefix)
            .WithTags("Authoring")
            .RequireAuthorization(policy => policy.RequireRole("admin"))
            .AddEndpointFilter<BinaryBridgeInternalOnlyFilter>();

        group.MapPost("/drafts", async (
            ServerDraftSaveRequest request,
            HttpContext context,
            AuthoringWorkflowService service,
            CancellationToken cancellationToken) =>
        {
            ServerDraftResponse saved = await service.SaveDraftAsync(context.GetUserId(), request, cancellationToken);
            return Results.Ok(JsonApiResponse<ServerDraftResponse>.Ok(saved));
        });

        group.MapGet("/drafts/{draftKey}", async (
            string draftKey,
            HttpContext context,
            AuthoringWorkflowService service,
            CancellationToken cancellationToken) =>
        {
            ServerDraftResponse? draft = await service.GetDraftAsync(context.GetUserId(), draftKey, cancellationToken);
            return Results.Ok(JsonApiResponse<ServerDraftResponse?>.Ok(draft));
        });

        group.MapDelete("/drafts/{draftKey}", async (
            string draftKey,
            HttpContext context,
            AuthoringWorkflowService service,
            CancellationToken cancellationToken) =>
        {
            bool discarded = await service.DiscardDraftAsync(context.GetUserId(), draftKey, cancellationToken);
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
                    context.GetUserId(),
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
            bool rolledBack = await service.RollbackRevisionAsync(context.GetUserId(), articleId, revisionId, cancellationToken);
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

        group.MapGet("/taxonomy/categories", async (ISqlSugarClient db, CancellationToken cancellationToken) =>
            Results.Ok(JsonApiResponse<IReadOnlyList<AdminCategoryItemResponse>>.Ok(await ListAdminCategoriesAsync(db, cancellationToken))));

        group.MapGet("/taxonomy/tags", async (ISqlSugarClient db, CancellationToken cancellationToken) =>
            Results.Ok(JsonApiResponse<IReadOnlyList<AdminTagItemResponse>>.Ok(await ListAdminTagsAsync(db, cancellationToken))));

        group.MapGet("/analytics", async (AuthoringWorkflowService service, CancellationToken cancellationToken) =>
            Results.Ok(JsonApiResponse<AuthorAnalyticsResponse>.Ok(await service.GetAnalyticsAsync(cancellationToken))));

        group.MapGet("/moderation/overview", async (
            ISqlSugarClient db,
            IModerationDictionaryService dictionaryService,
            IConfiguration configuration,
            CancellationToken cancellationToken) =>
        {
            ModerationDictionaryRuntimeSnapshot snapshot = dictionaryService.GetRuntimeSnapshot();
            int pending = await db.Queryable<Comment>().Where(static item => item.ModerationStatus == CommentModerationStatus.Pending && !item.IsDeleted).CountAsync(cancellationToken);
            int rejected = await db.Queryable<Comment>().Where(static item => item.ModerationStatus == CommentModerationStatus.Rejected && !item.IsDeleted).CountAsync(cancellationToken);
            int hidden = await db.Queryable<Comment>().Where(static item => item.ModerationStatus == CommentModerationStatus.Hidden && !item.IsDeleted).CountAsync(cancellationToken);
            var response = new ModerationOverviewResponse(
                pending,
                rejected,
                hidden,
                snapshot.Dictionaries.Count,
                snapshot.RegionPolicies.Count,
                ResolveMainlandStrictStatus(snapshot),
                snapshot.LastError,
                configuration.GetValue<bool>("Moderation:AntiSpamModel:Enabled"),
                NormalizeModerationProvider(configuration["Moderation:AntiSpamModel:Provider"]),
                configuration["Moderation:AntiSpamModel:Mode"] ?? "score-only",
                configuration["Moderation:AntiSpamModel:ContractVersion"] ?? AntiSpamModerationContract.DefaultVersion,
                Math.Clamp(configuration.GetValue<int?>("Moderation:AntiSpamModel:TimeoutMs") ?? 800, 100, 10_000));
            return Results.Ok(JsonApiResponse<ModerationOverviewResponse>.Ok(response));
        });

        group.MapGet("/moderation/anonymous-comment-policy", (
            IAnonymousCommentPolicyService policyService) =>
            Results.Ok(JsonApiResponse<AnonymousCommentPolicySnapshot>.Ok(policyService.Current)))
        .RequireAdminPermission(AdminPermissions.AnonymousCommentConfigure)
        .RequireRateLimiting("fixed_ip");

        group.MapPut("/moderation/anonymous-comment-policy", async (
            AnonymousCommentPolicyUpdateRequest request,
            HttpContext context,
            IMfaChallengeService mfaChallengeService,
            IAnonymousCommentPolicyService policyService,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, mfaChallengeService);
            if (stepUp is not null)
            {
                return stepUp;
            }

            AnonymousCommentPolicySnapshot snapshot = policyService.UpdatePolicy(request, context.GetUserId());
            await auditEvents.RecordHighValueAsync(new AuditEvent(
                AuditSourceCatalog.Admin,
                AuditTypeCatalog.Audit,
                AuditActionCatalog.AnonymousCommentPolicyUpdated,
                AuditOutcomeCatalog.Success,
                AuditSeverityCatalog.Warning,
                "管理员调整匿名评论策略",
                TargetType: "anonymous_comment_policy",
                TargetId: "current",
                ReasonCode: request.Reason ?? request.DefaultAuthorMode ?? snapshot.SnapshotHash,
                Context: new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["snapshotHash"] = snapshot.SnapshotHash,
                    ["changedBy"] = snapshot.ChangedBy,
                    ["reason"] = request.Reason ?? snapshot.Reason,
                    ["anonymousCommentsEnabled"] = snapshot.AnonymousCommentsEnabled,
                    ["publicCommentsEnabled"] = snapshot.PublicCommentsEnabled,
                    ["zkAnonymousEnabled"] = snapshot.ZkAnonymousEnabled,
                    ["defaultAuthorMode"] = snapshot.DefaultAuthorMode,
                    ["supportedDisplayLanguages"] = snapshot.SupportedDisplayLanguages
                }), cancellationToken);
            return Results.Ok(JsonApiResponse<AnonymousCommentPolicySnapshot>.Ok(snapshot));
        })
        .RequireAdminPermission(AdminPermissions.AnonymousCommentConfigure)
        .RequireRateLimiting("fixed_ip");

        group.MapPost("/comments/moderation/nullifiers/block", async (
            AnonymousNullifierBlockRequest request,
            HttpContext context,
            IMfaChallengeService mfaChallengeService,
            ICommentAnonymousNullifierService nullifierService,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, mfaChallengeService);
            if (stepUp is not null)
            {
                return stepUp;
            }

            string reason = string.IsNullOrWhiteSpace(request.Reason) ? "blocked_by_admin" : request.Reason.Trim();
            bool applied = await nullifierService.BlockAsync(request.NullifierHash, request.Scope, reason, cancellationToken);
            await auditEvents.RecordHighValueAsync(new AuditEvent(
                AuditSourceCatalog.Admin,
                AuditTypeCatalog.Audit,
                AuditActionCatalog.AnonymousNullifierBlocked,
                applied ? AuditOutcomeCatalog.Success : AuditOutcomeCatalog.Failure,
                applied ? AuditSeverityCatalog.Warning : AuditSeverityCatalog.Error,
                "管理员封禁匿名评论 nullifier",
                TargetType: "comment_anonymous_nullifier",
                TargetId: request.NullifierHash,
                ReasonCode: reason,
                Context: new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["scope"] = request.Scope,
                    ["applied"] = applied
                }), cancellationToken);
            return applied
                ? Results.Ok(JsonApiResponse<AnonymousGovernanceActionResponse>.Ok(new AnonymousGovernanceActionResponse(true)))
                : Results.NotFound(JsonApiResponse<AnonymousGovernanceActionResponse>.Fail("anonymous_nullifier_not_found"));
        })
        .RequireAdminPermission(AdminPermissions.AnonymousNullifierBlock)
        .RequireRateLimiting("fixed_ip");

        group.MapPost("/comments/moderation/anonymous-credentials/{credentialId:long}/revoke", async (
            long credentialId,
            AnonymousCredentialRevokeRequest request,
            HttpContext context,
            IMfaChallengeService mfaChallengeService,
            IAnonymousCredentialService credentialService,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, mfaChallengeService);
            if (stepUp is not null)
            {
                return stepUp;
            }

            bool revoked = await credentialService.RevokeAsync(credentialId, cancellationToken);
            await auditEvents.RecordHighValueAsync(new AuditEvent(
                AuditSourceCatalog.Admin,
                AuditTypeCatalog.Audit,
                AuditActionCatalog.AnonymousCredentialRevoked,
                revoked ? AuditOutcomeCatalog.Success : AuditOutcomeCatalog.Failure,
                revoked ? AuditSeverityCatalog.Warning : AuditSeverityCatalog.Error,
                "管理员撤销匿名凭证",
                TargetType: "anonymous_credential",
                TargetId: credentialId.ToString(System.Globalization.CultureInfo.InvariantCulture),
                ReasonCode: request.Reason,
                Context: new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["credentialId"] = credentialId,
                    ["revoked"] = revoked
                }), cancellationToken);
            return revoked
                ? Results.Ok(JsonApiResponse<AnonymousGovernanceActionResponse>.Ok(new AnonymousGovernanceActionResponse(true)))
                : Results.NotFound(JsonApiResponse<AnonymousGovernanceActionResponse>.Fail("anonymous_credential_not_found"));
        })
        .RequireAdminPermission(AdminPermissions.AnonymousCredentialRevoke)
        .RequireRateLimiting("fixed_ip");

        group.MapGet("/moderation/dictionaries", (IModerationDictionaryService dictionaryService) =>
            Results.Ok(JsonApiResponse<ModerationDictionaryRuntimeSnapshot>.Ok(dictionaryService.GetRuntimeSnapshot())));

        group.MapGet("/moderation/runtime/status", (IModerationRuntimeStateService runtimeState) =>
            Results.Ok(JsonApiResponse<ModerationRuntimeStatusResponse>.Ok(ToModerationRuntimeStatusResponse(runtimeState.Current))));

        group.MapPost("/moderation/runtime/global-state", async (
            ModerationRuntimeGlobalStateRequest request,
            HttpContext context,
            IMfaChallengeService mfaChallengeService,
            IModerationRuntimeStateService runtimeState,
            IAuditEventService auditEvents,
            ICacheInvalidationDispatcher cacheInvalidation,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, mfaChallengeService);
            if (stepUp is not null)
            {
                return stepUp;
            }

            Result<ModerationRuntimeSnapshot> result = runtimeState.SetGlobalState(
                request.State,
                request.Reason,
                request.ExpiresAtUtc,
                context.GetUserId().ToString(System.Globalization.CultureInfo.InvariantCulture));
            return await CompleteModerationRuntimeMutationAsync(
                result,
                auditEvents,
                cacheInvalidation,
                "admin.moderation.runtime_global_state_changed",
                "管理员调整评论审核全局运行状态",
                "moderation_runtime",
                result.IsSuccess ? result.Value!.SnapshotId : "global",
                request.Reason ?? request.State,
                cancellationToken);
        })
        .RequireRateLimiting("fixed_ip");

        group.MapPost("/moderation/runtime/region-state", async (
            ModerationRuntimeRegionStateRequest request,
            HttpContext context,
            IMfaChallengeService mfaChallengeService,
            IModerationRuntimeStateService runtimeState,
            IAuditEventService auditEvents,
            ICacheInvalidationDispatcher cacheInvalidation,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, mfaChallengeService);
            if (stepUp is not null)
            {
                return stepUp;
            }

            Result<ModerationRuntimeSnapshot> result = runtimeState.SetRegionState(
                request.Region,
                request.State,
                request.Reason,
                request.ExpiresAtUtc,
                request.ConfirmPhrase,
                context.GetUserId().ToString(System.Globalization.CultureInfo.InvariantCulture));
            return await CompleteModerationRuntimeMutationAsync(
                result,
                auditEvents,
                cacheInvalidation,
                "admin.moderation.runtime_region_state_changed",
                "管理员调整评论审核地区运行状态",
                "moderation_region_runtime",
                request.Region,
                request.Reason ?? request.State,
                cancellationToken);
        })
        .RequireRateLimiting("fixed_ip");

        group.MapPost("/moderation/dictionaries/reload", async (
            HttpContext context,
            IMfaChallengeService mfaChallengeService,
            IModerationDictionaryService dictionaryService,
            IAuditEventService auditEvents,
            ICacheInvalidationDispatcher cacheInvalidation,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, mfaChallengeService);
            if (stepUp is not null)
            {
                return stepUp;
            }

            Result result = dictionaryService.Reload();
            ModerationDictionaryRuntimeSnapshot snapshot = dictionaryService.GetRuntimeSnapshot();
            var response = new ModerationDictionaryReloadResponse(
                result.IsSuccess,
                snapshot.SnapshotId,
                snapshot.Checksum,
                result.IsSuccess ? null : result.Error.Message,
                DateTime.UtcNow);
            await auditEvents.RecordHighValueAsync(new AuditEvent(
                AuditSourceCatalog.Admin,
                AuditTypeCatalog.Security,
                "admin.moderation.dictionary_reloaded",
                result.IsSuccess ? AuditOutcomeCatalog.Success : AuditOutcomeCatalog.Failure,
                result.IsSuccess ? AuditSeverityCatalog.Warning : AuditSeverityCatalog.Error,
                "管理员重载审核词库快照",
                TargetType: "moderation_dictionary_snapshot",
                TargetId: snapshot.SnapshotId,
                ReasonCode: result.IsSuccess ? "dictionary_reload" : "dictionary_reload_failed",
                Context: new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["snapshotId"] = snapshot.SnapshotId,
                    ["checksum"] = snapshot.Checksum,
                    ["dictionaryCount"] = snapshot.Dictionaries.Count,
                    ["regionPolicyCount"] = snapshot.RegionPolicies.Count,
                    ["error"] = response.Error
                }), cancellationToken);

            if (result.IsSuccess)
            {
                await cacheInvalidation.InvalidateCommentMutationAsync(null, cancellationToken);
            }

            return result.IsSuccess
                ? Results.Ok(JsonApiResponse<ModerationDictionaryReloadResponse>.Ok(response))
                : Results.Json(
                    JsonApiResponse<ModerationDictionaryReloadResponse>.Fail("moderation_dictionary_reload_failed"),
                    statusCode: StatusCodes.Status500InternalServerError);
        })
        .RequireRateLimiting("fixed_ip");

        group.MapPost("/moderation/dictionaries/rollback", async (
            HttpContext context,
            IMfaChallengeService mfaChallengeService,
            IModerationDictionaryService dictionaryService,
            IAuditEventService auditEvents,
            ICacheInvalidationDispatcher cacheInvalidation,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, mfaChallengeService);
            if (stepUp is not null)
            {
                return stepUp;
            }

            Result result = dictionaryService.Rollback();
            ModerationDictionaryRuntimeSnapshot snapshot = dictionaryService.GetRuntimeSnapshot();
            await auditEvents.RecordHighValueAsync(new AuditEvent(
                AuditSourceCatalog.Admin,
                AuditTypeCatalog.Security,
                "admin.moderation.dictionary_rolled_back",
                result.IsSuccess ? AuditOutcomeCatalog.Success : AuditOutcomeCatalog.Failure,
                result.IsSuccess ? AuditSeverityCatalog.Warning : AuditSeverityCatalog.Error,
                "管理员回滚审核词库快照",
                TargetType: "moderation_dictionary_snapshot",
                TargetId: snapshot.SnapshotId,
                ReasonCode: result.IsSuccess ? "dictionary_rollback" : result.Error.Message,
                Context: new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["snapshotId"] = snapshot.SnapshotId,
                    ["checksum"] = snapshot.Checksum,
                    ["dictionaryCount"] = snapshot.Dictionaries.Count,
                    ["regionPolicyCount"] = snapshot.RegionPolicies.Count,
                    ["error"] = result.IsSuccess ? null : result.Error.Message
                }), cancellationToken);

            if (result.IsSuccess)
            {
                await cacheInvalidation.InvalidateCommentMutationAsync(null, cancellationToken);
                return Results.Ok(JsonApiResponse<ModerationDictionaryRuntimeSnapshot>.Ok(snapshot));
            }

            return Results.Json(
                JsonApiResponse<ModerationDictionaryRuntimeSnapshot>.Fail(result.Error.Message),
                statusCode: ToHttpStatusCode(result.Error.Code));
        })
        .RequireRateLimiting("fixed_ip");

        group.MapPost("/moderation/dictionaries/{dictionaryId}/enable", async (
            string dictionaryId,
            ModerationDictionaryStateRequest request,
            HttpContext context,
            IMfaChallengeService mfaChallengeService,
            IModerationRuntimeStateService runtimeState,
            IAuditEventService auditEvents,
            ICacheInvalidationDispatcher cacheInvalidation,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, mfaChallengeService);
            if (stepUp is not null)
            {
                return stepUp;
            }

            Result<ModerationRuntimeSnapshot> result = runtimeState.SetDictionaryState(
                dictionaryId,
                enabled: true,
                request.Reason,
                request.ConfirmPhrase,
                context.GetUserId().ToString(System.Globalization.CultureInfo.InvariantCulture));
            return await CompleteModerationRuntimeMutationAsync(
                result,
                auditEvents,
                cacheInvalidation,
                "admin.moderation.dictionary_enabled",
                "管理员启用审核词库",
                "moderation_dictionary",
                dictionaryId,
                request.Reason ?? "dictionary_enable",
                cancellationToken);
        })
        .RequireRateLimiting("fixed_ip");

        group.MapPost("/moderation/dictionaries/{dictionaryId}/disable", async (
            string dictionaryId,
            ModerationDictionaryStateRequest request,
            HttpContext context,
            IMfaChallengeService mfaChallengeService,
            IModerationRuntimeStateService runtimeState,
            IAuditEventService auditEvents,
            ICacheInvalidationDispatcher cacheInvalidation,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, mfaChallengeService);
            if (stepUp is not null)
            {
                return stepUp;
            }

            Result<ModerationRuntimeSnapshot> result = runtimeState.SetDictionaryState(
                dictionaryId,
                enabled: false,
                request.Reason,
                request.ConfirmPhrase,
                context.GetUserId().ToString(System.Globalization.CultureInfo.InvariantCulture));
            return await CompleteModerationRuntimeMutationAsync(
                result,
                auditEvents,
                cacheInvalidation,
                "admin.moderation.dictionary_disabled",
                "管理员禁用审核词库",
                "moderation_dictionary",
                dictionaryId,
                request.Reason ?? "dictionary_disable",
                cancellationToken);
        })
        .RequireRateLimiting("fixed_ip");

        group.MapGet("/moderation/policies", (IModerationDictionaryService dictionaryService) =>
        {
            ModerationDictionaryRuntimeSnapshot snapshot = dictionaryService.GetRuntimeSnapshot();
            RegionPolicySummaryResponse[] policies = [.. snapshot.RegionPolicies.Select(policy => new RegionPolicySummaryResponse(
                policy.Region,
                policy.Version,
                policy.Inherits,
                policy.DictionaryIds,
                policy.Checksum,
                policy.RuleCount,
                BuildRegionPolicyChecks(policy)))];
            return Results.Ok(JsonApiResponse<IReadOnlyList<RegionPolicySummaryResponse>>.Ok(policies));
        });

        group.MapGet("/moderation/regions", (IModerationRegionCatalogService regionCatalog) =>
        {
            ModerationRegionCatalogSnapshot snapshot = regionCatalog.GetRuntimeSnapshot();
            return Results.Ok(JsonApiResponse<IReadOnlyList<ModerationRegionDefinition>>.Ok(snapshot.Regions));
        });

        group.MapGet("/moderation/region-groups", (IModerationRegionCatalogService regionCatalog) =>
        {
            ModerationRegionCatalogSnapshot snapshot = regionCatalog.GetRuntimeSnapshot();
            return Results.Ok(JsonApiResponse<IReadOnlyList<ModerationRegionGroupDefinition>>.Ok(snapshot.RegionGroups));
        });

        group.MapGet("/moderation/policy-templates", (IModerationRegionCatalogService regionCatalog) =>
        {
            ModerationRegionCatalogSnapshot snapshot = regionCatalog.GetRuntimeSnapshot();
            return Results.Ok(JsonApiResponse<IReadOnlyList<ModerationPolicyTemplateDefinition>>.Ok(snapshot.PolicyTemplates));
        });

        group.MapGet("/moderation/effective-policy/{regionCode}", async (
            string regionCode,
            IModerationRegionCatalogService regionCatalog,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            ModerationEffectivePolicyPreview preview = regionCatalog.PreviewEffectivePolicy(regionCode);
            await RecordEffectivePolicyPreviewAuditAsync(preview, auditEvents, cancellationToken);
            return Results.Ok(JsonApiResponse<ModerationEffectivePolicyPreview>.Ok(preview));
        })
        .RequireRateLimiting("fixed_ip");

        group.MapPost("/moderation/effective-policy/preview", async (
            ModerationEffectivePolicyPreviewRequest request,
            IModerationRegionCatalogService regionCatalog,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            ModerationEffectivePolicyPreview preview = regionCatalog.PreviewEffectivePolicy(request.RegionCode, request.OperatorOverrides);
            await RecordEffectivePolicyPreviewAuditAsync(preview, auditEvents, cancellationToken);
            return Results.Ok(JsonApiResponse<ModerationEffectivePolicyPreview>.Ok(preview));
        })
        .RequireRateLimiting("fixed_ip");

        group.MapGet("/moderation/model/status", async (
            IConfiguration configuration,
            IModerationRuntimeStateService runtimeState,
            ISqlSugarClient db,
            CancellationToken cancellationToken) =>
        {
            ModerationModelRuntimeSnapshot runtimeModel = runtimeState.CurrentModel;
            List<DateTime> lastSuccess = await db.Queryable<CommentModerationSignal>()
                .Where(static signal => signal.Status == "ok")
                .OrderBy(static signal => signal.CreatedAtUtc, OrderByType.Desc)
                .Take(1)
                .Select(static signal => signal.CreatedAtUtc)
                .ToListAsync(cancellationToken);
            List<ModerationModelErrorRow> lastError = await db.Queryable<CommentModerationSignal>()
                .Where(static signal => signal.Status != "ok" || signal.ErrorCode != null)
                .OrderBy(static signal => signal.CreatedAtUtc, OrderByType.Desc)
                .Take(1)
                .Select(static signal => new ModerationModelErrorRow
                {
                    ErrorCode = signal.ErrorCode,
                    CreatedAtUtc = signal.CreatedAtUtc
                })
                .ToListAsync(cancellationToken);
            List<int> latencies = await db.Queryable<CommentModerationSignal>()
                .OrderBy(static signal => signal.CreatedAtUtc, OrderByType.Desc)
                .Take(100)
                .Select(static signal => signal.LatencyMs)
                .ToListAsync(cancellationToken);

            var response = new ModerationModelStatusResponse(
                runtimeState.IsModelEnabled,
                NormalizeModerationProvider(runtimeModel.Provider),
                configuration["Moderation:AntiSpamModel:Mode"] ?? "score-only",
                runtimeModel.ContractVersion,
                runtimeModel.TimeoutMs,
                runtimeModel.FailOpen,
                runtimeModel.ExternalProviderAllowed,
                runtimeModel.ExternalProviderReviewed,
                lastSuccess.Count > 0 ? lastSuccess[0] : null,
                lastError.Count > 0 ? lastError[0].ErrorCode : null,
                lastError.Count > 0 ? lastError[0].CreatedAtUtc : null,
                latencies.Count > 0 ? Math.Round(latencies.Average(), 2) : 0d,
                ResolveP95Latency(latencies));
            return Results.Ok(JsonApiResponse<ModerationModelStatusResponse>.Ok(response));
        });

        group.MapPost("/moderation/model/runtime", async (
            ModerationModelRuntimeRequest request,
            HttpContext context,
            IMfaChallengeService mfaChallengeService,
            IModerationRuntimeStateService runtimeState,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, mfaChallengeService);
            if (stepUp is not null)
            {
                return stepUp;
            }

            Result<ModerationRuntimeSnapshot> result = runtimeState.SetModelRuntime(
                request.Enabled,
                request.Provider,
                request.ModelProfile,
                request.ThresholdProfile,
                request.Reason,
                context.GetUserId().ToString(System.Globalization.CultureInfo.InvariantCulture));
            return await CompleteModerationRuntimeMutationAsync(
                result,
                auditEvents,
                null,
                "admin.moderation.model_runtime_changed",
                "管理员调整反垃圾模型运行状态",
                "moderation_model_runtime",
                result.IsSuccess ? result.Value!.Model.SnapshotId : "model",
                request.Reason ?? request.Provider ?? "model_runtime",
                cancellationToken);
        })
        .RequireRateLimiting("fixed_ip");

        group.MapPost("/moderation/model/reload", async (
            HttpContext context,
            IMfaChallengeService mfaChallengeService,
            IModerationRuntimeStateService runtimeState,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, mfaChallengeService);
            if (stepUp is not null)
            {
                return stepUp;
            }

            Result<ModerationRuntimeSnapshot> result = runtimeState.ReloadModel(context.GetUserId().ToString(System.Globalization.CultureInfo.InvariantCulture));
            return await CompleteModerationRuntimeMutationAsync(
                result,
                auditEvents,
                null,
                "admin.moderation.model_reloaded",
                "管理员重载反垃圾模型运行快照",
                "moderation_model_runtime",
                result.IsSuccess ? result.Value!.Model.SnapshotId : "model",
                "model_reload",
                cancellationToken);
        })
        .RequireRateLimiting("fixed_ip");

        group.MapPost("/moderation/model/rollback", async (
            HttpContext context,
            IMfaChallengeService mfaChallengeService,
            IModerationRuntimeStateService runtimeState,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, mfaChallengeService);
            if (stepUp is not null)
            {
                return stepUp;
            }

            Result<ModerationRuntimeSnapshot> result = runtimeState.RollbackModel(context.GetUserId().ToString(System.Globalization.CultureInfo.InvariantCulture));
            return await CompleteModerationRuntimeMutationAsync(
                result,
                auditEvents,
                null,
                "admin.moderation.model_rolled_back",
                "管理员回滚反垃圾模型运行快照",
                "moderation_model_runtime",
                result.IsSuccess ? result.Value!.Model.SnapshotId : "model",
                "model_rollback",
                cancellationToken);
        })
        .RequireRateLimiting("fixed_ip");

        group.MapPost("/moderation/replay/preview", async (
            ModerationReplayPreviewRequest request,
            ISqlSugarClient db,
            IRegionLegalModerationService regionLegalModerationService,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            ModerationReplayPreviewResponse response = await BuildModerationReplayPreviewAsync(
                request,
                db,
                regionLegalModerationService,
                cancellationToken);
            await auditEvents.RecordAsync(new AuditEvent(
                AuditSourceCatalog.Admin,
                AuditTypeCatalog.Security,
                "admin.moderation.replay_previewed",
                AuditOutcomeCatalog.Success,
                response.HighRiskChangeCount > 0 ? AuditSeverityCatalog.Warning : AuditSeverityCatalog.Info,
                "管理员预览地区策略回放影响",
                TargetType: "moderation_region_policy_replay",
                TargetId: response.PolicyVersion,
                Context: new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["region"] = response.Region,
                    ["policyVersion"] = response.PolicyVersion,
                    ["dictionaryId"] = response.DictionaryId,
                    ["scannedCount"] = response.ScannedCount,
                    ["affectedCommentCount"] = response.AffectedCommentCount,
                    ["publicVisibilityChangedCount"] = response.PublicVisibilityChangedCount,
                    ["highRiskChangeCount"] = response.HighRiskChangeCount
                }), cancellationToken);

            return Results.Ok(JsonApiResponse<ModerationReplayPreviewResponse>.Ok(response));
        })
        .RequireRateLimiting("fixed_ip");

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
        .RequireAdminPermission(AdminPermissions.CommentModerate)
        .RequireRateLimiting("fixed_ip");

        group.MapPost("/comments/moderation/bulk", async (
            CommentModerationBulkRequest request,
            HttpContext context,
            IMfaChallengeService mfaChallengeService,
            AuthoringWorkflowService service,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, mfaChallengeService);
            if (stepUp is not null)
            {
                return stepUp;
            }

            CommentModerationBulkResponse response = await service.ModerateCommentsAsync(context.GetUserId(), request, cancellationToken);
            await auditEvents.RecordHighValueAsync(new AuditEvent(
                AuditSourceCatalog.Admin,
                AuditTypeCatalog.Audit,
                AuditActionCatalog.CommentBulkModerated,
                AuditOutcomeCatalog.Success,
                AuditSeverityCatalog.Warning,
                "管理员批量审核评论",
                TargetType: "comment",
                TargetId: string.Join(',', request.CommentIds),
                ReasonCode: request.Reason,
                Context: new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["status"] = request.Status,
                    ["commentCount"] = request.CommentIds.Count,
                    ["updated"] = response.Updated,
                    ["bannedUsers"] = response.BannedUsers,
                    ["banUsers"] = request.BanUsers
                }), cancellationToken);
            return Results.Ok(JsonApiResponse<CommentModerationBulkResponse>.Ok(response));
        })
        .RequireAdminPermission(AdminPermissions.CommentModerate)
        .RequireRateLimiting("fixed_ip");

        group.MapPost("/comments/{commentId:long}/moderation", async (
            long commentId,
            CommentModerationRequest request,
            HttpContext context,
            IMfaChallengeService mfaChallengeService,
            AuthoringWorkflowService service,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, mfaChallengeService);
            if (stepUp is not null)
            {
                return stepUp;
            }

            bool moderated = await service.ModerateCommentAsync(context.GetUserId(), commentId, request, cancellationToken);
            await auditEvents.RecordHighValueAsync(new AuditEvent(
                AuditSourceCatalog.Admin,
                AuditTypeCatalog.Audit,
                AuditActionCatalog.CommentModerated,
                moderated ? AuditOutcomeCatalog.Success : AuditOutcomeCatalog.Failure,
                moderated ? AuditSeverityCatalog.Warning : AuditSeverityCatalog.Error,
                "管理员审核评论",
                TargetType: "comment",
                TargetId: commentId.ToString(System.Globalization.CultureInfo.InvariantCulture),
                ReasonCode: request.Reason,
                Context: new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["status"] = request.Status,
                    ["banUser"] = request.BanUser
                }), cancellationToken);
            return moderated
                ? Results.Ok(JsonApiResponse<object>.Ok(new { moderated }))
                : Results.NotFound(JsonApiResponse<object>.Fail("comment_not_found"));
        })
        .RequireAdminPermission(AdminPermissions.CommentModerate)
        .RequireRateLimiting("fixed_ip");

        group.MapGet("/content/export", async (
            HttpContext context,
            AuthoringWorkflowService service,
            IMfaChallengeService mfaChallengeService,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, mfaChallengeService);
            if (stepUp is not null)
            {
                return stepUp;
            }

            ContentBackupExportResponse response = await service.ExportContentBackupAsync(cancellationToken);
            await auditEvents.RecordHighValueAsync(new AuditEvent(
                AuditSourceCatalog.Admin,
                AuditTypeCatalog.Audit,
                AuditActionCatalog.ContentExported,
                AuditOutcomeCatalog.Success,
                AuditSeverityCatalog.Warning,
                "管理员导出全量内容备份",
                TargetType: "content_backup",
                TargetId: response.FileName,
                Context: new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["articleCount"] = response.Articles.Count,
                    ["exportedAt"] = response.ExportedAt
                }), cancellationToken);
            return Results.Ok(JsonApiResponse<ContentBackupExportResponse>.Ok(response));
        });

        group.MapGet("/articles/{articleId:int}/export", async (
            int articleId,
            AuthoringWorkflowService service,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            ContentExportResponse? exported = await service.ExportArticleAsync(articleId, cancellationToken);
            await auditEvents.RecordHighValueAsync(new AuditEvent(
                AuditSourceCatalog.Admin,
                AuditTypeCatalog.Audit,
                AuditActionCatalog.ArticleExported,
                exported is null ? AuditOutcomeCatalog.Failure : AuditOutcomeCatalog.Success,
                exported is null ? AuditSeverityCatalog.Error : AuditSeverityCatalog.Warning,
                "管理员导出文章内容",
                TargetType: "article",
                TargetId: articleId.ToString(System.Globalization.CultureInfo.InvariantCulture),
                Context: exported is null
                    ? null
                    : new Dictionary<string, object?>(StringComparer.Ordinal)
                    {
                        ["fileName"] = exported.FileName,
                        ["revisionCount"] = exported.Metadata.RevisionCount
                    }), cancellationToken);
            return exported is null
                ? Results.NotFound(JsonApiResponse<ContentExportResponse>.Fail("article_not_found"))
                : Results.Ok(JsonApiResponse<ContentExportResponse>.Ok(exported));
        });

        group.MapPost("/articles/import", async (
            ContentImportRequest request,
            AuthoringWorkflowService service,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            ContentImportResponse response = await service.ImportArticleAsync(request, cancellationToken);
            await auditEvents.RecordHighValueAsync(new AuditEvent(
                AuditSourceCatalog.Admin,
                AuditTypeCatalog.Audit,
                AuditActionCatalog.ArticleImported,
                AuditOutcomeCatalog.Success,
                AuditSeverityCatalog.Warning,
                "管理员导入文章内容",
                TargetType: "article",
                TargetId: response.ArticleId.ToString(System.Globalization.CultureInfo.InvariantCulture),
                Context: new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["publish"] = request.Publish,
                    ["preserveRevisions"] = request.PreserveRevisions,
                    ["restoredRevisionCount"] = response.RestoredRevisionCount
                }), cancellationToken);
            return Results.Ok(JsonApiResponse<ContentImportResponse>.Ok(response));
        });

        group.MapGet("/audit", async (
            int? page,
            int? pageSize,
            string? source,
            string? type,
            string? actor,
            string? action,
            string? targetType,
            string? targetId,
            string? outcome,
            string? severity,
            DateTime? fromUtc,
            DateTime? toUtc,
            AuditQueryService auditQuery,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            AuditLogQueryRequest query = BuildAuditLogQuery(page, pageSize, source, type, actor, action, targetType, targetId, outcome, severity, fromUtc, toUtc);
            AuditLogListResponse response = await auditQuery.ListAsync(query, cancellationToken);
            await auditEvents.RecordAsync(new AuditEvent(
                AuditSourceCatalog.Admin,
                AuditTypeCatalog.Audit,
                AuditActionCatalog.AuditQueried,
                AuditOutcomeCatalog.Success,
                AuditSeverityCatalog.Info,
                "管理员查询审计日志列表",
                TargetType: "audit_log",
                Context: BuildAuditQueryContext(query)), cancellationToken);
            return Results.Ok(JsonApiResponse<AuditLogListResponse>.Ok(response));
        })
        .RequireRateLimiting("fixed_ip");

        group.MapGet("/audit/summary", async (
            string? source,
            string? type,
            string? actor,
            string? action,
            string? targetType,
            string? targetId,
            string? outcome,
            string? severity,
            DateTime? fromUtc,
            DateTime? toUtc,
            AuditQueryService auditQuery,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            AuditLogQueryRequest query = BuildAuditLogQuery(1, 1, source, type, actor, action, targetType, targetId, outcome, severity, fromUtc, toUtc);
            AuditLogSummaryResponse response = await auditQuery.GetSummaryAsync(query, cancellationToken);
            await auditEvents.RecordAsync(new AuditEvent(
                AuditSourceCatalog.Admin,
                AuditTypeCatalog.Audit,
                AuditActionCatalog.AuditQueried,
                AuditOutcomeCatalog.Success,
                AuditSeverityCatalog.Info,
                "管理员查询审计日志汇总",
                TargetType: "audit_log_summary",
                Context: BuildAuditQueryContext(query)), cancellationToken);
            return Results.Ok(JsonApiResponse<AuditLogSummaryResponse>.Ok(response));
        })
        .RequireRateLimiting("fixed_ip");

        group.MapGet("/audit/{id:long}", async (
            long id,
            AuditQueryService auditQuery,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            AuditLogDetailResponse? response = await auditQuery.GetAsync(id, cancellationToken);
            await auditEvents.RecordAsync(new AuditEvent(
                AuditSourceCatalog.Admin,
                AuditTypeCatalog.Audit,
                AuditActionCatalog.AuditQueried,
                response is null ? AuditOutcomeCatalog.Failure : AuditOutcomeCatalog.Success,
                response is null ? AuditSeverityCatalog.Warning : AuditSeverityCatalog.Info,
                "管理员查看审计日志详情",
                TargetType: "audit_log",
                TargetId: id.ToString(System.Globalization.CultureInfo.InvariantCulture)), cancellationToken);
            return response is null
                ? Results.NotFound(JsonApiResponse<AuditLogDetailResponse>.Fail("audit_log_not_found"))
                : Results.Ok(JsonApiResponse<AuditLogDetailResponse>.Ok(response));
        })
        .RequireRateLimiting("fixed_ip");

        group.MapGet("/audit/{id:long}/verify", async (
            long id,
            AuditQueryService auditQuery,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            AuditTamperVerifyResponse? response = await auditQuery.VerifyAsync(id, cancellationToken);
            await auditEvents.RecordAsync(new AuditEvent(
                AuditSourceCatalog.Admin,
                AuditTypeCatalog.Audit,
                AuditActionCatalog.AuditQueried,
                response is null ? AuditOutcomeCatalog.Failure : AuditOutcomeCatalog.Success,
                response?.Valid == true ? AuditSeverityCatalog.Info : AuditSeverityCatalog.Warning,
                "管理员校验审计日志防篡改证据",
                TargetType: "audit_log",
                TargetId: id.ToString(System.Globalization.CultureInfo.InvariantCulture)), cancellationToken);
            return response is null
                ? Results.NotFound(JsonApiResponse<AuditTamperVerifyResponse>.Fail("audit_log_not_found"))
                : Results.Ok(JsonApiResponse<AuditTamperVerifyResponse>.Ok(response));
        })
        .RequireRateLimiting("fixed_ip");

        group.MapGet("/ops/health", async (
            AdminOperationsService operations,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            OpsHealthResponse response = await operations.GetOpsHealthAsync(cancellationToken);
            await auditEvents.RecordAsync(new AuditEvent(
                AuditSourceCatalog.Admin,
                AuditTypeCatalog.Infra,
                "admin.ops.health_viewed",
                AuditOutcomeCatalog.Success,
                AuditSeverityCatalog.Info,
                "管理员查看生产运维健康面板",
                TargetType: "ops_health"), cancellationToken);
            return Results.Ok(JsonApiResponse<OpsHealthResponse>.Ok(response));
        })
        .RequireRateLimiting("fixed_ip");

        group.MapGet("/ops/backup", (
            AdminOperationsService operations) =>
            Results.Ok(JsonApiResponse<BackupStatusResponse>.Ok(operations.GetBackupStatus())))
        .RequireRateLimiting("fixed_ip");

        group.MapGet("/ops/dangerous-operations/policy", (
            AdminOperationsService operations) =>
            Results.Ok(JsonApiResponse<DangerousOperationPolicyResponse>.Ok(operations.GetDangerousOperationPolicy())))
        .RequireRateLimiting("fixed_ip");

        group.MapGet("/cache/diagnostics", async (
            int? articleId,
            AdminOperationsService operations,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            CacheDiagnosticsResponse response = await operations.GetCacheDiagnosticsAsync(articleId, cancellationToken);
            await auditEvents.RecordAsync(new AuditEvent(
                AuditSourceCatalog.Admin,
                AuditTypeCatalog.Infra,
                "admin.cache.diagnostics_viewed",
                AuditOutcomeCatalog.Success,
                AuditSeverityCatalog.Info,
                "管理员查看缓存/AOT/search/sitemap 诊断",
                TargetType: "cache_diagnostics",
                TargetId: articleId?.ToString(System.Globalization.CultureInfo.InvariantCulture)), cancellationToken);
            return Results.Ok(JsonApiResponse<CacheDiagnosticsResponse>.Ok(response));
        })
        .RequireRateLimiting("fixed_ip");

        group.MapPost("/cache/actions", async (
            AdminCacheActionRequest request,
            AdminOperationsService operations,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            AdminCacheActionResponse response = await operations.RunCacheActionAsync(request, cancellationToken);
            await auditEvents.RecordHighValueAsync(new AuditEvent(
                AuditSourceCatalog.Admin,
                AuditTypeCatalog.Infra,
                "admin.cache.action_executed",
                response.Status is "ok" or "queued" ? AuditOutcomeCatalog.Success : AuditOutcomeCatalog.Failure,
                response.Status is "ok" or "queued" ? AuditSeverityCatalog.Warning : AuditSeverityCatalog.Error,
                "管理员执行缓存/索引维护动作",
                TargetType: "cache_action",
                TargetId: response.Action,
                Context: new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["articleId"] = request.ArticleId,
                    ["status"] = response.Status,
                    ["detail"] = response.Detail
                }), cancellationToken);
            return Results.Ok(JsonApiResponse<AdminCacheActionResponse>.Ok(response));
        })
        .RequireRateLimiting("fixed_ip");

        group.MapGet("/integrity", async (
            AdminOperationsService operations,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            IntegrityReportResponse response = await operations.InspectIntegrityAsync(cancellationToken);
            await auditEvents.RecordAsync(new AuditEvent(
                AuditSourceCatalog.Admin,
                AuditTypeCatalog.Infra,
                "admin.integrity.checked",
                AuditOutcomeCatalog.Success,
                response.IssueCount > 0 ? AuditSeverityCatalog.Warning : AuditSeverityCatalog.Info,
                "管理员执行数据一致性巡检",
                TargetType: "integrity_report",
                Context: new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["issueCount"] = response.IssueCount,
                    ["checkCount"] = response.CheckCount
                }), cancellationToken);
            return Results.Ok(JsonApiResponse<IntegrityReportResponse>.Ok(response));
        })
        .RequireRateLimiting("fixed_ip");

        group.MapGet("/integrity/fix-preview", async (
            AdminOperationsService operations,
            CancellationToken cancellationToken) =>
            Results.Ok(JsonApiResponse<IntegrityFixPreviewResponse>.Ok(await operations.PreviewIntegrityFixAsync(cancellationToken))))
        .RequireRateLimiting("fixed_ip");

        group.MapPost("/integrity/fix", async (
            IntegrityFixRequest request,
            HttpContext context,
            IMfaChallengeService mfaChallengeService,
            AdminOperationsService operations,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, mfaChallengeService);
            if (stepUp is not null)
            {
                return stepUp;
            }

            IntegrityFixResponse response = await operations.ApplyIntegrityFixAsync(request, cancellationToken);
            await auditEvents.RecordHighValueAsync(new AuditEvent(
                AuditSourceCatalog.Admin,
                AuditTypeCatalog.Infra,
                "admin.integrity.safe_fix_applied",
                response.Status == "applied" ? AuditOutcomeCatalog.Success : AuditOutcomeCatalog.Denied,
                response.Status == "applied" ? AuditSeverityCatalog.Warning : AuditSeverityCatalog.Error,
                "管理员应用数据巡检安全修复",
                TargetType: "integrity_fix",
                Context: new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["status"] = response.Status,
                    ["appliedCount"] = response.AppliedCount,
                    ["codes"] = request.Codes
                }), cancellationToken);
            return Results.Ok(JsonApiResponse<IntegrityFixResponse>.Ok(response));
        })
        .RequireRateLimiting("fixed_ip");

        group.MapPost("/ai-assist", (AiAssistRequest request, HttpContext context, AuthoringWorkflowService service) =>
            Results.Ok(JsonApiResponse<AiAssistResponse>.Ok(service.GenerateAiAssist(context.GetUserId(), request))));

        return app;
    }

    private static Task RecordEffectivePolicyPreviewAuditAsync(
        ModerationEffectivePolicyPreview preview,
        IAuditEventService auditEvents,
        CancellationToken cancellationToken)
        => auditEvents.RecordAsync(new AuditEvent(
            AuditSourceCatalog.Admin,
            AuditTypeCatalog.Security,
            "admin.moderation.effective_policy_previewed",
            AuditOutcomeCatalog.Success,
            preview.Warnings.Count > 0 ? AuditSeverityCatalog.Warning : AuditSeverityCatalog.Info,
            "管理员预览地区 effective policy",
            TargetType: "moderation_effective_policy",
            TargetId: preview.Region,
            Context: new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["region"] = preview.Region,
                ["inheritance"] = preview.Inheritance.Select(static item => item.SourceId).ToArray(),
                ["ruleCount"] = preview.Rules.Count,
                ["checksum"] = preview.Checksum,
                ["warnings"] = preview.Warnings
            }), cancellationToken);

    private static async Task<IResult> CompleteModerationRuntimeMutationAsync(
        Result<ModerationRuntimeSnapshot> result,
        IAuditEventService auditEvents,
        ICacheInvalidationDispatcher? cacheInvalidation,
        string action,
        string eventInfo,
        string targetType,
        string targetId,
        string? reasonCode,
        CancellationToken cancellationToken)
    {
        await auditEvents.RecordHighValueAsync(new AuditEvent(
            AuditSourceCatalog.Admin,
            AuditTypeCatalog.Security,
            action,
            result.IsSuccess ? AuditOutcomeCatalog.Success : AuditOutcomeCatalog.Failure,
            result.IsSuccess ? AuditSeverityCatalog.Warning : AuditSeverityCatalog.Error,
            eventInfo,
            TargetType: targetType,
            TargetId: targetId,
            ReasonCode: result.IsSuccess ? reasonCode : result.Error.Message,
            Context: new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["targetType"] = targetType,
                ["targetId"] = targetId,
                ["reason"] = reasonCode,
                ["errorCode"] = result.IsSuccess ? null : result.Error.Code.ToString(),
                ["error"] = result.IsSuccess ? null : result.Error.Message,
                ["snapshotId"] = result.IsSuccess ? result.Value!.SnapshotId : null,
                ["globalState"] = result.IsSuccess ? result.Value!.GlobalState : null,
                ["regionStateCount"] = result.IsSuccess ? result.Value!.RegionStates.Count : null,
                ["disabledDictionaryCount"] = result.IsSuccess ? result.Value!.DisabledDictionaryIds.Count : null,
                ["modelProvider"] = result.IsSuccess ? result.Value!.Model.Provider : null,
                ["modelEnabled"] = result.IsSuccess ? result.Value!.Model.Enabled : null
            }), cancellationToken);

        if (result.IsFailure)
        {
            return Results.Json(
                JsonApiResponse<ModerationRuntimeStatusResponse>.Fail(result.Error.Message),
                statusCode: ToHttpStatusCode(result.Error.Code));
        }

        if (cacheInvalidation is not null)
        {
            await cacheInvalidation.InvalidateCommentMutationAsync(null, cancellationToken);
        }

        return Results.Ok(JsonApiResponse<ModerationRuntimeStatusResponse>.Ok(ToModerationRuntimeStatusResponse(result.Value!)));
    }

    private static ModerationRuntimeStatusResponse ToModerationRuntimeStatusResponse(ModerationRuntimeSnapshot snapshot)
        => new(
            snapshot.SnapshotId,
            snapshot.GlobalState,
            new Dictionary<string, string>(snapshot.RegionStates, StringComparer.Ordinal),
            snapshot.DisabledDictionaryIds.OrderBy(static item => item, StringComparer.Ordinal).ToArray(),
            ToModerationModelRuntimeResponse(snapshot.Model),
            snapshot.ChangedAtUtc,
            snapshot.ChangedBy,
            snapshot.Reason,
            snapshot.ExpiresAtUtc,
            snapshot.LastError);

    private static ModerationModelRuntimeResponse ToModerationModelRuntimeResponse(ModerationModelRuntimeSnapshot model)
        => new(
            model.SnapshotId,
            model.Enabled,
            model.Provider,
            model.ModelProfile,
            model.ThresholdProfile,
            model.ContractVersion,
            model.ConfigChecksum,
            model.LoadedAtUtc,
            model.LoadedBy,
            model.Status,
            model.TimeoutMs,
            model.FailOpen,
            model.ExternalProviderAllowed,
            model.ExternalProviderReviewed,
            model.LastError);

    private static int ToHttpStatusCode(ErrorCode code)
        => code switch
        {
            ErrorCode.Validation => StatusCodes.Status400BadRequest,
            ErrorCode.Unauthorized => StatusCodes.Status401Unauthorized,
            ErrorCode.Forbidden => StatusCodes.Status403Forbidden,
            ErrorCode.NotFound => StatusCodes.Status404NotFound,
            ErrorCode.Conflict => StatusCodes.Status409Conflict,
            ErrorCode.InfraFailure => StatusCodes.Status500InternalServerError,
            _ => StatusCodes.Status500InternalServerError
        };

    private static AuditLogQueryRequest BuildAuditLogQuery(
        int? page,
        int? pageSize,
        string? source,
        string? type,
        string? actor,
        string? action,
        string? targetType,
        string? targetId,
        string? outcome,
        string? severity,
        DateTime? fromUtc,
        DateTime? toUtc)
        => new(
            page ?? 1,
            pageSize ?? 50,
            source,
            type,
            actor,
            action,
            targetType,
            targetId,
            outcome,
            severity,
            fromUtc,
            toUtc);

    private static IReadOnlyDictionary<string, object?> BuildAuditQueryContext(AuditLogQueryRequest query)
        => new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["page"] = query.Page,
            ["pageSize"] = query.PageSize,
            ["source"] = query.Source,
            ["type"] = query.Type,
            ["actor"] = query.Actor,
            ["action"] = query.Action,
            ["targetType"] = query.TargetType,
            ["targetId"] = query.TargetId,
            ["outcome"] = query.Outcome,
            ["severity"] = query.Severity,
            ["fromUtc"] = query.FromUtc,
            ["toUtc"] = query.ToUtc
        };

    private static async Task<IReadOnlyList<AdminCategoryItemResponse>> ListAdminCategoriesAsync(ISqlSugarClient db, CancellationToken cancellationToken)
    {
        List<TaxonomyNameRow> categories = await db.Queryable<Category>()
            .OrderBy(c => c.Id)
            .Select(c => new TaxonomyNameRow
            {
                Id = c.Id,
                Name = c.Name
            })
            .ToListAsync(cancellationToken);

        DateTime now = DateTime.UtcNow;
        List<TaxonomyCountRow> publicCounts = await db.Queryable<Article>()
            .Where(a => !a.IsDeleted
                && a.Status == ArticleStatus.Published
                && (a.PublishedAt == null || a.PublishedAt <= now)
                && (a.ScheduledPublishAt == null || a.ScheduledPublishAt <= now))
            .GroupBy(a => a.CategoryId)
            .Select(a => new TaxonomyCountRow
            {
                Id = a.CategoryId,
                Count = SqlFunc.AggregateCount(a.Id)
            })
            .ToListAsync(cancellationToken);

        List<TaxonomyStatusCountRow> statusCounts = await db.Queryable<Article>()
            .Where(a => !a.IsDeleted && a.Status != ArticleStatus.Deleted)
            .GroupBy(a => new { a.CategoryId, a.Status })
            .Select(a => new TaxonomyStatusCountRow
            {
                Id = a.CategoryId,
                Status = a.Status,
                Count = SqlFunc.AggregateCount(a.Id)
            })
            .ToListAsync(cancellationToken);

        Dictionary<int, int> publicById = publicCounts.ToDictionary(row => row.Id, row => row.Count);
        Dictionary<int, Dictionary<ArticleStatus, int>> statusById = BuildStatusCountLookup(statusCounts);

        return categories.Select(category =>
        {
            Dictionary<ArticleStatus, int> counts = GetStatusCounts(statusById, category.Id);
            int totalBlocking =
                CountStatus(counts, ArticleStatus.Draft)
                + CountStatus(counts, ArticleStatus.Scheduled)
                + CountStatus(counts, ArticleStatus.Published)
                + CountStatus(counts, ArticleStatus.Archived);

            return new AdminCategoryItemResponse(
                category.Id,
                category.Name ?? string.Empty,
                publicById.GetValueOrDefault(category.Id),
                CountStatus(counts, ArticleStatus.Draft),
                CountStatus(counts, ArticleStatus.Scheduled),
                CountStatus(counts, ArticleStatus.Archived),
                totalBlocking,
                totalBlocking == 0);
        }).ToList();
    }

    private static async Task<IReadOnlyList<AdminTagItemResponse>> ListAdminTagsAsync(ISqlSugarClient db, CancellationToken cancellationToken)
    {
        List<TaxonomyNameRow> tags = await db.Queryable<Tag>()
            .OrderBy(t => t.Id)
            .Select(t => new TaxonomyNameRow
            {
                Id = t.Id,
                Name = t.Name
            })
            .ToListAsync(cancellationToken);

        DateTime now = DateTime.UtcNow;
        List<TaxonomyCountRow> publicCounts = await db.Queryable<ArticleTag, Article>((at, a) => at.ArticleId == a.Id)
            .Where((at, a) => !a.IsDeleted
                && a.Status == ArticleStatus.Published
                && (a.PublishedAt == null || a.PublishedAt <= now)
                && (a.ScheduledPublishAt == null || a.ScheduledPublishAt <= now))
            .GroupBy((at, a) => at.TagId)
            .Select((at, a) => new TaxonomyCountRow
            {
                Id = at.TagId,
                Count = SqlFunc.AggregateCount(at.ArticleId)
            })
            .ToListAsync(cancellationToken);

        List<TaxonomyStatusCountRow> statusCounts = await db.Queryable<ArticleTag, Article>((at, a) => at.ArticleId == a.Id)
            .Where((at, a) => !a.IsDeleted)
            .GroupBy((at, a) => new { at.TagId, a.Status })
            .Select((at, a) => new TaxonomyStatusCountRow
            {
                Id = at.TagId,
                Status = a.Status,
                Count = SqlFunc.AggregateCount(at.ArticleId)
            })
            .ToListAsync(cancellationToken);

        List<TaxonomyCountRow> associationCounts = await db.Queryable<ArticleTag>()
            .GroupBy(at => at.TagId)
            .Select(at => new TaxonomyCountRow
            {
                Id = at.TagId,
                Count = SqlFunc.AggregateCount(at.ArticleId)
            })
            .ToListAsync(cancellationToken);

        Dictionary<int, int> publicById = publicCounts.ToDictionary(row => row.Id, row => row.Count);
        Dictionary<int, int> associationById = associationCounts.ToDictionary(row => row.Id, row => row.Count);
        Dictionary<int, Dictionary<ArticleStatus, int>> statusById = BuildStatusCountLookup(statusCounts);

        return tags.Select(tag =>
        {
            Dictionary<ArticleStatus, int> counts = GetStatusCounts(statusById, tag.Id);
            int totalBlocking = associationById.GetValueOrDefault(tag.Id);

            return new AdminTagItemResponse(
                tag.Id,
                tag.Name ?? string.Empty,
                publicById.GetValueOrDefault(tag.Id),
                CountStatus(counts, ArticleStatus.Draft),
                CountStatus(counts, ArticleStatus.Scheduled),
                CountStatus(counts, ArticleStatus.Archived),
                CountStatus(counts, ArticleStatus.Deleted),
                totalBlocking,
                totalBlocking == 0);
        }).ToList();
    }

    private static Dictionary<int, Dictionary<ArticleStatus, int>> BuildStatusCountLookup(IEnumerable<TaxonomyStatusCountRow> rows)
    {
        var lookup = new Dictionary<int, Dictionary<ArticleStatus, int>>();
        foreach (TaxonomyStatusCountRow row in rows)
        {
            if (!lookup.TryGetValue(row.Id, out Dictionary<ArticleStatus, int>? statusCounts))
            {
                statusCounts = [];
                lookup[row.Id] = statusCounts;
            }

            statusCounts[row.Status] = row.Count;
        }

        return lookup;
    }

    private static Dictionary<ArticleStatus, int> GetStatusCounts(Dictionary<int, Dictionary<ArticleStatus, int>> lookup, int id)
        => lookup.TryGetValue(id, out Dictionary<ArticleStatus, int>? counts) ? counts : [];

    private static int CountStatus(Dictionary<ArticleStatus, int> counts, ArticleStatus status)
        => counts.GetValueOrDefault(status);

    private static string ResolveMainlandStrictStatus(ModerationDictionaryRuntimeSnapshot snapshot)
    {
        ModerationRegionPolicyRuntimeItem? policy = snapshot.RegionPolicies
            .FirstOrDefault(static item => string.Equals(item.Region, RegionCodes.MainlandChina, StringComparison.Ordinal));
        if (policy is null)
        {
            return "disabled";
        }

        return BuildRegionPolicyChecks(policy).All(static item => item.Status == "ok")
            ? "enabled"
            : "invalid";
    }

    private static string NormalizeModerationProvider(string? provider)
    {
        string value = string.IsNullOrWhiteSpace(provider) ? "none" : provider.Trim();
        return value.ToLowerInvariant() switch
        {
            "disabled" or "off" => "none",
            "mock" => "mock",
            "httpjson" or "http-json" => "http-json",
            "fsuscli" or "fsus-cli" => "fsus-cli",
            _ => value
        };
    }

    private static int ResolveP95Latency(IReadOnlyList<int> latencies)
    {
        if (latencies.Count == 0)
        {
            return 0;
        }

        int[] sorted = [.. latencies.Order()];
        int index = Math.Clamp((int)Math.Ceiling(sorted.Length * 0.95d) - 1, 0, sorted.Length - 1);
        return sorted[index];
    }

    private static IReadOnlyList<RegionPolicyCheckResponse> BuildRegionPolicyChecks(ModerationRegionPolicyRuntimeItem policy)
    {
        if (!string.Equals(policy.Region, RegionCodes.MainlandChina, StringComparison.Ordinal))
        {
            return
            [
                BuildPolicyCheck(
                    "policy-version",
                    "Policy version",
                    !string.IsNullOrWhiteSpace(policy.Version),
                    policy.Version,
                    "policy version missing"),
                BuildPolicyCheck(
                    "dictionary-set",
                    "Dictionaries",
                    policy.DictionaryIds.Count > 0,
                    $"{policy.DictionaryIds.Count} dictionaries loaded",
                    "no dictionaries linked",
                    "warning"),
                BuildPolicyCheck(
                    "rule-set",
                    "Rules",
                    policy.RuleCount > 0,
                    $"{policy.RuleCount} rules loaded",
                    "no rules loaded",
                    "warning")
            ];
        }

        var checks = new List<RegionPolicyCheckResponse>
        {
            BuildPolicyCheck(
                "inherits-global",
                "继承 GLOBAL",
                policy.Inherits.Contains(RegionCodes.Global, StringComparer.Ordinal),
                "CN-MAINLAND policy inherits GLOBAL",
                "CN-MAINLAND policy does not inherit GLOBAL")
        };

        foreach (string dictionaryId in MainlandMandatoryDictionaryIds)
        {
            checks.Add(BuildPolicyCheck(
                $"dictionary:{dictionaryId}",
                dictionaryId,
                policy.DictionaryIds.Contains(dictionaryId, StringComparer.Ordinal),
                "mandatory dictionary loaded",
                "mandatory dictionary missing"));
        }

        checks.Add(BuildPolicyCheck(
            "political-sensitive-submit",
            "political_sensitive submit action",
            HasPolicyRule(policy, ModerationRiskCategories.PoliticalSensitive, ModerationDictionaryActions.RejectSubmit, null),
            "reject_submit",
            "political_sensitive submit action must be reject_submit"));
        checks.Add(BuildPolicyCheck(
            "political-sensitive-display",
            "political_sensitive display action",
            HasPolicyRule(policy, ModerationRiskCategories.PoliticalSensitive, null, ModerationDictionaryActions.GeoBlock),
            "geo_block",
            "political_sensitive display action must be geo_block"));
        checks.Add(BuildPolicyCheck(
            "pornographic-submit",
            "pornographic submit action",
            HasPolicyRule(policy, ModerationRiskCategories.Pornographic, ModerationDictionaryActions.RejectSubmit, null),
            "reject_submit",
            "pornographic submit action must be reject_submit"));
        checks.Add(BuildPolicyCheck(
            "pornographic-display",
            "pornographic display action",
            HasPolicyRule(policy, ModerationRiskCategories.Pornographic, null, ModerationDictionaryActions.GeoBlock),
            "geo_block",
            "pornographic display action must be geo_block"));
        checks.Add(BuildPolicyCheck(
            "policy-version",
            "policy version",
            !string.IsNullOrWhiteSpace(policy.Version),
            policy.Version,
            "policy version missing"));

        return checks;
    }

    private static bool HasPolicyRule(
        ModerationRegionPolicyRuntimeItem policy,
        string category,
        string? submitAction,
        string? displayAction)
        => policy.Rules.Any(rule =>
            string.Equals(rule.Category, category, StringComparison.Ordinal)
            && (submitAction is null || string.Equals(rule.SubmitAction, submitAction, StringComparison.Ordinal))
            && (displayAction is null || string.Equals(rule.DisplayAction, displayAction, StringComparison.Ordinal)));

    private static RegionPolicyCheckResponse BuildPolicyCheck(
        string code,
        string label,
        bool ok,
        string okDetail,
        string failedDetail,
        string failedStatus = "error")
        => new(code, label, ok ? "ok" : failedStatus, ok ? okDetail : failedDetail);

    private static async Task<ModerationReplayPreviewResponse> BuildModerationReplayPreviewAsync(
        ModerationReplayPreviewRequest request,
        ISqlSugarClient db,
        IRegionLegalModerationService regionLegalModerationService,
        CancellationToken cancellationToken)
    {
        int limit = Math.Clamp(request.Limit ?? 50, 1, 200);
        string? region = string.IsNullOrWhiteSpace(request.Region)
            ? null
            : regionLegalModerationService.NormalizeRegion(request.Region);
        string? policyVersion = string.IsNullOrWhiteSpace(request.PolicyVersion)
            ? null
            : request.PolicyVersion.Trim();
        string? dictionaryId = string.IsNullOrWhiteSpace(request.DictionaryId)
            ? null
            : request.DictionaryId.Trim();

        var query = db.Queryable<Comment, CommentRegionCompliance>((comment, compliance) => comment.Id == compliance.CommentId)
            .Where((comment, compliance) => !comment.IsDeleted);
        if (region is not null)
        {
            query = query.Where((comment, compliance) => compliance.SubmitRegion == region);
        }

        if (policyVersion is not null)
        {
            query = query.Where((comment, compliance) => compliance.PolicyVersion == policyVersion);
        }

        List<ModerationReplaySourceRow> rows = await query
            .OrderBy((comment, compliance) => compliance.UpdatedAtUtc, OrderByType.Desc)
            .Take(limit)
            .Select((comment, compliance) => new ModerationReplaySourceRow
            {
                CommentId = comment.Id,
                ArticleId = comment.ArticleId,
                UserId = comment.UserId,
                Content = comment.Content,
                SubmitRegion = compliance.SubmitRegion,
                SubmitRegionConfidence = compliance.SubmitRegionConfidence,
                RegionProvider = compliance.RegionProvider,
                SubmitIpHash = compliance.SubmitIpHash,
                PolicyVersion = compliance.PolicyVersion,
                CanPublish = compliance.CanPublish,
                RequiresManualReview = compliance.RequiresManualReview,
                HideUntilReviewed = compliance.HideUntilReviewed,
                BlockedRegions = compliance.BlockedRegions,
                RiskLabels = compliance.RiskLabels,
                DecisionReason = compliance.DecisionReason,
                RuleHitsJson = compliance.RuleHitsJson,
                CreatedAtUtc = compliance.CreatedAtUtc,
                UpdatedAtUtc = compliance.UpdatedAtUtc
            })
            .ToListAsync(cancellationToken);

        var items = new List<ModerationReplayPreviewItemResponse>(rows.Count);
        foreach (ModerationReplaySourceRow row in rows)
        {
            var current = new CommentRegionCompliance
            {
                CommentId = row.CommentId,
                SubmitRegion = row.SubmitRegion,
                SubmitRegionConfidence = row.SubmitRegionConfidence,
                RegionProvider = row.RegionProvider,
                SubmitIpHash = row.SubmitIpHash,
                PolicyVersion = row.PolicyVersion,
                CanPublish = row.CanPublish,
                RequiresManualReview = row.RequiresManualReview,
                HideUntilReviewed = row.HideUntilReviewed,
                BlockedRegions = row.BlockedRegions,
                RiskLabels = row.RiskLabels,
                DecisionReason = row.DecisionReason,
                RuleHitsJson = row.RuleHitsJson,
                CreatedAtUtc = row.CreatedAtUtc,
                UpdatedAtUtc = row.UpdatedAtUtc
            };
            RegionModerationDecision nextDecision = regionLegalModerationService.EvaluateOnSubmit(new RegionModerationRequest(
                row.Content,
                row.ArticleId,
                row.UserId ?? 0,
                row.SubmitRegion,
                row.SubmitRegionConfidence,
                row.RegionProvider,
                row.SubmitIpHash,
                null,
                row.CreatedAtUtc == default ? DateTime.UtcNow : row.CreatedAtUtc));
            RegionPolicyReplayDiff diff = regionLegalModerationService.PreviewReplay(current, nextDecision);
            if (!HasReplayChange(diff))
            {
                continue;
            }

            items.Add(new ModerationReplayPreviewItemResponse(
                diff.CommentId,
                diff.PreviousPolicyVersion,
                diff.NextPolicyVersion,
                diff.AddedBlockedRegions,
                diff.RemovedBlockedRegions,
                diff.AddedRiskLabels,
                diff.RemovedRiskLabels,
                diff.PublishabilityChanged,
                diff.ManualReviewChanged,
                diff.PublicVisibilityChanged));
        }

        return new ModerationReplayPreviewResponse(
            region,
            policyVersion,
            dictionaryId,
            rows.Count,
            items.Count,
            items.Sum(static item => item.AddedBlockedRegions.Count),
            items.Sum(static item => item.RemovedBlockedRegions.Count),
            items.Sum(static item => item.AddedRiskLabels.Count),
            items.Sum(static item => item.RemovedRiskLabels.Count),
            items.Count(static item => item.PublishabilityChanged),
            items.Count(static item => item.ManualReviewChanged),
            items.Count(static item => item.PublicVisibilityChanged),
            items.Count(IsHighRiskReplayChange),
            items);
    }

    private static bool HasReplayChange(RegionPolicyReplayDiff diff)
        => diff.AddedBlockedRegions.Count > 0
            || diff.RemovedBlockedRegions.Count > 0
            || diff.AddedRiskLabels.Count > 0
            || diff.RemovedRiskLabels.Count > 0
            || diff.PublishabilityChanged
            || diff.ManualReviewChanged
            || diff.PublicVisibilityChanged;

    private static bool IsHighRiskReplayChange(ModerationReplayPreviewItemResponse item)
        => item.PublicVisibilityChanged
            || item.PublishabilityChanged
            || item.AddedBlockedRegions.Contains(RegionCodes.MainlandChina, StringComparer.Ordinal)
            || item.RemovedBlockedRegions.Contains(RegionCodes.MainlandChina, StringComparer.Ordinal)
            || item.AddedRiskLabels.Concat(item.RemovedRiskLabels).Any(static label =>
                label.Contains("political", StringComparison.OrdinalIgnoreCase)
                || label.Contains("porn", StringComparison.OrdinalIgnoreCase)
                || label.Contains("national_security", StringComparison.OrdinalIgnoreCase)
                || label.Contains("public_order", StringComparison.OrdinalIgnoreCase));

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
        int userId = context.GetUserId();
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

    private sealed record TaxonomyNameRow
    {
        public int Id { get; init; }
        public string? Name { get; init; }
    }

    private sealed record TaxonomyCountRow
    {
        public int Id { get; init; }
        public int Count { get; init; }
    }

    private sealed record TaxonomyStatusCountRow
    {
        public int Id { get; init; }
        public ArticleStatus Status { get; init; }
        public int Count { get; init; }
    }

    private sealed record ModerationReplaySourceRow
    {
        public long CommentId { get; init; }
        public int ArticleId { get; init; }
        public int? UserId { get; init; }
        public string Content { get; init; } = string.Empty;
        public string SubmitRegion { get; init; } = RegionCodes.Unknown;
        public double SubmitRegionConfidence { get; init; }
        public string RegionProvider { get; init; } = "unknown";
        public string? SubmitIpHash { get; init; }
        public string PolicyVersion { get; init; } = string.Empty;
        public bool CanPublish { get; init; }
        public bool RequiresManualReview { get; init; }
        public bool HideUntilReviewed { get; init; }
        public string BlockedRegions { get; init; } = string.Empty;
        public string RiskLabels { get; init; } = string.Empty;
        public string? DecisionReason { get; init; }
        public string? RuleHitsJson { get; init; }
        public DateTime CreatedAtUtc { get; init; }
        public DateTime UpdatedAtUtc { get; init; }
    }

    private sealed record ModerationModelErrorRow
    {
        public string? ErrorCode { get; init; }
        public DateTime CreatedAtUtc { get; init; }
    }
}
