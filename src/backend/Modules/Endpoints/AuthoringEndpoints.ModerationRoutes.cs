using System.Security.Cryptography;
using System.Text;

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
    private static void MapAuthoringModerationRoutes(IEndpointRouteBuilder group)
    {
        group.MapGet("/moderation/overview", async (
            HttpContext context,
            IAedsEncoder aeds,
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
                AntiSpamModerationProviders.BuiltIn,
                configuration["Moderation:AntiSpamModel:Mode"] ?? "score-only",
                configuration["Moderation:AntiSpamModel:ContractVersion"] ?? AntiSpamModerationContract.DefaultVersion,
                Math.Clamp(configuration.GetValue<int?>("Moderation:AntiSpamModel:TimeoutMs") ?? 800, 100, 10_000));
            return Ok(context, aeds, response);
        })
        .RequireAdminPermission(AdminPermissions.CommentModerate);

        group.MapGet("/moderation/anonymous-comment-policy", async Task<IResult> (
            HttpContext context,
            IAedsEncoder aeds,
            IAnonymousCommentPolicyService policyService,
            CancellationToken cancellationToken) =>
            Ok(context, aeds, await policyService.GetCurrentAsync(cancellationToken)))
        .RequireAdminPermission(AdminPermissions.AnonymousCommentConfigure)
        .RequireRateLimiting("fixed_ip");

        group.MapPut("/moderation/anonymous-comment-policy", async (
            HttpContext context,
            IAedsEncoder aeds,
            IAdminPrincipalService adminPrincipals,
            IAnonymousCommentPolicyService policyService,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            var parsed = await ReadRequestAsync<AnonymousCommentPolicyUpdateRequest>(
                context,
                aeds,
                "anonymous_comment_policy_request_invalid",
                cancellationToken);
            if (!parsed.IsSuccess)
            {
                return parsed.ToErrorResult(aeds);
            }

            AnonymousCommentPolicyUpdateRequest request = parsed.Value!;
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals, aeds);
            if (stepUp is not null)
            {
                return stepUp;
            }

            AnonymousCommentPolicySnapshot snapshot;
            try
            {
                snapshot = await policyService.UpdatePolicyAsync(request, context.GetUserId(), cancellationToken);
            }
            catch (ArgumentException ex) when (ex.ParamName == nameof(AnonymousCommentPolicyUpdateRequest.DefaultAuthorMode))
            {
                return AedsJsonResults.BadRequest(
                    aeds,
                    ex.Message.StartsWith("anonymous_author_mode_retired", StringComparison.Ordinal)
                        ? "anonymous_author_mode_retired"
                        : "author_mode_invalid");
            }
            catch (ArgumentOutOfRangeException ex) when (
                ex.ParamName == nameof(AnonymousCommentPolicyUpdateRequest.CommentMaxChars) ||
                ex.ParamName == nameof(AnonymousCommentPolicyUpdateRequest.CommentMaxUtf8Bytes))
            {
                return AedsJsonResults.BadRequest(aeds, "comment_limit_invalid");
            }

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
                    ["supportedDisplayLanguages"] = snapshot.SupportedDisplayLanguages,
                    ["commentMaxChars"] = snapshot.CommentMaxChars,
                    ["commentMaxUtf8Bytes"] = snapshot.CommentMaxUtf8Bytes
                }), cancellationToken);
            return Ok(context, aeds, snapshot);
        })
        .RequireAdminPermission(AdminPermissions.AnonymousCommentConfigure)
        .RequireRateLimiting("fixed_ip");

        group.MapPost("/comments/moderation/nullifiers/block", async (
            HttpContext context,
            IAedsEncoder aeds,
            IAdminPrincipalService adminPrincipals,
            ICommentAnonymousNullifierService nullifierService,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            var parsed = await ReadRequestAsync<AnonymousNullifierBlockRequest>(
                context,
                aeds,
                "anonymous_nullifier_block_request_invalid",
                cancellationToken);
            if (!parsed.IsSuccess)
            {
                return parsed.ToErrorResult(aeds);
            }

            AnonymousNullifierBlockRequest request = parsed.Value!;
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals, aeds);
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
                TargetId: HashAuditTargetId("comment_anonymous_nullifier", request.NullifierHash),
                ReasonCode: reason,
                Context: new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["scope"] = request.Scope,
                    ["nullifierTarget"] = HashAuditTargetId("comment_anonymous_nullifier", request.NullifierHash),
                    ["applied"] = applied
                }), cancellationToken);
            return applied
                ? Ok(context, aeds, new AnonymousGovernanceActionResponse(true))
                : AedsJsonResults.NotFound(aeds, "anonymous_nullifier_not_found");
        })
        .RequireAdminPermission(AdminPermissions.AnonymousNullifierBlock)
        .RequireRateLimiting("fixed_ip");

        group.MapPost("/comments/moderation/anonymous-credentials/{credentialId:long}/revoke", async (
            long credentialId,
            HttpContext context,
            IAedsEncoder aeds,
            IAdminPrincipalService adminPrincipals,
            IAnonymousCredentialService credentialService,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            var parsed = await ReadRequestAsync<AnonymousCredentialRevokeRequest>(
                context,
                aeds,
                "anonymous_credential_revoke_request_invalid",
                cancellationToken);
            if (!parsed.IsSuccess)
            {
                return parsed.ToErrorResult(aeds);
            }

            AnonymousCredentialRevokeRequest request = parsed.Value!;
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals, aeds);
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
                TargetId: HashAuditTargetId("anonymous_credential", credentialId.ToString(System.Globalization.CultureInfo.InvariantCulture)),
                ReasonCode: request.Reason,
                Context: new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["credentialTarget"] = HashAuditTargetId("anonymous_credential", credentialId.ToString(System.Globalization.CultureInfo.InvariantCulture)),
                    ["revoked"] = revoked
                }), cancellationToken);
            return revoked
                ? Ok(context, aeds, new AnonymousGovernanceActionResponse(true))
                : AedsJsonResults.NotFound(aeds, "anonymous_credential_not_found");
        })
        .RequireAdminPermission(AdminPermissions.AnonymousCredentialRevoke)
        .RequireRateLimiting("fixed_ip");

        group.MapGet("/moderation/dictionaries", (
            HttpContext context,
            IAedsEncoder aeds,
            IModerationDictionaryService dictionaryService) =>
            Ok(context, aeds, dictionaryService.GetRuntimeSnapshot()))
        .RequireAdminPermission(AdminPermissions.SystemConfig);

        group.MapGet("/moderation/runtime/status", (
            HttpContext context,
            IAedsEncoder aeds,
            IModerationRuntimeStateService runtimeState) =>
            Ok(context, aeds, ToModerationRuntimeStatusResponse(runtimeState.Current)))
        .RequireAdminPermission(AdminPermissions.SystemConfig);

        group.MapPost("/moderation/runtime/global-state", async (
            HttpContext context,
            IAedsEncoder aeds,
            IAdminPrincipalService adminPrincipals,
            IModerationRuntimeStateService runtimeState,
            IAuditEventService auditEvents,
            ICacheInvalidationDispatcher cacheInvalidation,
            CancellationToken cancellationToken) =>
        {
            var parsed = await ReadRequestAsync<ModerationRuntimeGlobalStateRequest>(
                context,
                aeds,
                "moderation_runtime_global_state_request_invalid",
                cancellationToken);
            if (!parsed.IsSuccess)
            {
                return parsed.ToErrorResult(aeds);
            }

            ModerationRuntimeGlobalStateRequest request = parsed.Value!;
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals, aeds);
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
                aeds,
                cancellationToken);
        })
        .RequireAdminPermission(AdminPermissions.SystemConfig)
        .RequireRateLimiting("fixed_ip");

        group.MapPost("/moderation/runtime/region-state", async (
            HttpContext context,
            IAedsEncoder aeds,
            IAdminPrincipalService adminPrincipals,
            IModerationRuntimeStateService runtimeState,
            IAuditEventService auditEvents,
            ICacheInvalidationDispatcher cacheInvalidation,
            CancellationToken cancellationToken) =>
        {
            var parsed = await ReadRequestAsync<ModerationRuntimeRegionStateRequest>(
                context,
                aeds,
                "moderation_runtime_region_state_request_invalid",
                cancellationToken);
            if (!parsed.IsSuccess)
            {
                return parsed.ToErrorResult(aeds);
            }

            ModerationRuntimeRegionStateRequest request = parsed.Value!;
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals, aeds);
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
                aeds,
                cancellationToken);
        })
        .RequireAdminPermission(AdminPermissions.SystemConfig)
        .RequireRateLimiting("fixed_ip");

        group.MapPost("/moderation/dictionaries/reload", async (
            HttpContext context,
            IAedsEncoder aeds,
            IAdminPrincipalService adminPrincipals,
            IModerationDictionaryService dictionaryService,
            IAuditEventService auditEvents,
            ICacheInvalidationDispatcher cacheInvalidation,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals, aeds);
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
                ? Ok(context, aeds, response)
                : AedsJsonResults.Error(aeds, ErrorCode.InfraFailure, "moderation_dictionary_reload_failed", StatusCodes.Status500InternalServerError);
        })
        .RequireAdminPermission(AdminPermissions.SystemConfig)
        .RequireRateLimiting("fixed_ip");

        group.MapPost("/moderation/dictionaries/rollback", async (
            HttpContext context,
            IAedsEncoder aeds,
            IAdminPrincipalService adminPrincipals,
            IModerationDictionaryService dictionaryService,
            IAuditEventService auditEvents,
            ICacheInvalidationDispatcher cacheInvalidation,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals, aeds);
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
                return Ok(context, aeds, snapshot);
            }

            return AedsJsonResults.Error(aeds, result.Error.Code, result.Error.Message, ToHttpStatusCode(result.Error.Code));
        })
        .RequireAdminPermission(AdminPermissions.SystemConfig)
        .RequireRateLimiting("fixed_ip");

        group.MapPost("/moderation/dictionaries/{dictionaryId}/enable", async (
            string dictionaryId,
            HttpContext context,
            IAedsEncoder aeds,
            IAdminPrincipalService adminPrincipals,
            IModerationRuntimeStateService runtimeState,
            IAuditEventService auditEvents,
            ICacheInvalidationDispatcher cacheInvalidation,
            CancellationToken cancellationToken) =>
        {
            var parsed = await ReadRequestAsync<ModerationDictionaryStateRequest>(
                context,
                aeds,
                "moderation_dictionary_state_request_invalid",
                cancellationToken);
            if (!parsed.IsSuccess)
            {
                return parsed.ToErrorResult(aeds);
            }

            ModerationDictionaryStateRequest request = parsed.Value!;
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals, aeds);
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
                aeds,
                cancellationToken);
        })
        .RequireAdminPermission(AdminPermissions.SystemConfig)
        .RequireRateLimiting("fixed_ip");

        group.MapPost("/moderation/dictionaries/{dictionaryId}/disable", async (
            string dictionaryId,
            HttpContext context,
            IAedsEncoder aeds,
            IAdminPrincipalService adminPrincipals,
            IModerationRuntimeStateService runtimeState,
            IAuditEventService auditEvents,
            ICacheInvalidationDispatcher cacheInvalidation,
            CancellationToken cancellationToken) =>
        {
            var parsed = await ReadRequestAsync<ModerationDictionaryStateRequest>(
                context,
                aeds,
                "moderation_dictionary_state_request_invalid",
                cancellationToken);
            if (!parsed.IsSuccess)
            {
                return parsed.ToErrorResult(aeds);
            }

            ModerationDictionaryStateRequest request = parsed.Value!;
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals, aeds);
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
                aeds,
                cancellationToken);
        })
        .RequireAdminPermission(AdminPermissions.SystemConfig)
        .RequireRateLimiting("fixed_ip");

        group.MapGet("/moderation/policies", (
            HttpContext context,
            IAedsEncoder aeds,
            IModerationDictionaryService dictionaryService) =>
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
            return Ok(context, aeds, policies);
        })
        .RequireAdminPermission(AdminPermissions.SystemConfig);

        group.MapGet("/moderation/regions", (
            HttpContext context,
            IAedsEncoder aeds,
            IModerationRegionCatalogService regionCatalog) =>
        {
            ModerationRegionCatalogSnapshot snapshot = regionCatalog.GetRuntimeSnapshot();
            return Ok(context, aeds, snapshot.Regions);
        })
        .RequireAdminPermission(AdminPermissions.SystemConfig);

        group.MapGet("/moderation/region-groups", (
            HttpContext context,
            IAedsEncoder aeds,
            IModerationRegionCatalogService regionCatalog) =>
        {
            ModerationRegionCatalogSnapshot snapshot = regionCatalog.GetRuntimeSnapshot();
            return Ok(context, aeds, snapshot.RegionGroups);
        })
        .RequireAdminPermission(AdminPermissions.SystemConfig);

        group.MapGet("/moderation/policy-templates", (
            HttpContext context,
            IAedsEncoder aeds,
            IModerationRegionCatalogService regionCatalog) =>
        {
            ModerationRegionCatalogSnapshot snapshot = regionCatalog.GetRuntimeSnapshot();
            return Ok(context, aeds, snapshot.PolicyTemplates);
        })
        .RequireAdminPermission(AdminPermissions.SystemConfig);

        group.MapGet("/moderation/effective-policy/{regionCode}", async (
            string regionCode,
            HttpContext context,
            IAedsEncoder aeds,
            IModerationRegionCatalogService regionCatalog,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            ModerationEffectivePolicyPreview preview = regionCatalog.PreviewEffectivePolicy(regionCode);
            await RecordEffectivePolicyPreviewAuditAsync(preview, auditEvents, cancellationToken);
            return Ok(context, aeds, preview);
        })
        .RequireAdminPermission(AdminPermissions.SystemConfig)
        .RequireRateLimiting("fixed_ip");

        group.MapPost("/moderation/effective-policy/preview", async (
            HttpContext context,
            IAedsEncoder aeds,
            IModerationRegionCatalogService regionCatalog,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            var parsed = await ReadRequestAsync<ModerationEffectivePolicyPreviewRequest>(
                context,
                aeds,
                "moderation_effective_policy_preview_request_invalid",
                cancellationToken);
            if (!parsed.IsSuccess)
            {
                return parsed.ToErrorResult(aeds);
            }

            ModerationEffectivePolicyPreviewRequest request = parsed.Value!;
            ModerationEffectivePolicyPreview preview = regionCatalog.PreviewEffectivePolicy(request.RegionCode, request.OperatorOverrides);
            await RecordEffectivePolicyPreviewAuditAsync(preview, auditEvents, cancellationToken);
            return Ok(context, aeds, preview);
        })
        .RequireAdminPermission(AdminPermissions.SystemConfig)
        .RequireRateLimiting("fixed_ip");

        group.MapGet("/moderation/model/status", async (
            HttpContext context,
            IAedsEncoder aeds,
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
                lastSuccess.Count > 0 ? lastSuccess[0] : null,
                lastError.Count > 0 ? lastError[0].ErrorCode : null,
                lastError.Count > 0 ? lastError[0].CreatedAtUtc : null,
                latencies.Count > 0 ? RoundingHelper.Round2(latencies.Average()) : 0d,
                ResolveP95Latency(latencies));
            return Ok(context, aeds, response);
        })
        .RequireAdminPermission(AdminPermissions.SystemConfig);

        group.MapPost("/moderation/model/runtime", async (
            HttpContext context,
            IAedsEncoder aeds,
            IAdminPrincipalService adminPrincipals,
            IModerationRuntimeStateService runtimeState,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            var parsed = await ReadRequestAsync<ModerationModelRuntimeRequest>(
                context,
                aeds,
                "moderation_model_runtime_request_invalid",
                cancellationToken);
            if (!parsed.IsSuccess)
            {
                return parsed.ToErrorResult(aeds);
            }

            ModerationModelRuntimeRequest request = parsed.Value!;
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals, aeds);
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
                aeds,
                cancellationToken);
        })
        .RequireAdminPermission(AdminPermissions.SystemConfig)
        .RequireRateLimiting("fixed_ip");

        group.MapPost("/moderation/model/reload", async (
            HttpContext context,
            IAedsEncoder aeds,
            IAdminPrincipalService adminPrincipals,
            IModerationRuntimeStateService runtimeState,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals, aeds);
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
                aeds,
                cancellationToken);
        })
        .RequireAdminPermission(AdminPermissions.SystemConfig)
        .RequireRateLimiting("fixed_ip");

        group.MapPost("/moderation/model/rollback", async (
            HttpContext context,
            IAedsEncoder aeds,
            IAdminPrincipalService adminPrincipals,
            IModerationRuntimeStateService runtimeState,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals, aeds);
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
                aeds,
                cancellationToken);
        })
        .RequireAdminPermission(AdminPermissions.SystemConfig)
        .RequireRateLimiting("fixed_ip");

        group.MapPost("/moderation/replay/preview", async (
            HttpContext context,
            IAedsEncoder aeds,
            ISqlSugarClient db,
            IRegionLegalModerationService regionLegalModerationService,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            var parsed = await ReadRequestAsync<ModerationReplayPreviewRequest>(
                context,
                aeds,
                "moderation_replay_preview_request_invalid",
                cancellationToken);
            if (!parsed.IsSuccess)
            {
                return parsed.ToErrorResult(aeds);
            }

            ModerationReplayPreviewRequest request = parsed.Value!;
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

            return Ok(context, aeds, response);
        })
        .RequireAdminPermission(AdminPermissions.SystemConfig)
        .RequireRateLimiting("fixed_ip");

        group.MapGet("/comments/moderation", async (
            HttpContext context,
            IAedsEncoder aeds,
            int? status,
            int? limit,
            AuthoringWorkflowService service,
            CancellationToken cancellationToken) =>
        {
            if (!TryResolveModerationStatus(status, out CommentModerationStatus? resolvedStatus))
            {
                return AedsJsonResults.BadRequest(aeds, "comment_status_invalid");
            }

            CommentModerationQueueResponse queue = await service.ListCommentModerationQueueAsync(resolvedStatus, limit ?? 50, cancellationToken);
            return Ok(context, aeds, queue);
        })
        .RequireAdminPermission(AdminPermissions.CommentModerate)
        .RequireRateLimiting("fixed_ip");

        group.MapPost("/comments/moderation/bulk", async (
            HttpContext context,
            IAedsEncoder aeds,
            IAdminPrincipalService adminPrincipals,
            AuthoringWorkflowService service,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            var parsed = await ReadRequestAsync<CommentModerationBulkRequest>(
                context,
                aeds,
                "comment_moderation_bulk_request_invalid",
                cancellationToken);
            if (!parsed.IsSuccess)
            {
                return parsed.ToErrorResult(aeds);
            }

            CommentModerationBulkRequest request = parsed.Value!;
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals, aeds);
            if (stepUp is not null)
            {
                return stepUp;
            }

            CommentModerationBulkResponse response = await service.ModerateCommentsAsync(ResolveRequiredAdminPrincipalId(context), request, cancellationToken);
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
            return Ok(context, aeds, response);
        })
        .RequireAdminPermission(AdminPermissions.CommentModerate)
        .WithAdminSensitiveStepUp()
        .RequireRateLimiting("fixed_ip");

        group.MapPost("/comments/{commentId:long}/moderation", async (
            long commentId,
            HttpContext context,
            IAedsEncoder aeds,
            IAdminPrincipalService adminPrincipals,
            AuthoringWorkflowService service,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            var parsed = await ReadRequestAsync<CommentModerationRequest>(
                context,
                aeds,
                "comment_moderation_request_invalid",
                cancellationToken);
            if (!parsed.IsSuccess)
            {
                return parsed.ToErrorResult(aeds);
            }

            CommentModerationRequest request = parsed.Value!;
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals, aeds);
            if (stepUp is not null)
            {
                return stepUp;
            }

            bool moderated = await service.ModerateCommentAsync(ResolveRequiredAdminPrincipalId(context), commentId, request, cancellationToken);
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
                ? Ok(context, aeds, new
                {
                    moderated
                })
                : AedsJsonResults.NotFound(aeds, "comment_not_found");
        })
        .RequireAdminPermission(AdminPermissions.CommentModerate)
        .WithAdminSensitiveStepUp()
        .RequireRateLimiting("fixed_ip");

    }
}
